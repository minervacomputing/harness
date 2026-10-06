"""Jira's write operations: commenting, creating issues and changing their status."""

from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.atlassian import adf
from connectors.base import (
    Binding,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ScopedRecord,
)
from connectors.jira.client import JiraClient, Transition
from connectors.jira.issues import (
    ID,
    PROJECT,
    IssueName,
    ProjectName,
    SiteId,
    confirm_issue,
    hosts,
    link,
    project_resource,
    resolve_issue,
    resolve_project,
)
from connectors.text import single_line

MAX_SUMMARY = 255
MAX_DESCRIPTION = 30_000
MAX_COMMENT = 20_000
MAX_LISTED = 30

WRITE_CONSENT = (frozenset({"write:jira-work"}),)

ShortName = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
Summary = Annotated[
    str,
    Field(min_length=1, max_length=MAX_SUMMARY),
    AfterValidator(single_line),
    AfterValidator(adf.check_written),
]
TEXT_DESCRIPTION = "Plain text, shown literally: no formatting, mentions or links to Atlassian."
Description = Annotated[
    str,
    Field(min_length=1, max_length=MAX_DESCRIPTION, description=TEXT_DESCRIPTION),
    AfterValidator(adf.check_written),
]
CommentText = Annotated[
    str,
    Field(min_length=1, max_length=MAX_COMMENT, description=TEXT_DESCRIPTION),
    AfterValidator(adf.check_written),
]


WRITE_NOTE = (
    "Everyone who can browse the project sees what you write, posted as the signed-in user; watchers are "
    "notified, and the project's automation rules in Jira may make further changes."
)


def _names(values: list[str | None]) -> str:
    names = sorted({value for value in values if value})
    shown = ", ".join(names[:MAX_LISTED])
    return shown + (", …" if len(names) > MAX_LISTED else "") if shown else "none"


class AddComment(OperationInput):
    site_id: SiteId | None = None
    issue: IssueName
    text: CommentText


async def _prepare_add_comment(binding: Binding, data: AddComment) -> Prepared:
    site, resource, issue_id = await resolve_issue(binding, data.site_id, data.issue)
    adf.check_hosts(data.text, hosts(await binding.client.sites()))

    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        issue = await confirm_issue(binding, site, resource, issue_id, "project")
        comment = await client.add_comment(site.id, issue_id, adf.written(data.text))
        record = {
            "written": True,
            "id": comment.id,
            "issue_id": issue_id,
            "issue_key": issue.key,
            "created": comment.created,
            "link": link(site, issue.key),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "comment")], execute)


ADD_COMMENT = Operation(
    name="add_comment",
    title="Comment on an issue",
    description="Add a comment to a Jira issue in a project where you have comment permission. " + WRITE_NOTE,
    input_model=AddComment,
    needs=((PROJECT, "comment"),),
    prepare=_prepare_add_comment,
    consent=WRITE_CONSENT,
    mutates=True,
)


class CreateIssue(OperationInput):
    site_id: SiteId | None = None
    project: ProjectName
    issue_type: Annotated[
        ShortName, Field(description='An issue type\'s name in the project, such as "Task".')
    ]
    summary: Summary
    description: Description | None = None


async def _prepare_create_issue(binding: Binding, data: CreateIssue) -> Prepared:
    site, resource, project = await resolve_project(binding, data.site_id, data.project)
    adf.check_hosts(f"{data.summary}\n{data.description or ''}", hosts(await binding.client.sites()))

    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        # Sub-tasks need a parent issue, which this operation does not take.
        types = [t for t in await client.issue_types(site.id, project.id) if not t.subtask and t.id]
        folded = data.issue_type.casefold()
        matching = [t for t in types if t.name and t.name.casefold() == folded]
        if len(matching) != 1:
            raise OperationError(
                "INVALID_ARGUMENTS",
                f"No single issue type in this project has that name. Types: {_names([t.name for t in types])}.",
            )
        fields: dict[str, Any] = {
            "project": {"id": project.id},
            "issuetype": {"id": matching[0].id},
            "summary": data.summary,
        }
        if data.description is not None:
            fields["description"] = adf.written(data.description)
        created = await client.create_issue(site.id, fields)
        if not ID.match(created.id):
            raise client.unexpected()
        # Automation can move a new issue at once: the record names the project the issue is in now.
        issue = await client.issue(site.id, created.id, "project")
        if issue.id != created.id or issue.fields.project is None:
            raise client.unexpected()
        record = {
            "written": True,
            "id": issue.id,
            "key": issue.key,
            "site_id": site.id,
            "project_id": issue.fields.project.id,
            "link": link(site, issue.key),
        }
        return ProviderOutput(
            [ScopedRecord(project_resource(binding, site, issue.fields.project.id), record)]
        )

    return Prepared([Need(resource, "create")], execute)


CREATE_ISSUE = Operation(
    name="create_issue",
    title="Create an issue",
    description=(
        "Create an issue in a Jira project where you have create permission. Projects that require further "
        "fields are refused by Jira. " + WRITE_NOTE
    ),
    input_model=CreateIssue,
    needs=((PROJECT, "create"),),
    prepare=_prepare_create_issue,
    consent=WRITE_CONSENT,
    mutates=True,
)


class TransitionIssue(OperationInput):
    site_id: SiteId | None = None
    issue: IssueName
    status: Annotated[
        ShortName, Field(description="The status to move the issue to, or the name of the transition.")
    ]


def _pick(transitions: list[Transition], wanted: str) -> Transition:
    folded = wanted.casefold()
    by_status = [t for t in transitions if t.to and t.to.name and t.to.name.casefold() == folded]
    by_name = [t for t in transitions if t.name and t.name.casefold() == folded]
    for found in (by_status, by_name):
        if len({t.id for t in found}) == 1:
            return found[0]
    targets = _names([t.to.name if t.to else None for t in transitions])
    raise OperationError(
        "INVALID_ARGUMENTS",
        f"No single transition of this issue leads to that status. Statuses it can move to: {targets}.",
    )


async def _prepare_transition_issue(binding: Binding, data: TransitionIssue) -> Prepared:
    site, resource, issue_id = await resolve_issue(binding, data.site_id, data.issue)

    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        transitions = await client.transitions(site.id, issue_id)
        # After reading the transitions, so their names are shown only of an issue still in the project, and
        # as close to the write as Jira allows.
        issue = await confirm_issue(binding, site, resource, issue_id, "project")
        transition = _pick(transitions, data.status)
        await client.transition(site.id, issue_id, transition.id)
        record = {
            "written": True,
            "issue_id": issue_id,
            "issue_key": issue.key,
            "status": transition.to.name if transition.to else None,
            "link": link(site, issue.key),
        }
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "transition")], execute)


TRANSITION_ISSUE = Operation(
    name="transition_issue",
    title="Change an issue's status",
    description=(
        "Move a Jira issue to another status through its workflow, in a project where you have change "
        "status permission. Transitions that ask for further fields are refused by Jira. " + WRITE_NOTE
    ),
    input_model=TransitionIssue,
    needs=((PROJECT, "transition"),),
    prepare=_prepare_transition_issue,
    consent=WRITE_CONSENT,
    mutates=True,
)
