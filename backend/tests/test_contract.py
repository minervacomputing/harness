"""The connector contract: registry validation, requirement checks, write accounting, consent, and
contract changes, exercised through the test-only connectors in `fakes`."""

import asyncio
import dataclasses
import json
import time
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import jsonschema
import pytest
from asgiref.sync import sync_to_async
from connector_runs import claimed_run, replace_grants
from django.utils import timezone
from fakes import FOLDER, LABEL, FakeServer, KeyedConnector, MixedConnector
from pydantic import SecretStr

from agents.models import Agent
from connections import credentials as connection_credentials
from connections import oauth as connection_oauth
from connections import services as connection_services
from connections.models import Connection
from connectors import executor as executor_module
from connectors import registry, text
from connectors.base import (
    ACCOUNT_KIND,
    ActionSpec,
    OperationError,
    ProviderOutput,
    ResourceKind,
    ScopedRecord,
)
from connectors.executor import APPLIED_WITHOUT_RESULT, RESULT_SCHEMA, Executor
from connectors.http import Effect, write_attempt
from conversations.models import Conversation
from gateway.mcp import ATTEMPT_SCOPE_KEY, RUN_SCOPE_KEY, list_tools
from minerva.config import config
from permissions.models import Grant, PermissionLayer
from permissions.policy import Layer, Policy, Resource
from permissions.services import (
    MAX_GRANTS_PER_CONNECTION,
    GrantChange,
    InvalidGrants,
    apply_grant_changes,
    user_layer,
)
from runs import services
from runs.models import Run, RunWrite
from workspaces.tenancy import workspace_scope

pytestmark = pytest.mark.django_db(transaction=True)
COPY = "mixed_copy_file"


@pytest.fixture
def server(monkeypatch) -> FakeServer:
    server = FakeServer()
    connectors = [*registry._declared(), MixedConnector(server), KeyedConnector(server)]
    registry.validate(connectors)
    table = {c.slug: c for c in connectors}
    monkeypatch.setattr(registry, "_registry", lambda: table)
    registry.contract.cache_clear()
    yield server
    registry.contract.cache_clear()


@pytest.fixture
def mixed(scoped, user, server) -> Connection:
    connection = Connection(provider="mixed", owner=user, label="Mixed", external_account_id="acct-1")
    connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": ["files", "labels"]})
    connection.save()
    return connection


@pytest.fixture
def start(scoped, user, mixed):
    """Sets the user's grants on the mixed connection, starts and claims a run; returns an executor.

    Grants are {folder id: actions}, or {(kind, id): actions} for other kinds.
    """

    def start_(grants: dict, connection: Connection | None = None) -> Executor:
        connection = connection or mixed
        normalized = {
            key if isinstance(key, tuple) else (FOLDER, key): value for key, value in grants.items()
        }
        with workspace_scope(scoped.id):
            agent = Agent.objects.get()
            agent.connections.set([connection])
            replace_grants(user, connection, normalized)
        return claimed_run(scoped, user)

    return sync_to_async(start_)


async def _run(executor: Executor) -> Run:
    return await Run.unscoped.aget(pk=executor.context.run_id)


async def _writes(executor: Executor) -> list[RunWrite]:
    return [w async for w in RunWrite.unscoped.filter(run_id=executor.context.run_id)]


def _posts(server: FakeServer) -> int:
    return sum(1 for method, _ in server.calls if method == "POST")


async def _error(call) -> OperationError:
    with pytest.raises(OperationError) as caught:
        await call
    return caught.value


def copy(source="inbox", dest="archive", name="a") -> dict:
    return {"source": source, "dest": dest, "name": name}


# Registry validation


class Variant(MixedConnector):
    """MixedConnector with some operations replaced."""

    changes: dict = {}

    @property
    def operations(self):
        return tuple(dataclasses.replace(op, **self.changes.get(op.name, {})) for op in super().operations)


def variant(name="variant", **attrs) -> MixedConnector:
    return type(name, (Variant,), attrs)(FakeServer())


def test_free_text_validators_draw_one_line_for_control_characters():
    for code in range(0x80):
        char = chr(code)
        control = code < 0x20 or code == 0x7F
        for check, allowed in (
            (text.single_line, not control),
            (text.plain_text, not control or char in "\t\n\r"),
        ):
            if allowed:
                assert check(f"a{char}b") == f"a{char}b"
            else:
                with pytest.raises(ValueError):
                    check(f"a{char}b")


