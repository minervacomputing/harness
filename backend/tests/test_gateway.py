import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace

import httpx
import jsonschema
import mcp_types as types
import pytest
from asgiref.sync import async_to_sync, sync_to_async
from django.core.handlers.asgi import ASGIHandler
from django.db import connection, transaction
from django.test import AsyncClient, override_settings
from django.utils import timezone

from connectors.base import OperationError
from connectors.executor import RESULT_SCHEMA, Executor
from conversations.models import Conversation, Message
from gateway import mcp, relay
from gateway.body_limit import limit_body
from gateway.mcp import RUN_SCOPE_KEY, call_tool, list_tools, mcp_app
from models_access.taps import ResponsesTap, StreamTap
from models_access.upstream import OpenAICompatibleProvider, Route, UpstreamResponse
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
    assert spec["model"]["api"] in {"responses", "chat"}
    assert "todoist_list_tasks" in {tool["name"] for tool in spec["tools"]}
    assert "code_mode" not in spec
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
        chunks = [
            {"choices": [{"delta": {"content": "hi"}}]},
            {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}},
        ]
        return _sse(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)

    provider = OpenAICompatibleProvider(
        "https://models.example/v1", "platform-key", transport=httpx.MockTransport(upstream)
    )
    target = Route("default", "gpt-test", 1000, api="chat")
    monkeypatch.setattr("models_access.upstream.route", lambda alias: (provider, target))
    body = {
        "model": "gpt-expensive",
        "messages": [{"role": "user", "content": "x"}],
        "max_tokens": 99999,
        "user": "x",
        "stream": True,
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

    provider = OpenAICompatibleProvider(
        "https://models.example/v1", "k", transport=httpx.MockTransport(upstream)
    )
    target = Route("default", "m", 100, api="chat")
    monkeypatch.setattr("models_access.upstream.route", lambda alias: (provider, target))
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


def _sse(events) -> httpx.Response:
    content = "".join(events).encode()
    return httpx.Response(200, content=content, headers={"content-type": "text/event-stream"})


def _post(token: str, path: str, body: dict):
    return AsyncClient().post(
        path, data=json.dumps(body), content_type="application/json", headers=auth(token)
    )


def _upstream(monkeypatch, handler, **route) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(
        "https://models.example/v1", "platform-key", transport=httpx.MockTransport(handler)
    )
    target = Route("default", "gpt-test", 1000, **route)
    monkeypatch.setattr("models_access.upstream.route", lambda alias: (provider, target))
    return provider


@pytest.mark.parametrize(
    "message",
    [
        {
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": "https://attacker.example/?s=1"}}],
        },
        {"role": "user", "content": [{"type": "file", "file": {"file_id": "file-1"}}]},
        {
            "role": "assistant",
            "tool_calls": [{"id": "c", "type": "custom", "custom": {"name": "t", "input": ""}}],
        },
        {"role": ["user"], "content": "x"},
        {"role": "function", "content": "x"},
    ],
)
async def test_chat_requests_carry_text_only(claimed, monkeypatch, message):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="chat")
    body = {"messages": [message], "stream": True}
    assert (await _post(token, "/v1/chat/completions", body)).status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0


async def test_chat_requests_must_stream(claimed, monkeypatch):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="chat")
    body = {"messages": [{"role": "user", "content": "x"}]}
    assert (await _post(token, "/v1/chat/completions", body)).status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0


@pytest.mark.parametrize(
    "change",
    # A sample of the refusals in test_model_requests, one per kind of option.
    [
        {"tools": [{"type": "custom", "custom": {"name": "t"}}]},
        {"tools": [{"type": "function", "function": {"name": "t", "strict": "yes"}}]},
        {"tool_choice": {"type": "function", "name": "t"}},
        {"response_format": {"type": "grammar", "grammar": "x"}},
        {"stop": 1},
        {"seed": 1.5},
        {"stream": "yes"},
    ],
)
async def test_refused_chat_requests_reserve_nothing_and_reach_no_provider(claimed, monkeypatch, change):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="chat")
    body = {"messages": [{"role": "user", "content": "x"}], "stream": True, **change}
    assert (await _post(token, "/v1/chat/completions", body)).status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e400"])
