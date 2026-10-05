import json
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.test import Client
from django.utils import timezone
from pydantic import SecretStr

from accounts.models import User
from agents.models import Agent
from connections.models import Connection
from conversations.models import Conversation
from demo import bento, turnstile
from demo import services as demo
from demo.models import DemoLead, DemoSite, DemoUsage
from minerva.config import config
from permissions.models import Grant, PermissionLayer
from permissions.policy import Resource
from permissions.services import GrantChange, apply_grant_changes, effective_policy
from runs.models import Run
from workspaces.models import Membership, Workspace
from workspaces.tenancy import workspace_scope

AUTH = "/api/auth/browser/v1"


def post(client: Client, url: str, body: dict | None = None, method: str = "post"):
    return getattr(client, method)(url, data=json.dumps(body or {}), content_type="application/json")


@pytest.fixture
def demo_on(db, monkeypatch):
    monkeypatch.setattr(config(), "demo", True)
    monkeypatch.setattr(config(), "demo_turns_per_day", 2)
    monkeypatch.setattr(turnstile, "verify", lambda token, ip: token == "pass")


@pytest.fixture
def site(demo_on) -> DemoSite:
    call_command("demo_setup", owner="owner@example.com")
    return DemoSite.objects.select_related("workspace").get()


@pytest.fixture
def owner(site) -> User:
    return User.objects.get(email="owner@example.com")


@pytest.fixture
def shared(site, owner) -> Connection:
    """A Todoist account the owner connected, allowed on one project and denied on another, then synced."""
    with workspace_scope(site.workspace_id):
        connection = Connection(provider="todoist", owner=owner, label="Fernhill", external_account_id="u1")
        connection.set_credentials({"access_token": "test-token"})
        connection.save()
        apply_grant_changes(
            user_id=owner.id,
            connection=connection,
            changes=[GrantChange("project", "work", ("read",))],
            names={},
        )
        layer = PermissionLayer.objects.get(level=PermissionLayer.Level.USER, user=owner)
        Grant.objects.create(
            layer=layer,
            connection=connection,
            resource_kind="project",
            resource_id="private",
            actions=["read"],
            effect=Grant.Effect.DENY,
        )
    demo.sync(site)
    with workspace_scope(site.workspace_id):
        return Connection.objects.get(pk=connection.pk)


@pytest.fixture
def visitor(site) -> User:
    return User.objects.create_user("visitor@example.com")


@pytest.fixture
def visitor_api(visitor) -> Client:
    client = Client(enforce_csrf_checks=False)
    client.force_login(visitor)
    return client


def test_setup_creates_one_locked_workspace_with_an_owner_and_an_agent(site, owner):
    assert site.workspace.kind == Workspace.Kind.TEAM
    assert Membership.objects.get(user=owner).role == Membership.Role.OWNER
    with workspace_scope(site.workspace_id):
        assert Agent.objects.count() == 1
        assert PermissionLayer.objects.get(level=PermissionLayer.Level.CEILING).restricted
    call_command("demo_setup", owner="owner@example.com")
    assert DemoSite.objects.count() == 1
    assert not demo.is_visitor(owner)


def test_visitors_join_the_demo_workspace_with_the_owners_permissions(shared, site, visitor):
    assert not Workspace.objects.filter(personal_owner=visitor).exists()
    assert Membership.objects.get(user=visitor).role == Membership.Role.MEMBER
    assert demo.is_visitor(visitor)
    with workspace_scope(site.workspace_id):
        assert shared.owner_id is None
        assert list(Agent.objects.get().connections.all()) == [shared]
        policy = effective_policy(user_id=visitor.id, agent_id=Agent.objects.get().id)
    assert policy.permits(Resource(str(shared.id), "project", "work"), "read")
    assert not policy.permits(Resource(str(shared.id), "project", "private"), "read")
    assert not policy.permits(Resource(str(shared.id), "project", "work"), "create")


def test_sync_replaces_visitor_grants_and_stops_their_runs(shared, site, owner, visitor):
    with workspace_scope(site.workspace_id):
        conversation = Conversation.objects.create(agent=Agent.objects.get(), user=visitor)
        from runs import services as runs

        _, run = runs.start_run(conversation=conversation, user_id=visitor.id, content="hi")
        apply_grant_changes(
            user_id=owner.id, connection=shared, changes=[GrantChange("project", "work", ())], names={}
        )
    demo.sync(site)
    with workspace_scope(site.workspace_id):
        assert not Grant.objects.filter(layer__user=visitor, effect=Grant.Effect.ALLOW).exists()
        assert Grant.objects.filter(layer__user=visitor, effect=Grant.Effect.DENY).count() == 1
        run.refresh_from_db()
    assert run.status == Run.Status.CANCELLED


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "connections/todoist/authorize", {}),
        ("post", "connections/web/enable", {}),
        ("post", "connections/todoist/key", {"key": "x"}),
        ("delete", "connections/{connection}", None),
        ("patch", "connections/{connection}/access", {"changes": []}),
        ("post", "connections/{connection}/reconnect", {"actions": []}),
        ("get", "connections/{connection}/access/resources?kind=project", None),
        ("post", "agents", {"name": "Mine"}),
        ("put", "agents/{agent}", {"name": "Renamed"}),
        ("delete", "agents/{agent}", None),
    ],
)
def test_visitors_cannot_change_or_browse_the_setup(shared, site, visitor_api, method, path, body):
    with workspace_scope(site.workspace_id):
        agent = Agent.objects.get()
    url = f"/api/workspaces/{site.workspace_id}/" + path.format(connection=shared.id, agent=agent.id)
    response = post(visitor_api, url, body, method) if body is not None else getattr(visitor_api, method)(url)
    assert response.status_code == 403
    assert Connection.unscoped.filter(pk=shared.pk).exists()