def test_declared_connectors_are_valid():
    registry.validate(registry._declared())


@pytest.mark.parametrize(
    "connector",
    [
        variant(changes={"copy_file": {"needs": (("nope", "read"),)}}),
        variant(changes={"list_labels": {"needs": ((LABEL, "create"),)}}),
        variant(changes={"list_labels": {"output_action": "create"}}),
        variant(changes={"list_labels": {"needs": ()}}),
        variant(changes={"list_labels": {"name": "listLabels"}}),
        variant(changes={"list_labels": {"name": "list_labels2"}}),
        variant(changes={"list_labels": {"name": "list_folders"}}),
        variant(changes={"list_labels": {"name": "a" * 60}}),
        variant(changes={"list_labels": {"paginated": True}}),
        variant(
            actions=(
                ActionSpec("read", "Read", requires="create"),
                ActionSpec("create", "Create", requires="read"),
            )
        ),
        variant(actions=(ActionSpec("read", "Read", requires="write"),)),
        variant(kinds=(ResourceKind(FOLDER, "Folder", ("read", "delete")),)),
        variant(kinds=(ResourceKind(ACCOUNT_KIND, "Account", ("read",), wildcard=True),)),
        variant(slug="Mixed"),
        variant(auth=dataclasses.replace(MixedConnector.auth, app="Mixed")),
        variant(auth=dataclasses.replace(MixedConnector.auth, token_url="http://mixed.example/token")),
        variant(auth=dataclasses.replace(MixedConnector.auth, authorize_params=(("redirect_uri", "x"),))),
        variant(
            auth=dataclasses.replace(MixedConnector.auth, authorize_params=(("prompt", "a"), ("prompt", "b")))
        ),
    ],
)
def test_invalid_declarations_are_rejected(connector):
    with pytest.raises(registry.InvalidConnector):
        registry.validate([connector])


MIXED_OUTPUT = {"needs": ((FOLDER, "read"), (LABEL, "read")), "output_action": "create"}


def test_the_output_action_needs_to_apply_to_only_one_of_the_kinds():
    registry.validate([variant(changes={"list_folders": MIXED_OUTPUT})])


def test_records_of_a_kind_without_the_output_action_are_dropped_even_when_unrestricted():
    connector = variant(changes={"list_folders": MIXED_OUTPUT})
    op = connector.operation("list_folders")
    executor = Executor(SimpleNamespace(policy=Policy((Layer.build("agent", False, []),))))
    output = ProviderOutput(
        [
            ScopedRecord(Resource("c1", FOLDER, "inbox"), {"id": "inbox"}),
            ScopedRecord(Resource("c1", LABEL, "red"), {"id": "red"}),
        ]
    )
    result = executor._result(connector, op, SimpleNamespace(connection_id="c1", provider="variant"), output)
    assert [item["id"] for item in result["items"]] == ["inbox"]


def test_results_match_the_schema_the_gateway_declares():
    connector = variant()
    op = connector.operation("list_folders")
    unrestricted = Executor(SimpleNamespace(policy=Policy((Layer.build("agent", False, []),))))
    nothing_granted = Executor(SimpleNamespace(policy=Policy((Layer.build("agent", True, []),))))
    records = [ScopedRecord(Resource("c1", FOLDER, "inbox"), {"id": "inbox"})]
    ref = SimpleNamespace(connection_id="c1", provider="variant")
    cases = [
        (unrestricted, ProviderOutput(records), {"items": [{"id": "inbox"}], "count": 1}),
        (
            unrestricted,
            ProviderOutput(records, incomplete=True),
            {"items": [{"id": "inbox"}], "count": 1, "incomplete": True},
        ),
        # count is what is left after the policy, so a page can be empty while the provider had records.
        (nothing_granted, ProviderOutput(records), {"items": [], "count": 0}),
    ]
    for executor, output, expected in cases:
        result = executor._result(connector, op, ref, output)
        assert result == expected
        jsonschema.validate(result, RESULT_SCHEMA)
    # Paginated operations add the run-bound cursor afterwards, even to an empty page.
    jsonschema.validate({"items": [], "count": 0, "next_cursor": "token"}, RESULT_SCHEMA)
    jsonschema.validate(APPLIED_WITHOUT_RESULT, RESULT_SCHEMA)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"items": [], "count": 0, "total": 3}, RESULT_SCHEMA)