async def test_chat_requests_with_numbers_json_cannot_carry_are_refused(claimed, monkeypatch, number):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="chat")
    body = json.dumps({"messages": [{"role": "user", "content": "x"}], "stream": True, "temperature": 0})
    body = body.replace('"temperature": 0', f'"temperature": {number}')
    response = await AsyncClient().post(
        "/v1/chat/completions", data=body, content_type="application/json", headers=auth(token)
    )
    assert response.status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0


async def test_each_instance_serves_one_model_api(claimed, monkeypatch):
    _, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="responses")
    body = {"messages": [{"role": "user", "content": "x"}]}
    assert (await _post(token, "/v1/chat/completions", body)).status_code == 404


RESPONSES_INPUT = [
    {"role": "developer", "content": "Be brief."},
    {"role": "user", "content": [{"type": "input_text", "text": "x", "file_id": "file-1"}]},
    {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "sealed", "content": [{"x": 1}]},
    {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "c1",
        "name": "t",
        "arguments": "{}",
        "namespace": "n",
    },
    {"type": "function_call_output", "call_id": "c1", "output": "result"},
    {
        "type": "message",
        "role": "assistant",
        "id": "msg_1",
        "status": "completed",
        "content": [{"type": "output_text", "text": "hi", "annotations": [{"type": "url_citation"}]}],
    },
]


async def test_responses_requests_are_rebuilt_from_what_minerva_allows(claimed, monkeypatch):
    run, token = claimed
    seen: list[dict] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/responses"
        seen.append(json.loads(request.content))
        done = {"type": "response.completed", "response": {"usage": {"input_tokens": 7, "output_tokens": 3}}}
        return _sse([f"data: {json.dumps(done)}\n\n"])

    _upstream(monkeypatch, upstream, reasoning_effort="high")
    body = {
        "model": "gpt-expensive",
        "input": RESPONSES_INPUT,
        "tools": [{"type": "function", "name": "t", "parameters": {"type": "object"}, "extra": 1}],
        "tool_choice": "auto",
        "max_output_tokens": True,
        "store": True,
        "previous_response_id": "resp_other",
        "service_tier": "priority",
        "include": ["file_search_call.results"],
        "reasoning": {"effort": "xhigh"},
        "prompt_cache_key": "session-1",
        "stream": True,
    }
    response = await _post(token, "/v1/responses", body)
    assert response.status_code == 200
    b"".join([chunk async for chunk in response.streaming_content])
    assert seen[0] == {
        "model": "gpt-test",
        "input": [
            {"type": "message", "role": "developer", "content": "Be brief."},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]},
            {"type": "reasoning", "id": "rs_1", "encrypted_content": "sealed", "summary": []},
            {"type": "function_call", "call_id": "c1", "name": "t", "arguments": "{}", "id": "fc_1"},
            {"type": "function_call_output", "call_id": "c1", "output": "result"},
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "hi", "annotations": []}],
                "id": "msg_1",
                "status": "completed",
            },
        ],
        "store": False,
        "stream": True,
        "max_output_tokens": 1000,
        "tools": [{"type": "function", "name": "t", "parameters": {"type": "object"}, "strict": False}],
        "tool_choice": "auto",
        "prompt_cache_key": "session-1",
        "reasoning": {"effort": "high"},
        "include": ["reasoning.encrypted_content"],
    }
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.input_tokens, stored.output_tokens) == (1, 7, 3)


