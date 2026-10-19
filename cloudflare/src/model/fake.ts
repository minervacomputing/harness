// A deterministic model for tests and a test deployment (MINERVA_MODEL_PROVIDER=fake), from the attempt-gate
// spike: a pi-ai provider that answers from a script. Each response is chosen by the transcript alone (how
// many tool rounds follow the last user message), never by in-memory state, so a crash, a replay or a new
// isolate gets the same answer for the same transcript. Text, reasoning and tool arguments stream in chunks,
// optionally with a delay, and the stream honours its abort signal like a real provider.
//
// Never in the production Worker: its entry imports no module that reaches this one (test/unit/sources.test.ts,
// scripts/bundle.ts).
//
// The script is the newest user message's last paragraph that is JSON of the form `{"fake": FakeScript}`, after
// any quote of earlier messages; any other message gets `{turns: [{text: "Done."}]}`. Tests may also pass a script
// function of their own. A compaction's summary request gets a summary of the fake's own, which carries the
// summarized run's script and its tool rounds, so a run whose message was summarized carries on with its script.

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
import { isCompaction } from "./policy.ts";
import type { Upstream } from "./route.ts";

export const FAKE_API = "minerva-fake";
export const FAKE_PROVIDER = "minerva-fake";
export const FAKE_MODEL_ID = "fake-1";

