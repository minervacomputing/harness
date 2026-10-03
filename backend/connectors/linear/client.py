"""Linear's GraphQL API.

GraphQL answers with 200 even when a request failed, and reports why in `errors`. Reads fail closed: a
response with any error is refused as a whole, so partial data is never used. A write counts as applied
only when Linear confirms it (`success: true`), and as not applied only when Linear refused the request
before running it (a malformed request, or only rate limit and authentication errors); anything else
leaves its outcome unknown, which pauses further writes. Read responses are streamed with a byte limit.
"""

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.http import Effect, ProviderHTTP

API_URL = "https://api.linear.app"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# How many parent teams (and parent issues) a request resolves; one more level is asked for, to tell
# whether the chain goes on.
MAX_TEAM_DEPTH = 8
MAX_ISSUE_DEPTH = 5
MAX_LIST_PAGES = 4
# Errors Linear raises before it runs a request.
REFUSED_BEFORE_RUNNING = frozenset({"ratelimited", "authentication error"})
MALFORMED = frozenset({"GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"})


def _nested(fields: str, depth: int) -> str:
    return "" if depth == 0 else f"parent {{ {fields} {_nested(fields, depth - 1)} }}"


TEAM_FIELDS = f"id key name description private {_nested('id', MAX_TEAM_DEPTH + 1)}"
ISSUE_SUMMARY = (
    "id identifier title priorityLabel dueDate updatedAt url state { name type } assignee { name } "
    "team { id }"
)
PAGE_INFO = "pageInfo { hasNextPage endCursor }"


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class PageInfo(Model):
    has_next_page: bool = False
    end_cursor: str | None = None


class TeamRef(Model):
    id: str
    parent: TeamRef | None = None


class Team(TeamRef):
    key: str
    name: str
    description: str | None = None
    private: bool = False


class Teams(Model):
    nodes: list[Team]
    page_info: PageInfo


class Named(Model):
    name: str | None = None


class State(Model):
    id: str | None = None
    name: str
    type: str


class Person(Model):
    id: str
    name: str
    display_name: str | None = None
    active: bool = True


class Label(Model):
    id: str
    name: str
    is_group: bool = False
    parent: Named | None = None


class IssueSummary(Model):
    id: str
    identifier: str
    title: str
    priority_label: str | None = None
    due_date: str | None = None
    updated_at: str | None = None
    url: str | None = None
    state: State | None = None
    assignee: Named | None = None
    team: TeamRef


class IssueList(Model):
    nodes: list[IssueSummary]
    page_info: PageInfo


class TeamIssues(Team):
    issues: IssueList


class Labels(Model):
    nodes: list[Named]
    page_info: PageInfo


class Relative(Model):
    identifier: str
    title: str
    state: State | None = None
    team: TeamRef


class Relatives(Model):
    nodes: list[Relative]
    page_info: PageInfo


class Comment(Model):
    id: str
    body: str = ""
    created_at: str | None = None
    hide_in_linear: bool = False
    parent: TeamRef | None = None  # only its id is asked for
    user: Named | None = None
    bot_actor: Named | None = None
    external_user: Named | None = None

    @property
    def author(self) -> str | None:
        for actor in (self.user, self.bot_actor, self.external_user):
            if actor is not None and actor.name:
                return actor.name
        return None


class Comments(Model):
    nodes: list[Comment]
    page_info: PageInfo


class Issue(Model):
    id: str
    identifier: str
    title: str
    description: str | None = None
    priority_label: str | None = None
    estimate: float | None = None
    due_date: str | None = None
    url: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None
    canceled_at: str | None = None
    state: State | None = None
    assignee: Named | None = None
    creator: Named | None = None
    project: Named | None = None
    labels: Labels
    team: Team
    parent: Relative | None = None
    children: Relatives
    comments: Comments


class IssuePlace(Model):
    id: str
    identifier: str
    team: Team


class ParentIssue(Model):
    id: str
    team: TeamRef
    parent: ParentIssue | None = None


class IssueForUpdate(IssuePlace):
    parent: ParentIssue | None = None


class CommentPlace(Model):
    id: str
    issue: TeamRef | None = None  # only its id is asked for
    parent: TeamRef | None = None


class Organization(Model):
    name: str
    url_key: str


class Viewer(Model):
    id: str
    name: str


class Me(Model):
    viewer: Viewer
    organization: Organization


class Written(Model):
    """What a write returns: the issue it created or changed."""

    id: str
    identifier: str
    title: str
    url: str | None = None
    state: State | None = None
    team: TeamRef


class WrittenComment(Model):
    id: str
    created_at: str | None = None


