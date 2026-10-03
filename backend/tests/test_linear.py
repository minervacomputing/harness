"""Linear connector against an in-memory Linear GraphQL API, and runs through the executor."""

import json
import re
from uuid import UUID, uuid4

import httpx
import pytest
from asgiref.sync import sync_to_async

from agents.models import Agent
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.executor import Executor, RunContext
from connectors.http import Effect
from connectors.linear import markdown as text
from connectors.linear import teams
from connectors.linear.client import MAX_ISSUE_DEPTH, MAX_TEAM_DEPTH, LinearClient, TeamRef, judge
from connectors.linear.connector import LinearConnector
from conversations.models import Conversation
from permissions.models import Grant, PermissionLayer
from permissions.services import GrantChange, apply_grant_changes
from runs import services
from workspaces.tenancy import workspace_scope

TEAMS = {
    "eng": {"key": "ENG", "name": "Engineering", "parent": None},
    "web": {"key": "WEB", "name": "Web", "parent": "eng"},
    "ops": {"key": "OPS", "name": "Operations", "parent": None},
    "des": {"key": "DES", "name": "Design", "parent": None},
    "sec": {"key": "SEC", "name": "Security", "parent": None, "private": True},
}
PEOPLE = ["ada", "grace", "old"]
COMMENTS = ["c1", "c2", "c3", "c4", "gone"]
ISSUES = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "WEB-1", "OPS-1", "OPS-2", "SEC-1", "NEW"]
ID = {name: str(UUID(int=i + 1)) for i, name in enumerate([*TEAMS, *PEOPLE, *COMMENTS, *ISSUES])}
NAME = {v: k for k, v in ID.items()}
STATES = [("Backlog", "backlog"), ("Todo", "unstarted"), ("In Progress", "started"), ("Done", "completed"),
          ("Canceled", "canceled")]  # fmt: skip
NO_MORE = {"hasNextPage": False, "endCursor": None}
SECRET = "Secret ops thing"


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


