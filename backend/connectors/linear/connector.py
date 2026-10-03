"""Linear. Resources are teams; what is allowed on a team also covers its sub-teams.

Every issue belongs to one team, and everything about an issue is authorized on that team. Tools name
teams by key ("ENG") and issues by identifier ("ENG-123"); a name is resolved to the team once, before
authorization, and nothing that depends on what a call wants to read or write is looked up until the call
is authorized. Just before content is read or written, the issue and its team's chain of parent teams are
resolved again: a call whose issue or team moved in between is refused.

Text agents read hides the titles of other issues, which Linear writes into links (see `markdown`), and
related issues in other teams are shown only as existing. Text agents write may mention only issues in
the same team. Linear itself closes related issues in some cases (a parent whose sub-issues are all done,
the open sub-issues of a closed parent), so a status change that could reach an issue in another team is
refused. What stays outside Minerva's reach: other Linear automations (triage rules, integrations), which
may act on an issue an agent changed, and teams the connected account cannot see at all.
"""

import asyncio
import re
from datetime import date
from typing import Annotated, Any, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    DENIED,
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
)
from connectors.linear import markdown as text
from connectors.linear.client import (
    MAX_ISSUE_DEPTH,
    MAX_TEAM_DEPTH,
    IssueSummary,
    Label,
    LinearClient,
    PageInfo,
    ParentIssue,
    Person,
    State,
    Team,
    TeamRef,
    Written,
)

TEAM = "team"
MAX_TITLE = 255
MAX_DESCRIPTION = 50_000
MAX_COMMENT = 20_000
MAX_READ_DESCRIPTION = 20_000
MAX_READ_COMMENT = 4_000
MAX_COMMENTS = 30
MAX_LABELS = 10
MAX_DISCOVERY_PAGES = 10
DESCRIBE_BATCH = 100
# How many levels of sub-issues a status change looks through for issues in other teams.
SUB_ISSUE_DEPTH = 3
MAX_SEARCH_WORDS = 8
CLOSED = ("completed", "canceled")
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"})

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TEAM_KEY = re.compile(r"^[A-Z0-9]{1,10}$")
_CURSOR = re.compile(r"^[\x21-\x7e]{1,500}$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _team_name(value: str) -> str:
    if _UUID.match(value.lower()):
        return value.lower()
    if _TEAM_KEY.match(value.upper()):
        return value.upper()
    raise ValueError('must be a team key such as "ENG", or a team id')


def _issue_name(value: str) -> str:
    if _UUID.match(value.lower()):
        return value.lower()
    if text.IDENTIFIER.match(value):
        return value.upper()
    raise ValueError('must be an issue identifier such as "ENG-123", or an issue id')


def _uuid(value: str) -> str:
    if not _UUID.match(value.lower()):
        raise ValueError("must be a Linear id")
    return value.lower()


def _single_line(value: str) -> str:
    if CONTROL.search(value) or "\n" in value or "\r" in value:
        raise ValueError("must be a single line without control characters")
    return value


def _due_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValueError("must be a date such as 2026-10-01") from None


TeamName = Annotated[
    str,
    Field(min_length=1, max_length=36, description='A team key such as "ENG", or a team id.'),
    AfterValidator(_team_name),
]
IssueName = Annotated[
    str,
    Field(min_length=1, max_length=36, description='An issue identifier such as "ENG-123", or an issue id.'),
    AfterValidator(_issue_name),
]
Cursor = Annotated[str, Field(max_length=500)]
Title = Annotated[str, Field(min_length=1, max_length=MAX_TITLE), AfterValidator(_single_line)]
ShortName = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_single_line)]
Priority = Annotated[int, Field(ge=0, le=4, description="0 no priority, 1 urgent, 2 high, 3 medium, 4 low.")]
DueDate = Annotated[str, Field(max_length=10, description="YYYY-MM-DD."), AfterValidator(_due_date)]
Description = Annotated[
    str,
    Field(min_length=1, max_length=MAX_DESCRIPTION, description="Markdown."),
    AfterValidator(text.check_written),
]
Assignee = Annotated[
    str,
    Field(min_length=1, max_length=200, description='"me", or a team member\'s name or display name.'),
    AfterValidator(_single_line),
]
LabelNames = Annotated[
    list[ShortName],
    Field(
        min_length=1,
        max_length=MAX_LABELS,
        description='Label names; "Group/Label" picks a label inside a label group.',
    ),
]


