from django.http import HttpRequest
from ninja.security import SessionAuth

from workspaces.models import Membership
from workspaces.tenancy import activate_workspace


class WorkspaceMember(SessionAuth):
    """Session login (with CSRF) plus membership of the workspace named in the URL.

    On success the workspace becomes the tenant scope for the rest of the request.
    """

    def authenticate(self, request: HttpRequest, key: str | None):
        user = super().authenticate(request, key)
        if user is None:
            return None
        workspace_id = request.resolver_match.kwargs.get("workspace_id") if request.resolver_match else None
        if workspace_id is None:
            return None
        membership = (
            Membership.objects.select_related("workspace")
            .filter(workspace_id=workspace_id, user=user)
            .first()
        )
        if membership is None:
            return None
        request.membership = membership  # type: ignore[attr-defined]
        request.workspace = membership.workspace  # type: ignore[attr-defined]
        activate_workspace(membership.workspace_id)
        return user


workspace_member = WorkspaceMember()