class FakeLinear:
    """Linear's GraphQL API, served through httpx.MockTransport.

    Teams: Engineering (sub-team Web), Operations, Design, and Security, which the account cannot see.
    ENG-1 has sub-issues ENG-2 and OPS-2; ENG-3's parent is OPS-1; ENG-4 is done.
    """

    def __init__(self) -> None:
        self.teams = {name: dict(team) for name, team in TEAMS.items()}
        self.hidden = {"sec"}
        self.issues = {
            "ENG-1": self._new("ENG-1", "eng", "Launch plan", description=(
                f"Blocked by [{SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing), see "
                "https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f and linear.app/acme/view/hush"
            )),
            "ENG-2": self._new("ENG-2", "eng", "Write docs", parent="ENG-1", assignee="ada"),
            "ENG-3": self._new("ENG-3", "eng", "Ops follow-up", parent="OPS-1"),
            "ENG-4": self._new("ENG-4", "eng", "Shipped", state="completed"),
            "WEB-1": self._new("WEB-1", "web", "Landing page"),
            "OPS-1": self._new("OPS-1", "ops", SECRET),
            "OPS-2": self._new("OPS-2", "ops", "Ops sub-task", parent="ENG-1"),
            "SEC-1": self._new("SEC-1", "sec", "Pen test"),
        }  # fmt: skip
        self.comments = {
            "c1": {"issue": "ENG-1", "body": "First", "parent": None, "user": "Grace", "at": "2026-09-01"},
            "c2": {"issue": "ENG-1", "body": "Hidden", "parent": None, "user": "Bot", "at": "2026-09-02",
                   "hidden": True},
            "c3": {"issue": "ENG-1", "body": f"Reply about [{SECRET}](https://linear.app/acme/issue/OPS-1/x)",
                   "parent": "c1", "user": "Ada", "at": "2026-09-03"},
            "c4": {"issue": "ENG-2", "body": "Elsewhere", "parent": None, "user": "Ada", "at": "2026-09-04"},
        }  # fmt: skip
        self.labels = {
            "eng": [
                {"id": "l-bug", "name": "Bug", "isGroup": False, "parent": None},
                {"id": "l-area", "name": "Area", "isGroup": True, "parent": None},
                {"id": "l-frontend", "name": "Frontend", "isGroup": False, "parent": {"name": "Area"}},
            ],
            "workspace": [{"id": "l-urgent", "name": "Urgent", "isGroup": False, "parent": None}],
        }
        self.members = [
            {"id": ID["ada"], "name": "Ada Lovelace", "displayName": "ada", "active": True},
            {"id": ID["grace"], "name": "Grace Hopper", "displayName": "grace", "active": True},
            {"id": ID["old"], "name": "Old Timer", "displayName": "old", "active": False},
        ]
        self.ops: list[tuple[str, dict]] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None
        self.stray: str | None = None
        self.last_filter: dict | None = None

    @staticmethod
    def _new(ident: str, team: str, title: str, *, description: str = "", parent: str | None = None,
             assignee: str | None = None, state: str = "unstarted") -> dict:  # fmt: skip
        return {
            "id": ID[ident],
            "identifier": ident,
            "team": team,
            "title": title,
            "description": description,
            "parent": parent,
            "assignee": assignee,
            "state": state,
            "labels": [],
            "dueDate": None,
        }

    # Shapes

    def _chain(self, name: str | None, levels: int) -> dict | None:
        if name is None:
            return None
        node: dict = {"id": ID[name]}
        if levels > 1:
            node["parent"] = self._chain(self.teams[name]["parent"], levels - 1)
        return node

    def _team(self, name: str) -> dict:
        team = self.teams[name]
        return {
            "id": ID[name],
            "key": team["key"],
            "name": team["name"],
            "description": None,
            "private": team.get("private", False),
            "parent": self._chain(team["parent"], MAX_TEAM_DEPTH + 1),
        }

    @staticmethod
    def _state(team: str, state_type: str) -> dict:
        name = next(name for name, kind in STATES if kind == state_type)
        return {"id": f"{team}-{state_type}", "name": name, "type": state_type}

    def _url(self, issue: dict) -> str:
        return f"https://linear.app/acme/issue/{issue['identifier']}/{_slug(issue['title'])}"

    def _summary(self, issue: dict) -> dict:
        return {
            "id": issue["id"],
            "identifier": issue["identifier"],
            "title": issue["title"],
            "priorityLabel": "No priority",
            "dueDate": issue["dueDate"],
            "updatedAt": "2026-09-05T00:00:00.000Z",
            "url": self._url(issue),
            "state": self._state(issue["team"], issue["state"]),
            "assignee": {"name": issue["assignee"]} if issue["assignee"] else None,
            "team": {"id": ID[issue["team"]]},
        }

    def _relative(self, issue: dict) -> dict:
        return {
            "identifier": issue["identifier"],
            "title": issue["title"],
            "state": self._state(issue["team"], issue["state"]),
            "team": {"id": ID[issue["team"]]},
        }

    def _comment(self, name: str) -> dict:
        comment = self.comments[name]
        return {
            "id": ID[name],
            "body": comment["body"],
            "createdAt": comment["at"],
            "hideInLinear": comment.get("hidden", False),
            "parent": {"id": ID[comment["parent"]]} if comment["parent"] else None,
            "user": {"name": comment["user"]},
            "botActor": None,
            "externalUser": None,
        }

    def _full(self, issue: dict) -> dict:
        ident = issue["identifier"]
        parent = self.issues.get(issue["parent"]) if issue["parent"] else None
        children = [i for i in self.issues.values() if i["parent"] == ident]
        comments = [name for name, c in self.comments.items() if c["issue"] == ident]
        return {
            **self._summary(issue),
            "description": issue["description"],
            "estimate": None,
            "createdAt": "2026-09-01T00:00:00.000Z",
            "completedAt": None,
            "canceledAt": None,
            "creator": {"name": "Ada Lovelace"},
            "project": None,
            "labels": {"nodes": [{"name": n} for n in issue["labels"]], "pageInfo": NO_MORE},
            "team": self._team(issue["team"]),
            "parent": self._relative(parent) if parent else None,
            "children": {"nodes": [self._relative(c) for c in children], "pageInfo": NO_MORE},
            "comments": {"nodes": [self._comment(n) for n in reversed(comments)], "pageInfo": NO_MORE},
        }

    def _parents(self, ident: str | None, levels: int) -> dict | None:
        if ident is None:
            return None
        issue = self.issues[ident]
        node: dict = {"id": issue["id"], "team": {"id": ID[issue["team"]]}}
        if levels > 1:
            node["parent"] = self._parents(issue["parent"], levels - 1)
        return node

    # Lookups

    def _find_team(self, value: str) -> str:
        name = NAME.get(value)
        if name not in self.teams or name in self.hidden:
            raise LookupError
        return name

    def _find_issue(self, value: str) -> dict:
        issue = self.issues.get(value.upper()) or self.issues.get(NAME.get(value, ""))
        if issue is None or issue["team"] in self.hidden:
            raise LookupError
        return issue

    def _visible_teams(self) -> list[str]:
        return [name for name in self.teams if name not in self.hidden]

    @staticmethod
    def _compare(value, condition: dict) -> bool:
        for op, arg in condition.items():
            match op:
                case "eq":
                    ok = value == arg
                case "neq":
                    ok = value != arg
                case "in":
                    ok = value in arg
                case "nin":
                    ok = value not in arg
                case "eqIgnoreCase":
                    ok = value.lower() == arg.lower()
                case "containsIgnoreCase":
                    ok = arg.lower() in value.lower()
                case _:
                    raise AssertionError(op)
            if not ok:
                return False
        return True

    def _matches(self, issue: dict, where: dict) -> bool:
        for key, condition in where.items():
            if key == "and":
                ok = all(self._matches(issue, c) for c in condition)
            elif key == "or":
                ok = any(self._matches(issue, c) for c in condition)
            elif key == "id":
                ok = self._compare(issue["id"], condition)
            elif key == "team":
                ok = self._compare(ID[issue["team"]], condition["id"])
            elif key == "state":
                ok = self._compare(issue["state"], condition["type"])
            elif key == "title":
                ok = self._compare(issue["title"], condition)
            elif key == "assignee":
                ok = (issue["assignee"] == "ada") == condition["isMe"]["eq"]
            elif key == "parent":
                ok = issue["parent"] is not None and self._matches(self.issues[issue["parent"]], condition)
            else:
                raise AssertionError(key)
            if not ok:
                return False
        return True

    def _visible_issues(self) -> list[dict]:
        return [i for i in self.issues.values() if i["team"] not in self.hidden]

    @staticmethod
    def _paged(nodes: list, variables: dict, first: int | None = None) -> dict:
        first = first or variables.get("first") or 100
        after = variables.get("after")
        start = int(after[1:]) if after else 0
        end = start + first
        more = end < len(nodes)
        return {
            "nodes": nodes[start:end],
            "pageInfo": {"hasNextPage": more, "endCursor": f"c{end}" if more else None},
        }

    # Dispatch

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/graphql" and request.method == "POST"
        body = json.loads(request.content)
        name = re.match(r"\s*(?:query|mutation)\s+(\w+)", body["query"])[1]
        variables = body.get("variables") or {}
        self.ops.append((name, variables))
        if self.hook is not None and (response := self.hook(name, variables)) is not None:
            return response
        try:
            data = self._answer(name, variables)
        except LookupError:
            return httpx.Response(
                200,
                json={
                    "data": None,
                    "errors": [{"message": "Entity not found", "extensions": {"type": "invalid input"}}],
                },
            )
        return httpx.Response(200, json={"data": data})

    def _answer(self, name: str, v: dict) -> dict:
        match name:
            case "Me":
                return {
                    "viewer": {"id": ID["ada"], "name": "Ada Lovelace"},
                    "organization": {"name": "Acme", "urlKey": "acme"},
                }
            case "Organization":
                return {"organization": {"name": "Acme", "urlKey": "acme"}}
            case "Viewer":
                return {"viewer": {"id": ID["ada"], "name": "Ada Lovelace"}}
            case "Team":
                return {"team": self._team(self._find_team(v["id"]))}
            case "TeamByKey":
                found = [n for n in self._visible_teams() if self.teams[n]["key"].lower() == v["key"].lower()]
                return {"teams": {"nodes": [self._team(n) for n in found], "pageInfo": NO_MORE}}
            case "Teams":
                ids = (v.get("filter") or {}).get("id", {}).get("in")
                found = [n for n in self._visible_teams() if ids is None or ID[n] in ids]
                return {"teams": self._paged([self._team(n) for n in found], v)}
            case "TeamIssues":
                self.last_filter = v.get("filter")
                team = self._find_team(v["id"])
                issues = [
                    i
                    for i in self._visible_issues()
                    if i["team"] == team and self._matches(i, v.get("filter") or {})
                ]
                if self.stray:
                    issues.append(self.issues[self.stray])
                return {
                    "team": {**self._team(team), "issues": self._paged([self._summary(i) for i in issues], v)}
                }
            case "States":
                team = self._find_team(v["id"])
                states = [self._state(team, kind) for _, kind in STATES]
                return {"team": {"states": self._paged(states, v)}}
            case "TeamLabels":
                team = self._find_team(v["id"])
                return {"team": {"labels": self._paged(self.labels.get(team, []), v)}}
            case "WorkspaceLabels":
                return {"issueLabels": self._paged(self.labels["workspace"], v)}
            case "Members":
                self._find_team(v["id"])
                return {"team": {"members": self._paged(self.members, v)}}
            case "IssuePlace":
                issue = self._find_issue(v["id"])
                return {
                    "issue": {
                        "id": issue["id"],
                        "identifier": issue["identifier"],
                        "team": self._team(issue["team"]),
                    }
                }
            case "IssueTeam":
                return {"issue": {"team": {"id": ID[self._find_issue(v["id"])["team"]]}}}
            case "Issue":
                return {"issue": self._full(self._find_issue(v["id"]))}
            case "IssueForUpdate":
                issue = self._find_issue(v["id"])
                return {
                    "issue": {
                        "id": issue["id"],
                        "identifier": issue["identifier"],
                        "team": self._team(issue["team"]),
                        "parent": self._parents(issue["parent"], MAX_ISSUE_DEPTH + 1),
                    }
                }
            case "OpenSubIssues":
                issues = self._visible_issues()
                return {
                    key: {"nodes": [{"id": i["id"]} for i in issues if self._matches(i, v[key])][:1]}
                    for key in ("elsewhere", "deeper")
                }
            case "CommentPlace":
                comment_name = NAME.get(v["id"])
                if comment_name not in self.comments:
                    raise LookupError
                comment = self.comments[comment_name]
                return {
                    "comment": {
                        "id": ID[comment_name],
                        "issue": {"id": ID[comment["issue"]]},
                        "parent": {"id": ID[comment["parent"]]} if comment["parent"] else None,
                    }
                }
            case "IssueCreate":
                data = v["input"]
                self.writes.append((name, data))
                team = NAME[data["teamId"]]
                issue = self._new("NEW", team, data["title"], description=data.get("description", ""))
                issue["identifier"] = f"{self.teams[team]['key']}-9"
                return {"issueCreate": {"success": True, "issue": self._written(issue)}}
            case "IssueUpdate":
                self.writes.append((name, {"id": v["id"], **v["input"]}))
                issue = self._find_issue(v["id"])
                if "title" in v["input"]:
                    issue["title"] = v["input"]["title"]
                return {"issueUpdate": {"success": True, "issue": self._written(issue)}}
            case "CommentCreate":
                self.writes.append((name, v["input"]))
                return {
                    "commentCreate": {"success": True, "comment": {"id": str(uuid4()), "createdAt": "now"}}
                }
        raise AssertionError(name)

    def _written(self, issue: dict) -> dict:
        return {
            "id": issue["id"],
            "identifier": issue["identifier"],
            "title": issue["title"],
            "url": self._url(issue),
            "state": self._state(issue["team"], issue["state"]),
            "team": {"id": ID[issue["team"]]},
        }

    def names(self) -> list[str]:
        return [name for name, _ in self.ops]

    def client(self) -> LinearClient:
        return LinearClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def linear() -> FakeLinear:
    return FakeLinear()


