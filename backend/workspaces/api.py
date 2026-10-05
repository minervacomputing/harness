from typing import Literal
from uuid import UUID

from ninja import Router, Schema
from ninja.security import django_auth

from demo import services as demo
from minerva.config import config
from workspaces.models import Membership, Workspace

router = Router(tags=["account"])


class WorkspaceOut(Schema):
    id: UUID
    name: str
    kind: Literal[*Workspace.Kind.values]
    role: Literal[*Membership.Role.values]


class UserOut(Schema):
    id: UUID
    email: str
    name: str
    is_staff: bool


class DemoOut(Schema):
    """Present on a public demo instance. `visitor` is false for the people who run the demo."""

    visitor: bool
    turns_per_day: int
    turns_left: int
    chat_retention_hours: int
    suggestions: list[str]
    # Shown above the others, set apart: a request Minerva refuses.
    featured_suggestion: str | None


class MeOut(Schema):
    user: UserOut
    workspaces: list[WorkspaceOut]
    demo: DemoOut | None


@router.get("/me", response=MeOut, auth=django_auth)
def me(request):
    memberships = (
        Membership.objects.filter(user=request.user)
        .select_related("workspace")
        .order_by("workspace__kind", "workspace__created_at")
    )
    return {
        "user": request.user,
        "workspaces": [
            {"id": m.workspace.id, "name": m.workspace.name, "kind": m.workspace.kind, "role": m.role}
            for m in memberships
        ],
        "demo": _demo(request.user),
    }


def _demo(user) -> dict | None:
    site = demo.site()
    if site is None:
        return None
    usage = demo.usage(user)
    return {
        "visitor": demo.is_visitor(user),
        "turns_per_day": usage.turns_per_day,
        "turns_left": usage.turns_left,
        "chat_retention_hours": config().demo_chat_retention_hours,
        "suggestions": site.suggestions,
        "featured_suggestion": site.featured_suggestion or None,
    }
