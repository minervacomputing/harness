// The model wrapper on fake streams (plan: The harness, Model): refusals that count nothing, the call counted once, deltas per
// call id, usage, provider error text, aborts, the output cap and the tool-call text. The relay's
// reasoning-summary retry, metering of refused calls and read timeout go through createAI itself, over a
// fake AI binding that answers as AI Gateway's universal endpoint and OpenAI's Responses API do.

import { type AssistantMessage, type AssistantMessageEvent, createModels, isContextOverflow, type Message, type Models, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, test } from "vitest";
import { type FakeOptions, type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { COMPACTION_PROMPT_START } from "../../src/model/policy.ts";
import { callOf, minervaModel, minervaProvider, type ModelHost, REASONING_SUMMARY, RUN_ENDED_TEXT, SUMMARY_REFUSED_HINT } from "../../src/model/provider.ts";
import { type ModelRoute, upstreamOf } from "../../src/model/route.ts";
import { CONTEXT_OVERFLOW, PROVIDER_ERROR, type Segment } from "../../src/model/tap.ts";
import type { AttemptFence } from "../../src/shared/rpc.ts";

const FENCE: AttemptFence = { runId: "0199a000-0000-7000-8000-000000000001", attempt: 2 };
const ROUTE: ModelRoute = { provider: "fake", name: "fake", gateway: "minerva-cf", api: "chat", cap: 1000, reasoningEffort: "", reasoningSummary: "" };

class Host implements ModelHost {
	active = true;
	controller = new AbortController();
	counts = 0;
	published: [string, Segment[]][] = [];
	texts: [string, string][] = [];
	usage: ({ input: number; output: number } | null)[] = [];
	logs: string[] = [];
	sessions: (string | undefined)[] = [];
	begin(sessionId: string | undefined) {
		this.sessions.push(sessionId);
		return this.active ? { fence: FENCE, signal: this.controller.signal } : null;
	}
	current(fence: AttemptFence) {
		expect(fence).toEqual(FENCE);
		return this.active;
	}
	counted(fence: AttemptFence) {
		expect(fence).toEqual(FENCE);
		this.counts++;
	}
	deltas(_fence: AttemptFence, call: string, segments: Segment[]) {
		this.published.push([call, segments]);
	}
	toolCallText(_fence: AttemptFence, callId: string, text: string) {
		this.texts.push([callId, text]);
	}
	settled(_fence: AttemptFence, usage: { input: number; output: number } | null) {
		this.usage.push(usage);
	}
	log(message: string) {
		this.logs.push(message);
	}
}

interface Setup {
	host: Host;
	models: Models;
	options: (SimpleStreamOptions | undefined)[];
}

function setup(fake: FakeOptions = {}, clock?: () => number, route: Partial<ModelRoute> = {}): Setup {
	const host = new Host();
	const options: (SimpleStreamOptions | undefined)[] = [];
	const models = createModels();
	models.setProvider(
		minervaProvider({
			route: () => ({ ...ROUTE, ...route }),
			upstream: () => {
				const upstream = fakeUpstream({
					...fake,
					onCall: (call, context, streamOptions) => {
						options.push(streamOptions);
						fake.onCall?.(call, context, streamOptions);
					},
				});
				return { ...upstream, options: { ...upstream.options, temperature: 0.5 } };
			},
			host,
			...(clock ? { now: clock } : {}),
		}),
	);
	return { host, models, options };
}

function prompt(script: FakeScript): Message[] {
	return [{ role: "user", content: JSON.stringify({ fake: script }), timestamp: 1 }];
}

async function ask(models: Models, messages: Message[], options: SimpleStreamOptions = { sessionId: "s1" }) {
	return models.streamSimple(minervaModel(ROUTE), { messages }, options).result();
}

describe("refused calls count nothing", () => {
	test("a call for a run that is not current gets 'This run has ended.' and never reaches the provider", async () => {
		const { host, models, options } = setup();
		host.active = false;
		const message = await ask(models, prompt({ turns: [{ text: "Hi" }] }));
		expect([message.stopReason, message.errorMessage]).toEqual(["error", RUN_ENDED_TEXT]);
		expect(RUN_ENDED_TEXT).toBe("This run has ended.");
		expect([host.counts, options.length, host.usage.length]).toEqual([0, 0, 0]);
	});

	test("a request with an image is refused before it is counted", async () => {
		const { host, models, options } = setup();
		const message = await ask(models, [{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 }]);
		expect(message.errorMessage).toBe("Only text can be sent to the model.");
		expect([host.counts, options.length]).toEqual([0, 0]);
	});

	test("the session id names the run", async () => {
		const { host, models } = setup();
		await ask(models, prompt({ turns: [{ text: "Hi" }] }), { sessionId: "provider-session" });
		expect(host.sessions).toEqual(["provider-session"]);
	});
});

describe("a call", () => {
	test("is counted once, streams its text and reasoning under one 8-hex call id, names it in its message, and records its usage", async () => {
		const { host, models } = setup();
		const message = await ask(models, prompt({ turns: [{ thinking: "Hm", text: "Hello", usage: { input: 7, output: 3 } }] }));
		expect(message.content.filter((block) => block.type === "text")).toEqual([{ type: "text", text: "Hello" }]);
		expect(host.counts).toBe(1);
		const segments = host.published.flatMap(([, published]) => published);
		expect(segments.filter(([kind]) => kind === "reasoning").map(([, text]) => text).join("")).toBe("Hm");
		expect(segments.filter(([kind]) => kind === "text").map(([, text]) => text).join("")).toBe("Hello");
		const calls = new Set(host.published.map(([call]) => call));
		expect(calls.size).toBe(1);
		expect([...calls][0]).toMatch(/^[0-9a-f]{8}$/);
		expect(callOf(message)).toBe([...calls][0]);
		expect(host.usage).toEqual([{ input: 7, output: 3 }]);
	});

	test("each call gets its own id; there is no limit on calls", async () => {
		const { host, models } = setup();
		for (let i = 0; i < 3; i++) await ask(models, prompt({ turns: [{ text: `Answer ${i}` }] }));
		expect(host.counts).toBe(3);
		expect(new Set(host.published.map(([call]) => call)).size).toBe(3);
	});

	test("publishes what streamed every 0.25 s, then the rest when it settles", async () => {
		let now = 0;
		const { host, models } = setup({}, () => (now += 100));
		await ask(models, prompt({ chunkChars: 1, turns: [{ text: "abcdefgh" }] }));
		const texts = host.published.map(([, segments]) => segments.map(([, text]) => text).join(""));
		expect(texts.length).toBeGreaterThan(1);
		expect(texts.join("")).toBe("abcdefgh");
	});

	test("a call without usage counts as unmetered", async () => {
		const { host, models } = setup();
		await ask(models, prompt({ turns: [{ text: "x", usage: null }] }));
		expect(host.usage).toEqual([null]);
	});

	test("the output cap and the route's options reach the provider", async () => {
		const { models, options } = setup();
		await ask(models, prompt({ turns: [{ text: "x" }] }), { sessionId: "s1", maxTokens: 99_999 });
		await ask(models, prompt({ turns: [{ text: "x" }] }), { sessionId: "s1", maxTokens: 300 });
		expect(options.map((option) => [option?.maxTokens, option?.temperature])).toEqual([
			[1000, 0.5],
			[300, 0.5],
		]);
	});

	test("a compaction's summary is not published as answer text, but is counted and metered", async () => {
		const { host, models } = setup({ script: () => ({ turns: [{ text: "Summary." }] }) });
		await ask(models, [
			{ role: "system", content: `${COMPACTION_PROMPT_START} Your task is…`, timestamp: 1 },
			{ role: "user", content: "Summarize", timestamp: 1 },
		]);
		expect(host.published).toEqual([]);
		expect(host.counts).toBe(1);
		expect(host.usage).toHaveLength(1);
	});
});

describe("errors and aborts", () => {
	test("a provider's error text is replaced before pi sees it, and never logged", async () => {
		const { host, models } = setup();
		const message = await ask(models, prompt({ turns: [{ error: { message: "org-1234 is over its quota" } }] }));
		expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
		expect(host.logs.join("\n")).not.toContain("org-1234");
		expect(host.logs.join("\n")).toContain("The model provider reported an error");
		expect(host.counts).toBe(1);
	});

	test("the run stopping aborts the stream; the call is unmetered", async () => {
		const { host, models } = setup({ onDelta: async (_call, index) => {
			if (index === 2) host.controller.abort(new Error("The run ended."));
		} });
		// No usage report had arrived when the run stopped: no input tokens, one unmetered call.
		const message = await ask(models, prompt({ chunkChars: 1, delayMs: 1, turns: [{ text: "abcdefgh", usage: null }] }));
		expect(message.stopReason).toBe("aborted");
		expect(host.usage).toEqual([null]);
		expect(host.counts).toBe(1);
	});
});

describe("the fake's script", () => {
	test("is read before the note on a message's attachments", async () => {
		const { models } = setup();
		const note = "\n\n[The user attached data.csv to this message, in your folder.]";
		const content = `${JSON.stringify({ fake: { turns: [{ text: "From the script." }] } })}${note}`;
		const message = await ask(models, [{ role: "user", content, timestamp: 1 }]);
		expect(message.content).toEqual([{ type: "text", text: "From the script." }]);
	});
});

describe("tool calls", () => {
	test("arguments the provider's JSON.parse misread are read again from the model's text before pi gets them", async () => {
		const first = "minerva_unit_escaped_key_probe";
		const text = `{"${first}":1,"\\n":2}`;
		// The runtime's escaped-key bug (lib/json.ts), here in Node's V8: the fake parses as pi-ai's providers do.
		JSON.parse(`{"${first}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(text))).toEqual([first, "\\"]);
		const { models } = setup();
		const events = models.streamSimple(minervaModel(ROUTE), { messages: prompt({ turns: [{ tools: [{ name: "t", arguments: {} }], rawArguments: { "0": text } }] }) }, { sessionId: "s1" });
		const ended: unknown[] = [];
		for await (const event of events) if (event.type === "toolcall_end") ended.push(event.toolCall.arguments);
		const message = await events.result();
		const call = message.content.find((block) => block.type === "toolCall");
		expect(ended).toEqual([{ [first]: 1, "\n": 2 }]);
		expect(call && "arguments" in call ? call.arguments : null).toEqual({ [first]: 1, "\n": 2 });
	});

	test("the argument text is handed over by call id, as the model sent it", async () => {
		const { host, models } = setup();
		const message = await ask(models, prompt({ turns: [{ tools: [{ name: "t", arguments: { "\n": 1 } }], rawArguments: { "0": '{"\\n": 1}' } }] }));
		const call = message.content.find((block) => block.type === "toolCall");
		expect(host.texts).toEqual([[call && "id" in call ? call.id : "", '{"\\n": 1}']]);
		expect(message.stopReason).toBe("toolUse");
	});
});

/** AI Gateway's universal endpoint as createAI calls it (`env.AI.gateway(id).run`), answered by `answer`. */
class FakeGateway {
	/** What each request asked for, in order. */
	reasoning: unknown[] = [];
	signals: AbortSignal[] = [];
	answers: ((signal: AbortSignal) => Response | Promise<Response>)[] = [];
	readonly binding = {
		aiGatewayLogId: null,
		run: async () => ({}),
		gateway: () => ({
			run: async (request: { query: { reasoning?: unknown } }, options: { signal: AbortSignal }) => {
				this.reasoning.push(request.query.reasoning);
				this.signals.push(options.signal);
				const answer = this.answers.shift();
				if (!answer) throw new Error("No answer left.");
				return answer(options.signal);
			},
		}),
	} as unknown as Ai;
}

function events(list: object[]): Response {
	return new Response(list.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A Responses stream that answers `text` with usage (5, 2). */
function answered(text: string) {
	return () =>
		events([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
		]);
}

function refused(status: number, message: string) {
	return () => new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }), { status, headers: { "content-type": "application/json" } });
}

/** OpenAI's answer to an organization it has not verified for summaries. */
const SUMMARY_REFUSAL = refused(400, "Your organization must be verified to generate reasoning summaries.");

/** Never answers; rejects when its request is aborted. */
function silent(signal: AbortSignal): Promise<Response> {
	return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

const OPENAI: ModelRoute = { provider: "openai", name: "gpt-test", gateway: "minerva-cf", api: "responses", cap: 1000, reasoningEffort: "low", reasoningSummary: "auto" };

function overGateway(gateway: FakeGateway, route: Partial<ModelRoute> = {}, quietMs?: number) {
	const host = new Host();
	const models = createModels();
	models.setProvider(
		minervaProvider({ route: () => ({ ...OPENAI, ...route }), upstream: (current) => upstreamOf(current, gateway.binding), host, ...(quietMs ? { quietMs } : {}) }),
	);
	const ask = async () => (await streamed()).message;
	/** Every event pi gets, and the final message. */
	const streamed = async () => {
		const stream = models.streamSimple(minervaModel(OPENAI), { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { sessionId: "s1" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const message = await stream.result();
		// The answer resolves with its last event; the call settles its usage just after.
		await new Promise((resolve) => setTimeout(resolve, 20));
		return { events, message };
	};
	return { host, ask, streamed };
}

/** A secret-looking marker, as a provider's error text might echo a request's Authorization header. */
const SECRET = "SYNTHETIC_SECRET";

/** What createAI itself makes of an answer, without the wrapper: the message pi would have stored. */
async function unwrapped(answer: (signal: AbortSignal) => Response | Promise<Response>): Promise<AssistantMessage> {
	const gateway = new FakeGateway();
	gateway.answers = [answer];
	const upstream = upstreamOf({ ...OPENAI, reasoningEffort: "" }, gateway.binding);
	return upstream.provider.streamSimple(upstream.model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] } as never, {}).result();
}

describe("over AI Gateway (createAI)", () => {
	beforeEach(() => {
		REASONING_SUMMARY.refused = false;
	});

	test("a refused reasoning summary is asked once more without it, and never again", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [SUMMARY_REFUSAL, answered("Hello"), answered("Again")];
		const { host, ask } = overGateway(gateway);
		const first = await ask();
		expect(first.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
		expect(gateway.reasoning).toEqual([{ effort: "low", summary: "auto" }, { effort: "low" }]);
		expect(host.logs).toContain(SUMMARY_REFUSED_HINT);
		await ask();
		expect(gateway.reasoning.slice(2)).toEqual([{ effort: "low" }]);
		// One model call each, the retry included; the refused request was neither metered nor unmetered.
		expect(host.counts).toBe(2);
		expect(host.usage).toEqual([
			{ input: 5, output: 2 },
			{ input: 5, output: 2 },
		]);
	});

	test("a 400 for another reason keeps the summary: the call fails, and nothing is learned", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [refused(400, "Invalid value for 'max_output_tokens'.")];
		const { host, ask } = overGateway(gateway);
		const message = await ask();
		expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
		expect(gateway.reasoning).toEqual([{ effort: "low", summary: "auto" }]);
		expect(REASONING_SUMMARY.refused).toBe(false);
		expect([host.counts, host.usage]).toEqual([1, []]);
	});

	test("a run that ended while the summary was refused is not asked again", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [SUMMARY_REFUSAL, answered("Never")];
		const { host, ask } = overGateway(gateway);
		gateway.answers[0] = () => {
			host.active = false;
			return SUMMARY_REFUSAL();
		};
		const message = await ask();
		expect([message.stopReason, message.errorMessage]).toEqual(["error", RUN_ENDED_TEXT]);
		expect(gateway.reasoning).toHaveLength(1);
		expect([host.counts, host.usage, REASONING_SUMMARY.refused]).toEqual([1, [], false]);
	});

	test("without a summary configured nothing is retried", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [SUMMARY_REFUSAL];
		const { ask } = overGateway(gateway, { reasoningSummary: "" });
		expect((await ask()).stopReason).toBe("error");
		expect(gateway.reasoning).toEqual([{ effort: "low" }]);
	});

	test("a call the provider refused, or that never reached it, is counted but neither metered nor unmetered", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [
			refused(500, "The server had an error."),
			() => {
				throw new TypeError("Network connection lost.");
			},
		];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		expect((await ask()).stopReason).toBe("error");
		expect((await ask()).stopReason).toBe("error");
		expect([host.counts, host.usage]).toEqual([2, []]);
	});

	test("an accepted answer with no body is counted unmetered", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [() => new Response(null, { status: 200 })];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		expect((await ask()).stopReason).toBe("error");
		expect([host.counts, host.usage]).toEqual([1, [null]]);
	});

	test("a run stopped while waiting for the provider ends the wait, and the call is unmetered", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [silent];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		const asked = ask();
		await new Promise((resolve) => setTimeout(resolve, 10));
		host.controller.abort(new Error("The run ended."));
		expect((await asked).stopReason).toBe("aborted");
		expect([host.counts, host.usage]).toEqual([1, [null]]);
	});

	test("an accepted answer that is not an event stream and never ends is timed too: an error, unmetered", async () => {
		// createAI reads such an answer whole after `start`, with no idle deadline of its own; its
		// test of the headers is case-sensitive, and no header at all is no event stream. These bodies do not
		// even end when their request is aborted: the wrapper stops waiting all the same.
		for (const headers of [{ "content-type": "text/plain" }, {}, { "content-type": "Text/Event-Stream" }] as Record<string, string>[]) {
			const gateway = new FakeGateway();
			gateway.answers = [() => new Response(new ReadableStream({}), { status: 200, headers })];
			const { host, ask } = overGateway(gateway, { api: "chat", reasoningEffort: "" }, 30);
			const message = await ask();
			expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
			expect(gateway.signals[0]?.aborted).toBe(true);
			expect(host.logs.join("\n")).toContain("did not answer within");
			// The provider accepted the request, so the call settles, without usage.
			expect([host.counts, host.usage]).toEqual([1, [null]]);
		}
	});

	test("a failure's text, which createAI copies into its diagnostics, reaches neither pi nor the log", async () => {
		const failures = [
			refused(401, `Incorrect API key provided: Bearer ${SECRET}.`),
			refused(500, `upstream echoed Authorization: Bearer ${SECRET}`),
			() => {
				throw new TypeError(`Network connection lost (Bearer ${SECRET}).`);
			},
		];
		// Without the wrapper, the text is in the message createAI hands on, diagnostics included.
		const raw = await unwrapped(refused(401, `Incorrect API key provided: Bearer ${SECRET}.`));
		expect(JSON.stringify(raw.diagnostics)).toContain(SECRET);
		for (const failure of failures) {
			const gateway = new FakeGateway();
			gateway.answers = [failure];
			const { host, streamed } = overGateway(gateway, { reasoningEffort: "" });
			const { events, message } = await streamed();
			expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
			expect(JSON.stringify({ events, message })).not.toContain(SECRET);
			expect(message.diagnostics).toBeUndefined();
			expect(host.logs.join("\n")).not.toContain(SECRET);
			expect(host.logs.length).toBeGreaterThan(0);
		}
	});

	test("a context overflow stays one for pi-durable, which compacts on it, without the provider's text", async () => {
		const overflow = refused(400, `Your input exceeds the context window of this model. Bearer ${SECRET}`);
		// pi-durable's test is pi-ai's isContextOverflow on the message it gets: true for createAI's own.
		expect(isContextOverflow(await unwrapped(overflow))).toBe(true);
		const gateway = new FakeGateway();
		gateway.answers = [overflow];
		const { host, streamed } = overGateway(gateway, { reasoningEffort: "" });
		const { events, message } = await streamed();
		expect([message.stopReason, message.errorMessage, isContextOverflow(message)]).toEqual(["error", CONTEXT_OVERFLOW, true]);
		expect(JSON.stringify({ events, message })).not.toContain(SECRET);
		expect(host.logs).toContain("The model provider reported a context overflow, status 400, CloudflareAIError, code bad-request.");
	});

	test("an answer that does not start in time ends the call as an error, as the relay's read timeout did", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [silent];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" }, 30);
		const message = await ask();
		expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
		expect(gateway.signals[0]?.aborted).toBe(true);
		expect(host.logs.join("\n")).toContain("did not answer within");
		// The provider never answered: counted, neither metered nor unmetered.
		expect([host.counts, host.usage]).toEqual([1, []]);
	});
});
