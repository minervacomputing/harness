"""Sentry's operations, all reads: projects, issue search, single issues and their events.

Issues are named by id or short id ("WEB-1A3"). `prepare` reads the issue, which tells its project, and
authorizes there; the agent gets that read only if allowed. An issue never changes project (Sentry merges
issues only within one), so it is not read again. An issue the account cannot see, or one too large to
read, is refused like an ungranted one.

Search takes fields, never Sentry's query syntax: Minerva builds the query, names the one project in the
request, and refuses a response with an issue from any other project.

An event is shown in part. Exceptions with their innermost stack frames and the source lines around them,
an allowlist of tags, the runtime, OS and browser, and the request's method and address without its query
are shown. Local variables, request headers, cookies and bodies, the user, breadcrumbs and attachments are
left out. What an application put in messages, exception values, source lines, transaction names and request
paths is shown as it is, links to other issues included.
"""

import re
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ScopedRecord,
    denied,
)
from connectors.sentry.client import EVENT_ID, ID, SLUG, Issue, Project, SentryClient
from connectors.text import single_line, truncate

PROJECT = "project"
# Unseen issues and projects, and ones too large to read: an error naming either would say they exist.
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN", "RESPONSE_TOO_LARGE"})
MAX_SHORT = 500
MAX_MESSAGE = 5_000
MAX_VALUE = 2_000
MAX_LINE = 500
MAX_EXCEPTIONS = 10
MAX_FRAMES = 40
CONTEXT_LINES = 3
MAX_TAGS = 50

_SHORT_ID = re.compile(r"\A[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,13}\Z")
_PERMALINK = re.compile(r"^https://([a-z0-9-]+\.)?sentry\.io/")
SORTS = {"last_seen": "date", "first_seen": "new", "events": "freq", "users": "user"}
# Tags that describe where an event happened, for events and an issue's tag names. Others can carry users,
# addresses, host names and whatever an application chose to tag.
TAGS = frozenset(
    {
        "environment",
        "release",
        "dist",
        "level",
        "handled",
        "mechanism",
        "logger",
        "transaction",
        "browser",
        "browser.name",
        "os",
        "os.name",
        "runtime",
        "runtime.name",
        "device",
        "device.family",
    }
)
CONTEXTS = ("runtime", "os", "browser")


def _project_name(value: str) -> str:
    folded = value.lower()
    if ID.match(folded) or SLUG.match(folded):
        return folded
    raise ValueError('must be a project id or slug, such as "web"')


def _issue_name(value: str) -> str:
    upper = value.upper()
    if ID.match(upper) or _SHORT_ID.match(upper):
        return upper
    raise ValueError('must be an issue id, or a short id such as "WEB-1A3"')


def _event_name(value: str) -> str:
    folded = value.lower().replace("-", "")
    if folded in {"latest", "oldest", "recommended"} or EVENT_ID.match(folded):
        return folded
    raise ValueError('must be "latest", "oldest", "recommended", or an event id')


def _phrase(value: str) -> str:
    single_line(value)
    if '"' in value or "\\" in value:
        raise ValueError("must not contain quotes or backslashes")
    return value


ProjectName = Annotated[
    str,
    Field(min_length=1, max_length=100, description="A project's id or slug, from list_projects."),
    AfterValidator(_project_name),
]
IssueName = Annotated[
    str,
    Field(min_length=1, max_length=80, description='An issue\'s id, or its short id such as "WEB-1A3".'),
    AfterValidator(_issue_name),
]
Cursor = Annotated[str, Field(max_length=200)]
ProjectQuery = Annotated[
    str,
    Field(min_length=1, max_length=100, description="Words in the project's name or slug."),
    AfterValidator(single_line),
]
Phrase = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        description="A phrase the issue's message or title contains; no quotes or backslashes.",
    ),
    AfterValidator(_phrase),
]
Environment = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[^\s/]+$", description="An environment's name."),
    AfterValidator(single_line),
]


def unseen(error: OperationError) -> bool:
    return error.code in HIDDEN


def short(value: Any, limit: int = MAX_SHORT) -> str | None:
    if not isinstance(value, str):
        return None
    shown, _ = truncate(" ".join(value.split()), limit)
    return shown or None