class KeyedWithConsent(KeyedConnector):
    @property
    def operations(self):
        return tuple(dataclasses.replace(op, consent=(frozenset({"x"}),)) for op in super().operations)


def test_consent_needs_oauth_and_tool_names_are_unique():
    with pytest.raises(registry.InvalidConnector):
        registry.validate([KeyedWithConsent(FakeServer())])
    with pytest.raises(registry.InvalidConnector):
        registry.validate([KeyedConnector(FakeServer()), KeyedConnector(FakeServer())])


def test_the_fingerprint_follows_what_an_operation_means():
    base = MixedConnector(FakeServer())
    op = base.operation("copy_file")
    fingerprint = registry.fingerprint(base, op)
    assert registry.fingerprint(MixedConnector(FakeServer()), op) == fingerprint
    assert registry.fingerprint(base, dataclasses.replace(op, revision=2)) != fingerprint
    assert registry.fingerprint(base, dataclasses.replace(op, needs=((FOLDER, "create"),))) != fingerprint
    unrequired = variant(actions=(ActionSpec("read", "Read"), ActionSpec("create", "Create")))
    assert registry.fingerprint(unrequired, op) != fingerprint
    no_wildcard = variant(kinds=(ResourceKind(FOLDER, "Folder", ("read", "create")), MixedConnector.kinds[1]))
    assert registry.fingerprint(no_wildcard, op) != fingerprint


# Requirements and records


async def test_copy_needs_read_on_the_source_and_create_on_the_destination(start, server):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    outcome = await executor.invoke(COPY, copy())
    assert outcome.result["count"] == 1
    denied = [copy(source="secret"), copy(source="archive", dest="inbox")]
    for arguments in denied:
        assert (await _error(executor.invoke(COPY, arguments))).code == "POLICY_DENIED"
    assert _posts(server) == 1


@pytest.mark.parametrize("mode", ["omit-source", "enumerate-write"])
async def test_requirements_that_break_the_declaration_are_rejected(start, server, mode):
    server.mode = mode
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    assert (await _error(executor.invoke(COPY, copy()))).code == "CONNECTOR_ERROR"
    assert _posts(server) == 0
    assert await _writes(executor) == []


async def test_prepare_cannot_write(start, server):
    server.mode = "write-in-prepare"
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    with pytest.raises(RuntimeError):
        await executor.invoke(COPY, copy())
    assert _posts(server) == 0
    assert await _writes(executor) == []


async def test_an_operation_sends_at_most_one_write(start, server):
    server.mode = "two-writes"
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    outcome = await executor.invoke(COPY, copy())
    assert outcome.result == APPLIED_WITHOUT_RESULT
    assert _posts(server) == 1


async def test_records_of_undeclared_kinds_or_other_connections_are_dropped(start, server):
    server.mode = "foreign-record"
    executor = await start({"*": ["read"]})
    outcome = await executor.invoke("mixed_list_folders", {})
    assert [item["id"] for item in outcome.result["items"]] == ["inbox", "archive", "secret"]


async def test_wildcard_grants_cover_resources_the_user_never_listed(start, server):
    executor = await start({"*": ["read"], "archive": ["create"]})
    server.folders["new"] = "New"
    assert (await executor.invoke(COPY, copy(source="new"))).result["count"] == 1
    assert (await _error(executor.invoke(COPY, copy(dest="inbox")))).code == "POLICY_DENIED"


# Write accounting


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (409, "PROVIDER_REJECTED"),
        (429, "PROVIDER_RATE_LIMITED"),
        (403, "PROVIDER_FORBIDDEN"),
        (httpx.ConnectError, "PROVIDER_UNAVAILABLE"),
    ],
)
async def test_a_refused_write_returns_its_quota_and_can_be_retried(start, server, response, code):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = [response]
    assert (await _error(executor.invoke(COPY, copy()))).code == code
    run = await _run(executor)
    assert (run.write_count, run.writes_uncertain) == (0, False)
    assert await _writes(executor) == []
    assert (await executor.invoke(COPY, copy())).result["count"] == 1
    assert (await _run(executor)).write_count == 1