@pytest.fixture
def start(scoped, user, linear, monkeypatch):
    """Starts a run for an agent with the user's Linear connection, holding `grants` on teams."""
    monkeypatch.setattr(LinearConnector, "client", lambda self, token: linear.client())

    def start_(grants: dict[str, tuple[str, ...]]) -> Executor:
        with workspace_scope(scoped.id):
            connection = Connection.objects.filter(provider="linear").first() or Connection(
                provider="linear", owner=user, label="Acme", external_account_id=ID["ada"]
            )
            connection.set_credentials({"kind": "oauth2", "access_token": "t", "scopes": ["read", "write"]})
            connection.save()
            Grant.objects.filter(connection=connection, layer__level=PermissionLayer.Level.USER).delete()
            changes = [GrantChange("team", ID.get(name, name), actions) for name, actions in grants.items()]
            if changes:
                apply_grant_changes(user_id=user.id, connection=connection, changes=changes, names={})
            agent = Agent.objects.get()
            agent.connections.set([connection])
            conversation = Conversation.objects.create(agent=agent, user=user)
            _, run = services.start_run(conversation=conversation, user_id=user.id, content="hi")
        services.claim_queued(10)
        run.refresh_from_db()
        return Executor(RunContext.from_run(run))

    return sync_to_async(start_)


