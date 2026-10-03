"""Confluence connector against an in-memory Atlassian API, and runs through the executor."""

import copy
import json
import re
from urllib.parse import urlencode

import httpx
import pytest
from connector_runs import ceiling, refusal

from connections import oauth as connection_oauth
from connections.oauth import ClientCredentials
from connectors import registry
from connectors.base import OperationError
from connectors.confluence import client as client_module
from connectors.confluence.client import ConfluenceClient, Listing
from connectors.confluence.connector import ConfluenceConnector
from permissions.models import Grant

SECRET = "SECRET merger"
ACCOUNT_ID = "5b10ac8d82e05b22cc7d4ef5"
ACME = "11111111-1111-1111-1111-111111111111"
BETA = "22222222-2222-2222-2222-222222222222"
JIRA = "33333333-3333-3333-3333-333333333333"
ENG = f"{ACME}/100"
FIN = f"{ACME}/101"
OPS = f"{BETA}/100"
READ_SCOPES = [
    "read:space:confluence",
    "read:page:confluence",
    "read:comment:confluence",
    "read:content-details:confluence",
]
SCOPES = ["offline_access", "read:me", *READ_SCOPES, "write:comment:confluence", "write:page:confluence"]
# Confluence's cursors are opaque; some are not URL-safe.
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


def _body(document: dict) -> dict:
    return {"atlas_doc_format": {"representation": "atlas_doc_format", "value": json.dumps(document)}}


def _space(space_id: str, key: str, name: str, **fields) -> dict:
    return {"id": space_id, "key": key, "name": name, "type": "global", "status": "current"} | fields


def _page(page_id: str, space_id: str, title: str, **fields) -> dict:
    return {
        "id": page_id,
        "status": "current",
        "title": title,
        "spaceId": space_id,
        "parentId": None,
        "parentType": None,
        "createdAt": "2026-10-01T09:00:00.000Z",
        "version": {"number": 3, "createdAt": "2026-10-02T09:00:00.000Z"},
        "body": _body(_doc(_paragraph(_text(f"About {title}")))),
    } | fields


