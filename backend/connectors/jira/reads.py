"""Jira's read operations: projects, issue search and single issues."""

import re
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from connectors.atlassian import Site, adf
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
)
from connectors.jira.client import Comment, Issue, JiraClient, Project
from connectors.jira.issues import (
    ID,
    PROJECT,
    IssueName,
    ProjectName,
    SiteId,
    confirm_issue,
    hosts,
    link,
    project_id,
    project_resource,
    resolve_issue,
    resolve_project,
)
from connectors.text import single_line, truncate

MAX_PROJECT_PAGES = 20
MAX_SEARCH_WORDS = 8
MAX_DESCRIPTION = 20_000
MAX_COMMENT = 4_000
MAX_COMMENTS = 30
MAX_RELATED = 50
MAX_SHORT = 500

# Jira's status categories by id: "To Do" 2, "In Progress" 4, "Done" 3.
STATUS_CATEGORIES = {"to_do": 2, "in_progress": 4, "done": 3}
SEARCH_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated", "project"]
ISSUE_FIELDS = (
    "summary,status,issuetype,priority,assignee,reporter,labels,created,updated,duedate,resolution,"
    "description,parent,subtasks,issuelinks,attachment,project"
)
RELATED_FIELDS = ["summary", "status", "project"]

Cursor = Annotated[str, Field(max_length=1000)]
_WORD = re.compile(r"\w+")


def _short(value: str | None, site_hosts: list[str]) -> str | None:
    shown, _ = truncate(adf.redact(value, site_hosts) if value else None, MAX_SHORT)
    return shown or None


def _status(issue: Issue) -> dict[str, Any] | None:
    status = issue.fields.status
    if status is None:
        return None
    category = status.status_category
    return {"name": status.name, "category": category.name if category else None}


def _project_data(site: Site, project: Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "site_id": site.id,
        "site": site.label,
        "key": project.key,
        "name": project.name,
        "type": project.project_type_key,
        "archived": bool(project.archived),
    }


class ListProjects(OperationInput):
    site_id: Annotated[SiteId | None, Field(description="A site's id; without one, every site.")] = None


async def _prepare_list_projects(binding: Binding, data: ListProjects) -> Prepared:
    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        sites = [await client.site(data.site_id)] if data.site_id else await client.sites()
        records: list[ScopedRecord] = []
        incomplete = False
        for site in sites:
            start: int | None = 0
            for _ in range(MAX_PROJECT_PAGES):
                projects, start = await client.projects(site.id, start=start or 0, limit=50)
                records += [
                    ScopedRecord(project_resource(binding, site, p.id), _project_data(site, p))
                    for p in projects
                ]
                if start is None:
                    break
            incomplete = incomplete or start is not None
        return ProviderOutput(records, incomplete=incomplete)

    return Prepared([Enumerate(PROJECT, "read")], execute)


LIST_PROJECTS = Operation(
    name="list_projects",
    title="List projects",
    description="List the Jira projects you may read, with the site each is on.",
    input_model=ListProjects,
    needs=((PROJECT, "read"),),
    prepare=_prepare_list_projects,
)


def _search_words(text: str) -> str:
    words = _WORD.findall(text)[:MAX_SEARCH_WORDS]
    if not words:
        raise OperationError("INVALID_ARGUMENTS", "text must contain letters or digits.")
    return " ".join(words)


SearchText = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        description="Words to find in the summary (descriptions and comments are not searched).",
    ),
    AfterValidator(single_line),
]


class SearchIssues(OperationInput):
    site_id: SiteId | None = None
    project: ProjectName
    text: SearchText | None = None
    status_category: Literal["to_do", "in_progress", "done"] | None = None
    assigned_to_me: bool = False
    limit: Annotated[int, Field(ge=1, le=50)] = 25
    cursor: Cursor | None = None


async def _prepare_search_issues(binding: Binding, data: SearchIssues) -> Prepared:
    site, resource, project = await resolve_project(binding, data.site_id, data.project)

    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        # The query is built from fields, never taken from the agent: JQL functions can select issues by
        # their relations to issues in other projects. Summaries only: Jira's text search also matches
        # descriptions and comments, whose links can carry titles of issues the agent may not read.
        clauses = [f"project = {project.id}"]
        if data.text is not None:
            clauses.append(f'summary ~ "{_search_words(data.text)}"')
        if data.status_category is not None:
            clauses.append(f"statusCategory = {STATUS_CATEGORIES[data.status_category]}")
        if data.assigned_to_me:
            clauses.append("assignee = currentUser()")
        jql = " AND ".join(clauses) + " ORDER BY updated DESC"
        try:
            ids, cursor = await client.search(site.id, jql, limit=data.limit, cursor=data.cursor)
        except OperationError as error:
            if error.code == "PROVIDER_REJECTED":
                raise OperationError("INVALID_ARGUMENTS", "Jira could not run this search.") from None
            raise
        # Search reads an index that can lag behind moves: each issue is read again, and shown under the
        # project it is in now.
        issues = await client.bulk(site.id, [i for i in ids if ID.match(i)], SEARCH_FIELDS) if ids else []
        site_hosts = hosts(await client.sites())
        records = []
        for issue in issues:
            if not ID.match(issue.id) or issue.fields.project is None:
                continue
            fields = issue.fields
            record = {
                "id": issue.id,
                "key": issue.key,
                "site_id": site.id,
                "project_id": fields.project.id,
                "summary": _short(fields.summary, site_hosts),
                "status": _status(issue),
                "type": fields.issuetype.name if fields.issuetype else None,
                "priority": fields.priority.name if fields.priority else None,
                "assignee": fields.assignee.display_name if fields.assignee else None,
                "updated": fields.updated,
                "link": link(site, issue.key),
            }
            records.append(ScopedRecord(project_resource(binding, site, fields.project.id), record))
        return ProviderOutput(records, cursor)

    return Prepared([Need(resource, "read")], execute)