def _denied() -> OperationError:
    return OperationError("POLICY_DENIED", DENIED)


def _issue_moved() -> OperationError:
    return OperationError(
        "ISSUE_MOVED", "This issue or its team moved in Linear while Minerva was using it. Try again."
    )


def _team_moved() -> OperationError:
    return OperationError("TEAM_MOVED", "This team moved in Linear while Minerva was using it. Try again.")


def _ancestry(team: TeamRef) -> tuple[tuple[str, ...], bool]:
    """The team's parent teams, nearest first, and whether the chain may go on beyond them."""
    within: list[str] = []
    seen = {team.id.lower()}
    current = team.parent
    while current is not None:
        parent_id = current.id.lower()
        if parent_id in seen or not _UUID.match(parent_id) or len(within) >= MAX_TEAM_DEPTH:
            return tuple(within), True
        seen.add(parent_id)
        within.append(parent_id)
        current = current.parent
    return tuple(within), False


def _team_resource(binding: Binding, team: TeamRef) -> Resource:
    team_id = team.id.lower()
    if not _UUID.match(team_id):
        raise OperationError("PROVIDER_FAILED", "Linear returned an unexpected response.")
    within, partial = _ancestry(team)
    return binding.resource(TEAM, team_id, within, partial)


def _same_place(binding: Binding, resource: Resource, team: TeamRef) -> bool:
    return _team_resource(binding, team) == resource


async def _resolve_team(binding: Binding, name: str) -> Resource:
    """The team a call names, as the resource that is authorized. Teams the account cannot see are refused
    like teams without a grant."""
    client: LinearClient = binding.client
    try:
        if _UUID.match(name):
            team: Team | None = await client.team(name)
            if team is not None and team.id.lower() != name:
                team = None
        else:
            found = [t for t in await client.team_by_key(name) if t.key.upper() == name]
            team = found[0] if len(found) == 1 else None
    except OperationError as error:
        if error.code in HIDDEN:
            raise _denied() from None
        raise
    if team is None:
        raise _denied()
    return _team_resource(binding, team)


async def _resolve_issue(binding: Binding, name: str) -> tuple[str, Resource]:
    """The issue a call names (its id) and its team, which is what is authorized."""
    client: LinearClient = binding.client
    try:
        place = await client.issue_place(name)
    except OperationError as error:
        if error.code in HIDDEN:
            raise _denied() from None
        raise
    issue_id = place.id.lower()
    if not _UUID.match(issue_id) or (_UUID.match(name) and issue_id != name):
        raise _denied()
    return issue_id, _team_resource(binding, place.team)


async def _confirm_team(binding: Binding, resource: Resource) -> Team:
    try:
        team = await binding.client.team(resource.id)
    except OperationError as error:
        if error.code in HIDDEN:
            raise _team_moved() from None
        raise
    if not _same_place(binding, resource, team):
        raise _team_moved()
    return team


async def _confirm_issue(binding: Binding, issue_id: str, resource: Resource) -> str:
    """The issue's identifier, refused if the issue or its team moved since `resource` was authorized."""
    try:
        place = await binding.client.issue_place(issue_id)
    except OperationError as error:
        if error.code in HIDDEN:
            raise _issue_moved() from None
        raise
    if place.id.lower() != issue_id or not _same_place(binding, resource, place.team):
        raise _issue_moved()
    return place.identifier


