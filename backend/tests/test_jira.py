"""Jira connector against an in-memory Atlassian API, and runs through the executor."""

import copy
import json
import re
import time

import httpx
import pytest
from connector_runs import ceiling, refusal

from connections import credentials as connection_credentials
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.atlassian import adf
from connectors.base import OperationError
from connectors.jira import client as client_module
from connectors.jira.client import JiraClient
from connectors.jira.connector import JiraConnector
from permissions.models import Grant

SECRET = "SECRET merger"
ACCOUNT_ID = "5b10ac8d82e05b22cc7d4ef5"
ACME = "11111111-1111-1111-1111-111111111111"
BETA = "22222222-2222-2222-2222-222222222222"
WIKI = "33333333-3333-3333-3333-333333333333"
ENG = f"{ACME}/10000"
FIN = f"{ACME}/10001"
OPS = f"{BETA}/10000"
SCOPES = ["offline_access", "read:me", "read:jira-work", "write:jira-work"]
# Jira's page tokens are opaque; some are not URL-safe.
TOKEN = "eyJ+a/b="


def _doc(*content: dict) -> dict:
    return {"type": "doc", "version": 1, "content": list(content)}


def _paragraph(*content: dict) -> dict:
    return {"type": "paragraph", "content": list(content)}


def _text(text: str, href: str | None = None) -> dict:
    node: dict = {"type": "text", "text": text}
    if href is not None:
        node["marks"] = [{"type": "link", "attrs": {"href": href}}]
    return node


def _issue(issue_id: str, key: str, project: str, summary: str, **fields) -> dict:
    return {
        "id": issue_id,
        "key": key,
        "fields": {
            "project": {"id": project, "key": key.split("-")[0]},
            "summary": summary,
            "status": {"name": "To Do", "statusCategory": {"key": "new", "name": "To Do"}},
            "issuetype": {"id": "1", "name": "Task", "subtask": False},
            "priority": {"name": "Medium"},
            "assignee": {"displayName": "Ada"},
            "reporter": {"displayName": "Grace"},
            "labels": [],
            "created": "2026-10-01T09:00:00.000+0000",
            "updated": "2026-10-02T09:00:00.000+0000",
            "duedate": None,
            "resolution": None,
            "description": None,
            "subtasks": [],
            "issuelinks": [],
            "attachment": [],
        }
        | fields,
    }


def _project(project_id: str, key: str, name: str) -> dict:
    return {"id": project_id, "key": key, "name": name, "projectTypeKey": "software", "archived": False}


