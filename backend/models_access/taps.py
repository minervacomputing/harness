"""Stream taps: what the relay reads from a provider's event stream as it passes it to the worker."""

import json
from typing import Any


class StreamTooLarge(Exception):
    pass


BOM = b"\xef\xbb\xbf"
# Where OpenAI-compatible chat servers stream reasoning (DeepSeek, vLLM, OpenRouter, ...).
REASONING_KEYS = ("reasoning_content", "reasoning", "reasoning_text")


class StreamTap:
    """Follows an OpenAI-style event stream as it is relayed: token usage, and the assistant's text and reasoning
    in the order they arrive, so the backend can stream progress without trusting the worker for it. Events pass through unchanged,
    except provider errors, whose diagnostics are replaced as they are for non-200 responses."""

    MAX_EVENT = 4_000_000
    ERROR_MESSAGE = "The model provider reported an error."

    def __init__(self) -> None:
        self._partial = b""
        self._started = False
        self._after_cr = False
        self._event: list[bytes] = []
        self._event_size = 0
        # [kind, text] pairs, kind "text" or "reasoning"; adjacent text of one kind is joined.
        self._segments: list[list[str]] = []
        self.input_tokens = 0
        self.output_tokens = 0
        self.metered = False
        self.error_code: str | None = None

    def feed(self, chunk: bytes) -> bytes:
        """Returns the events completed by this chunk, as the worker should receive them. Line endings
        are relayed as LF: event streams may also end lines with CR or CRLF, and a stream may open with a
        byte order mark, and every form has to be screened alike."""
        # A CR ends its line at once; an LF right after it, even in the next chunk, is part of that end.
        if chunk and self._after_cr:
            chunk, self._after_cr = chunk.removeprefix(b"\n"), False
        if chunk:
            self._after_cr = chunk.endswith(b"\r")
        data = self._partial + chunk
        if not self._started:
            if BOM.startswith(data):
                self._partial = data
                return b""
            data, self._started = data.removeprefix(BOM), True
        *lines, self._partial = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
        out = []
        for line in lines:
            self._event.append(line + b"\n")
            self._event_size += len(line) + 1
            if not line:
                out.append(self._flush())
            elif self._event_size > self.MAX_EVENT:
                raise StreamTooLarge
        if self._event_size + len(self._partial) > self.MAX_EVENT:
            raise StreamTooLarge
        return b"".join(out)

    def finish(self) -> bytes:
        if self._partial:
            self._event.append(self._partial.removeprefix(BOM))
            self._partial = b""
        return self._flush() if self._event else b""

    def take(self) -> list[tuple[str, str]]:
        """The text and reasoning read since the last call, in order."""
        segments = [(kind, text) for kind, text in self._segments]
        self._segments.clear()
        return segments

    def _add(self, kind: str, text: str) -> None:
        if not text:
            return
        if self._segments and self._segments[-1][0] == kind:
            self._segments[-1][1] += text
        else:
            self._segments.append([kind, text])

    def _flush(self) -> bytes:
        lines, self._event, self._event_size = self._event, [], 0
        # An event's data may span several lines, which clients join with newlines.
        data = [line.rstrip(b"\n")[5:] for line in lines if line.startswith(b"data:")]
        if not data:
            return b"".join(lines)
        try:
            body = json.loads(b"\n".join(item.removeprefix(b" ") for item in data))
        except ValueError:
            return b"".join(lines)
        replacement = self._read(body) if isinstance(body, dict) else None
        if replacement is None:
            return b"".join(lines)
        fields = b"".join(line for line in lines if not line.startswith(b"data:") and line.strip())
        return fields + b"data: " + json.dumps(replacement).encode() + b"\n\n"

    def _usage(self, usage: Any, input_key: str, output_key: str) -> None:
        if not isinstance(usage, dict):
            return
        counts = usage.get(input_key), usage.get(output_key)
        if all(type(count) is int and count >= 0 for count in counts):
            self.input_tokens, self.output_tokens = counts
            self.metered = True

    def _error(self, error: Any) -> None:
        code = error.get("code") if isinstance(error, dict) else None
        self.error_code = code if isinstance(code, str) else "unknown"

    def _read(self, body: dict) -> dict | None:
        """Takes what the tap needs from one event. Returns a replacement event, or None to relay it."""
        if body.get("error") is not None:
            self._error(body["error"])
            return {"error": {"message": self.ERROR_MESSAGE}}
        self._usage(body.get("usage"), "prompt_tokens", "completion_tokens")
        for choice in body.get("choices") or []:
            delta = choice.get("delta") if isinstance(choice, dict) else None
            if not isinstance(delta, dict):
                continue
            # Servers that stream reasoning name it differently.
            reasoning = next((delta[key] for key in REASONING_KEYS if isinstance(delta.get(key), str)), "")
            self._add("reasoning", reasoning)
            content = delta.get("content")
            if isinstance(content, str):
                self._add("text", content)
        return None


class ResponsesTap(StreamTap):
    """StreamTap for the Responses API: text is output_text; reasoning is the reasoning summary, or the reasoning
    text that some compatible servers stream instead. Encrypted reasoning is never read."""

    TERMINAL = frozenset({"response.completed", "response.incomplete", "response.failed"})
    REASONING = frozenset({"response.reasoning_summary_text.delta", "response.reasoning_text.delta"})

    def __init__(self) -> None:
        super().__init__()
        self._reasoning_part: tuple | None = None

    def _read(self, body: dict) -> dict | None:
        kind = body.get("type")
        # Screened alike: error events, and bare error envelopes some compatible servers send instead.
        if kind == "error" or (kind not in self.TERMINAL and body.get("error") is not None):
            self._error(body if kind == "error" else body["error"])
            return {
                "type": "error",
                "code": "provider_error",
                "message": self.ERROR_MESSAGE,
                "param": None,
                "sequence_number": body.get("sequence_number"),
            }
        if kind == "response.output_text.delta" and isinstance(body.get("delta"), str):
            self._add("text", body["delta"])
        elif kind in self.REASONING and isinstance(body.get("delta"), str) and body["delta"]:
            # A summary comes in parts, each a paragraph of its own.
            part = (body.get("item_id"), body.get("summary_index"), body.get("content_index"))
            if self._reasoning_part is not None and part != self._reasoning_part:
                self._add("reasoning", "\n\n")
            self._reasoning_part = part
            self._add("reasoning", body["delta"])
        elif kind in self.TERMINAL and isinstance(body.get("response"), dict):
            response = body["response"]
            self._usage(response.get("usage"), "input_tokens", "output_tokens")
            if response.get("error") is not None:
                self._error(response["error"])
                error = {"code": "provider_error", "message": self.ERROR_MESSAGE}
                return {**body, "response": {**response, "error": error}}
        return None
