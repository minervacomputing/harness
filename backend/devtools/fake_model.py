"""A scripted OpenAI-compatible model for local end-to-end runs without a provider key.

On the first request of a turn it calls one offered tool (preferring `*_list_projects`); once a tool
result is present it answers in text and quotes the start of that result. Streams like the real API.

    uv run python devtools/fake_model.py  # then MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9900


def plan(body: dict) -> dict:
    messages = body.get("messages") or []
    tools = [tool["function"]["name"] for tool in body.get("tools") or []]
    print(f"model request: {len(messages)} message(s), tools: {', '.join(tools) or 'none'}", flush=True)
    last = messages[-1] if messages else {}
    if tools and last.get("role") != "tool":
        name = next((tool for tool in tools if tool.endswith("list_projects")), tools[0])
        return {"tool": name}
    result = last.get("content") if last.get("role") == "tool" else None
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


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        step = plan(body)
        usage = {"prompt_tokens": 42, "completion_tokens": 7, "total_tokens": 49}
        if not body.get("stream"):
            message = {"role": "assistant", "content": step.get("text")}
            if "tool" in step:
                message["tool_calls"] = [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": step["tool"], "arguments": "{}"},
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
        if "tool" in step:
            call = {"index": 0, "id": "call_1", "type": "function"}
            call["function"] = {"name": step["tool"], "arguments": "{}"}
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
            time.sleep(0.03)
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"Fake model listening on http://127.0.0.1:{PORT}/v1")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