class FakeJira:
    """Atlassian's API for Jira, served through httpx.MockTransport.

    Acme (acme.atlassian.net) has projects ENG and FIN; Beta (beta.atlassian.net) has OPS, whose id repeats
    ENG's. ENG-1 has a sub-task ENG-2 and blocks FIN-1, whose former key was ENG-9.
    """

    def __init__(self) -> None:
        self.me = {"account_id": ACCOUNT_ID, "name": "Ada", "email": "ada@example.com"}
        self.resources = [
            {"id": BETA.upper(), "name": "Beta", "url": "https://beta.atlassian.net", "scopes": SCOPES},
            {"id": ACME, "name": "Acme", "url": "https://acme.atlassian.net", "scopes": SCOPES},
            # The same site again (Atlassian lists a site once per product), and a site without Jira.
            {"id": ACME, "name": "Acme", "url": "https://acme.atlassian.net", "scopes": ["read:confluence"]},
            {"id": WIKI, "name": "Wiki", "url": "https://wiki.atlassian.net", "scopes": ["read:confluence"]},
        ]
        description = _doc(
            _paragraph(
                _text("See "),
                _text(SECRET, "https://acme.atlassian.net/browse/FIN-1"),
                _text(" and "),
                _text("docs", "https://example.com/docs"),
            ),
            {"type": "inlineCard", "attrs": {"url": "https://acme.atlassian.net/browse/FIN-1"}},
        )
        self.sites: dict[str, dict] = {
            ACME: {
                "projects": [_project("10000", "ENG", "Engineering"), _project("10001", "FIN", SECRET)],
                "issues": {
                    "20001": _issue(
                        "20001",
                        "ENG-1",
                        "10000",
                        "Fix login",
                        description=description,
                        subtasks=[{"id": "20003", "key": "ENG-2"}],
                        issuelinks=[
                            {
                                "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                                "outwardIssue": {"id": "20002", "key": "FIN-1"},
                            }
                        ],
                        attachment=[{"filename": SECRET}],
                    ),
                    "20002": _issue("20002", "FIN-1", "10001", SECRET),
                    "20003": _issue("20003", "ENG-2", "10000", "Write tests", parent={"id": "20001"}),
                },
                "aliases": {"ENG-9": "20002"},
                "comments": {
                    "20001": [
                        {
                            "id": str(30000 + n),
                            "author": {"displayName": "Grace"},
                            "body": _doc(_paragraph(_text(f"comment {n}"))),
                            "created": f"2026-10-01T{n:02d}:00:00.000+0000",
                        }
                        for n in range(3)
                    ]
                },
            },
            BETA: {
                "projects": [_project("10000", "OPS", "Operations")],
                "issues": {"20001": _issue("20001", "OPS-1", "10000", "Rotate keys")},
                "aliases": {},
                "comments": {},
            },
        }
        self.types = [
            {"id": "1", "name": "Task", "subtask": False},
            {"id": "2", "name": "Bug", "subtask": False},
            {"id": "5", "name": "Sub-task", "subtask": True},
        ]
        self.transitions = [
            {"id": "11", "name": "Start", "to": {"name": "In Progress"}},
            {"id": "21", "name": "Finish", "to": {"name": "Done"}},
            {"id": "31", "name": "Close", "to": {"name": "Done"}},
        ]
        self.page_size: int | None = None
        # Ids search returns before the issues it names (an index that lags behind moves).
        self.stale: list[str] = []
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _missing() -> httpx.Response:
        return httpx.Response(404, json={"errorMessages": [SECRET]})

    def _issue(self, site: dict, name: str) -> dict | None:
        issue_id = site["aliases"].get(name, name)
        return site["issues"].get(issue_id) or next(
            (i for i in site["issues"].values() if i["key"] == issue_id), None
        )

    def _page(self, items: list, params: dict) -> tuple[list, int | None]:
        size = self.page_size or int(params.get("maxResults", 50))
        start = int(params.get("startAt", 0))
        if "nextPageToken" in params:
            assert params["nextPageToken"].startswith(TOKEN)
            start = int(params["nextPageToken"].removeprefix(TOKEN))
        end = start + size
        return items[start:end], end if end < len(items) else None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == "api.atlassian.com"
        path = request.url.path
        params = dict(request.url.params)
        if self.hook is not None and (response := self.hook(request.method, path, params)) is not None:
            return response
        if path == "/me":
            return httpx.Response(200, json=self.me)
        if path == "/oauth/token/accessible-resources":
            return httpx.Response(200, json=self.resources)
        parts = path.strip("/").split("/")
        assert parts[:2] == ["ex", "jira"] and parts[3:6] == ["rest", "api", "3"], path
        site = self.sites.get(parts[2])
        if site is None:
            return self._missing()
        rest = parts[6:]
        if request.method == "POST":
            body = json.loads(request.content)
            match rest:
                case ["issue", "bulkfetch"]:
                    found = [i for i in (self._issue(site, n) for n in body["issueIdsOrKeys"]) if i]
                    # In ascending id order, whatever order they were asked in.
                    found.sort(key=lambda issue: int(issue["id"]))
                    return httpx.Response(200, json={"issues": found, "issueErrors": []})
            self.writes.append(("/".join(rest), body))
            match rest:
                case ["issue"]:
                    fields = body["fields"]
                    project = next(p for p in site["projects"] if p["id"] == fields["project"]["id"])
                    issue = _issue("20009", f"{project['key']}-9", project["id"], fields["summary"])
                    site["issues"]["20009"] = issue
                    return httpx.Response(201, json={"id": "20009", "key": issue["key"], "self": "x"})
                case ["issue", issue_id, "comment"]:
                    created = {"id": "30009", "body": body["body"], "created": "2026-10-03T09:00:00.000+0000"}
                    return httpx.Response(201, json=created)
                case ["issue", issue_id, "transitions"]:
                    return httpx.Response(204)
            raise AssertionError(path)
        match rest:
            case ["project", "search"]:
                assert params["action"] == "browse"
                projects = site["projects"]
                if "query" in params:
                    q = params["query"].casefold()
                    projects = [p for p in projects if q in p["key"].casefold() or q in p["name"].casefold()]
                page, after = self._page(projects, params)
                return httpx.Response(
                    200, json={"values": page, "isLast": after is None, "total": len(projects)}
                )
            case ["project", name]:
                found = next((p for p in site["projects"] if name in (p["id"], p["key"])), None)
                return httpx.Response(200, json=found) if found else self._missing()
            case ["issue", "createmeta", _, "issuetypes"]:
                page, _ = self._page(self.types, params)
                body = {"issueTypes": page, "total": len(self.types), "startAt": int(params["startAt"])}
                return httpx.Response(200, json=body)
            case ["issue", name]:
                found = self._issue(site, name)
                return httpx.Response(200, json=found) if found else self._missing()
            case ["issue", issue_id, "comment"]:
                assert params["orderBy"] == "-created"
                comments = list(reversed(site["comments"].get(issue_id, [])))
                limit = int(params["maxResults"])
                return httpx.Response(200, json={"comments": comments[:limit], "total": len(comments)})
            case ["issue", issue_id, "transitions"]:
                return httpx.Response(200, json={"transitions": self.transitions})
            case ["search", "jql"]:
                project = re.match(r"project = (\d+) ", params["jql"]).group(1)
                # Most recently updated first: here, the highest id.
                matching = [i for i, v in site["issues"].items() if v["fields"]["project"]["id"] == project]
                ids = self.stale + sorted(matching, key=int, reverse=True)
                page, after = self._page(ids, params)
                body: dict = {"issues": [{"id": i} for i in page]}
                if after is not None:
                    body["nextPageToken"] = f"{TOKEN}{after}"
                return httpx.Response(200, json=body)
        raise AssertionError(path)

    def reads(self, suffix: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path.endswith(suffix)]

    def client(self) -> JiraClient:
        return JiraClient("token", transport=httpx.MockTransport(self.handler))

    def one_site(self) -> None:
        self.resources = [r for r in self.resources if r["id"] != BETA.upper()]


