"""Helpers for connector tests: grants and claimed runs. The `connector_run` fixture in conftest.py
is built on them."""

from agents.models import Agent
from connections.models import Connection
from connectors.base import ACCOUNT_KIND
from connectors.executor import Executor, RunContext
from conversations.models import Conversation
from permissions.models import Grant
from permissions.services import GrantChange, apply_grant_changes, user_layer
from runs import services
from workspaces.tenancy import workspace_scope


def replace_grants(user, connection: Connection, grants: dict[tuple[str, str], tuple[str, ...]]) -> None:
    """Replaces the user's grants on the connection with `grants` ({(kind, id): actions}).

    An account grant is on the connection itself, whatever id it is given.
    """
    Grant.objects.filter(layer=user_layer(user.id), connection=connection).delete()
    changes = [
        GrantChange(kind, str(connection.id) if kind == ACCOUNT_KIND else rid, tuple(actions))
        for (kind, rid), actions in grants.items()
    ]
    if changes:
        apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})


def claimed_run(workspace, user) -> Executor:
    """Starts a run of the workspace's agent and claims it, as the supervisor would; returns its executor."""
    with workspace_scope(workspace.id):
        conversation = Conversation.objects.create(agent=Agent.objects.get(), user=user)
        _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
    services.claim_queued(10)
    run.refresh_from_db()
    return Executor(RunContext.from_run(run))