@pytest.mark.parametrize("response", [500, 502, 418, httpx.ReadTimeout])
async def test_a_write_with_an_unknown_outcome_pauses_writes(start, server, response):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = [response]
    assert (await _error(executor.invoke(COPY, copy()))).code == "WRITE_UNCERTAIN"
    run = await _run(executor)
    assert (run.write_count, run.writes_uncertain) == (1, True)
    assert [w.status for w in await _writes(executor)] == [RunWrite.Status.UNCERTAIN]
    assert (await _error(executor.invoke(COPY, copy()))).code == "WRITE_UNCERTAIN"
    assert (await _error(executor.invoke(COPY, copy(name="b")))).code == "WRITE_UNCERTAIN"
    assert _posts(server) == 1


@pytest.mark.parametrize("response", [500, httpx.ReadTimeout])
async def test_a_connector_cannot_hide_an_unknown_write_outcome(start, server, response):
    server.mode = "swallow-errors"
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = [response]
    assert (await _error(executor.invoke(COPY, copy()))).code == "WRITE_UNCERTAIN"
    assert (await _run(executor)).writes_uncertain


@pytest.mark.parametrize("mode", ["swallow-errors", "no-write"])
async def test_a_write_that_sent_nothing_or_was_refused_returns_its_quota(start, server, mode):
    server.mode = mode
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = [409]
    assert (await executor.invoke(COPY, copy())).result["count"] == 0
    run = await _run(executor)
    assert (run.write_count, run.writes_uncertain) == (0, False)
    assert await _writes(executor) == []


async def test_a_write_applied_without_a_readable_result_counts_and_is_remembered(start, server):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = ["bad-json"]
    assert (await executor.invoke(COPY, copy())).result == APPLIED_WITHOUT_RESULT
    assert (await executor.invoke(COPY, copy())).result == APPLIED_WITHOUT_RESULT
    run = await _run(executor)
    assert (run.write_count, run.writes_uncertain) == (1, False)
    assert _posts(server) == 1
    assert (await executor.invoke(COPY, copy(name="b"))).result["count"] == 1


async def test_writes_run_one_at_a_time_and_a_cancelled_write_is_uncertain(start, server):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.gate = asyncio.Event()
    in_flight = asyncio.create_task(executor.invoke(COPY, copy()))
    await asyncio.wait_for(server.received.wait(), 5)
    assert (await _error(executor.invoke(COPY, copy()))).code == "WRITE_IN_PROGRESS"
    assert (await _error(executor.invoke(COPY, copy(name="b")))).code == "WRITE_IN_PROGRESS"
    in_flight.cancel()
    with pytest.raises(asyncio.CancelledError):
        await in_flight
    assert [w.status for w in await _writes(executor)] == [RunWrite.Status.UNCERTAIN]
    assert (await _run(executor)).writes_uncertain


async def test_a_write_is_not_sent_without_time_to_finish(start, server):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    await Run.unscoped.filter(pk=executor.context.run_id).aupdate(
        deadline=timezone.now() + timedelta(seconds=1.5)
    )
    assert (await _error(executor.invoke(COPY, copy()))).code == "TIMED_OUT"
    assert _posts(server) == 0
    assert (await _run(executor)).write_count == 0


async def test_time_spent_after_dispatch_counts_against_the_write(start, server, monkeypatch):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    await Run.unscoped.filter(pk=executor.context.run_id).aupdate(
        deadline=timezone.now() + timedelta(seconds=3)
    )
    current = executor_module.is_current

    def slow_current(run_id, attempt):
        # Slow only once the write is dispatched.
        if RunWrite.unscoped.filter(run_id=run_id).exists():
            time.sleep(1.5)
        return current(run_id, attempt)

    monkeypatch.setattr(executor_module, "is_current", slow_current)
    assert (await _error(executor.invoke(COPY, copy()))).code == "TIMED_OUT"
    assert _posts(server) == 0


async def test_the_sweep_marks_writes_that_never_settled(start, server):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    now = timezone.now()

    def dispatched(deadline_at):
        RunWrite.unscoped.all().delete()
        RunWrite.unscoped.create(
            workspace_id=executor.context.workspace_id,
            run_id=executor.context.run_id,
            key="k",
            status=RunWrite.Status.DISPATCHED,
            dispatched_at=now - timedelta(minutes=2),
            deadline_at=deadline_at,
        )

    await sync_to_async(dispatched)(now - timedelta(seconds=10))
    assert await sync_to_async(services.sweep_lost_writes)() == 0
    await sync_to_async(dispatched)(now - timedelta(seconds=40))
    assert await sync_to_async(services.sweep_lost_writes)() == 1
    assert (await _run(executor)).writes_uncertain
    assert [w.status for w in await _writes(executor)] == [RunWrite.Status.UNCERTAIN]