@pytest.mark.parametrize(
    "change",
    [
        {"tools": [{"type": "web_search"}]},
        {"tools": [{"type": "mcp", "server_url": "https://attacker.example", "server_label": "x"}]},
        {"tools": [{"type": "custom", "name": "t"}]},
        {"tool_choice": {"type": "web_search_preview"}},
        {"input": [{"type": "item_reference", "id": "msg_stored"}]},
        {
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "input_image", "image_url": "https://attacker.example"}],
                }
            ]
        },
        {"input": [{"role": "user", "content": [{"type": "input_file", "file_id": "file-1"}]}]},
        {"input": [{"type": "reasoning", "id": "rs_stored", "summary": []}]},
        {"input": [{"type": "function_call_output", "call_id": "c", "output": [{"type": "input_image"}]}]},
        {"input": [{"role": "tool", "content": "x"}]},
        {"input": "just text"},
        {"input": [{"role": [], "content": "x"}]},
        {
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "c",
                    "output": [{"type": "output_text", "text": "x"}],
                }
            ]
        },
        {"max_output_tokens": 8},
        {"stream": "yes"},
        {"stream": False},
    ],
)
async def test_responses_requests_outside_the_allowlist_are_refused(claimed, monkeypatch, change):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"))
    body = {"input": [{"role": "user", "content": "x"}], "stream": True, **change}
    assert (await _post(token, "/v1/responses", body)).status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0


async def test_responses_stream_publishes_answer_text_but_not_reasoning(claimed, monkeypatch):
    run, token = claimed
    events = [
        {"type": "response.created", "response": {"status": "in_progress"}},
        {"type": "response.reasoning_summary_text.delta", "delta": "thinking about secrets"},
        {"type": "response.output_text.delta", "delta": "Hel"},
        {"type": "response.output_text.delta", "delta": "lo"},
        {"type": "response.function_call_arguments.delta", "delta": "{}"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 2}}},
    ]
    sse = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)

    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    _upstream(monkeypatch, upstream)
    body = {"input": [{"role": "user", "content": "x"}], "stream": True}
    response = await _post(token, "/v1/responses", body)
    relayed = b"".join([chunk async for chunk in response.streaming_content])
    assert relayed == sse.encode()
    deltas = [e.data["text"] async for e in RunEvent.unscoped.filter(run=run, type="text_delta")]
    assert "".join(deltas) == "Hello"
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens) == (5, 2)


SECRET = "quota of org-123 exceeded"


async def test_provider_errors_inside_a_stream_do_not_reach_the_worker(claimed, monkeypatch):
    run, token = claimed
    failed = {"code": "server_error", "message": SECRET}
    events = [
        {"type": "response.output_text.delta", "delta": "Hi"},
        {"type": "error", "code": "server_error", "message": SECRET, "param": None, "sequence_number": 2},
        {
            "type": "response.failed",
            "response": {
                "status": "failed",
                "error": failed,
                "usage": {"input_tokens": 5, "output_tokens": 1},
            },
        },
    ]
    _upstream(
        monkeypatch, lambda request: _sse(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    )
    response = await _post(
        token, "/v1/responses", {"input": [{"role": "user", "content": "x"}], "stream": True}
    )
    relayed = b"".join([chunk async for chunk in response.streaming_content])
    assert SECRET.encode() not in relayed
    sent = [json.loads(line[5:]) for line in relayed.splitlines() if line.startswith(b"data:")]
    assert [e["type"] for e in sent] == ["response.output_text.delta", "error", "response.failed"]
    assert sent[1]["message"] == sent[2]["response"]["error"]["message"] == StreamTap.ERROR_MESSAGE
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens, stored.unmetered_model_calls) == (5, 1, 0)


def _stream(*parts: bytes | asyncio.Event) -> httpx.Response:
    """A provider stream that waits wherever an event is given."""

    async def content():
        for part in parts:
            if isinstance(part, asyncio.Event):
                await part.wait()
            else:
                yield part

    return httpx.Response(200, content=content(), headers={"content-type": "text/event-stream"})


TEXT_EVENT = b'data: {"type": "response.output_text.delta", "delta": "Hi"}\n\n'
DONE_EVENT = b'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 2}}}\n\n'
BODY = {"input": [{"role": "user", "content": "x"}], "stream": True}


