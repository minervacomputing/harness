// A deterministic model for tests and a test deployment (MINERVA_MODEL_PROVIDER=fake), from the attempt-gate
// spike: a pi-ai provider that answers from a script. Each response is chosen by the transcript alone (how
// many tool rounds follow the last user message), never by in-memory state, so a crash, a replay or a new
// isolate gets the same answer for the same transcript. Text, reasoning and tool arguments stream in chunks,
// optionally with a delay, and the stream honours its abort signal like a real provider.
//
// Never in the production Worker: its entry imports no module that reaches this one (test/unit/sources.test.ts,
// scripts/bundle.ts).
//
// The script comes from the run's prompt (the last user message) when that is JSON of the form
// `{"fake": FakeScript}`; any other prompt gets `{turns: [{text: "Done."}]}`. Tests may also pass a script
// function of their own.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type JsonObject,
	parseStreamingJson,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { type Json, parseJson } from "../lib/json.ts";
import { tokenHex } from "../lib/random.ts";
import type { Upstream } from "./route.ts";

export const FAKE_API = "minerva-fake";
export const FAKE_PROVIDER = "minerva-fake";
export const FAKE_MODEL_ID = "fake-1";

/** One model response. A turn with tools ends with `toolUse`, one without with `stop`. */
export interface FakeTurn {
	thinking?: string;
	text?: string;
	tools?: { name: string; arguments: JsonObject }[];
	/** Tool arguments sent as this raw text instead of their JSON, keyed by the tool's index in `tools`. */
	rawArguments?: { [index: string]: string };
	/** Fail this response with this provider error text; see `FakeOptions.fails`. */
	error?: { message: string; times?: number };
	/** Refuse the request with this HTTP status, as a provider's error answer: no stream, and no usage. */
	refused?: { status: number };
	/** Report this usage instead of about four characters a token; `null` reports none. */
	usage?: { input: number; output: number } | null;
}

export interface FakeScript {
	turns: FakeTurn[];
	/** Characters per delta; default 8. */
	chunkChars?: number;
	/** Wait before each delta, in milliseconds. */
	delayMs?: number;
}

/** What one call answers: `step` is the number of tool rounds after the last user message. */
export interface FakeCall {
	step: number;
	turn: FakeTurn;
	messages: number;
}

export interface FakeOptions {
	/** The script for a transcript; by default the prompt's `{"fake": …}`. */
	script?: (context: TranscriptContext) => FakeScript;
	/** Called when a request starts, before the first event. */
	onCall?: (call: FakeCall, context: TranscriptContext, options: SimpleStreamOptions | undefined) => void;
	/** Awaited after `onCall`, before the first event, where a provider's request would go out; may throw. */
	request?: (call: FakeCall, options: SimpleStreamOptions | undefined) => Promise<void>;
	/** Called before each delta; may throw or never settle, to inject faults. */
	onDelta?: (call: FakeCall, index: number) => void | Promise<void>;
	/** Called as the terminal event (`done` or `error`) is pushed. */
	onEnd?: (call: FakeCall) => void;
	/**
	 * Whether this call fails, for a turn with `error`: pi keeps failed responses out of the transcript, so
	 * how often a turn has failed is counted by the host. Default: always.
	 */
	fails?: (call: FakeCall) => boolean;
	/** What the model takes: text and images by default, as the default model does. */
	input?: Model<Api>["input"];
}

const FINAL: FakeTurn = { text: "Done." };
export const DEFAULT_SCRIPT: FakeScript = { turns: [FINAL] };

