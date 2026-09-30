"""Connector contract.

A connector declares its resource kinds, the actions on them, how it authenticates, and a list of
operations. Each operation validates its input strictly and declares which (kind, action) pairs it needs.
`prepare()` resolves the real resources a call touches before anything is authorized; returned records
carry their actual resource, so results can be filtered after the call. Provider-specific knowledge lives
in connectors; the generic rules live in the executor, which checks every declaration at runtime.
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict

from permissions.policy import Resource

# A reserved kind for account-level actions; its one resource id is the connection id.
ACCOUNT_KIND = "account"


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
    # An action that must also be allowed on the same resource, e.g. create requires read.
    requires: str | None = None


@dataclass(frozen=True, slots=True)
class ResourceKind:
    id: str
    label: str
    actions: tuple[str, ...]
    # Whether one grant may cover every resource of this kind ("All calendars").
    wildcard: bool = False


@dataclass(frozen=True, slots=True)
class DiscoveryItem:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class DiscoveryPage:
    items: list[DiscoveryItem]
    next_cursor: str | None = None


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


@dataclass(frozen=True, slots=True)
class Need:
    """The call touches this resource and needs this action (and what it requires) on it."""

    resource: Resource
    action: str


@dataclass(frozen=True, slots=True)
class Enumerate:
    """A read over resources of a kind; it passes if some resource could be allowed, and its results are
    filtered per record. Never valid for writes."""

    kind: str
    action: str


Requirement = Need | Enumerate


@dataclass(slots=True)
class Prepared:
    requirements: list[Requirement]
    execute: Callable[[], Awaitable[ProviderOutput]]


@dataclass(frozen=True, slots=True)
class Binding:
    """One connection as seen by one call: its id and an authenticated provider client."""

    connection_id: str
    client: Any

    def resource(self, kind: str, resource_id: str) -> Resource:
        return Resource(self.connection_id, kind, resource_id)

    def account(self) -> Resource:
        return Resource(self.connection_id, ACCOUNT_KIND, self.connection_id)


# Provider scopes an operation works with: any one of these sets, each granted in full.
Consent = tuple[frozenset[str], ...]


def consent_given(consent: Consent | None, scopes: frozenset[str] | None) -> bool:
    """Unknown scopes (None) pass: the provider is then the one to refuse."""
    return consent is None or scopes is None or any(option <= scopes for option in consent)


@dataclass(frozen=True, slots=True)
class Operation:
    name: str
    title: str
    description: str
    input_model: type[OperationInput]
    prepare: Callable[[Binding, Any], Awaitable[Prepared]]
    # Every (kind, action) pair the operation can need. Runtime requirements must cover exactly these.
    needs: tuple[tuple[str, str], ...]
    # The action each returned record must allow on its own resource.
    output_action: str = "read"
    consent: Consent | None = None
    # Bump when the operation's meaning changes in a way the declarations above do not show.
    revision: int = 1
    mutates: bool = False
    paginated: bool = field(default=False)

    def input_schema(self) -> dict[str, Any]:
        return self.input_model.model_json_schema()


@dataclass(frozen=True, slots=True)
class OAuth2:
    # Names the operator's client configuration (MINERVA_<APP>_CLIENT_ID); several connectors may share one.
    app: str
    authorize_url: str
    token_url: str
    scopes: tuple[str, ...]
    # Dynamic client registration, used when the operator configured no client.
    registration_url: str | None = None
    authorize_params: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class ApiKey:
    label: str


AuthStrategy = OAuth2 | ApiKey


class Connector(ABC):
    slug: ClassVar[str]
    name: ClassVar[str]
    kinds: ClassVar[tuple[ResourceKind, ...]]
    actions: ClassVar[tuple[ActionSpec, ...]]
    auth: ClassVar[AuthStrategy]

    @property
    @abstractmethod
    def operations(self) -> tuple[Operation, ...]: ...

    @abstractmethod
    def client(self, secret: str) -> Any:
        """An authenticated provider client. Owned by one request; closed via `aclose()`."""

    @abstractmethod
    async def account(self, client: Any) -> Account: ...

    @abstractmethod
    async def discover(
        self, client: Any, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        """One page of resources of `kind` the account can see, for choosing what to grant."""

    @abstractmethod
    async def describe(self, client: Any, kind: str, ids: list[str]) -> dict[str, str]:
        """Names of the given resources. Resources the account cannot see are left out."""

    def operation(self, name: str) -> Operation | None:
        return next((op for op in self.operations if op.name == name), None)

    def action(self, action_id: str) -> ActionSpec | None:
        return next((a for a in self.actions if a.id == action_id), None)

    def kind(self, kind_id: str) -> ResourceKind | None:
        return next((k for k in self.kinds if k.id == kind_id), None)

    def requires_of(self, action_id: str) -> str | None:
        spec = self.action(action_id)
        return spec.requires if spec else None
