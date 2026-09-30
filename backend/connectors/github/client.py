import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from connectors.base import OperationError
from connectors.http import ProviderHTTP, default_forbidden

API_URL = "https://api.github.com"
# The largest file GitHub returns inline, and room for its base64 encoding in the JSON around it.
MAX_INLINE_FILE = 1024 * 1024
MAX_CONTENTS_RESPONSE = 2 * 1024 * 1024
# A page of issues, pull requests or changed files, whose bodies and diffs can be large.
MAX_PAGE_RESPONSE = 10 * 1024 * 1024
NEXT_LINK = re.compile(r'<([^>]+)>;\s*rel="next"')


def segment(value: str) -> str:
    return quote(value, safe="")


def forbidden(provider: str, response: httpx.Response) -> OperationError:
    """GitHub reports rate limits, and what the App may not do, as 403."""
    try:
        message = str(response.json().get("message", ""))
    except ValueError, AttributeError:
        message = ""
    if (
        response.headers.get("x-ratelimit-remaining") == "0"
        or "retry-after" in response.headers
        or "rate limit" in message.lower()
    ):
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    if "not accessible by integration" in message.lower():
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "The Minerva GitHub App may not do this here: it is not installed on this repository, or "
            "lacks the permission.",
        )
    return default_forbidden(provider, response)


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class User(Model):
    id: int
    login: str = ""


class Owner(Model):
    login: str = ""


class Repository(Model):
    id: int
    full_name: str
    owner: Owner | None = None
    private: bool = False
    description: str | None = None
    default_branch: str | None = None
    html_url: str | None = None
    open_issues_count: int | None = None
    archived: bool = False
    fork: bool = False
    pushed_at: str | None = None


class Installation(Model):
    id: int


class Installations(Model):
    installations: list[Installation] = []


class InstallationRepositories(Model):
    repositories: list[Repository] = []


class Label(Model):
    name: str = ""


class Issue(Model):
    number: int
    title: str = ""
    state: str = ""
    body: str | None = None
    user: Owner | None = None
    labels: list[Label] = []
    comments: int = 0
    created_at: str | None = None
    updated_at: str | None = None
    closed_at: str | None = None
    html_url: str | None = None
    pull_request: dict[str, Any] | None = None


class Comment(Model):
    id: int
    body: str | None = None
    user: Owner | None = None
    created_at: str | None = None
    html_url: str | None = None


class Branch(Model):
    ref: str = ""


class Pull(Model):
    number: int
    title: str = ""
    state: str = ""
    body: str | None = None
    user: Owner | None = None
    draft: bool = False
    merged_at: str | None = None
    head: Branch | None = None
    base: Branch | None = None
    created_at: str | None = None
    updated_at: str | None = None
    html_url: str | None = None
    changed_files: int | None = None
    additions: int | None = None
    deletions: int | None = None


class PullFile(Model):
    filename: str
    status: str = ""
    additions: int = 0
    deletions: int = 0
    patch: str | None = None


class Entry(Model):
    type: str
    name: str = ""
    path: str = ""
    size: int = 0
    encoding: str | None = None
    content: str | None = None
    submodule_git_url: str | None = None
    html_url: str | None = None


Contents = TypeAdapter(Entry | list[Entry])


@dataclass(frozen=True, slots=True)
class Page[T]:
    items: list[T]
    # GitHub's next page, as the query parameters its Link header names; None on the last page.
    next: dict[str, str] | None


def _next(response: httpx.Response) -> dict[str, str] | None:
    match = NEXT_LINK.search(response.headers.get("link", ""))
    if match is None:
        return None
    query = parse_qs(urlsplit(match.group(1)).query)
    return {key: query[key][0] for key in ("page", "after") if query.get(key)} or None


