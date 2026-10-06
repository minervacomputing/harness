"""Linear's write operations: creating and updating issues, and commenting."""

from datetime import date
from typing import Annotated, Any, Self

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Resource,
    ScopedRecord,
)
from connectors.linear import markdown as text
from connectors.linear.client import MAX_ISSUE_DEPTH, LinearClient, ParentIssue, Person, State, Written
from connectors.linear.teams import (
    CLOSED,
    HIDDEN,
    TEAM,
    UUID,
    IssueName,
    TeamName,
    confirm_issue,
    confirm_team,
    issue_moved,
    resolve_issue,
    resolve_team,
    same_place,
    state_data,
)
from connectors.text import single_line

MAX_TITLE = 255
MAX_DESCRIPTION = 50_000
MAX_COMMENT = 20_000
MAX_LABELS = 10
# How many levels of sub-issues a status change looks through for issues in other teams.
SUB_ISSUE_DEPTH = 3


def _uuid(value: str) -> str:
    if not UUID.match(value.lower()):
        raise ValueError("must be a Linear id")
    return value.lower()


def _due_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValueError("must be a date such as 2026-10-01") from None


Title = Annotated[str, Field(min_length=1, max_length=MAX_TITLE), AfterValidator(single_line)]
ShortName = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
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
    AfterValidator(single_line),
]
LabelNames = Annotated[
    list[ShortName],
    Field(
        min_length=1,
        max_length=MAX_LABELS,
        description='Label names; "Group/Label" picks a label inside a label group.',
    ),
]


WRITE_NOTE = (
    "Everyone who can see the team sees what you write; subscribers are notified, assignees are notified, "
    "and the team's automations in Linear may make further changes."
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
        "state": state_data(written.state),
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
    resource = await resolve_team(binding, data.team)

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
        await confirm_team(binding, resource)
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
    issue_id, resource = await resolve_issue(binding, data.issue)

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
        identifier = await confirm_issue(binding, issue_id, resource)
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
    issue_id, resource = await resolve_issue(binding, data.issue)

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
                raise issue_moved() from None
            raise
        if issue.id.lower() != issue_id or not same_place(binding, resource, issue.team):
            raise issue_moved()
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
                await confirm_issue(binding, issue_id, resource)
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