SEARCH_ISSUES = Operation(
    name="search_issues",
    title="Search issues",
    description=(
        "Find a project's issues, most recently updated first, by words in the summary, status category or "
        "assignment to you. To get the next page, repeat the call with identical arguments plus the "
        "returned next_cursor."
    ),
    input_model=SearchIssues,
    needs=((PROJECT, "read"),),
    prepare=_prepare_search_issues,
    paginated=True,
)


READ_NOTE = (
    "Links to Atlassian appear without their titles, macros without their content, and related issues in "
    "other projects only as a count."
)


def _comment(comment: Comment, site_hosts: list[str]) -> dict[str, Any]:
    body, truncated = truncate(adf.read(comment.body, site_hosts), MAX_COMMENT)
    return {
        "id": comment.id,
        "author": comment.author.display_name if comment.author else None,
        "created": comment.created,
        "updated": comment.updated,
        "text": body,
        "text_truncated": truncated,
    }


def _relations(issue: Issue) -> list[tuple[str, str]]:
    """The issues this one is related to, as (id, relation), once each."""
    fields = issue.fields
    found: list[tuple[str, str]] = []
    if fields.parent is not None:
        found.append((fields.parent.id, "parent"))
    found += [(subtask.id, "subtask") for subtask in fields.subtasks]
    for issue_link in fields.issuelinks:
        kind = issue_link.type
        if issue_link.outward_issue is not None:
            found.append((issue_link.outward_issue.id, (kind.outward if kind else None) or "related"))
        if issue_link.inward_issue is not None:
            found.append((issue_link.inward_issue.id, (kind.inward if kind else None) or "related"))
    seen: set[tuple[str, str]] = set()
    return [r for r in found if ID.match(r[0]) and not (r in seen or seen.add(r))]


async def _related(
    client: JiraClient, site: Site, resource: Resource, issue: Issue, site_hosts: list[str]
) -> dict[str, Any]:
    """Related issues in the same project, read fresh; the others only counted. An issue's embedded
    relations do not say which project the other issue is in, so each is read to find out."""
    relations = _relations(issue)
    shown = relations[:MAX_RELATED]
    ids = list(dict.fromkeys(issue_id for issue_id, _ in shown))
    found = {i.id: i for i in await client.bulk(site.id, ids, RELATED_FIELDS)} if ids else {}
    related: list[dict[str, Any]] = []
    elsewhere = 0
    for issue_id, relation in shown:
        other = found.get(issue_id)
        project = other.fields.project if other else None
        if other is None or project is None or project_id(site, project.id) != resource.id:
            elsewhere += 1
            continue
        related.append(
            {
                "relation": _short(relation, site_hosts),
                "key": other.key,
                "summary": _short(other.fields.summary, site_hosts),
                "status": _status(other),
            }
        )
    return {
        "related": related,
        "related_elsewhere": elsewhere,
        "related_not_shown": len(relations) - len(shown),
    }


class GetIssue(OperationInput):
    site_id: SiteId | None = None
    issue: IssueName


async def _prepare_get_issue(binding: Binding, data: GetIssue) -> Prepared:
    site, resource, issue_id = await resolve_issue(binding, data.site_id, data.issue)

    async def execute() -> ProviderOutput:
        client: JiraClient = binding.client
        comments, total = await client.comments(site.id, issue_id, limit=MAX_COMMENTS)
        # Last, so the issue is seen in the project after its comments were read.
        issue = await confirm_issue(binding, site, resource, issue_id, ISSUE_FIELDS)
        site_hosts = hosts(await client.sites())
        fields = issue.fields
        description, description_truncated = truncate(
            adf.read(fields.description, site_hosts), MAX_DESCRIPTION
        )
        record = {
            "id": issue.id,
            "key": issue.key,
            "site_id": site.id,
            "project_id": fields.project.id if fields.project else None,
            "summary": _short(fields.summary, site_hosts),
            "status": _status(issue),
            "type": fields.issuetype.name if fields.issuetype else None,
            "priority": fields.priority.name if fields.priority else None,
            "assignee": fields.assignee.display_name if fields.assignee else None,
            "reporter": fields.reporter.display_name if fields.reporter else None,
            "labels": fields.labels,
            "created": fields.created,
            "updated": fields.updated,
            "due_date": fields.duedate,
            "resolution": fields.resolution.name if fields.resolution else None,
            "description": description,
            "description_truncated": description_truncated,
            "attachments": len(fields.attachment),
            "comments": [_comment(comment, site_hosts) for comment in reversed(comments)],
            "comments_not_shown": max(total - len(comments), 0),
            "link": link(site, issue.key),
        } | await _related(client, site, resource, issue, site_hosts)
        return ProviderOutput([ScopedRecord(resource, record)])

    return Prepared([Need(resource, "read")], execute)


GET_ISSUE = Operation(
    name="get_issue",
    title="Read an issue",
    description=(
        "Read one Jira issue with its description, latest comments and related issues. " + READ_NOTE
    ),
    input_model=GetIssue,
    needs=((PROJECT, "read"),),
    prepare=_prepare_get_issue,
)