async def test_usage_is_recorded_when_the_worker_hangs_up(claimed, monkeypatch):
    run, token = claimed
    provider_done = asyncio.Event()
    _upstream(monkeypatch, lambda request: _stream(TEXT_EVENT, provider_done, DONE_EVENT))
    response = await _post(token, "/v1/responses", BODY)
    assert await anext(aiter(response.streaming_content)) == TEXT_EVENT
    # The worker reads no further; the provider finishes afterwards.
    provider_done.set()
    await asyncio.wait_for(asyncio.gather(*relay._calls), 5)
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens, stored.unmetered_model_calls) == (5, 2, 0)


async def test_a_stopped_run_ends_a_silent_model_stream(claimed, monkeypatch):
    run, token = claimed
    monkeypatch.setattr(relay, "REVOCATION_CHECK_SECONDS", 0.05)
    _upstream(monkeypatch, lambda request: _stream(TEXT_EVENT, asyncio.Event(), DONE_EVENT))
    response = await _post(token, "/v1/responses", BODY)
    stream = aiter(response.streaming_content)
    assert await anext(stream) == TEXT_EVENT
    await Run.unscoped.filter(pk=run.id).aupdate(status=Run.Status.CANCELLED)
    assert await asyncio.wait_for(_rest(stream), 5) == b""
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.unmetered_model_calls) == (0, 1)


async def _rest(stream) -> bytes:
    return b"".join([chunk async for chunk in stream])


async def test_model_traffic_is_size_limited(claimed, monkeypatch):
    run, token = claimed
    _upstream(monkeypatch, lambda request: _stream(TEXT_EVENT, DONE_EVENT))
    with override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000):
        body = {**BODY, "input": [{"role": "user", "content": "x" * 2000}]}
        assert (await _post(token, "/v1/responses", body)).status_code == 413
    assert (await Run.unscoped.aget(pk=run.id)).model_calls == 0

    monkeypatch.setattr(relay, "MAX_RESPONSE_BYTES", len(TEXT_EVENT) + 1)
    response = await _post(token, "/v1/responses", BODY)
    assert await _rest(response.streaming_content) == TEXT_EVENT
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.input_tokens, stored.unmetered_model_calls) == (1, 0, 1)


async def test_a_stopped_run_ends_the_wait_for_the_provider(claimed, monkeypatch):
    run, token = claimed
    monkeypatch.setattr(relay, "REVOCATION_CHECK_SECONDS", 0.05)
    answered = asyncio.Event()

    async def slow(request: httpx.Request) -> httpx.Response:
        await answered.wait()
        return _stream(DONE_EVENT)

    _upstream(monkeypatch, slow)
    pending = asyncio.create_task(_post(token, "/v1/responses", BODY))
    await asyncio.sleep(0.1)
    await Run.unscoped.filter(pk=run.id).aupdate(status=Run.Status.CANCELLED)
    response = await asyncio.wait_for(pending, 5)
    assert response.status_code == 401
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.unmetered_model_calls) == (1, 1)


async def test_the_gateway_refuses_oversized_bodies_before_reading_them():
    seen: list[bytes] = []

    async def app(scope, receive, send):
        while (message := await receive())["type"] == "http.request":
            seen.append(message["body"])
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    limited = limit_body(app, 10)

    async def call(headers, *bodies):
        sent: list[dict] = []
        messages = [{"type": "http.request", "body": b, "more_body": True} for b in bodies]
        messages.append({"type": "http.disconnect"})

        async def receive():
            return messages.pop(0)

        async def send(message):
            sent.append(message)

        await limited({"type": "http", "headers": headers}, receive, send)
        return sent[0]["status"] if sent else None

    assert await call([(b"content-length", b"11")], b"x" * 11) == 413
    assert seen == []
    # Streamed without a length, the body is cut off at the limit and refused; the app answers nothing.
    assert await call([], b"x" * 6, b"x" * 6) == 413
    assert seen == [b"x" * 6]
    assert await call([], b"x" * 6, b"x" * 4) == 200


