"""Sentry's REST API on sentry.io.

A token reaches one organisation, the one the user chose on Sentry's consent screen, and the organisation
list shows only that one. The list is read on sentry.io, and the organisation's API calls go to its region
(us.sentry.io or de.sentry.io) when Sentry names one of those, or to sentry.io otherwise. The token is
never sent to any other host. Paths name the organisation by the slug that same list gave.

Every response is read with a byte limit and validated before use. Pages are followed by the cursor in the
`Link` header; only the cursor is taken from it, never its address. Sentry's error messages are not passed on.
"""

import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OperationError
from connectors.http import ProviderHTTP

API_URL = "https://sentry.io"
REGIONS = frozenset({"https://us.sentry.io", "https://de.sentry.io"})
# Project, issue and user ids are positive integers; leading zeros are refused, so each has one spelling.
# Patterns end in \Z, not $, which also matches before a final newline.
ID = re.compile(r"\A[1-9][0-9]{0,19}\Z")
EVENT_ID = re.compile(r"\A[0-9a-f]{32}\Z")
SLUG = re.compile(r"\A[a-z0-9][a-z0-9_-]{0,99}\Z")
MAX_RESPONSE = 4 * 1024 * 1024
MAX_EVENT = 8 * 1024 * 1024
# Sentry's cursors look like "1727950000000:0:0"; they are checked, never followed as addresses.
_CURSOR = re.compile(r"\A[0-9A-Za-z.:_-]{1,200}\Z")
_LINK = re.compile(r'<[^>]*>((?:\s*;\s*[a-z]+="[^"]*")*)')
_PARAM = re.compile(r'([a-z]+)="([^"]*)"')


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class User(Model):
    id: str
    name: str | None = None
    email: str | None = None


class Links(Model):
    regionUrl: str | None = None


class Organisation(Model):
    id: str
    slug: str
    name: str | None = None
    links: Links | None = None


class Project(Model):
    id: str
    slug: str
    name: str | None = None
    platform: str | None = None


class IssueProject(Model):
    # Required: the project decides who may see an issue, so a response without it is not guessed at.
    id: str
    slug: str | None = None
    name: str | None = None


class Assignee(Model):
    type: str | None = None
    name: str | None = None


class Release(Model):
    version: str | None = None


class TagSummary(Model):
    key: str
    name: str | None = None
    totalValues: int | None = None


class Issue(Model):
    id: str
    shortId: str | None = None
    title: str | None = None
    culprit: str | None = None
    level: str | None = None
    status: str | None = None
    substatus: str | None = None
    priority: str | None = None
    count: str | None = None
    userCount: int | None = None
    firstSeen: str | None = None
    lastSeen: str | None = None
    platform: str | None = None
    permalink: str | None = None
    project: IssueProject
    assignedTo: Assignee | None = None
    # Issue detail only.
    firstRelease: Release | None = None
    lastRelease: Release | None = None
    tags: list[TagSummary] = []
    numComments: int | None = None
    userReportCount: int | None = None


class ShortId(Model):
    groupId: str
    organizationSlug: str | None = None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    if response.status_code == 403:
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "Sentry refused this request. The connected account may not be a member of this project's team, "
            "or the connection lacks a permission; connecting it again asks for them.",
        )
    return None


def cursor(value: str | None) -> str | None:
    """A cursor from a call, checked before it is sent."""
    if value is not None and not _CURSOR.match(value):
        raise OperationError("INVALID_CURSOR", "This page token is invalid.")
    return value


def next_cursor(response: httpx.Response) -> str | None:
    """The cursor of the next page, from the `Link` header, when Sentry says it has results."""
    for match in _LINK.finditer(response.headers.get("link", "")):
        params = dict(_PARAM.findall(match.group(1)))
        if params.get("rel") == "next" and params.get("results") == "true":
            found = params.get("cursor")
            if found is None or not _CURSOR.match(found):
                raise OperationError("PROVIDER_LIMIT", "Sentry returned a page token Minerva cannot use.")
            return found
    return None


def invalid_cursor(error: OperationError, sent: str | None) -> OperationError:
    """A refused page request is the cursor's fault when one was sent: other arguments are checked first."""
    if error.code == "PROVIDER_REJECTED" and sent is not None:
        return OperationError("INVALID_CURSOR", "This page token is invalid.")
    return error


