"""Connector contract.

A connector declares its resource kinds and actions, and a list of operations. Each operation validates
its input strictly, then `prepare()` resolves which real resources the call touches before anything is
authorized. Returned records carry their actual resource, so results can be filtered after the call.
Provider-specific knowledge lives in connectors; the generic rules live in the executor.
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict

from permissions.policy import Resource


class OperationError(Exception):
    """An owned, deliberately safe error. Only these messages reach the model or the UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


DENIED = "This resource or action is not available under the current permissions."


class OperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)


@dataclass(frozen=True, slots=True)
class ActionSpec:
    id: str
    label: str
    requires: str | None = None


@dataclass(frozen=True, slots=True)
class ScopeItem:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class Account:
    id: str
    label: str


@dataclass(slots=True)
class ScopedRecord:
    resource: Resource
    data: dict[str, Any]


@dataclass(slots=True)
class ProviderOutput:
    records: list[ScopedRecord]
    next_cursor: str | None = None


@dataclass(slots=True)
class Prepared:
    targets: list[Resource]
    execute: Callable[[], Awaitable[ProviderOutput]]


@dataclass(frozen=True, slots=True)
class Binding:
    """One connection as seen by one call: its id and an authenticated provider client."""

    connection_id: str
    client: Any

    def resource(self, kind: str, resource_id: str) -> Resource:
        return Resource(self.connection_id, kind, resource_id)


@dataclass(frozen=True, slots=True)
class Operation:
    name: str
    title: str
    description: str
    input_model: type[OperationInput]
    action: str
    prepare: Callable[[Binding, Any], Awaitable[Prepared]]
    mutates: bool = False
    paginated: bool = field(default=False)

    def input_schema(self) -> dict[str, Any]:
        return self.input_model.model_json_schema()


@dataclass(frozen=True, slots=True)
class OAuthSpec:
    authorize_url: str
    token_url: str
    scope: str
    registration_url: str | None = None


class Connector(ABC):
    slug: ClassVar[str]
    name: ClassVar[str]
    scope_kind: ClassVar[str]
    scope_label: ClassVar[str]
    actions: ClassVar[tuple[ActionSpec, ...]]
    oauth: ClassVar[OAuthSpec]

    @property
    @abstractmethod
    def operations(self) -> tuple[Operation, ...]: ...

    @abstractmethod
    def client(self, access_token: str) -> Any:
        """An authenticated provider client. Owned by one request; closed via `aclose()`."""

    @abstractmethod
    async def account(self, client: Any) -> Account: ...

    @abstractmethod
    async def list_scope(self, client: Any) -> list[ScopeItem]:
        """Resources of `scope_kind` the connected account can see; grants are made on these."""

    def operation(self, name: str) -> Operation | None:
        return next((op for op in self.operations if op.name == name), None)

    def action(self, action_id: str) -> ActionSpec | None:
        return next((a for a in self.actions if a.id == action_id), None)