async def test_django_answers_oversized_streamed_bodies_with_413():
    sent: list[dict] = []
    messages = [{"type": "http.request", "body": b"x" * 11, "more_body": True}]

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/v1/responses", "headers": [], "query_string": b""}
    await limit_body(ASGIHandler(), 10)(scope, receive, send)
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    assert sent[0]["status"] == 413


async def test_raw_asgi_refusals_are_json_errors():
    async def answer(app, headers):
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"x" * 11}

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": headers, "query_string": b""}
        await app(scope, receive, send)
        return sent

    def expected(status, body):
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        return [
            {"type": "http.response.start", "status": status, "headers": headers},
            {"type": "http.response.body", "body": body},
        ]

    too_large = await answer(limit_body(None, 10), [(b"content-length", b"11")])
    assert too_large == expected(413, b'{"error": {"message": "The request is too large."}}')
    assert await answer(mcp_app, []) == expected(401, b'{"error": {"message": "Inactive run credential."}}')


async def test_only_event_streams_are_relayed(claimed, monkeypatch):
    run, token = claimed
    error = {"error": {"message": SECRET}}
    _upstream(monkeypatch, lambda request: httpx.Response(200, json=error))
    response = await _post(token, "/v1/responses", BODY)
    assert response.status_code == 502 and SECRET.encode() not in response.content
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.unmetered_model_calls) == (1, 1)


class _Body(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self):
        yield DONE_EVENT

    async def aclose(self) -> None:
        self.closed = True


async def test_a_response_arriving_as_the_run_ends_is_closed(claimed, monkeypatch):
    run, token = claimed
    body = _Body()

    async def answer(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return httpx.Response(200, stream=body, headers={"content-type": "text/event-stream"})

    def slow_check(run_id) -> bool:
        # The provider answers while the run's state is being read.
        time.sleep(0.3)
        return False

    provider = _upstream(monkeypatch, answer)
    # Held here, so only the gateway itself can close the call, not the garbage collector.
    calls = []
    responses = provider.responses
    monkeypatch.setattr(provider, "responses", lambda payload: calls.append(responses(payload)) or calls[-1])
    monkeypatch.setattr(relay, "REVOCATION_CHECK_SECONDS", 0.01)
    monkeypatch.setattr(relay.services, "is_token_valid", slow_check)
    response = await _post(token, "/v1/responses", BODY)
    assert response.status_code == 401 and body.closed
    assert (await Run.unscoped.aget(pk=run.id)).unmetered_model_calls == 1


async def test_a_call_that_opens_despite_cancellation_is_closed(claimed):
    run, _ = claimed
    closed = asyncio.Event()

    class Upstream:
        async def __aenter__(self):
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                # Answers anyway, after a moment.
                await asyncio.sleep(0.05)
            return object()

        async def __aexit__(self, *args):
            closed.set()

    cm = Upstream()
    opening = asyncio.create_task(cm.__aenter__())
    await asyncio.sleep(0)
    opening.cancel()
    await relay._abandon(opening, cm, run.id)
    assert closed.is_set()
    assert (await Run.unscoped.aget(pk=run.id)).unmetered_model_calls == 1


async def test_usage_is_recorded_even_if_closing_the_call_fails(claimed):
    run, _ = claimed

    class FailingClose:
        async def __aexit__(self, *args):
            raise OSError("close failed")

    async def chunks():
        yield DONE_EVENT

    upstream = UpstreamResponse(200, "text/event-stream", chunks())
    call = relay.ModelCall(run.id, ResponsesTap(), FailingClose(), upstream)
    await call._run()
    assert await _rest(call.stream()) == DONE_EVENT
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens, stored.unmetered_model_calls) == (5, 2, 0)