async def test_a_rejected_token_marks_the_connection_but_a_forbidden_request_does_not(start, server, mixed):
    executor = await start({"inbox": ["read"], "archive": ["read", "create"]})
    server.write_responses = [403]
    await _error(executor.invoke(COPY, copy()))
    assert (await Connection.unscoped.aget(pk=mixed.pk)).status == Connection.Status.ACTIVE
    server.write_responses = [401]
    assert (await _error(executor.invoke(COPY, copy()))).code == "CONNECTION_UNAUTHORIZED"
    assert (await Connection.unscoped.aget(pk=mixed.pk)).status == Connection.Status.ERROR
    assert (await _run(executor)).write_count == 0


async def test_a_rejection_of_replaced_credentials_does_not_mark_the_connection(mixed, server):
    def replace_credentials():
        connection = Connection.unscoped.get(pk=mixed.pk)
        connection.set_credentials({"kind": "oauth2", "access_token": "fresh", "scopes": None})
        connection.save()

    with pytest.raises(OperationError):
        async with connection_credentials.open_client("mixed", mixed.pk):
            await sync_to_async(replace_credentials)()
            raise OperationError("CONNECTION_UNAUTHORIZED", "stale")
    assert (await Connection.unscoped.aget(pk=mixed.pk)).status == Connection.Status.ACTIVE
    with pytest.raises(OperationError):
        async with connection_credentials.open_client("mixed", mixed.pk):
            try:
                raise OperationError("CONNECTION_UNAUTHORIZED", "current")
            except OperationError as error:
                raise OperationError("PROVIDER_FAILED", "wrapped") from error
    assert (await Connection.unscoped.aget(pk=mixed.pk)).status == Connection.Status.ERROR


# Consent, exposure, and contract changes


async def test_tools_need_provider_consent(start, mixed, server):
    labels = {(LABEL, "red"): ["read"], "inbox": ["read"]}
    executor = await start(labels)
    assert "mixed_list_labels" in executor.context.tools

    def set_scopes(scopes):
        connection = Connection.unscoped.get(pk=mixed.pk)
        connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": scopes})
        connection.save()

    await sync_to_async(set_scopes)(["files"])
    assert (await _error(executor.invoke("mixed_list_labels", {}))).code == "CONSENT_REQUIRED"
    assert ("GET", "/labels") not in server.calls
    assert "mixed_list_labels" not in (await start(labels)).context.tools
    await sync_to_async(set_scopes)(None)
    assert "mixed_list_labels" in (await start(labels)).context.tools


async def test_tools_are_offered_only_when_some_resource_could_allow_them(start):
    assert set((await start({})).context.tools) == set()
    assert set((await start({"inbox": ["read"]})).context.tools) == {"mixed_list_folders"}
    assert set((await start({"inbox": ["read"], "archive": ["read", "create"]})).context.tools) == {
        "mixed_list_folders",
        "mixed_copy_file",
    }


def test_a_wildcard_on_a_kind_without_wildcards_is_ignored(scoped, user, mixed):
    agent = Agent.objects.get()
    agent.connections.set([mixed])
    replace_grants(user, mixed, {(FOLDER, "inbox"): ["read"]})
    # Only a hand edit can store this; the API rejects it.
    Grant.objects.create(
        layer=user_layer(user.id), connection=mixed, resource_kind=LABEL, resource_id="*", actions=["read"]
    )
    conversation = Conversation.objects.create(agent=agent, user=user)
    _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    assert {tool["name"] for tool in run.tools} == {"mixed_list_folders"}
    assert not Policy.from_json(run.permissions).permits_any(str(mixed.pk), LABEL, "read")