class FakeConfluence:
    """Atlassian's API for Confluence, served through httpx.MockTransport.

    Acme (acme.atlassian.net) has spaces ENG (100) and FIN (101); Beta (beta.atlassian.net) has OPS, whose id
    repeats ENG's. Page 500 in ENG links to page 501 in FIN and has a child 502; page 504 in ENG names 501 as
    its parent, and 505 is a draft.
    """

    def __init__(self) -> None:
        self.me = {"account_id": ACCOUNT_ID, "name": "Ada", "email": "ada@example.com"}
        self.resources = [
            {"id": BETA.upper(), "name": "Beta", "url": "https://beta.atlassian.net", "scopes": SCOPES},
            {"id": ACME, "name": "Acme", "url": "https://acme.atlassian.net", "scopes": SCOPES},
            # The same site again (Atlassian lists a site once per product), and a site without Confluence.
            {"id": ACME, "name": "Acme", "url": "https://acme.atlassian.net", "scopes": ["read:jira-work"]},
            {
                "id": JIRA,
                "name": "Tracker",
                "url": "https://tracker.atlassian.net",
                "scopes": ["read:jira-work"],
            },
        ]
        body = _doc(
            _paragraph(
                _text("See "),
                _text(SECRET, "https://acme.atlassian.net/wiki/spaces/FIN/pages/501"),
                _text(" and "),
                _text("docs", "https://example.com/docs"),
            ),
            {"type": "inlineCard", "attrs": {"url": "https://acme.atlassian.net/wiki/x/501"}},
            {"type": "extension", "attrs": {"extensionKey": "children", "text": SECRET}},
        )
        self.sites: dict[str, dict] = {
            ACME: {
                "spaces": [
                    _space("100", "ENG", "Engineering"),
                    _space("101", "FIN", SECRET),
                    _space("102", "~ada", "Ada", type="personal"),
                ],
                "pages": {
                    "500": _page("500", "100", "Runbook", body=_body(body)),
                    "501": _page("501", "101", SECRET),
                    "502": _page("502", "100", "Child", parentId="500", parentType="page"),
                    "504": _page("504", "100", "Adopted", parentId="501", parentType="page"),
                    "505": _page("505", "100", "Draft", status="draft"),
                },
                "comments": {
                    "500": [
                        {
                            "id": str(700 + n),
                            "status": "current",
                            "version": {"number": 1, "createdAt": f"2026-10-01T{n:02d}:00:00.000Z"},
                            "body": _body(_doc(_paragraph(_text(f"comment {n}")))),
                        }
                        for n in range(3)
                    ]
                },
            },
            BETA: {
                "spaces": [_space("100", "OPS", "Operations")],
                "pages": {"500": _page("500", "100", "Keys")},
                "comments": {},
            },
        }
        self.page_size: int | None = None
        # Ids search returns before the pages it names (an index that lags behind moves).
        self.stale: list[str] = []
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, dict]] = []
        self.hook = None

    @staticmethod
    def _missing() -> httpx.Response:
        return httpx.Response(404, json={"errors": [{"title": SECRET}]})

    def _listing(self, path: str, items: list, params: dict) -> dict:
        """One page of `items`, with Confluence's link to the next page."""
        size = self.page_size or int(params.get("limit", 25))
        start = 0
        if "cursor" in params:
            assert params["cursor"].startswith(TOKEN)
            start = int(params["cursor"].removeprefix(TOKEN))
        end = start + size
        listing: dict = {"results": items[start:end], "_links": {}}
        if end < len(items):
            query = {k: v for k, v in params.items() if k != "cursor"} | {"cursor": f"{TOKEN}{end}"}
            listing["_links"]["next"] = f"{path}?{urlencode(query)}"
        return listing

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
        assert parts[:2] == ["ex", "confluence"] and parts[3] == "wiki", path
        site = self.sites.get(parts[2])
        if site is None:
            return self._missing()
        if parts[4:7] == ["rest", "api", "search"]:
            return self._search(site, params)
        assert parts[4:6] == ["api", "v2"], path
        rest = parts[6:]
        if request.method == "POST":
            body = json.loads(request.content)
            self.writes.append(("/".join(rest), body))
            match rest:
                case ["footer-comments"]:
                    created = {"id": "709", "version": {"number": 1, "createdAt": "2026-10-03T09:00:00.000Z"}}
                    return httpx.Response(200, json=created)
                case ["pages"]:
                    if any(p["title"] == body["title"] for p in site["pages"].values()):
                        return httpx.Response(400, json={"errors": [{"title": SECRET}]})
                    page = _page("509", body["spaceId"], body["title"], parentId=body.get("parentId"))
                    site["pages"]["509"] = page
                    return httpx.Response(200, json=page)
            raise AssertionError(path)
        match rest:
            case ["spaces"]:
                spaces = site["spaces"]
                if "ids" in params:
                    spaces = [s for s in spaces if s["id"] in params["ids"].split(",")]
                if "keys" in params:
                    spaces = [s for s in spaces if s["key"] in params["keys"].split(",")]
                return httpx.Response(200, json=self._listing("/wiki/api/v2/spaces", spaces, params))
            case ["spaces", space_id]:
                found = next((s for s in site["spaces"] if s["id"] == space_id), None)
                return httpx.Response(200, json=found) if found else self._missing()
            case ["pages"]:
                assert params["status"] == "current"
                ids = params["id"].split(",")
                pages = [
                    {k: v for k, v in site["pages"][i].items() if k != "body"}
                    for i in sorted(ids, key=int)
                    if i in site["pages"] and site["pages"][i]["status"] == "current"
                ]
                return httpx.Response(200, json=self._listing("/wiki/api/v2/pages", pages, params))
            case ["pages", page_id]:
                found = site["pages"].get(page_id)
                if found is None:
                    return self._missing()
                if params.get("body-format") != "atlas_doc_format":
                    found = {k: v for k, v in found.items() if k != "body"}
                return httpx.Response(200, json=found)
            case ["pages", page_id, "footer-comments"]:
                assert params["sort"] == "-created-date"
                comments = list(reversed(site["comments"].get(page_id, [])))
                path = f"/wiki/api/v2/pages/{page_id}/footer-comments"
                return httpx.Response(200, json=self._listing(path, comments, params))
        raise AssertionError(path)

    def _search(self, site: dict, params: dict) -> httpx.Response:
        match = re.match(r'type = page AND space = "([^"]+)"', params["cql"])
        space = next(s for s in site["spaces"] if s["key"] == match.group(1))
        # Most recently changed first: here, the highest id.
        matching = sorted(
            (i for i, p in site["pages"].items() if p["spaceId"] == space["id"] and p["status"] == "current"),
            key=int,
            reverse=True,
        )
        results = [
            {"content": {"id": i, "type": "page", "title": SECRET}, "excerpt": SECRET} for i in matching
        ]
        results = [{"content": {"id": i, "type": "page"}} for i in self.stale] + results
        return httpx.Response(200, json=self._listing("/rest/api/search", results, params))

    def reads(self, suffix: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path.endswith(suffix)]

    def client(self) -> ConfluenceClient:
        return ConfluenceClient("token", transport=httpx.MockTransport(self.handler))

    def one_site(self) -> None:
        self.resources = [r for r in self.resources if r["id"] != BETA.upper()]