def test_no_model_call_is_reserved_for_a_run_past_its_deadline(claimed):
    run, _ = claimed
    Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() - timedelta(seconds=1))
    assert not relay._reserve_model_call(run.id)
    Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() + timedelta(minutes=1))
    assert relay._reserve_model_call(run.id)


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
    # Scripts get typed results from it.
    assert all(tool.output_schema == RESULT_SCHEMA for tool in listed.tools)

    allowed = await call_tool(
        ctx, types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "work"})
    )
    assert not allowed.is_error and allowed.structured_content["count"] == 1
    jsonschema.validate(allowed.structured_content, RESULT_SCHEMA)
    denied = await call_tool(
        ctx, types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "private"})
    )
    assert denied.is_error
    events = await sync_to_async(list)(RunEvent.unscoped.filter(run=run, type="tool_call").order_by("seq"))
    assert [e.data["decision"] for e in events] == ["allowed", "denied"]
    assert events[0].data["label"] == "Todoist: List tasks"


def test_listed_tools_say_whether_they_only_read(scoped, user, agent, grant, todoist):
    grant(work=["read", "create"])
    with workspace_scope(scoped.id):
        conversation = Conversation.objects.create(agent=agent, user=user)
        services.start_run(conversation=conversation, user_id=user.id, content="Add a task")
    [(run, _)] = services.claim_queued(1)
    listed = async_to_sync(list_tools)(_mcp_ctx(run), None)
    assert {tool.name: tool.annotations.read_only_hint for tool in listed.tools} == {
        "todoist_list_projects": True,
        "todoist_list_tasks": True,
        "todoist_get_task": True,
        "todoist_create_task": False,
    }


def _mcp_ctx(run) -> SimpleNamespace:
    return SimpleNamespace(request=SimpleNamespace(scope={RUN_SCOPE_KEY: run.id}))


def _list_tasks() -> types.CallToolRequestParams:
    return types.CallToolRequestParams(name="todoist_list_tasks", arguments={"project_id": "work"})


async def test_tool_calls_stop_at_the_run_limit_and_the_refusal_is_recorded_once(claimed):
    run, _ = claimed
    await Run.unscoped.filter(pk=run.id).aupdate(max_tool_calls=2)
    results = [await call_tool(_mcp_ctx(run), _list_tasks()) for _ in range(4)]
    assert [r.is_error for r in results] == [False, False, True, True]
    assert results[2].content[0].text == "This run has reached its limit of 2 tool calls."
    events = await sync_to_async(list)(RunEvent.unscoped.filter(run=run, type="tool_call").order_by("seq"))
    assert [(e.data["decision"], e.data.get("code")) for e in events] == [
        ("allowed", None),
        ("allowed", None),
        ("denied", "LIMIT_REACHED"),
    ]
    # Refusals after the first write nothing.
    assert (await Run.unscoped.aget(pk=run.id)).tool_calls == 3


async def test_a_limit_refusal_that_cannot_be_recorded_is_not_counted(claimed, monkeypatch):
    run, _ = claimed
    await Run.unscoped.filter(pk=run.id).aupdate(max_tool_calls=1, tool_calls=1)
    append_event = services.append_event
    failures = [RuntimeError("database unavailable")]

    def flaky_append_event(*args):
        if failures:
            raise failures.pop()
        return append_event(*args)

    monkeypatch.setattr(services, "append_event", flaky_append_event)
    first = await call_tool(_mcp_ctx(run), _list_tasks())
    second = await call_tool(_mcp_ctx(run), _list_tasks())
    assert first.is_error and second.is_error
    assert second.content[0].text == "This run has reached its limit of 1 tool calls."
    refusals = RunEvent.unscoped.filter(run=run, type="tool_call", data__code="LIMIT_REACHED")
    assert await refusals.acount() == 1
    assert (await Run.unscoped.aget(pk=run.id)).tool_calls == 2


async def test_concurrent_tool_calls_cannot_share_the_last_one(claimed, todoist):
    run, _ = claimed
    await Run.unscoped.filter(pk=run.id).aupdate(max_tool_calls=3, tool_calls=2)
    results = await asyncio.gather(*(call_tool(_mcp_ctx(run), _list_tasks()) for _ in range(5)))
    assert sum(not r.is_error for r in results) == 1
    assert len(todoist.calls) == 1
    refusals = RunEvent.unscoped.filter(run=run, type="tool_call", data__code="LIMIT_REACHED")
    assert await refusals.acount() == 1


