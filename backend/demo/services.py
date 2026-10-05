"""The public demo: admission, visitor provisioning, usage limits, permission sync and cleanup.

A visitor is anyone who is not an owner or admin of the demo workspace. Visitors share the workspace's
connections and its one agent, chat in private conversations, and cannot change anything else.
"""

from dataclasses import dataclass
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from accounts.models import User
from conversations.models import Conversation
from demo.models import DemoAdmission, DemoLead, DemoSite, DemoUsage
from minerva.config import config
from permissions.models import Grant, PermissionLayer
from runs.models import Run
from workspaces.models import Membership
from workspaces.tenancy import workspace_scope

GATE_KEY = "demo_gate"
ADMIN_ROLES = (Membership.Role.OWNER, Membership.Role.ADMIN)


class DemoLimit(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def enabled() -> bool:
    return config().demo


def site() -> DemoSite | None:
    return DemoSite.objects.select_related("workspace").first() if enabled() else None


def is_visitor(user) -> bool:
    """True for every signed-in demo user who does not run the demo. Cached on the user object."""
    if not enabled() or not user.is_authenticated:
        return False
    cached = getattr(user, "_demo_visitor", None)
    if cached is None:
        current = site()
        cached = (
            current is None
            or not Membership.objects.filter(
                workspace_id=current.workspace_id, user=user, role__in=ADMIN_ROLES
            ).exists()
        )
        user._demo_visitor = cached
    return cached


# Admission: a Turnstile pass admits one browser session for a while and a few sign-in attempts.
# Uses are counted in the database, because concurrent requests each hold their own copy of the session.


def admit(session, *, newsletter: bool) -> None:
    session[GATE_KEY] = str(DemoAdmission.objects.create(newsletter=newsletter).pk)


def _admissions(session):
    gate = session.get(GATE_KEY)
    if not isinstance(gate, str):
        return DemoAdmission.objects.none()
    try:
        return DemoAdmission.objects.filter(pk=gate)
    except ValidationError:
        return DemoAdmission.objects.none()


def admission(session) -> DemoAdmission | None:
    cutoff = timezone.now() - timedelta(minutes=config().demo_gate_minutes)
    return _admissions(session).filter(created_at__gte=cutoff).first()


def newsletter_choice(session) -> bool | None:
    """What the visitor chose at their last security check, however long ago."""
    return _admissions(session).values_list("newsletter", flat=True).first()


def use_admission(session) -> bool:
    """Spends one sign-in attempt (an email sent, an OAuth flow started) of the admission."""
    cutoff = timezone.now() - timedelta(minutes=config().demo_gate_minutes)
    spent = (
        _admissions(session)
        .filter(created_at__gte=cutoff, uses__lt=config().demo_gate_uses)
        .update(uses=F("uses") + 1)
    )
    return spent == 1


# Visitors


def copy_grants(source: PermissionLayer | None, target: PermissionLayer) -> None:
    """Replaces the target layer's grants, allows and denies, with the source's."""
    Grant.objects.filter(layer=target).delete()
    if source is None:
        return
    Grant.objects.bulk_create(
        Grant(
            workspace_id=target.workspace_id,
            layer=target,
            connection_id=g.connection_id,
            resource_kind=g.resource_kind,
            resource_id=g.resource_id,
            resource_name=g.resource_name,
            actions=g.actions,
            effect=g.effect,
        )
        for g in Grant.objects.filter(layer=source)
    )
    PermissionLayer.objects.filter(pk=target.pk).update(version=F("version") + 1)


def join(user: User) -> None:
    """Makes a new account a member of the demo workspace, allowed what the demo ceiling allows."""
    current = site()
    if current is None:
        return
    with transaction.atomic(), workspace_scope(current.workspace_id):
        _, created = Membership.objects.get_or_create(
            workspace=current.workspace, user=user, defaults={"role": Membership.Role.MEMBER}
        )
        if not created:
            return
        ceiling = PermissionLayer.objects.filter(level=PermissionLayer.Level.CEILING).first()
        layer = PermissionLayer.objects.create(level=PermissionLayer.Level.USER, user=user, restricted=True)
        copy_grants(ceiling, layer)


def record_lead(user: User, *, source: str, newsletter: bool | None) -> None:
    lead, created = DemoLead.objects.get_or_create(
        email=user.email, defaults={"source": source, "newsletter": bool(newsletter)}
    )
    if not created:
        # The latest choice wins; bento.sync_leads unsubscribes someone who unticks the box later.
        if newsletter is not None:
            lead.newsletter = newsletter
        lead.save(update_fields=["newsletter", "last_seen_at"])


# Usage


@dataclass(frozen=True)
class Usage:
    turns_per_day: int
    turns_left: int


def _today():
    return timezone.now().date()


def usage(user: User) -> Usage:
    limit = config().demo_turns_per_day
    used = DemoUsage.objects.filter(user=user, day=_today()).values_list("turns", flat=True).first() or 0
    return Usage(limit, max(limit - used, 0))


def reserve_turn(user: User) -> None:
    """Counts a chat turn before it starts, inside the caller's transaction. Raises DemoLimit."""
    cfg = config()
    # One reservation at a time, held until the caller's run exists, so concurrent turns cannot all pass
    # the checks below.
    DemoSite.objects.select_for_update().first()
    if Run.unscoped.filter(user=user, status__in=Run.ACTIVE).exists():
        raise DemoLimit(409, "Wait for your current answer to finish, or stop it.")
    if Run.unscoped.filter(status__in=Run.ACTIVE).count() >= cfg.demo_max_active_runs:
        raise DemoLimit(503, "The demo is busy right now. Try again in a minute.")
    today = _today()
    total = DemoUsage.objects.filter(day=today).aggregate(total=Sum("turns"))["total"] or 0
    if total >= cfg.demo_turns_global_per_day:
        raise DemoLimit(503, "The demo has reached its limit for today. Try again tomorrow.")
    DemoUsage.objects.get_or_create(user=user, day=today)
    row = DemoUsage.objects.select_for_update().get(user=user, day=today)
    if row.turns >= cfg.demo_turns_per_day:
        raise DemoLimit(429, f"You have used today's {cfg.demo_turns_per_day} demo messages.")
    row.turns += 1
    row.save(update_fields=["turns"])


def check_new_conversation(user: User) -> None:
    """Raises DemoLimit when a visitor already has many chats; the frontend removes refused empty ones. Locks
    the user until the caller's transaction ends, so concurrent requests cannot all pass the check."""
    User.objects.select_for_update().filter(pk=user.pk).first()
    if Conversation.objects.filter(user=user).count() >= config().demo_max_conversations:
        raise DemoLimit(429, "You have too many chats. Delete some to start a new one.")


# Operator commands


def sync(current: DemoSite) -> dict[str, int]:
    """Publishes the owner's setup to visitors: every connection becomes shared and part of the agent, and
    the ceiling and every visitor's layer become copies of the owner's grants. Stops active runs."""
    from agents.models import Agent
    from connections.models import Connection
    from runs.services import revoke_active_runs

    owner = Membership.objects.get(workspace=current.workspace, role=Membership.Role.OWNER).user
    with transaction.atomic(), workspace_scope(current.workspace_id):
        connections = list(Connection.objects.all())
        Connection.objects.filter(owner__isnull=False).update(owner=None)
        agents = list(Agent.objects.all())
        for agent in agents:
            agent.connections.set(connections)
        ceiling = PermissionLayer.objects.select_for_update().get(level=PermissionLayer.Level.CEILING)
        source = PermissionLayer.objects.select_for_update().get(level=PermissionLayer.Level.USER, user=owner)
        if not ceiling.restricted:
            PermissionLayer.objects.filter(pk=ceiling.pk).update(restricted=True)
        copy_grants(source, ceiling)
        admins = Membership.objects.filter(workspace=current.workspace, role__in=ADMIN_ROLES).values(
            "user_id"
        )
        visitors = list(
            PermissionLayer.objects.select_for_update()
            .filter(level=PermissionLayer.Level.USER)
            .exclude(user_id__in=admins)
            .order_by("pk")
        )
        for layer in visitors:
            copy_grants(source, layer)
        stopped = revoke_active_runs(reason="permissions_changed")
    return {
        "connections": len(connections),
        "agents": len(agents),
        "grants": Grant.unscoped.filter(layer=source).count(),
        "visitors": len(visitors),
        "stopped_runs": stopped,
    }


def cleanup(current: DemoSite) -> int:
    """Deletes visitors' conversations started longer ago than the retention period, and old admissions."""
    from runs.services import cancel

    cutoff = timezone.now() - timedelta(hours=config().demo_chat_retention_hours)
    admins = Membership.objects.filter(workspace=current.workspace, role__in=ADMIN_ROLES).values("user_id")
    deleted = 0
    with workspace_scope(current.workspace_id):
        stale = Conversation.objects.filter(created_at__lt=cutoff).exclude(user_id__in=admins)
        for conversation in stale:
            for run in Run.objects.filter(conversation=conversation, status__in=Run.ACTIVE):
                cancel(run)
            conversation.delete()
            deleted += 1
    DemoAdmission.objects.filter(created_at__lt=timezone.now() - timedelta(days=1)).delete()
    return deleted