def _text(value: Any, limit: int) -> tuple[str | None, bool]:
    return truncate(value if isinstance(value, str) and value else None, limit)


def _number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def project_resource(binding: Binding, project: str) -> Resource:
    if not ID.match(project):
        raise binding.client.unexpected()
    return binding.resource(PROJECT, project)


async def resolve_project(binding: Binding, name: str) -> tuple[Resource, Project]:
    """The project a call names, by id or slug. One the account cannot see is refused like an ungranted one."""
    client: SentryClient = binding.client
    try:
        project = await client.project(name)
    except OperationError as error:
        if unseen(error):
            raise denied() from None
        raise
    if not ID.match(name) and project.slug != name:
        raise client.unexpected()
    return project_resource(binding, project.id), project


async def resolve_issue(binding: Binding, name: str) -> tuple[Resource, Issue]:
    """The issue a call names, read in full, and its project. One the account cannot see is refused like one
    in an ungranted project."""
    client: SentryClient = binding.client
    try:
        issue_id = name if ID.match(name) else await client.short_id(name)
        issue = await client.issue(issue_id)
    except OperationError as error:
        if unseen(error):
            raise denied() from None
        raise
    return project_resource(binding, issue.project.id), issue


def _issue(issue: Issue) -> dict[str, Any]:
    assignee = issue.assignedTo
    return {
        "id": issue.id,
        "short_id": short(issue.shortId),
        "title": short(issue.title),
        "culprit": short(issue.culprit),
        "level": issue.level,
        "status": issue.status,
        "substatus": issue.substatus,
        "priority": issue.priority,
        "events": _number(issue.count),
        "users": issue.userCount,
        "first_seen": issue.firstSeen,
        "last_seen": issue.lastSeen,
        "platform": short(issue.platform),
        "project": {"id": issue.project.id, "slug": short(issue.project.slug)},
        "assignee": {"type": assignee.type, "name": short(assignee.name)} if assignee else None,
        "link": issue.permalink if issue.permalink and _PERMALINK.match(issue.permalink) else None,
    }


def _issue_detail(issue: Issue) -> dict[str, Any]:
    return _issue(issue) | {
        "first_release": short(issue.firstRelease.version) if issue.firstRelease else None,
        "last_release": short(issue.lastRelease.version) if issue.lastRelease else None,
        "tags": [
            {"key": short(tag.key), "name": short(tag.name), "events": tag.totalValues}
            for tag in [tag for tag in issue.tags if tag.key in TAGS][:MAX_TAGS]
        ],
        "comments": issue.numComments,
        "user_reports": issue.userReportCount,
    }


class ListProjects(OperationInput):
    query: ProjectQuery | None = None
    cursor: Cursor | None = None


async def _prepare_list_projects(binding: Binding, data: ListProjects) -> Prepared:
    async def execute() -> ProviderOutput:
        client: SentryClient = binding.client
        projects, after = await client.projects(query=data.query, after=data.cursor)
        records = [
            ScopedRecord(
                project_resource(binding, p.id),
                {"id": p.id, "slug": p.slug, "name": short(p.name), "platform": short(p.platform)},
            )
            for p in projects
        ]
        return ProviderOutput(records, after)

    return Prepared([Enumerate(PROJECT, "read")], execute)


LIST_PROJECTS = Operation(
    name="list_projects",
    title="List projects",
    description=(
        "List the Sentry projects you may read. To get the next page, repeat the call with identical "
        "arguments plus the returned next_cursor."
    ),
    input_model=ListProjects,
    needs=((PROJECT, "read"),),
    prepare=_prepare_list_projects,
    paginated=True,
)


class SearchIssues(OperationInput):
    project: ProjectName
    text: Phrase | None = None
    status: Annotated[
        Literal["unresolved", "resolved", "archived", "any"],
        Field(description="Archived issues were once called ignored."),
    ] = "unresolved"
    level: Literal["fatal", "error", "warning", "info", "debug"] | None = None
    environment: Environment | None = None
    period: Annotated[
        Literal["24h", "7d", "14d", "30d", "90d"],
        Field(description="Only issues with events in this period, counted back from now."),
    ] = "14d"
    sort: Literal["last_seen", "first_seen", "events", "users"] = "last_seen"
    limit: Annotated[int, Field(ge=1, le=25)] = 10
    cursor: Cursor | None = None