async def test_a_tool_whose_contract_changed_stops_working(start, server):
    executor = await start({"inbox": ["read"]})
    tool = "mixed_list_folders"
    executor.context.tools[tool] = dataclasses.replace(executor.context.tools[tool], contract="stale")
    assert (await _error(executor.invoke(tool, {}))).code == "OPERATION_CHANGED"
    assert server.calls == []

    run = await _run(executor)
    await Run.unscoped.filter(pk=run.pk).aupdate(tools=[{**t, "contract": ""} for t in run.tools])
    ctx = SimpleNamespace(
        request=SimpleNamespace(scope={RUN_SCOPE_KEY: run.pk, ATTEMPT_SCOPE_KEY: run.attempt})
    )
    assert (await list_tools(ctx, None)).tools == []


# API keys and the account kind


def test_api_key_connections_act_on_their_account(scoped, user, server):
    connection = connection_services.save_api_key(
        workspace_id=scoped.id, owner_id=user.id, provider="keyed", key="secret-key"
    )
    assert connection.label == "Fake account"
    assert connection.credentials() == {"kind": "api_key", "key": "secret-key"}
    with pytest.raises(connection_oauth.ConnectionFlowError):
        connection_services.save_api_key(workspace_id=scoped.id, owner_id=user.id, provider="mixed", key="k")
    with pytest.raises(InvalidGrants):
        apply_grant_changes(
            user_id=user.id,
            connection=connection,
            changes=[GrantChange(ACCOUNT_KIND, "other", ("read",))],
            names={},
        )


async def test_account_grants_cover_account_operations(scoped, user, server, start):
    def connect():
        with workspace_scope(scoped.id):
            return connection_services.save_api_key(
                workspace_id=scoped.id, owner_id=user.id, provider="keyed", key="secret-key"
            )

    connection = await sync_to_async(connect)()
    executor = await start({(ACCOUNT_KIND, str(connection.pk)): ["read"]}, connection=connection)
    outcome = await executor.invoke("keyed_whoami", {})
    assert outcome.result["items"] == [{"id": "acct-1", "name": "Fake account"}]


# Run start and grant edits


def test_a_run_started_during_a_grant_edit_sees_the_edit(scoped, user, mixed, server):
    import threading
    import time

    from django.db import connection as db
    from django.db import transaction

    agent = Agent.objects.get()
    agent.connections.set([mixed])
    replace_grants(user, mixed, {(FOLDER, "inbox"): ["read"]})
    locked = threading.Event()

    def edit():
        try:
            with workspace_scope(scoped.id), transaction.atomic():
                layer = PermissionLayer.objects.select_for_update().get(level="user", user=user)
                locked.set()
                time.sleep(0.5)
                Grant.objects.filter(layer=layer).delete()
                services.revoke_active_runs(user_id=user.id, reason="permissions_changed")
        finally:
            db.close()

    thread = threading.Thread(target=edit)
    thread.start()
    assert locked.wait(5)
    conversation = Conversation.objects.create(agent=agent, user=user)
    _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    thread.join()
    run.refresh_from_db()
    assert run.status == Run.Status.QUEUED
    assert run.tools == []


# Access settings


def _patch(api, url: str, *changes: dict):
    return api.patch(url, data=json.dumps({"changes": list(changes)}), content_type="application/json")


def test_access_settings_understand_wildcards(api, workspace, mixed, server):
    url = f"/api/workspaces/{workspace.id}/connections/{mixed.id}/access"
    assert _patch(api, url, {"kind": FOLDER, "id": "*", "actions": ["read"]}).status_code == 200
    resources = api.get(f"{url}/resources?kind={FOLDER}").json()["items"]
    assert resources[0] == {
        "id": "inbox",
        "name": "Inbox",
        "actions": [],
        "inherited": ["read"],
        "expandable": False,
    }

    # Create on one folder relies on the wildcard read, so the read cannot be removed underneath it.
    saved = _patch(api, url, {"kind": FOLDER, "id": "archive", "actions": ["create"]})
    assert saved.status_code == 200
    assert {"kind": FOLDER, "id": "archive", "name": "Archive", "actions": ["create"]} in saved.json()[
        "grants"
    ]
    calls = len(server.calls)
    assert _patch(api, url, {"kind": FOLDER, "id": "*", "actions": []}).status_code == 422
    assert _patch(api, url, {"kind": FOLDER, "id": "archive", "actions": []}).status_code == 200
    assert len(server.calls) == calls

    rejected = [
        {"kind": LABEL, "id": "*", "actions": ["read"]},
        {"kind": FOLDER, "id": "ghost", "actions": ["read"]},
        {"kind": ACCOUNT_KIND, "id": str(mixed.id), "actions": ["read"]},
    ]
    for change in rejected:
        assert _patch(api, url, change).status_code == 422, change
    assert api.get(f"{url}/resources?kind=nope").status_code == 422


