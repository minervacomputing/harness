// The stream tap's pure parts: segments, flushes, provider text kept out, usage.

import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { ABORTED, CONTEXT_OVERFLOW, DeltaBuffer, failureSummary, PROVIDER_ERROR, reportedUsage, screened, screenedEvent, TEXT_FLUSH_MS } from "../../src/model/tap.ts";

/** A secret-looking marker, as a provider's error text might echo a request's Authorization header. */
const SECRET = "SYNTHETIC_SECRET";

describe("segments", () => {
	test("adjacent deltas of a kind are joined, kinds alternate in arrival order", () => {
		const buffer = new DeltaBuffer();
		buffer.reasoning(0, "Hm");
		buffer.text("Hel");
		buffer.text("lo");
		expect(buffer.take()).toEqual([
			["reasoning", "Hm"],
			["text", "Hello"],
		]);
		expect(buffer.take()).toEqual([]);
		expect(TEXT_FLUSH_MS).toBe(250);
	});

	test("a summary in parts publishes one paragraph per part, as the Responses tap does", () => {
		// What pi-ai's Responses API emits for summary_index 0, 0, 1: a "\n\n" after every part, the last included.
		const buffer = new DeltaBuffer();
		for (const delta of ["Looking at ", "the list.", "\n\n", "Then the answer.", "\n\n"]) buffer.reasoning(0, delta);
		buffer.text("Hel");
		buffer.text("lo");
		expect(buffer.take()).toEqual([
			["reasoning", "Looking at the list.\n\nThen the answer."],
			["text", "Hello"],
		]);
	});

	test("a new thinking block is a new part; parts flushed apart still get their break", () => {
		const buffer = new DeltaBuffer();
		buffer.reasoning(0, "First.");
		expect(buffer.take()).toEqual([["reasoning", "First."]]);
		buffer.reasoning(2, "Second.");
		buffer.reasoning(2, " More.");
		expect(buffer.take()).toEqual([["reasoning", "\n\nSecond. More."]]);
	});

	test("an empty delta adds nothing", () => {
		const buffer = new DeltaBuffer();
		buffer.text("");
		buffer.reasoning(0, "");
		buffer.reasoning(0, "\n\n");
		expect(buffer.take()).toEqual([]);
	});
});

