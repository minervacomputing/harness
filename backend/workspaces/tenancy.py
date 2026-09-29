"""Tenant scoping. Every tenant-owned model inherits `TenantModel`.

`Model.objects` only ever returns rows of the workspace in the current scope and raises when no scope
is active, so a forgotten filter fails closed instead of leaking another tenant's data. Code that must
cross tenants (supervisor, staff tools, gateway token lookup) uses `Model.unscoped` explicitly.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from django.db import models

from minerva.models import UUIDModel

_current_workspace: ContextVar[UUID | None] = ContextVar("minerva_workspace", default=None)


class TenantScopeMissing(RuntimeError):
    pass


class CrossTenantReference(ValueError):
    pass


def current_workspace_id() -> UUID:
    workspace_id = _current_workspace.get()
    if workspace_id is None:
        raise TenantScopeMissing("No workspace scope is active for this tenant query.")
    return workspace_id


@contextmanager
def workspace_scope(workspace_id: UUID) -> Iterator[None]:
    token = _current_workspace.set(workspace_id)
    try:
        yield
    finally:
        _current_workspace.reset(token)


def activate_workspace(workspace_id: UUID) -> None:
    """Set the scope for the rest of the current context (one request or task)."""
    _current_workspace.set(workspace_id)


class TenantScopeMiddleware:
    """Start every request without a tenant scope and clear it afterwards, whatever the server model."""

    sync_capable = True
    async_capable = True

    def __init__(self, get_response) -> None:
        from asgiref.sync import iscoroutinefunction, markcoroutinefunction

        self.get_response = get_response
        self.is_async = iscoroutinefunction(get_response)
        if self.is_async:
            markcoroutinefunction(self)

    def __call__(self, request):
        if self.is_async:
            return self._acall(request)
        token = _current_workspace.set(None)
        try:
            return self.get_response(request)
        finally:
            _current_workspace.reset(token)

    async def _acall(self, request):
        token = _current_workspace.set(None)
        try:
            return await self.get_response(request)
        finally:
            _current_workspace.reset(token)


class TenantManager(models.Manager):
    def get_queryset(self) -> models.QuerySet:
        return super().get_queryset().filter(workspace_id=current_workspace_id())


class TenantModel(UUIDModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")

    objects = TenantManager()
    unscoped = models.Manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs) -> None:
        scoped = _current_workspace.get()
        if self.workspace_id is None:
            self.workspace_id = current_workspace_id()
        elif scoped is not None and scoped != self.workspace_id:
            raise CrossTenantReference("Object belongs to a different workspace than the active scope.")
        for field in self._meta.concrete_fields:
            if not isinstance(field, models.ForeignKey) or not field.is_cached(self):
                continue
            related = field.get_cached_value(self)
            if isinstance(related, TenantModel) and related.workspace_id != self.workspace_id:
                raise CrossTenantReference(f"{field.name} belongs to a different workspace.")
        super().save(*args, **kwargs)