@pytest.mark.parametrize(
    "path",
    ["account/password/change", "account/email", "account/authenticators/totp", "auth/reauthenticate"],
)
def test_visitors_cannot_change_their_account(visitor_api, path):
    assert post(visitor_api, f"{AUTH}/{path}", {"x": 1}).status_code == 403


def test_visitors_can_read_and_sign_out(shared, site, visitor_api):
    base = f"/api/workspaces/{site.workspace_id}"
    assert visitor_api.get(f"{base}/connections").status_code == 200
    assert visitor_api.get(f"{base}/connections/{shared.id}/access").status_code == 200
    assert visitor_api.get(f"{base}/agents").status_code == 200
    assert visitor_api.delete(f"{AUTH}/auth/session").status_code in {200, 401}


def test_chat_turns_are_limited_per_visitor_and_survive_deleting_chats(shared, site, visitor, visitor_api):
    base = f"/api/workspaces/{site.workspace_id}"
    with workspace_scope(site.workspace_id):
        agent_id = str(Agent.objects.get().id)

    def chat():
        conversation = post(visitor_api, f"{base}/conversations", {"agent_id": agent_id}).json()
        posted = post(visitor_api, f"{base}/conversations/{conversation['id']}/messages", {"content": "hi"})
        return conversation, posted

    conversation, posted = chat()
    assert posted.status_code == 201
    # One active run per visitor, across conversations.
    _, busy = chat()
    assert busy.status_code == 409
    post(visitor_api, f"{base}/runs/{posted.json()['run']['id']}/cancel")
    assert visitor_api.delete(f"{base}/conversations/{conversation['id']}").status_code == 204
    assert chat()[1].status_code == 201
    Run.unscoped.filter(user=visitor).update(status=Run.Status.COMPLETED)
    refused = chat()[1]
    assert refused.status_code == 429
    assert DemoUsage.objects.get(user=visitor).turns == 2
    me = visitor_api.get("/api/me").json()
    assert me["demo"]["visitor"] is True
    assert me["demo"]["turns_left"] == 0
    assert me["workspaces"] == [
        {"id": str(site.workspace_id), "name": "Fernhill Labs", "kind": "team", "role": "member"}
    ]


def test_visitors_have_a_limited_number_of_chats(site, visitor_api, monkeypatch):
    monkeypatch.setattr(config(), "demo_max_conversations", 2)
    base = f"/api/workspaces/{site.workspace_id}"
    with workspace_scope(site.workspace_id):
        agent_id = str(Agent.objects.get().id)
    created = [
        post(visitor_api, f"{base}/conversations", {"agent_id": agent_id}).status_code for _ in range(3)
    ]
    assert created == [201, 201, 429]


def test_the_owner_has_no_turn_limit(shared, site, owner):
    client = Client(enforce_csrf_checks=False)
    client.force_login(owner)
    base = f"/api/workspaces/{site.workspace_id}"
    with workspace_scope(site.workspace_id):
        agent_id = str(Agent.objects.get().id)
    for _ in range(3):
        conversation = post(client, f"{base}/conversations", {"agent_id": agent_id}).json()
        url = f"{base}/conversations/{conversation['id']}/messages"
        assert post(client, url, {"content": "hi"}).status_code == 201
    assert client.get("/api/me").json()["demo"]["visitor"] is False


def test_sign_in_needs_a_recent_security_check(site, client, monkeypatch):
    request_code = f"{AUTH}/auth/code/request"
    assert post(client, request_code, {"email": "new@example.com"}).status_code == 403
    assert post(client, "/api/demo/email", {"email": "new@example.com"}).status_code == 403
    assert post(client, "/api/demo/gate", {"token": "fail", "newsletter": True}).status_code == 403
    assert post(client, "/api/demo/gate", {"token": "pass", "newsletter": True}).status_code == 204
    assert post(client, "/api/demo/email", {"email": "New@Example.com"}).status_code == 204
    assert User.objects.filter(email="new@example.com").exists()
    assert post(client, request_code, {"email": "new@example.com"}).status_code != 403
    monkeypatch.setattr(config(), "demo_gate_uses", 2)
    assert post(client, request_code, {"email": "new@example.com"}).status_code == 403


