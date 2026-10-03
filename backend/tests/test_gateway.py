import asyncio
import json
import time
from datetime import timedelta
from types import SimpleNamespace

import httpx
import mcp_types as types
import pytest
from asgiref.sync import sync_to_async
from django.core.handlers.asgi import ASGIHandler
from django.test import AsyncClient, override_settings
from django.utils import timezone

from conversations.models import Conversation, Message
from gateway import views
from gateway.body_limit import limit_body
from gateway.mcp import RUN_SCOPE_KEY, call_tool, list_tools
from models_access.chat import build_chat_payload
from models_access.taps import ResponsesTap, StreamTap, StreamTooLarge
from models_access.upstream import OpenAICompatibleProvider, Route, UpstreamResponse
from models_access.validate import InvalidModelRequest
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


def test_chat_messages_are_rebuilt_from_known_fields():
    call = {"id": "c1", "type": "function", "function": {"name": "t", "arguments": "{}"}, "index": 0}
    body = {
        "messages": [
            {"role": "assistant", "content": None, "audio": {"id": "audio_elsewhere"}, "tool_calls": [call]},
            {"role": "assistant", "content": "hi", "reasoning_content": "because", "x": 1},
            {"role": "tool", "tool_call_id": "c1", "content": [{"type": "text", "text": "ok", "cache": 1}]},
        ]
    }
    payload = build_chat_payload({**body, "stream": True}, Route("default", "m", 100, api="chat"))
    assert payload["messages"] == [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{k: v for k, v in call.items() if k != "index"}],
        },
        {"role": "assistant", "content": "hi", "reasoning_content": "because"},
        {"role": "tool", "content": [{"type": "text", "text": "ok"}], "tool_call_id": "c1"},
    ]


CHAT_ROUTE = Route("default", "m", 100, api="chat")


def test_chat_requests_as_the_worker_sends_them_are_rebuilt():
    """The shape pi-ai's openai-completions adapter sends to a custom OpenAI-compatible endpoint."""
    tool = {
        "type": "function",
        "function": {"name": "t", "description": "A tool", "parameters": {"type": "object"}, "strict": False},
    }
    call = {"id": "c1", "type": "function", "function": {"name": "t", "arguments": "{}"}}
    messages = [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "x"},
        {
            "role": "assistant",
            "content": None,
            "reasoning_content": "because",
            "reasoning_details": [{"type": "reasoning.encrypted", "data": "sealed"}],
            "tool_calls": [call],
        },
        {"role": "tool", "content": "ok", "tool_call_id": "c1"},
    ]
    body = {
        "model": "gpt-expensive",
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": False},
        "store": True,
        "max_completion_tokens": 50,
        "tools": [tool],
        "prompt_cache_key": "session-1",
        "priority": 1,
    }
    assert build_chat_payload(body, CHAT_ROUTE) == {
        "model": "m",
        "messages": messages,
        "n": 1,
        "store": False,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_completion_tokens": 50,
        "tools": [tool],
    }
    # Sent when the history has tool calls but no tools are active.
    assert build_chat_payload({**body, "tools": []}, CHAT_ROUTE)["tools"] == []


