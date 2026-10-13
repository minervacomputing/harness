// What a model request may carry, as rules on the payload pi-ai builds: the forced model, the output cap, `store: false`, text and function tools only.

import { readFileSync } from "node:fs";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { COMPACTION_PROMPT_START, forcePayload, isCompaction, outputCap, refusal } from "../../src/model/policy.ts";
import type { ModelRoute } from "../../src/model/route.ts";

function route(fields: Partial<ModelRoute> = {}): ModelRoute {
	return { provider: "openai", name: "gpt-test", gateway: "acme", api: "chat", cap: 1000, reasoningEffort: "", reasoningSummary: "", ...fields };
}

function context(messages: Message[]): TranscriptContext {
	return { messages } as unknown as TranscriptContext;
}

describe("the output cap", () => {
	test("the requested positive integer up to the cap, else the cap", () => {
		expect(outputCap(99999, 1000)).toBe(1000);
		expect(outputCap(500, 1000)).toBe(500);
		for (const requested of [undefined, null, 0, -1, 1.5, true, "500"]) expect(outputCap(requested, 1000)).toBe(1000);
	});
});

describe("payloads", () => {
	test("chat: the instance's model, the cap on max_completion_tokens, store false, no user or max_tokens", () => {
		const payload = forcePayload(route(), { model: "gpt-expensive", messages: [], max_tokens: 99999, user: "x", stream: true }, 1000);
		expect(payload).toEqual({ model: "gpt-test", messages: [], max_completion_tokens: 1000, store: false, stream: true });
	});

	test("responses: stored state and identification dropped, the cap on max_output_tokens", () => {
		const payload = forcePayload(
			route({ api: "responses" }),
			{ model: "x", input: [], store: true, previous_response_id: "r1", service_tier: "flex", user: "u", metadata: {}, max_output_tokens: 50, prompt_cache_key: "k" },
			1000,
		);
		expect(payload).toEqual({ model: "gpt-test", input: [], store: false, max_output_tokens: 50, prompt_cache_key: "k" });
	});

	test("responses: reasoning comes from configuration, with its encrypted content replayed", () => {
		const client = { input: [], reasoning: { effort: "low", summary: "auto" }, include: ["file_search_call.results"] };
		expect(forcePayload(route({ api: "responses", reasoningEffort: "high", reasoningSummary: "auto" }), client, 1000)).toMatchObject({
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
		});
		expect(forcePayload(route({ api: "responses", reasoningEffort: "high" }), client, 1000)).toMatchObject({ reasoning: { effort: "high" } });
		const none = forcePayload(route({ api: "responses" }), client, 1000) as { [key: string]: unknown };
		expect(["reasoning" in none, "include" in none]).toEqual([false, false]);
	});

	test("Workers AI: the binding's body gets the cap and nothing it would not know", () => {
		expect(forcePayload(route({ provider: "workers-ai", name: "@cf/zai-org/glm-5.3-flash" }), { messages: [], max_tokens: 99999 }, 8192)).toEqual({ messages: [], max_tokens: 8192 });
		expect(forcePayload(route({ provider: "anthropic", name: "claude-test" }), { model: "x", max_tokens: 10 }, 8192)).toEqual({ model: "claude-test", max_tokens: 10 });
	});

	test("a tool that is not a function is refused", () => {
		expect(() => forcePayload(route({ api: "responses" }), { tools: [{ type: "web_search" }] }, 1000)).toThrow("Only function tools can be offered to the model.");
		expect(forcePayload(route(), { tools: [{ type: "function", function: { name: "t" } }] }, 1000)).toMatchObject({ tools: [{ type: "function" }] });
	});
});

describe("requests", () => {
	test("only text: an image in a message or a tool result is refused before anything is sent", () => {
		const image = { type: "image" as const, data: "x", mimeType: "image/png" };
		expect(refusal(context([{ role: "user", content: [image], timestamp: 1 }]))).toBe("Only text can be sent to the model.");
		expect(refusal(context([{ role: "toolResult", toolCallId: "c", toolName: "t", content: [image], isError: false, timestamp: 1 } as Message]))).toBe(
			"Only text can be sent to the model.",
		);
		expect(refusal(context([{ role: "user", content: "Hi", timestamp: 1 }]))).toBeNull();
	});

	test("only function tools: a grammar tool is refused", () => {
		const system: Message = { role: "system", content: "", toolsAdded: [{ name: "t", description: "", parameters: {} as never, constrainedSampling: { type: "grammar", variants: {} } }], timestamp: 1 };
		expect(refusal(context([system]))).toBe("Only function tools can be offered to the model.");
	});

	test("a compaction's summary request is told apart, by the prompt pi-durable sends", () => {
		expect(isCompaction(context([{ role: "system", content: `${COMPACTION_PROMPT_START} Your task…`, timestamp: 1 }]))).toBe(true);
		expect(isCompaction(context([{ role: "system", content: "You are an agent inside Minerva.", timestamp: 1 }]))).toBe(false);
		expect(isCompaction(context([{ role: "user", content: COMPACTION_PROMPT_START, timestamp: 1 }]))).toBe(false);
		// The installed pi-durable still sends it (harness/compaction.js keeps it private).
		const source = readFileSync(new URL("harness/compaction.js", import.meta.resolve("@earendil-works/pi-durable")).pathname, "utf8");
		expect(source).toContain(`const SUMMARIZATION_SYSTEM_PROMPT = \`${COMPACTION_PROMPT_START}`);
	});
});