describe("errors and usage", () => {
	const message = (fields: Partial<AssistantMessage>): AssistantMessage =>
		({ role: "assistant", content: [], api: "x", provider: "x", model: "x", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1, ...fields }) as AssistantMessage;

	test("a provider's error text is replaced; an abort gets pi-ai's own words", () => {
		expect(screened(message({ stopReason: "error", errorMessage: "org-1234 is over quota" })).errorMessage).toBe(PROVIDER_ERROR);
		expect(PROVIDER_ERROR).toBe("The model provider reported an error.");
		expect(screened(message({ stopReason: "aborted", errorMessage: "Request was aborted" })).errorMessage).toBe(ABORTED);
		expect(screened(message({ stopReason: "aborted", errorMessage: `Bearer ${SECRET}` })).errorMessage).toBe("Request was aborted");
		const done = message({ content: [{ type: "text", text: "Hi" }], responseId: "resp_1" });
		expect(screened(done)).toEqual(done);
	});

	test("nothing a provider wrote survives in a message pi gets: diagnostics, its ids, its raw stop reason", () => {
		const diagnostics: NonNullable<AssistantMessage["diagnostics"]> = [
			{ type: "cloudflare-error", timestamp: 1, error: { message: `401 Incorrect API key provided: Bearer ${SECRET}`, name: "CloudflareAIError", code: "auth" }, details: { status: 401, logId: SECRET } },
			{ type: "cloudflare-fallback", timestamp: 1, details: { attempts: [{ errorMessage: `Bearer ${SECRET}`, model: "m" }] } },
		];
		const failed = message({ stopReason: "error", errorMessage: `401 Incorrect API key provided: Bearer ${SECRET}`, diagnostics, responseId: SECRET, responseModel: SECRET, rawStopReason: SECRET });
		const kept = screened(failed);
		expect(JSON.stringify(kept)).not.toContain(SECRET);
		expect(Object.keys(kept).sort()).toEqual(["api", "content", "errorMessage", "model", "provider", "role", "stopReason", "timestamp", "usage"]);
		// A successful message keeps its own fields, never a fallback's earlier failures.
		const done = screened(message({ diagnostics, responseId: "resp_1" }));
		expect([JSON.stringify(done).includes(SECRET), done.responseId]).toEqual([false, "resp_1"]);
		// Every event's message: the live partial (a copy, as the provider keeps mutating its own), done and error.
		const partial = message({ diagnostics });
		const events = [
			screenedEvent({ type: "text_delta", contentIndex: 0, delta: "Hi", partial }),
			screenedEvent({ type: "done", reason: "stop", message: partial }),
			screenedEvent({ type: "error", reason: "error", error: failed }),
		];
		expect(JSON.stringify(events)).not.toContain(SECRET);
		expect((events[0] as { partial: AssistantMessage }).partial).not.toBe(partial);
	});

	test("a context overflow is still one to pi-ai, in our words; other errors are not (pi-durable compacts on it)", () => {
		const overflow = message({ stopReason: "error", errorMessage: `Your input exceeds the context window of this model. Bearer ${SECRET}` });
		expect(isContextOverflow(overflow)).toBe(true);
		const kept = screened(overflow);
		expect([kept.errorMessage, isContextOverflow(kept), JSON.stringify(kept).includes(SECRET)]).toEqual([CONTEXT_OVERFLOW, true, false]);
		for (const text of ["prompt is too long: 213462 tokens > 200000 maximum", "context_length_exceeded", "Prompt too long"]) {
			expect(screened(message({ stopReason: "error", errorMessage: text })).errorMessage).toBe(CONTEXT_OVERFLOW);
		}
		// pi-ai's own exclusions stay excluded: a rate limit that mentions tokens is no overflow.
		for (const text of ["Rate limit reached: too many tokens per minute", "org-1234 is over quota"]) {
			const other = screened(message({ stopReason: "error", errorMessage: text }));
			expect([other.errorMessage, isContextOverflow(other)]).toEqual([PROVIDER_ERROR, false]);
		}
		expect(isContextOverflow(screened(message({ stopReason: "error" })))).toBe(false);
	});

	test("the log of a failure says its kind, status, class and createAI's code, never the provider's text", () => {
		const failed = message({
			stopReason: "error",
			errorMessage: `401 Incorrect API key provided: Bearer ${SECRET}`,
			diagnostics: [{ type: "cloudflare-error", timestamp: 1, error: { message: `Bearer ${SECRET}`, name: "CloudflareAIError", code: "auth" }, details: { status: 401 } }],
		});
		expect(failureSummary(failed, undefined)).toBe("The model provider reported an error, status 401, CloudflareAIError, code auth.");
		expect(failureSummary(failed, 403)).toBe("The model provider reported an error, status 403, CloudflareAIError, code auth.");
		const forged = message({
			stopReason: "error",
			errorMessage: "Your input exceeds the context window of this model.",
			diagnostics: [{ type: "x", timestamp: 1, error: { message: SECRET, name: `Bearer ${SECRET}`, code: SECRET }, details: { status: SECRET } }],
		});
		expect(failureSummary(forged, undefined)).toBe("The model provider reported a context overflow.");
	});

	test("the last usage report counts; none makes the call unmetered", () => {
		expect(reportedUsage(message({}).usage)).toEqual({ input: 5, output: 1, cached: 0, reasoning: 0 });
		expect(reportedUsage(undefined)).toBeNull();
		expect(reportedUsage({ ...message({}).usage, input: 0, output: 0 })).toBeNull();
		expect(reportedUsage({ ...message({}).usage, input: 1.5 })).toBeNull();
		expect(reportedUsage({ ...message({}).usage, input: -1 })).toBeNull();
	});

	test("the input counts cached tokens, as the provider's input_tokens does", () => {
		// pi-ai reports OpenAI's input_tokens 10, of them 8 cached, as input 2 and cacheRead 8.
		expect(reportedUsage({ ...message({}).usage, input: 2, cacheRead: 8, cacheWrite: 0, output: 2 })).toEqual({ input: 10, output: 2, cached: 8, reasoning: 0 });
		expect(reportedUsage({ ...message({}).usage, input: 0, cacheRead: 0, cacheWrite: 3, output: 0 })).toEqual({ input: 3, output: 0, cached: 0, reasoning: 0 });
	});
});
