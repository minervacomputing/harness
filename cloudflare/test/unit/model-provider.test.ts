// The model wrapper on fake streams (ARCHITECTURE.md: The harness, Model): refusals that count nothing, the call counted once, deltas per
// call id, usage, provider error text, aborts, the output cap and the tool-call text. The relay's
// reasoning-summary retry, metering of refused calls and read timeout go through createAI itself, over a
// fake AI binding that answers as AI Gateway's universal endpoint and OpenAI's Responses API do.

import { type AssistantMessage, type AssistantMessageEvent, createModels, type TranscriptContext, isContextOverflow, type Message, type Models, type SimpleStreamOptions, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, test } from "vitest";
import { type FakeOptions, type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { COMPACTION_PROMPT_START, IMAGE_PLACEHOLDER, TOOL_IMAGE_PLACEHOLDER } from "../../src/model/policy.ts";
import {
	type CallRequest,
	type CallSettlement,
	callOf,
	IMAGE_MAX_BYTES,
	MINERVA_PROVIDER,
	MODEL_ALIAS,
	minervaModel,
	minervaProvider,
	type ModelHost,
	REASONING_SUMMARY,
	RUN_ENDED_TEXT,
	SUMMARY_REFUSED_HINT,
} from "../../src/model/provider.ts";
import { type ModelRoute, upstreamOf } from "../../src/model/route.ts";
import { CONTEXT_OVERFLOW, PROVIDER_ERROR, type Segment } from "../../src/model/tap.ts";
import type { AttemptFence } from "../../src/shared/rpc.ts";

const FENCE: AttemptFence = { runId: "0199a000-0000-7000-8000-000000000001", attempt: 2 };
const ROUTE: ModelRoute = { provider: "fake", name: "fake", gateway: "acme", api: "chat", cap: 1000, reasoningEffort: "", reasoningSummary: "" };

class Host implements ModelHost {
	active = true;
	/** The run ended between `begin` and the record. */
	ended = false;
	controller = new AbortController();
	/** Each call recorded, in order; its id is its position, in 8 hex. */
	records: CallRequest[] = [];
	settlements: { call: string; settlement: CallSettlement }[] = [];
	/** Awaited by each settlement before it is kept: a test may hold it or fail it. */
	settling = async () => {};
	published: [string, Segment[]][] = [];
	texts: [string, string][] = [];
	logs: string[] = [];
	sessions: (string | undefined)[] = [];
	begin(sessionId: string | undefined) {
		this.sessions.push(sessionId);
		return this.active ? { fence: FENCE, signal: this.controller.signal } : null;
	}
	async record(fence: AttemptFence, request: CallRequest) {
		expect(fence).toEqual(FENCE);
		if (this.ended) return null;
		this.records.push(request);
		return this.records.length.toString(16).padStart(8, "0");
	}
	current(fence: AttemptFence) {
		expect(fence).toEqual(FENCE);
		return this.active;
	}
	deltas(_fence: AttemptFence, call: string, segments: Segment[]) {
		this.published.push([call, segments]);
	}
	toolCallText(_fence: AttemptFence, callId: string, text: string) {
		this.texts.push([callId, text]);
	}
	async settle(fence: AttemptFence, call: string, settlement: CallSettlement) {
		expect(fence).toEqual(FENCE);
		await this.settling();
		this.settlements.push({ call, settlement });
	}
	log(message: string) {
		this.logs.push(message);
	}
	get counts() {
		return this.records.length;
	}
	/** Each settlement in short: a reported call's input and output, a refusal, or an unmetered call's cause. */
	get outcomes() {
		return this.settlements.map(({ settlement }) =>
			settlement.outcome === "reported" ? { input: settlement.tokens.input, output: settlement.tokens.output } : settlement.outcome === "refused" ? "refused" : settlement.cause,
		);
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
		expect([host.counts, options.length, host.settlements.length]).toEqual([0, 0, 0]);
	});

	test("a request with anything but text and images is refused before it is counted", async () => {
		const { host, models, options } = setup();
		const audio = { type: "audio", data: "x", mimeType: "audio/wav" } as unknown as { type: "text"; text: string };
		const message = await ask(models, [{ role: "user", content: [audio], timestamp: 1 }]);
		expect(message.errorMessage).toBe("Only text and images can be sent to the model.");
		expect([host.counts, options.length]).toEqual([0, 0]);
	});

	test("a run that ended before the call was recorded gets 'This run has ended.', with nothing recorded or sent", async () => {
		const { host, models, options } = setup();
		host.ended = true;
		const message = await ask(models, prompt({ turns: [{ text: "Hi" }] }));
		expect([message.stopReason, message.errorMessage]).toEqual(["error", RUN_ENDED_TEXT]);
		expect([host.counts, options.length, host.settlements.length]).toEqual([0, 0, 0]);
	});

	test("a record that fails ends the call as an error before anything is sent", async () => {
		const { host, models, options } = setup();
		host.record = async () => {
			throw new TypeError("SQLITE_FULL");
		};
		const message = await ask(models, prompt({ turns: [{ text: "Hi" }] }));
		expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
		expect([options.length, host.settlements.length]).toEqual([0, 0]);
		expect(host.logs).toEqual(["A model call could not be recorded (TypeError)."]);
	});

	test("the session id names the run", async () => {
		const { host, models } = setup();
		await ask(models, prompt({ turns: [{ text: "Hi" }] }), { sessionId: "provider-session" });
		expect(host.sessions).toEqual(["provider-session"]);
	});
});

