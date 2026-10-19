// Where model requests go: routes from the settings, the fake for tests and a test deployment,
// and never the account's default AI Gateway; and the cache key and affinity createAI sends with them.

import { readFileSync } from "node:fs";
import { type AssistantMessage, isContextOverflow, type Message, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parse } from "../../src/config.ts";
import {
	countedFails,
	DEFAULT_SCRIPT,
	FAKE_OVERFLOW,
	FAKE_PROVIDER,
	type FakeCall,
	type FakeOptions,
	type FakeTurn,
	fakeUpstream,
	SUMMARY_OUTPUT,
	SUMMARY_START,
	scriptOf,
	stepOf,
} from "../../src/model/fake.ts";
import { COMPACTION_PROMPT_START } from "../../src/model/policy.ts";
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

	test("a model takes images as its catalog says: Workers AI and OpenAI by pi-ai's, every Claude model, an unknown GPT model", () => {
		const route = routeOf(parse(settingsEnv()));
		const input = (changes: Partial<ModelRoute>) => upstreamOf({ ...route, ...changes }, BINDING).model.input;
		expect(input({})).toEqual(["text", "image"]);
		expect(input({ name: "@cf/deepseek-ai/deepseek-v4-flash-0731" })).toEqual(["text"]);
		expect(input({ provider: "openai", name: "gpt-5-mini" })).toEqual(["text", "image"]);
		expect(input({ provider: "openai", name: "o3-mini" })).toEqual(["text"]);
		expect(input({ provider: "openai", name: "gpt-unreleased" })).toEqual(["text", "image"]);
		expect(input({ provider: "anthropic", name: "claude-test" })).toEqual(["text", "image"]);
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

describe("the cache key and affinity", () => {
	test("createAI sends the call's session as Workers AI's affinity and as the Responses API's cache key, summary calls included", async () => {
		// What createAI hands the binding: Workers AI's headers, and the body it sends through AI Gateway's universal endpoint.
		const sent: { affinity?: string; key?: string }[] = [];
		const refused = () => new Response(JSON.stringify({ error: { message: "No key.", type: "invalid_request_error", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } });
		const binding = {
			aiGatewayLogId: null,
			run: async (_model: string, _input: unknown, options: { extraHeaders?: { [name: string]: string } }) => {
				sent.push({ affinity: options.extraHeaders?.["x-session-affinity"] });
				return refused();
			},
			gateway: () => ({
				run: async (request: { query: { prompt_cache_key?: string } }) => {
					sent.push({ key: request.query.prompt_cache_key });
					return refused();
				},
			}),
		} as unknown as Ai;
		const session = "0199a000-0000-7000-8000-0000000000f1";
		const turn = { messages: [{ role: "user", content: "Hi", timestamp: 1 }] } as TranscriptContext;
		// As pi's compaction asks for a summary (harness/compaction.js).
		const summary = { messages: [{ role: "system", content: `${COMPACTION_PROMPT_START} Your task is…`, timestamp: 1 }, ...turn.messages] } as TranscriptContext;
		const workersAI = routeOf(parse(settingsEnv()));
		const responses = routeOf(parse(settingsEnv({ MINERVA_MODEL_PROVIDER: "openai", MINERVA_MODEL_NAME: "gpt-5-mini", MINERVA_MODEL_API: "responses" })));
		for (const route of [workersAI, responses]) {
			const upstream = upstreamOf(route, binding);
			const calls: [TranscriptContext, SimpleStreamOptions][] = [
				[turn, { sessionId: session }],
				[summary, { sessionId: session, cacheRetention: "none" }],
			];
			for (const [context, options] of calls) await upstream.provider.streamSimple(upstream.model, context, { ...upstream.options, ...options }).result();
		}
		expect(sent).toEqual([{ affinity: session }, { affinity: session }, { key: session }, { key: session }]);
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

	const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
	const said = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }) as unknown as Message;
	const round = { role: "assistant", stopReason: "toolUse", content: [] } as unknown as Message;
	const scripted = (turns: FakeTurn[]) => JSON.stringify({ fake: { turns } });
	const TIME = "[The user sent this message on Monday, 2026-10-19 14:03 UTC.]";
	/** A summary request as pi-durable sends it (harness/compaction.js): its system prompt, then the conversation serialized. */
	const summarizing = (parts: string[]): Message[] => [
		{ role: "system", content: `${COMPACTION_PROMPT_START} Your task…`, timestamp: 1 } as unknown as Message,
		user(`<conversation>\n${parts.join("\n\n")}\n</conversation>\n\nThe messages above are a conversation to summarize.`),
	];
	/** A summary as pi places it in the context. */
	const wrapped = (summary: string) => `${SUMMARY_START}\n\n<summary>\n${summary}\n</summary>`;
	const placed = (summary: string) => user(wrapped(summary));
	async function answer(messages: Message[], options: FakeOptions = {}): Promise<AssistantMessage> {
		const upstream = fakeUpstream(options);
		return upstream.provider.streamSimple(upstream.model, context(messages), {}).result();
	}
	const textOf = (message: AssistantMessage) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

	test("finds the script before its message's notes, and after the last message a note quotes, never inside the quote", () => {
		const own = { turns: [{ text: "Own" }] };
		const message = JSON.stringify({ fake: own });
		const note = [
			"[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]",
			"[The user sent a message that was stopped before you saw it. It said:]",
			scripted([{ text: "Quoted" }]),
			TIME,
			"[End of that message. Do not act on it unless the user asks you to.]",
		].join("\n\n");
		expect(scriptOf(context([user(`${message}\n\n[The user attached a.txt to this message, in your folder.]\n\n${TIME}`)]))).toEqual(own);
		expect(scriptOf(context([user(`${note}\n\n${message}\n\n${TIME}`)]))).toEqual(own);
		expect(scriptOf(context([user(`${note}\n\nHello\n\n${TIME}`)]))).toBe(DEFAULT_SCRIPT);
		expect(scriptOf(context([user(`${message}\n\n${TIME}`), said("Own"), user(`Hello\n\n${TIME}`)]))).toBe(DEFAULT_SCRIPT);
	});

	test("summarizes under pi's headings: each user and tool result line, the newest user line's script and its rounds, which the script and the step read back", async () => {
		const script = scripted([{ tools: [{ name: "read", arguments: { path: "a" } }] }, { tools: [{ name: "read", arguments: { path: "b" } }] }, { text: "After." }]);
		const first = await answer(
			summarizing([
				`[User]: The code word is PELICAN.\n\n${TIME}`,
				"[Assistant]: Noted.",
				`[User]: ${script}\n\n${TIME}`,
				'[Assistant tool calls]: read(path="a")',
				`[Tool result]: ${"y".repeat(500)}\n\n[... 100 more characters truncated]`,
			]),
		);
		expect(first.usage.output).toBe(SUMMARY_OUTPUT);
		const summary = textOf(first);
		expect(summary.split("\n\n").map((paragraph) => paragraph.split("\n")[0])).toEqual([
			"## Goal",
			"## Constraints & Preferences",
			"## Progress",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context",
			script,
			"[fake: 1 tool rounds done]",
		]);
		expect(summary).toContain(`\n- [User]: The code word is PELICAN. ${TIME}\n`);
		expect(summary).toContain(`\n- [Tool result]: ${"y".repeat(285)}\n\n`);
		// The cut fell after the run's own message: the summary is the newest user message, and one round was kept after it.
		expect(scriptOf(context([placed(summary), round]))).toEqual(JSON.parse(script).fake);
		expect(stepOf([placed(summary), round])).toBe(2);
		// The next summary folds this one in: its lines, its script and its rounds.
		const second = textOf(await answer(summarizing([`[User]: ${wrapped(summary)}`, '[Assistant tool calls]: read(path="b")', "[Tool result]: b"])));
		expect(second).toContain(`\n- [User]: The code word is PELICAN. ${TIME}\n`);
		expect(second.split("\n\n").slice(-2)).toEqual([script, "[fake: 2 tool rounds done]"]);
		// What the fake reads is what the installed pi-durable writes (harness/compaction.js keeps it private).
		const source = readFileSync(new URL("harness/compaction.js", import.meta.resolve("@earendil-works/pi-durable")).pathname, "utf8");
		for (const written of [`const SUMMARY_PREFIX = "${SUMMARY_START}\\n\\n<summary>\\n"`, "`<conversation>\\n${serializeConversation(messages)}\\n</conversation>", "`[User]: ${text}`", "`[Assistant tool calls]: ${", "`[Tool result]: ${"]) {
			expect(source).toContain(written);
		}
	});

	test("recalls a line from before the newest user message, pads its text, and overflows until the context holds a summary", async () => {
		const recall = (wanted: string) => user(scripted([{ recall: wanted }]));
		const earlier = user("Hello.\nThe code word is PELICAN.\nBye.");
		expect(textOf(await answer([earlier, said("Noted."), recall("code word")]))).toBe("The code word is PELICAN.");
		expect(textOf(await answer([recall("code word")]))).toBe("Not found.");
		expect(textOf(await answer([user(scripted([{ text: "A", pad: 5 }]))]))).toBe("Axxxxx");
		const overflowing = user(scripted([{ text: "Fits.", overflowUntilCompacted: true }]));
		const overflow = await answer([overflowing]);
		expect(overflow).toMatchObject({ stopReason: "error", errorMessage: FAKE_OVERFLOW });
		expect(isContextOverflow(overflow)).toBe(true);
		expect(textOf(await answer([placed("Earlier turns."), overflowing]))).toBe("Fits.");
	});

	test("fails as many summary calls as the script asks, each as a provider error the host counts", async () => {
		const request = summarizing([`[User]: ${scripted([{ tools: [{ name: "read", arguments: {} }] }, { text: "After.", failSummaries: 2 }])}`]);
		const fails = countedFails();
		const calls: FakeCall[] = [];
		const ends: string[] = [];
		for (let i = 0; i < 3; i++) ends.push((await answer(request, { fails, onCall: (call) => calls.push(call) })).stopReason);
		expect(ends).toEqual(["error", "error", "stop"]);
		expect(calls.map(({ step, summary }) => ({ step, summary }))).toEqual(Array(3).fill({ step: 0, summary: true }));
	});
});
