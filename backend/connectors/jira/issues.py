"""What Jira's operations share: sites, project and issue names, and where issues sit."""

import re
from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.atlassian import CLOUD_ID, Site
from connectors.base import Binding, OperationError, Resource, denied
from connectors.jira.client import Issue, JiraClient, Project

PROJECT = "project"
HIDDEN = frozenset({"NOT_FOUND", "PROVIDER_FORBIDDEN"})

ID = re.compile(r"^\d{1,18}$")
_PROJECT_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,254}$")
_ISSUE_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,254}-\d{1,9}$")


def _site_id(value: str) -> str:
    folded = value.lower()
    if not CLOUD_ID.match(folded):
        raise ValueError("must be a site id from list_projects")
    return folded


def _project_name(value: str) -> str:
    if ID.match(value) or _PROJECT_KEY.match(value.upper()):
        return value.upper()
    raise ValueError('must be a project key such as "ENG", or a project id')


def _issue_name(value: str) -> str:
    if ID.match(value) or _ISSUE_KEY.match(value.upper()):
        return value.upper()
    raise ValueError('must be an issue key such as "ENG-123", or an issue id')


SiteId = Annotated[
    str,
    Field(
        min_length=36,
        max_length=36,
        description="The site's id, from list_projects. Needed only when the connection reaches several sites.",
    ),
    AfterValidator(_site_id),
]
ProjectName = Annotated[
    str,
    Field(min_length=1, max_length=255, description='A project key such as "ENG", or a project id.'),
    AfterValidator(_project_name),
]
IssueName = Annotated[
    str,
    Field(min_length=1, max_length=266, description='An issue key such as "ENG-123", or an issue id.'),
    AfterValidator(_issue_name),
]


def unseen(error: OperationError) -> bool:
    return error.code in HIDDEN


def issue_moved() -> OperationError:
    return OperationError(
        "ISSUE_MOVED", "This issue moved in Jira while Minerva was using it, or access was lost. Try again."
    )


def project_id(site: Site, project: str) -> str:
    return f"{site.id}/{project}"


def project_resource(binding: Binding, site: Site, project: str | None) -> Resource:
    """The resource of a project Jira named. A malformed id fails rather than being guessed."""
    if project is None or not ID.match(project):
        raise binding.client.unexpected()
    return binding.resource(PROJECT, project_id(site, project), (site.id,))


def hosts(sites: list[Site]) -> list[str]:
    """The hosts of the connection's sites, whose addresses text hides as links to Atlassian."""
    return [site.host for site in sites if site.host]


async def resolve_project(binding: Binding, site_id: str | None, name: str) -> tuple[Site, Resource, Project]:
    """The project a call names. One the account cannot see is refused like one without a grant."""
    client: JiraClient = binding.client
    site = await client.site(site_id)
    try:
        project = await client.project(site.id, name)
    except OperationError as error:
        if unseen(error):
            raise denied() from None
        raise
    # A former key leads to the project too; grants are on its id, so that spelling changes nothing.
    return site, project_resource(binding, site, project.id), project


async def resolve_issue(binding: Binding, site_id: str | None, name: str) -> tuple[Site, Resource, str]:
    """The issue a call names: its site, its project's resource and its id. Jira also answers to an issue's
    former keys; the project is the one the issue is in now. One the account cannot see is refused like one
    without a grant."""
    client: JiraClient = binding.client
    site = await client.site(site_id)
    try:
        issue = await client.issue(site.id, name, "project")
    except OperationError as error:
        if unseen(error):
            raise denied() from None
        raise
    if not ID.match(issue.id) or issue.fields.project is None:
        raise client.unexpected()
    return site, project_resource(binding, site, issue.fields.project.id), issue.id


async def confirm_issue(
    binding: Binding, site: Site, resource: Resource, issue_id: str, fields: str
) -> Issue:
    """The issue read again by id, refused unless it is still in the project it was authorized in."""
    client: JiraClient = binding.client
    try:
        issue = await client.issue(
            site.id, issue_id, fields if "project" in fields.split(",") else f"{fields},project"
        )
    except OperationError as error:
        if unseen(error):
            raise issue_moved() from None
        raise
    project = issue.fields.project
    if issue.id != issue_id or project is None or project_id(site, project.id) != resource.id:
        raise issue_moved()
    return issue


def link(site: Site, key: str) -> str | None:
    return f"https://{site.host}/browse/{key}" if site.host else None