describe("a call", () => {
	test("is recorded once with its route and reservation, streams under the record's id, names it in its message, and settles reported", async () => {
		const { host, models } = setup();
		const message = await ask(models, prompt({ turns: [{ thinking: "Hm", text: "Hello", usage: { input: 7, output: 3 } }] }));
		expect(message.content.filter((block) => block.type === "text")).toEqual([{ type: "text", text: "Hello" }]);
		expect(host.records).toEqual([{ provider: "fake", model: "fake-1", reserved: { input: 128_000, output: 1000 } }]);
		const segments = host.published.flatMap(([, published]) => published);
		expect(segments.filter(([kind]) => kind === "reasoning").map(([, text]) => text).join("")).toBe("Hm");
		expect(segments.filter(([kind]) => kind === "text").map(([, text]) => text).join("")).toBe("Hello");
		expect(new Set(host.published.map(([call]) => call))).toEqual(new Set(["00000001"]));
		expect(callOf(message)).toBe("00000001");
		// The fake builds no payload, so it has no request bytes.
		expect(host.settlements).toEqual([{ call: "00000001", settlement: { outcome: "reported", tokens: { input: 7, output: 3, cached: 0, cacheWrite: 0, reasoning: 0 }, requestBytes: null } }]);
	});

	test("each call gets its own id; there is no limit on calls", async () => {
		const { host, models } = setup();
		for (let i = 0; i < 3; i++) await ask(models, prompt({ turns: [{ text: `Answer ${i}` }] }));
		expect(host.counts).toBe(3);
		expect(host.published.map(([call]) => call)).toEqual(["00000001", "00000002", "00000003"]);
	});

	test("publishes what streamed every 0.25 s, then the rest when it settles", async () => {
		let now = 0;
		const { host, models } = setup({}, () => (now += 100));
		await ask(models, prompt({ chunkChars: 1, turns: [{ text: "abcdefgh" }] }));
		const texts = host.published.map(([, segments]) => segments.map(([, text]) => text).join(""));
		expect(texts.length).toBeGreaterThan(1);
		expect(texts.join("")).toBe("abcdefgh");
	});

	test("an answer without a usage report settles unmetered, no_usage", async () => {
		const { host, models } = setup();
		await ask(models, prompt({ turns: [{ text: "x", usage: null }] }));
		expect(host.outcomes).toEqual(["no_usage"]);
	});

	test("a refusal (a 4xx without an answer) settles refused; another status settles unmetered, failed", async () => {
		const { host, models } = setup();
		const first = await ask(models, prompt({ turns: [{ refused: { status: 429 } }] }));
		const second = await ask(models, prompt({ turns: [{ refused: { status: 502 } }] }));
		expect([first.errorMessage, second.errorMessage]).toEqual([PROVIDER_ERROR, PROVIDER_ERROR]);
		expect(host.outcomes).toEqual(["refused", "failed"]);
	});

	test("the terminal event reaches pi only once the call is settled", async () => {
		const { host, models } = setup();
		const held = Promise.withResolvers<void>();
		host.settling = () => held.promise;
		const stream = models.streamSimple(minervaModel(ROUTE), { messages: prompt({ turns: [{ text: "Hello" }] }) }, { sessionId: "s1" });
		const seen: string[] = [];
		const reading = (async () => {
			for await (const event of stream) seen.push(event.type);
		})();
		let answered = false;
		void stream.result().then(() => (answered = true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["start", "text_start", "text_delta", "text_end"]);
		expect([answered, host.settlements.length]).toEqual([false, 0]);
		held.resolve();
		await reading;
		expect(seen.at(-1)).toBe("done");
		expect([answered, host.outcomes.length]).toEqual([true, 1]);
	});

	test("a call whose last text cannot be published still settles and answers", async () => {
		const { host, models } = setup();
		host.deltas = () => {
			throw new TypeError("SQLITE_FULL");
		};
		const message = await ask(models, prompt({ turns: [{ text: "Hello", usage: { input: 7, output: 3 } }] }));
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(host.outcomes).toEqual([{ input: 7, output: 3 }]);
		expect(host.logs).toEqual(["A model call's last text could not be published (TypeError)."]);
	});

	test("a settlement that fails holds the answer: pi never hears it", async () => {
		const { host, models } = setup();
		host.settling = async () => {
			throw new TypeError("SQLITE_FULL");
		};
		const stream = models.streamSimple(minervaModel(ROUTE), { messages: prompt({ turns: [{ text: "Hello" }] }) }, { sessionId: "s1" });
		let answered = false;
		void stream.result().then(() => (answered = true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(answered).toBe(false);
		expect(host.logs).toEqual(["A model call could not be settled (TypeError); its answer is held."]);
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
		expect(host.settlements.map(({ settlement }) => settlement.outcome)).toEqual(["reported"]);
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

	test("the run stopping aborts the stream; an answer that had started and reported nothing is unmetered, no_usage", async () => {
		const { host, models } = setup({ onDelta: async (_call, index) => {
			if (index === 2) host.controller.abort(new Error("The run ended."));
		} });
		// No usage report had arrived when the run stopped: no input tokens, one unmetered call.
		const message = await ask(models, prompt({ chunkChars: 1, delayMs: 1, turns: [{ text: "abcdefgh", usage: null }] }));
		expect(message.stopReason).toBe("aborted");
		expect(host.outcomes).toEqual(["no_usage"]);
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

	test("arguments cut off mid-value, which the fake parses as pi-ai's streaming parse does, are refused", async () => {
		const text = '{"key":"inb';
		const { models } = setup();
		const events = models.streamSimple(minervaModel(ROUTE), { messages: prompt({ turns: [{ tools: [{ name: "t", arguments: {} }], rawArguments: { "0": text } }] }) }, { sessionId: "s1" });
		const ended: unknown[] = [];
		for await (const event of events) if (event.type === "toolcall_end") ended.push([event.toolCall.arguments, event.toolCall.argumentsError]);
		const message = await events.result();
		const call = message.content.find((block) => block.type === "toolCall");
		const error = `Unterminated string in JSON at position 11 (line 1 column 12)\n\nReceived arguments:\n${text}`;
		expect(ended).toEqual([[{}, error]]);
		expect(call && "arguments" in call ? [call.arguments, call.argumentsError] : null).toEqual([{}, error]);
	});
});

/** AI Gateway's universal endpoint as createAI calls it (`env.AI.gateway(id).run`), answered by `answer`. */
class FakeGateway {
	/** What each request asked for, in order. */
	reasoning: unknown[] = [];
	/** Each request's payload, as the provider got it. */
	queries: unknown[] = [];
	signals: AbortSignal[] = [];
	answers: ((signal: AbortSignal) => Response | Promise<Response>)[] = [];
	readonly binding = {
		aiGatewayLogId: null,
		run: async () => ({}),
		gateway: () => ({
			run: async (request: { query: { reasoning?: unknown } }, options: { signal: AbortSignal }) => {
				this.reasoning.push(request.query.reasoning);
				this.queries.push(request.query);
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

/** A Responses stream that calls `save_note` with this argument text, sent in two deltas, with usage (5, 2). */
function calling(text: string) {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "save_note" };
	const half = Math.floor(text.length / 2);
	return () =>
		events([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: text.slice(0, half) },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: text.slice(half) },
			{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: text },
			{ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: text, status: "completed" } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
		]);
}

/** A chat-completions stream that calls `save_note` with this argument text, sent in two deltas, with usage (5, 2). */
function chatCalling(text: string) {
	const half = Math.floor(text.length / 2);
	const chunk = (delta: object, finish: string | null = null) => ({ id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
	return () =>
		events([
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "save_note", arguments: "" } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: text.slice(0, half) } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: text.slice(half) } }] }),
			{ ...chunk({}, "tool_calls"), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
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

const OPENAI: ModelRoute = { provider: "openai", name: "gpt-test", gateway: "acme", api: "responses", cap: 1000, reasoningEffort: "low", reasoningSummary: "auto" };

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
		// One model call each, the retry included, settled with the answer the retry got.
		expect(host.counts).toBe(2);
		expect(host.outcomes).toEqual([
			{ input: 5, output: 2 },
			{ input: 5, output: 2 },
		]);
	});

	test("a call's request bytes are the UTF-8 length of the last payload it sent, as it left", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [SUMMARY_REFUSAL, answered("Hello")];
		const { host, ask } = overGateway(gateway);
		await ask();
		const [first, last] = gateway.queries.map((query) => new TextEncoder().encode(JSON.stringify(query)).byteLength);
		expect(host.settlements.map(({ settlement }) => settlement.requestBytes)).toEqual([last]);
		expect(first).not.toBe(last);
	});

	test("a 400 for another reason keeps the summary: the call fails, and nothing is learned", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [refused(400, "Invalid value for 'max_output_tokens'.")];
		const { host, ask } = overGateway(gateway);
		const message = await ask();
		expect([message.stopReason, message.errorMessage]).toEqual(["error", PROVIDER_ERROR]);
		expect(gateway.reasoning).toEqual([{ effort: "low", summary: "auto" }]);
		expect(REASONING_SUMMARY.refused).toBe(false);
		expect([host.counts, host.outcomes]).toEqual([1, ["refused"]]);
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
		// The one request sent was refused: the call settles as that refusal.
		expect([host.counts, host.outcomes, REASONING_SUMMARY.refused]).toEqual([1, ["refused"], false]);
	});

	test("without a summary configured nothing is retried", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [SUMMARY_REFUSAL];
		const { ask } = overGateway(gateway, { reasoningSummary: "" });
		expect((await ask()).stopReason).toBe("error");
		expect(gateway.reasoning).toEqual([{ effort: "low" }]);
	});

	test("a 4xx without an answer settles refused; a 5xx, or a request that never reached the provider, unmetered, failed", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [
			refused(429, "Rate limit reached."),
			refused(500, "The server had an error."),
			() => {
				throw new TypeError("Network connection lost.");
			},
		];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		for (let i = 0; i < 3; i++) expect((await ask()).stopReason).toBe("error");
		expect([host.counts, host.outcomes]).toEqual([3, ["refused", "failed", "failed"]]);
	});

	test("an accepted answer with no body settles unmetered, no_usage", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [() => new Response(null, { status: 200 })];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		expect((await ask()).stopReason).toBe("error");
		expect([host.counts, host.outcomes]).toEqual([1, ["no_usage"]]);
	});

	test("a run stopped while waiting for the provider ends the wait, and the call settles unmetered, stopped", async () => {
		const gateway = new FakeGateway();
		gateway.answers = [silent];
		const { host, ask } = overGateway(gateway, { reasoningEffort: "" });
		const asked = ask();
		await new Promise((resolve) => setTimeout(resolve, 10));
		host.controller.abort(new Error("The run ended."));
		expect((await asked).stopReason).toBe("aborted");
		expect([host.counts, host.outcomes]).toEqual([1, ["stopped"]]);
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
			// The provider accepted the request, so the call settles as an answer without usage.
			expect([host.counts, host.outcomes]).toEqual([1, ["no_usage"]]);
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
		// The provider never answered, and nothing stopped the call: unmetered, failed.
		expect([host.counts, host.outcomes]).toEqual([1, ["failed"]]);
	});
});

