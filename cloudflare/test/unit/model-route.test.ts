// Where model requests go: routes from the settings, the fake for tests and a test deployment,
// and never the account's default AI Gateway.

import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parse } from "../../src/config.ts";
import { DEFAULT_SCRIPT, FAKE_PROVIDER, fakeUpstream, scriptOf, stepOf } from "../../src/model/fake.ts";
import { CONTEXT_WINDOW, type ModelRoute, QUIET_MS, routeOf, upstreamOf } from "../../src/model/route.ts";
import { settingsEnv } from "./settings.ts";

/** Enough of the AI binding for createAI to build a provider; nothing is called. */
const BINDING = { aiGatewayLogId: null, run: async () => ({}), gateway: () => ({}) } as unknown as Ai;

describe("routes", () => {
	test("the settings name the model, its gateway, its API, its cap and reasoning", () => {
		const route = routeOf(parse(settingsEnv({ MINERVA_MODEL_MAX_OUTPUT_TOKENS: "1000", MINERVA_MODEL_REASONING_EFFORT: "low" })));
		expect(route).toEqual({ provider: "workers-ai", name: "@cf/zai-org/glm-5.3-flash", gateway: "acme", api: "chat", cap: 1000, reasoningEffort: "low", reasoningSummary: "" });
		expect(parse(settingsEnv({ MINERVA_MODEL_PROVIDER: "fake" })).model.provider).toBe("fake");
		expect(() => parse(settingsEnv({ MINERVA_MODEL_PROVIDER: "openrouter" }))).toThrow("MINERVA_MODEL_PROVIDER must be one of 'workers-ai', 'openai', 'anthropic', 'fake'.");
	});

	test("Workers AI goes through the configured gateway, never the default one", () => {
		const route = routeOf(parse(settingsEnv()));
		const upstream = upstreamOf(route, BINDING);
		expect(upstream.model).toMatchObject({ id: "@cf/zai-org/glm-5.3-flash", maxTokens: 8192, contextWindow: CONTEXT_WINDOW });
		expect(() => upstreamOf({ ...route, gateway: "default" }, BINDING)).toThrow(/default AI Gateway/);
		expect(() => upstreamOf(route, undefined)).toThrow("The AI binding is missing.");
	});

	test("OpenAI and Anthropic models are routed by createAI with their own wire APIs", () => {
		const base = routeOf(parse(settingsEnv({ MINERVA_MODEL_PROVIDER: "openai", MINERVA_MODEL_NAME: "gpt-5-mini", MINERVA_MODEL_API: "responses", MINERVA_MODEL_REASONING_EFFORT: "medium", MINERVA_MODEL_REASONING_SUMMARY: "auto" })));
		const responses = upstreamOf(base, BINDING);
		expect(responses.model).toMatchObject({ id: "gpt-5-mini", api: "openai-responses", provider: "openai", reasoning: true, maxTokens: 8192 });
		expect(responses.options).toEqual({ reasoning: "medium", reasoningSummary: "auto" });
		expect(upstreamOf({ ...base, api: "chat", reasoningEffort: "" }, BINDING).model).toMatchObject({ api: "openai-completions", reasoning: false });
		expect(upstreamOf({ ...base, provider: "anthropic", name: "claude-test" }, BINDING).model).toMatchObject({ api: "anthropic-messages", provider: "anthropic" });
	});

	test("the fake is not a route: only the test build and the tests have it", () => {
		expect(() => upstreamOf({ ...routeOf(parse(settingsEnv())), provider: "fake" }, BINDING)).toThrow("The fake model runs only in the test build.");
		expect(fakeUpstream().model.provider).toBe(FAKE_PROVIDER);
	});

	test("every route stops reading an answer that is quiet for 120 s between chunks", () => {
		const options = (route: Partial<ModelRoute>) => {
			const { model } = upstreamOf({ ...routeOf(parse(settingsEnv())), ...route }, BINDING);
			return (model as unknown as { [key: symbol]: { streamIdleTimeoutMs?: number } })[Symbol.for("agents.models.pi-ai.options")];
		};
		expect(QUIET_MS).toBe(120_000);
		for (const route of [{}, { provider: "anthropic", name: "claude-test" }, { provider: "openai", api: "chat" }, { provider: "openai", api: "responses" }] as Partial<ModelRoute>[]) {
			expect(options(route)).toMatchObject({ streamIdleTimeoutMs: 120_000 });
		}
	});
});

describe("the fake model", () => {
	const context = (messages: Message[]) => ({ messages }) as unknown as TranscriptContext;

	test("reads its script from the prompt, or answers Done.", () => {
		const script = { turns: [{ text: "Hi" }] };
		expect(scriptOf(context([{ role: "user", content: JSON.stringify({ fake: script }), timestamp: 1 }]))).toEqual(script);
		expect(scriptOf(context([{ role: "user", content: "Hello", timestamp: 1 }]))).toBe(DEFAULT_SCRIPT);
		expect(scriptOf(context([{ role: "user", content: '{"fake": {"turns": 3}}', timestamp: 1 }]))).toBe(DEFAULT_SCRIPT);
		// The run's own prompt is the last user message; earlier ones are history.
		const later = { turns: [{ text: "Later" }] };
		expect(
			scriptOf(
				context([
					{ role: "user", content: JSON.stringify({ fake: script }), timestamp: 1 },
					{ role: "user", content: JSON.stringify({ fake: later }), timestamp: 2 },
				]),
			),
		).toEqual(later);
	});

	test("its step is the tool rounds after the last user message, so a replay gets the same answer", () => {
		const round = { role: "assistant", stopReason: "toolUse", content: [] } as unknown as Message;
		const answer = { role: "assistant", stopReason: "stop", content: [] } as unknown as Message;
		const user = { role: "user", content: "x", timestamp: 1 } as Message;
		expect(stepOf([user])).toBe(0);
		expect(stepOf([user, round, round])).toBe(2);
		expect(stepOf([round, answer, user, round])).toBe(1);
	});
});
