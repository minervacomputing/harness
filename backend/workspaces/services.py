from django.db import transaction

from accounts.models import User
from agents.models import Agent
from permissions.models import PermissionLayer
from workspaces.models import Membership, Workspace
from workspaces.tenancy import workspace_scope

DEFAULT_AGENT_INSTRUCTIONS = "You are a helpful, concise assistant."


def provision_personal_workspace(user: User) -> Workspace:
    """Every person gets a personal workspace of one, so individuals and teams share one code path."""
    with transaction.atomic():
        existing = Workspace.objects.filter(personal_owner=user).first()
        if existing is not None:
            return existing
        workspace = Workspace.objects.create(
            kind=Workspace.Kind.PERSONAL, name="Personal", personal_owner=user
        )
        Membership.objects.create(workspace=workspace, user=user, role=Membership.Role.OWNER)
        with workspace_scope(workspace.id):
            PermissionLayer.objects.create(level=PermissionLayer.Level.CEILING, restricted=False)
            PermissionLayer.objects.create(level=PermissionLayer.Level.USER, user=user, restricted=True)
            Agent.objects.create(owner=user, name="Assistant", instructions=DEFAULT_AGENT_INSTRUCTIONS)
    return workspace
