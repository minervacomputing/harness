"""The Web connector: site names, the guarded fetcher, page text, search, and runs through the executor."""

import gzip
import json
import time

import httpx
import pytest
from asgiref.sync import sync_to_async

from connections import services as connection_services
from connections.models import Connection
from connectors.base import ACCOUNT_KIND, OperationError
from connectors.executor import Executor
from connectors.web import sites
from connectors.web.connector import WebClient, WebConnector
from connectors.web.fetch import MAX_BODY, Fetcher, Moved, Page, public_address
from connectors.web.markdown import html_to_text
from connectors.web.search import BraveSearch
from minerva.config import config
from permissions.models import Grant, PermissionLayer
from workspaces.tenancy import workspace_scope

PUBLIC = "93.184.215.14"


def _code(call, *args, **kwargs) -> str:
    with pytest.raises(OperationError) as caught:
        call(*args, **kwargs)
    return caught.value.code


async def _acode(awaitable) -> str:
    with pytest.raises(OperationError) as caught:
        await awaitable
    return caught.value.code


# Site names


def test_hosts_are_canonical_public_names():
    assert sites.canonical_host("Docs.Python.ORG.") == "docs.python.org"
    assert sites.canonical_host("bücher.ch") == "xn--bcher-kva.ch"
    for refused in (
        "localhost",
        "intranet",
        "printer.local",
        "db.internal",
        "1.0.0.10.in-addr.arpa",
        "abc.onion",
        "127.0.0.1",
        "[::1]",
        "127.1",
        "0x7f.1",
        "2130706433",
        "-bad-.com",
        "a..com",
        "x" * 64 + ".com",
        "",
    ):
        assert _code(sites.canonical_host, refused) == "INVALID_URL", refused


def test_patterns_never_span_a_public_suffix():
    assert sites.ancestors("a.docs.python.org") == (
        "*.a.docs.python.org",
        "*.docs.python.org",
        "*.python.org",
    )
    assert sites.ancestors("python.org") == ("*.python.org",)
    assert sites.ancestors("ada.github.io") == ("*.ada.github.io",)
    assert sites.ancestors("shop.example.co.uk") == ("*.shop.example.co.uk", "*.example.co.uk")
    assert sites.choices("docs.python.org") == ["docs.python.org", "*.docs.python.org", "*.python.org"]
    for valid in ("python.org", "*.python.org", "*.docs.python.org", "*.ada.github.io"):
        assert sites.valid_id(valid), valid
    for invalid in (
        "*.org",
        "*.co.uk",
        "*.github.io",
        "*",
        "Python.org",
        "*.*.python.org",
        "localhost",
        "1.2.3.4",
    ):
        assert not sites.valid_id(invalid), invalid
    assert sites.name("*.python.org") == "python.org, including subdomains"


def test_addresses_are_parsed_into_what_is_requested():
    url = sites.parse_url("HTTPS://Docs.Python.org/3/library/os.html?q=a b#frag".replace(" ", "%20"))
    assert (url.scheme, url.host, url.target) == ("https", "docs.python.org", "/3/library/os.html?q=a%20b")
    assert sites.parse_url("http://example.com").text == "http://example.com/"
    assert sites.parse_url("https://example.com:443/x").text == "https://example.com/x"
    assert sites.parse_url("/next", base=url).text == "https://docs.python.org/next"
    assert sites.parse_url("//other.org/y", base=url).text == "https://other.org/y"
    for refused in (
        "ftp://example.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:pw@example.com/",
        "https://example.com@127.0.0.1/",
        "https://example.com:8443/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "http://127.1/",
        "http://localhost/",
        "https://example.com\\@evil.org/",
        "https://exa mple.com/",
        "https://example.com/\n",
        "https:///path",
        "https://" + "a" * 2000 + ".com/",
    ):
        assert _code(sites.parse_url, refused) == "INVALID_URL", refused


def test_only_public_addresses_are_opened():
    for public in (PUBLIC, "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"):
        assert public_address(public), public
    for private in (
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",  # noqa: S104
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "fe80::1",
        "fe80::1%en0",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "::127.0.0.1",
        "::8.8.8.8",
        "2002:7f00:0001::1",
        "64:ff9b::a00:1",
        "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
        "ff02::1",
        "not an address",
    ):
        assert not public_address(private), private


# The fetcher


class _Stream(httpx.AsyncByteStream):
    def __init__(self, body: bytes) -> None:
        self.body = body

    async def __aiter__(self):
        for start in range(0, len(self.body), 65536):
            yield self.body[start : start + 65536]


