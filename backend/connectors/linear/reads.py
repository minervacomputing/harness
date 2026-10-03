"""Linear's read operations: teams, issue lists and search, and single issues."""

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ScopedRecord,
)
from connectors.linear import markdown as text
from connectors.linear.client import IssueSummary, Label, LinearClient, Team
from connectors.linear.teams import (
    CLOSED,
    TEAM,
    IssueName,
    TeamName,
    checked_cursor,
    confirm_team,
    issue_moved,
    next_cursor,
    resolve_issue,
    resolve_team,
    same_place,
    single_line,
    state_data,
    team_moved,
    team_resource,
)

MAX_READ_DESCRIPTION = 20_000
MAX_READ_COMMENT = 4_000
MAX_COMMENTS = 30
MAX_SEARCH_WORDS = 8
Cursor = Annotated[str, Field(max_length=500)]


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


def _summary(issue: IssueSummary) -> dict[str, Any]:
    return {
        "id": issue.id,
        "identifier": issue.identifier,
        "title": issue.title,
        "state": state_data(issue.state),
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
        found = await binding.client.teams(first=data.limit, after=checked_cursor(data.cursor))
        records = []
        for team in found.nodes:
            resource = team_resource(binding, team)
            records.append(ScopedRecord(resource, _team_data(resource, team)))
        return ProviderOutput(records, next_cursor(found.page_info))

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
    resource = await resolve_team(binding, data.team)

    async def execute() -> ProviderOutput:
        client: LinearClient = binding.client
        team = await confirm_team(binding, resource)
        states, states_more = await client.states(resource.id)
        labels, labels_more = await client.labels(resource.id)
        members, members_more = await client.members(resource.id)
        record = {
            **_team_data(resource, team),
            "states": [state_data(state) for state in states],
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
        after=checked_cursor(cursor),
        filter={"and": conditions} if conditions else None,
    )
    if not same_place(binding, resource, found):
        raise team_moved()
    records = [
        ScopedRecord(resource, _summary(issue))
        for issue in found.issues.nodes
        if issue.team.id.lower() == resource.id
    ]
    return ProviderOutput(records, next_cursor(found.issues.page_info))


async def _prepare_list_issues(binding: Binding, data: ListIssues) -> Prepared:
    resource = await resolve_team(binding, data.team)

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
        AfterValidator(single_line),
    ]
    state: Literal["open", "closed", "all"] = "all"
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Cursor | None = None


async def _prepare_search_issues(binding: Binding, data: SearchIssues) -> Prepared:
    resource = await resolve_team(binding, data.team)

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
    issue_id, resource = await resolve_issue(binding, data.issue)

    async def execute() -> ProviderOutput:
        issue = await binding.client.issue(issue_id, comments=MAX_COMMENTS)
        if issue.id.lower() != issue_id or not same_place(binding, resource, issue.team):
            raise issue_moved()
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
            "state": state_data(issue.state),
            "priority": issue.priority_label,
            "estimate": issue.estimate,
            "due_date": issue.due_date,
            "assignee": issue.assignee.name if issue.assignee else None,
            "creator": issue.creator.name if issue.creator else None,
            "project": issue.project.name if issue.project else None,
            "labels": [label.name for label in issue.labels.nodes],
            "parent": parent,
            "sub_issues": [
                {"identifier": child.identifier, "title": child.title, "state": state_data(child.state)}
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