class GitHubClient:
    """Thin async client for the GitHub REST API, as a GitHub App acting for a user. Repositories are
    addressed by id (`/repositories/{id}`), so a rename between two requests cannot change which
    repository a request reaches. Responses are validated before use."""

    def __init__(
        self, access_token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._base_url = base_url.rstrip("/")
        self._http = ProviderHTTP(
            "GitHub",
            base_url=self._base_url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            transport=transport,
            forbidden=forbidden,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def _validate(self, model: Any, data: Any) -> Any:
        try:
            return model.model_validate(data) if isinstance(model, type) else model.validate_python(data)
        except ValidationError as error:
            raise self._http.unexpected() from error

    async def _get(self, model: Any, path: str, **params: Any) -> Any:
        return self._validate(model, await self._http.json("GET", path, params=params))

    async def _page[M: BaseModel](self, model: type[M], path: str, params: dict[str, Any]) -> Page[M]:
        response = await self._http.bounded(
            path,
            limit=MAX_PAGE_RESPONSE,
            too_large=OperationError("PROVIDER_LIMIT", "GitHub returned more than Minerva reads at once."),
            params=params,
        )
        try:
            data = response.json()
        except ValueError as error:
            raise self._http.unexpected() from error
        items = self._validate(TypeAdapter(list[model]), data)
        return Page(items, _next(response))

    async def user(self) -> User:
        return await self._get(User, "/user")

    async def installations(self, page: int) -> list[Installation]:
        found = await self._get(Installations, "/user/installations", per_page=100, page=page)
        return found.installations

    async def installation_repositories(
        self, installation_id: int, *, page: int, per_page: int
    ) -> list[Repository]:
        found = await self._get(
            InstallationRepositories,
            f"/user/installations/{installation_id}/repositories",
            per_page=per_page,
            page=page,
        )
        return found.repositories

    async def find(self, owner: str, name: str) -> Repository:
        """The repository with this name. A renamed or transferred one redirects to its id."""
        response = await self._http.request("GET", f"/repos/{segment(owner)}/{segment(name)}", redirects=True)
        if response.is_redirect:
            location = response.headers.get("location", "")
            match = re.fullmatch(re.escape(self._base_url) + r"/repositories/(\d{1,20})", location)
            if match is None:
                raise self._http.unexpected()
            repository = await self.repository(match.group(1))
            if str(repository.id) != match.group(1):
                raise self._http.unexpected()
            return repository
        try:
            return self._validate(Repository, response.json())
        except ValueError as error:
            raise self._http.unexpected() from error

    async def repository(self, repo_id: str) -> Repository:
        return await self._get(Repository, f"/repositories/{segment(repo_id)}")

    async def issues(self, repo_id: str, params: dict[str, Any]) -> Page[Issue]:
        return await self._page(Issue, f"/repositories/{segment(repo_id)}/issues", params)

    async def issue(self, repo_id: str, number: int) -> Issue:
        return await self._get(Issue, f"/repositories/{segment(repo_id)}/issues/{number}")

    async def comments(self, repo_id: str, number: int, *, per_page: int) -> list[Comment]:
        page = await self._page(
            Comment, f"/repositories/{segment(repo_id)}/issues/{number}/comments", {"per_page": per_page}
        )
        return page.items

    async def pulls(self, repo_id: str, params: dict[str, Any]) -> Page[Pull]:
        return await self._page(Pull, f"/repositories/{segment(repo_id)}/pulls", params)

    async def pull(self, repo_id: str, number: int) -> Pull:
        return await self._get(Pull, f"/repositories/{segment(repo_id)}/pulls/{number}")

    async def pull_files(self, repo_id: str, number: int, *, per_page: int) -> list[PullFile]:
        page = await self._page(
            PullFile, f"/repositories/{segment(repo_id)}/pulls/{number}/files", {"per_page": per_page}
        )
        return page.items

    async def contents(self, repo_id: str, path: str, ref: str | None) -> Entry | list[Entry]:
        encoded = "/".join(segment(part) for part in path.split("/")) if path else ""
        params = {"ref": ref} if ref else {}
        body = await self._http.download(
            f"/repositories/{segment(repo_id)}/contents/{encoded}", limit=MAX_CONTENTS_RESPONSE, params=params
        )
        try:
            data = json.loads(body)
        except ValueError as error:
            raise self._http.unexpected() from error
        return self._validate(Contents, data)

    async def create_issue(self, repo_id: str, title: str, body: str | None) -> Issue:
        payload: dict[str, Any] = {"title": title}
        if body:
            payload["body"] = body
        data = await self._http.json("POST", f"/repositories/{segment(repo_id)}/issues", json=payload)
        return self._validate(Issue, data)

    async def comment(self, repo_id: str, number: int, body: str) -> Comment:
        data = await self._http.json(
            "POST", f"/repositories/{segment(repo_id)}/issues/{number}/comments", json={"body": body}
        )
        return self._validate(Comment, data)