def test_chat_options_are_rebuilt_from_known_keys():
    body = {
        "messages": [{"role": "user", "content": "x"}],
        "stream": True,
        "tools": [{"type": "function", "function": {"name": "t", "x": 1}, "x": 1}],
        "tool_choice": {"type": "function", "function": {"name": "t", "x": 1}},
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "s", "schema": {"type": "object"}, "strict": True, "x": 1},
        },
        "stop": ["a", "b"],
        "parallel_tool_calls": False,
        "temperature": 0,
        "top_p": 0.5,
        "seed": 7,
        "reasoning_effort": "low",
        "logit_bias": {"1": 100},
    }
    payload = build_chat_payload(body, CHAT_ROUTE)
    assert {key: payload[key] for key in body.keys() - {"messages", "logit_bias"}} == {
        "stream": True,
        "tools": [{"type": "function", "function": {"name": "t"}}],
        "tool_choice": {"type": "function", "function": {"name": "t"}},
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "s", "schema": {"type": "object"}, "strict": True},
        },
        "stop": ["a", "b"],
        "parallel_tool_calls": False,
        "temperature": 0,
        "top_p": 0.5,
        "seed": 7,
        "reasoning_effort": "low",
    }
    assert "logit_bias" not in payload
    # Null means unset, as in the Responses builder.
    nulls = dict.fromkeys(body.keys() - {"messages", "stream"})
    assert build_chat_payload({**body, **nulls}, CHAT_ROUTE).keys() == {
        "model",
        "messages",
        "n",
        "store",
        "stream",
        "stream_options",
        "max_completion_tokens",
    }
    for value in ("auto", "none", "required"):
        assert build_chat_payload({**body, "tool_choice": value}, CHAT_ROUTE)["tool_choice"] == value
    for value in ({"type": "text", "x": 1}, {"type": "json_object"}):
        rebuilt = build_chat_payload({**body, "response_format": value}, CHAT_ROUTE)
        assert rebuilt["response_format"] == {"type": value["type"]}
    assert build_chat_payload({**body, "stop": "END"}, CHAT_ROUTE)["stop"] == "END"


CHAT_REFUSALS = [
    {"tools": [{"type": "custom", "custom": {"name": "t"}}]},
    {"tools": [{"type": "function", "name": "t", "parameters": {}}]},
    {"tools": [{"type": "function", "function": {"name": 1}}]},
    {"tools": [{"type": "function", "function": {"name": "t", "parameters": "{}"}}]},
    {"tools": [{"type": "function", "function": {"name": "t", "strict": "yes"}}]},
    {"tools": [{"type": "function", "function": {"name": "t"}}] * 129},
    {"tools": {"type": "function", "function": {"name": "t"}}},
    {"tool_choice": "any"},
    {"tool_choice": {"type": "function", "name": "t"}},
    {"tool_choice": {"type": "allowed_tools", "allowed_tools": {"mode": "auto", "tools": []}}},
    {"response_format": {"type": "json_schema", "json_schema": {"schema": {}}}},
    {"response_format": {"type": "json_schema", "json_schema": {"name": "s", "schema": "{}"}}},
    {"response_format": {"type": "grammar", "grammar": "x"}},
    {"response_format": "json_object"},
    {"stop": ["a", "b", "c", "d", "e"]},
    {"stop": [1]},
    {"stop": 1},
    {"temperature": True},
    {"temperature": "0.5"},
    {"top_p": [1]},
    {"seed": 1.5},
    {"seed": False},
    {"parallel_tool_calls": 1},
    {"reasoning_effort": {"effort": "high"}},
    {"stream": "yes"},
]


@pytest.mark.parametrize("change", CHAT_REFUSALS)
def test_chat_requests_outside_the_allowlist_are_refused(change):
    body = {"messages": [{"role": "user", "content": "x"}], "stream": True, **change}
    with pytest.raises(InvalidModelRequest):
        build_chat_payload(body, CHAT_ROUTE)


@pytest.mark.parametrize("change", CHAT_REFUSALS[::4])
async def test_refused_chat_requests_reserve_nothing_and_reach_no_provider(claimed, monkeypatch, change):
    run, token = claimed
    _upstream(monkeypatch, lambda request: pytest.fail("reached the provider"), api="chat")
    body = {"messages": [{"role": "user", "content": "x"}], "stream": True, **change}
    assert (await _post(token, "/v1/chat/completions", body)).status_code == 400
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