def _cursor(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return cursor


def _next(page: PageInfo) -> str | None:
    if not page.has_next_page or not page.end_cursor:
        return None
    if not _CURSOR.match(page.end_cursor):
        raise OperationError("PROVIDER_LIMIT", "Linear returned a page token Minerva cannot use.")
    return page.end_cursor


def _truncated(value: str | None, limit: int) -> tuple[str | None, bool]:
    if value is None or len(value) <= limit:
        return value, False
    return value[:limit], True


def _team_data(resource: Resource, team: Team) -> dict[str, Any]:
    return {
        "id": resource.id,
        "key": team.key,
        "name": team.name,
        "description": team.description,
        "private": team.private,
        "parent_team_id": resource.within[0] if resource.within else None,
    }


def _state(state: State | None) -> dict[str, str] | None:
    return {"name": state.name, "type": state.type} if state is not None else None


def _summary(issue: IssueSummary) -> dict[str, Any]:
    return {
        "id": issue.id,
        "identifier": issue.identifier,
        "title": issue.title,
        "state": _state(issue.state),
        "priority": issue.priority_label,
        "assignee": issue.assignee.name if issue.assignee else None,
        "due_date": issue.due_date,
        "updated_at": issue.updated_at,
        "url": text.redact(issue.url),
    }


class ListTeams(OperationInput):
    limit: Annotated[int, Field(ge=1, le=100)] = 50
    cursor: Cursor | None = None


async def _prepare_list_teams(binding: Binding, data: ListTeams) -> Prepared:
    async def execute() -> ProviderOutput:
        found = await binding.client.teams(first=data.limit, after=_cursor(data.cursor))
        records = []
        for team in found.nodes:
            resource = _team_resource(binding, team)
            records.append(ScopedRecord(resource, _team_data(resource, team)))
        return ProviderOutput(records, _next(found.page_info))

    return Prepared([Enumerate(TEAM, "read")], execute)


LIST_TEAMS = Operation(
    name="list_teams",
    title="List teams",
    description=(
        "List the Linear teams you may read, with their keys. To get the next page, repeat the call "
        "with identical arguments plus the returned next_cursor."
    ),
    input_model=ListTeams,
    needs=((TEAM, "read"),),
    prepare=_prepare_list_teams,
    paginated=True,
)


class TeamInput(OperationInput):
    team: TeamName


def _label_data(label: Label) -> dict[str, Any]:
    return {"name": label.name, "group": label.parent.name if label.parent else None}


async def _prepare_get_team(binding: Binding, data: TeamInput) -> Prepared:
    resource = await _resolve_team(binding, data.team)

    async def execute() -> ProviderOutput:
        client: LinearClient = binding.client
        team = await _confirm_team(binding, resource)
        states, states_more = await client.states(resource.id)
        labels, labels_more = await client.labels(resource.id)
        members, members_more = await client.members(resource.id)
        record = {
            **_team_data(resource, team),
            "states": [_state(state) for state in states],
            "labels": [_label_data(label) for label in labels if not label.is_group],
            "members": [
                {"name": person.name, "display_name": person.display_name}
                for person in members
                if person.active
            ],
            "truncated": states_more or labels_more or members_more,
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_TEAM = Operation(
    name="get_team",
    title="Get a team",
    description=(
        "Read a Linear team: its statuses, the labels its issues can have, and its members. Use these "
        "names when creating or updating issues."
    ),
    input_model=TeamInput,
    needs=((TEAM, "read"),),
    prepare=_prepare_get_team,
)


class ListIssues(OperationInput):
    team: TeamName
    state: Literal["open", "closed", "all"] = "open"
    assigned_to_me: bool = False
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Cursor | None = None


def _state_condition(state: str) -> list[dict[str, Any]]:
    if state == "open":
        return [{"state": {"type": {"nin": list(CLOSED)}}}]
    if state == "closed":
        return [{"state": {"type": {"in": list(CLOSED)}}}]
    return []


async def _issue_page(
    binding: Binding, resource: Resource, conditions: list[dict[str, Any]], limit: int, cursor: str | None
) -> ProviderOutput:
    found = await binding.client.team_issues(
        resource.id,
        first=limit,
        after=_cursor(cursor),
        filter={"and": conditions} if conditions else None,
    )
    if not _same_place(binding, resource, found):
        raise _team_moved()
    records = [
        ScopedRecord(resource, _summary(issue))
        for issue in found.issues.nodes
        if issue.team.id.lower() == resource.id
    ]
    return ProviderOutput(records, _next(found.issues.page_info))


async def _prepare_list_issues(binding: Binding, data: ListIssues) -> Prepared:
    resource = await _resolve_team(binding, data.team)

    async def execute() -> ProviderOutput:
        conditions = _state_condition(data.state)
        if data.assigned_to_me:
            conditions.append({"assignee": {"isMe": {"eq": True}}})
        return await _issue_page(binding, resource, conditions, data.limit, data.cursor)

    return Prepared([Need(resource, "read")], execute)


LIST_ISSUES = Operation(
    name="list_issues",
    title="List issues",
    description=(
        "List a team's issues, most recently updated first; open ones by default. Sub-teams' issues "
        "are not included. To get the next page, repeat the call with identical arguments plus the "
        "returned next_cursor."
    ),
    input_model=ListIssues,
    needs=((TEAM, "read"),),
    prepare=_prepare_list_issues,
    paginated=True,
)


class SearchIssues(OperationInput):
    team: TeamName
    query: Annotated[
        str,
        Field(min_length=1, max_length=200, description="Words that must all appear in the title."),
        AfterValidator(_single_line),
    ]
    state: Literal["open", "closed", "all"] = "all"
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Cursor | None = None


async def _prepare_search_issues(binding: Binding, data: SearchIssues) -> Prepared:
    resource = await _resolve_team(binding, data.team)

    async def execute() -> ProviderOutput:
        # Titles only: Linear's text search also matches descriptions, whose links carry titles of issues
        # in other teams, so which issues matched would reveal words of those titles.
        words = data.query.split()[:MAX_SEARCH_WORDS]
        conditions = _state_condition(data.state)
        conditions += [{"title": {"containsIgnoreCase": word}} for word in words]
        return await _issue_page(binding, resource, conditions, data.limit, data.cursor)

    return Prepared([Need(resource, "read")], execute)


SEARCH_ISSUES = Operation(
    name="search_issues",
    title="Search issues",
    description=(
        "Find one team's issues whose title contains every word of the query (descriptions and "
        "comments are not searched). To get the next page, repeat the call with identical "
        "arguments plus the returned next_cursor."
    ),
    input_model=SearchIssues,
    needs=((TEAM, "read"),),
    prepare=_prepare_search_issues,
    paginated=True,
)


READ_NOTE = (
    "Links to other Linear objects appear without their titles, and related issues in other teams only as "
    "existing."
)


class IssueInput(OperationInput):
    issue: IssueName


async def _prepare_get_issue(binding: Binding, data: IssueInput) -> Prepared:
    issue_id, resource = await _resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        issue = await binding.client.issue(issue_id, comments=MAX_COMMENTS)
        if issue.id.lower() != issue_id or not _same_place(binding, resource, issue.team):
            raise _issue_moved()
        description, description_truncated = _truncated(text.redact(issue.description), MAX_READ_DESCRIPTION)
        parent: dict[str, Any] | None = None
        if issue.parent is not None:
            parent = (
                {"identifier": issue.parent.identifier, "title": issue.parent.title}
                if issue.parent.team.id.lower() == resource.id
                else {"in_another_team": True}
            )
        children = issue.children.nodes
        comments = []
        for comment in sorted(issue.comments.nodes, key=lambda c: c.created_at or ""):
            if comment.hide_in_linear:
                continue
            body, body_truncated = _truncated(text.redact(comment.body), MAX_READ_COMMENT)
            comments.append(
                {
                    "id": comment.id,
                    "author": comment.author,
                    "body": body,
                    "body_truncated": body_truncated,
                    "created_at": comment.created_at,
                    "reply_to": comment.parent.id if comment.parent else None,
                }
            )
        record = {
            "id": issue.id,
            "identifier": issue.identifier,
            "title": issue.title,
            "team": {"id": resource.id, "key": issue.team.key, "name": issue.team.name},
            "description": description,
            "description_truncated": description_truncated,
            "state": _state(issue.state),
            "priority": issue.priority_label,
            "estimate": issue.estimate,
            "due_date": issue.due_date,
            "assignee": issue.assignee.name if issue.assignee else None,
            "creator": issue.creator.name if issue.creator else None,
            "project": issue.project.name if issue.project else None,
            "labels": [label.name for label in issue.labels.nodes],
            "parent": parent,
            "sub_issues": [
                {"identifier": child.identifier, "title": child.title, "state": _state(child.state)}
                for child in children
                if child.team.id.lower() == resource.id
            ],
            "sub_issues_in_other_teams": any(child.team.id.lower() != resource.id for child in children),
            "sub_issues_truncated": issue.children.page_info.has_next_page,
            "url": text.redact(issue.url),
            "created_at": issue.created_at,
            "updated_at": issue.updated_at,
            "completed_at": issue.completed_at,
            "canceled_at": issue.canceled_at,
            "comments": comments,
            "comments_truncated": issue.comments.page_info.has_next_page,
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_ISSUE = Operation(
    name="get_issue",
    title="Read an issue",
    description=("Read one Linear issue with its description, sub-issues and first comments. " + READ_NOTE),
    input_model=IssueInput,
    needs=((TEAM, "read"),),
    prepare=_prepare_get_issue,
)


WRITE_NOTE = (
    "Everyone who can see the team sees what you write; subscribers are notified, assignees are notified, "
    "and the team's automations in Linear may make further changes. The number of writes per run is limited."
)
TEXT_NOTE = (
    "Text is Markdown. It may link to Linear only with addresses of issues in the same team "
    "(https://linear.app/<workspace>/issue/<ID>), which Linear shows as mentions, and show images only "
    "from Linear's uploads."
)

CREATE_CONSENT = (frozenset({"issues:create"}), frozenset({"write"}))
COMMENT_CONSENT = (frozenset({"comments:create"}), frozenset({"write"}))
EDIT_CONSENT = (frozenset({"write"}),)


def _link_refused() -> OperationError:
    return OperationError(
        "LINK_NOT_ALLOWED",
        "Text may link only to issues in the same team of this Linear workspace: Linear turns such links "
        "into mentions, which show on the linked issue.",
    )


async def _check_links(client: LinearClient, team_id: str, written: str | None) -> None:
    """Refuses text that links to an issue outside the team. Runs after authorization, so its answer tells
    nothing about teams the agent may not read."""
    links = text.issue_links(written) if written else []
    if not links:
        return
    workspace = (await client.organization()).url_key.lower()
    for link_workspace, identifier in links:
        if link_workspace != workspace:
            raise _link_refused()
        try:
            team = await client.issue_team(identifier)
        except OperationError as error:
            if error.code in HIDDEN:
                raise _link_refused() from None
            raise
        if team.id.lower() != team_id:
            raise _link_refused()


def _unknown_name(what: str) -> OperationError:
    return OperationError(
        "INVALID_ARGUMENTS", f"No single {what} in this team has that name; get_team lists them."
    )


def _pick[T](items: list[T], name: str, keys: Any, what: str) -> T:
    folded = name.casefold()
    found = [item for item in items if any(key and key.casefold() == folded for key in keys(item))]
    if len(found) != 1:
        raise _unknown_name(what)
    return found[0]


async def _state_id(client: LinearClient, team_id: str, name: str) -> State:
    states, _ = await client.states(team_id)
    state = _pick(states, name, lambda s: [s.name], "status")
    if state.id is None:
        raise client.unexpected()
    return state


async def _label_ids(client: LinearClient, team_id: str, names: list[str]) -> list[str]:
    labels = [label for label in (await client.labels(team_id))[0] if not label.is_group]
    picked = [
        _pick(
            labels,
            name,
            lambda label: [label.name, f"{label.parent.name}/{label.name}" if label.parent else None],
            "label",
        )
        for name in names
    ]
    return list(dict.fromkeys(label.id for label in picked))


async def _assignee_id(client: LinearClient, team_id: str, name: str) -> str:
    if name.casefold() == "me":
        return (await client.viewer()).id
    members: list[Person] = [m for m in (await client.members(team_id))[0] if m.active]
    return _pick(members, name, lambda m: [m.name, m.display_name], "member").id


def _written_record(resource: Resource, written: Written | None, **extra: Any) -> dict[str, Any]:
    if written is None or written.team.id.lower() != resource.id:
        # Linear confirmed the write but did not return the issue, or placed it in another team.
        return {"written": True, **extra}
    return {
        "written": True,
        "id": written.id,
        "identifier": written.identifier,
        "title": written.title,
        "state": _state(written.state),
        "url": text.redact(written.url),
        **extra,
    }


class CreateIssue(OperationInput):
    team: TeamName
    title: Title
    description: Description | None = None
    state: ShortName | None = None
    priority: Priority | None = None
    labels: LabelNames | None = None
    assignee: Assignee | None = None
    due_date: DueDate | None = None


async def _prepare_create_issue(binding: Binding, data: CreateIssue) -> Prepared:
    resource = await _resolve_team(binding, data.team)

    async def execute() -> ProviderOutput:
        client: LinearClient = binding.client
        # A team's default template could add sub-issues or other content Minerva did not check.
        input: dict[str, Any] = {"teamId": resource.id, "title": data.title, "useDefaultTemplate": False}
        if data.description is not None:
            await _check_links(client, resource.id, data.description)
            input["description"] = data.description
        if data.state is not None:
            state = await _state_id(client, resource.id, data.state)
            if state.type in CLOSED:
                raise OperationError("INVALID_ARGUMENTS", "Create the issue open, then change its status.")
            input["stateId"] = state.id
        if data.priority is not None:
            input["priority"] = data.priority
        if data.labels:
            input["labelIds"] = await _label_ids(client, resource.id, data.labels)
        if data.assignee is not None:
            input["assigneeId"] = await _assignee_id(client, resource.id, data.assignee)
        if data.due_date is not None:
            input["dueDate"] = data.due_date
        # Last before the write, so the team is checked as close to it as Linear allows.
        await _confirm_team(binding, resource)
        created = await client.create_issue(input)
        return ProviderOutput([ScopedRecord(resource, _written_record(resource, created))])

    return Prepared([Need(resource, "create")], execute)


CREATE_ISSUE = Operation(
    name="create_issue",
    title="Create an issue",
    description=(
        "Create an issue in a team where you have create permission. Status, labels and assignee are "
        "names from get_team. " + TEXT_NOTE + " " + WRITE_NOTE
    ),
    input_model=CreateIssue,
    needs=((TEAM, "create"),),
    prepare=_prepare_create_issue,
    consent=CREATE_CONSENT,
    mutates=True,
)


class AddComment(OperationInput):
    issue: IssueName
    body: Annotated[
        str,
        Field(min_length=1, max_length=MAX_COMMENT, description="Markdown."),
        AfterValidator(text.check_written),
    ]
    reply_to: (
        Annotated[
            str,
            Field(max_length=36, description="The id of a comment on this issue to reply to."),
            AfterValidator(_uuid),
        ]
        | None
    ) = None


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    issue_id, resource = await _resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        client: LinearClient = binding.client
        input: dict[str, Any] = {"issueId": issue_id, "body": data.body}
        if data.reply_to is not None:
            not_here = OperationError("INVALID_ARGUMENTS", "reply_to must be a comment on this issue.")
            try:
                comment = await client.comment_place(data.reply_to)
            except OperationError as error:
                if error.code in HIDDEN:
                    raise not_here from None
                raise
            if (
                comment.issue is None
                or comment.issue.id.lower() != issue_id
                or comment.id.lower() != data.reply_to
            ):
                raise not_here
            # Linear threads are one level deep: a reply to a reply joins its thread.
            input["parentId"] = comment.parent.id if comment.parent else comment.id
        await _check_links(client, resource.id, data.body)
        identifier = await _confirm_issue(binding, issue_id, resource)
        created = await client.create_comment(input)
        record = {
            "written": True,
            "id": created.id if created else None,
            "issue": identifier,
            "created_at": created.created_at if created else None,
            "reply_to": input.get("parentId"),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "comment")], execute)


ADD_COMMENT = Operation(
    name="add_comment",
    title="Comment on an issue",
    description=(
        "Comment on an issue in a team where you have comment permission, optionally replying to one "
        "of its comments. " + TEXT_NOTE + " " + WRITE_NOTE
    ),
    input_model=AddComment,
    needs=((TEAM, "comment"),),
    prepare=_prepare_add_comment,
    consent=COMMENT_CONSENT,
    mutates=True,
)


class UpdateIssue(OperationInput):
    issue: IssueName
    title: Title | None = None
    description: (
        Annotated[Description, Field(description="Markdown; replaces the whole description.")] | None
    ) = None
    state: ShortName | None = None
    priority: Priority | None = None
    add_labels: LabelNames | None = None
    remove_labels: LabelNames | None = None
    assignee: Assignee | None = None
    unassign: bool = False
    due_date: DueDate | None = None
    clear_due_date: bool = False

    @model_validator(mode="after")
    def _one_change(self) -> Self:
        changes = [
            self.title,
            self.description,
            self.state,
            self.priority,
            self.add_labels,
            self.remove_labels,
            self.assignee,
            self.due_date,
        ]
        if all(change is None for change in changes) and not self.unassign and not self.clear_due_date:
            raise ValueError("change at least one field")
        if self.assignee is not None and self.unassign:
            raise ValueError("give either assignee or unassign")
        if self.due_date is not None and self.clear_due_date:
            raise ValueError("give either due_date or clear_due_date")
        added = {name.casefold() for name in self.add_labels or []}
        if added & {name.casefold() for name in self.remove_labels or []}:
            raise ValueError("a label cannot be both added and removed")
        return self


def _status_refused() -> OperationError:
    return OperationError(
        "STATUS_CHANGE_REFUSED",
        "Minerva does not change this issue's status: Linear could then close related issues in other "
        "teams (a parent issue, or open sub-issues) on its own.",
    )


def _parents_elsewhere(parent: ParentIssue | None, team_id: str) -> bool:
    """Whether a parent issue, at any level, is in another team, or the chain goes beyond what was read."""
    for _ in range(MAX_ISSUE_DEPTH):
        if parent is None:
            return False
        if parent.team.id.lower() != team_id:
            return True
        parent = parent.parent
    return parent is not None


async def _prepare_update_issue(binding: Binding, data: UpdateIssue) -> Prepared:
    issue_id, resource = await _resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        client: LinearClient = binding.client
        input: dict[str, Any] = {}
        if data.title is not None:
            input["title"] = data.title
        if data.description is not None:
            await _check_links(client, resource.id, data.description)
            input["description"] = data.description
        state = None
        if data.state is not None:
            state = await _state_id(client, resource.id, data.state)
            input["stateId"] = state.id
        if data.priority is not None:
            input["priority"] = data.priority
        if data.add_labels:
            input["addedLabelIds"] = await _label_ids(client, resource.id, data.add_labels)
        if data.remove_labels:
            input["removedLabelIds"] = await _label_ids(client, resource.id, data.remove_labels)
        if data.assignee is not None:
            input["assigneeId"] = await _assignee_id(client, resource.id, data.assignee)
        if data.unassign:
            input["assigneeId"] = None
        if data.due_date is not None:
            input["dueDate"] = data.due_date
        if data.clear_due_date:
            input["dueDate"] = None
        # Last before the write, so the issue is checked as close to it as Linear allows.
        try:
            issue = await client.issue_for_update(issue_id)
        except OperationError as error:
            if error.code in HIDDEN:
                raise _issue_moved() from None
            raise
        if issue.id.lower() != issue_id or not _same_place(binding, resource, issue.team):
            raise _issue_moved()
        if state is not None:
            # Parent auto-close: a parent closes when its last sub-issue does.
            if _parents_elsewhere(issue.parent, resource.id):
                raise _status_refused()
            # Sub-issue auto-close: closing a parent closes its open sub-issues.
            if state.type in CLOSED:
                elsewhere, deeper = await client.open_sub_issues(issue_id, resource.id, SUB_ISSUE_DEPTH)
                if elsewhere or deeper:
                    raise _status_refused()
                # The lookup came after the check above; check the place again right before the write.
                await _confirm_issue(binding, issue_id, resource)
        updated = await client.update_issue(issue_id, input)
        record = _written_record(resource, updated, changed=sorted(input))
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "edit")], execute)