def _ceiling(name: str, effect: str, actions=("read",)):
    def create() -> None:
        Grant.objects.create(
            layer=PermissionLayer.unscoped.get(level=PermissionLayer.Level.CEILING),
            connection=Connection.unscoped.get(provider="linear"),
            resource_kind="team",
            resource_id=ID[name],
            actions=list(actions),
            effect=effect,
        )

    return sync_to_async(create)


async def _refused(executor, tool, args) -> str:
    with pytest.raises(OperationError) as caught:
        await executor.invoke(tool, args)
    return caught.value.code


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _identifiers(outcome) -> list[str]:
    return [item["identifier"] for item in _items(outcome)]


# Text


def test_read_text_hides_titles_of_linked_objects():
    shown = text.redact(
        f"[{SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing) and "
        "https://linear.app/Acme/issue/ops-2/other-title, "
        "https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f/overview, "
        "linear.app/acme/view/hush-hush, https://linear.app/acme, "
        "![shot](https://uploads.linear.app/a/b.png), "
        f"[\\[SEC\\] {SECRET} \\[x\\]](https://linear.app/acme/issue/OPS-1/x), "
        f"[[{SECRET}]](https://linear.app/acme/issue/OPS-1 'tip'), "
        f"![{SECRET}](https://linear.app/acme/issue/OPS-1 ({SECRET})), "
        f'[{SECRET}](https://linear.app/acme/issue/OPS-1 "a \\"quote\\"")'
    )
    assert (
        "ecret" not in shown and "other-title" not in shown and "roadmap" not in shown and "hush" not in shown
    )
    assert "https://linear.app/acme/issue/OPS-1 and" in shown
    assert "https://linear.app/Acme/issue/OPS-2," in shown
    assert "https://linear.app/acme/project/0a1b2c3d4e5f," in shown
    assert "https://linear.app/acme/view," in shown
    assert "![shot](https://uploads.linear.app/a/b.png)" in shown
    assert "SEC" not in shown
    assert text.redact(None) is None


@pytest.mark.parametrize(
    "written",
    [
        "![x](https://evil.example/p.png)",
        "<img src=https://evil.example/p.png>",
        '<a href="https://evil.example">x</a>',
        "<iframe>",
        "https://linear.app/acme/project/roadmap-0a1b2c3d4e5f",
        "linear.app/acme/issue/ENG-1",
        "https://linear.app/acme/issue/ENG-1.evil",
        "[x](https://linear.app/acme/issue/ENG-1/../../issue/OPS-1)",
        "[x](https://linear.app/acme/issue/ENG-1/x_/../../OPS-1)",
        "[x](https://linear.app/acme/issue/ENG-1'/../OPS-1)",
        "https://linear.app/acme/issue/ENG-1)/../OPS-1",
        "https://linear.app/acme/issue/ENG-1\\)/../OPS-1",
        "https://linear.app/acme/issue/ENG-1/%2e%2e",
        "https://linear.app/acme/issue/ENG-1?x=1",
        "https://linear.app/acme/issue/ENG-1#top",
        "[x](https://linear%2eapp/acme/issue/OPS-1)",
        "[x](https://linear&#46;app/acme/issue/OPS-1)",
        "[x](https://linear\\.app/acme/issue/OPS-1)",
        "[x](https://linear\u3002app/acme/issue/OPS-1)",
        "[x](https://\uff4c\uff49\uff4e\uff45\uff41\uff52.app/acme/issue/OPS-1)",
        "[x](https://linear\u200b.app/acme/issue/OPS-1)",
        "https://linear.app/acme/settings/api",
        "[ENG-1](https://linear.app/acme/team/ENG)",
        "nul\x00",
        " ".join(f"https://linear.app/acme/issue/ENG-{n}" for n in range(1, 12)),
    ],
)
def test_written_text_may_only_add_words(written):
    with pytest.raises(ValueError):
        text.check_written(written)


def test_written_text_allows_markdown_uploads_and_issue_links():
    written = (
        "Plain **markdown** with [a link](https://example.com), <br>, "
        "![shot](https://uploads.linear.app/a/b.png), [docs](https://linear.app/Acme/issue/eng-2/write-docs) "
        "and https://linear.app/acme/issue/ENG-2. (https://linear.app/acme/issue/ENG-2), 100% sure, "
        "**https://linear.app/acme/issue/ENG-2**, <https://linear.app/acme/issue/ENG-2/>"
    )
    assert text.check_written(written) == written
    assert text.issue_links(written) == [("acme", "ENG-2")]


def test_judge_claims_only_what_linear_confirms():
    def response(status: int, body) -> httpx.Response:
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)

    error = {"message": "x", "extensions": {"type": "internal error"}}
    assert judge(response(200, {"data": {"issueCreate": {"success": True}}})) == Effect.APPLIED
    # Errors raised before anything ran.
    malformed = {"message": "x", "extensions": {"type": "graphql error", "code": "GRAPHQL_VALIDATION_FAILED"}}
    assert judge(response(400, {"errors": [malformed]})) == Effect.NOT_APPLIED
    limited = {"message": "x", "extensions": {"type": "Ratelimited", "code": "RATELIMITED"}}
    assert judge(response(400, {"data": None, "errors": [limited]})) == Effect.NOT_APPLIED
    # Anything else may have been applied.
    assert judge(response(400, {"errors": [error]})) == Effect.UNKNOWN
    assert judge(response(200, {"data": None, "errors": [malformed]})) == Effect.UNKNOWN
    assert judge(response(200, {"data": None, "errors": [error]})) == Effect.UNKNOWN
    assert judge(response(200, {"data": {"issueCreate": {"success": False}}})) == Effect.UNKNOWN
    assert judge(response(200, "<html>")) == Effect.UNKNOWN
    assert judge(response(502, "<html>")) is None