def _query(data: SearchIssues) -> str:
    """The search, built from fields. An empty query is sent too: without one Sentry shows unresolved issues."""
    parts = []
    if data.status != "any":
        parts.append(f"is:{data.status}")
    if data.level is not None:
        parts.append(f"level:{data.level}")
    if data.text is not None:
        parts.append(f'"{data.text}"')
    return " ".join(parts)


async def _prepare_search_issues(binding: Binding, data: SearchIssues) -> Prepared:
    resource, project = await resolve_project(binding, data.project)

    async def execute() -> ProviderOutput:
        client: SentryClient = binding.client
        params: dict[str, Any] = {
            "project": project.id,
            "query": _query(data),
            "statsPeriod": data.period,
            "sort": SORTS[data.sort],
            "limit": data.limit,
            "collapse": ["stats", "unhandled"],
        }
        if data.environment is not None:
            params["environment"] = data.environment
        try:
            issues, after = await client.issues(params, data.cursor)
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED":
                raise OperationError("INVALID_ARGUMENTS", "Sentry could not run this search.") from None
            raise
        # The request names one project; an issue from another means the response cannot be trusted.
        if any(issue.project.id != project.id for issue in issues):
            raise client.unexpected()
        return ProviderOutput([ScopedRecord(resource, _issue(issue)) for issue in issues], after)

    return Prepared([Need(resource, "read")], execute)


SEARCH_ISSUES = Operation(
    name="search_issues",
    title="Search issues",
    description=(
        "Search one Sentry project's issues (grouped errors) by status, level, environment and a phrase, "
        "most recently seen first by default. To get the next page, repeat the call with identical arguments "
        "plus the returned next_cursor."
    ),
    input_model=SearchIssues,
    needs=((PROJECT, "read"),),
    prepare=_prepare_search_issues,
    paginated=True,
)


class GetIssue(OperationInput):
    issue: IssueName


async def _prepare_get_issue(binding: Binding, data: GetIssue) -> Prepared:
    resource, issue = await resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        return ProviderOutput([ScopedRecord(resource, _issue_detail(issue))])

    return Prepared([Need(resource, "read")], execute)


GET_ISSUE = Operation(
    name="get_issue",
    title="Get an issue",
    description=(
        "Get a Sentry issue by id or short id: its status, counts, releases and tag names. Use get_issue_event "
        "for its stack trace."
    ),
    input_model=GetIssue,
    needs=((PROJECT, "read"),),
    prepare=_prepare_get_issue,
)


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _context(frame: dict[str, Any], line: int | None) -> list[dict[str, Any]]:
    pairs = frame.get("context")
    if line is None or not isinstance(pairs, list):
        return []
    shown: dict[int, dict[str, Any]] = {}
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2:
            continue
        number, text = _number(pair[0]), pair[1]
        if (
            number is None
            or not isinstance(text, str)
            or abs(number - line) > CONTEXT_LINES
            or number in shown
        ):
            continue
        code, cut = truncate(text, MAX_LINE)
        shown[number] = {"line": number, "code": code, "code_truncated": cut}
    return [shown[number] for number in sorted(shown)]


def _frame(frame: dict[str, Any]) -> dict[str, Any]:
    line = _number(frame.get("lineNo"))
    return {
        "file": short(frame.get("filename")),
        "function": short(frame.get("function")),
        "module": short(frame.get("module")),
        "line": line,
        "column": _number(frame.get("colNo")),
        "in_app": frame.get("inApp") is True,
        "source": _context(frame, line),
    }


def _exception(value: dict[str, Any]) -> dict[str, Any]:
    stacktrace = value.get("stacktrace")
    frames = _items(stacktrace.get("frames")) if isinstance(stacktrace, dict) else []
    mechanism = value.get("mechanism")
    handled = mechanism.get("handled") if isinstance(mechanism, dict) else None
    text, cut = _text(value.get("value"), MAX_VALUE)
    return {
        "type": short(value.get("type")),
        "value": text,
        "value_truncated": cut,
        "module": short(value.get("module")),
        "mechanism": (
            {"type": short(mechanism.get("type")), "handled": handled if isinstance(handled, bool) else None}
            if isinstance(mechanism, dict)
            else None
        ),
        # Sentry lists frames outermost first; the innermost, where the error was raised, are kept.
        "frames": [_frame(frame) for frame in frames[-MAX_FRAMES:]],
        "frame_count": len(frames),
        "frames_truncated": len(frames) > MAX_FRAMES,
    }


