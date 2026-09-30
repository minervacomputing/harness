"""The permission executor: every tool call from an agent goes through this one pipeline.

strict validation → resolve real targets → check effective permissions → reserve write quota →
call the provider → drop records the run may not see → return results with run-bound page tokens.

Run state (write quota, deduplication, uncertain writes, page tokens) lives in the database, so any
gateway process can serve any call. Revocation is checked around every await.
"""

import hashlib
import json
import logging
import secrets
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import IntegrityError, transaction
from django.db import connection as db
from pydantic import ValidationError

from connections.services import open_client
from connectors import registry
from connectors.base import DENIED, Binding, Connector, Operation, OperationError
from permissions.policy import Policy, Resource
from runs.models import Run, RunPageToken, RunWrite
from runs.services import ToolRef, is_token_valid

log = logging.getLogger(__name__)
MAX_PAGE_TOKENS = 200
# The provider refused these requests outright, so a write with one of them was not applied.
REJECTED_BEFORE_APPLYING = frozenset({"CONNECTION_UNAUTHORIZED", "NOT_FOUND", "PROVIDER_RATE_LIMITED"})


@dataclass(frozen=True)
class RunContext:
    run_id: UUID
    workspace_id: UUID
    policy: Policy
    tools: dict[str, ToolRef]

    @classmethod
    def from_run(cls, run: Run) -> RunContext:
        return cls(
            run_id=run.id,
            workspace_id=run.workspace_id,
            policy=Policy.from_json(run.permissions),
            tools={item["name"]: ToolRef(**item) for item in run.tools},
        )


@dataclass(frozen=True)
class Outcome:
    result: dict[str, Any]
    title: str


