from typing import Literal
from uuid import UUID

from ninja import Router, Schema
from ninja.security import django_auth

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


class MeOut(Schema):
    user: UserOut
    workspaces: list[WorkspaceOut]


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
    }