@pytest.fixture
def jira() -> FakeJira:
    return FakeJira()


@pytest.fixture
def start(connector_run, jira, monkeypatch):
    """Starts a run with the user's Jira connection, holding `grants` ({site or project: actions})."""
    monkeypatch.setattr(JiraConnector, "client", lambda self, token: jira.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = SCOPES):
        projects = {("project", resource_id): actions for resource_id, actions in grants.items()}
        return connector_run(
            "jira", projects, scopes=scopes, label="Ada (ada@example.com)", external_account_id=ACCOUNT_ID
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


# Connecting and discovery


async def test_the_account_and_its_jira_sites(jira):
    connector = JiraConnector()
    client = jira.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (ACCOUNT_ID, "Ada (ada@example.com)")
    # Once each, ordered by id, in lower case, without sites that did not grant Jira.
    assert [(s.id, s.label) for s in await client.sites()] == [
        (ACME, "Acme (acme.atlassian.net)"),
        (BETA, "Beta (beta.atlassian.net)"),
    ]
    jira.resources = jira.resources[3:]
    with pytest.raises(OperationError) as caught:
        await connector.account(jira.client())
    assert caught.value.code == "UNSUPPORTED_ACCOUNT"


async def test_discovery_lists_sites_then_each_sites_projects(jira, monkeypatch):
    connector = JiraConnector()
    client = jira.client()
    page = await connector.discover(client, "project", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (ACME, "Acme (acme.atlassian.net)"),
        (BETA, "Beta (beta.atlassian.net)"),
        (ENG, "Engineering (ENG) · Acme"),
        (FIN, f"{SECRET} (FIN) · Acme"),
    ]
    second = await connector.discover(client, "project", query=None, cursor=page.next_cursor)
    assert ([(i.id, i.name) for i in second.items], second.next_cursor) == (
        [(OPS, "Operations (OPS) · Beta")],
        None,
    )
    jira.page_size = 1
    first = await connector.discover(client, "project", query="e", cursor=None)
    assert ([i.id for i in first.items], first.next_cursor) == ([ACME, BETA, ENG], "0:1")
    for cursor in ("x", "2:0", "0:-1", "0:1234567"):
        with pytest.raises(OperationError) as caught:
            await connector.discover(client, "project", query=None, cursor=cursor)
        assert caught.value.code == "INVALID_CURSOR"
    described = await connector.describe(
        client,
        "project",
        [ACME, ACME.upper(), WIKI, ENG, OPS, f"{ACME}/99999", f"{WIKI}/10000", f"{ACME}/ENG"],
    )
    assert described == {
        ACME: "Acme (acme.atlassian.net)",
        ENG: "Engineering (ENG) · Acme",
        OPS: "Operations (OPS) · Beta",
    }


async def test_too_many_sites_are_refused(jira, monkeypatch):
    from connectors import atlassian

    monkeypatch.setattr(atlassian, "MAX_SITES", 1)
    with pytest.raises(OperationError) as caught:
        await jira.client().sites()
    assert caught.value.code == "PROVIDER_LIMIT"


def test_cursors_are_checked():
    assert client_module.page_params("t:" + TOKEN) == {"nextPageToken": TOKEN}
    for cursor in ("x:abc", "t:", "t:a b", "t:" + "a" * 991, "t:é"):
        with pytest.raises(OperationError) as caught:
            client_module.page_params(cursor)
        assert caught.value.code == "INVALID_CURSOR"
    assert client_module.next_cursor({"nextPageToken": "abc", "isLast": True}) is None
    assert client_module.next_cursor({}) is None
    for token in ("a b", 5, "a" * 991):
        with pytest.raises(OperationError) as caught:
            client_module.next_cursor({"nextPageToken": token})
        assert caught.value.code == "PROVIDER_LIMIT"


def test_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("jira")
    monkeypatch.setattr(
        connection_oauth, "client_credentials", lambda connector: ClientCredentials("id", "s", "https://x/cb")
    )
    base = ["offline_access", "read:me", "read:jira-work"]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    assert connection_oauth.requested_scopes(connector, {"read", "comment"}) == [*base, "write:jira-work"]
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset(base), {"read", "comment", "create"}) == ["comment", "create"]
    assert needed(connector, frozenset([*base, "write:jira-work"]), {"read", "comment", "transition"}) == []


