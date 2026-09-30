"""Test-only connectors that exercise the contract beyond what Todoist needs.

`mixed` has two kinds (one without wildcards), an operation that needs different actions on two resources,
and an operation gated by provider consent. `mode` switches it into deliberately broken behaviour, which the
executor must reject. `keyed` authenticates with an API key and acts on its account.
"""

import asyncio
import json
from typing import Annotated, Any

import httpx
from pydantic import Field

from connectors.base import (
    ACCOUNT_KIND,
    Account,
    ActionSpec,
    ApiKey,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    OAuth2,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ResourceKind,
    ScopedRecord,
)
from connectors.http import ProviderHTTP

FOLDER = "folder"
LABEL = "label"
Id = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[a-z0-9-]+$")]


class FakeServer:
    """One in-memory provider behind httpx.MockTransport."""

    def __init__(self) -> None:
        self.folders = {"inbox": "Inbox", "archive": "Archive", "secret": "Secret"}
        self.labels = {"red": "Red", "blue": "Blue"}
        self.calls: list[tuple[str, str]] = []
        # What the next writes get: a status code, an exception to raise, or "bad-json".
        self.write_responses: list[Any] = []
        self.read_status = 200
        # Holds writes until set, to observe a write in flight.
        self.gate: asyncio.Event | None = None
        self.received = asyncio.Event()
        # "ok" | "omit-source" | "enumerate-write" | "two-writes" | "write-in-prepare" | "foreign-record"
        # | "swallow-errors" | "no-write"
        self.mode = "ok"
        self.copies: list[dict] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path))
        if request.method == "GET":
            if self.read_status != 200:
                return httpx.Response(self.read_status, json={})
            if request.url.path == "/me":
                return httpx.Response(200, json={"id": "acct-1", "name": "Fake account"})
            if request.url.path == "/folders":
                return httpx.Response(200, json=[{"id": k, "name": v} for k, v in self.folders.items()])
            if request.url.path == "/labels":
                return httpx.Response(200, json=[{"id": k, "name": v} for k, v in self.labels.items()])
            return httpx.Response(404, json={})
        self.received.set()
        if self.gate is not None:
            await self.gate.wait()
        response = self.write_responses.pop(0) if self.write_responses else 200
        if isinstance(response, type) and issubclass(response, Exception):
            raise response("simulated", request=request)
        if response == "bad-json":
            return httpx.Response(200, content=b"<html>")
        if response != 200:
            return httpx.Response(response, json={})
        body = json.loads(request.content)
        self.copies.append(body)
        return httpx.Response(200, json={"id": f"copy-{len(self.copies)}", **body})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


class CopyFile(OperationInput):
    source: Id
    dest: Id
    name: Annotated[str, Field(min_length=1, max_length=100)]


class ListInput(OperationInput):
    pass


