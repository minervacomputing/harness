"""Jira Cloud's REST API (v3), reached per site through api.atlassian.com.

Search pages with an opaque `nextPageToken`; this client keeps it as the page cursor, checked to be
printable and short enough to store, and sends it back as a query parameter. Other lists page by offset.
"""

import re
from typing import Any

import httpx
from pydantic import Field

from connectors.atlassian import AtlassianClient, Model, segment
from connectors.base import OperationError

MAX_PAGES = 10
BULK_LIMIT = 100
_TOKEN = re.compile(r"\A[\x21-\x7e]{1,990}\Z")
PREFIX = "t:"


class Project(Model):
    id: str
    key: str
    name: str | None = None
    project_type_key: str | None = None
    archived: bool | None = None


class Named(Model):
    name: str | None = None


class StatusCategory(Model):
    key: str | None = None
    name: str | None = None


class Status(Model):
    name: str | None = None
    status_category: StatusCategory | None = None


class IssueType(Model):
    id: str | None = None
    name: str | None = None
    subtask: bool | None = None


class Person(Model):
    display_name: str | None = None


class ProjectRef(Model):
    id: str
    key: str | None = None


class Related(Model):
    id: str


class LinkType(Model):
    name: str | None = None
    inward: str | None = None
    outward: str | None = None


class IssueLink(Model):
    type: LinkType | None = None
    inward_issue: Related | None = None
    outward_issue: Related | None = None


class Fields(Model):
    project: ProjectRef | None = None
    summary: str | None = None
    status: Status | None = None
    issuetype: IssueType | None = None
    priority: Named | None = None
    assignee: Person | None = None
    reporter: Person | None = None
    labels: list[str] = []
    created: str | None = None
    updated: str | None = None
    duedate: str | None = None
    resolution: Named | None = None
    description: Any = None
    parent: Related | None = None
    subtasks: list[Related] = []
    issuelinks: list[IssueLink] = []
    attachment: list[dict[str, Any]] = []


class Issue(Model):
    id: str
    key: str
    fields: Fields = Field(default_factory=Fields)


class Comment(Model):
    id: str
    author: Person | None = None
    body: Any = None
    created: str | None = None
    updated: str | None = None


class Transition(Model):
    id: str
    name: str | None = None
    to: Status | None = None


class Found(Model):
    id: str


class Created(Model):
    id: str
    key: str | None = None


def page_params(cursor: str | None) -> dict[str, str]:
    if cursor is None:
        return {}
    token = cursor.removeprefix(PREFIX)
    if not cursor.startswith(PREFIX) or not _TOKEN.match(token):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return {"nextPageToken": token}


def next_cursor(body: dict[str, Any]) -> str | None:
    token = body.get("nextPageToken")
    if token is None or body.get("isLast") is True:
        return None
    if not isinstance(token, str) or not _TOKEN.match(token):
        raise OperationError("PROVIDER_LIMIT", "Jira returned a page token Minerva cannot use.")
    return f"{PREFIX}{token}"


