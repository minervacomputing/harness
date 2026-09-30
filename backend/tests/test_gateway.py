import json
from types import SimpleNamespace

import httpx
import mcp_types as types
import pytest
from asgiref.sync import sync_to_async
from django.test import AsyncClient, override_settings

from conversations.models import Conversation, Message
from gateway.mcp import RUN_SCOPE_KEY, call_tool, list_tools
from models_access import providers
from runs import services
from runs.models import Run, RunEvent
from workspaces.tenancy import workspace_scope

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("gateway_urls")]


@pytest.fixture
def gateway_urls():
    with override_settings(ROOT_URLCONF="gateway.urls"):
        yield


@pytest.fixture
def claimed(scoped, user, agent, grant, todoist):
    """A claimed run and its raw token, as the supervisor would hand them to a sandbox."""
    grant(work=["read"])
    with workspace_scope(scoped.id):
        conversation = Conversation.objects.create(agent=agent, user=user)
        services.start_run(conversation=conversation, user_id=user.id, content="List my tasks")
    [(run, token)] = services.claim_queued(1)
    return run, token


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_run_spec_requires_the_run_token(claimed):
    run, token = claimed
    client = AsyncClient()
    assert (await client.get("/run")).status_code == 401
    assert (await client.get("/run", headers=auth("wrong"))).status_code == 401
    spec = (await client.get("/run", headers=auth(token))).json()
    assert spec["prompt"] == "List my tasks"
    assert "todoist_list_tasks" in {tool["name"] for tool in spec["tools"]}
    assert (await Run.unscoped.aget(pk=run.id)).status == Run.Status.RUNNING


async def test_completion_stores_the_answer_and_revokes_the_token(claimed):
    run, token = claimed
    client = AsyncClient()
    await client.get("/run", headers=auth(token))
    forged = {"events": [{"seq": 1, "type": "text_delta", "text": "forged"}]}
    response = await client.post(
        "/events", data=json.dumps(forged), content_type="application/json", headers=auth(token)
    )
    assert response.status_code == 400
    batch = {
        "events": [
            {"seq": 1, "type": "phase", "text": "Working"},
            {"seq": 2, "type": "completed", "text": "Hello"},
        ]
    }
    response = await client.post(
        "/events", data=json.dumps(batch), content_type="application/json", headers=auth(token)
    )
    assert response.status_code == 200
    stored = await Run.unscoped.aget(pk=run.id)
    assert stored.status == Run.Status.COMPLETED
    answer = await Message.unscoped.aget(run=run, role=Message.Role.ASSISTANT)
    assert answer.content == "Hello"
    assert (await client.get("/run", headers=auth(token))).status_code == 401
    types_ = [e.type async for e in RunEvent.unscoped.filter(run=run).order_by("seq")]
    assert "text_delta" not in types_
    assert types_[-2:] == ["message", "status"]


async def test_replayed_worker_events_are_ignored(claimed):
    run, token = claimed
    client = AsyncClient()
    batch = json.dumps({"events": [{"seq": 1, "type": "phase", "text": "Thinking"}]})
    for _ in range(2):
        await client.post("/events", data=batch, content_type="application/json", headers=auth(token))
    assert await RunEvent.unscoped.filter(run=run, type="phase").acount() == 1


async def test_model_relay_enforces_backend_choices(claimed, monkeypatch):
    run, token = claimed
    seen: list[dict] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        assert request.headers["Authorization"] == "Bearer platform-key"
        body = {
            "choices": [{"message": {"content": "hi"}}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 3},
        }
        return httpx.Response(200, json=body)

    provider = providers.OpenAICompatibleProvider(
        "https://models.example/v1", "platform-key", transport=httpx.MockTransport(upstream)
    )
    target = providers.Route("default", "gpt-test", 1000)
    monkeypatch.setattr("gateway.views.route", lambda alias: (provider, target))
    body = {
        "model": "gpt-expensive",
        "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 99999,
        "user": "x",
    }
    client = AsyncClient()
    response = await client.post(
        "/v1/chat/completions", data=json.dumps(body), content_type="application/json", headers=auth(token)
    )
    assert response.status_code == 200
    b"".join([chunk async for chunk in response.streaming_content])
    assert seen[0]["model"] == "gpt-test"
    assert seen[0]["max_completion_tokens"] == 1000
    assert seen[0]["store"] is False and "user" not in seen[0] and "max_tokens" not in seen[0]
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.input_tokens, stored.output_tokens) == (1, 7, 3)
    deltas = [e.data["text"] async for e in RunEvent.unscoped.filter(run=run, type="text_delta")]
    assert deltas == ["hi"]

    await Run.unscoped.filter(pk=run.id).aupdate(model_calls=stored.max_model_calls)
    limited = await client.post(
        "/v1/chat/completions", data=json.dumps(body), content_type="application/json", headers=auth(token)
    )
    assert limited.status_code == 429


async def test_model_relay_streams_text_as_run_events(claimed, monkeypatch):
    run, token = claimed
    chunks = [
        {"choices": [{"delta": {"role": "assistant", "content": "Hel"}}]},
        {"choices": [{"delta": {"content": "lo"}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}}]},
        {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}},
    ]
    sse = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"

    def upstream(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream_options"] == {"include_usage": True}
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    provider = providers.OpenAICompatibleProvider(
        "https://models.example/v1", "k", transport=httpx.MockTransport(upstream)
    )
    monkeypatch.setattr("gateway.views.route", lambda alias: (provider, providers.Route("default", "m", 100)))
    body = {"messages": [{"role": "user", "content": "x"}], "stream": True}
    response = await AsyncClient().post(
        "/v1/chat/completions", data=json.dumps(body), content_type="application/json", headers=auth(token)
    )
    relayed = b"".join([chunk async for chunk in response.streaming_content])
    assert relayed == sse.encode()
    deltas = [e.data["text"] async for e in RunEvent.unscoped.filter(run=run, type="text_delta")]
    assert "".join(deltas) == "Hello"
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens) == (5, 2)


async def test_mcp_tools_are_authorized_and_recorded(claimed):
    run, _ = claimed
    ctx = SimpleNamespace(request=SimpleNamespace(scope={RUN_SCOPE_KEY: run.id}))
    listed = await list_tools(ctx, None)
    # Nothing allows creating, so the tool is not offered.
    assert {tool.name for tool in listed.tools} == {
        "todoist_list_projects",
        "todoist_list_tasks",
        "todoist_get_task",
    }

    allowed = await call_tool(
        ctx, types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "work"})
    )
    assert not allowed.is_error and allowed.structured_content["count"] == 1
    denied = await call_tool(
        ctx, types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "private"})
    )
    assert denied.is_error
    events = await sync_to_async(list)(RunEvent.unscoped.filter(run=run, type="tool_call").order_by("seq"))
    assert [e.data["decision"] for e in events] == ["allowed", "denied"]