class MixedConnector(Connector):
    slug = "mixed"
    name = "Mixed"
    kinds = (
        ResourceKind(FOLDER, "Folder", ("read", "create"), wildcard=True),
        ResourceKind(LABEL, "Label", ("read",)),
    )
    actions = (ActionSpec("read", "Read"), ActionSpec("create", "Create", requires="read"))
    auth = OAuth2(
        app="mixed",
        authorize_url="https://mixed.example/authorize",
        token_url="https://mixed.example/token",
        scopes=("files", "labels"),
    )

    def __init__(self, server: FakeServer) -> None:
        self.server = server

    @property
    def operations(self) -> tuple[Operation, ...]:
        return (
            Operation(
                "list_folders",
                "List folders",
                "Lists folders.",
                ListInput,
                self._prepare_list_folders,
                needs=((FOLDER, "read"),),
            ),
            Operation(
                "copy_file",
                "Copy a file",
                "Copies a file from one folder into another.",
                CopyFile,
                self._prepare_copy,
                needs=((FOLDER, "read"), (FOLDER, "create")),
                mutates=True,
            ),
            Operation(
                "list_labels",
                "List labels",
                "Lists labels.",
                ListInput,
                self._prepare_list_labels,
                needs=((LABEL, "read"),),
                consent=(frozenset({"labels"}),),
            ),
        )

    def client(self, secret: str) -> ProviderHTTP:
        return ProviderHTTP(
            "Mixed",
            base_url="https://mixed.example",
            headers={"Authorization": f"Bearer {secret}"},
            transport=self.server.transport(),
        )

    async def account(self, client: ProviderHTTP) -> Account:
        me = await client.json("GET", "/me")
        return Account(me["id"], me["name"])

    async def discover(self, client, kind, *, query, cursor) -> DiscoveryPage:
        path = "/folders" if kind == FOLDER else "/labels"
        items = [DiscoveryItem(i["id"], i["name"]) for i in await client.json("GET", path)]
        if query:
            items = [i for i in items if query.lower() in i.name.lower()]
        return DiscoveryPage(items)

    async def describe(self, client, kind, ids) -> dict[str, str]:
        page = await self.discover(client, kind, query=None, cursor=None)
        return {i.id: i.name for i in page.items if i.id in ids}

    async def _prepare_list_folders(self, binding: Binding, _: ListInput) -> Prepared:
        async def execute() -> ProviderOutput:
            folders = await binding.client.json("GET", "/folders")
            records = [ScopedRecord(binding.resource(FOLDER, f["id"]), f) for f in folders]
            if self.server.mode == "foreign-record":
                records.append(ScopedRecord(binding.resource(LABEL, "red"), {"id": "red"}))
                records.append(ScopedRecord(Binding("other", None).resource(FOLDER, "inbox"), {"id": "x"}))
            return ProviderOutput(records)

        return Prepared([Enumerate(FOLDER, "read")], execute)

    async def _prepare_list_labels(self, binding: Binding, _: ListInput) -> Prepared:
        async def execute() -> ProviderOutput:
            labels = await binding.client.json("GET", "/labels")
            return ProviderOutput([ScopedRecord(binding.resource(LABEL, i["id"]), i) for i in labels])

        return Prepared([Enumerate(LABEL, "read")], execute)

    async def _prepare_copy(self, binding: Binding, data: CopyFile) -> Prepared:
        mode = self.server.mode
        source = Need(binding.resource(FOLDER, data.source), "read")
        dest = Need(binding.resource(FOLDER, data.dest), "create")
        requirements = {
            "omit-source": [dest],
            "enumerate-write": [Enumerate(FOLDER, "read"), dest],
        }.get(mode, [source, dest])
        if mode == "write-in-prepare":
            await binding.client.request("POST", "/copies", json={})

        async def execute() -> ProviderOutput:
            body = {"source": data.source, "dest": data.dest, "name": data.name}
            if mode == "no-write":
                return ProviderOutput([])
            try:
                created = await binding.client.json("POST", "/copies", json=body)
            except OperationError:
                if mode != "swallow-errors":
                    raise
                return ProviderOutput([])
            if mode == "two-writes":
                await binding.client.request("POST", "/copies", json=body)
            return ProviderOutput([ScopedRecord(binding.resource(FOLDER, data.dest), created)])

        return Prepared(requirements, execute)


class Whoami(OperationInput):
    pass


class KeyedConnector(Connector):
    slug = "keyed"
    name = "Keyed"
    kinds = (ResourceKind(ACCOUNT_KIND, "Account", ("read",)),)
    actions = (ActionSpec("read", "Read"),)
    auth = ApiKey("API key")

    def __init__(self, server: FakeServer) -> None:
        self.server = server

    @property
    def operations(self) -> tuple[Operation, ...]:
        return (
            Operation(
                "whoami",
                "Who am I",
                "Shows the account.",
                Whoami,
                self._prepare,
                needs=((ACCOUNT_KIND, "read"),),
            ),
        )

    def client(self, secret: str) -> ProviderHTTP:
        return ProviderHTTP(
            "Keyed",
            base_url="https://keyed.example",
            headers={"X-Key": secret},
            transport=self.server.transport(),
        )

    async def account(self, client: ProviderHTTP) -> Account:
        me = await client.json("GET", "/me")
        return Account(me["id"], me["name"])

    async def discover(self, client, kind, *, query, cursor) -> DiscoveryPage:
        raise OperationError("NOT_SUPPORTED", "Nothing to discover.")

    async def describe(self, client, kind, ids) -> dict[str, str]:
        return {}

    async def _prepare(self, binding: Binding, _: Whoami) -> Prepared:
        async def execute() -> ProviderOutput:
            me = await binding.client.json("GET", "/me")
            return ProviderOutput([ScopedRecord(binding.account(), me)])

        return Prepared([Need(binding.account(), "read")], execute)