export function fakeModel(input: Model<Api>["input"] = ["text", "image"]): Model<Api> {
	return {
		id: FAKE_MODEL_ID,
		name: "Fake",
		api: FAKE_API,
		provider: FAKE_PROVIDER,
		baseUrl: "http://fake.invalid",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

/** The fake as the wrapper's upstream (model/route.ts `Upstream`), for the test build and the tests. */
export function fakeUpstream(options: FakeOptions = {}): Upstream {
	return { provider: fakeProvider(options), model: fakeModel(options.input), options: {} };
}

export function fakeProvider(options: FakeOptions = {}): Provider {
	const stream = (model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) =>
		respond(model, context, streamOptions, options);
	return createProvider({
		id: FAKE_PROVIDER,
		name: "Fake",
		auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
		models: [fakeModel(options.input)],
		api: { stream, streamSimple: stream },
	});
}

/** The text of a user message. */
function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The note a message with attachments ends with (history.ts `withFiles`), after the script. */
const ATTACHED_NOTE = "\n\n[The user attached ";

/** The script a prompt carries as `{"fake": …}` (before the note on a message's attachments), else the default. */
export function scriptOf(context: TranscriptContext): FakeScript {
	const last = [...context.messages].reverse().find((message) => message.role === "user");
	const text = userText(last);
	const noted = text.indexOf(ATTACHED_NOTE);
	let parsed: Json;
	try {
		parsed = parseJson(noted < 0 ? text : text.slice(0, noted));
	} catch {
		return DEFAULT_SCRIPT;
	}
	const script = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.fake : undefined;
	if (script === null || typeof script !== "object" || Array.isArray(script) || !Array.isArray(script.turns)) return DEFAULT_SCRIPT;
	return script as unknown as FakeScript;
}

/** Tool rounds after the last user message. */
export function stepOf(messages: readonly Message[]): number {
	let step = 0;
	for (const message of messages) {
		if (message.role === "user") step = 0;
		else if (message.role === "assistant" && message.stopReason === "toolUse") step++;
	}
	return step;
}

function respond(model: Model<Api>, context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined, options: FakeOptions): AssistantMessageEventStream {
	const signal = streamOptions?.signal;
	const out = createAssistantMessageEventStream();
	const script = (options.script ?? scriptOf)(context);
	const step = stepOf(context.messages);
	const turn = script.turns[step] ?? FINAL;
	const call: FakeCall = { step, turn, messages: context.messages.length };
	options.onCall?.(call, context, streamOptions);
	const failing = turn.error !== undefined && (options.fails?.(call) ?? true);
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(context.messages, turn),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const chunk = Math.max(1, script.chunkChars ?? 8);
	const delayMs = script.delayMs ?? 0;
	let deltas = 0;
	const tick = async () => {
		await options.onDelta?.(call, deltas++);
		if (delayMs > 0) await sleep(delayMs, signal);
		signal?.throwIfAborted();
	};
	const end = (stopReason: "stop" | "toolUse" | "error" | "aborted", errorMessage?: string) => {
		const final: AssistantMessage = { ...message, content: [...message.content], stopReason, ...(errorMessage ? { errorMessage } : {}) };
		options.onEnd?.(call);
		if (stopReason === "error" || stopReason === "aborted") out.push({ type: "error", reason: stopReason, error: final });
		else out.push({ type: "done", reason: stopReason, message: final });
		out.end(final);
	};
	queueMicrotask(async () => {
		try {
			signal?.throwIfAborted();
			await options.request?.(call, streamOptions);
			signal?.throwIfAborted();
			if (turn.refused) {
				await streamOptions?.onResponse?.({ status: turn.refused.status, headers: { "content-type": "application/json" } }, model);
				return end("error", `The provider refused the request with status ${turn.refused.status}.`);
			}
			out.push({ type: "start", partial: { ...message } });
			if (failing) return end("error", turn.error?.message);
			if (turn.thinking) {
				const index = message.content.push({ type: "thinking", thinking: "" }) - 1;
				out.push({ type: "thinking_start", contentIndex: index, partial: { ...message } });
				for (const piece of pieces(turn.thinking, chunk)) {
					await tick();
					const block = message.content[index] as { type: "thinking"; thinking: string };
					block.thinking += piece;
					out.push({ type: "thinking_delta", contentIndex: index, delta: piece, partial: { ...message } });
				}
				out.push({ type: "thinking_end", contentIndex: index, content: turn.thinking, partial: { ...message } });
			}
			if (turn.text) {
				const index = message.content.push({ type: "text", text: "" }) - 1;
				out.push({ type: "text_start", contentIndex: index, partial: { ...message } });
				for (const piece of pieces(turn.text, chunk)) {
					await tick();
					const block = message.content[index] as { type: "text"; text: string };
					block.text += piece;
					out.push({ type: "text_delta", contentIndex: index, delta: piece, partial: { ...message } });
				}
				out.push({ type: "text_end", contentIndex: index, content: turn.text, partial: { ...message } });
			}
			for (const [i, tool] of (turn.tools ?? []).entries()) {
				// Raw text is parsed as pi-ai's providers parse it (with JSON.parse, so with the runtime's escaped-key bug).
				const raw = turn.rawArguments?.[String(i)];
				const parsed = raw === undefined ? tool.arguments : (parseStreamingJson(raw) as JsonObject);
				const toolCall: ToolCall = { type: "toolCall", id: callId(step, i), name: tool.name, arguments: parsed };
				const index = message.content.push({ ...toolCall, arguments: {} }) - 1;
				out.push({ type: "toolcall_start", contentIndex: index, partial: { ...message } });
				for (const piece of pieces(raw ?? JSON.stringify(tool.arguments), chunk)) {
					await tick();
					out.push({ type: "toolcall_delta", contentIndex: index, delta: piece, partial: { ...message } });
				}
				message.content[index] = toolCall;
				out.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: { ...message } });
			}
			end(turn.tools?.length ? "toolUse" : "stop");
		} catch (error) {
			if (signal?.aborted) return end("aborted", "Request was aborted");
			end("error", error instanceof Error ? error.message : String(error));
		}
	});
	return out;
}

function pieces(text: string, size: number): string[] {
	const points = Array.from(text);
	const out: string[] = [];
	for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(""));
	return out.length > 0 ? out : [""];
}

/** Unique like a provider's: a regenerated response gets new ids. */
function callId(step: number, index: number): string {
	return `fc_${step}_${index}_${tokenHex(4)}`;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** About four characters a token, as providers count, unless the turn says otherwise. */
function usage(messages: readonly Message[], turn: FakeTurn): Usage {
	if (turn.usage === null) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST };
	const input = turn.usage?.input ?? Math.ceil(JSON.stringify(messages).length / 4);
	const output = turn.usage?.output ?? Math.ceil(((turn.thinking ?? "") + (turn.text ?? "") + JSON.stringify(turn.tools ?? [])).length / 4);
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: ZERO_COST };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