class JiraClient(AtlassianClient):
    """Thin async client for the parts of Jira's API the connector uses."""

    def __init__(self, access_token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__("Jira", "jira", access_token, scope="read:jira-work", transport=transport)

    def _path(self, cloud_id: str, path: str) -> str:
        return f"{self.api(cloud_id)}/rest/api/3{path}"

    async def _object(self, cloud_id: str, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        body = await self.get(self._path(cloud_id, path), params=params)
        if not isinstance(body, dict):
            raise self.unexpected()
        return body

    def _items[M: Model](self, model: type[M], body: dict[str, Any], field: str) -> list[M]:
        items = body.get(field)
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(model, item) for item in items]

    async def projects(
        self, cloud_id: str, *, start: int, limit: int, query: str | None = None
    ) -> tuple[list[Project], int | None]:
        """One page of the projects the account may browse, and the offset of the next page."""
        params = {"startAt": str(start), "maxResults": str(limit), "action": "browse", "orderBy": "key"}
        if query:
            params["query"] = query
        body = await self._object(cloud_id, "/project/search", params)
        projects = self._items(Project, body, "values")
        last = body.get("isLast", True) is not False or not projects
        return projects, None if last else start + len(projects)

    async def all_projects(self, cloud_id: str) -> list[Project]:
        found: list[Project] = []
        start: int | None = 0
        for _ in range(MAX_PAGES):
            projects, start = await self.projects(cloud_id, start=start or 0, limit=50)
            found += projects
            if start is None:
                return found
        raise OperationError("PROVIDER_LIMIT", "There are more Jira projects than Minerva reads.")

    async def project(self, cloud_id: str, key_or_id: str) -> Project:
        return self._parse(Project, await self._object(cloud_id, f"/project/{segment(key_or_id)}"))

    async def issue(self, cloud_id: str, key_or_id: str, fields: str) -> Issue:
        return self._parse(
            Issue, await self._object(cloud_id, f"/issue/{segment(key_or_id)}", {"fields": fields})
        )

    async def bulk(self, cloud_id: str, ids: list[str], fields: list[str]) -> list[Issue]:
        """The issues with these ids, read fresh; ones the account cannot see are left out."""
        found: list[Issue] = []
        for start in range(0, len(ids), BULK_LIMIT):
            body = await self.read_post(
                self._path(cloud_id, "/issue/bulkfetch"),
                {"issueIdsOrKeys": ids[start : start + BULK_LIMIT], "fields": fields},
            )
            if not isinstance(body, dict):
                raise self.unexpected()
            found += self._items(Issue, body, "issues")
        # Jira answers in ascending id order; the caller's order (a search's) is kept.
        order = {issue_id: index for index, issue_id in enumerate(ids)}
        return sorted((issue for issue in found if issue.id in order), key=lambda issue: order[issue.id])

    async def search(
        self, cloud_id: str, jql: str, *, limit: int, cursor: str | None
    ) -> tuple[list[str], str | None]:
        """The ids of one page of issues matching `jql`."""
        params = {"jql": jql, "maxResults": str(limit), "fields": "id", **page_params(cursor)}
        body = await self._object(cloud_id, "/search/jql", params)
        return [issue.id for issue in self._items(Found, body, "issues")], next_cursor(body)

    async def comments(self, cloud_id: str, issue_id: str, *, limit: int) -> tuple[list[Comment], int]:
        """The latest comments, newest first, and how many there are in all."""
        body = await self._object(
            cloud_id,
            f"/issue/{segment(issue_id)}/comment",
            {"orderBy": "-created", "maxResults": str(limit), "startAt": "0"},
        )
        comments = self._items(Comment, body, "comments")
        total = body.get("total")
        return comments, total if isinstance(total, int) else len(comments)

    async def issue_types(self, cloud_id: str, project_id: str) -> list[IssueType]:
        """The issue types issues can be created with in a project."""
        found: list[IssueType] = []
        for _ in range(MAX_PAGES):
            body = await self._object(
                cloud_id,
                f"/issue/createmeta/{segment(project_id)}/issuetypes",
                {"startAt": str(len(found)), "maxResults": "50"},
            )
            field = "issueTypes" if "issueTypes" in body else "values"
            types = self._items(IssueType, body, field)
            found += types
            total = body.get("total")
            if not types or not isinstance(total, int) or len(found) >= total:
                return found
        raise OperationError("PROVIDER_LIMIT", "This Jira project has more issue types than Minerva reads.")

    async def transitions(self, cloud_id: str, issue_id: str) -> list[Transition]:
        body = await self._object(cloud_id, f"/issue/{segment(issue_id)}/transitions")
        return self._items(Transition, body, "transitions")

    # Writes: each operation sends exactly one.

    async def add_comment(self, cloud_id: str, issue_id: str, body: dict[str, Any]) -> Comment:
        return await self._http.parsed(
            Comment, "POST", self._path(cloud_id, f"/issue/{segment(issue_id)}/comment"), json={"body": body}
        )

    async def create_issue(self, cloud_id: str, fields: dict[str, Any]) -> Created:
        return await self._http.parsed(
            Created, "POST", self._path(cloud_id, "/issue"), json={"fields": fields}
        )

    async def transition(self, cloud_id: str, issue_id: str, transition_id: str) -> None:
        await self._http.request(
            "POST",
            self._path(cloud_id, f"/issue/{segment(issue_id)}/transitions"),
            json={"transition": {"id": transition_id}},
        )