def test_team_chains_beyond_the_limit_are_partial():
    def chain(levels: int) -> TeamRef:
        team = TeamRef(id=str(UUID(int=1000)))
        for n in range(levels):
            team = TeamRef(id=str(UUID(int=n + 1)), parent=team)
        return team

    within, partial = teams._ancestry(chain(MAX_TEAM_DEPTH))
    assert len(within) == MAX_TEAM_DEPTH and not partial
    within, partial = teams._ancestry(chain(MAX_TEAM_DEPTH + 1))
    assert len(within) == MAX_TEAM_DEPTH and partial


# Connecting


async def test_account_discovery_and_names(linear):
    connector = LinearConnector()
    client = linear.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (ID["ada"], "Ada Lovelace (Acme)")
    found = await connector.discover(client, "team", query=None, cursor=None)
    assert [i.name for i in found.items] == [
        "Engineering (ENG)",
        "Web (WEB)",
        "Operations (OPS)",
        "Design (DES)",
    ]
    found = await connector.discover(client, "team", query="ops", cursor=None)
    assert [(NAME[i.id], i.name) for i in found.items] == [("ops", "Operations (OPS)")]
    with pytest.raises(OperationError) as bad:
        await connector.discover(client, "team", query=None, cursor="not a cursor")
    assert bad.value.code == "INVALID_CURSOR"
    names = await connector.describe(client, "team", [ID["eng"], ID["sec"], "*", "ENG"])
    assert names == {ID["eng"]: "Engineering (ENG)"}


FLOW = {"client_id": "id", "verifier": "v"}


@pytest.fixture
def token_endpoint(monkeypatch):
    sent: list[dict] = []
    responses: list[httpx.Response] = []
    creds = ClientCredentials("id", "secret", "https://x/cb")
    monkeypatch.setattr(connection_oauth, "client_credentials", lambda connector: creds)
    monkeypatch.setattr(connection_oauth, "issuing_client", lambda connector, client_id: creds)

    def post(url, **kwargs):
        sent.append({"url": url, **kwargs})
        return responses.pop(0)

    monkeypatch.setattr(connection_oauth.httpx, "post", post)
    return sent, responses


def test_linear_tokens_carry_their_scopes(token_endpoint):
    sent, responses = token_endpoint
    connector = registry.get("linear")
    responses.append(
        httpx.Response(200, json={"access_token": "a", "token_type": "Bearer", "scope": ["read", "write"]})
    )
    tokens = connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    assert tokens["access_token"] == "a" and tokens["scopes"] == ["read", "write"]
    [request] = sent
    assert request["url"] == "https://api.linear.app/oauth/token"
    assert request["data"]["client_secret"] == "secret" and request["data"]["code_verifier"] == "v"
    responses.append(httpx.Response(200, json={"access_token": "b", "scope": "read,issues:create"}))
    tokens = connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    assert tokens["scopes"] == ["issues:create", "read"]


def test_linear_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("linear")
    monkeypatch.setattr(
        connection_oauth,
        "client_credentials",
        lambda connector: ClientCredentials("id", "s", "https://x/cb"),
    )
    requested = connection_oauth.requested_scopes(connector, {"read", "create", "comment"})
    assert requested == ["read", "comments:create", "issues:create"]
    url = connection_oauth.authorization_url({}, workspace_id=uuid4(), provider="linear", scopes=requested)
    params = httpx.URL(url).params
    assert url.startswith("https://linear.app/oauth/authorize?")
    assert params["scope"] == "read,comments:create,issues:create"
    assert params["code_challenge_method"] == "S256"
    assert connection_oauth.requested_scopes(connector, {"read"}) == ["read"]
    assert "write" in connection_oauth.requested_scopes(connector, {"read", "edit"})
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset({"read", "write"}), {"read", "create", "comment", "edit"}) == []
    assert needed(connector, frozenset({"read", "issues:create"}), {"read", "create", "comment", "edit"}) == [
        "comment",
        "edit",
    ]


# Runs


@pytest.mark.django_db(transaction=True)
async def test_a_grant_on_a_team_covers_its_sub_teams(start, linear):
    executor = await start({"eng": ("read",)})
    teams = await executor.invoke("linear_list_teams", {})
    assert [item["key"] for item in _items(teams)] == ["ENG", "WEB"]
    [web] = _items(await executor.invoke("linear_get_team", {"team": "web"}))
    assert web["parent_team_id"] == ID["eng"]
    [issue] = _items(await executor.invoke("linear_get_issue", {"issue": "web-1"}))
    assert issue["title"] == "Landing page"
    [issue] = _items(await executor.invoke("linear_get_issue", {"issue": ID["ENG-2"].upper()}))
    assert issue["identifier"] == "ENG-2"

    linear.ops.clear()
    # Teams without a grant, teams the account cannot see, and missing issues look alike.
    for args in ({"issue": "OPS-1"}, {"issue": "SEC-1"}, {"issue": "ENG-999"}, {"issue": str(uuid4())}):
        assert await _refused(executor, "linear_get_issue", args) == "POLICY_DENIED"
    for team in ("OPS", "sec", "NOPE", ID["sec"]):
        assert await _refused(executor, "linear_list_issues", {"team": team}) == "POLICY_DENIED"
    # Nothing but where the issue or team sits was asked for.
    assert set(linear.names()) <= {"IssuePlace", "TeamByKey", "Team"}

    executor = await start({"web": ("read",)})
    assert await _refused(executor, "linear_get_team", {"team": "ENG"}) == "POLICY_DENIED"
    assert [item["key"] for item in _items(await executor.invoke("linear_list_teams", {}))] == ["WEB"]


