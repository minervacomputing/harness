"""GitHub, through a GitHub App acting for the user. Resources are repositories, by GitHub's numeric id.

Tokens are user-to-server tokens, which expire and rotate. The App has no scopes: what a token can reach
is the intersection of the App's permissions, the repositories the App is installed on, and the user's own
access (plus public repositories, which anyone may read). The connector therefore declares no consent, and
the user picks repositories twice: on GitHub (the installation, linked from `manage_link`) and in Minerva
(grants), which narrow that further.

Tools name repositories as "owner/name"; the name is resolved to the id once, before authorization, the
id is what is authorized, and every later request addresses `/repositories/<id>/...`, so a rename or a new
repository taking the name cannot redirect a call. A renamed or transferred repository answers with a
redirect, which is followed only to `/repositories/<id>` on the API host. A repository the account cannot
see is refused like one without a grant. Grants follow a repository through renames and transfers.

Listing pages are read with a byte limit. The executor still returns a continuation token when every
record of a provider page was filtered out, so a model can tell that hidden repositories exist, but not
which.

GitHub's token endpoint answers form-encoded unless asked for JSON, and reports refusals as HTTP 200 with
an `error` field. Token requests (connections/oauth.py) therefore ask for JSON; a refused refresh
(`bad_refresh_token`) marks the connection for reconnecting, while other refusals, such as a misconfigured
client, leave it unchanged (connections/credentials.py).
"""

import asyncio
import base64
import json
import re
from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import (
    Account,
    ActionSpec,
    Binding,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Enumerate,
    Need,
    OAuth2,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ResourceKind,
    ScopedRecord,
    denied,
)
from connectors.github.client import (
    MAX_INLINE_FILE,
    Comment,
    Entry,
    GitHubClient,
    Issue,
    Pull,
    Repository,
)
from connectors.text import CONTROL, single_line, truncate
from minerva.config import config

REPOSITORY = "repository"
MAX_BODY = 20_000
MAX_COMMENT_BODY = 4_000
MAX_COMMENTS = 30
MAX_PULL_FILES = 100
MAX_PATCH_CHARS = 50_000
# GitHub lists at most this many directory entries, without pagination.
MAX_DIRECTORY_ENTRIES = 1000
MAX_INSTALLATION_PAGES = 5
MAX_DISCOVERY_PAGES = 10
MAX_DESCRIBE_CONCURRENCY = 8


def _clean_text(value: str) -> str:
    if CONTROL.search(value):
        raise ValueError("must not contain control characters")
    return value


def _repository_name(value: str) -> str:
    if value.partition("/")[2] in {".", ".."}:
        raise ValueError('must be "owner/name"')
    return value


def _path(value: str) -> str:
    if value == "":
        return value
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts) or CONTROL.search(value) or "\n" in value:
        raise ValueError('must be a path inside the repository, like "docs/intro.md", or "" for the top')
    return value


def _ref(value: str) -> str:
    if ".." in value or value.startswith(("/", "-")) or value.endswith(("/", ".lock")) or "//" in value:
        raise ValueError("is not a valid branch, tag, or commit")
    return value


RepositoryName = Annotated[
    str,
    Field(
        min_length=3,
        max_length=140,
        pattern=r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$",
        description='The repository as "owner/name".',
    ),
    AfterValidator(_repository_name),
]
Number = Annotated[int, Field(ge=1, le=10**9)]
Cursor = Annotated[str, Field(max_length=1000)]
State = Annotated[str, Field(pattern=r"^(open|closed|all)$")]


async def _resolve(binding: Binding, repository: str) -> Resource:
    """The repository a call names, as the resource that is authorized. Repositories the account cannot
    see are refused like repositories without a grant."""
    client: GitHubClient = binding.client
    owner, _, name = repository.partition("/")
    try:
        found = await client.find(owner, name)
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise denied() from None
        raise
    return binding.resource(REPOSITORY, str(found.id))


def _repository(repository: Repository) -> dict[str, Any]:
    return {
        "id": repository.id,
        "full_name": repository.full_name,
        "private": repository.private,
        "description": repository.description,
        "default_branch": repository.default_branch,
        "open_issues_and_pull_requests": repository.open_issues_count,
        "archived": repository.archived,
        "fork": repository.fork,
        "pushed_at": repository.pushed_at,
        "url": repository.html_url,
    }