def _errors(body: Any) -> list[dict[str, Any]]:
    errors = body.get("errors") if isinstance(body, dict) else None
    if not isinstance(errors, list):
        return []
    return [error if isinstance(error, dict) else {} for error in errors]


def _kind(error: dict[str, Any]) -> tuple[str, str]:
    extensions = error.get("extensions")
    if not isinstance(extensions, dict):
        return "", ""
    kind, code = extensions.get("type"), extensions.get("code")
    return (kind.lower() if isinstance(kind, str) else ""), (code.upper() if isinstance(code, str) else "")


def error_for(provider: str, errors: list[dict[str, Any]]) -> OperationError:
    """An owned error for Linear's errors. Linear's own messages never reach the model."""
    kinds = [_kind(error) for error in errors]
    types = {kind for kind, _ in kinds}
    codes = {code for _, code in kinds}
    messages = " ".join(str(error.get("message", "")).lower() for error in errors)
    if "ratelimited" in types or "RATELIMITED" in codes:
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    if "authentication error" in types:
        return OperationError(
            "CONNECTION_UNAUTHORIZED", f"The {provider} connection is no longer authorized."
        )
    if types & {"forbidden", "feature not accessible"}:
        return OperationError(
            "PROVIDER_FORBIDDEN", f"{provider} refused this request for the connected account."
        )
    if "not found" in messages:
        return OperationError("NOT_FOUND", f"{provider} did not find this object.")
    if types & {"invalid input", "user error", "graphql error"}:
        return OperationError("PROVIDER_REJECTED", f"{provider} rejected this request.")
    return OperationError("PROVIDER_FAILED", f"{provider} could not complete this request.")


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    try:
        body = response.json()
    except ValueError:
        return None
    errors = _errors(body)
    return error_for(provider, errors) if errors else None


def judge(response: httpx.Response) -> Effect | None:
    """What a mutation did. Only Linear's confirmation counts as applied, and only a refusal before the
    mutation ran as not applied: an error raised after it committed can look like any other."""
    try:
        body = response.json()
    except ValueError:
        return Effect.UNKNOWN if response.is_success else None
    if not isinstance(body, dict):
        return Effect.UNKNOWN if response.is_success else None
    data = body.get("data")
    if isinstance(data, dict):
        for payload in data.values():
            if isinstance(payload, dict) and payload.get("success") is True:
                return Effect.APPLIED
    errors = _errors(body)
    if errors and all(_refused_before_running(error, has_data="data" in body) for error in errors):
        return Effect.NOT_APPLIED
    return Effect.UNKNOWN


def _refused_before_running(error: dict[str, Any], *, has_data: bool) -> bool:
    kind, code = _kind(error)
    if kind in REFUSED_BEFORE_RUNNING:
        return True
    # A malformed request is refused before execution, and GraphQL then leaves out `data`. Other errors
    # without `data` are not trusted: Linear might leave it out after a mutation ran too.
    return not has_data and (kind == "graphql error" or code in MALFORMED)