@pytest.mark.django_db(transaction=True)
async def test_a_deny_on_a_sub_team_holds(start, linear):
    await start({})
    await _ceiling("web", Grant.Effect.DENY)()
    executor = await start({"eng": ("read",)})
    assert await _refused(executor, "linear_get_issue", {"issue": "WEB-1"}) == "POLICY_DENIED"
    assert [item["key"] for item in _items(await executor.invoke("linear_list_teams", {}))] == ["ENG"]
    assert _items(await executor.invoke("linear_get_issue", {"issue": "ENG-1"}))


@pytest.mark.django_db(transaction=True)
async def test_cycles_are_partial(start, linear):
    linear.teams["eng"]["parent"] = "web"
    await start({})
    await _ceiling("ops", Grant.Effect.DENY)()
    executor = await start({"*": ("read",)})
    # A chain Linear cannot show in full could lead anywhere, the denied team included.
    for team in ("ENG", "WEB", "OPS"):
        assert await _refused(executor, "linear_get_team", {"team": team}) == "POLICY_DENIED"
    assert _items(await executor.invoke("linear_get_team", {"team": "DES"}))


@pytest.mark.django_db(transaction=True)
async def test_reading_an_issue_hides_other_teams(start, linear):
    executor = await start({"eng": ("read",)})
    [issue] = _items(await executor.invoke("linear_get_issue", {"issue": "ENG-1"}))
    assert SECRET not in json.dumps(issue)
    assert "https://linear.app/acme/issue/OPS-1," in issue["description"]
    assert "https://linear.app/acme/project/0a1b2c3d4e5f" in issue["description"]
    assert "hush" not in issue["description"]
    assert issue["url"] == "https://linear.app/acme/issue/ENG-1"
    assert [child["identifier"] for child in issue["sub_issues"]] == ["ENG-2"]
    assert issue["sub_issues_in_other_teams"] is True
    assert issue["parent"] is None
    # Hidden comments are left out; comments come oldest first.
    assert [c["body"] for c in issue["comments"]] == [
        "First",
        "Reply about https://linear.app/acme/issue/OPS-1",
    ]
    assert issue["comments"][1]["reply_to"] == ID["c1"]
    assert issue["comments"][0]["author"] == "Grace"

    [child] = _items(await executor.invoke("linear_get_issue", {"issue": "ENG-2"}))
    assert child["parent"] == {"identifier": "ENG-1", "title": "Launch plan"}
    [other] = _items(await executor.invoke("linear_get_issue", {"issue": "ENG-3"}))
    assert other["parent"] == {"in_another_team": True}


@pytest.mark.django_db(transaction=True)
async def test_listing_and_searching_issues(start, linear):
    executor = await start({"eng": ("read",)})
    assert _identifiers(await executor.invoke("linear_list_issues", {"team": "ENG"})) == [
        "ENG-1",
        "ENG-2",
        "ENG-3",
    ]
    closed = await executor.invoke("linear_list_issues", {"team": "ENG", "state": "closed"})
    assert _identifiers(closed) == ["ENG-4"]
    mine = await executor.invoke("linear_list_issues", {"team": "ENG", "assigned_to_me": True})
    assert _identifiers(mine) == ["ENG-2"]
    first = await executor.invoke("linear_list_issues", {"team": "ENG", "state": "all", "limit": 3})
    assert _identifiers(first) == ["ENG-1", "ENG-2", "ENG-3"]
    rest = await executor.invoke(
        "linear_list_issues",
        {"team": "ENG", "state": "all", "limit": 3, "cursor": first.result["next_cursor"]},
    )
    assert _identifiers(rest) == ["ENG-4"] and "next_cursor" not in rest.result
    # Issues of other teams are dropped even if Linear returned them.
    linear.stray = "OPS-1"
    assert "OPS-1" not in _identifiers(await executor.invoke("linear_list_issues", {"team": "ENG"}))
    linear.stray = None

    assert _identifiers(await executor.invoke("linear_search_issues", {"team": "ENG", "query": "plan"})) == [
        "ENG-1"
    ]
    assert linear.last_filter == {"and": [{"title": {"containsIgnoreCase": "plan"}}]}
    assert (
        _identifiers(await executor.invoke("linear_search_issues", {"team": "ENG", "query": "secret"})) == []
    )
    assert (
        await _refused(executor, "linear_search_issues", {"team": "OPS", "query": "secret"})
        == "POLICY_DENIED"
    )


@pytest.mark.django_db(transaction=True)
async def test_a_team_lists_what_issues_can_use(start, linear):
    executor = await start({"eng": ("read",)})
    [team] = _items(await executor.invoke("linear_get_team", {"team": "ENG"}))
    assert [s["name"] for s in team["states"]] == [name for name, _ in STATES]
    assert team["labels"] == [
        {"name": "Bug", "group": None},
        {"name": "Frontend", "group": "Area"},
        {"name": "Urgent", "group": None},
    ]
    assert [m["name"] for m in team["members"]] == ["Ada Lovelace", "Grace Hopper"]
    assert team["truncated"] is False


