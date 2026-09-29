import pytest

from agents.models import Agent
from permissions.models import PermissionLayer
from workspaces.models import Membership, Workspace
from workspaces.tenancy import CrossTenantReference, TenantScopeMissing, workspace_scope


def test_signup_provisions_a_personal_workspace(user):
    workspace = user.personal_workspace
    assert workspace.kind == Workspace.Kind.PERSONAL
    assert Membership.objects.get(workspace=workspace, user=user).role == Membership.Role.OWNER
    with workspace_scope(workspace.id):
        ceiling = PermissionLayer.objects.get(level=PermissionLayer.Level.CEILING)
        assert ceiling.restricted is False
        assert PermissionLayer.objects.get(level=PermissionLayer.Level.USER, user=user).restricted is True
        assert Agent.objects.get().owner == user


def test_tenant_queries_fail_closed_without_scope(user):
    with pytest.raises(TenantScopeMissing):
        list(Agent.objects.all())


def test_tenant_queries_only_see_the_active_workspace(user, other_user):
    with workspace_scope(user.personal_workspace.id):
        agents = list(Agent.objects.all())
    assert [a.owner for a in agents] == [user]
    assert Agent.unscoped.count() == 2


def test_cross_tenant_writes_are_rejected(user, other_user):
    with workspace_scope(other_user.personal_workspace.id):
        foreign = Agent.objects.get()
    with workspace_scope(user.personal_workspace.id), pytest.raises(CrossTenantReference):
        foreign.name = "hijacked"
        foreign.save()