class LinearClient:
    """Thin async client for Linear's GraphQL API. Responses are validated before use."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._http = ProviderHTTP(
            "Linear",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
            classify=classify,
            judge=judge,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def query(self, document: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """A read. Any error refuses the whole response."""
        response = await self._http.bounded(
            "/graphql",
            method="POST",
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Linear returned more than Minerva reads."),
            json={"query": document, "variables": variables or {}},
        )
        try:
            body = response.json()
        except ValueError as error:
            raise self.unexpected() from error
        if errors := _errors(body):
            raise error_for("Linear", errors)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            raise self.unexpected()
        return data

    async def _model[M: BaseModel](
        self, model: type[M], document: str, variables: dict[str, Any], *path: str
    ) -> M:
        value: Any = await self.query(document, variables)
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        try:
            return model.model_validate(value)
        except ValidationError as error:
            raise self.unexpected() from error

    async def _mutate(self, document: str, variables: dict[str, Any], field: str) -> dict[str, Any]:
        """The one write of an operation. Its outcome is judged by `judge`."""
        body = await self._http.json(
            "POST", "/graphql", mutating=True, json={"query": document, "variables": variables}
        )
        data = body.get("data") if isinstance(body, dict) else None
        payload = data.get(field) if isinstance(data, dict) else None
        if isinstance(payload, dict) and payload.get("success") is True:
            return payload
        if errors := _errors(body):
            raise error_for("Linear", errors)
        raise OperationError("WRITE_UNCONFIRMED", "Linear did not confirm the change.")

    async def me(self) -> Me:
        return await self._model(Me, "query Me { viewer { id name } organization { name urlKey } }", {})

    async def organization(self) -> Organization:
        return await self._model(
            Organization, "query Organization { organization { name urlKey } }", {}, "organization"
        )

    async def viewer(self) -> Viewer:
        return await self._model(Viewer, "query Viewer { viewer { id name } }", {}, "viewer")

    async def team(self, team_id: str) -> Team:
        return await self._model(
            Team, f"query Team($id: String!) {{ team(id: $id) {{ {TEAM_FIELDS} }} }}", {"id": team_id}, "team"
        )

    async def team_by_key(self, key: str) -> list[Team]:
        found = await self._model(
            Teams,
            f"query TeamByKey($key: String!) {{ teams(first: 2, filter: {{ key: {{ eqIgnoreCase: $key }} }}) "
            f"{{ nodes {{ {TEAM_FIELDS} }} {PAGE_INFO} }} }}",
            {"key": key},
            "teams",
        )
        return found.nodes

    async def teams(self, *, first: int, after: str | None, ids: list[str] | None = None) -> Teams:
        variables: dict[str, Any] = {"first": first, "after": after}
        if ids is not None:
            variables["filter"] = {"id": {"in": ids}}
        return await self._model(
            Teams,
            "query Teams($first: Int!, $after: String, $filter: TeamFilter) "
            f"{{ teams(first: $first, after: $after, filter: $filter) {{ nodes {{ {TEAM_FIELDS} }} {PAGE_INFO} }} }}",
            variables,
            "teams",
        )

    async def team_issues(
        self, team_id: str, *, first: int, after: str | None, filter: dict[str, Any] | None
    ) -> TeamIssues:
        return await self._model(
            TeamIssues,
            "query TeamIssues($id: String!, $first: Int!, $after: String, $filter: IssueFilter) "
            f"{{ team(id: $id) {{ {TEAM_FIELDS} issues(first: $first, after: $after, filter: $filter, "
            f"orderBy: updatedAt) {{ nodes {{ {ISSUE_SUMMARY} }} {PAGE_INFO} }} }} }}",
            {"id": team_id, "first": first, "after": after, "filter": filter},
            "team",
        )

    async def _pages(self, document: str, variables: dict[str, Any], *path: str) -> tuple[list[Any], bool]:
        """Every node of a connection, up to MAX_LIST_PAGES pages; and whether more were left out."""
        nodes: list[Any] = []
        after = None
        for _ in range(MAX_LIST_PAGES):
            value: Any = await self.query(document, {**variables, "after": after})
            for key in path:
                value = value.get(key) if isinstance(value, dict) else None
            page = value if isinstance(value, dict) else {}
            found, info = page.get("nodes"), page.get("pageInfo")
            if not isinstance(found, list) or not isinstance(info, dict):
                raise self.unexpected()
            nodes.extend(found)
            after = info.get("endCursor")
            if not info.get("hasNextPage") or not isinstance(after, str):
                return nodes, bool(info.get("hasNextPage"))
        return nodes, True

    async def states(self, team_id: str) -> tuple[list[State], bool]:
        nodes, more = await self._pages(
            "query States($id: String!, $after: String) { team(id: $id) { states(first: 100, after: $after) "
            f"{{ nodes {{ id name type }} {PAGE_INFO} }} }} }}",
            {"id": team_id},
            "team",
            "states",
        )
        return self._validate(State, nodes), more

    async def labels(self, team_id: str) -> tuple[list[Label], bool]:
        """Labels issues in the team can have: the team's own and the workspace's."""
        fields = f"nodes {{ id name isGroup parent {{ name }} }} {PAGE_INFO}"
        own, more_own = await self._pages(
            "query TeamLabels($id: String!, $after: String) { team(id: $id) { labels(first: 250, "
            f"after: $after) {{ {fields} }} }} }}",
            {"id": team_id},
            "team",
            "labels",
        )
        shared, more_shared = await self._pages(
            "query WorkspaceLabels($after: String) { issueLabels(first: 250, after: $after, "
            f"filter: {{ team: {{ null: true }} }}) {{ {fields} }} }}",
            {},
            "issueLabels",
        )
        labels: dict[str, Label] = {}
        for label in self._validate(Label, own + shared):
            labels.setdefault(label.id, label)
        return list(labels.values()), more_own or more_shared

    async def members(self, team_id: str) -> tuple[list[Person], bool]:
        nodes, more = await self._pages(
            "query Members($id: String!, $after: String) { team(id: $id) { members(first: 250, after: $after) "
            f"{{ nodes {{ id name displayName active }} {PAGE_INFO} }} }} }}",
            {"id": team_id},
            "team",
            "members",
        )
        return self._validate(Person, nodes), more

    def _validate[M: BaseModel](self, model: type[M], items: list[Any]) -> list[M]:
        try:
            return [model.model_validate(item) for item in items]
        except ValidationError as error:
            raise self.unexpected() from error

    async def issue_place(self, issue_id: str) -> IssuePlace:
        return await self._model(
            IssuePlace,
            f"query IssuePlace($id: String!) {{ issue(id: $id) {{ id identifier team {{ {TEAM_FIELDS} }} }} }}",
            {"id": issue_id},
            "issue",
        )

    async def issue_team(self, issue_id: str) -> TeamRef:
        return await self._model(
            TeamRef,
            "query IssueTeam($id: String!) { issue(id: $id) { team { id } } }",
            {"id": issue_id},
            "issue",
            "team",
        )

    async def issue(self, issue_id: str, *, comments: int) -> Issue:
        return await self._model(
            Issue,
            "query Issue($id: String!, $comments: Int!) { issue(id: $id) { "
            "id identifier title description priorityLabel estimate dueDate url createdAt updatedAt "
            "completedAt canceledAt state { name type } assignee { name } creator { name } project { name } "
            f"labels(first: 50) {{ nodes {{ name }} {PAGE_INFO} }} team {{ {TEAM_FIELDS} }} "
            "parent { identifier title team { id } } "
            f"children(first: 50) {{ nodes {{ identifier title state {{ name type }} team {{ id }} }} {PAGE_INFO} }} "
            "comments(first: $comments, orderBy: createdAt) { nodes { id body createdAt hideInLinear "
            f"parent {{ id }} user {{ name }} botActor {{ name }} externalUser {{ name }} }} {PAGE_INFO} }} }} }}",
            {"id": issue_id, "comments": comments},
            "issue",
        )

    async def issue_for_update(self, issue_id: str) -> IssueForUpdate:
        chain = _nested("id team { id }", MAX_ISSUE_DEPTH + 1)
        return await self._model(
            IssueForUpdate,
            "query IssueForUpdate($id: String!) { issue(id: $id) { "
            f"id identifier team {{ {TEAM_FIELDS} }} {chain} }} }}",
            {"id": issue_id},
            "issue",
        )

    async def open_sub_issues(self, issue_id: str, team_id: str, depth: int) -> tuple[bool, bool]:
        """Whether the issue has open sub-issues (to `depth` levels down) in other teams, and whether it has
        sub-issues deeper than that. Only issues the account can see are found."""

        def under(level: int) -> dict[str, Any]:
            filter: dict[str, Any] = {"id": {"eq": issue_id}}
            for _ in range(level):
                filter = {"parent": filter}
            return filter

        elsewhere = {
            "and": [
                {"team": {"id": {"neq": team_id}}},
                {"state": {"type": {"nin": ["completed", "canceled"]}}},
                {"or": [under(level) for level in range(1, depth + 1)]},
            ]
        }
        data = await self.query(
            "query OpenSubIssues($elsewhere: IssueFilter!, $deeper: IssueFilter!) { "
            "elsewhere: issues(first: 1, filter: $elsewhere) { nodes { id } } "
            "deeper: issues(first: 1, filter: $deeper) { nodes { id } } }",
            {"elsewhere": elsewhere, "deeper": under(depth + 1)},
        )

        def found(key: str) -> bool:
            value = data.get(key)
            nodes = value.get("nodes") if isinstance(value, dict) else None
            if not isinstance(nodes, list):
                raise self.unexpected()
            return bool(nodes)

        return found("elsewhere"), found("deeper")

    async def comment_place(self, comment_id: str) -> CommentPlace:
        return await self._model(
            CommentPlace,
            "query CommentPlace($id: String!) { comment(id: $id) { id issue { id } parent { id } } }",
            {"id": comment_id},
            "comment",
        )

    async def create_issue(self, input: dict[str, Any]) -> Written | None:
        payload = await self._mutate(
            "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success "
            "issue { id identifier title url state { name type } team { id } } } }",
            {"input": input},
            "issueCreate",
        )
        return self._written(payload.get("issue"))

    async def update_issue(self, issue_id: str, input: dict[str, Any]) -> Written | None:
        payload = await self._mutate(
            "mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, "
            "input: $input) { success issue { id identifier title url state { name type } team { id } } } }",
            {"id": issue_id, "input": input},
            "issueUpdate",
        )
        return self._written(payload.get("issue"))

    async def create_comment(self, input: dict[str, Any]) -> WrittenComment | None:
        payload = await self._mutate(
            "mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success "
            "comment { id createdAt } } }",
            {"input": input},
            "commentCreate",
        )
        try:
            return WrittenComment.model_validate(payload.get("comment"))
        except ValidationError:
            return None

    @staticmethod
    def _written(value: Any) -> Written | None:
        """The written issue, or None when Linear did not return it; the write itself was confirmed."""
        try:
            return Written.model_validate(value)
        except ValidationError:
            return None