def test_account_access_needs_no_provider_call(api, scoped, user, server):
    workspace = scoped
    keyed = connection_services.save_api_key(
        workspace_id=workspace.id, owner_id=user.id, provider="keyed", key="secret-key"
    )
    url = f"/api/workspaces/{workspace.id}/connections/{keyed.id}/access"
    calls = len(server.calls)
    resources = api.get(f"{url}/resources?kind={ACCOUNT_KIND}").json()["items"]
    assert resources == [
        {"id": str(keyed.id), "name": "Fake account", "actions": [], "inherited": [], "expandable": False}
    ]
    saved = _patch(api, url, {"kind": ACCOUNT_KIND, "id": str(keyed.id), "actions": ["read"]})
    assert saved.json()["grants"] == [
        {"kind": ACCOUNT_KIND, "id": str(keyed.id), "name": "Fake account", "actions": ["read"]}
    ]
    assert len(server.calls) == calls


def test_a_connection_has_a_limited_number_of_grants(api, workspace, user, mixed, server):
    layer = user_layer(user.id)
    Grant.objects.bulk_create(
        Grant(
            workspace_id=workspace.id,
            layer=layer,
            connection=mixed,
            resource_kind=FOLDER,
            resource_id=f"f{i}",
            actions=["read"],
        )
        for i in range(MAX_GRANTS_PER_CONNECTION)
    )
    url = f"/api/workspaces/{workspace.id}/connections/{mixed.id}/access"
    assert _patch(api, url, {"kind": FOLDER, "id": "inbox", "actions": ["read"]}).status_code == 422
    assert _patch(api, url, {"kind": FOLDER, "id": "f0", "actions": ["read", "create"]}).status_code == 422
    assert _patch(api, url, {"kind": FOLDER, "id": "f0", "actions": []}).status_code == 200
    assert _patch(api, url, {"kind": FOLDER, "id": "inbox", "actions": ["read"]}).status_code == 200


# Credentials


def _expiring(connection: Connection, **tokens) -> None:
    connection.set_credentials(
        {
            "kind": "oauth2",
            "access_token": "old",
            "refresh_token": "r1",
            "expires_at": int(time.time()),
            **tokens,
        }
    )
    connection.save()


def test_a_refresh_keeps_scopes_unless_the_provider_names_them(mixed, token_endpoint):
    _, responses = token_endpoint
    _expiring(mixed, scopes=["files", "labels"], client_id="id")
    responses.append(httpx.Response(200, json={"access_token": "a2", "expires_in": 3600}))
    assert connection_credentials.access_secret(mixed.id).scopes == {"files", "labels"}
    mixed.refresh_from_db()
    assert mixed.credentials()["client_id"] == "id"
    _expiring(mixed, scopes=["files", "labels"])
    responses.append(httpx.Response(200, json={"access_token": "a3", "expires_in": 3600, "scope": "files"}))
    assert connection_credentials.access_secret(mixed.id).scopes == {"files"}
    # GitHub separates scopes with commas.
    _expiring(mixed)
    responses.append(
        httpx.Response(200, json={"access_token": "a4", "expires_in": 3600, "scope": "files,labels"})
    )
    assert connection_credentials.access_secret(mixed.id).scopes == {"files", "labels"}


def test_a_code_is_redeemed_by_the_client_the_flow_started_with(server, monkeypatch):
    operator = {"client": connection_oauth.ClientCredentials("one", "s1", "https://x/cb")}
    monkeypatch.setattr(connection_oauth, "_configured", lambda connector: operator["client"])
    sent: list[dict] = []
    monkeypatch.setattr(
        connection_oauth.httpx,
        "post",
        lambda url, **k: sent.append({"url": url, **k}) or httpx.Response(200, json={"access_token": "a"}),
    )
    session: dict = {}
    url = connection_oauth.authorization_url(session, workspace_id=uuid4(), provider="mixed")
    flow = session[connection_oauth.SESSION_KEY]
    assert flow["client_id"] == "one"
    assert parse_qs(urlparse(url).query)["client_id"] == ["one"]
    connector = registry.get("mixed")
    tokens = connection_oauth.exchange_code(connector, code="c", flow=flow)
    assert (tokens["client_id"], tokens["token_url"]) == ("one", "https://mixed.example/token")
    assert (sent[-1]["url"], sent[-1]["data"]["client_id"]) == ("https://mixed.example/token", "one")
    # The operator replaced the client while the user was at the provider.
    operator["client"] = connection_oauth.ClientCredentials("two", "s2", "https://x/cb")
    with pytest.raises(connection_oauth.ConnectionFlowError):
        connection_oauth.exchange_code(connector, code="c", flow=flow)
    assert len(sent) == 1


