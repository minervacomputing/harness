"""GitHub connector against an in-memory GitHub API, and runs through the executor."""

import base64
import json
import time

import httpx
import pytest
from asgiref.sync import sync_to_async

from connections import credentials as connection_credentials
from connections import oauth as connection_oauth
from connections.models import Connection
from connections.oauth import ClientCredentials, ConnectionFlowError
from connectors import registry
from connectors.base import OperationError
from connectors.executor import Executor
from connectors.github import client as client_module
from connectors.github import connector as github_module
from connectors.github.client import API_URL, GitHubClient
from connectors.github.connector import GitHubConnector
from minerva.config import config
from permissions.models import Grant, PermissionLayer


def _repo(repo_id, full_name, private=False):
    return {"id": repo_id, "full_name": full_name, "private": private, "default_branch": "main"}


def _entry(path, kind="file", content=None, **extra):
    data = {"type": kind, "name": path.rsplit("/", 1)[-1], "path": path, "size": 0, **extra}
    if content is not None:
        data |= {"size": len(content), "encoding": "base64", "content": base64.b64encode(content).decode()}
    return data


class FakeGitHub:
    """The GitHub REST API, served through httpx.MockTransport.

    The App is installed on acme (acme/app, private acme/secret) and on ada (ada/notes, formerly
    ada/old-notes). acme/app has issues 1 and 3, pull request 2, and some files.
    """

    def __init__(self) -> None:
        self.repos = {
            1: _repo(1, "acme/app"),
            2: _repo(2, "acme/secret", private=True),
            3: _repo(3, "ada/notes"),
        }
        self.installations = {10: [1, 2], 11: [3]}
        self.renamed = {"ada/old-notes": f"{API_URL}/repositories/3"}
        self.issues = {
            1: [
                {"number": 3, "title": "Crash", "state": "open", "body": "x" * 30_000, "comments": 2},
                {
                    "number": 2,
                    "title": "Fix crash",
                    "state": "open",
                    "pull_request": {"url": "u"},
                    "comments": 0,
                },
                {"number": 1, "title": "Docs", "state": "open", "body": "Please", "comments": 0},
            ]
        }
        self.comments = {
            (1, 3): [{"id": 7, "body": "Same here", "user": {"login": "grace"}}, {"id": 8, "body": "+1"}]
        }
        self.pull = {
            "number": 2,
            "title": "Fix crash",
            "state": "open",
            "changed_files": 3,
            "merged_at": None,
        }
        self.pull_files = [
            {"filename": "a.py", "status": "modified", "additions": 1, "deletions": 1, "patch": "a" * 30},
            {"filename": "b.py", "status": "added", "additions": 5, "deletions": 0, "patch": "b" * 30},
        ]
        self.contents = {
            "": [_entry("README.md"), _entry("src", "dir")],
            "README.md": _entry("README.md", content=b"# App\nHello"),
            "src/zażółć.py": _entry("src/zażółć.py", content=b"print(1)\n"),
            "big.bin": {**_entry("big.bin"), "size": 2_000_000, "encoding": "none", "content": ""},
            "logo.png": _entry("logo.png", content=b"\x89PNG\x00\x01"),
            "link": _entry("link", "symlink", target="/etc/passwd"),
            "vendor": _entry("vendor", "file", submodule_git_url="https://github.com/x/y.git"),
        }
        self.requests: list[httpx.Request] = []
        self.posts: list[httpx.Request] = []
        self.error: httpx.Response | None = None
        self.refuse_posts: httpx.Response | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "POST":
            self.posts.append(request)
        if self.error is not None:
            return self.error
        if request.method == "POST" and self.refuse_posts is not None:
            return self.refuse_posts
        path = request.url.raw_path.decode().split("?")[0]
        parts = path.strip("/").split("/")
        params = request.url.params
        match parts:
            case ["user"]:
                return httpx.Response(200, json={"id": 42, "login": "ada"})
            case ["user", "installations"]:
                return httpx.Response(200, json={"installations": [{"id": i} for i in self.installations]})
            case ["user", "installations", installation, "repositories"]:
                ids = self.installations[int(installation)]
                start = (int(params["page"]) - 1) * int(params["per_page"])
                chosen = ids[start : start + int(params["per_page"])]
                return httpx.Response(200, json={"repositories": [self.repos[i] for i in chosen]})
            case ["repos", owner, name]:
                full = f"{owner}/{name}"
                if full in self.renamed:
                    return httpx.Response(301, headers={"location": self.renamed[full]})
                for repo in self.repos.values():
                    if repo["full_name"] == full:
                        return httpx.Response(200, json=repo)
            case ["repositories", repo_id] if int(repo_id) in self.repos:
                return httpx.Response(200, json=self.repos[int(repo_id)])
            case ["repositories", repo_id, "issues"] if request.method == "POST":
                body = json.loads(request.content)
                return httpx.Response(201, json={"number": 4, "state": "open", **body})
            case ["repositories", repo_id, "issues"]:
                issues = self.issues.get(int(repo_id), [])
                page = int(params.get("page", "1"))
                size = int(params["per_page"])
                headers = {}
                if page * size < len(issues):
                    nxt = f"{API_URL}/repositories/{repo_id}/issues?per_page={size}&after=Y3Vy%3D&page={page + 1}"
                    headers["link"] = f'<{nxt}>; rel="next", <{API_URL}/x?page=9>; rel="last"'
                return httpx.Response(200, json=issues[(page - 1) * size : page * size], headers=headers)
            case ["repositories", repo_id, "issues", number]:
                found = [i for i in self.issues.get(int(repo_id), []) if i["number"] == int(number)]
                if found:
                    return httpx.Response(200, json=found[0])
            case ["repositories", repo_id, "issues", number, "comments"] if request.method == "POST":
                return httpx.Response(201, json={"id": 99, "body": json.loads(request.content)["body"]})
            case ["repositories", repo_id, "issues", number, "comments"]:
                return httpx.Response(200, json=self.comments.get((int(repo_id), int(number)), []))
            case ["repositories", repo_id, "pulls"]:
                return httpx.Response(200, json=[self.pull])
            case ["repositories", repo_id, "pulls", "2"]:
                return httpx.Response(200, json=self.pull)
            case ["repositories", repo_id, "pulls", "2", "files"]:
                return httpx.Response(200, json=self.pull_files)
            case ["repositories", repo_id, "contents", *rest]:
                from urllib.parse import unquote

                key = "/".join(unquote(part) for part in rest)
                if key in self.contents:
                    return httpx.Response(200, json=self.contents[key])
        return httpx.Response(404, json={"message": "Not Found"})

    def client(self) -> GitHubClient:
        return GitHubClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def start(connector_run, github, monkeypatch):
    """Starts a run for an agent with the user's GitHub connection and `grants` (repository id → actions)."""
    monkeypatch.setattr(GitHubConnector, "client", lambda self, token: github.client())

    def start_(grants: dict[str, tuple[str, ...]]):
        repositories = {("repository", rid): actions for rid, actions in grants.items()}
        return connector_run("github", repositories, label="ada", external_account_id="42")

    return start_