class FakeNet:
    """DNS and web servers for the fetcher: `sites` maps a host to its addresses and its pages."""

    def __init__(self) -> None:
        self.addresses: dict[str, list[str]] = {}
        self.pages: dict[tuple[str, str], httpx.Response] = {}
        self.resolved: list[str] = []
        self.requests: list[httpx.Request] = []

    def site(self, host: str, *addresses: str) -> None:
        self.addresses[host] = list(addresses or [PUBLIC])

    def page(self, host: str, target: str, response: httpx.Response) -> None:
        self.pages[(host, target)] = response

    async def resolve(self, host: str) -> list[str]:
        self.resolved.append(host)
        if host not in self.addresses:
            raise OperationError("SITE_UNREACHABLE", "This site's name could not be found.")
        return self.addresses[host]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        page = self.pages.get((request.headers["host"], request.url.raw_path.decode()))
        if page is None:
            return httpx.Response(404)
        # Streamed like a network response, with the body as sent (httpx decoded `content` already).
        return httpx.Response(page.status_code, headers=page.headers, stream=_Stream(b"".join(page.stream)))

    def fetcher(self) -> Fetcher:
        return Fetcher(resolver=self.resolve, transport=lambda: httpx.MockTransport(self.handler))


@pytest.fixture
def net() -> FakeNet:
    return FakeNet()


def _html(body: str, **headers) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8", **headers}, content=body)


async def test_the_fetcher_connects_to_the_checked_address_under_the_site_name(net):
    net.site("example.com", PUBLIC)
    net.page("example.com", "/a?b=1", _html("<p>Hello</p>"))
    page = await net.fetcher().get(sites.parse_url("https://example.com/a?b=1"))
    assert isinstance(page, Page)
    assert (page.form, page.text) == ("html", "<p>Hello</p>")
    request = net.requests[0]
    assert request.url.host == PUBLIC
    assert request.headers["host"] == "example.com"
    assert request.extensions["sni_hostname"] == "example.com"
    assert "cookie" not in request.headers and "authorization" not in request.headers


async def test_a_site_with_any_private_address_is_refused(net):
    for addresses in (("127.0.0.1",), (PUBLIC, "10.0.0.5"), ("::ffff:192.168.0.1",)):
        net.site("sneaky.example.com", *addresses)
        assert (
            await _acode(net.fetcher().get(sites.parse_url("https://sneaky.example.com/")))
            == "SITE_NOT_PUBLIC"
        )
    assert net.requests == []


async def test_redirects_are_followed_only_on_the_same_host(net):
    net.site("example.com")
    net.page("example.com", "/old", httpx.Response(301, headers={"location": "/new"}))
    net.page(
        "example.com", "/new", httpx.Response(200, headers={"content-type": "text/plain"}, content="moved")
    )
    net.page("example.com", "/away", httpx.Response(302, headers={"location": "https://evil.example.org/x"}))
    net.page("example.com", "/down", httpx.Response(302, headers={"location": "http://example.com/new"}))
    net.page("example.com", "/inside", httpx.Response(302, headers={"location": "http://10.0.0.1/"}))
    net.page("example.com", "/loop", httpx.Response(302, headers={"location": "/loop"}))
    fetcher = net.fetcher()
    page = await fetcher.get(sites.parse_url("https://example.com/old"))
    assert isinstance(page, Page) and page.url.text == "https://example.com/new" and page.text == "moved"
    moved = await fetcher.get(sites.parse_url("https://example.com/away"))
    assert isinstance(moved, Moved) and moved.target.text == "https://evil.example.org/x"
    assert "evil.example.org" not in net.resolved
    moved = await fetcher.get(sites.parse_url("https://example.com/down"))
    assert isinstance(moved, Moved) and moved.target.scheme == "http"
    assert await _acode(fetcher.get(sites.parse_url("https://example.com/inside"))) == "PAGE_ERROR"
    assert await _acode(fetcher.get(sites.parse_url("https://example.com/loop"))) == "PAGE_ERROR"