@pytest.mark.django_db(transaction=True)
async def test_creating_issues(start, linear):
    executor = await start({"eng": ("read", "create")})
    [created] = _items(
        await executor.invoke(
            "linear_create_issue",
            {
                "team": "eng",
                "title": "New thing",
                "description": "Follows https://linear.app/acme/issue/ENG-2/write-docs",
                "state": "todo",
                "priority": 2,
                "labels": ["bug", "area/frontend", "Urgent"],
                "assignee": "Me",
                "due_date": "2026-10-10",
            },
        )
    )
    assert created["identifier"] == "ENG-9" and created["url"] == "https://linear.app/acme/issue/ENG-9"
    [(_, sent)] = linear.writes
    assert sent == {
        "teamId": ID["eng"],
        "title": "New thing",
        "useDefaultTemplate": False,
        "description": "Follows https://linear.app/acme/issue/ENG-2/write-docs",
        "stateId": "eng-unstarted",
        "priority": 2,
        "labelIds": ["l-bug", "l-frontend", "l-urgent"],
        "assigneeId": ID["ada"],
        "dueDate": "2026-10-10",
    }

    refusals = [
        ({"description": "See https://linear.app/acme/issue/OPS-1"}, "LINK_NOT_ALLOWED"),
        ({"description": "See https://linear.app/acme/issue/WEB-1"}, "LINK_NOT_ALLOWED"),
        ({"description": "See https://linear.app/acme/issue/SEC-1"}, "LINK_NOT_ALLOWED"),
        ({"description": "See https://linear.app/acme/issue/ENG-404"}, "LINK_NOT_ALLOWED"),
        ({"description": "See https://linear.app/other/issue/ENG-1"}, "LINK_NOT_ALLOWED"),
        ({"description": "See https://linear.app/acme/project/x-0a1b2c3d4e5f"}, "INVALID_ARGUMENTS"),
        ({"labels": ["Area"]}, "INVALID_ARGUMENTS"),
        ({"labels": ["Nope"]}, "INVALID_ARGUMENTS"),
        ({"assignee": "old"}, "INVALID_ARGUMENTS"),
        ({"state": "Done"}, "INVALID_ARGUMENTS"),
        ({"due_date": "10/10/2026"}, "INVALID_ARGUMENTS"),
        ({"title": "two\nlines"}, "INVALID_ARGUMENTS"),
        ({"priority": 5}, "INVALID_ARGUMENTS"),
    ]
    for extra, code in refusals:
        args = {"team": "ENG", "title": "x", **extra}
        assert await _refused(executor, "linear_create_issue", args) == code, extra
    assert len(linear.writes) == 1
    # Refused messages are the same whatever the linked issue is.
    messages = set()
    for target in ("OPS-1", "SEC-1", "ENG-404"):
        with pytest.raises(OperationError) as caught:
            await executor.invoke(
                "linear_create_issue",
                {"team": "ENG", "title": "x", "description": f"https://linear.app/acme/issue/{target}"},
            )
        messages.add(caught.value.message)
    assert len(messages) == 1

    assert await _refused(executor, "linear_create_issue", {"team": "OPS", "title": "x"}) == "POLICY_DENIED"
    executor = await start({"eng": ("read",)})
    assert "linear_create_issue" not in executor.context.tools


@pytest.mark.django_db(transaction=True)
async def test_commenting(start, linear):
    executor = await start({"eng": ("read", "comment")})
    [comment] = _items(await executor.invoke("linear_add_comment", {"issue": "ENG-1", "body": "Thanks"}))
    assert comment["issue"] == "ENG-1" and comment["reply_to"] is None
    # A reply to a reply joins its thread.
    [reply] = _items(
        await executor.invoke(
            "linear_add_comment", {"issue": "ENG-1", "body": "Agreed", "reply_to": ID["c3"]}
        )
    )
    assert reply["reply_to"] == ID["c1"]
    assert linear.writes == [
        ("CommentCreate", {"issueId": ID["ENG-1"], "body": "Thanks"}),
        ("CommentCreate", {"issueId": ID["ENG-1"], "body": "Agreed", "parentId": ID["c1"]}),
    ]
    for reply_to in (ID["c4"], ID["gone"], "c1"):
        args = {"issue": "ENG-1", "body": "x", "reply_to": reply_to}
        assert await _refused(executor, "linear_add_comment", args) == "INVALID_ARGUMENTS"
    args = {"issue": "ENG-1", "body": "cc https://linear.app/acme/issue/OPS-2"}
    assert await _refused(executor, "linear_add_comment", args) == "LINK_NOT_ALLOWED"
    assert await _refused(executor, "linear_add_comment", {"issue": "OPS-1", "body": "x"}) == "POLICY_DENIED"
    assert len(linear.writes) == 2


@pytest.mark.django_db(transaction=True)
async def test_updating_issues(start, linear):
    executor = await start({"eng": ("read", "edit")})
    [updated] = _items(
        await executor.invoke(
            "linear_update_issue",
            {
                "issue": "ENG-2",
                "title": "Write better docs",
                "priority": 1,
                "add_labels": ["Bug"],
                "remove_labels": ["Frontend"],
                "unassign": True,
                "clear_due_date": True,
            },
        )
    )
    assert updated["title"] == "Write better docs"
    assert updated["changed"] == [
        "addedLabelIds",
        "assigneeId",
        "dueDate",
        "priority",
        "removedLabelIds",
        "title",
    ]
    assert linear.writes[-1] == (
        "IssueUpdate",
        {
            "id": ID["ENG-2"],
            "title": "Write better docs",
            "priority": 1,
            "addedLabelIds": ["l-bug"],
            "removedLabelIds": ["l-frontend"],
            "assigneeId": None,
            "dueDate": None,
        },
    )
    # A sub-issue whose parents are all in the team may change status.
    await executor.invoke("linear_update_issue", {"issue": "ENG-2", "state": "In progress"})
    assert linear.writes[-1][1] == {"id": ID["ENG-2"], "stateId": "eng-started"}

    executor = await start({"eng": ("read", "edit")})
    writes = len(linear.writes)
    # Linear could close OPS-1 when its sub-issue ENG-3 closes, or reopen it.
    for state in ("Done", "Todo"):
        args = {"issue": "ENG-3", "state": state}
        assert await _refused(executor, "linear_update_issue", args) == "STATUS_CHANGE_REFUSED"
    # Closing ENG-1 would close its open sub-issue OPS-2.
    for state in ("Done", "Canceled"):
        args = {"issue": "ENG-1", "state": state}
        assert await _refused(executor, "linear_update_issue", args) == "STATUS_CHANGE_REFUSED"
    assert len(linear.writes) == writes
    await executor.invoke("linear_update_issue", {"issue": "ENG-1", "state": "In Progress"})
    linear.issues["OPS-2"]["state"] = "completed"
    await executor.invoke("linear_update_issue", {"issue": "ENG-1", "state": "Done"})
    assert linear.writes[-1][1] == {"id": ID["ENG-1"], "stateId": "eng-completed"}

    executor = await start({"eng": ("read", "edit")})
    for args in (
        {"issue": "ENG-1"},
        {"issue": "ENG-1", "assignee": "grace", "unassign": True},
        {"issue": "ENG-1", "due_date": "2026-10-10", "clear_due_date": True},
        {"issue": "ENG-1", "add_labels": ["Bug"], "remove_labels": ["bug"]},
    ):
        assert await _refused(executor, "linear_update_issue", args) == "INVALID_ARGUMENTS"
    assert (
        await _refused(executor, "linear_update_issue", {"issue": "OPS-1", "title": "x"}) == "POLICY_DENIED"
    )


