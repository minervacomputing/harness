"""A scripted OpenAI-compatible model for local end-to-end runs without a provider key.

On the first request of a turn it calls one offered tool (preferring `*_list_projects`); once a tool
result is present it answers in text and quotes the start of that result. A message that starts with
`run_script:` makes it call the code-mode tool with the rest of the message as the script. A message that starts with
`slow:` makes it stream one event per second, which leaves time to stop a worker mid-answer. A message that starts with
`multi:` makes it call three tools that need no arguments, one after another, before it answers. It says a sentence before each tool call.
Serves Chat Completions and Responses, and streams like the real API. When asked for encrypted reasoning it emits a
reasoning item, with a summary when one is asked for; over Chat Completions it streams `reasoning_content`.

    uv run python devtools/fake_model.py  # then MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9900


SCRIPT_PREFIX = "run_script:"
SLOW_PREFIX = "slow:"
MULTI_PREFIX = "multi:"


def text_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content if isinstance(content, str) else ""


def plan(body: dict) -> dict:
    responses = "input" in body
    messages = body.get("input" if responses else "messages") or []
    specs = [tool if responses else tool["function"] for tool in body.get("tools") or []]
    tools = [spec["name"] for spec in specs]
    # Tools the fake can call with no arguments; the worker refuses a call that lacks a required one.
    free = [spec["name"] for spec in specs if not (spec.get("parameters") or {}).get("required")]
    print(f"model request: {len(messages)} item(s), tools: {', '.join(tools) or 'none'}", flush=True)
    last = messages[-1] if messages else {}
    is_result = last.get("type") == "function_call_output" if responses else last.get("role") == "tool"
    turn = messages[
        next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("role") == "user"), 0) :
    ]
    results = sum(
        1 for m in turn if (m.get("type") == "function_call_output" if responses else m.get("role") == "tool")
    )
    prompt = next((text_of(m) for m in reversed(messages) if m.get("role") == "user"), "")
    pace = 1.0 if prompt.startswith(SLOW_PREFIX) else 0.03
    step = choose(tools, free, responses, last, is_result, prompt, results)
    return {**step, "pace": pace, "thought": thought(step, results), "call": f"call_{results + 1}"}


def thought(step: dict, results: int) -> str:
    if "tool" in step:
        return f"The user wants something from their apps. Step {results + 1}: I will call {step['tool']}."
    return "I have what I need. I will answer briefly."


def choose(
    tools: list[str], free: list[str], responses: bool, last: dict, is_result: bool, prompt: str, results: int
) -> dict:
    if "run_script" in tools and not is_result and prompt.startswith(SCRIPT_PREFIX):
        return {"tool": "run_script", "arguments": json.dumps({"code": prompt.removeprefix(SCRIPT_PREFIX)})}
    if tools and prompt.startswith(MULTI_PREFIX) and results < 3:
        name = (free or tools)[results % len(free or tools)]
        return {"tool": name, "say": f"Now {name}."}
    if tools and not is_result:
        name = next((tool for tool in tools if tool.endswith("list_projects")), tools[0])
        return {"tool": name, "say": "Let me look that up."}
    result = last.get("output" if responses else "content") if is_result else None
    if isinstance(result, list):
        result = " ".join(part.get("text", "") for part in result if isinstance(part, dict))
    text = f"This is the fake model. I was offered {len(tools)} tool(s)."
    if result:
        text += f" The tool answered: {str(result)[:300]}"
    return {"text": text}


def chunk(delta: dict, finish: str | None = None) -> dict:
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "fake",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def message_item(text: str, id: str = "msg_fake") -> dict:
    content = [{"type": "output_text", "text": text, "annotations": []}]
    return {"type": "message", "id": id, "role": "assistant", "status": "completed", "content": content}


def response_items(body: dict, step: dict) -> list[dict]:
    items = []
    if "reasoning.encrypted_content" in (body.get("include") or []):
        asked = (body.get("reasoning") or {}).get("summary")
        summary = [{"type": "summary_text", "text": step["thought"]}] if asked else []
        items.append({"type": "reasoning", "id": "rs_fake", "summary": summary, "encrypted_content": "fake"})
    if "say" in step:
        items.append(message_item(step["say"], "msg_say"))
    if "tool" in step:
        items.append(
            {
                "type": "function_call",
                "id": f"fc_{step['call']}",
                "call_id": step["call"],
                "name": step["tool"],
                "arguments": step.get("arguments", "{}"),
                "status": "completed",
            }
        )
    else:
        items.append(message_item(step["text"]))
    return items


def response_events(items: list[dict], response: dict) -> list[dict]:
    events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}]
    for index, item in enumerate(items):
        if item["type"] == "message":
            text = item["content"][0]["text"]
            opened = {**item, "status": "in_progress", "content": []}
            events.append({"type": "response.output_item.added", "output_index": index, "item": opened})
            part = {"type": "output_text", "text": "", "annotations": []}
            ids = {"item_id": item["id"], "output_index": index, "content_index": 0}
            events.append({"type": "response.content_part.added", **ids, "part": part})
            for word in text.split(" "):
                events.append({"type": "response.output_text.delta", **ids, "delta": word + " "})
            events.append({"type": "response.output_text.done", **ids, "text": text})
            events.append({"type": "response.content_part.done", **ids, "part": item["content"][0]})
        elif item["type"] == "reasoning" and item["summary"]:
            text = item["summary"][0]["text"]
            events.append(
                {"type": "response.output_item.added", "output_index": index, "item": {**item, "summary": []}}
            )
            ids = {"item_id": item["id"], "output_index": index, "summary_index": 0}
            events.append(
                {
                    "type": "response.reasoning_summary_part.added",
                    **ids,
                    "part": {"type": "summary_text", "text": ""},
                }
            )
            for word in text.split(" "):
                events.append({"type": "response.reasoning_summary_text.delta", **ids, "delta": word + " "})
            events.append({"type": "response.reasoning_summary_text.done", **ids, "text": text})
            events.append({"type": "response.reasoning_summary_part.done", **ids, "part": item["summary"][0]})
        else:
            opened = {**item, "arguments": ""} if item["type"] == "function_call" else item
            events.append({"type": "response.output_item.added", "output_index": index, "item": opened})
            if item["type"] == "function_call":
                ids = {"item_id": item["id"], "output_index": index}
                arguments = item["arguments"]
                events.append({"type": "response.function_call_arguments.delta", **ids, "delta": arguments})
                events.append(
                    {"type": "response.function_call_arguments.done", **ids, "arguments": arguments}
                )
        events.append({"type": "response.output_item.done", "output_index": index, "item": item})
    events.append({"type": "response.completed", "response": response})
    return [{**event, "sequence_number": n} for n, event in enumerate(events)]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        step = plan(body)
        if self.path.endswith("/responses"):
            self.respond(body, step)
            return
        usage = {"prompt_tokens": 42, "completion_tokens": 7, "total_tokens": 49}
        if not body.get("stream"):
            message = {"role": "assistant", "content": step.get("text")}
            if "tool" in step:
                message["tool_calls"] = [
                    {
                        "id": step["call"],
                        "type": "function",
                        "function": {"name": step["tool"], "arguments": step.get("arguments", "{}")},
                    }
                ]
            payload = {"id": "chatcmpl-fake", "object": "chat.completion", "model": "fake", "usage": usage}
            payload["choices"] = [{"index": 0, "message": message, "finish_reason": "stop"}]
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        events = [chunk({"role": "assistant", "content": ""})]
        events += [chunk({"reasoning_content": word + " "}) for word in step["thought"].split(" ")]
        if "say" in step:
            events += [chunk({"content": word + " "}) for word in step["say"].split(" ")]
        if "tool" in step:
            call = {"index": 0, "id": step["call"], "type": "function"}
            call["function"] = {"name": step["tool"], "arguments": step.get("arguments", "{}")}
            events += [chunk({"tool_calls": [call]}), chunk({}, "tool_calls")]
        else:
            events += [chunk({"content": word + " "}) for word in step["text"].split(" ")]
            events.append(chunk({}, "stop"))
        events.append({**chunk({}), "choices": [], "usage": usage})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for event in events:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()
            time.sleep(step["pace"])
        self.wfile.write(b"data: [DONE]\n\n")

    def respond(self, body: dict, step: dict) -> None:
        response = {
            "id": "resp_fake",
            "object": "response",
            "created_at": int(time.time()),
            "model": "fake",
            "status": "completed",
            "output": response_items(body, step),
            "usage": {"input_tokens": 42, "output_tokens": 7, "total_tokens": 49},
        }
        if not body.get("stream"):
            data = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for event in response_events(response["output"], response):
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()
            time.sleep(step["pace"])

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"Fake model listening on http://127.0.0.1:{PORT}/v1")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