async def test_bodies_are_capped_before_and_after_decompression(net):
    net.site("example.com")
    bomb = gzip.compress(b"a" * (MAX_BODY + 10))
    assert len(bomb) < 100_000
    net.page("example.com", "/bomb", _html(bomb, **{"content-encoding": "gzip"}))
    net.page("example.com", "/big", _html(b"a" * (MAX_BODY + 1)))
    net.page("example.com", "/zipped", _html(gzip.compress(b"<p>small</p>"), **{"content-encoding": "gzip"}))
    net.page("example.com", "/twice", _html(b"x", **{"content-encoding": "gzip, br"}))
    net.page(
        "example.com",
        "/pdf",
        httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF"),
    )
    net.page("example.com", "/gone", httpx.Response(410))
    fetcher = net.fetcher()
    for target, code in (
        ("/bomb", "PAGE_TOO_LARGE"),
        ("/big", "PAGE_TOO_LARGE"),
        ("/twice", "UNSUPPORTED_CONTENT"),
        ("/pdf", "UNSUPPORTED_CONTENT"),
        ("/gone", "PAGE_ERROR"),
    ):
        assert await _acode(fetcher.get(sites.parse_url(f"https://example.com{target}"))) == code, target
    page = await fetcher.get(sites.parse_url("https://example.com/zipped"))
    assert page.text == "<p>small</p>"


async def test_charsets_are_honoured(net):
    net.site("example.com")
    latin = "<meta charset='iso-8859-1'><p>Zürich</p>".encode("latin-1")
    net.page(
        "example.com", "/meta", httpx.Response(200, headers={"content-type": "text/html"}, content=latin)
    )
    net.page(
        "example.com",
        "/header",
        httpx.Response(
            200, headers={"content-type": "text/plain; charset=latin-1"}, content="Zürich".encode("latin-1")
        ),
    )
    fetcher = net.fetcher()
    assert "Zürich" in (await fetcher.get(sites.parse_url("https://example.com/meta"))).text
    assert (await fetcher.get(sites.parse_url("https://example.com/header"))).text == "Zürich"


# Page text


def test_pages_become_readable_text_without_active_content():
    html = """<html><head><title> The  Title </title><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav>
    <h1>Heading</h1><p>Some <b>bold</b> and <a href="/docs (1)">a link</a>.</p>
    <script>steal()</script><iframe src="https://evil.example.org"></iframe>
    <ul><li>one</li><li>two<ol><li>inner</li></ol></li></ul>
    <pre>  indented
    code</pre>
    <img src="https://evil.example.org/leak?d=secret" alt="A cat">
    <a href="javascript:alert(1)">bad</a>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <footer>Footer</footer></body></html>"""
    text, title = html_to_text(html, "https://example.com/page")
    assert title == "The Title"
    assert text.startswith("# Heading")
    assert "Some **bold** and [a link](https://example.com/docs%20%281%29)." in text
    assert "- one\n- two\n  1. inner" in text
    assert "```\n  indented\n    code\n```" in text
    assert "[image: A cat]" in text and "leak" not in text
    assert "bad" in text and "javascript" not in text
    assert "A | B\n1 | 2" in text
    for dropped in ("steal", "evil.example.org", "Home", "Footer", "p{}"):
        assert dropped not in text, dropped


def test_hostile_markup_is_converted_in_linear_time():
    """Pages are converted in the trusted backend, after the fetch deadline, so no page may stall it."""
    # A link left open inside a script that never closes.
    assert html_to_text('<a href="/"><script>', "https://example.com/") == ("", None)
    assert html_to_text('<a href="/">x<script>', "https://example.com/")[0] == "[x](https://example.com/)"
    n = 50_000
    cases = (
        '<a href="/">' * n + "x" + "</a>" * n,
        "<svg>" * n + "<math>" + "</svg>" * n + "text",
        "<svg><math>" * n + "</math>" * n + "</svg>" * n,
        "<ul><li>" * n + "x",
    )
    for html in cases:
        start = time.monotonic()
        html_to_text(html, "https://example.com/")
        assert time.monotonic() - start < 3, html[:20]
    # Links do not nest.
    text, _ = html_to_text('<a href="/a">one <a href="/b">two</a></a>', "https://example.com/")
    assert text == "[one](https://example.com/a)[two](https://example.com/b)"


# Runs through the executor


class FakeBrave:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "no"})
        return httpx.Response(
            200,
            json={
                "query": {"more_results_available": True},
                "web": {
                    "results": [
                        {
                            "title": "<strong>Python</strong> docs",
                            "url": "https://docs.python.org/3/",
                            "description": "The &amp; official <strong>docs</strong>",
                            "age": "2 days ago",
                        },
                        {"title": "Local", "url": "http://localhost/admin", "description": "skipped"},
                    ]
                },
            },
        )


@pytest.fixture
def brave() -> FakeBrave:
    return FakeBrave()