@pytest.fixture
def confluence() -> FakeConfluence:
    return FakeConfluence()


@pytest.fixture
def start(connector_run, confluence, monkeypatch):
    """Starts a run with the user's Confluence connection, holding `grants` ({site or space: actions})."""
    monkeypatch.setattr(ConfluenceConnector, "client", lambda self, token: confluence.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = SCOPES):
        spaces = {("space", resource_id): actions for resource_id, actions in grants.items()}
        return connector_run(
            "confluence", spaces, scopes=scopes, label="Ada (ada@example.com)", external_account_id=ACCOUNT_ID
        )

    return start_


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


# Connecting and discovery


async def test_the_account_and_its_confluence_sites(confluence):
    connector = ConfluenceConnector()
    client = confluence.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (ACCOUNT_ID, "Ada (ada@example.com)")
    assert [s.id for s in await client.sites()] == [ACME, BETA]
    confluence.resources = confluence.resources[2:]
    with pytest.raises(OperationError) as caught:
        await connector.account(confluence.client())
    assert caught.value.code == "UNSUPPORTED_ACCOUNT"


async def test_discovery_lists_sites_then_each_sites_spaces(confluence):
    connector = ConfluenceConnector()
    client = confluence.client()
    page = await connector.discover(client, "space", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (ACME, "Acme (acme.atlassian.net)"),
        (BETA, "Beta (beta.atlassian.net)"),
        (ENG, "Engineering (ENG) · Acme"),
        (FIN, f"{SECRET} (FIN) · Acme"),
        (f"{ACME}/102", "Ada (~ada) · Acme"),
    ]
    second = await connector.discover(client, "space", query=None, cursor=page.next_cursor)
    assert ([(i.id, i.name) for i in second.items], second.next_cursor) == (
        [(OPS, "Operations (OPS) · Beta")],
        None,
    )
    confluence.page_size = 1
    first = await connector.discover(client, "space", query="eng", cursor=None)
    assert ([i.id for i in first.items], first.next_cursor) == ([ENG], f"0:{TOKEN}1")
    following = await connector.discover(client, "space", query="eng", cursor=first.next_cursor)
    assert following.items == [] and following.next_cursor == f"0:{TOKEN}2"
    for cursor in ("x", "2:", "0:a b", "0:" + "a" * 991):
        with pytest.raises(OperationError) as caught:
            await connector.discover(client, "space", query=None, cursor=cursor)
        assert caught.value.code == "INVALID_CURSOR"
    described = await connector.describe(
        client,
        "space",
        [ACME, ACME.upper(), JIRA, ENG, OPS, f"{ACME}/999", f"{JIRA}/100", f"{ACME}/ENG"],
    )
    assert described == {
        ACME: "Acme (acme.atlassian.net)",
        ENG: "Engineering (ENG) · Acme",
        OPS: "Operations (OPS) · Beta",
    }