def _move(linear, before: str, change) -> None:
    """Applies `change` just before Linear answers the first `before` request."""
    done = []

    def hook(name, variables):
        if name == before and not done:
            done.append(name)
            change()

    linear.hook = hook


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("tool", "args", "before", "code"),
    [
        ("linear_get_issue", {"issue": "ENG-1"}, "Issue", "ISSUE_MOVED"),
        ("linear_add_comment", {"issue": "ENG-1", "body": "x"}, "IssuePlace", "ISSUE_MOVED"),
        ("linear_update_issue", {"issue": "ENG-1", "title": "x"}, "IssueForUpdate", "ISSUE_MOVED"),
        ("linear_create_issue", {"team": "ENG", "title": "x"}, "Team", "TEAM_MOVED"),
        # A move during the lookups that come before the write.
        ("linear_update_issue", {"issue": "ENG-1", "add_labels": ["Bug"]}, "TeamLabels", "ISSUE_MOVED"),
        ("linear_create_issue", {"team": "ENG", "title": "x", "labels": ["Bug"]}, "TeamLabels", "TEAM_MOVED"),
        ("linear_update_issue", {"issue": "ENG-2", "state": "Done"}, "OpenSubIssues", "ISSUE_MOVED"),
        ("linear_list_issues", {"team": "ENG"}, "TeamIssues", "TEAM_MOVED"),
        ("linear_get_team", {"team": "ENG"}, "Team", "TEAM_MOVED"),
    ],
)
async def test_an_issue_or_team_moved_while_the_call_runs_is_refused(start, linear, tool, args, before, code):
    executor = await start({"*": ("read", "comment", "create", "edit")})

    def change():
        if code == "ISSUE_MOVED":
            linear.issues[args.get("issue", "ENG-1")]["team"] = "ops"
        else:
            linear.teams["eng"]["parent"] = "ops"

    if tool == "linear_add_comment":
        # The first IssuePlace resolves the issue; the move lands before the second.
        seen = []

        def hook(name, variables):
            if name == "IssuePlace":
                seen.append(name)
                if len(seen) == 2:
                    change()

        linear.hook = hook
    else:
        _move(linear, before, change)
    assert await _refused(executor, tool, args) == code
    assert linear.writes == []


@pytest.mark.django_db(transaction=True)
async def test_write_outcomes_follow_what_linear_confirmed(start, linear):
    executor = await start({"eng": ("read", "create")})

    def answer(body, status=200):
        linear.hook = lambda name, variables: (
            httpx.Response(status, json=body) if name == "IssueCreate" else None
        )

    limited = {"message": "x", "extensions": {"type": "Ratelimited", "code": "RATELIMITED"}}
    answer({"data": None, "errors": [limited]}, 400)
    assert (
        await _refused(executor, "linear_create_issue", {"team": "ENG", "title": "a"})
        == "PROVIDER_RATE_LIMITED"
    )
    answer({"errors": [{"message": "bad", "extensions": {"type": "graphql error"}}]}, 400)
    assert (
        await _refused(executor, "linear_create_issue", {"team": "ENG", "title": "b"}) == "PROVIDER_REJECTED"
    )
    # Confirmed without the issue: applied, with nothing more to show.
    answer({"data": {"issueCreate": {"success": True, "issue": None}}})
    [written] = _items(await executor.invoke("linear_create_issue", {"team": "ENG", "title": "c"}))
    assert written == {"written": True}
    # An error after the mutation may have run: unknown, and further writes pause.
    answer({"data": None, "errors": [{"message": "boom", "extensions": {"type": "internal error"}}]})
    assert await _refused(executor, "linear_create_issue", {"team": "ENG", "title": "d"}) == "WRITE_UNCERTAIN"
    linear.hook = None
    assert await _refused(executor, "linear_create_issue", {"team": "ENG", "title": "e"}) == "WRITE_UNCERTAIN"


@pytest.mark.django_db(transaction=True)
async def test_reads_with_errors_or_too_much_data_are_refused(start, linear):
    executor = await start({"eng": ("read",)})
    forbidden = {"message": "no", "extensions": {"type": "forbidden"}}
    linear.hook = lambda name, variables: (
        httpx.Response(200, json={"data": {"issue": None}, "errors": [forbidden]})
        if name == "Issue"
        else None
    )
    assert await _refused(executor, "linear_get_issue", {"issue": "ENG-1"}) == "PROVIDER_FORBIDDEN"
    huge = {"data": {"issue": {"description": "x" * (5 * 1024 * 1024)}}}
    linear.hook = lambda name, variables: httpx.Response(200, json=huge) if name == "Issue" else None
    assert await _refused(executor, "linear_get_issue", {"issue": "ENG-1"}) == "RESPONSE_TOO_LARGE"