class SentryClient:
    def __init__(self, token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self._token = token
        self._transport = transport
        self._control = self._open(API_URL)
        self._region: ProviderHTTP | None = None
        self._organisation: Organisation | None = None

    def _open(self, base_url: str) -> ProviderHTTP:
        return ProviderHTTP(
            "Sentry",
            base_url=base_url,
            headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
            transport=self._transport,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._control.aclose()
        if self._region is not None:
            await self._region.aclose()

    def unexpected(self) -> OperationError:
        return self._control.unexpected()

    async def _get(
        self, http: ProviderHTTP, path: str, *, limit: int = MAX_RESPONSE, **kwargs: Any
    ) -> httpx.Response:
        return await http.bounded(
            path,
            limit=limit,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Sentry's response was too large to read."),
            **kwargs,
        )

    def _parse[M: BaseModel](self, model: type[M], response: httpx.Response) -> M:
        try:
            return model.model_validate_json(response.content)
        except ValueError as error:
            raise self.unexpected() from error

    async def user(self) -> User:
        found = self._parse(User, await self._get(self._control, "/api/0/auth/"))
        if not ID.match(found.id):
            raise self.unexpected()
        return found

    async def organisations(self) -> list[Organisation]:
        response = await self._get(self._control, "/api/0/organizations/")
        try:
            found = [Organisation.model_validate(o) for o in response.json()]
        except (ValueError, TypeError) as error:
            raise self.unexpected() from error
        if any(not ID.match(o.id) or not SLUG.match(o.slug) for o in found):
            raise self.unexpected()
        return found

    async def organisation(self) -> Organisation:
        """The one organisation this token reaches."""
        if self._organisation is None:
            found = await self.organisations()
            if len(found) != 1:
                raise OperationError(
                    "PROVIDER_FAILED", "Sentry did not name the one organisation this connection reaches."
                )
            self._organisation = found[0]
        return self._organisation

    async def _api(self) -> tuple[ProviderHTTP, str]:
        """The client for the organisation's region, and the path prefix naming the organisation."""
        organisation = await self.organisation()
        if self._region is None:
            region = organisation.links.regionUrl if organisation.links else None
            self._region = self._open(region if region in REGIONS else API_URL)
        return self._region, f"/api/0/organizations/{organisation.slug}"

    async def _org_get(self, path: str, *, limit: int = MAX_RESPONSE, **kwargs: Any) -> httpx.Response:
        http, prefix = await self._api()
        return await self._get(http, prefix + path, limit=limit, **kwargs)

    async def _project_get(self, project: str) -> httpx.Response:
        http, _ = await self._api()
        organisation = await self.organisation()
        return await self._get(http, f"/api/0/projects/{organisation.slug}/{project}/")

    async def projects(
        self, *, query: str | None = None, after: str | None = None, per_page: int = 100
    ) -> tuple[list[Project], str | None]:
        params: dict[str, Any] = {"per_page": per_page}
        if query:
            params["query"] = query
        if after is not None:
            params["cursor"] = cursor(after)
        try:
            response = await self._org_get("/projects/", params=params)
        except OperationError as error:
            raise invalid_cursor(error, after) from None
        try:
            found = [Project.model_validate(p) for p in response.json()]
        except (ValueError, TypeError) as error:
            raise self.unexpected() from error
        if any(not ID.match(p.id) for p in found):
            raise self.unexpected()
        return found, next_cursor(response)

    async def project(self, name: str) -> Project:
        """A project by id or slug."""
        found = self._parse(Project, await self._project_get(name))
        if not ID.match(found.id) or (ID.match(name) and found.id != name):
            raise self.unexpected()
        return found

    def _checked(self, issue: Issue) -> Issue:
        if not ID.match(issue.id) or not ID.match(issue.project.id):
            raise self.unexpected()
        return issue

    async def issues(self, params: dict[str, Any], after: str | None) -> tuple[list[Issue], str | None]:
        if after is not None:
            params = {**params, "cursor": cursor(after)}
        try:
            response = await self._org_get("/issues/", params=params)
        except OperationError as error:
            raise invalid_cursor(error, after) from None
        try:
            found = [self._checked(Issue.model_validate(i)) for i in response.json()]
        except (ValueError, TypeError) as error:
            raise self.unexpected() from error
        return found, next_cursor(response)

    async def issue(self, issue_id: str) -> Issue:
        """An issue by id. Sentry answers for an id merged into another issue with that issue."""
        return self._checked(self._parse(Issue, await self._org_get(f"/issues/{issue_id}/")))

    async def short_id(self, short_id: str) -> str:
        """The id of the issue a short id names."""
        found = self._parse(ShortId, await self._org_get(f"/shortids/{short_id}/"))
        organisation = await self.organisation()
        if not ID.match(found.groupId) or found.organizationSlug not in {None, organisation.slug}:
            raise self.unexpected()
        return found.groupId

    async def event(self, issue_id: str, event: str) -> dict[str, Any]:
        """One event of an issue, as Sentry sent it; `reads` picks what is shown."""
        response = await self._org_get(f"/issues/{issue_id}/events/{event}/", limit=MAX_EVENT)
        try:
            found = response.json()
        except ValueError as error:
            raise self.unexpected() from error
        if not isinstance(found, dict):
            raise self.unexpected()
        return found