def test_admission_uses_are_counted_across_copies_of_the_session(site, monkeypatch):
    monkeypatch.setattr(config(), "demo_gate_uses", 2)
    session = {}
    demo.admit(session, newsletter=False)
    # Concurrent requests each load their own copy of the session.
    copies = [dict(session) for _ in range(5)]
    assert [demo.use_admission(copy) for copy in copies] == [True, True, False, False, False]
    assert not demo.use_admission({demo.GATE_KEY: "not-a-uuid"})
    assert not demo.use_admission({demo.GATE_KEY: {"at": 0, "uses": 0}})


@pytest.mark.parametrize(
    "path",
    [
        "auth/login",
        "auth/webauthn/login",
        "auth/signup",
        "auth/password/request",
        "auth/provider/token",
    ],
)
def test_password_and_plain_signup_flows_are_closed(site, client, path):
    assert post(client, f"{AUTH}/{path}", {"email": "x@example.com"}).status_code == 403


def test_only_provider_callbacks_are_exposed(site, client, settings):
    settings.SOCIALACCOUNT_PROVIDERS = {"google": {"APPS": [{"client_id": "id", "secret": "secret"}]}}
    assert client.get("/api/accounts/google/login/").status_code == 404
    assert client.get("/api/accounts/google/login/callback/").status_code != 404


def test_social_signup_needs_admission(site, rf):
    from accounts.adapter import SocialAccountAdapter

    request = rf.get("/")
    request.session = {}
    assert not SocialAccountAdapter().is_open_for_signup(request, None)
    demo.admit(request.session, newsletter=False)
    assert SocialAccountAdapter().is_open_for_signup(request, None)


def test_signing_in_records_a_lead_with_the_newsletter_choice(site, client):
    post(client, "/api/demo/gate", {"token": "pass", "newsletter": True})
    post(client, "/api/demo/email", {"email": "lead@example.com"})
    from allauth.account.signals import user_logged_in

    request = type("R", (), {"session": client.session})()
    user = User.objects.get(email="lead@example.com")
    user_logged_in.send(sender=User, request=request, response=None, user=user)
    lead = DemoLead.objects.get()
    assert (lead.email, lead.newsletter, lead.source) == ("lead@example.com", True, "email")
    request.session = {}
    user_logged_in.send(sender=User, request=request, response=None, user=user)
    assert DemoLead.objects.get().newsletter is True
    # Unticking the box at a later sign-in withdraws the opt-in.
    demo.admit(request.session, newsletter=False)
    user_logged_in.send(sender=User, request=request, response=None, user=user)
    assert DemoLead.objects.get().newsletter is False


def test_bento_gets_opt_ins_and_later_withdrawals_only(db, monkeypatch):
    monkeypatch.setattr(config(), "bento_site_uuid", "site")
    monkeypatch.setattr(config(), "bento_publishable_key", "pk")
    monkeypatch.setattr(config(), "bento_secret_key", SecretStr("sk"))
    sent = []
    monkeypatch.setattr(
        bento.httpx,
        "post",
        lambda url, json, **_: sent.append((url, json)) or type("R", (), {"status_code": 200})(),
    )
    DemoLead.objects.create(email="in@example.com", source="email", newsletter=True)
    DemoLead.objects.create(email="out@example.com", source="email", newsletter=False)
    assert bento.sync_leads() == 1
    assert sent == [(bento.API_URL, {"subscribers": [{"email": "in@example.com", "tags": bento.TAGS}]})]
    sent.clear()
    DemoLead.objects.filter(email="in@example.com").update(newsletter=False)
    assert bento.sync_leads() == 1
    assert sent == [
        (bento.COMMANDS_URL, {"command": [{"command": "unsubscribe", "email": "in@example.com"}]})
    ]
    assert bento.sync_leads() == 0


def test_cleanup_deletes_old_visitor_conversations_only(shared, site, owner, visitor):
    with workspace_scope(site.workspace_id):
        agent = Agent.objects.get()
        old = Conversation.objects.create(agent=agent, user=visitor)
        fresh = Conversation.objects.create(agent=agent, user=visitor)
        owners = Conversation.objects.create(agent=agent, user=owner)
        stale = timezone.now() - timedelta(hours=25)
        # Age counts from the start: a recent message does not keep an old chat.
        Conversation.objects.filter(pk__in=[old.pk, owners.pk]).update(created_at=stale)
    assert demo.cleanup(site) == 1
    with workspace_scope(site.workspace_id):
        assert set(Conversation.objects.values_list("pk", flat=True)) == {fresh.pk, owners.pk}


def test_demo_endpoints_are_off_without_demo_mode(client):
    assert client.get("/api/demo/config").json() == {
        "enabled": False,
        "turnstile_site_key": None,
        "providers": [],
    }
    assert post(client, "/api/demo/gate", {"token": "pass", "newsletter": True}).status_code == 404
