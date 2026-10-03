"""Sentry connector against an in-memory Sentry API, and runs through the executor."""

import json

import httpx
import pytest
from connector_runs import ceiling, refusal

from connectors import registry
from connectors.base import OperationError
from connectors.sentry.client import API_URL, REGIONS, SentryClient, next_cursor
from connectors.sentry.connector import SentryConnector
from permissions.models import Grant

SECRET = "SECRET payroll"
WEB = "11"
PAYROLL = "12"
SCOPES = ["org:read", "project:read", "event:read"]
LEAKS = ("hunter2", "sessionid=", "token=abc", "pw@", "ada@example.com", "crumb text", "10.0.0.7")


def _issue(issue_id: str, project: dict, title: str, **fields) -> dict:
    return {
        "id": issue_id,
        "shortId": f"{project['slug'].upper()}-{issue_id}",
        "title": title,
        "culprit": "app.views in checkout",
        "level": "error",
        "status": "unresolved",
        "substatus": "ongoing",
        "priority": "high",
        "count": "150",
        "userCount": 12,
        "firstSeen": "2026-09-01T10:00:00Z",
        "lastSeen": "2026-10-02T10:00:00Z",
        "platform": "python",
        "permalink": f"https://acme.sentry.io/issues/{issue_id}/",
        "project": {"id": project["id"], "slug": project["slug"], "name": project["name"]},
        "assignedTo": {"type": "user", "id": "5", "name": "Grace", "email": "grace@example.com"},
        "activity": [{"type": "note", "data": {"text": "see PAYROLL-202"}}],
        "seenBy": [{"email": "seen@example.com"}],
    } | fields


def _frame(n: int) -> dict:
    return {
        "filename": f"app/f{n}.py",
        "absPath": f"/srv/app/f{n}.py",
        "function": f"fn{n}",
        "module": f"app.f{n}",
        "lineNo": 20,
        "colNo": None,
        "inApp": n % 2 == 0,
        "context": [[line, f"line {line}"] for line in range(15, 26)],
        "vars": {"password": "hunter2"},
    }


def _event(issue: dict, **fields) -> dict:
    return {
        "eventID": "9fac2ceed9344f2bbfdd1fdacb0ed9b1",
        "groupID": issue["id"],
        "projectID": issue["project"]["id"],
        "title": issue["title"],
        "message": "",
        "platform": "python",
        "culprit": "app.views in checkout",
        "location": "app/f44.py",
        "dateCreated": "2026-10-02T10:00:00Z",
        "release": {"version": "web@1.4.2"},
        "user": {"email": "ada@example.com", "ip_address": "10.0.0.7"},
        "tags": [
            {"key": "environment", "value": "production"},
            {"key": "level", "value": "error"},
            {"key": "user", "value": "email:ada@example.com"},
            {"key": "url", "value": "https://shop.example.com/cart?token=abc"},
            {"key": "runtime", "value": "CPython 3.14"},
        ],
        "contexts": {
            "runtime": {"name": "CPython", "version": "3.14.0"},
            "os": {"name": "Linux", "version": "6.1"},
            "device": {"model": "x"},
        },
        "sdk": {"name": "sentry.python", "version": "2.40.0"},
        "entries": [
            {
                "type": "exception",
                "data": {
                    "values": [
                        {"type": "KeyError", "value": "'cart'", "stacktrace": {"frames": [_frame(0)]}},
                        {
                            "type": "ValueError",
                            "value": "bad total",
                            "module": None,
                            "mechanism": {"type": "django", "handled": False},
                            "stacktrace": {"frames": [_frame(n) for n in range(45)]},
                        },
                    ]
                },
            },
            {"type": "breadcrumbs", "data": {"values": [{"message": "crumb text"}]}},
            {
                "type": "request",
                "data": {
                    "method": "POST",
                    "url": "https://user:pw@shop.example.com:8443/cart?token=abc#top",
                    "headers": [["Cookie", "sessionid=1"]],
                    "data": {"card": "4242"},
                },
            },
        ],
    } | fields