@pytest.fixture
def start(connector_run, net, brave, monkeypatch):
    """Starts a run for an agent with the user's Web connection, holding `grants` ((kind, id) → actions);
    returns its executor and the names of the tools it was offered."""
    monkeypatch.setattr(config(), "brave_search_api_key", config().secret_key)

    def client(self, secret):
        key = config().brave_search_api_key
        search = BraveSearch("k", transport=httpx.MockTransport(brave.handler)) if key else None
        return WebClient(net.fetcher(), search)

    monkeypatch.setattr(WebConnector, "client", client)

    async def start_(grants: dict[tuple[str, str], tuple[str, ...]]) -> tuple[Executor, list[str]]:
        executor = await connector_run("web", grants)
        return executor, list(executor.context.tools)

    return start_


def _ceiling_deny(resource_id: str):
    def create() -> None:
        Grant.objects.create(
            layer=PermissionLayer.unscoped.get(level=PermissionLayer.Level.CEILING),
            connection=Connection.unscoped.get(provider="web"),
            resource_kind="site",
            resource_id=resource_id,
            actions=["read"],
            effect=Grant.Effect.DENY,
        )

    return sync_to_async(create)


@pytest.mark.django_db(transaction=True)
async def test_a_domain_grant_covers_its_subdomains_and_nothing_else(start, net):
    for host in ("python.org", "docs.python.org", "evil.example.org"):
        net.site(host)
        net.page(host, "/", _html(f"<title>{host}</title><p>Welcome to {host}</p>"))
    executor, tools = await start({("site", "*.python.org"): ("read",)})
    assert tools == ["web_read_page"]
    for url in ("https://python.org/", "https://docs.python.org/"):
        outcome = await executor.invoke("web_read_page", {"url": url})
        item = outcome.result["items"][0]
        assert item["url"] == url and item["title"] == sites.parse_url(url).host
    assert "Welcome to docs.python.org" in item["text"]
    resolved = list(net.resolved)
    assert (
        await _acode(executor.invoke("web_read_page", {"url": "https://evil.example.org/"}))
        == "POLICY_DENIED"
    )
    assert await _acode(executor.invoke("web_read_page", {"url": "http://localhost/"})) == "INVALID_URL"
    # Nothing was resolved for the refused addresses.
    assert net.resolved == resolved


@pytest.mark.django_db(transaction=True)
async def test_a_block_on_a_subdomain_wins(start, net):
    net.site("docs.python.org")
    net.page("docs.python.org", "/", _html("<p>docs</p>"))
    await start({})
    await _ceiling_deny("*.docs.python.org")()
    executor, _ = await start({("site", "*"): ("read",)})
    assert (
        await _acode(executor.invoke("web_read_page", {"url": "https://docs.python.org/"})) == "POLICY_DENIED"
    )
    assert (
        await _acode(executor.invoke("web_read_page", {"url": "https://a.docs.python.org/"}))
        == "POLICY_DENIED"
    )
    assert net.resolved == []


@pytest.mark.django_db(transaction=True)
async def test_a_redirect_to_another_site_is_returned_not_followed(start, net):
    net.site("example.com")
    net.page("example.com", "/", httpx.Response(302, headers={"location": "https://evil.example.org/?d=1"}))
    executor, _ = await start({("site", "example.com"): ("read",)})
    outcome = await executor.invoke("web_read_page", {"url": "https://example.com/"})
    assert outcome.result["items"][0]["redirect_to"] == "https://evil.example.org/?d=1"
    assert net.resolved == ["example.com"]


@pytest.mark.django_db(transaction=True)
async def test_long_pages_are_read_in_parts(start, net):
    net.site("example.com")
    net.page(
        "example.com", "/", httpx.Response(200, headers={"content-type": "text/plain"}, content="x" * 1200)
    )
    executor, _ = await start({("site", "example.com"): ("read",)})
    first = await executor.invoke("web_read_page", {"url": "https://example.com/", "max_chars": 500})
    item = first.result["items"][0]
    assert (len(item["text"]), item["total_chars"], item["next_offset"]) == (500, 1200, 500)
    last = await executor.invoke(
        "web_read_page", {"url": "https://example.com/", "max_chars": 1000, "offset": 500}
    )
    assert last.result["items"][0]["next_offset"] is None