/** A write tool as pi validates its calls (pi-durable's harness/tool.ts calls validateToolArguments). */
const SAVE_NOTE = {
	name: "save_note",
	description: "Saves a note.",
	parameters: { type: "object", properties: { folder: { type: "string" }, title: { type: "string" } }, required: ["folder", "title"], additionalProperties: false } as unknown as Tool["parameters"],
} satisfies Tool;

/** The `save_note` call the model streamed with `text` over createAI, as each `toolcall_end` event and the final message carry it. */
async function savedOver(api: ModelRoute["api"], text: string) {
	const gateway = new FakeGateway();
	gateway.answers = [api === "chat" ? chatCalling(text) : calling(text)];
	const { host, streamed } = overGateway(gateway, { api, reasoningEffort: "" });
	const { events, message } = await streamed();
	const ended = events.flatMap((event) => (event.type === "toolcall_end" ? [event.toolCall] : []));
	const call = message.content.find((block) => block.type === "toolCall");
	if (!call) throw new Error("No tool call in the message.");
	return { host, ended, call, message };
}

describe("tool calls over the Responses API (createAI)", () => {
	const saved = (text: string) => savedOver("responses", text);

	test("well-formed arguments reach the tool as the model sent them", async () => {
		const text = '{"folder":"inbox","title":"Hello"}';
		const { host, ended, call, message } = await saved(text);
		const expected = { type: "toolCall", id: "call_1|fc_1", name: "save_note", arguments: { folder: "inbox", title: "Hello" } };
		expect(message.stopReason).toBe("toolUse");
		expect([ended, call]).toEqual([[expected], expected]);
		expect(validateToolArguments(SAVE_NOTE, call)).toEqual({ folder: "inbox", title: "Hello" });
		expect(host.texts).toEqual([["call_1|fc_1", text]]);
	});

	test("arguments cut off mid-value are refused, never salvaged into a plausible call", async () => {
		const text = '{"folder":"inbox","title":"Hel';
		const { ended, call } = await saved(text);
		const error = `Unterminated string in JSON at position 30 (line 1 column 31)\n\nReceived arguments:\n${text}`;
		const expected = { type: "toolCall", id: "call_1|fc_1", name: "save_note", arguments: {}, argumentsError: error };
		expect([ended, call]).toEqual([[expected], expected]);
		expect(() => validateToolArguments(SAVE_NOTE, call)).toThrow(`Invalid arguments for tool "save_note": ${error}`);
	});

	test("a value with an invalid escape, as LaTeX's \\usepackage, keeps every field", async () => {
		const { call } = await saved('{"title":"\\usepackage{amsmath}","folder":"inbox"}');
		expect(call).toEqual({ type: "toolCall", id: "call_1|fc_1", name: "save_note", arguments: { title: "\\usepackage{amsmath}", folder: "inbox" } });
		expect(validateToolArguments(SAVE_NOTE, call)).toEqual({ title: "\\usepackage{amsmath}", folder: "inbox" });
	});
});