def _deny(repo_id: str, actions=("read", "create")):
    def create() -> None:
        Grant.objects.create(
            layer=PermissionLayer.unscoped.get(level=PermissionLayer.Level.CEILING),
            connection=Connection.unscoped.get(provider="github"),
            resource_kind="repository",
            resource_id=repo_id,
            actions=list(actions),
            effect=Grant.Effect.DENY,
        )

    return sync_to_async(create)


async def _refused(executor: Executor, tool: str, args: dict) -> str:
    with pytest.raises(OperationError) as caught:
        await executor.invoke(tool, args)
    return caught.value.code


async def test_account_discovery_and_names(github):
    connector = GitHubConnector()
    client = github.client()
    account = await connector.account(client)
    assert (account.id, account.label) == ("42", "ada")
    first = await connector.discover(client, "repository", query=None, cursor=None)
    assert [(i.id, i.name) for i in first.items] == [("1", "acme/app"), ("2", "acme/secret (private)")]
    second = await connector.discover(client, "repository", query=None, cursor=first.next_cursor)
    assert [i.name for i in second.items] == ["ada/notes"]
    assert second.next_cursor is None
    found = await connector.discover(client, "repository", query="NOTES", cursor=None)
    assert [i.id for i in found.items] == ["3"]
    # An installation removed meanwhile is skipped, not the one after it.
    del github.installations[10]
    again = await connector.discover(client, "repository", query=None, cursor=first.next_cursor)
    assert [i.name for i in again.items] == ["ada/notes"]
    moved_on = await connector.discover(
        client, "repository", query=None, cursor='{"installation": 10, "page": 2}'
    )
    assert [i.name for i in moved_on.items] == ["ada/notes"]
    github.installations[10] = [1, 2]
    for cursor in ("{}", '{"installation": 0, "page": 1}', "[1]", '{"installation": 11, "page": "1"}'):
        with pytest.raises(OperationError) as bad:
            await connector.discover(client, "repository", query=None, cursor=cursor)
        assert bad.value.code == "INVALID_CURSOR"
    assert await connector.describe(client, "repository", ["3", "1", "404", "../x"]) == {
        "3": "ada/notes",
        "1": "acme/app",
    }


