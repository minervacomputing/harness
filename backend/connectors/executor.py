"""The permission executor: every tool call from an agent goes through this one pipeline.

strict validation → provider consent → resolve what the call touches → check effective permissions →
dispatch the write (one at a time, deduplication) → call the provider → settle the write → drop records the run
may not see → return results with run-bound page tokens.

Run state (writes in flight, deduplication, uncertain writes, page tokens) lives in the database, so any
gateway process can serve any call. Revocation is checked around every await and when a write is
dispatched.
"""

import asyncio
import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import transaction
from django.utils import timezone
from pydantic import ValidationError

from connections.credentials import open_client
from connectors import registry
from connectors.base import (
    ACCOUNT_KIND,
    DENIED,
    Binding,
    Connector,
    Enumerate,
    Need,
    Operation,
    OperationError,
    ProviderOutput,
    Requirement,
    consent_given,
)
from connectors.http import Effect, write_attempt
from permissions.policy import ANY, Policy, Resource
from runs.models import Run, RunPageToken, RunWrite
from runs.services import ToolRef, is_current, is_token_valid

log = logging.getLogger(__name__)
MAX_PAGE_TOKENS = 200
MAX_ANCESTORS = 64
# How long one write may take. The run's own deadline shortens it.
WRITE_WINDOW = timedelta(seconds=60)
# The provider client enforces the write window; this only stops a connector that ignores it.
BACKSTOP_SECONDS = 5.0
APPLIED_WITHOUT_RESULT = {"items": [], "count": 0, "outcome": "applied_without_result"}
# What every operation returns; the gateway declares it to the worker as each tool's output schema.
RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {"type": "object"},
            "description": "Records this run may see. Their fields depend on the tool.",
        },
        "count": {
            "type": "integer",
            "minimum": 0,
            "description": "The number of items in this result, not a total across pages.",
        },
        "incomplete": {"const": True, "description": "A provider or connector limit left something out."},
        "next_cursor": {
            "type": "string",
            "minLength": 1,
            "description": "More items may follow: repeat the call with the same arguments and this as cursor.",
        },
        "outcome": {
            "const": "applied_without_result",
            "description": "The write took effect, but its result could not be read back.",
        },
    },
    "required": ["items", "count"],
    "additionalProperties": False,
}
PAUSED = "A previous write has an unknown outcome. Further writes in this run are paused."


@dataclass(frozen=True)
class RunContext:
    run_id: UUID
    workspace_id: UUID
    policy: Policy
    tools: dict[str, ToolRef]
    # The attempt whose worker made the call. Work starts only while it is the run's current one.
    attempt: int

    @classmethod
    def from_run(cls, run: Run, attempt: int | None = None) -> RunContext:
        return cls(
            run_id=run.id,
            workspace_id=run.workspace_id,
            policy=Policy.from_json(run.permissions),
            tools={item["name"]: ToolRef(**item) for item in run.tools},
            attempt=run.attempt if attempt is None else attempt,
        )


@dataclass(frozen=True)
class Outcome:
    result: dict[str, Any]
    title: str
    # An identical write this run made earlier answered the call; nothing was sent.
    repeat: bool = False
    # Set for a write: identical writes of a run share it.
    write_key: str | None = None


@dataclass(frozen=True)
class Dispatch:
    # Set when an identical write already succeeded; nothing is sent then.
    cached: dict | None
    deadline: float = 0.0  # time.monotonic(); fixed at dispatch so later waits do not extend it