describe("tool calls over the chat API (createAI), whose parse keeps a cut-off text's prefix", () => {
	const saved = (text: string) => savedOver("chat", text);

	test("well-formed arguments reach the tool as the model sent them", async () => {
		const text = '{"folder":"inbox","title":"Hello"}';
		const { host, ended, call, message } = await saved(text);
		const expected = { type: "toolCall", id: "call_1", name: "save_note", arguments: { folder: "inbox", title: "Hello" } };
		expect(message.stopReason).toBe("toolUse");
		expect([ended, call]).toEqual([[expected], expected]);
		expect(host.texts).toEqual([["call_1", text]]);
	});

	test("arguments cut off mid-value are refused, never salvaged into a plausible call", async () => {
		const text = '{"folder":"inbox","title":"Hel';
		const { ended, call } = await saved(text);
		const error = `Unterminated string in JSON at position 30 (line 1 column 31)\n\nReceived arguments:\n${text}`;
		const expected = { type: "toolCall", id: "call_1", name: "save_note", arguments: {}, argumentsError: error };
		expect([ended, call]).toEqual([[expected], expected]);
		expect(() => validateToolArguments(SAVE_NOTE, call)).toThrow(`Invalid arguments for tool "save_note": ${error}`);
	});

	test("a raw line break in a value, which pi-ai's repair escapes, is not refused", async () => {
		const { call } = await saved('{"folder":"inbox","title":"Line 1\nLine 2"}');
		expect(call).toEqual({ type: "toolCall", id: "call_1", name: "save_note", arguments: { folder: "inbox", title: "Line 1\nLine 2" } });
	});
});