@pytest.mark.django_db(transaction=True)
async def test_searching_needs_its_own_permission(start, brave):
    executor, tools = await start({("site", "*"): ("read",)})
    assert tools == ["web_read_page"]
    assert await _acode(executor.invoke("web_search", {"query": "python"})) == "UNKNOWN_OPERATION"
    assert brave.requests == []
    executor, tools = await start(
        {(ACCOUNT_KIND, "account"): ("search",), ("site", "example.com"): ("read",)}
    )
    assert tools == ["web_search", "web_read_page"]
    outcome = await executor.invoke("web_search", {"query": "python docs", "limit": 5, "country": "CH"})
    assert outcome.result["items"] == [
        {
            "title": "Python docs",
            "url": "https://docs.python.org/3/",
            "site": "docs.python.org",
            "snippet": "The & official docs",
            "age": "2 days ago",
        }
    ]
    assert outcome.result["next_cursor"]
    params = brave.requests[0].url.params
    assert (params["q"], params["count"], params["country"], params["offset"]) == (
        "python docs",
        "5",
        "CH",
        "0",
    )
    arguments = {"query": "python docs", "limit": 5, "country": "CH", "cursor": outcome.result["next_cursor"]}
    await executor.invoke("web_search", arguments)
    assert brave.requests[1].url.params["offset"] == "1"
    # Search results do not open pages: reading one still needs the site.
    assert (
        await _acode(executor.invoke("web_read_page", {"url": "https://docs.python.org/3/"}))
        == "POLICY_DENIED"
    )


@pytest.mark.django_db(transaction=True)
async def test_a_refused_search_key_keeps_the_connection(start, brave):
    brave.status = 401
    executor, _ = await start({(ACCOUNT_KIND, "account"): ("search",)})
    assert await _acode(executor.invoke("web_search", {"query": "python"})) == "SEARCH_UNAVAILABLE"
    connection = await Connection.unscoped.aget(provider="web")
    assert connection.status == Connection.Status.ACTIVE


@pytest.mark.django_db(transaction=True)
async def test_search_is_not_offered_without_a_key(start, monkeypatch):
    monkeypatch.setattr(config(), "brave_search_api_key", None)
    _, tools = await start({(ACCOUNT_KIND, "account"): ("search",), ("site", "*"): ("read",)})
    assert tools == ["web_read_page"]


# Settings


def test_the_web_is_added_once_per_user_and_has_no_account_to_reconnect(api, workspace, other_user):
    listed = {c["slug"]: c for c in api.get(f"/api/workspaces/{workspace.id}/connectors").json()}
    assert listed["web"]["auth"] == "builtin"
    first = api.post(f"/api/workspaces/{workspace.id}/connections/web/enable")
    again = api.post(f"/api/workspaces/{workspace.id}/connections/web/enable")
    assert first.status_code == again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert api.post(f"/api/workspaces/{workspace.id}/connections/todoist/enable").status_code == 422
    assert api.post(f"/api/workspaces/{workspace.id}/connections/nope/enable").status_code == 404
    reconnect = api.post(
        f"/api/workspaces/{workspace.id}/connections/{first.json()['id']}/reconnect",
        data=json.dumps({"actions": []}),
        content_type="application/json",
    )
    assert reconnect.status_code == 422
    other = other_user.personal_workspace
    with workspace_scope(other.id):
        theirs = connection_services.enable_builtin(
            workspace_id=other.id, owner_id=other_user.id, provider="web"
        )
    assert str(theirs.id) != first.json()["id"]


def test_sites_are_found_by_address_and_allowed_per_domain(api, workspace):
    connection = api.post(f"/api/workspaces/{workspace.id}/connections/web/enable").json()
    url = f"/api/workspaces/{workspace.id}/connections/{connection['id']}/access"
    kinds = {k["id"]: k for k in api.get(url).json()["kinds"]}
    assert kinds["site"]["listed"] is False and kinds["site"]["note"]
    assert api.get(f"{url}/resources?kind=site").json()["items"] == []
    found = api.get(f"{url}/resources?kind=site&q=https://Docs.Python.org/3/").json()["items"]
    assert [(i["id"], i["name"]) for i in found] == [
        ("docs.python.org", "docs.python.org"),
        ("*.docs.python.org", "docs.python.org, including subdomains"),
        ("*.python.org", "python.org, including subdomains"),
    ]

    def change(resource_id: str, kind: str = "site", actions=("read",)):
        body = {"changes": [{"kind": kind, "id": resource_id, "actions": list(actions)}]}
        return api.patch(url, data=json.dumps(body), content_type="application/json")

    assert change("*.python.org").status_code == 200
    for refused in ("*.org", "*.github.io", "localhost", "10.0.0.1", "Python.org", "*.*.python.org"):
        assert change(refused).status_code == 422, refused
    assert change("*.python.org", actions=("search",)).status_code == 422
    assert change(connection["id"], kind=ACCOUNT_KIND, actions=("search",)).status_code == 200
    grants = {(g["kind"], g["id"]): g["actions"] for g in api.get(url).json()["grants"]}
    assert grants == {("site", "*.python.org"): ["read"], (ACCOUNT_KIND, connection["id"]): ["search"]}