def _canonical(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def validation_message(error: ValidationError) -> str:
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


def _connector_bug(where: str, problem: str) -> OperationError:
    log.error("Connector contract violation in %s: %s", where, problem)
    return OperationError("CONNECTOR_ERROR", "This operation failed because of an internal error.")


def _shape_problem(connector: Connector, resource: Resource) -> str | None:
    """Why a resource from a connector is malformed, or None."""
    if not connector.nests(resource.kind):
        if resource.within or resource.partial:
            return "ancestors on a kind that does not nest"
        return None
    ids = resource.ids()
    if len(resource.within) > MAX_ANCESTORS or ANY in ids or len(set(ids)) != len(ids):
        return "malformed ancestors"
    return None


def _known_write(write: RunWrite) -> dict:
    """The outcome of a write this run already sent with the same arguments."""
    if write.status == RunWrite.Status.SUCCEEDED:
        return write.result
    if write.status == RunWrite.Status.UNCERTAIN:
        raise OperationError(
            "WRITE_UNCERTAIN", "This write has an unknown outcome. Check the provider before retrying."
        )
    raise OperationError("WRITE_IN_PROGRESS", "An identical write is already in progress.")


class Executor:
    def __init__(self, context: RunContext) -> None:
        self.context = context

    async def _ensure_current(self) -> None:
        """Before work starts: the run can still act and the calling attempt has not been replaced."""
        if not await sync_to_async(is_current)(self.context.run_id, self.context.attempt):
            raise OperationError("RUN_ENDED", "This run is no longer active.")

    async def _ensure_active(self) -> None:
        """After work finished: the run can still act. A replaced attempt still gets its answer, so that a
        write it made is recorded."""
        if not await sync_to_async(is_token_valid)(self.context.run_id):
            raise OperationError("RUN_ENDED", "This run is no longer active.")

    def operation_for(self, tool: str) -> tuple[ToolRef, Operation]:
        ref = self.context.tools.get(tool)
        if ref is None:
            raise OperationError("UNKNOWN_OPERATION", "This operation is not available.")
        op = registry.resolve(ref.provider, ref.operation, ref.contract)
        if op is None:
            raise OperationError(
                "OPERATION_CHANGED",
                "This operation changed after the run started. Send a new message to use it.",
            )
        return ref, op

    async def invoke(self, tool: str, raw: Any) -> Outcome:
        await self._ensure_current()
        ref, op = self.operation_for(tool)
        try:
            data = op.input_model.model_validate(raw if raw is not None else {})
        except ValidationError as error:
            raise OperationError("INVALID_ARGUMENTS", validation_message(error)) from error
        fields = data.model_dump()
        query_hash = _hash(_canonical({k: v for k, v in fields.items() if k != "cursor"}))

        if op.paginated and fields.get("cursor"):
            upstream = await self._resolve_cursor(tool, fields["cursor"], query_hash)
            data = data.model_copy(update={"cursor": upstream})

        write_key = _hash(f"{tool}:{_canonical(fields)}") if op.mutates else None
        if write_key is not None:
            known = await RunWrite.unscoped.filter(run_id=self.context.run_id, key=write_key).afirst()
            if known is not None:
                return Outcome(_known_write(known), op.title, repeat=True, write_key=write_key)
        result, repeat = await self._perform(ref, op, data, tool, query_hash, write_key)
        return Outcome(result, op.title, repeat=repeat, write_key=write_key)

    def _authorize(
        self, connector: Connector, op: Operation, ref: ToolRef, requirements: list[Requirement]
    ) -> None:
        """Checks what prepare() says the call touches against the declaration, then against the policy."""
        where = f"{ref.provider}.{op.name}"
        policy = self.context.policy
        covered: set[tuple[str, str]] = set()
        concrete = False
        denied = False
        for requirement in requirements:
            if isinstance(requirement, Need):
                resource = requirement.resource
                pair = (resource.kind, requirement.action)
                if (
                    resource.connection_id != ref.connection_id
                    or resource.id == ANY
                    or (resource.kind == ACCOUNT_KIND and resource.id != ref.connection_id)
                    or _shape_problem(connector, resource)
                ):
                    raise _connector_bug(where, f"invalid resource {resource!r}")
                concrete = True
                allowed = policy.permits(resource, requirement.action, connector.requires_of)
            elif isinstance(requirement, Enumerate):
                pair = (requirement.kind, requirement.action)
                if op.mutates:
                    raise _connector_bug(where, "a write cannot enumerate")
                allowed = policy.permits_any(
                    ref.connection_id,
                    requirement.kind,
                    requirement.action,
                    connector.requires_of,
                    connector.nests(requirement.kind),
                )
            else:
                raise _connector_bug(where, f"unknown requirement {requirement!r}")
            if pair not in op.needs:
                raise _connector_bug(where, f"undeclared need {pair!r}")
            covered.add(pair)
            denied = denied or not allowed
        if covered != set(op.needs):
            raise _connector_bug(where, f"needs not covered: {sorted(set(op.needs) - covered)!r}")
        if op.mutates and not concrete:
            raise _connector_bug(where, "a write needs a concrete destination")
        if denied:
            raise OperationError("POLICY_DENIED", DENIED)

    def _result(
        self, connector: Connector, op: Operation, ref: ToolRef, output: ProviderOutput
    ) -> dict[str, Any]:
        kinds = {kind for kind, _ in op.needs}
        items = []
        for record in output.records:
            resource = record.resource
            if (
                resource.connection_id != ref.connection_id
                or resource.kind not in kinds
                or resource.id == ANY
                or _shape_problem(connector, resource)
                # An unrestricted policy passes any action, even one the kind does not have.
                or op.output_action not in connector.kind(resource.kind).actions
            ):
                log.error("Connector %s.%s returned a record with %r", ref.provider, op.name, resource)
                continue
            if self.context.policy.permits(resource, op.output_action, connector.requires_of):
                items.append(record.data)
        result: dict[str, Any] = {"items": items, "count": len(items)}
        if output.incomplete:
            result["incomplete"] = True
        return result

    async def _perform(
        self, ref: ToolRef, op: Operation, data: Any, tool: str, query_hash: str, write_key: str | None
    ) -> tuple[dict[str, Any], bool]:
        """The result, and whether an identical earlier write answered the call."""
        connector = registry.get(ref.provider)
        async with open_client(ref.provider, UUID(ref.connection_id)) as opened:
            if not consent_given(op.consent, opened.scopes):
                raise OperationError(
                    "CONSENT_REQUIRED",
                    f"{connector.name} has not given Minerva access for this yet. "
                    "The user can allow it on Minerva's connections page.",
                )
            prepared = await op.prepare(Binding(ref.connection_id, opened.client), data)
            if not prepared.requirements:
                raise _connector_bug(f"{ref.provider}.{op.name}", "no requirements")
            self._authorize(connector, op, ref, prepared.requirements)
            await self._ensure_current()
            repeat = False
            if write_key is None:
                output = await prepared.execute()
                result = self._result(connector, op, ref, output)
            else:
                output = None
                result, repeat = await self._write(connector, op, ref, write_key, prepared.execute)
            await self._ensure_active()

        if output is not None and output.next_cursor and op.paginated:
            result["next_cursor"] = await sync_to_async(self._issue_cursor)(
                tool, query_hash, output.next_cursor
            )
        return result, repeat

    async def _write(
        self, connector: Connector, op: Operation, ref: ToolRef, key: str, execute
    ) -> tuple[dict[str, Any], bool]:
        """The write's result, and whether an identical earlier write answered it."""
        dispatch = await sync_to_async(self._dispatch)(key)
        if dispatch.cached is not None:
            return dispatch.cached, True
        if not await sync_to_async(is_current)(self.context.run_id, self.context.attempt):
            await asyncio.shield(sync_to_async(self._settle)(key, None))
            raise OperationError("RUN_ENDED", "This run is no longer active.")
        with write_attempt(dispatch.deadline) as attempt:
            try:
                async with asyncio.timeout_at(self._loop_time(dispatch.deadline) + BACKSTOP_SECONDS):
                    output = await execute()
                # A normal return proves nothing about the write: the connector may have swallowed a
                # timeout, or left the request running in a task.
                if attempt.outcome() == Effect.UNKNOWN:
                    raise OperationError("PROVIDER_UNAVAILABLE", "The write did not report its outcome.")
                result = self._result(connector, op, ref, output)
            except BaseException as error:
                effect = attempt.outcome()
                if effect == Effect.NOT_APPLIED:
                    await asyncio.shield(sync_to_async(self._settle)(key, None))
                    raise
                if effect == Effect.APPLIED:
                    log.warning(
                        "Write applied without a usable result in run %s: %r", self.context.run_id, error
                    )
                    await asyncio.shield(
                        sync_to_async(self._settle)(key, RunWrite.Status.SUCCEEDED, APPLIED_WITHOUT_RESULT)
                    )
                    if not isinstance(error, Exception):
                        raise
                    return dict(APPLIED_WITHOUT_RESULT), False
                log.warning("Write outcome unknown in run %s: %r", self.context.run_id, error)
                await asyncio.shield(sync_to_async(self._settle)(key, RunWrite.Status.UNCERTAIN))
                if not isinstance(error, Exception):
                    raise
                raise OperationError(
                    "WRITE_UNCERTAIN",
                    "The write outcome is unknown. Check the provider; further writes in this run are paused.",
                ) from error
        if attempt.outcome() == Effect.NOT_APPLIED:
            # The connector sent nothing, or handled a refusal itself.
            await asyncio.shield(sync_to_async(self._settle)(key, None))
            return result, False
        await asyncio.shield(sync_to_async(self._settle)(key, RunWrite.Status.SUCCEEDED, result))
        return result, False

    @staticmethod
    def _loop_time(deadline: float) -> float:
        """A time.monotonic() deadline on the event loop's clock."""
        return asyncio.get_running_loop().time() + (deadline - time.monotonic())

    def _dispatch(self, key: str) -> Dispatch:
        """Claims the write before anything is sent. Locks the run first, like every write transition. This is
        where a write starts: one claimed here is carried out even if its attempt is replaced meanwhile, and a
        run restarts only once none of its writes is still dispatched (services.restart)."""
        with transaction.atomic():
            run = (
                Run.unscoped.select_for_update()
                .only("status", "deadline", "attempt", "writes_uncertain")
                .get(pk=self.context.run_id)
            )
            now = timezone.now()
            clock = time.monotonic()
            if run.status not in Run.TOKEN_VALID or run.expired(now) or run.attempt != self.context.attempt:
                raise OperationError("RUN_ENDED", "This run is no longer active.")
            known = RunWrite.unscoped.filter(run_id=run.pk, key=key).first()
            if known is not None:
                return Dispatch(_known_write(known))
            if run.writes_uncertain:
                raise OperationError("WRITE_UNCERTAIN", PAUSED)
            if RunWrite.unscoped.filter(run_id=run.pk, status=RunWrite.Status.DISPATCHED).exists():
                raise OperationError("WRITE_IN_PROGRESS", "Another write in this run is still in progress.")
            deadline_at = now + WRITE_WINDOW
            if run.deadline is not None:
                deadline_at = min(deadline_at, run.deadline)
            RunWrite.unscoped.create(
                workspace_id=self.context.workspace_id,
                run_id=run.pk,
                key=key,
                status=RunWrite.Status.DISPATCHED,
                dispatched_at=now,
                deadline_at=deadline_at,
            )
        return Dispatch(None, clock + (deadline_at - now).total_seconds())

    def _settle(self, key: str, status: str | None, result: dict | None = None) -> None:
        """Records how a dispatched write ended; None means it was not applied, so it can be tried again."""
        with transaction.atomic():
            Run.unscoped.select_for_update().only("id").get(pk=self.context.run_id)
            write = RunWrite.unscoped.filter(
                run_id=self.context.run_id, key=key, status=RunWrite.Status.DISPATCHED
            )
            if status is None:
                write.delete()
            elif status == RunWrite.Status.SUCCEEDED:
                write.update(status=status, result=result)
            else:
                write.update(status=status)
                Run.unscoped.filter(pk=self.context.run_id).update(writes_uncertain=True)

    def _issue_cursor(self, tool: str, query_hash: str, upstream: str) -> str:
        if RunPageToken.unscoped.filter(run_id=self.context.run_id).count() >= MAX_PAGE_TOKENS:
            raise OperationError("LIMIT_REACHED", "This run has reached its pagination limit.")
        token = secrets.token_urlsafe(18)
        RunPageToken.unscoped.create(
            workspace_id=self.context.workspace_id,
            run_id=self.context.run_id,
            token=token,
            tool=tool,
            query_hash=query_hash,
            upstream_cursor=upstream,
        )
        return token

    async def _resolve_cursor(self, tool: str, cursor: str, query_hash: str) -> str:
        binding = await RunPageToken.unscoped.filter(run_id=self.context.run_id, token=cursor).afirst()
        if binding is None or binding.tool != tool or binding.query_hash != query_hash:
            raise OperationError(
                "INVALID_CURSOR", "This page token is invalid or belongs to another request."
            )
        return binding.upstream_cursor


def public_error(error: BaseException) -> str:
    if isinstance(error, OperationError):
        return error.message
    return "The operation could not be completed. Check the connection and try again."