def _address(value: Any) -> str | None:
    """A request's address without credentials, query or fragment."""
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port  # noqa: B018 - refuses a malformed port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not host:
        return None
    # The host and port as written, so an IPv6 address keeps its brackets.
    return short(f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}{parts.path}")


def _event(event: dict[str, Any]) -> dict[str, Any]:
    entries = _items(event.get("entries"))
    values: list[dict[str, Any]] = []
    request: dict[str, Any] | None = None
    for entry in entries:
        data = entry.get("data")
        if not isinstance(data, dict):
            continue
        if entry.get("type") == "exception":
            values += _items(data.get("values"))
        elif entry.get("type") == "request" and request is None:
            request = {"method": short(data.get("method"), 20), "url": _address(data.get("url"))}
    tags = {
        tag["key"]: short(tag.get("value"))
        for tag in _items(event.get("tags"))
        if isinstance(tag.get("key"), str) and tag["key"] in TAGS
    }
    contexts = event.get("contexts") if isinstance(event.get("contexts"), dict) else {}
    sdk = event.get("sdk") if isinstance(event.get("sdk"), dict) else {}
    release = event.get("release")
    message, message_cut = _text(event.get("message"), MAX_MESSAGE)
    return {
        "id": event["eventID"],
        "date": short(event.get("dateCreated"), 40),
        "title": short(event.get("title")),
        "message": message,
        "message_truncated": message_cut,
        "platform": short(event.get("platform"), 40),
        "culprit": short(event.get("culprit")),
        "location": short(event.get("location")),
        "release": short(release.get("version")) if isinstance(release, dict) else tags.get("release"),
        "environment": tags.get("environment"),
        "tags": tags,
        # The last exceptions are the ones raised last; earlier ones are their causes.
        "exceptions": [_exception(value) for value in values[-MAX_EXCEPTIONS:]],
        "exceptions_truncated": len(values) > MAX_EXCEPTIONS,
        "request": request,
        "contexts": {
            name: {"name": short(found.get("name"), 100), "version": short(found.get("version"), 100)}
            for name in CONTEXTS
            if isinstance(found := contexts.get(name), dict)
        },
        "sdk": {"name": short(sdk.get("name"), 100), "version": short(sdk.get("version"), 100)},
    }


class GetIssueEvent(OperationInput):
    issue: IssueName
    event: Annotated[
        str,
        Field(
            min_length=1,
            max_length=36,
            description='"latest" (default), "oldest", "recommended" (Sentry\'s pick), or an event id.',
        ),
        AfterValidator(_event_name),
    ] = "latest"


async def _prepare_get_issue_event(binding: Binding, data: GetIssueEvent) -> Prepared:
    resource, issue = await resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        client: SentryClient = binding.client
        try:
            event = await client.event(issue.id, data.event)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise OperationError("NOT_FOUND", "This issue has no such event.") from None
            raise
        # The event must belong to the issue authorized, as read: an id merged into another issue is read
        # as that issue.
        if (
            str(event.get("groupID")) != issue.id
            or str(event.get("projectID")) != issue.project.id
            or not isinstance(event.get("eventID"), str)
            or not EVENT_ID.match(event["eventID"])
            or (EVENT_ID.match(data.event) and event["eventID"] != data.event)
        ):
            raise client.unexpected()
        return ProviderOutput([ScopedRecord(resource, {"issue": issue.id, **_event(event)})])

    return Prepared([Need(resource, "read")], execute)


GET_ISSUE_EVENT = Operation(
    name="get_issue_event",
    title="Get an issue's event",
    description=(
        "Get one event of a Sentry issue, the latest by default: its exceptions with the innermost "
        f"{MAX_FRAMES} stack frames and nearby source lines, tags, release, environment and runtime. Local "
        "variables, request headers and bodies, the user and breadcrumbs are left out."
    ),
    input_model=GetIssueEvent,
    needs=((PROJECT, "read"),),
    prepare=_prepare_get_issue_event,
)