def test_the_tap_screens_whole_events():
    tap = StreamTap()
    error = json.dumps({"error": {"code": "server_error", "message": SECRET}})
    relayed = tap.feed(f"data: {error}\n\ndata: [DONE]\n\n".encode())
    assert SECRET.encode() not in relayed and relayed.endswith(b"\n\ndata: [DONE]\n\n")
    assert tap.error_code == "server_error"

    # Data spread over several lines is one event; it arrives here in pieces.
    tap = ResponsesTap()
    event = f'event: error\r\ndata: {{"type": "error",\r\ndata: "message": "{SECRET}"}}\r\n\r\n'.encode()
    relayed = b"".join(tap.feed(event[i : i + 7]) for i in range(0, len(event), 7)) + tap.finish()
    assert relayed.startswith(b"event: error\ndata: ") and SECRET.encode() not in relayed

    # Lines may also end with a bare CR, and a stream may open with a byte order mark.
    for framing in (
        b'event: error\rdata: {"type": "error", "message": "%s"}\r\r',
        b'\xef\xbb\xbfdata: {"type": "error", "message": "%s"}\n\n',
        b'data: {"error": {"message": "%s"}}\r\n\r\n',
    ):
        event = framing % SECRET.encode()
        tap = ResponsesTap()
        relayed = b"".join(tap.feed(event[i : i + 1]) for i in range(len(event))) + tap.finish()
        assert SECRET.encode() not in relayed and relayed.endswith(b"\n\n") and tap.error_code
    # A bare-CR event is complete as soon as its blank line arrives; the LF of a split CRLF is swallowed.
    tap = ResponsesTap()
    cr_event = DONE_EVENT.replace(b"\n", b"\r")
    assert tap.feed(cr_event) == DONE_EVENT and tap.metered
    assert tap.feed(b"data: x\r") == b"" and tap.feed(b"\n\n") == b"data: x\n\n"
    tap = ResponsesTap()
    tap.feed(b"\xef\xbb")
    tap.feed(b"\xbf" + DONE_EVENT.replace(b"\n", b"\r")[:-1])
    assert not tap.metered
    tap.finish()
    assert (tap.input_tokens, tap.output_tokens) == (5, 2)

    # Usage without counts is not usage.
    tap = ResponsesTap()
    tap.feed(b'data: {"type": "response.completed", "response": {"usage": {}}}\n\n')
    assert not tap.metered

    tap = StreamTap()
    with pytest.raises(StreamTooLarge):
        tap.feed(b"data: " + b"x" * StreamTap.MAX_EVENT + b"\n")


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
    await asyncio.wait_for(asyncio.gather(*views._calls), 5)
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens, stored.unmetered_model_calls) == (5, 2, 0)


async def test_a_stopped_run_ends_a_silent_model_stream(claimed, monkeypatch):
    run, token = claimed
    monkeypatch.setattr(views, "REVOCATION_CHECK_SECONDS", 0.05)
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

    monkeypatch.setattr(views, "MAX_RESPONSE_BYTES", len(TEXT_EVENT) + 1)
    response = await _post(token, "/v1/responses", BODY)
    assert await _rest(response.streaming_content) == TEXT_EVENT
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.model_calls, stored.input_tokens, stored.unmetered_model_calls) == (1, 0, 1)


async def test_a_stopped_run_ends_the_wait_for_the_provider(claimed, monkeypatch):
    run, token = claimed
    monkeypatch.setattr(views, "REVOCATION_CHECK_SECONDS", 0.05)
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
    monkeypatch.setattr(views, "REVOCATION_CHECK_SECONDS", 0.01)
    monkeypatch.setattr(views.services, "is_token_valid", slow_check)
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
    await views._abandon(opening, cm, run.id)
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
    call = views.ModelCall(run.id, ResponsesTap(), FailingClose(), upstream)
    await call._run()
    assert await _rest(call.stream()) == DONE_EVENT
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.input_tokens, stored.output_tokens, stored.unmetered_model_calls) == (5, 2, 0)


def test_no_model_call_is_reserved_for_a_run_past_its_deadline(claimed):
    run, _ = claimed
    Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() - timedelta(seconds=1))
    assert not views._reserve_model_call(run.id)
    Run.unscoped.filter(pk=run.id).update(deadline=timezone.now() + timedelta(minutes=1))
    assert views._reserve_model_call(run.id)


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
    assert events[0].data["label"] == "Todoist: List tasks"