def test_cursors_are_checked():
    assert client_module.page_params("c:" + TOKEN) == {"cursor": TOKEN}
    for cursor in ("x:abc", "c:", "c:a b", "c:" + "a" * 991, "c:é"):
        with pytest.raises(OperationError) as caught:
            client_module.page_params(cursor)
        assert caught.value.code == "INVALID_CURSOR"

    def listing(next_link: str | None) -> Listing:
        return Listing.model_validate({"results": [], "_links": {"next": next_link} if next_link else {}})

    assert client_module.next_cursor(listing(None)) is None
    assert client_module.next_cursor(listing("/wiki/api/v2/pages?cursor=abc%2B&limit=5")) == "c:abc+"
    # Only the cursor is kept: where the link points is never used.
    assert client_module.next_cursor(listing("https://evil.example/x?cursor=abc")) == "c:abc"
    for link in ("/x?limit=5", "/x?cursor=a%20b", "/x?cursor=a&cursor=b", "/x?cursor=" + "a" * 991):
        with pytest.raises(OperationError) as caught:
            client_module.next_cursor(listing(link))
        assert caught.value.code == "PROVIDER_LIMIT"


def test_scopes_follow_the_allowed_actions(monkeypatch):
    connector = registry.get("confluence")
    monkeypatch.setattr(
        connection_oauth, "client_credentials", lambda connector: ClientCredentials("id", "s", "https://x/cb")
    )
    base = ["offline_access", "read:me", *READ_SCOPES]
    assert connection_oauth.requested_scopes(connector, {"read"}) == base
    assert connection_oauth.requested_scopes(connector, {"read", "comment"}) == [
        *base,
        "write:comment:confluence",
    ]
    needed = connection_oauth.consent_needed
    assert needed(connector, frozenset(base), {"read", "comment", "create"}) == ["comment", "create"]
    assert needed(connector, frozenset([*base, "write:page:confluence"]), {"read", "create"}) == []


# Reading


@pytest.mark.django_db(transaction=True)
async def test_a_site_grant_covers_its_spaces_and_denies_hold_inside_it(start, confluence):
    await start({})
    await ceiling("confluence", "space", FIN, Grant.Effect.DENY)
    executor = await start({ACME: ("read",)})
    outcome = await executor.invoke("confluence_list_spaces", {})
    assert [s["key"] for s in _items(outcome)] == ["ENG", "~ada"]
    assert _items(outcome)[0] == {
        "id": "100",
        "site_id": ACME,
        "site": "Acme (acme.atlassian.net)",
        "key": "ENG",
        "name": "Engineering",
        "type": "global",
        "status": "current",
    }
    assert SECRET not in json.dumps(outcome.result)
    # Several sites: calls name one.
    assert await refusal(executor, "confluence_get_page", {"page": "500"}) == "INVALID_ARGUMENTS"
    args = {"site_id": ACME.upper(), "page": "500"}
    assert _items(await executor.invoke("confluence_get_page", args))[0]["title"] == "Runbook"
    for site_id, page in ((ACME, "501"), (BETA, "500"), (JIRA, "500"), (ACME, "404"), (ACME, "505")):
        args = {"site_id": site_id, "page": page}
        assert await refusal(executor, "confluence_get_page", args) == "POLICY_DENIED"
    for args in (
        {"site_id": "acme", "page": "500"},
        {"site_id": ACME, "page": "x500"},
        {"site_id": ACME, "page": "0500"},
    ):
        assert await refusal(executor, "confluence_get_page", args) == "INVALID_ARGUMENTS"
    # Nothing of a refused page was read beyond where it is.
    assert all("body-format" not in r.url.params for r in confluence.reads("/pages/501"))
    assert not confluence.reads("/pages/501/footer-comments")


