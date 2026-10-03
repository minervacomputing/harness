"""Request builders and stream taps of models_access, tested without a database or the gateway."""

import json

import pytest

from models_access.chat import build_chat_payload
from models_access.taps import ResponsesTap, StreamTap, StreamTooLarge
from models_access.upstream import Route
from models_access.validate import InvalidModelRequest

SECRET = "quota of org-123 exceeded"
DONE_EVENT = b'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 2}}}\n\n'


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