# Reading


@pytest.mark.django_db(transaction=True)
async def test_a_site_grant_covers_its_projects_and_denies_hold_inside_it(start, jira):
    await start({})
    await ceiling("jira", "project", FIN, Grant.Effect.DENY)
    executor = await start({ACME: ("read",)})
    outcome = await executor.invoke("jira_list_projects", {})
    assert _items(outcome) == [
        {
            "id": "10000",
            "site_id": ACME,
            "site": "Acme (acme.atlassian.net)",
            "key": "ENG",
            "name": "Engineering",
            "type": "software",
            "archived": False,
        }
    ]
    assert SECRET not in json.dumps(outcome.result)
    # Several sites: calls name one.
    assert await refusal(executor, "jira_get_issue", {"issue": "ENG-1"}) == "INVALID_ARGUMENTS"
    args = {"site_id": ACME.upper(), "issue": "eng-1"}
    assert _items(await executor.invoke("jira_get_issue", args))[0]["key"] == "ENG-1"
    for site_id, issue in (
        (ACME, "FIN-1"),
        (ACME, "20002"),
        (BETA, "OPS-1"),
        (WIKI, "ENG-1"),
        (ACME, "ENG-404"),
    ):
        args = {"site_id": site_id, "issue": issue}
        assert await refusal(executor, "jira_get_issue", args) == "POLICY_DENIED"
    for args in ({"site_id": "acme", "issue": "ENG-1"}, {"site_id": ACME, "issue": "ENG 1"}):
        assert await refusal(executor, "jira_get_issue", args) == "INVALID_ARGUMENTS"
    # Nothing of a refused issue was read beyond its project.
    assert all(
        r.url.params.get("fields") == "project" for r in jira.reads("/issue/20002") + jira.reads("/FIN-1")
    )


@pytest.mark.django_db(transaction=True)
async def test_one_site_needs_no_site_id_and_project_ids_repeat_across_sites(start, jira):
    executor = await start({OPS: ("read",)})
    assert await refusal(executor, "jira_search_issues", {"project": "ENG"}) == "INVALID_ARGUMENTS"
    # Project 10000 on Acme is not project 10000 on Beta.
    args = {"site_id": ACME, "project": "10000"}
    assert await refusal(executor, "jira_search_issues", args) == "POLICY_DENIED"
    outcome = await executor.invoke("jira_search_issues", {"site_id": BETA, "project": "10000"})
    assert [i["key"] for i in _items(outcome)] == ["OPS-1"]
    jira.one_site()
    executor = await start({ENG: ("read",)})
    assert [i["key"] for i in _items(await executor.invoke("jira_search_issues", {"project": "ENG"}))] == [
        "ENG-2",
        "ENG-1",
    ]