def test_a_reservation_waiting_on_another_connection_cannot_take_the_same_last_call(claimed):
    run, _ = claimed
    Run.unscoped.filter(pk=run.id).update(max_tool_calls=1)
    event = {"tool": "todoist_list_tasks", "label": "Todoist: List tasks", "arguments": {}}

    def reserve_elsewhere():
        try:
            return mcp._reserve_tool_call(run.id, event)
        finally:
            connection.close()

    with ThreadPoolExecutor(1) as pool:
        with transaction.atomic():
            mcp._reserve_tool_call(run.id, event)
            other = pool.submit(reserve_elsewhere)
            # The other connection waits for this transaction's row lock, then sees its count.
            _wait_for_a_lock_waiter()
            assert not other.done()
        with pytest.raises(mcp.ToolLimitReached):
            other.result(timeout=10)
    assert Run.unscoped.get(pk=run.id).tool_calls == 2


def _wait_for_a_lock_waiter() -> None:
    give_up = time.monotonic() + 10
    with connection.cursor() as cursor:
        while time.monotonic() < give_up:
            cursor.execute(
                "SELECT count(*) FROM pg_locks WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))"
            )
            if cursor.fetchone()[0]:
                return
            time.sleep(0.01)
    raise AssertionError("No other connection waited for a lock held by this one.")


async def test_tool_calls_of_one_run_wait_for_a_free_slot(claimed, monkeypatch):
    run, _ = claimed
    monkeypatch.setattr(mcp, "config", lambda: SimpleNamespace(run_tool_concurrency=2))
    running = peak = 0

    async def invoke(self, tool, raw):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        raise OperationError("FAILED", "Done.")

    monkeypatch.setattr(Executor, "invoke", invoke)
    await asyncio.gather(*(call_tool(_mcp_ctx(run), _list_tasks()) for _ in range(5)))
    assert peak == 2
    assert run.id not in mcp._slots


async def test_a_call_waiting_for_a_slot_when_the_run_stops_does_nothing(claimed, todoist, monkeypatch):
    run, _ = claimed
    monkeypatch.setattr(mcp, "config", lambda: SimpleNamespace(run_tool_concurrency=1))
    loop = asyncio.get_running_loop()
    admitted = asyncio.Event()
    reserve = mcp._reserve_tool_call

    def reserve_and_tell(run_id, event):
        deadline = reserve(run_id, event)
        loop.call_soon_threadsafe(admitted.set)
        return deadline

    monkeypatch.setattr(mcp, "_reserve_tool_call", reserve_and_tell)
    deadline = (await Run.unscoped.aget(pk=run.id)).deadline
    async with mcp._slot(run.id, deadline):
        waiting = asyncio.create_task(call_tool(_mcp_ctx(run), _list_tasks()))
        await admitted.wait()
        await sync_to_async(services.finish)(run.id, Run.Status.CANCELLED)
        assert not waiting.done()
    result = await waiting
    assert result.is_error and result.content[0].text == "This run is no longer active."
    assert todoist.calls == []


async def test_a_call_waiting_for_a_slot_gives_up_at_the_deadline(claimed, monkeypatch):
    run, _ = claimed
    monkeypatch.setattr(mcp, "config", lambda: SimpleNamespace(run_tool_concurrency=1))
    deadline = timezone.now() + timedelta(seconds=0.2)
    await Run.unscoped.filter(pk=run.id).aupdate(deadline=deadline)
    async with mcp._slot(run.id, deadline):
        result = await call_tool(_mcp_ctx(run), _list_tasks())
    assert result.is_error and result.content[0].text == "This run is no longer active."


async def test_tool_calls_of_an_ended_run_are_not_counted(claimed):
    run, _ = claimed
    await sync_to_async(services.finish)(run.id, Run.Status.CANCELLED)
    result = await call_tool(_mcp_ctx(run), _list_tasks())
    assert result.is_error and result.content[0].text == "This run is no longer active."
    assert (await Run.unscoped.aget(pk=run.id)).tool_calls == 0