def test_a_refresh_goes_to_the_endpoint_that_issued_the_tokens(mixed, token_endpoint):
    sent, responses = token_endpoint
    responses += [httpx.Response(200, json={"access_token": "a2", "expires_in": 60}) for _ in range(2)]
    _expiring(mixed, client_id="id", token_url="https://old.mixed.example/token")
    connection_credentials.access_secret(mixed.id)
    assert [request["url"] for request in sent] == ["https://old.mixed.example/token"]
    mixed.refresh_from_db()
    assert mixed.credentials()["token_url"] == "https://old.mixed.example/token"
    # Tokens saved before the endpoint was recorded use the declared one.
    _expiring(mixed, client_id="id")
    connection_credentials.access_secret(mixed.id)
    assert sent[-1]["url"] == "https://mixed.example/token"
    mixed.refresh_from_db()
    assert mixed.credentials()["token_url"] == "https://mixed.example/token"


def test_a_refresh_needs_the_client_that_issued_the_tokens(mixed, token_endpoint):
    _expiring(mixed, client_id="retired")
    with pytest.raises(OperationError) as expired:
        connection_credentials.access_secret(mixed.id)
    assert expired.value.code == "CONNECTION_UNAUTHORIZED"
    mixed.refresh_from_db()
    assert mixed.status == Connection.Status.ERROR


def test_reconnecting_keeps_a_refresh_token_only_from_the_same_client(scoped, user, mixed, server):
    mixed.set_credentials({"kind": "oauth2", "access_token": "a", "refresh_token": "r1", "client_id": "id"})
    mixed.save()

    def reconnect(client_id: str) -> dict:
        tokens = {
            "kind": "oauth2",
            "access_token": "b",
            "refresh_token": None,
            "client_id": client_id,
            "token_url": "https://mixed.example/token",
        }
        connection_services.save_connection(
            workspace_id=scoped.id, owner_id=user.id, provider="mixed", tokens=tokens
        )
        return Connection.objects.get(pk=mixed.pk).credentials()

    assert reconnect("id")["refresh_token"] == "r1"
    assert reconnect("other")["refresh_token"] is None
    # A kept refresh token still goes to the endpoint that issued it.
    mixed.set_credentials(
        {
            "kind": "oauth2",
            "access_token": "a",
            "refresh_token": "r1",
            "client_id": "id",
            "token_url": "https://old.mixed.example/token",
        }
    )
    mixed.save()
    kept = reconnect("id")
    assert (kept["refresh_token"], kept["token_url"]) == ("r1", "https://old.mixed.example/token")
    # Tokens saved before the issuer was recorded may come from another client.
    mixed.set_credentials({"kind": "oauth2", "access_token": "a", "refresh_token": "r1"})
    mixed.save()
    assert reconnect("id")["refresh_token"] is None


def test_operator_clients_are_configured_per_app():
    settings = config().model_copy(
        update={"google_client_id": "gid", "google_client_secret": SecretStr("gs")}
    )
    assert settings.oauth_client("google") == ("gid", "gs")
    assert settings.oauth_client("mixed") is None
    assert settings.model_copy(update={"google_client_id": ""}).oauth_client("google") is None


async def test_a_write_cannot_be_sent_after_its_attempt_was_judged():
    server = FakeServer()
    client = MixedConnector(server).client("t")
    gate = asyncio.Event()

    async def late_write():
        await gate.wait()
        await client.request("POST", "/copies", json={})

    with write_attempt(time.monotonic() + 60) as attempt:
        task = asyncio.create_task(late_write())
        await asyncio.sleep(0)
        assert attempt.outcome() == Effect.NOT_APPLIED
        gate.set()
        with pytest.raises(RuntimeError):
            await task
    assert _posts(server) == 0
    await client.aclose()