describe("images", () => {
	const IMAGE = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

	function withImages(): Message[] {
		const script = JSON.stringify({ fake: { turns: [{ text: "A dot." }] } });
		return [
			{ role: "user", content: [{ type: "text", text: script }, IMAGE], timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "dot.png" } }], api: "fake", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [IMAGE], isError: false, timestamp: 3 },
		];
	}

	test("the model pi sees takes images when the upstream does, at most IMAGE_MAX_BYTES of them", () => {
		expect(setup({ input: ["text", "image"] }).models.getModel(MINERVA_PROVIDER, MODEL_ALIAS)).toMatchObject({
			input: ["text", "image"],
			inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: IMAGE_MAX_BYTES } } },
		});
		expect(setup({ input: ["text"] }).models.getModel(MINERVA_PROVIDER, MODEL_ALIAS)?.input).toEqual(["text"]);
		expect(IMAGE_MAX_BYTES).toBeLessThan(2_000_000);
	});

	test("an upstream that takes images gets them as they are", async () => {
		const sent: TranscriptContext[] = [];
		const { models } = setup({ input: ["text", "image"], onCall: (_call, context) => sent.push(context) });
		const message = await ask(models, withImages());
		expect(message.stopReason).toBe("stop");
		expect(sent[0]?.messages).toEqual(withImages());
	});

	test("an upstream that takes text only gets pi-ai's placeholders instead", async () => {
		const sent: TranscriptContext[] = [];
		const { models } = setup({ input: ["text"], onCall: (_call, context) => sent.push(context) });
		const message = await ask(models, withImages());
		expect(message.stopReason).toBe("stop");
		const [user, , result] = sent[0]?.messages ?? [];
		expect(user?.content).toEqual([expect.objectContaining({ type: "text" }), { type: "text", text: IMAGE_PLACEHOLDER }]);
		expect(result?.content).toEqual([{ type: "text", text: TOOL_IMAGE_PLACEHOLDER }]);
	});
});