@pytest.mark.django_db(transaction=True)
async def test_a_former_key_is_authorized_where_the_issue_is_now(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read",)})
    assert await refusal(executor, "jira_get_issue", {"issue": "ENG-9"}) == "POLICY_DENIED"
    assert not jira.reads("/comment")


@pytest.mark.django_db(transaction=True)
async def test_issues_show_their_project_only_and_hide_atlassian_links(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read",)})
    outcome = await executor.invoke("jira_get_issue", {"issue": "ENG-1"})
    assert SECRET not in json.dumps(outcome.result)
    issue = _items(outcome)[0]
    assert (
        issue["description"] == "See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link]"
    )
    assert [c["text"] for c in issue["comments"]] == ["comment 0", "comment 1", "comment 2"]
    assert issue["comments_not_shown"] == 0
    assert issue["related"] == [
        {
            "relation": "subtask",
            "key": "ENG-2",
            "summary": "Write tests",
            "status": {"name": "To Do", "category": "To Do"},
        }
    ]
    assert (issue["related_elsewhere"], issue["related_not_shown"]) == (1, 0)
    assert (issue["attachments"], issue["link"]) == (1, "https://acme.atlassian.net/browse/ENG-1")
    assert jira.reads("/comment")[0].url.params["maxResults"] == "30"
    # A parent is read for its project too.
    sub = _items(await executor.invoke("jira_get_issue", {"issue": "ENG-2"}))[0]
    assert [r["key"] for r in sub["related"]] == ["ENG-1"]


@pytest.mark.django_db(transaction=True)
async def test_an_issue_that_moves_after_authorizing_is_refused(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read", "comment", "transition")})
    moves = 0

    def move(method: str, path: str, params: dict):
        # Jira answers the lookup by key, then the issue moves to FIN.
        nonlocal moves
        if method == "GET" and path.endswith("/issue/ENG-1"):
            issue = jira.sites[ACME]["issues"]["20001"]
            response = httpx.Response(200, json=copy.deepcopy(issue))
            issue["fields"]["project"]["id"] = "10001"
            moves += 1
            return response
        return None

    jira.hook = move
    assert await refusal(executor, "jira_get_issue", {"issue": "ENG-1"}) == "ISSUE_MOVED"
    jira.sites[ACME]["issues"]["20001"]["fields"]["project"]["id"] = "10000"
    assert await refusal(executor, "jira_add_comment", {"issue": "ENG-1", "text": "hi"}) == "ISSUE_MOVED"
    jira.sites[ACME]["issues"]["20001"]["fields"]["project"]["id"] = "10000"
    # A status that matches no transition: the statuses are not named, since the issue moved.
    args = {"issue": "ENG-1", "status": "nowhere"}
    assert await refusal(executor, "jira_transition_issue", args) == "ISSUE_MOVED"
    assert moves == 3 and not jira.writes


@pytest.mark.django_db(transaction=True)
async def test_search_reads_results_again_and_shows_them_where_they_are(start, jira):
    jira.one_site()
    jira.stale = ["20002"]
    executor = await start({ENG: ("read",)})
    args = {
        "project": "eng",
        "text": 'login "OR project = FIN',
        "status_category": "to_do",
        "assigned_to_me": True,
    }
    outcome = await executor.invoke("jira_search_issues", args)
    assert [i["key"] for i in _items(outcome)] == ["ENG-2", "ENG-1"]
    assert SECRET not in json.dumps(outcome.result)
    assert jira.reads("/search/jql")[-1].url.params["jql"] == (
        'project = 10000 AND summary ~ "login OR project FIN" AND statusCategory = 2 AND '
        "assignee = currentUser() ORDER BY updated DESC"
    )
    assert (
        await refusal(executor, "jira_search_issues", {"project": "ENG", "text": "?!"}) == "INVALID_ARGUMENTS"
    )
    assert await refusal(executor, "jira_search_issues", {"project": "FIN"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_search_pages_are_run_bound(start, jira):
    jira.one_site()
    jira.page_size = 1
    executor = await start({"*": ("read",)})
    first = await executor.invoke("jira_search_issues", {"project": "ENG", "limit": 1})
    assert [i["key"] for i in _items(first)] == ["ENG-2"]
    args = {"project": "ENG", "limit": 1, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("jira_search_issues", args)
    assert [i["key"] for i in _items(second)] == ["ENG-1"] and "next_cursor" not in second.result
    assert jira.reads("/search/jql")[-1].url.params["nextPageToken"] == f"{TOKEN}1"
    other = {"project": "FIN", "limit": 1, "cursor": first.result["next_cursor"]}
    assert await refusal(executor, "jira_search_issues", other) == "INVALID_CURSOR"


@pytest.mark.django_db(transaction=True)
async def test_project_listings_stop_at_a_cap(start, jira, monkeypatch):
    from connectors.jira import reads

    jira.page_size = 1
    monkeypatch.setattr(reads, "MAX_PROJECT_PAGES", 1)
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("jira_list_projects", {"site_id": ACME})
    assert [p["key"] for p in _items(outcome)] == ["ENG"] and outcome.result["incomplete"] is True


# Writing


@pytest.mark.django_db(transaction=True)
async def test_comments_are_plain_text_without_links_to_atlassian(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read", "comment")})
    outcome = await executor.invoke(
        "jira_add_comment", {"issue": "ENG-1", "text": "Done.\n\n**not bold**\nnext"}
    )
    assert _items(outcome) == [
        {
            "written": True,
            "id": "30009",
            "issue_id": "20001",
            "issue_key": "ENG-1",
            "created": "2026-10-03T09:00:00.000+0000",
            "link": "https://acme.atlassian.net/browse/ENG-1",
        }
    ]
    assert jira.writes == [
        (
            "issue/20001/comment",
            {
                "body": _doc(
                    _paragraph(_text("Done.")),
                    _paragraph(_text("**not bold**"), {"type": "hardBreak"}, _text("next")),
                )
            },
        )
    ]
    for text in (
        "see https://acme.atlassian.net/browse/FIN-1",
        "see https%3A%2F%2Facme%2Eatlassian%2Enet",
        "ACME.ATLASSIAN.NET/x",
        "bell \x07",
    ):
        assert (
            await refusal(executor, "jira_add_comment", {"issue": "ENG-1", "text": text})
            == "INVALID_ARGUMENTS"
        )
    assert len(jira.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_writes_need_read_and_their_consent(start, jira):
    jira.one_site()
    await start({})
    await ceiling("jira", "project", ENG, Grant.Effect.DENY, ("read",))
    executor = await start({ACME: ("read", "comment", "create", "transition")})
    assert await refusal(executor, "jira_add_comment", {"issue": "ENG-1", "text": "x"}) == "POLICY_DENIED"
    args = {"project": "ENG", "issue_type": "Task", "summary": "x"}
    assert await refusal(executor, "jira_create_issue", args) == "POLICY_DENIED"
    # Without write:jira-work only the reads are offered.
    executor = await start({ACME: ("read", "comment")}, scopes=["read:jira-work", "read:me"])
    assert {t for t in executor.context.tools if t.startswith("jira_")} == {
        "jira_list_projects",
        "jira_search_issues",
        "jira_get_issue",
    }
    assert not jira.writes


@pytest.mark.django_db(transaction=True)
async def test_issues_are_created_with_a_named_type_and_shown_where_they_land(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read", "create")})
    args = {"project": "ENG", "issue_type": "bug", "summary": "Crash", "description": "Steps"}
    outcome = await executor.invoke("jira_create_issue", args)
    assert _items(outcome) == [
        {
            "written": True,
            "id": "20009",
            "key": "ENG-9",
            "site_id": ACME,
            "project_id": "10000",
            "link": "https://acme.atlassian.net/browse/ENG-9",
        }
    ]
    assert jira.writes == [
        (
            "issue",
            {
                "fields": {
                    "project": {"id": "10000"},
                    "issuetype": {"id": "2"},
                    "summary": "Crash",
                    "description": _doc(_paragraph(_text("Steps"))),
                }
            },
        )
    ]
    for issue_type in ("Sub-task", "Epic"):
        attempt = args | {"issue_type": issue_type}
        assert await refusal(executor, "jira_create_issue", attempt) == "INVALID_ARGUMENTS"
    for summary in ("a\nb", "see acme.atlassian.net/browse/FIN-1"):
        assert (
            await refusal(executor, "jira_create_issue", args | {"summary": summary}) == "INVALID_ARGUMENTS"
        )
    assert len(jira.writes) == 1

    # Automation moves the new issue at once: the result is in FIN, which the agent may not read.
    def moved(method: str, path: str, params: dict):
        if method == "GET" and path.endswith("/issue/20009"):
            return httpx.Response(200, json=_issue("20009", "FIN-9", "10001", SECRET))
        return None

    jira.hook = moved
    outcome = await executor.invoke("jira_create_issue", args | {"summary": "Again"})
    assert _items(outcome) == [] and SECRET not in json.dumps(outcome.result)
    assert len(jira.writes) == 2


@pytest.mark.django_db(transaction=True)
async def test_a_created_issue_that_cannot_be_read_back_counts_without_a_result(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read", "create")})

    def lost(method: str, path: str, params: dict):
        if method == "GET" and path.endswith("/issue/20009"):
            return httpx.Response(404, json={})
        return None

    jira.hook = lost
    args = {"project": "ENG", "issue_type": "Task", "summary": "Crash"}
    outcome = await executor.invoke("jira_create_issue", args)
    assert outcome.result["outcome"] == "applied_without_result" and _items(outcome) == []
    assert len(jira.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_transitions_are_picked_by_status_or_name(start, jira):
    jira.one_site()
    executor = await start({ENG: ("read", "transition")})
    outcome = await executor.invoke("jira_transition_issue", {"issue": "ENG-1", "status": "in progress"})
    assert _items(outcome)[0]["status"] == "In Progress"
    # Two transitions lead to Done; one is named Finish.
    args = {"issue": "ENG-1", "status": "Done"}
    assert await refusal(executor, "jira_transition_issue", args) == "INVALID_ARGUMENTS"
    outcome = await executor.invoke("jira_transition_issue", {"issue": "ENG-1", "status": "finish"})
    assert _items(outcome)[0]["status"] == "Done"
    assert jira.writes == [
        ("issue/20001/transitions", {"transition": {"id": "11"}}),
        ("issue/20001/transitions", {"transition": {"id": "21"}}),
    ]
    assert (
        await refusal(executor, "jira_transition_issue", {"issue": "FIN-1", "status": "Done"})
        == "POLICY_DENIED"
    )


# Atlassian Document Format


def test_adf_hides_links_to_atlassian_in_any_spelling():
    hosts = ["acme.example.com"]
    nodes = _doc(
        _paragraph(
            _text(SECRET, "https%3A%2F%2Facme%2Eatlassian%2Enet/browse/FIN-1"),
            _text(" "),
            _text(SECRET, "https://acme.example.com/browse/FIN-1"),
            _text(" "),
            _text(SECRET, "/browse/FIN-1"),
            _text(" "),
            _text(SECRET, "//evil.example/x"),
            _text(" "),
            # One link split across text nodes is one link.
            _text("SECRET ", "https://acme.atlassian.net/x"),
            _text("merger", "https://acme.atlassian.net/x"),
            _text(" "),
            {
                "type": "text",
                "text": SECRET,
                "marks": [{"type": "link", "attrs": {"href": "https://ok.example"}}] * 2,
            },
            _text(" "),
            _text("plain https://acme.atlassian.net/browse/FIN-1 and acme.example.com/x"),
        ),
        {"type": "blockCard", "attrs": {"url": "https://jira.com/x"}},
        {"type": "blockCard", "attrs": {"url": "https://example.org/page"}},
        {"type": "extension", "attrs": {"text": SECRET}},
        {"type": "somethingNew", "content": [_text(SECRET)]},
    )
    text = adf.read(nodes, hosts)
    assert SECRET not in text and "merger" not in text
    assert text == (
        "[Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] [Atlassian link] "
        "plain [Atlassian link] and [Atlassian link]\n"
        "[Atlassian link]https://example.org/page[unsupported content][unsupported content]"
    )


def test_adf_reads_structure_and_stops_at_its_limits(monkeypatch):
    nodes = _doc(
        {"type": "heading", "content": [_text("Title")]},
        {
            "type": "bulletList",
            "content": [{"type": "listItem", "content": [_paragraph(_text("one"))]}],
        },
        {
            "type": "taskList",
            "content": [{"type": "taskItem", "attrs": {"state": "DONE"}, "content": [_text("done")]}],
        },
        _paragraph(
            {"type": "mention", "attrs": {"text": "@Grace"}},
            _text(" on "),
            {"type": "date", "attrs": {"timestamp": "1759276800000"}},
            _text(" "),
            {"type": "status", "attrs": {"text": "BLOCKED"}},
            {"type": "hardBreak"},
            {"type": "emoji", "attrs": {"shortName": ":smile:", "text": "😄"}},
        ),
        {"type": "mediaSingle", "content": [{"type": "media", "attrs": {"id": SECRET}}]},
    )
    assert adf.read(nodes) == "Title\n- one\n- [x] done\n@Grace on 2025-10-01 [BLOCKED]\n😄\n[attachment]"
    deep: dict = _text("bottom")
    for _ in range(60):
        deep = {"type": "blockquote", "content": [deep]}
    assert adf.read(_doc(deep)) == "[more content not shown]"
    assert adf.read("not a document") == ""


def test_written_adf_is_literal_text():
    assert adf.written("a\r\nb\n\n\nc") == _doc(
        _paragraph(_text("a"), {"type": "hardBreak"}, _text("b")), _paragraph(_text("c"))
    )
    assert adf.check_written("see https://example.com") == "see https://example.com"
    for text in ("x trello.com/b", "atl.so/x", "BITBUCKET.ORG"):
        with pytest.raises(ValueError):
            adf.check_written(text)


@pytest.mark.django_db(transaction=True)
async def test_written_text_may_not_name_a_site_on_its_own_domain(start, jira):
    jira.one_site()
    jira.resources[0]["url"] = "https://jira.acme.example"
    executor = await start({ENG: ("read", "comment", "create")})
    for text in ("see https://JIRA.acme.example/browse/FIN-1", "jira%2Eacme%2Eexample/x"):
        assert (
            await refusal(executor, "jira_add_comment", {"issue": "ENG-1", "text": text})
            == "INVALID_ARGUMENTS"
        )
    args = {"project": "ENG", "issue_type": "Task", "summary": "x", "description": "jira.acme.example"}
    assert await refusal(executor, "jira_create_issue", args) == "INVALID_ARGUMENTS"
    assert not jira.writes


async def test_issue_types_page_by_what_jira_returned(jira):
    jira.types = [{"id": str(n), "name": f"Type {n}", "subtask": False} for n in range(1, 8)]
    jira.page_size = 3
    types = await jira.client().issue_types(ACME, "10000")
    assert [t.id for t in types] == [str(n) for n in range(1, 8)]
    assert [r.url.params["startAt"] for r in jira.reads("/issuetypes")] == ["0", "3", "6"]


def test_linked_text_counts_toward_the_limits(monkeypatch):
    monkeypatch.setattr(adf, "MAX_NODES", 10)
    links = [_text(f"w{n} ", f"https://example.com/{n}") for n in range(50)]
    text = adf.read(_doc(_paragraph(*links)))
    assert text.endswith("[more content not shown]") and "w20" not in text and "/20" not in text
    monkeypatch.setattr(adf, "MAX_NODES", 20_000)
    monkeypatch.setattr(adf, "MAX_DEPTH", 1)
    assert adf.read(_doc(_paragraph(*links[:1]))) == "[more content not shown]"


def test_an_expired_atlassian_refresh_token_needs_reconnecting(scoped, user, token_endpoint):
    _, responses = token_endpoint
    connection = Connection(provider="jira", owner=user, label="Ada", external_account_id=ACCOUNT_ID)
    credentials = {"kind": "oauth2", "access_token": "old", "refresh_token": "r1", "scopes": SCOPES}
    connection.set_credentials({**credentials, "expires_at": int(time.time())})
    connection.save()
    responses.append(
        httpx.Response(403, json={"error": "invalid_grant", "error_description": "Unknown token."})
    )
    with pytest.raises(OperationError) as caught:
        connection_credentials.access_secret(connection.id)
    assert caught.value.code == "CONNECTION_UNAUTHORIZED"
