import re
from typing import Annotated

from pydantic import Field

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
    ResourceKind,
    ScopedRecord,
)
from connectors.todoist.client import TodoistClient, TodoistTask

PROJECT = "project"
ObjectId = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")]
MAX_PROJECT_PAGES = 20


def _task(binding: Binding, task: TodoistTask) -> ScopedRecord:
    return ScopedRecord(
        resource=binding.resource(PROJECT, task.project_id),
        data={
            "id": task.id,
            "project_id": task.project_id,
            "title": task.content,
            "description": task.description,
            "priority": task.priority,
            "due": task.due.string or task.due.date if task.due else None,
            "completed": task.checked,
        },
    )


async def _all_projects(client: TodoistClient) -> list[DiscoveryItem]:
    items: list[DiscoveryItem] = []
    cursor: str | None = None
    for _ in range(MAX_PROJECT_PAGES):
        page = await client.projects(cursor)
        items.extend(DiscoveryItem(project.id, project.name) for project in page.results)
        if not page.next_cursor:
            return items
        cursor = page.next_cursor
    raise OperationError("PROVIDER_LIMIT", "This Todoist account has more projects than Minerva can list.")


class ListProjects(OperationInput):
    pass


async def _prepare_list_projects(binding: Binding, _: ListProjects) -> Prepared:
    async def execute() -> ProviderOutput:
        projects = await _all_projects(binding.client)
        return ProviderOutput(
            [ScopedRecord(binding.resource(PROJECT, p.id), {"id": p.id, "name": p.name}) for p in projects]
        )

    return Prepared([Enumerate(PROJECT, "read")], execute)


class ListTasks(OperationInput):
    project_id: ObjectId
    search: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 30
    cursor: Annotated[str, Field(max_length=300)] | None = None


async def _prepare_list_tasks(binding: Binding, data: ListTasks) -> Prepared:
    async def execute() -> ProviderOutput:
        client: TodoistClient = binding.client
        if data.search:
            text = re.sub(r"[&|!()#@,\\]", " ", data.search).strip()
            page = await client.filter_tasks(f"search: {text}", cursor=data.cursor, limit=data.limit)
            tasks = [task for task in page.results if task.project_id == data.project_id]
        else:
            page = await client.tasks(data.project_id, cursor=data.cursor, limit=data.limit)
            tasks = page.results
        return ProviderOutput([_task(binding, task) for task in tasks], page.next_cursor)

    return Prepared([Need(binding.resource(PROJECT, data.project_id), "read")], execute)


class GetTask(OperationInput):
    task_id: ObjectId


async def _prepare_get_task(binding: Binding, data: GetTask) -> Prepared:
    # The task's project is only known after fetching it. The backend sees the task; the agent only
    # receives it if that project is allowed. Failures look like denials so existence is not revealed.
    try:
        task = await binding.client.task(data.task_id)
    except OperationError as error:
        if error.code in {"NOT_FOUND", "PROVIDER_FORBIDDEN"}:
            raise OperationError("POLICY_DENIED", DENIED) from error
        raise
    if task.id != data.task_id:
        raise OperationError("POLICY_DENIED", DENIED)

    async def execute() -> ProviderOutput:
        return ProviderOutput([_task(binding, task)])

    return Prepared([Need(binding.resource(PROJECT, task.project_id), "read")], execute)


class CreateTask(OperationInput):
    project_id: ObjectId
    title: Annotated[str, Field(min_length=1, max_length=300)]


async def _prepare_create_task(binding: Binding, data: CreateTask) -> Prepared:
    async def execute() -> ProviderOutput:
        # The record carries the project Todoist actually used; the executor filters it by that.
        task = await binding.client.create_task(data.project_id, data.title)
        return ProviderOutput([_task(binding, task)])

    return Prepared([Need(binding.resource(PROJECT, data.project_id), "create")], execute)


class TodoistConnector(Connector):
    slug = "todoist"
    name = "Todoist"
    kinds = (ResourceKind(PROJECT, "Project", ("read", "create"), wildcard=True),)
    actions = (
        ActionSpec("read", "Read tasks"),
        ActionSpec("create", "Create tasks", requires="read"),
    )
    auth = OAuth2(
        app="todoist",
        authorize_url="https://app.todoist.com/oauth/authorize",
        token_url="https://api.todoist.com/oauth/access_token",  # noqa: S106
        scopes=("data:read_write",),
        registration_url="https://api.todoist.com/oauth/register",
    )

    operations = (
        Operation(
            name="list_projects",
            title="List projects",
            description="List the Todoist projects you may access.",
            input_model=ListProjects,
            needs=((PROJECT, "read"),),
            prepare=_prepare_list_projects,
        ),
        Operation(
            name="list_tasks",
            title="List tasks",
            description=(
                "List active tasks in one project you may read. Optionally filter by search text. "
                "To get the next page, repeat the call with identical arguments plus the returned next_cursor."
            ),
            input_model=ListTasks,
            needs=((PROJECT, "read"),),
            prepare=_prepare_list_tasks,
            paginated=True,
        ),
        Operation(
            name="get_task",
            title="Get a task",
            description="Read one task by ID. Its project must be readable for you.",
            input_model=GetTask,
            needs=((PROJECT, "read"),),
            prepare=_prepare_get_task,
        ),
        Operation(
            name="create_task",
            title="Create a task",
            description=(
                "Create one task in a project where you have create permission. "
                "Give an explicit project_id and title. The number of creations per run is limited."
            ),
            input_model=CreateTask,
            needs=((PROJECT, "create"),),
            prepare=_prepare_create_task,
            mutates=True,
        ),
    )

    def client(self, access_token: str) -> TodoistClient:
        return TodoistClient(access_token)

    async def account(self, client: TodoistClient) -> Account:
        user = await client.user()
        return Account(id=user.id, label=user.full_name or user.email or "Todoist")

    async def discover(
        self, client: TodoistClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if query:
            text = query.casefold()
            return DiscoveryPage([p for p in await _all_projects(client) if text in p.name.casefold()])
        page = await client.projects(cursor)
        return DiscoveryPage([DiscoveryItem(p.id, p.name) for p in page.results], page.next_cursor)

    async def describe(self, client: TodoistClient, kind: str, ids: list[str]) -> dict[str, str]:
        wanted = set(ids)
        return {p.id: p.name for p in await _all_projects(client) if p.id in wanted}