class FakeSentry:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.user = {"id": "42", "name": "Ada Lovelace", "email": "ada@example.com"}
        self.organisations = [
            {"id": "7", "slug": "acme", "name": "Acme", "links": {"regionUrl": "https://de.sentry.io"}}
        ]
        web = {"id": WEB, "slug": "web", "name": "Web", "platform": "python"}
        payroll = {"id": PAYROLL, "slug": "payroll", "name": SECRET, "platform": "go"}
        self.projects = [web, payroll]
        self.issues = [
            _issue("101", web, "ValueError: bad total"),
            _issue("102", web, "KeyError: cart", status="resolved"),
            _issue("202", payroll, f"{SECRET} failed"),
        ]
        self.events: dict[str, dict] = {i["id"]: _event(i) for i in self.issues}
        self.hook = None
        # An explicit event id the fake answers with whatever event it has.
        self.answer = "b" * 32

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["authorization"] == "Bearer token"
        assert request.url.host in {"sentry.io", "de.sentry.io"}
        path, params = request.url.path, request.url.params
        if self.hook is not None and (response := self.hook(request)) is not None:
            return response
        if request.url.host == "sentry.io" and path == "/api/0/auth/":
            return httpx.Response(200, json=self.user)
        if request.url.host == "sentry.io" and path == "/api/0/organizations/":
            return httpx.Response(200, json=self.organisations)
        region = self.organisations[0]["links"]["regionUrl"]
        assert f"https://{request.url.host}" == (region if region in REGIONS else API_URL)
        parts = path.removeprefix("/api/0/").strip("/").split("/")
        match parts:
            case ["organizations", "acme", "projects"]:
                found = [p for p in self.projects if params.get("query", "") in p["slug"]]
                return self._page(found, params, int(params["per_page"]))
            case ["projects", "acme", name]:
                found = [p for p in self.projects if name in (p["id"], p["slug"])]
                return httpx.Response(200, json=found[0]) if found else httpx.Response(404, json={})
            case ["organizations", "acme", "issues"]:
                found = [i for i in self.issues if i["project"]["id"] == params["project"]]
                return self._page(found, params, int(params["limit"]))
            case ["organizations", "acme", "shortids", short_id]:
                found = [i for i in self.issues if i["shortId"] == short_id]
                if not found:
                    return httpx.Response(404, json={})
                return httpx.Response(
                    200, json={"organizationSlug": "acme", "groupId": found[0]["id"], "group": {"id": "0"}}
                )
            case ["organizations", "acme", "issues", issue_id]:
                found = [i for i in self.issues if i["id"] == issue_id]
                return httpx.Response(200, json=found[0]) if found else httpx.Response(404, json={})
            case ["organizations", "acme", "issues", issue_id, "events", name]:
                event = self.events.get(issue_id)
                if event is None or name not in {
                    "latest",
                    "oldest",
                    "recommended",
                    event["eventID"],
                    self.answer,
                }:
                    return httpx.Response(404, json={})
                return httpx.Response(200, json=event)
        raise AssertionError(path)

    @staticmethod
    def _page(items: list[dict], params, size: int) -> httpx.Response:
        start = int(params.get("cursor", "0:0:0").split(":")[1])
        link = (
            f'<https://elsewhere.example.com/?cursor=0:{start + size}:0>; rel="next"; results="true"; '
            f'cursor="0:{start + size}:0"'
            if start + size < len(items)
            else '<https://de.sentry.io/>; rel="next"; results="false"; cursor="0:99:0"'
        )
        return httpx.Response(200, json=items[start : start + size], headers={"Link": link})

    def api(self, kind: str = "") -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.startswith(f"/api/0/organizations/acme/{kind}")]

    def client(self) -> SentryClient:
        return SentryClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def sentry() -> FakeSentry:
    return FakeSentry()


