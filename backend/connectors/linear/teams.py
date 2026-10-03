"""What Linear's operations share: team and issue names, where teams sit, and page tokens."""

import re
from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.base import DENIED, Binding, OperationError, Resource
from connectors.linear import markdown as text
from connectors.linear.client import MAX_TEAM_DEPTH, LinearClient, PageInfo, State, Team, TeamRef

TEAM = "team"
CLOSED = ("completed", "canceled")
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"})

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TEAM_KEY = re.compile(r"^[A-Z0-9]{1,10}$")
_CURSOR = re.compile(r"^[\x21-\x7e]{1,500}$")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _team_name(value: str) -> str:
    if UUID.match(value.lower()):
        return value.lower()
    if _TEAM_KEY.match(value.upper()):
        return value.upper()
    raise ValueError('must be a team key such as "ENG", or a team id')


def _issue_name(value: str) -> str:
    if UUID.match(value.lower()):
        return value.lower()
    if text.IDENTIFIER.match(value):
        return value.upper()
    raise ValueError('must be an issue identifier such as "ENG-123", or an issue id')


def single_line(value: str) -> str:
    if CONTROL.search(value) or "\n" in value or "\r" in value:
        raise ValueError("must be a single line without control characters")
    return value


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


def _denied() -> OperationError:
    return OperationError("POLICY_DENIED", DENIED)


def issue_moved() -> OperationError:
    return OperationError(
        "ISSUE_MOVED", "This issue or its team moved in Linear while Minerva was using it. Try again."
    )


def team_moved() -> OperationError:
    return OperationError("TEAM_MOVED", "This team moved in Linear while Minerva was using it. Try again.")


def _ancestry(team: TeamRef) -> tuple[tuple[str, ...], bool]:
    """The team's parent teams, nearest first, and whether the chain may go on beyond them."""
    within: list[str] = []
    seen = {team.id.lower()}
    current = team.parent
    while current is not None:
        parent_id = current.id.lower()
        if parent_id in seen or not UUID.match(parent_id) or len(within) >= MAX_TEAM_DEPTH:
            return tuple(within), True
        seen.add(parent_id)
        within.append(parent_id)
        current = current.parent
    return tuple(within), False


def team_resource(binding: Binding, team: TeamRef) -> Resource:
    team_id = team.id.lower()
    if not UUID.match(team_id):
        raise OperationError("PROVIDER_FAILED", "Linear returned an unexpected response.")
    within, partial = _ancestry(team)
    return binding.resource(TEAM, team_id, within, partial)


def same_place(binding: Binding, resource: Resource, team: TeamRef) -> bool:
    return team_resource(binding, team) == resource


async def resolve_team(binding: Binding, name: str) -> Resource:
    """The team a call names, as the resource that is authorized. Teams the account cannot see are refused
    like teams without a grant."""
    client: LinearClient = binding.client
    try:
        if UUID.match(name):
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
    return team_resource(binding, team)


async def resolve_issue(binding: Binding, name: str) -> tuple[str, Resource]:
    """The issue a call names (its id) and its team, which is what is authorized."""
    client: LinearClient = binding.client
    try:
        place = await client.issue_place(name)
    except OperationError as error:
        if error.code in HIDDEN:
            raise _denied() from None
        raise
    issue_id = place.id.lower()
    if not UUID.match(issue_id) or (UUID.match(name) and issue_id != name):
        raise _denied()
    return issue_id, team_resource(binding, place.team)


async def confirm_team(binding: Binding, resource: Resource) -> Team:
    try:
        team = await binding.client.team(resource.id)
    except OperationError as error:
        if error.code in HIDDEN:
            raise team_moved() from None
        raise
    if not same_place(binding, resource, team):
        raise team_moved()
    return team


async def confirm_issue(binding: Binding, issue_id: str, resource: Resource) -> str:
    """The issue's identifier, refused if the issue or its team moved since `resource` was authorized."""
    try:
        place = await binding.client.issue_place(issue_id)
    except OperationError as error:
        if error.code in HIDDEN:
            raise issue_moved() from None
        raise
    if place.id.lower() != issue_id or not same_place(binding, resource, place.team):
        raise issue_moved()
    return place.identifier


def checked_cursor(cursor: str | None) -> str | None:
    if cursor is not None and not _CURSOR.match(cursor):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return cursor


def next_cursor(page: PageInfo) -> str | None:
    if not page.has_next_page or not page.end_cursor:
        return None
    if not _CURSOR.match(page.end_cursor):
        raise OperationError("PROVIDER_LIMIT", "Linear returned a page token Minerva cannot use.")
    return page.end_cursor


def state_data(state: State | None) -> dict[str, str] | None:
    return {"name": state.name, "type": state.type} if state is not None else None