def _issue(issue: Issue, *, body: bool = False) -> dict[str, Any]:
    data: dict[str, Any] = {
        "number": issue.number,
        "type": "pull_request" if issue.pull_request is not None else "issue",
        "title": issue.title,
        "state": issue.state,
        "author": issue.user.login if issue.user else None,
        "labels": [label.name for label in issue.labels],
        "comments": issue.comments,
        "created_at": issue.created_at,
        "updated_at": issue.updated_at,
        "closed_at": issue.closed_at,
        "url": issue.html_url,
    }
    if body:
        data["body"], data["body_truncated"] = truncate(issue.body, MAX_BODY)
    return data


def _comment(comment: Comment) -> dict[str, Any]:
    text, truncated = truncate(comment.body, MAX_COMMENT_BODY)
    return {
        "id": comment.id,
        "author": comment.user.login if comment.user else None,
        "created_at": comment.created_at,
        "body": text,
        "body_truncated": truncated,
        "url": comment.html_url,
    }


def _pull(pull: Pull, *, body: bool = False) -> dict[str, Any]:
    data: dict[str, Any] = {
        "number": pull.number,
        "title": pull.title,
        "state": "merged" if pull.merged_at else pull.state,
        "draft": pull.draft,
        "author": pull.user.login if pull.user else None,
        "head": pull.head.ref if pull.head else None,
        "base": pull.base.ref if pull.base else None,
        "created_at": pull.created_at,
        "updated_at": pull.updated_at,
        "url": pull.html_url,
    }
    if body:
        data["body"], data["body_truncated"] = truncate(pull.body, MAX_BODY)
        data |= {
            "changed_files": pull.changed_files,
            "additions": pull.additions,
            "deletions": pull.deletions,
        }
    return data


def _page_params(cursor: str | None) -> dict[str, str]:
    """GitHub's next page, from a cursor this connector returned: a page number or an opaque `after`."""
    if cursor is None:
        return {}
    try:
        state = json.loads(cursor)
    except ValueError:
        state = None
    if (
        not isinstance(state, dict)
        or not set(state) <= {"page", "after"}
        or not all(isinstance(v, str) and 0 < len(v) <= 500 and v.isprintable() for v in state.values())
        or ("page" in state and not (state["page"].isdigit() and len(state["page"]) <= 6))
    ):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return state


def _cursor(params: dict[str, str] | None) -> str | None:
    return json.dumps(params, sort_keys=True) if params else None


class ListRepositories(OperationInput):
    limit: Annotated[int, Field(ge=1, le=100)] = 30
    cursor: Cursor | None = None


def _repositories_cursor(cursor: str | None) -> tuple[int, int]:
    """(installation id, page) from a cursor this connector returned; (0, 1) to start."""
    if cursor is None:
        return 0, 1
    try:
        state = json.loads(cursor)
        installation, page = state["installation"], state["page"]
    except ValueError, KeyError, TypeError:
        installation = page = None
    if not (
        isinstance(installation, int)
        and isinstance(page, int)
        and 0 < installation < 10**15
        and 0 < page < 10_000
    ):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return installation, page


async def _installations(client: GitHubClient) -> list[int]:
    ids: list[int] = []
    for page in range(1, MAX_INSTALLATION_PAGES + 1):
        found = await client.installations(page)
        ids.extend(installation.id for installation in found)
        if len(found) < 100:
            return sorted(set(ids))
    raise OperationError(
        "PROVIDER_LIMIT", "The Minerva GitHub App has more installations than Minerva can list."
    )


async def _repositories_page(
    client: GitHubClient, cursor: str | None, limit: int
) -> tuple[list[Repository], str | None]:
    """One page of the repositories the App is installed on and the user can access, installation after
    installation in id order. The cursor names the installation by id, so installations added or removed
    meanwhile do not shift it; one that was removed is skipped."""
    installation, page = _repositories_cursor(cursor)
    installations = await _installations(client)
    remaining = [i for i in installations if i >= installation]
    if not remaining:
        return [], None
    if remaining[0] != installation:
        page = 1
    found = await client.installation_repositories(remaining[0], page=page, per_page=limit)
    if len(found) == limit:
        following = {"installation": remaining[0], "page": page + 1}
    elif len(remaining) > 1:
        following = {"installation": remaining[1], "page": 1}
    else:
        following = None
    return found, json.dumps(following) if following else None