@pytest.fixture
def start(connector_run, sentry, monkeypatch):
    """Starts a run with the user's Sentry connection, holding `grants` ({project: actions})."""
    monkeypatch.setattr(SentryConnector, "client", lambda self, token: sentry.client())

    def start_(grants: dict[str, tuple[str, ...]]):
        projects = {("project", project): actions for project, actions in grants.items()}
        return connector_run(
            "sentry", projects, scopes=SCOPES, label="Ada Lovelace · Acme", external_account_id="7:42"
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


# Connecting and discovery


async def test_the_account_is_the_user_in_the_organisation(sentry):
    connector = SentryConnector()
    account = await connector.account(sentry.client())
    assert (account.id, account.label) == ("7:42", "Ada Lovelace (ada@example.com) · Acme")
    sentry.user = {"id": "42"}
    assert (await connector.account(sentry.client())).label == "Acme"
    sentry.user = {"id": "042"}
    with pytest.raises(OperationError) as caught:
        await connector.account(sentry.client())
    assert caught.value.code == "PROVIDER_FAILED"
    sentry.user = {"id": "42"}
    sentry.organisations = sentry.organisations * 2
    with pytest.raises(OperationError) as caught:
        await connector.account(sentry.client())
    assert caught.value.code == "UNSUPPORTED_ACCOUNT"
    with pytest.raises(OperationError) as caught:
        await sentry.client().projects()
    assert caught.value.code == "PROVIDER_FAILED"


async def test_calls_go_to_the_organisations_region_or_sentry_io(sentry):
    client = sentry.client()
    await client.projects()
    await client.project(WEB)
    assert [r.url.host for r in sentry.requests] == ["sentry.io", "de.sentry.io", "de.sentry.io"]
    # A region Minerva does not know is not trusted with the token.
    for region in ("https://evil.example.com", "https://de.sentry.io.evil.com", "http://de.sentry.io", ""):
        sentry.organisations[0]["links"]["regionUrl"] = region
        sentry.requests.clear()
        await sentry.client().projects()
        assert {r.url.host for r in sentry.requests} == {"sentry.io"}


async def test_projects_are_discovered_and_described(sentry):
    connector = SentryConnector()
    client = sentry.client()
    page = await connector.discover(client, "project", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [(WEB, "Web (web)"), (PAYROLL, f"{SECRET} (payroll)")]
    assert page.next_cursor is None
    page = await connector.discover(client, "project", query="pay", cursor=None)
    assert [i.id for i in page.items] == [PAYROLL]
    with pytest.raises(OperationError) as caught:
        await connector.discover(client, "project", query=None, cursor="0:0:0 ")
    assert caught.value.code == "INVALID_CURSOR"
    described = await connector.describe(client, "project", [WEB, WEB, "99", "web", "x/1"])
    assert described == {WEB: "Web (web)"}
    # The organisation is read once per client.
    assert len([r for r in sentry.requests if r.url.path == "/api/0/organizations/"]) == 1


def test_only_the_cursor_is_taken_from_a_link():
    def link(value: str) -> httpx.Response:
        return httpx.Response(200, headers={"Link": value})

    previous = '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1"'
    following = '<https://elsewhere.example.com/x>; rel="next"; results="true"; cursor="1727:100:0"'
    assert next_cursor(link(f"{previous}, {following}")) == "1727:100:0"
    assert next_cursor(link(following.replace('"true"', '"false"'))) is None
    assert next_cursor(httpx.Response(200)) is None
    with pytest.raises(OperationError) as caught:
        next_cursor(link(following.replace("1727:100:0", "x y")))
    assert caught.value.code == "PROVIDER_LIMIT"


def test_reading_needs_the_read_scopes():
    connector = registry.get("sentry")
    assert connector.auth.scopes == ("org:read", "project:read", "event:read")
    assert connector.auth.client_auth == "post" and connector.auth.pkce
    assert all(not op.mutates for op in connector.operations)


# Projects and issues


@pytest.mark.django_db(transaction=True)
async def test_only_granted_projects_are_listed_or_read(start, sentry):
    executor = await start({WEB: ("read",)})
    outcome = await executor.invoke("sentry_list_projects", {})
    assert _items(outcome) == [{"id": WEB, "slug": "web", "name": "Web", "platform": "python"}]
    assert SECRET not in json.dumps(outcome.result)

    sentry.requests.clear()
    for project in (PAYROLL, "payroll", "missing", "99"):
        assert await refusal(executor, "sentry_search_issues", {"project": project}) == "POLICY_DENIED"
    for issue in ("202", "PAYROLL-202", "999", "NOPE-1"):
        assert await refusal(executor, "sentry_get_issue", {"issue": issue}) == "POLICY_DENIED"
        assert await refusal(executor, "sentry_get_issue_event", {"issue": issue}) == "POLICY_DENIED"
    assert not [r for r in sentry.requests if r.url.path == "/api/0/organizations/acme/issues/"]
    assert not [r for r in sentry.requests if "/events/" in r.url.path]


@pytest.mark.django_db(transaction=True)
async def test_all_projects_respects_the_ceiling(start, sentry):
    await start({})
    await ceiling("sentry", "project", PAYROLL, Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("sentry_list_projects", {})
    assert [p["id"] for p in _items(outcome)] == [WEB]
    assert await refusal(executor, "sentry_get_issue", {"issue": "202"}) == "POLICY_DENIED"
    outcome = await executor.invoke("sentry_get_issue", {"issue": "web-101"})
    assert _items(outcome)[0]["id"] == "101"


@pytest.mark.django_db(transaction=True)
async def test_issues_are_searched_in_one_project_with_a_query_built_from_fields(start, sentry):
    executor = await start({WEB: ("read",)})
    outcome = await executor.invoke("sentry_search_issues", {"project": "WEB"})
    params = sentry.api("issues/")[-1].url.params
    assert sorted(params.multi_items()) == sorted(
        [
            ("project", WEB),
            ("query", "is:unresolved"),
            ("statsPeriod", "14d"),
            ("sort", "date"),
            ("limit", "10"),
            ("collapse", "stats"),
            ("collapse", "unhandled"),
        ]
    )
    assert _items(outcome)[0] == {
        "id": "101",
        "short_id": "WEB-101",
        "title": "ValueError: bad total",
        "culprit": "app.views in checkout",
        "level": "error",
        "status": "unresolved",
        "substatus": "ongoing",
        "priority": "high",
        "events": 150,
        "users": 12,
        "first_seen": "2026-09-01T10:00:00Z",
        "last_seen": "2026-10-02T10:00:00Z",
        "platform": "python",
        "project": {"id": WEB, "slug": "web"},
        "assignee": {"type": "user", "name": "Grace"},
        "link": "https://acme.sentry.io/issues/101/",
    }

    args = {
        "project": WEB,
        "text": "bad total",
        "status": "any",
        "level": "fatal",
        "environment": "production",
        "period": "90d",
        "sort": "users",
        "limit": 25,
    }
    await executor.invoke("sentry_search_issues", args)
    params = sentry.api("issues/")[-1].url.params
    assert params["query"] == 'level:fatal "bad total"'
    assert (params["environment"], params["statsPeriod"], params["sort"]) == ("production", "90d", "user")
    await executor.invoke("sentry_search_issues", {"project": WEB, "status": "any"})
    assert sentry.api("issues/")[-1].url.params["query"] == ""
    assert "shortIdLookup" not in str(sentry.api("issues/")[-1].url)

    for bad in (
        {"text": 'x" project:payroll "'},
        {"text": "x\\"},
        {"text": "a\nb"},
        {"environment": "prod uction"},
        {"environment": "a/b"},
        {"status": "ignored"},
        {"period": "1y"},
        {"limit": 26},
        {"query": "is:unresolved"},
        {"project": "../payroll"},
    ):
        assert await refusal(executor, "sentry_search_issues", {"project": WEB} | bad) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_search_pages_and_refuses_issues_from_another_project(start, sentry):
    executor = await start({WEB: ("read",)})
    first = await executor.invoke("sentry_search_issues", {"project": WEB, "limit": 1})
    assert [i["id"] for i in _items(first)] == ["101"]
    args = {"project": WEB, "limit": 1, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("sentry_search_issues", args)
    assert [i["id"] for i in _items(second)] == ["102"] and "next_cursor" not in second.result
    assert sentry.api("issues/")[-1].url.params["cursor"] == "0:1:0"
    assert await refusal(executor, "sentry_search_issues", args | {"limit": 2}) == "INVALID_CURSOR"

    def rejected(request: httpx.Request) -> httpx.Response | None:
        if request.url.path.endswith("/issues/"):
            return httpx.Response(400, json={"detail": "Invalid cursor parameter."})
        return None

    sentry.hook = rejected
    assert await refusal(executor, "sentry_search_issues", args) == "INVALID_CURSOR"
    assert await refusal(executor, "sentry_search_issues", {"project": WEB}) == "INVALID_ARGUMENTS"

    # An issue of another project in the answer means it cannot be trusted.
    def foreign(request: httpx.Request) -> httpx.Response | None:
        if request.url.path.endswith("/issues/"):
            return httpx.Response(200, json=[sentry.issues[0], sentry.issues[2]])
        return None

    sentry.hook = foreign
    assert await refusal(executor, "sentry_search_issues", {"project": WEB}) == "PROVIDER_FAILED"


@pytest.mark.django_db(transaction=True)
async def test_an_issue_is_read_by_id_or_short_id(start, sentry):
    executor = await start({WEB: ("read",)})
    by_id = await executor.invoke("sentry_get_issue", {"issue": "101"})
    by_short = await executor.invoke("sentry_get_issue", {"issue": "web-101"})
    assert _items(by_id) == _items(by_short)
    issue = _items(by_id)[0]
    assert issue["comments"] is None and issue["tags"] == []
    assert "see PAYROLL" not in json.dumps(by_id.result) and "grace@" not in json.dumps(by_id.result)

    sentry.issues[0] |= {
        "firstRelease": {"version": "web@1.0"},
        "lastRelease": None,
        "tags": [
            {"key": "browser", "name": "Browser", "totalValues": 150},
            {"key": "customer:ada@example.com", "name": "Customer", "totalValues": 1},
        ],
        "numComments": 2,
        "userReportCount": 1,
        "permalink": "https://evil.example.com/issues/101/",
    }
    issue = _items(await executor.invoke("sentry_get_issue", {"issue": "101"}))[0]
    assert (issue["first_release"], issue["last_release"], issue["comments"], issue["user_reports"]) == (
        "web@1.0",
        None,
        2,
        1,
    )
    assert issue["tags"] == [{"key": "browser", "name": "Browser", "events": 150}]
    assert issue["link"] is None

    for bad in ("WEB_101", "web 101", "0101", "-1", ""):
        assert await refusal(executor, "sentry_get_issue", {"issue": bad}) == "INVALID_ARGUMENTS"

    # An issue too large to read is refused like one the account cannot see.
    sentry.issues[0]["title"] = "x" * (5 * 1024 * 1024)
    assert await refusal(executor, "sentry_get_issue", {"issue": "101"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_an_event_shows_exceptions_and_leaves_out_what_identifies_people(start, sentry):
    executor = await start({WEB: ("read",)})
    outcome = await executor.invoke("sentry_get_issue_event", {"issue": "WEB-101"})
    assert sentry.requests[-1].url.path == "/api/0/organizations/acme/issues/101/events/latest/"
    event = _items(outcome)[0]
    text = json.dumps(outcome.result)
    for leak in LEAKS:
        assert leak not in text, leak
    assert {k: event[k] for k in ("issue", "id", "release", "environment", "request", "contexts", "sdk")} == {
        "issue": "101",
        "id": "9fac2ceed9344f2bbfdd1fdacb0ed9b1",
        "release": "web@1.4.2",
        "environment": "production",
        "request": {"method": "POST", "url": "https://shop.example.com:8443/cart"},
        "contexts": {
            "runtime": {"name": "CPython", "version": "3.14.0"},
            "os": {"name": "Linux", "version": "6.1"},
        },
        "sdk": {"name": "sentry.python", "version": "2.40.0"},
    }
    assert event["tags"] == {"environment": "production", "level": "error", "runtime": "CPython 3.14"}
    cause, raised = event["exceptions"]
    assert (cause["type"], raised["type"], raised["value"]) == ("KeyError", "ValueError", "bad total")
    assert raised["mechanism"] == {"type": "django", "handled": False}
    assert (raised["frame_count"], raised["frames_truncated"], len(raised["frames"])) == (45, True, 40)
    assert raised["frames"][0]["function"] == "fn5" and raised["frames"][-1] == {
        "file": "app/f44.py",
        "function": "fn44",
        "module": "app.f44",
        "line": 20,
        "column": None,
        "in_app": True,
        "source": [{"line": n, "code": f"line {n}", "code_truncated": False} for n in range(17, 24)],
    }

    for name in ("oldest", "recommended", "9FAC2CEE-D934-4F2B-BFDD-1FDACB0ED9B1"):
        await executor.invoke("sentry_get_issue_event", {"issue": "101", "event": name})
    assert sentry.requests[-1].url.path.endswith("/events/9fac2ceed9344f2bbfdd1fdacb0ed9b1/")
    # An event other than the one asked for is not shown.
    assert (
        await refusal(executor, "sentry_get_issue_event", {"issue": "101", "event": "a" * 32}) == "NOT_FOUND"
    )
    sentry.answer = "a" * 32
    assert await refusal(executor, "sentry_get_issue_event", {"issue": "101", "event": "a" * 32}) == (
        "PROVIDER_FAILED"
    )
    for bad in ("newest", "9fac2cee", "../202"):
        assert await refusal(executor, "sentry_get_issue_event", {"issue": "101", "event": bad}) == (
            "INVALID_ARGUMENTS"
        )

    # An event of another issue or project is not shown.
    for odd in ({"groupID": "202"}, {"projectID": PAYROLL}, {"eventID": "../x"}):
        sentry.events["101"] = _event(sentry.issues[0], **odd)
        assert await refusal(executor, "sentry_get_issue_event", {"issue": "101"}) == "PROVIDER_FAILED"
    del sentry.events["101"]
    assert await refusal(executor, "sentry_get_issue_event", {"issue": "101"}) == "NOT_FOUND"


@pytest.mark.django_db(transaction=True)
async def test_an_event_of_odd_shape_is_shown_in_what_parts_fit(start, sentry):
    executor = await start({WEB: ("read",)})
    sentry.events["101"] = _event(
        sentry.issues[0],
        entries=[{"type": "exception", "data": {"values": [{"type": 3, "stacktrace": "x"}, "y"]}}, "z"],
        tags=[{"key": ["environment"], "value": "x"}, "y"],
        contexts=[],
        sdk=None,
        release=None,
        message="m" * 6000,
    )
    event = _items(await executor.invoke("sentry_get_issue_event", {"issue": "101"}))[0]
    assert event["exceptions"] == [
        {
            "type": None,
            "value": None,
            "value_truncated": False,
            "module": None,
            "mechanism": None,
            "frames": [],
            "frame_count": 0,
            "frames_truncated": False,
        }
    ]
    assert (event["tags"], event["contexts"], event["release"], event["request"]) == ({}, {}, None, None)
    assert event["message_truncated"] and len(event["message"]) == 5000

    frames = [
        {"lineNo": 20, "context": 42},
        {"lineNo": 20, "context": [[20, "x"]] * 1000 + [[19, "w"], ["21", "y"], [22, 5]]},
    ]
    exception = {
        "type": "E",
        "mechanism": {"type": "generic", "handled": {"vars": {"password": "hunter2"}}},
        "stacktrace": {"frames": frames},
    }
    request = {"method": "GET", "url": "https://u:pw@[2001:db8::1]:8443/cart?token=abc"}
    sentry.events["101"] = _event(
        sentry.issues[0],
        entries=[
            {"type": "exception", "data": {"values": [exception]}},
            {"type": "request", "data": request},
        ],
    )
    event = _items(await executor.invoke("sentry_get_issue_event", {"issue": "101"}))[0]
    shown = event["exceptions"][0]
    assert shown["mechanism"] == {"type": "generic", "handled": None}
    assert [frame["source"] for frame in shown["frames"]] == [
        [],
        [
            {"line": 19, "code": "w", "code_truncated": False},
            {"line": 20, "code": "x", "code_truncated": False},
            {"line": 21, "code": "y", "code_truncated": False},
        ],
    ]
    assert event["request"]["url"] == "https://[2001:db8::1]:8443/cart"


async def test_ids_with_a_final_newline_are_refused(sentry):
    sentry.projects[0]["id"] = WEB + "\n"
    with pytest.raises(OperationError) as caught:
        await sentry.client().projects()
    assert caught.value.code == "PROVIDER_FAILED"