def _canonical(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def validation_message(error: ValidationError) -> str:
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


class Executor:
    def __init__(self, context: RunContext) -> None:
        self.context = context

    async def _ensure_active(self) -> None:
        if not await sync_to_async(is_token_valid)(self.context.run_id):
            raise OperationError("RUN_ENDED", "This run is no longer active.")

    def operation_for(self, tool: str) -> tuple[ToolRef, Operation]:
        ref = self.context.tools.get(tool)
        op = registry.get(ref.provider).operation(ref.operation) if ref else None
        if ref is None or op is None:
            raise OperationError("UNKNOWN_OPERATION", "This operation is not available.")
        return ref, op

    async def invoke(self, tool: str, raw: Any) -> Outcome:
        ref, op = self.operation_for(tool)
        await self._ensure_active()
        try:
            data = op.input_model.model_validate(raw if raw is not None else {})
        except ValidationError as error:
            raise OperationError("INVALID_ARGUMENTS", validation_message(error)) from error
        fields = data.model_dump()
        query_hash = _hash(_canonical({k: v for k, v in fields.items() if k != "cursor"}))

        if op.paginated and fields.get("cursor"):
            upstream = await self._resolve_cursor(tool, fields["cursor"], query_hash)
            data = data.model_copy(update={"cursor": upstream})

        if not op.mutates:
            return Outcome(await self._perform(ref, op, data, tool, query_hash), op.title)

        write_key = _hash(f"{tool}:{_canonical(fields)}")
        previous = await sync_to_async(self._begin_write)(write_key)
        if previous is not None:
            return Outcome(previous, op.title)
        try:
            result = await self._perform(ref, op, data, tool, query_hash, write_key=write_key)
        except Exception:
            # Refusals (denied, limit, ended) may be retried; applied and uncertain writes are remembered,
            # because `_perform` records them before anything else can fail.
            await RunWrite.unscoped.filter(
                run_id=self.context.run_id, key=write_key, status=RunWrite.Status.PENDING
            ).adelete()
            raise
        return Outcome(result, op.title)

    def _permits(self, connector: Connector, resource: Resource, action_id: str) -> bool:
        """The action and every action it requires, checked against the intersected layers.

        Requirements are checked here rather than only when grants are saved, because layers can combine
        into a policy that allows an action without its requirement.
        """
        seen: set[str] = set()
        current: str | None = action_id
        while current is not None and current not in seen:
            if not self.context.policy.permits(resource, current):
                return False
            seen.add(current)
            spec = connector.action(current)
            current = spec.requires if spec else None
        return True

    def _begin_write(self, key: str) -> dict | None:
        run = Run.unscoped.only("writes_uncertain").get(pk=self.context.run_id)
        if run.writes_uncertain:
            raise OperationError(
                "WRITE_UNCERTAIN",
                "A previous write has an unknown outcome. Further writes in this run are paused.",
            )
        try:
            with transaction.atomic():
                RunWrite.unscoped.create(
                    workspace_id=self.context.workspace_id, run_id=self.context.run_id, key=key
                )
        except IntegrityError:
            existing = RunWrite.unscoped.get(run_id=self.context.run_id, key=key)
            if existing.status == RunWrite.Status.SUCCEEDED:
                return existing.result
            if existing.status == RunWrite.Status.UNCERTAIN:
                raise OperationError(
                    "WRITE_UNCERTAIN",
                    "This write has an unknown outcome. Check the provider before retrying.",
                ) from None
            raise OperationError("WRITE_IN_PROGRESS", "An identical write is already in progress.") from None
        return None

    def _reserve_write(self) -> None:
        with db.cursor() as cursor:
            cursor.execute(
                "UPDATE runs_run SET write_count = write_count + 1 "
                "WHERE id = %s AND write_count < max_writes AND NOT writes_uncertain RETURNING write_count",
                [self.context.run_id],
            )
            reserved = cursor.fetchone()
        if reserved is None:
            run = Run.unscoped.only("writes_uncertain", "max_writes").get(pk=self.context.run_id)
            if run.writes_uncertain:
                raise OperationError(
                    "WRITE_UNCERTAIN",
                    "A previous write has an unknown outcome. Further writes in this run are paused.",
                )
            raise OperationError(
                "LIMIT_REACHED", f"This run has reached its limit of {run.max_writes} writes."
            )

    def _mark_uncertain(self, key: str) -> None:
        Run.unscoped.filter(pk=self.context.run_id).update(writes_uncertain=True)
        RunWrite.unscoped.filter(run_id=self.context.run_id, key=key).update(status=RunWrite.Status.UNCERTAIN)

    async def _perform(
        self,
        ref: ToolRef,
        op: Operation,
        data: Any,
        tool: str,
        query_hash: str,
        *,
        write_key: str | None = None,
    ) -> dict[str, Any]:
        connector = registry.get(ref.provider)
        async with open_client(ref.provider, UUID(ref.connection_id)) as client:
            binding = Binding(ref.connection_id, client)
            prepared = await op.prepare(binding, data)
            await self._ensure_active()
            for target in prepared.targets:
                if target.connection_id != ref.connection_id or not self._permits(
                    connector, target, op.action
                ):
                    raise OperationError("POLICY_DENIED", DENIED)
            if op.mutates:
                if not prepared.targets:
                    raise OperationError("POLICY_DENIED", "A write needs an explicitly allowed destination.")
                await sync_to_async(self._reserve_write)()
                await self._ensure_active()
            try:
                output = await prepared.execute()
            except Exception as error:
                refused = isinstance(error, OperationError) and error.code in REJECTED_BEFORE_APPLYING
                if op.mutates and write_key is not None and not refused:
                    await sync_to_async(self._mark_uncertain)(write_key)
                    log.warning(
                        "Write outcome unknown for run %s tool %s: %r", self.context.run_id, tool, error
                    )
                    raise OperationError(
                        "WRITE_UNCERTAIN",
                        "The write outcome is unknown. Check the provider; further writes in this run are paused.",
                    ) from error
                raise
            items = [
                record.data
                for record in output.records
                if record.resource.connection_id == ref.connection_id
                and self._permits(connector, record.resource, op.action)
            ]
            result: dict[str, Any] = {"items": items, "count": len(items)}
            if write_key is not None:
                # The provider applied the write: record it before any later step can fail and drop it.
                try:
                    await RunWrite.unscoped.filter(run_id=self.context.run_id, key=write_key).aupdate(
                        status=RunWrite.Status.SUCCEEDED, result=result
                    )
                except Exception:
                    # Never leave an applied write pending, or `invoke` would delete it and allow a repeat.
                    await sync_to_async(self._mark_uncertain)(write_key)
                    raise
            await self._ensure_active()

        if output.next_cursor and op.paginated:
            result["next_cursor"] = await sync_to_async(self._issue_cursor)(
                tool, query_hash, output.next_cursor
            )
        return result

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