async def _prepare_list_repositories(binding: Binding, data: ListRepositories) -> Prepared:
    async def execute() -> ProviderOutput:
        found, following = await _repositories_page(binding.client, data.cursor, data.limit)
        records = [
            ScopedRecord(binding.resource(REPOSITORY, str(repository.id)), _repository(repository))
            for repository in found
        ]
        return ProviderOutput(records, following)

    return Prepared([Enumerate(REPOSITORY, "read")], execute)


LIST_REPOSITORIES = Operation(
    name="list_repositories",
    title="List repositories",
    description=(
        "List the GitHub repositories you may read. To get the next page, repeat the call with "
        "identical arguments plus the returned next_cursor."
    ),
    input_model=ListRepositories,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_list_repositories,
    paginated=True,
)


class GetRepository(OperationInput):
    repository: RepositoryName


async def _prepare_get_repository(binding: Binding, data: GetRepository) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        fresh = await binding.client.repository(resource.id)
        return ProviderOutput([ScopedRecord(resource, _repository(fresh))])

    return Prepared([Need(resource, "read")], execute)


GET_REPOSITORY = Operation(
    name="get_repository",
    title="Get a repository",
    description="Read a repository's details, such as its default branch and description.",
    input_model=GetRepository,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_get_repository,
)


class ListIssues(OperationInput):
    repository: RepositoryName
    state: State = "open"
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_list_issues(binding: Binding, data: ListIssues) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        params = {
            "state": data.state,
            "sort": "updated",
            "direction": "desc",
            "per_page": data.limit,
            **_page_params(data.cursor),
        }
        page = await binding.client.issues(resource.id, params)
        # GitHub lists pull requests as issues too; they have their own tool.
        records = [
            ScopedRecord(resource, _issue(issue)) for issue in page.items if issue.pull_request is None
        ]
        return ProviderOutput(records, _cursor(page.next))

    return Prepared([Need(resource, "read")], execute)