def test_the_install_link_needs_a_valid_slug(monkeypatch):
    connector = GitHubConnector()
    monkeypatch.setattr(config(), "github_app_slug", None)
    assert connector.manage_link() is None
    monkeypatch.setattr(config(), "github_app_slug", "minerva-dev")
    assert connector.manage_link() == (
        "Choose repositories on GitHub",
        "https://github.com/apps/minerva-dev/installations/new",
    )
    monkeypatch.setattr(config(), "github_app_slug", "evil.com/x")
    assert connector.manage_link() is None


def test_github_is_offered_only_when_configured(monkeypatch):
    connector = registry.get("github")
    monkeypatch.setattr(config(), "github_client_id", None)
    assert not connection_oauth.available(connector)
    monkeypatch.setattr(config(), "github_client_id", "Iv1.x")
    monkeypatch.setattr(config(), "github_client_secret", config().secret_key)
    assert connection_oauth.available(connector)


@pytest.mark.django_db(transaction=True)
async def test_repositories_are_listed_and_read_by_grant(start, github):
    executor = await start({"1": ("read",)})
    outcome = await executor.invoke("github_list_repositories", {})
    assert [item["full_name"] for item in outcome.result["items"]] == ["acme/app"]
    outcome = await executor.invoke("github_get_repository", {"repository": "acme/app"})
    assert outcome.result["items"][0]["default_branch"] == "main"
    assert github.requests[-1].url.path == "/repositories/1"
    for name in ("acme/secret", "acme/missing"):
        assert await _refused(executor, "github_get_repository", {"repository": name}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_a_deny_on_one_repository_wins_over_the_wildcard(start):
    await start({})
    await _deny("2")()
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("github_list_repositories", {})
    assert [item["id"] for item in outcome.result["items"]] == [1]
    assert await _refused(executor, "github_list_issues", {"repository": "acme/secret"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_a_renamed_repository_is_authorized_by_its_id(start, github):
    executor = await start({"3": ("read",)})
    outcome = await executor.invoke("github_get_repository", {"repository": "ada/old-notes"})
    assert outcome.result["items"][0]["full_name"] == "ada/notes"
    # A redirect elsewhere, or to a repository that turns out to be another, is not followed.
    for location in (
        "https://evil.example/repositories/3",
        f"{API_URL}/repositories/3/../1",
        f"{API_URL}/users/3",
    ):
        github.renamed["ada/old-notes"] = location
        code = await _refused(executor, "github_get_repository", {"repository": "ada/old-notes"})
        assert code == "PROVIDER_FAILED"
    github.renamed["ada/old-notes"] = f"{API_URL}/repositories/3"
    github.repos[3]["id"] = 1
    assert (
        await _refused(executor, "github_get_repository", {"repository": "ada/old-notes"})
        == "PROVIDER_FAILED"
    )


@pytest.mark.django_db(transaction=True)
async def test_issues_skip_pull_requests_and_page_through_github_cursors(start, github, monkeypatch):
    executor = await start({"1": ("read",)})
    first = await executor.invoke("github_list_issues", {"repository": "acme/app", "limit": 2})
    # The page held issue 3 and pull request 2.
    assert [item["number"] for item in first.result["items"]] == [3]
    assert "body" not in first.result["items"][0]
    request = github.requests[-1]
    assert request.url.path == "/repositories/1/issues"
    assert (request.url.params["state"], request.url.params["sort"]) == ("open", "updated")
    second = await executor.invoke(
        "github_list_issues", {"repository": "acme/app", "limit": 2, "cursor": first.result["next_cursor"]}
    )
    assert [item["number"] for item in second.result["items"]] == [1]
    assert (github.requests[-1].url.params["page"], github.requests[-1].url.params["after"]) == ("2", "Y3Vy=")
    assert "next_cursor" not in second.result
    monkeypatch.setattr(client_module, "MAX_PAGE_RESPONSE", 1000)
    assert await _refused(executor, "github_list_issues", {"repository": "acme/app"}) == "PROVIDER_LIMIT"


@pytest.mark.django_db(transaction=True)
async def test_reading_an_issue_and_a_pull_request(start, github, monkeypatch):
    executor = await start({"1": ("read",)})
    [issue] = (await executor.invoke("github_get_issue", {"repository": "acme/app", "number": 3})).result[
        "items"
    ]
    assert (len(issue["body"]), issue["body_truncated"]) == (20_000, True)
    assert [c["body"] for c in issue["comment_list"]] == ["Same here", "+1"]
    assert issue["comments_truncated"] is False
    assert (
        await _refused(executor, "github_get_issue", {"repository": "acme/app", "number": 9}) == "NOT_FOUND"
    )

    monkeypatch.setattr(github_module, "MAX_PATCH_CHARS", 40)
    [pull] = (
        await executor.invoke("github_get_pull_request", {"repository": "acme/app", "number": 2})
    ).result["items"]
    assert [(f["patch"], f["patch_truncated"]) for f in pull["files"]] == [
        ("a" * 30, False),
        ("b" * 10, True),
    ]
    assert pull["files_truncated"] is True
    pulls = await executor.invoke("github_list_pull_requests", {"repository": "acme/app", "state": "all"})
    assert pulls.result["items"][0]["number"] == 2


@pytest.mark.django_db(transaction=True)
async def test_reading_files(start, github):
    executor = await start({"1": ("read",)})

    async def read(path, **extra):
        outcome = await executor.invoke("github_read_file", {"repository": "acme/app", "path": path, **extra})
        return outcome.result["items"][0]

    top = await read("")
    assert [e["path"] for e in top["entries"]] == ["README.md", "src"]
    assert top["entries_truncated"] is False
    readme = await read("README.md", max_chars=5, ref="v1.0")
    assert (readme["text"], readme["truncated"]) == ("# App", True)
    assert github.requests[-1].url.params["ref"] == "v1.0"
    assert (await read("src/zażółć.py"))["text"] == "print(1)\n"
    assert github.requests[-1].url.raw_path.startswith(b"/repositories/1/contents/src/za%C5%BC")
    for path, code in (
        ("big.bin", "FILE_TOO_LARGE"),
        ("logo.png", "UNSUPPORTED_FILE"),
        ("link", "UNSUPPORTED_FILE"),
        ("vendor", "UNSUPPORTED_FILE"),
        ("missing.txt", "NOT_FOUND"),
    ):
        assert await _refused(executor, "github_read_file", {"repository": "acme/app", "path": path}) == code
    sent = len(github.requests)
    for args in (
        {"path": "../other/x"},
        {"path": "/etc/passwd"},
        {"path": "a//b"},
        {"path": "a/./b"},
        {"path": "README.md", "ref": "../../x"},
        {"path": "README.md", "ref": "-flag"},
        {"repository": "acme/.."},
        {"repository": "acme/app/extra"},
    ):
        code = await _refused(executor, "github_read_file", {"repository": "acme/app", **args})
        assert code == "INVALID_ARGUMENTS", args
    assert len(github.requests) == sent


@pytest.mark.django_db(transaction=True)
async def test_writing_needs_create_and_sends_one_request(start, github):
    executor = await start({"1": ("read",)})
    assert "github_create_issue" not in executor.context.tools
    executor = await start({"1": ("read", "create")})
    outcome = await executor.invoke(
        "github_create_issue", {"repository": "acme/app", "title": "Idea", "body": "Details\nhere"}
    )
    assert outcome.result["items"][0]["number"] == 4
    [post] = github.posts
    assert post.url.path == "/repositories/1/issues"
    assert json.loads(post.content) == {"title": "Idea", "body": "Details\nhere"}
    outcome = await executor.invoke(
        "github_add_comment", {"repository": "acme/app", "number": 3, "body": "Thanks"}
    )
    assert (outcome.result["items"][0]["id"], outcome.result["items"][0]["number"]) == (99, 3)
    assert github.posts[-1].url.path == "/repositories/1/issues/3/comments"

    assert await _refused(executor, "github_create_issue", {"repository": "ada/notes", "title": "x"}) == (
        "POLICY_DENIED"
    )
    code = await _refused(executor, "github_create_issue", {"repository": "acme/app", "title": "two\nlines"})
    assert code == "INVALID_ARGUMENTS"
    assert len(github.posts) == 2


@pytest.mark.django_db(transaction=True)
async def test_a_write_the_app_may_not_make_is_reported_as_not_applied(start, github):
    executor = await start({"1": ("read", "create")})
    github.refuse_posts = httpx.Response(403, json={"message": "Resource not accessible by integration"})
    with pytest.raises(OperationError) as refused:
        await executor.invoke("github_create_issue", {"repository": "acme/app", "title": "x"})
    assert refused.value.code == "PROVIDER_FORBIDDEN"
    assert "not installed" in refused.value.message
    github.refuse_posts = None
    outcome = await executor.invoke("github_create_issue", {"repository": "acme/app", "title": "y"})
    assert outcome.result["items"][0]["title"] == "y"
    assert len(github.posts) == 2


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(
            403, json={"message": "API rate limit exceeded"}, headers={"x-ratelimit-remaining": "0"}
        ),
        httpx.Response(403, json={"message": "You have exceeded a secondary rate limit."}),
        httpx.Response(429, json={"message": "Too many"}, headers={"retry-after": "30"}),
    ],
)
async def test_rate_limits(start, github, response):
    executor = await start({"*": ("read",)})
    github.error = response
    assert (
        await _refused(executor, "github_get_repository", {"repository": "acme/app"})
        == "PROVIDER_RATE_LIMITED"
    )


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


def test_github_token_responses(token_endpoint):
    sent, responses = token_endpoint
    connector = registry.get("github")
    responses.append(
        httpx.Response(
            200, json={"access_token": "a", "refresh_token": "r", "expires_in": 28800, "scope": ""}
        )
    )
    tokens = connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    assert (tokens["access_token"], tokens["scopes"], tokens["refresh_token"]) == ("a", [], "r")
    assert sent[-1]["headers"]["Accept"] == "application/json"
    # GitHub reports a refused code with HTTP 200.
    for body in ({"error": "bad_verification_code"}, {"token_type": "bearer"}):
        responses.append(httpx.Response(200, json=body))
        with pytest.raises(ConnectionFlowError):
            connection_oauth.exchange_code(connector, code="c", flow=FLOW)
    responses.append(httpx.Response(200, text="access_token=a&scope="))
    with pytest.raises(ConnectionFlowError):
        connection_oauth.exchange_code(connector, code="c", flow=FLOW)


@pytest.fixture
def github_connection(scoped, user):
    connection = Connection(provider="github", owner=user, label="ada", external_account_id="42")
    connection.set_credentials(
        {
            "kind": "oauth2",
            "access_token": "old",
            "refresh_token": "r1",
            "expires_at": int(time.time()),
            "scopes": [],
        }
    )
    connection.save()
    return connection


def test_a_refused_github_refresh_needs_reconnecting(github_connection, token_endpoint):
    sent, responses = token_endpoint
    responses.append(httpx.Response(200, json={"error": "bad_refresh_token"}))
    with pytest.raises(OperationError) as caught:
        connection_credentials.access_secret(github_connection.id)
    assert caught.value.code == "CONNECTION_UNAUTHORIZED"
    assert sent[-1]["headers"]["Accept"] == "application/json"


def test_a_misconfigured_client_keeps_the_connection(github_connection, token_endpoint):
    _, responses = token_endpoint
    responses.append(httpx.Response(200, json={"error": "incorrect_client_credentials"}))
    with pytest.raises(OperationError) as caught:
        connection_credentials.access_secret(github_connection.id)
    assert caught.value.code == "PROVIDER_UNAVAILABLE"
    github_connection.refresh_from_db()
    assert github_connection.credentials()["refresh_token"] == "r1"
    assert github_connection.status == Connection.Status.ACTIVE
    responses.append(
        httpx.Response(200, json={"access_token": "new", "refresh_token": "r2", "expires_in": 28800})
    )
    assert connection_credentials.access_secret(github_connection.id).value == "new"
    github_connection.refresh_from_db()
    assert github_connection.credentials()["refresh_token"] == "r2"


def test_apps_without_an_oauth_client_are_not_offered(api, workspace, monkeypatch):
    monkeypatch.setattr(config(), "github_client_id", None)
    listed = api.get(f"/api/workspaces/{workspace.id}/connectors").json()
    assert "github" not in {c["slug"] for c in listed}
    monkeypatch.setattr(config(), "github_client_id", "Iv1.x")
    monkeypatch.setattr(config(), "github_client_secret", config().secret_key)
    listed = api.get(f"/api/workspaces/{workspace.id}/connectors").json()
    assert "github" in {c["slug"] for c in listed}