UPDATE_ISSUE = Operation(
    name="update_issue",
    title="Update an issue",
    description=(
        "Change an issue's title, description, status, priority, labels, assignee or due date, in a "
        "team where you have edit permission. Issues cannot be moved to another team or parent. A "
        "status change is refused when Linear could then close related issues in other teams. "
        + TEXT_NOTE
        + " "
        + WRITE_NOTE
    ),
    input_model=UpdateIssue,
    needs=((TEAM, "edit"),),
    prepare=_prepare_update_issue,
    consent=EDIT_CONSENT,
    mutates=True,
)


class LinearConnector(Connector):
    slug = "linear"
    name = "Linear"
    kinds = (
        ResourceKind(
            TEAM,
            "Team",
            ("read", "comment", "create", "edit"),
            wildcard=True,
            hierarchical=True,
            note=(
                "What is allowed on a team also covers its issues and its sub-teams. Minerva reaches the "
                "teams the connected Linear account can see. Where Linear does not show a team's whole chain "
                "of parent teams, blocking an action anywhere in this connection also blocks it there."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read issues"),
        ActionSpec("comment", "Comment on issues", requires="read"),
        ActionSpec("create", "Create issues", requires="read"),
        ActionSpec("edit", "Edit issues", requires="read"),
    )
    auth = OAuth2(
        app="linear",
        authorize_url="https://linear.app/oauth/authorize",
        token_url="https://api.linear.app/oauth/token",  # noqa: S106
        scopes=("read",),
        scope_separator=",",
        client_auth="post",
        pkce=True,
    )

    operations = (
        LIST_TEAMS,
        GET_TEAM,
        LIST_ISSUES,
        SEARCH_ISSUES,
        GET_ISSUE,
        CREATE_ISSUE,
        ADD_COMMENT,
        UPDATE_ISSUE,
    )

    def client(self, access_token: str) -> LinearClient:
        return LinearClient(access_token)

    async def account(self, client: LinearClient) -> Account:
        me = await client.me()
        return Account(id=me.viewer.id, label=f"{me.viewer.name} ({me.organization.name})")

    async def discover(
        self, client: LinearClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            found = await client.teams(first=100, after=_cursor(cursor))
            return DiscoveryPage([_item(team) for team in found.nodes], _next(found.page_info))
        folded = query.casefold()
        matches: list[Team] = []
        after = None
        for _ in range(MAX_DISCOVERY_PAGES):
            found = await client.teams(first=100, after=after)
            matches.extend(
                t for t in found.nodes if folded in t.name.casefold() or folded in t.key.casefold()
            )
            after = _next(found.page_info)
            if after is None:
                return DiscoveryPage([_item(team) for team in matches])
        raise OperationError("PROVIDER_LIMIT", "There are more teams than Minerva can search.")

    async def describe(self, client: LinearClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = [team_id for team_id in ids if _UUID.match(team_id)]
        batches = [wanted[i : i + DESCRIBE_BATCH] for i in range(0, len(wanted), DESCRIBE_BATCH)]
        found = await asyncio.gather(
            *(client.teams(first=DESCRIBE_BATCH, after=None, ids=batch) for batch in batches)
        )
        names = {team.id.lower(): _item(team).name for page in found for team in page.nodes}
        return {team_id: names[team_id] for team_id in wanted if team_id in names}


def _item(team: Team) -> DiscoveryItem:
    return DiscoveryItem(team.id.lower(), f"{team.name} ({team.key})")