LIST_ISSUES = Operation(
    name="list_issues",
    title="List issues",
    description=(
        "List issues in a repository, most recently updated first, without pull requests. To get "
        "the next page, repeat the call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListIssues,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_list_issues,
    paginated=True,
)


class GetIssue(OperationInput):
    repository: RepositoryName
    number: Number


async def _prepare_get_issue(binding: Binding, data: GetIssue) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        client: GitHubClient = binding.client
        issue = await client.issue(resource.id, data.number)
        comments = (
            await client.comments(resource.id, data.number, per_page=MAX_COMMENTS) if issue.comments else []
        )
        record = {
            **_issue(issue, body=True),
            "comment_list": [_comment(comment) for comment in comments],
            "comments_truncated": issue.comments > len(comments),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_ISSUE = Operation(
    name="get_issue",
    title="Read an issue",
    description=(
        f"Read an issue or pull request conversation: its text and its first {MAX_COMMENTS} comments."
    ),
    input_model=GetIssue,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_get_issue,
)


class ListPullRequests(OperationInput):
    repository: RepositoryName
    state: State = "open"
    limit: Annotated[int, Field(ge=1, le=50)] = 20
    cursor: Cursor | None = None


async def _prepare_list_pull_requests(binding: Binding, data: ListPullRequests) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        params = {
            "state": data.state,
            "sort": "updated",
            "direction": "desc",
            "per_page": data.limit,
            **_page_params(data.cursor),
        }
        page = await binding.client.pulls(resource.id, params)
        return ProviderOutput(
            [ScopedRecord(resource, _pull(pull)) for pull in page.items], _cursor(page.next)
        )

    return Prepared([Need(resource, "read")], execute)


LIST_PULL_REQUESTS = Operation(
    name="list_pull_requests",
    title="List pull requests",
    description=(
        "List pull requests in a repository, most recently updated first. To get the next page, "
        "repeat the call with identical arguments plus the returned next_cursor."
    ),
    input_model=ListPullRequests,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_list_pull_requests,
    paginated=True,
)


class GetPullRequest(OperationInput):
    repository: RepositoryName
    number: Number


async def _prepare_get_pull_request(binding: Binding, data: GetPullRequest) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        client: GitHubClient = binding.client
        pull = await client.pull(resource.id, data.number)
        files = await client.pull_files(resource.id, data.number, per_page=MAX_PULL_FILES)
        budget = MAX_PATCH_CHARS
        listed = []
        for file in files:
            patch = file.patch
            patch_truncated = False
            if patch is not None:
                patch, patch_truncated = truncate(patch, max(budget, 0))
                budget -= len(patch or "")
            listed.append(
                {
                    "path": file.filename,
                    "status": file.status,
                    "additions": file.additions,
                    "deletions": file.deletions,
                    # None when GitHub gives no patch (binary or very large changes).
                    "patch": patch,
                    "patch_truncated": patch_truncated,
                }
            )
        record = {
            **_pull(pull, body=True),
            "files": listed,
            "files_truncated": (pull.changed_files or 0) > len(files),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_PULL_REQUEST = Operation(
    name="get_pull_request",
    title="Read a pull request",
    description=(
        f"Read a pull request with its first {MAX_PULL_FILES} changed files and their diffs "
        f"(at most {MAX_PATCH_CHARS} characters of diff in total). Use get_issue for its comments."
    ),
    input_model=GetPullRequest,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_get_pull_request,
)


class ReadFile(OperationInput):
    repository: RepositoryName
    path: Annotated[
        str,
        Field(
            max_length=1000, description='A path inside the repository, like "src/app.py"; "" lists the top.'
        ),
        AfterValidator(_path),
    ] = ""
    ref: (
        Annotated[
            str,
            Field(
                min_length=1,
                max_length=255,
                pattern=r"^[A-Za-z0-9._/-]+$",
                description="A branch, tag, or commit. Defaults to the default branch.",
            ),
            AfterValidator(_ref),
        ]
        | None
    ) = None
    max_chars: Annotated[int, Field(ge=1, le=100_000)] = 20_000


def _unsupported(message: str) -> OperationError:
    return OperationError("UNSUPPORTED_FILE", message)


def _file(entry: Entry, max_chars: int) -> dict[str, Any]:
    if entry.type == "submodule" or entry.submodule_git_url:
        raise _unsupported("This is a submodule, another repository. Minerva does not follow it.")
    if entry.type == "symlink":
        raise _unsupported("This is a link to a path outside the repository or to a directory.")
    if entry.type != "file":
        raise _unsupported("Minerva cannot read this kind of entry.")
    if entry.size > MAX_INLINE_FILE or entry.encoding != "base64" or entry.content is None:
        raise OperationError("FILE_TOO_LARGE", f"Minerva reads files up to {MAX_INLINE_FILE} bytes.")
    try:
        raw = base64.b64decode(entry.content)
    except ValueError:
        raise OperationError("PROVIDER_FAILED", "GitHub returned an unexpected response.") from None
    if b"\x00" in raw:
        raise _unsupported("This looks like a binary file. Minerva reads text files.")
    text = raw.decode("utf-8", errors="replace")
    return {
        "path": entry.path,
        "type": "file",
        "size": entry.size,
        "text": text[:max_chars],
        "truncated": len(text) > max_chars,
        "url": entry.html_url,
    }


async def _prepare_read_file(binding: Binding, data: ReadFile) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        found = await binding.client.contents(resource.id, data.path, data.ref)
        if isinstance(found, list):
            record: dict[str, Any] = {
                "path": data.path,
                "type": "dir",
                "entries": [{"name": e.name, "path": e.path, "type": e.type, "size": e.size} for e in found],
                "entries_truncated": len(found) >= MAX_DIRECTORY_ENTRIES,
            }
        else:
            record = _file(found, data.max_chars)
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


READ_FILE = Operation(
    name="read_file",
    title="Read a file",
    description=("Read a text file from a repository, or list a directory. Files up to 1 MB can be read."),
    input_model=ReadFile,
    needs=((REPOSITORY, "read"),),
    prepare=_prepare_read_file,
)


WRITE_WARNING = (
    "Everyone who can see the repository sees what you write; mentions notify people, subscribers are "
    "notified, and the repository's automation may run. The number of writes per run is limited."
)


class CreateIssue(OperationInput):
    repository: RepositoryName
    title: Annotated[str, Field(min_length=1, max_length=256), AfterValidator(single_line)]
    body: Annotated[str, Field(max_length=MAX_BODY), AfterValidator(_clean_text)] | None = None


async def _prepare_create_issue(binding: Binding, data: CreateIssue) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        issue = await binding.client.create_issue(resource.id, data.title, data.body)
        return ProviderOutput([ScopedRecord(resource, _issue(issue))])

    return Prepared([Need(resource, "create")], execute)


CREATE_ISSUE = Operation(
    name="create_issue",
    title="Open an issue",
    description=(
        "Open an issue with a title and text in a repository where you have create permission. "
        + WRITE_WARNING
    ),
    input_model=CreateIssue,
    needs=((REPOSITORY, "create"),),
    prepare=_prepare_create_issue,
    mutates=True,
)


class AddComment(OperationInput):
    repository: RepositoryName
    number: Annotated[int, Field(ge=1, le=10**9, description="The issue or pull request number.")]
    body: Annotated[str, Field(min_length=1, max_length=MAX_BODY), AfterValidator(_clean_text)]


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    resource = await _resolve(binding, data.repository)

    async def execute() -> ProviderOutput:
        comment = await binding.client.comment(resource.id, data.number, data.body)
        return ProviderOutput([ScopedRecord(resource, {**_comment(comment), "number": data.number})])

    return Prepared([Need(resource, "create")], execute)


ADD_COMMENT = Operation(
    name="add_comment",
    title="Comment",
    description=(
        "Comment on an issue or pull request in a repository where you have create permission. "
        + WRITE_WARNING
    ),
    input_model=AddComment,
    needs=((REPOSITORY, "create"),),
    prepare=_prepare_add_comment,
    mutates=True,
)


class GitHubConnector(Connector):
    slug = "github"
    name = "GitHub"
    kinds = (ResourceKind(REPOSITORY, "Repository", ("read", "create"), wildcard=True),)
    actions = (
        ActionSpec("read", "Read code, issues and pull requests"),
        ActionSpec("create", "Open issues and comment", requires="read"),
    )
    # A GitHub App: what it may do is set by the App's permissions and where it is installed, not scopes.
    auth = OAuth2(
        app="github",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",  # noqa: S106
        scopes=(),
    )

    operations = (
        LIST_REPOSITORIES,
        GET_REPOSITORY,
        LIST_ISSUES,
        GET_ISSUE,
        LIST_PULL_REQUESTS,
        GET_PULL_REQUEST,
        READ_FILE,
        CREATE_ISSUE,
        ADD_COMMENT,
    )

    def client(self, access_token: str) -> GitHubClient:
        return GitHubClient(access_token)

    def manage_link(self) -> tuple[str, str] | None:
        slug = config().github_app_slug
        if not slug or not re.fullmatch(r"[a-z0-9-]{1,100}", slug):
            return None
        return "Choose repositories on GitHub", f"https://github.com/apps/{slug}/installations/new"

    async def account(self, client: GitHubClient) -> Account:
        # The numeric id is stable; the login can change.
        user = await client.user()
        return Account(id=str(user.id), label=user.login or "GitHub")

    async def discover(
        self, client: GitHubClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            found, following = await _repositories_page(client, cursor, 100)
            return DiscoveryPage([_item(r) for r in found], following)
        text = query.casefold()
        matches: list[Repository] = []
        following = None
        for _ in range(MAX_DISCOVERY_PAGES):
            found, following = await _repositories_page(client, following, 100)
            matches.extend(r for r in found if text in r.full_name.casefold())
            if following is None:
                return DiscoveryPage([_item(r) for r in matches])
        raise OperationError("PROVIDER_LIMIT", "There are more repositories than Minerva can search.")

    async def describe(self, client: GitHubClient, kind: str, ids: list[str]) -> dict[str, str]:
        limit = asyncio.Semaphore(MAX_DESCRIBE_CONCURRENCY)

        async def one(repo_id: str) -> Repository | None:
            if not repo_id.isdigit():
                return None
            async with limit:
                try:
                    return await client.repository(repo_id)
                except OperationError as error:
                    if error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN"}:
                        return None
                    raise

        found = await asyncio.gather(*(one(repo_id) for repo_id in ids))
        return {str(r.id): _item(r).name for r in found if r is not None and str(r.id) in ids}


def _item(repository: Repository) -> DiscoveryItem:
    suffix = " (private)" if repository.private else ""
    return DiscoveryItem(str(repository.id), f"{repository.full_name}{suffix}")