@pytest.mark.django_db(transaction=True)
async def test_spaces_are_named_by_exact_key_or_id_and_ids_repeat_across_sites(start, confluence):
    executor = await start({OPS: ("read",)})
    args = {"site_id": ACME, "space": "100"}
    assert await refusal(executor, "confluence_search_pages", args) == "POLICY_DENIED"
    outcome = await executor.invoke("confluence_search_pages", {"site_id": BETA, "space": "100"})
    assert [p["title"] for p in _items(outcome)] == ["Keys"]
    confluence.one_site()
    executor = await start({ENG: ("read",)})
    assert [p["id"] for p in _items(await executor.invoke("confluence_search_pages", {"space": "ENG"}))] == [
        "504",
        "502",
        "500",
    ]
    # Keys are case-sensitive: "eng" is not ENG.
    for space in ("eng", "FIN", "~ada", "NOPE"):
        assert await refusal(executor, "confluence_search_pages", {"space": space}) == "POLICY_DENIED"
    # Another spelling of an id is refused before Confluence is asked: it cannot tell spaces apart.
    for space in ('ENG" OR space = "FIN', "a b", "0101", "0999"):
        assert await refusal(executor, "confluence_search_pages", {"space": space}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_pages_show_their_space_only_and_hide_atlassian_links(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read",)})
    outcome = await executor.invoke("confluence_get_page", {"page": "500"})
    assert SECRET not in json.dumps(outcome.result)
    page = _items(outcome)[0]
    assert page["body"] == (
        "See [Atlassian link] and docs (https://example.com/docs)\n[Atlassian link][unsupported content]"
    )
    assert [c["text"] for c in page["comments"]] == ["comment 0", "comment 1", "comment 2"]
    assert (page["more_comments"], page["parent"], page["version"]) == (False, None, 3)
    assert page["link"] == "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500"
    assert confluence.reads("/footer-comments")[0].url.params["limit"] == "30"
    child = _items(await executor.invoke("confluence_get_page", {"page": "502"}))[0]
    assert child["parent"] == {"id": "500", "title": "Runbook"}
    # A parent in another space is left out.
    adopted = _items(await executor.invoke("confluence_get_page", {"page": "504"}))[0]
    assert adopted["parent"] is None
    confluence.page_size = 2
    assert _items(await executor.invoke("confluence_get_page", {"page": "500"}))[0]["more_comments"] is True


@pytest.mark.django_db(transaction=True)
async def test_a_body_that_cannot_be_read_is_not_shown_as_empty(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read",)})
    acme = confluence.sites[ACME]
    acme["comments"]["500"][0]["body"] = {"atlas_doc_format": {"value": "{broken"}}
    page = _items(await executor.invoke("confluence_get_page", {"page": "500"}))[0]
    assert [c["text"] for c in page["comments"]] == [None, "comment 1", "comment 2"]
    assert page["comments"][2]["updated"] == "2026-10-01T02:00:00.000Z"
    acme["pages"]["500"]["body"] = {"atlas_doc_format": {"value": "{broken"}}
    assert await refusal(executor, "confluence_get_page", {"page": "500"}) == "PROVIDER_FAILED"
    del acme["pages"]["500"]["body"]
    assert await refusal(executor, "confluence_get_page", {"page": "500"}) == "PROVIDER_FAILED"


@pytest.mark.django_db(transaction=True)
async def test_a_page_that_moves_after_authorizing_is_refused(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read", "comment", "create")})

    def move(method: str, path: str, params: dict):
        # Confluence answers the lookup that authorizes, then the page moves to FIN.
        page = confluence.sites[ACME]["pages"]["500"]
        if method == "GET" and path.endswith("/pages/500") and page["spaceId"] == "100":
            response = httpx.Response(200, json=copy.deepcopy(page))
            page["spaceId"] = "101"
            return response
        return None

    confluence.hook = move
    assert await refusal(executor, "confluence_get_page", {"page": "500"}) == "PAGE_MOVED"
    confluence.sites[ACME]["pages"]["500"]["spaceId"] = "100"
    assert await refusal(executor, "confluence_add_comment", {"page": "500", "text": "hi"}) == "PAGE_MOVED"
    confluence.sites[ACME]["pages"]["500"]["spaceId"] = "100"
    args = {"space": "ENG", "title": "New", "parent_page": "500"}
    assert await refusal(executor, "confluence_create_page", args) == "PAGE_MOVED"
    assert not confluence.writes


@pytest.mark.django_db(transaction=True)
async def test_search_reads_results_again_and_shows_them_where_they_are(start, confluence):
    confluence.one_site()
    confluence.stale = ["501"]
    executor = await start({ENG: ("read",)})
    args = {"space": "ENG", "text": 'run "OR space = FIN'}
    outcome = await executor.invoke("confluence_search_pages", args)
    assert [p["id"] for p in _items(outcome)] == ["504", "502", "500"]
    assert _items(outcome)[2] == {
        "id": "500",
        "site_id": ACME,
        "space_id": "100",
        "title": "Runbook",
        "updated": "2026-10-02T09:00:00.000Z",
        "link": "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500",
    }
    assert SECRET not in json.dumps(outcome.result)
    assert confluence.reads("/rest/api/search")[-1].url.params["cql"] == (
        'type = page AND space = "ENG" AND title ~ "run OR space FIN" ORDER BY lastmodified DESC'
    )
    args = {"space": "ENG", "text": "?!"}
    assert await refusal(executor, "confluence_search_pages", args) == "INVALID_ARGUMENTS"

    def rejected(method: str, path: str, params: dict):
        return httpx.Response(400, json={"message": SECRET}) if path.endswith("/search") else None

    confluence.hook = rejected
    assert await refusal(executor, "confluence_search_pages", {"space": "ENG"}) == "INVALID_ARGUMENTS"


@pytest.mark.django_db(transaction=True)
async def test_search_pages_are_run_bound_and_batch_reads_follow_their_pages(start, confluence):
    confluence.one_site()
    executor = await start({"*": ("read",)})
    first = await executor.invoke("confluence_search_pages", {"space": "ENG", "limit": 2})
    assert [p["id"] for p in _items(first)] == ["504", "502"]
    args = {"space": "ENG", "limit": 2, "cursor": first.result["next_cursor"]}
    second = await executor.invoke("confluence_search_pages", args)
    assert [p["id"] for p in _items(second)] == ["500"] and "next_cursor" not in second.result
    assert confluence.reads("/rest/api/search")[-1].url.params["cursor"] == f"{TOKEN}2"
    other = {"space": "FIN", "limit": 2, "cursor": first.result["next_cursor"]}
    assert await refusal(executor, "confluence_search_pages", other) == "INVALID_CURSOR"
    # Confluence pages a filtered listing too; every page of it is read, in the search's order.
    confluence.page_size = 1
    pages = await confluence.client().pages(ACME, ["504", "500", "502", "999"])
    assert [p.id for p in pages] == ["504", "500", "502"]


@pytest.mark.django_db(transaction=True)
async def test_space_listings_stop_at_a_cap(start, confluence, monkeypatch):
    from connectors.confluence import reads

    confluence.page_size = 1
    monkeypatch.setattr(reads, "MAX_SPACE_PAGES", 1)
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("confluence_list_spaces", {"site_id": ACME})
    assert [s["key"] for s in _items(outcome)] == ["ENG"] and outcome.result["incomplete"] is True


async def test_a_repeated_cursor_is_refused(confluence):
    def loop(method: str, path: str, params: dict):
        if path.endswith("/api/v2/spaces"):
            return httpx.Response(200, json={"results": [], "_links": {"next": "/x?cursor=same"}})
        return None

    confluence.hook = loop
    with pytest.raises(OperationError) as caught:
        await confluence.client().spaces_by(ACME, "keys", ["ENG"])
    assert caught.value.code == "PROVIDER_FAILED"


# Writing


@pytest.mark.django_db(transaction=True)
async def test_comments_are_plain_text_without_links_to_atlassian(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read", "comment")})
    outcome = await executor.invoke(
        "confluence_add_comment", {"page": "500", "text": "Done.\n\n**not bold**"}
    )
    assert _items(outcome) == [
        {
            "written": True,
            "id": "709",
            "page_id": "500",
            "created": "2026-10-03T09:00:00.000Z",
            "link": "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=500",
        }
    ]
    [(path, body)] = confluence.writes
    assert (path, body["pageId"], body["body"]["representation"]) == (
        "footer-comments",
        "500",
        "atlas_doc_format",
    )
    assert json.loads(body["body"]["value"]) == _doc(
        _paragraph(_text("Done.")), _paragraph(_text("**not bold**"))
    )
    for text in ("see https://acme.atlassian.net/wiki/x/501", "ACME%2EATLASSIAN%2ENET/x", "bell \x07"):
        args = {"page": "500", "text": text}
        assert await refusal(executor, "confluence_add_comment", args) == "INVALID_ARGUMENTS"
    assert await refusal(executor, "confluence_add_comment", {"page": "501", "text": "x"}) == "POLICY_DENIED"
    assert len(confluence.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_writes_need_read_and_their_consent(start, confluence):
    confluence.one_site()
    await start({})
    await ceiling("confluence", "space", ENG, Grant.Effect.DENY, ("read",))
    executor = await start({ACME: ("read", "comment", "create")})
    assert await refusal(executor, "confluence_add_comment", {"page": "500", "text": "x"}) == "POLICY_DENIED"
    args = {"space": "ENG", "title": "x"}
    assert await refusal(executor, "confluence_create_page", args) == "POLICY_DENIED"
    # With only the comment scope, creating pages is not offered.
    executor = await start(
        {ACME: ("read", "comment", "create")}, scopes=[*READ_SCOPES, "write:comment:confluence"]
    )
    assert {t for t in executor.context.tools if t.startswith("confluence_")} == {
        "confluence_list_spaces",
        "confluence_search_pages",
        "confluence_get_page",
        "confluence_add_comment",
    }
    assert not confluence.writes


@pytest.mark.django_db(transaction=True)
async def test_pages_are_created_in_the_space_or_under_a_page_in_it(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read", "create")})
    args = {"space": "ENG", "title": "Release notes", "body": "Shipped.", "parent_page": "500"}
    outcome = await executor.invoke("confluence_create_page", args)
    assert _items(outcome) == [
        {
            "written": True,
            "id": "509",
            "site_id": ACME,
            "space_id": "100",
            "link": "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=509",
        }
    ]
    [(path, body)] = confluence.writes
    assert path == "pages" and {k: v for k, v in body.items() if k != "body"} == {
        "spaceId": "100",
        "status": "current",
        "title": "Release notes",
        "parentId": "500",
    }
    assert json.loads(body["body"]["value"]) == _doc(_paragraph(_text("Shipped.")))
    # A parent in another space, or one that does not exist, is refused alike.
    for parent in ("501", "404", "505"):
        attempt = args | {"title": "Other", "parent_page": parent}
        assert await refusal(executor, "confluence_create_page", attempt) == "POLICY_DENIED"
    for title in ("a\nb", "see acme.atlassian.net/wiki/x/501"):
        assert (
            await refusal(executor, "confluence_create_page", args | {"title": title}) == "INVALID_ARGUMENTS"
        )
    # A title the space already has: Confluence's reason is not passed on.
    attempt = {"space": "ENG", "title": "Runbook"}
    assert await refusal(executor, "confluence_create_page", attempt) == "INVALID_ARGUMENTS"
    assert len(confluence.writes) == 2

    # Automation moves the new page at once: the result is in FIN, which the agent may not read.
    def moved(method: str, path: str, params: dict):
        if method == "GET" and path.endswith("/pages/509"):
            return httpx.Response(200, json=_page("509", "101", SECRET))
        return None

    confluence.hook = moved
    del confluence.sites[ACME]["pages"]["509"]
    outcome = await executor.invoke("confluence_create_page", {"space": "ENG", "title": "Again"})
    assert _items(outcome) == [] and SECRET not in json.dumps(outcome.result)
    assert "parentId" not in confluence.writes[-1][1]


@pytest.mark.django_db(transaction=True)
async def test_a_created_page_that_cannot_be_read_back_counts_without_a_result(start, confluence):
    confluence.one_site()
    executor = await start({ENG: ("read", "create")})

    def lost(method: str, path: str, params: dict):
        if method == "GET" and path.endswith("/pages/509"):
            return httpx.Response(404, json={})
        return None

    confluence.hook = lost
    outcome = await executor.invoke("confluence_create_page", {"space": "ENG", "title": "New"})
    assert outcome.result["outcome"] == "applied_without_result" and _items(outcome) == []
    assert len(confluence.writes) == 1


@pytest.mark.django_db(transaction=True)
async def test_written_text_may_not_name_a_site_on_its_own_domain(start, confluence):
    confluence.one_site()
    confluence.resources[0]["url"] = "https://wiki.acme.example"
    executor = await start({ENG: ("read", "comment", "create")})
    for text in ("see https://WIKI.acme.example/wiki/x", "wiki%2Eacme%2Eexample/x"):
        args = {"page": "500", "text": text}
        assert await refusal(executor, "confluence_add_comment", args) == "INVALID_ARGUMENTS"
        args = {"space": "ENG", "title": "New", "body": text}
        assert await refusal(executor, "confluence_create_page", args) == "INVALID_ARGUMENTS"
    assert not confluence.writes