/** One model response. A turn with tools ends with `toolUse`, one without with `stop`. */
export interface FakeTurn {
	thinking?: string;
	text?: string;
	/** Answer with the first line holding this text in a message before the newest user message, or `Not found.` */
	recall?: string;
	/** This many filler characters after the text, to fill the context without a large message. */
	pad?: number;
	tools?: { name: string; arguments: JsonObject }[];
	/** Tool arguments sent as this raw text instead of their JSON, keyed by the tool's index in `tools`. */
	rawArguments?: { [index: string]: string };
	/** Fail this response with this provider error text; see `FakeOptions.fails`. */
	error?: { message: string; times?: number };
	/** Fail with FAKE_OVERFLOW until the context holds a summary. */
	overflowUntilCompacted?: true;
	/**
	 * Fail the next this many summary calls made before this turn's request, each with a provider error: the summary
	 * call's turn is an `error` with these `times`, so the host's `fails` counts them (`countedFails`).
	 */
	failSummaries?: number;
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
	/** A compaction's summary call, whose step is 0. */
	summary: boolean;
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
/** A provider's overflow text, which pi-ai's `isContextOverflow` recognises (OpenAI's). */
export const FAKE_OVERFLOW = "Your input exceeds the context window of this model.";
/** A summary's output tokens, so a test can find its call. */
export const SUMMARY_OUTPUT = 777;

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

/** How a script's paragraph starts: compact JSON has no raw newline, so a script is one paragraph. */
const SCRIPT_START = '{"fake":';
/** The paragraph that closes a quote of an earlier message (history.ts, the note after a stopped turn). */
const QUOTE_END = "[End of that message.";
/** How pi-durable 1.3.0 wraps a summary (harness/compaction.js, not exported): the user message a compaction leaves. */
export const SUMMARY_START = "The conversation history before this point was compacted into the following summary:";
const ROUNDS = /\[fake: (\d+) tool rounds done\]/;

/** The script paragraph of a message: its last paragraph that starts as a script, after the last quote of an earlier one. */
function scriptParagraph(text: string): string | undefined {
	const quoted = text.lastIndexOf(QUOTE_END);
	return (quoted < 0 ? text : text.slice(quoted)).split("\n\n").findLast((paragraph) => paragraph.startsWith(SCRIPT_START));
}

/** The script a message carries, else the default. */
function parseScript(paragraph: string | undefined): FakeScript {
	let parsed: Json;
	try {
		parsed = parseJson(paragraph ?? "");
	} catch {
		return DEFAULT_SCRIPT;
	}
	const script = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.fake : undefined;
	if (script === null || typeof script !== "object" || Array.isArray(script) || !Array.isArray(script.turns)) return DEFAULT_SCRIPT;
	return script as unknown as FakeScript;
}

/** The tool rounds a summary says its run had done, or null for a message that is not a summary. */
function summaryRounds(text: string): number | null {
	if (!text.startsWith(SUMMARY_START)) return null;
	return Number(text.match(ROUNDS)?.[1] ?? 0);
}

/** The script the newest user message carries (the run's own, or a summary's copy of it), else the default. */
export function scriptOf(context: TranscriptContext): FakeScript {
	return parseScript(scriptParagraph(userText(context.messages.findLast((message) => message.role === "user"))));
}

/** Tool rounds after the last user message, plus those a summary says were done before it. */
export function stepOf(messages: readonly Message[]): number {
	let step = 0;
	for (const message of messages) {
		if (message.role === "user") step = summaryRounds(userText(message)) ?? 0;
		else if (message.role === "assistant" && message.stopReason === "toolUse") step++;
	}
	return step;
}

/** A message's text: a user's, an assistant's answer or a tool's result. */
function textOf(message: Message): string {
	if (message.role === "user") return userText(message);
	if (message.role === "assistant" || message.role === "toolResult") return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	return "";
}

function recalled(messages: readonly Message[], wanted: string): string {
	const newest = messages.findLastIndex((message) => message.role === "user");
	for (const message of messages.slice(0, Math.max(newest, 0))) {
		const line = textOf(message)
			.split("\n")
			.find((candidate) => candidate.includes(wanted));
		if (line !== undefined) return line;
	}
	return "Not found.";
}

/** pi-durable's labels in the conversation it asks a summary of (harness/compaction.js `serializeConversation`). */
const USER = "[User]: ";
const TOOL_CALLS = "[Assistant tool calls]: ";
const TOOL_RESULT = "[Tool result]: ";
const LABELS = [USER, "[Assistant]: ", TOOL_CALLS, TOOL_RESULT];
const KEPT_CHARS = 300;

/** The conversation a summary request carries, as its labelled parts; a paragraph without a label continues the one before. */
function summarizedParts(context: TranscriptContext): string[] {
	const request = userText(context.messages.findLast((message) => message.role === "user"));
	const start = request.indexOf("<conversation>\n");
	const end = request.lastIndexOf("\n</conversation>");
	if (start < 0 || end < start) return [];
	const parts: string[] = [];
	for (const paragraph of request.slice(start + "<conversation>\n".length, end).split("\n\n")) {
		if (parts.length > 0 && !LABELS.some((label) => paragraph.startsWith(label))) parts[parts.length - 1] += `\n\n${paragraph}`;
		else parts.push(paragraph);
	}
	return parts;
}

/**
 * The fake's summary under pi's headings. Its critical context keeps each user and tool result line, clipped, and the lines
 * an earlier summary kept; then the newest user line's script and the tool rounds done since it, which `scriptOf` and
 * `stepOf` read back. A script that asks for failed summaries gets that error too, which the host's `fails` decides.
 */
function summaryTurn(context: TranscriptContext): FakeTurn {
	const parts = summarizedParts(context);
	const kept: string[] = [];
	for (const part of parts) {
		const earlier = part.startsWith(USER) && summaryRounds(part.slice(USER.length)) !== null;
		if (earlier) kept.push(...part.split("\n").filter((line) => line.startsWith(`- ${USER}`) || line.startsWith(`- ${TOOL_RESULT}`)));
		else if (part.startsWith(USER) || part.startsWith(TOOL_RESULT)) kept.push(`- ${part.replace(/\s+/g, " ").slice(0, KEPT_CHARS)}`);
	}
	const newest = parts.findLastIndex((part) => part.startsWith(USER));
	const user = newest < 0 ? "" : (parts[newest] as string).slice(USER.length);
	const rounds = (summaryRounds(user) ?? 0) + parts.slice(newest + 1).filter((part) => part.startsWith(TOOL_CALLS)).length;
	const script = scriptParagraph(user);
	const failures = parseScript(script)
		.turns.slice(rounds)
		.find((turn) => turn.failSummaries)?.failSummaries;
	const text = [
		"## Goal\nCarry on with the conversation.",
		"## Constraints & Preferences\n- (none)",
		"## Progress\n### Done\n- [x] The turns summarized here.",
		"## Key Decisions\n- (none)",
		"## Next Steps\n1. Answer the newest message.",
		`## Critical Context\n${kept.length ? kept.join("\n") : "- (none)"}`,
		...(script ? [script] : []),
		`[fake: ${rounds} tool rounds done]`,
	].join("\n\n");
	const summary: FakeTurn = { text, usage: { input: inputTokens(context.messages), output: SUMMARY_OUTPUT } };
	// Once the host says its failures are spent, the turn answers its summary.
	return failures ? { ...summary, error: { message: "The fake model could not summarize.", times: failures } } : summary;
}

/** A turn's text: its own or what it recalls, then its padding. */
function answerOf(turn: FakeTurn, messages: readonly Message[]): string {
	const text = turn.recall === undefined ? (turn.text ?? "") : recalled(messages, turn.recall);
	return turn.pad ? text + "x".repeat(turn.pad) : text;
}

/** A host's `fails` that counts each error turn's failures, by its JSON: it fails `times` times, or always without. */
export function countedFails(): (call: FakeCall) => boolean {
	const failed = new Map<string, number>();
	return (call) => {
		const key = JSON.stringify(call.turn);
		const count = failed.get(key) ?? 0;
		failed.set(key, count + 1);
		return count < (call.turn.error?.times ?? Number.POSITIVE_INFINITY);
	};
}

function respond(model: Model<Api>, context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined, options: FakeOptions): AssistantMessageEventStream {
	const signal = streamOptions?.signal;
	const out = createAssistantMessageEventStream();
	const summary = isCompaction(context);
	// A summary streams in one delta.
	const script: FakeScript = summary ? { turns: [summaryTurn(context)], chunkChars: Number.MAX_SAFE_INTEGER } : (options.script ?? scriptOf)(context);
	const step = summary ? 0 : stepOf(context.messages);
	const turn = script.turns[step] ?? FINAL;
	const call: FakeCall = { step, turn, messages: context.messages.length, summary };
	options.onCall?.(call, context, streamOptions);
	const overflow = turn.overflowUntilCompacted === true && !context.messages.some((message) => message.role === "user" && summaryRounds(userText(message)) !== null);
	const failing = overflow || (turn.error !== undefined && (options.fails?.(call) ?? true));
	const text = answerOf(turn, context.messages);
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(context.messages, turn, text),
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
			if (failing) return end("error", overflow ? FAKE_OVERFLOW : turn.error?.message);
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
			if (text) {
				const index = message.content.push({ type: "text", text: "" }) - 1;
				out.push({ type: "text_start", contentIndex: index, partial: { ...message } });
				for (const piece of pieces(text, chunk)) {
					await tick();
					const block = message.content[index] as { type: "text"; text: string };
					block.text += piece;
					out.push({ type: "text_delta", contentIndex: index, delta: piece, partial: { ...message } });
				}
				out.push({ type: "text_end", contentIndex: index, content: text, partial: { ...message } });
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

function inputTokens(messages: readonly Message[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

/** About four characters a token, as providers count, unless the turn says otherwise. */
function usage(messages: readonly Message[], turn: FakeTurn, text: string): Usage {
	if (turn.usage === null) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST };
	const input = turn.usage?.input ?? inputTokens(messages);
	const output = turn.usage?.output ?? Math.ceil(((turn.thinking ?? "") + text + JSON.stringify(turn.tools ?? [])).length / 4);
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
