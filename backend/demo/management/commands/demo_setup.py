from allauth.account.models import EmailAddress
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import User
from agents.models import Agent
from demo import story
from demo.models import DemoSite
from minerva.config import config
from permissions.models import PermissionLayer
from workspaces.models import Membership, Workspace
from workspaces.tenancy import workspace_scope


class Command(BaseCommand):
    help = "Creates the demo workspace, its owner and its agent. Safe to run again."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--owner", required=True, help="Email of the account that sets up the demo.")
        parser.add_argument("--name", default="Fernhill Labs", help="Workspace name.")
        parser.add_argument(
            "--reset-story", action="store_true", help="Restore the agent's instructions and the suggestions."
        )

    def handle(self, *args, owner: str, name: str, reset_story: bool, **options) -> None:
        if not config().demo:
            raise CommandError("Set MINERVA_DEMO=true first.")
        with transaction.atomic():
            site = DemoSite.objects.select_related("workspace").first()
            if site is None:
                workspace = Workspace.objects.create(kind=Workspace.Kind.TEAM, name=name)
                site = DemoSite.objects.create(workspace=workspace, suggestions=story.SUGGESTIONS)
                with workspace_scope(workspace.id):
                    # Restricted from the start: until `demo_sync`, visitors may do nothing.
                    PermissionLayer.objects.create(level=PermissionLayer.Level.CEILING, restricted=True)
            workspace = site.workspace
            # Signing up in demo mode joins the workspace as a member; the owner is promoted below.
            user = User.objects.filter(email=owner.strip().lower()).first() or User.objects.create_user(owner)
            EmailAddress.objects.update_or_create(
                user=user, email=user.email, defaults={"primary": True, "verified": True}
            )
            Membership.objects.update_or_create(
                workspace=workspace, user=user, defaults={"role": Membership.Role.OWNER}
            )
            with workspace_scope(workspace.id):
                PermissionLayer.objects.get_or_create(
                    level=PermissionLayer.Level.USER, user=user, defaults={"restricted": True}
                )
                agent = Agent.objects.first()
                if agent is None:
                    agent = Agent.objects.create(
                        owner=user, name=story.AGENT_NAME, instructions=story.AGENT_INSTRUCTIONS
                    )
                elif reset_story:
                    agent.name, agent.instructions = story.AGENT_NAME, story.AGENT_INSTRUCTIONS
                    agent.save(update_fields=["name", "instructions", "updated_at"])
            if reset_story:
                site.suggestions = story.SUGGESTIONS
                site.save(update_fields=["suggestions"])
        self.stdout.write(
            f"Demo workspace {workspace.name} ({workspace.id}), owner {user.email}, agent {agent.name}.\n"
            "Next: sign in as the owner, connect the apps, choose what to allow, then run demo_sync."
        )
