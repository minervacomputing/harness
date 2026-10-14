// The model wrapper (ARCHITECTURE.md: The harness, Model): the one pi-ai provider pi is opened with. pi stores a
// session's model as `minerva/default` (the alias is always `default`) and resolves it at each
// request, so every call, compaction's included, comes through here. For each request the wrapper:
//
// - finds the run it belongs to by pi's provider session id, and refuses it ("This run has ended.", counted
//   nothing) unless that run's current attempt can act: the backstop to the attempt gate's stop;
// - refuses anything but text input and function tools, before anything is counted;
// - counts the call (`model_calls`, once per request, before the provider is asked; never limited);
// - forces the route's model, the output cap and `store: false` on the payload, and adds the route's
//   reasoning settings;
// - asks once more without the reasoning summary when the provider refuses it, and then never asks for one
//   again in this isolate;
// - aborts the upstream request when the run stops, is revoked, passes its deadline or is replaced, and
//   ends a call whose answer has not started within 120 s, or whose answer that is not an event stream
//   has not been read within 120 s more, as an error;
// - taps the stream: text and reasoning published every 0.25 s per call with the call's 8-hex id (not for
//   a compaction's summary), tool-call argument text kept as the model sent it, and when the call settles
//   (attempt or not) the last usage report recorded, or the call counted unmetered if it streamed without
//   one or was stopped; a call the provider refused or that never reached it is neither;
// - names the call in the message it finished with (`callOf`), so the run's `message` event can say which
//   call's text the answer replaces;
// - keeps provider text out of everything pi gets (tap.ts `screened`): a failure's text is replaced with
//   "The model provider reported an error.", or for a context overflow with words pi-ai still classifies as
//   one, so pi compacts and asks again; createAI's diagnostics, which copy that text, are dropped from every
//   message; the operator's log gets the failure's kind, status, class and createAI's code, never its text.
//
// pi-ai parses tool-call arguments with `JSON.parse` (utils/json-parse.ts `parseStreamingJson`, through
// `parseJsonWithRepair`, falling back to partial-json; agents' createAI does the same), which has the
// runtime's escaped-key bug (lib/json.ts). The raw argument text is only in the stream's `toolcall_delta`
// events. So the tap reads it again with `parseJson` and puts those arguments in the `toolcall_end` event and
// the final message, before pi validates or stores the call, and hands the text to the host by call id
// (`toolCallText`), so a read replayed after a restart can read it again too (conversation/tools.ts). What
// remains exposed: pi reads its own stored rows with `JSON.parse`, so a call replayed from storage in an
// isolate that already parsed a "\\" key may get a misread key back before our tool sees it.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { parseJson } from "../lib/json.ts";
import { tokenHex } from "../lib/random.ts";
import type { AttemptFence } from "../shared/rpc.ts";
import { forcePayload, isCompaction, outputCap, refusal } from "./policy.ts";
import { CONTEXT_WINDOW, type ModelRoute, QUIET_MS, type Upstream } from "./route.ts";
import { DeltaBuffer, errorClass, failureSummary, PROVIDER_ERROR, reportedUsage, type Segment, screened, screenedEvent, TEXT_FLUSH_MS } from "./tap.ts";

export const MINERVA_PROVIDER = "minerva";
export const MINERVA_API = "minerva";
/** The model alias every run uses. */
export const MODEL_ALIAS = "default";
/** How pi refers to the model, in every session it stores. */
export const MODEL_REF = { provider: MINERVA_PROVIDER, modelId: MODEL_ALIAS } as const;

/** The error a model call of a run that is not current ends with. */
export const RUN_ENDED_TEXT = "This run has ended.";
/** For the operator, once per isolate, when the provider took a request without the summary it refused. */
export const SUMMARY_REFUSED_HINT = "The model provider refused a reasoning summary; set MINERVA_MODEL_REASONING_SUMMARY empty";

/**
 * Set once the provider refused a reasoning summary and then took the request without one (OpenAI asks
 * some organizations to verify first): later calls ask for none. Per isolate; tests
 * reset it.
 */
export const REASONING_SUMMARY = { refused: false };

/** What the wrapper needs from the run that makes a call. */
export interface ModelHost {
	/**
	 * The run and attempt this request is for, by pi's provider session id, and a signal that aborts when
	 * that attempt can no longer act; null when no current attempt owns the session.
	 */
	begin(sessionId: string | undefined): { fence: AttemptFence; signal: AbortSignal } | null;
	/** `model_calls += 1`, for a request that is about to be sent. */
	counted(fence: AttemptFence): void;
	/** Whether the attempt can still act, checked again before a request is sent a second time. */
	current(fence: AttemptFence): boolean;
	/** Fenced: dropped once the attempt is replaced or the run ended. */
	deltas(fence: AttemptFence, call: string, segments: Segment[]): void;
	/** A tool call's argument text, as the model sent it, when its call ends. */
	toolCallText(fence: AttemptFence, callId: string, text: string): void;
	/**
	 * Not fenced: a call is metered whichever attempt made it; null counts it unmetered.
	 * Not called for a call the provider refused or that never reached it.
	 */
	settled(fence: AttemptFence, usage: ModelUsage | null): void;
	/** For operators' logs only. */
	log(message: string): void;
}

/** A metered call's usage: its id (as its deltas name it), the upstream model, and its tokens (tap.ts `reportedUsage`). */
export interface ModelUsage {
	call: string;
	model: string;
	/** Input with cache reads and writes. */
	input: number;
	output: number;
	/** Cache reads. */
	cached: number;
	/** The part of `output` spent reasoning; 0 when the provider does not say. */
	reasoning: number;
}

/** The model pi sees: `minerva/default`, text only, with CONTEXT_WINDOW and the route's cap. */
export function minervaModel(route: ModelRoute): Model<Api> {
	return {
		id: MODEL_ALIAS,
		name: MODEL_ALIAS,
		api: MINERVA_API,
		provider: MINERVA_PROVIDER,
		baseUrl: "",
		// The route adds reasoning settings itself, so pi sends none.
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: route.cap,
	};
}

export interface WrapperOptions {
	/** Read at each call: the settings in force then. */
	route: () => ModelRoute;
	upstream: (route: ModelRoute) => Upstream;
	host: ModelHost;
	now?: () => number;
	/** How long the answer may take to start; QUIET_MS by default. */
	quietMs?: number;
}

/** The provider `minerva`, for `models.setProvider` in the harness factory. */
export function minervaProvider(options: WrapperOptions): Provider {
	// createAI builds its model catalogue when it is made, so an upstream is made once per route.
	const upstreams = new Map<string, Upstream>();
	const cached: WrapperOptions = {
		...options,
		upstream: (route) => {
			const key = JSON.stringify(route);
			let upstream = upstreams.get(key);
			if (!upstream) upstreams.set(key, (upstream = options.upstream(route)));
			return upstream;
		},
	};
	const stream = (_model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) =>
		wrapped(context, streamOptions, cached);
	const route = options.route();
	return createProvider({
		id: MINERVA_PROVIDER,
		name: "Minerva",
		auth: { apiKey: { name: "Minerva", resolve: async () => ({ auth: {} }) } },
		models: [minervaModel(route)],
		api: { stream, streamSimple: stream },
	});
}

/** A terminal error message, for a call refused before it was sent. */
function failed(text: string, model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	};
}

function refuse(text: string, model: Model<Api>): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const message = failed(text, model);
	queueMicrotask(() => {
		out.push({ type: "error", reason: "error", error: message });
		out.end(message);
	});
	return out;
}

/** Whether a request asks for a reasoning summary: the Responses API, with an effort and a summary set. */
function asksSummary(route: ModelRoute): boolean {
	return route.provider === "openai" && route.api === "responses" && route.reasoningEffort !== "" && route.reasoningSummary !== "";
}

/**
 * Whether the provider refused the reasoning summary: a 400 whose error mentions the summary. createAI
 * reads the provider's error message from its body (OpenAI's `error.message`).
 */
function summaryRefused(event: AssistantMessageEvent, status: number | undefined): boolean {
	return event.type === "error" && event.reason === "error" && status === 400 && (event.error.errorMessage ?? "").toLowerCase().includes("summar");
}

function wrapped(context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined, options: WrapperOptions): AssistantMessageEventStream {
	const route = options.route();
	const self = minervaModel(route);
	const begun = options.host.begin(streamOptions?.sessionId);
	if (begun === null) return refuse(RUN_ENDED_TEXT, self);
	const refused = refusal(context);
	if (refused !== null) return refuse(refused, self);
	const { fence } = begun;
	let upstream: Upstream;
	try {
		upstream = options.upstream(route);
	} catch (error) {
		options.host.log(`The model is not available: ${error instanceof Error ? error.message : String(error)}`);
		return refuse("The model is not available.", self);
	}
	options.host.counted(fence);
	const now = options.now ?? (() => performance.now());
	const call = tokenHex(4);
	const publish = !isCompaction(context);
	/** The run's and pi's: either stopping the call counts it unmetered. */
	const stops = [begun.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])];
	/** Aborts a request whose answer did not start in time. */
	const quiet = new AbortController();
	const cap = outputCap(streamOptions?.maxTokens, route.cap);
	const callerPayload = streamOptions?.onPayload;
	const callerResponse = streamOptions?.onResponse;
	/** The HTTP status of the request just sent, when the upstream reports one. */
	let status: number | undefined;
	/**
	 * Whether createAI reads the answer whole once it started: a chat-completions route (Workers AI, OpenAI's
	 * chat) whose answer, by createAI's own test of its headers, is not an event stream. Every other answer
	 * is read as a stream, which createAI times between chunks itself.
	 */
	let readsWhole = false;
	const chatRoute = route.provider === "workers-ai" || (route.provider === "openai" && route.api === "chat");
	const request = (summary: boolean): SimpleStreamOptions => {
		const forced = summary ? route : { ...route, reasoningSummary: "" };
		return {
			...streamOptions,
			...upstream.options,
			maxTokens: cap,
			signal: AbortSignal.any([...stops, quiet.signal]),
			onPayload: async (payload, model) => {
				const changed = (await callerPayload?.(payload, model)) ?? payload;
				return forcePayload(forced, changed, cap);
			},
			onResponse: async (response, model) => {
				status = response.status;
				readsWhole = chatRoute && !(response.headers["content-type"] ?? "").includes("text/event-stream");
				await callerResponse?.(response, model);
			},
		};
	};
	const out = createAssistantMessageEventStream();
	const buffer = new DeltaBuffer();
	const argumentText = new Map<number, string>();
	/** Tool calls whose arguments were read again from the model's text, by call id. */
	const reparsed = new Map<string, JsonObject>();
	let lastFlush = now();
	const flush = () => {
		if (!publish) return;
		const segments = buffer.take();
		if (segments.length) options.host.deltas(fence, call, segments);
	};
	(async () => {
		let final: AssistantMessage | undefined;
		/** The upstream answered with a stream, so the call settles, metered or not. */
		let streamed = false;
		/** The run could not act any more when the request was to be sent again. */
		let runEnded = false;
		const quietMs = options.quietMs ?? QUIET_MS;
		let quietTimer: ReturnType<typeof setTimeout> | undefined;
		const timeQuiet = () => {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(() => quiet.abort(new Error("The model provider did not answer in time.")), quietMs);
		};
		const timedOut = () => quiet.signal.aborted && !stops.some((signal) => signal.aborted);
		// The wait ends when the time is up, whether or not the upstream stops on its abort.
		const quietEnded = new Promise<never>((_, reject) => quiet.signal.addEventListener("abort", () => reject(quiet.signal.reason), { once: true }));
		quietEnded.catch(() => {});
		const nextOf = <T>(iterator: AsyncIterator<T>) => Promise.race([iterator.next(), quietEnded]);
		try {
			const send = (summary: boolean) => {
				status = undefined;
				readsWhole = false;
				timeQuiet();
				const events = upstream.provider.streamSimple(upstream.model, context, request(summary));
				return { events, iterator: events[Symbol.asyncIterator]() };
			};
			let summary = asksSummary(route) && !REASONING_SUMMARY.refused;
			let { events, iterator } = send(summary);
			let next = await nextOf(iterator);
			if (summary && !next.done && summaryRefused(next.value, status)) {
				// Asked once more without the summary; if that is taken, the summary was the problem.
				// The same call: not counted again, and the refused request was neither metered nor not.
				if (!options.host.current(fence) || stops.some((signal) => signal.aborted)) {
					runEnded = true;
					throw new Error(RUN_ENDED_TEXT);
				}
				summary = false;
				({ events, iterator } = send(false));
				next = await nextOf(iterator);
				if (!next.done && next.value.type !== "error" && !REASONING_SUMMARY.refused) {
					REASONING_SUMMARY.refused = true;
					options.host.log(SUMMARY_REFUSED_HINT);
				}
			}
			clearTimeout(quietTimer);
			// createAI times an event stream's chunks itself, but reads an answer that is not one whole after
			// `start`, with no deadline: that read is timed until the next event, as the relay timed every read.
			let readingWhole = !next.done && next.value.type === "start" && readsWhole;
			if (readingWhole) timeQuiet();
			for (; !next.done; next = await nextOf(iterator)) {
				let event = next.value;
				if (readingWhole && event.type !== "start") {
					clearTimeout(quietTimer);
					readingWhole = false;
				}
				if (event.type === "start") streamed = true;
				else if (event.type === "text_delta") buffer.text(event.delta);
				else if (event.type === "thinking_delta") buffer.reasoning(event.contentIndex, event.delta);
				else if (event.type === "toolcall_delta") argumentText.set(event.contentIndex, (argumentText.get(event.contentIndex) ?? "") + event.delta);
				else if (event.type === "toolcall_end") {
					const text = argumentText.get(event.contentIndex);
					if (text !== undefined) {
						options.host.toolCallText(fence, event.toolCall.id, text);
						const fixed = reparse(text);
						if (fixed) {
							reparsed.set(event.toolCall.id, fixed);
							event = { ...event, toolCall: { ...event.toolCall, arguments: fixed } };
						}
					}
				} else if (event.type === "done") event = { ...event, message: withArguments(event.message, reparsed) };
				else if (event.type === "error" && timedOut()) {
					// Not the run's stop: the provider was quiet too long, which ends the call as an error, as the
					// relay's read timeout did.
					options.host.log(`The model provider did not answer within ${Math.round(quietMs / 1000)} s.`);
					event = { type: "error", reason: "error", error: { ...event.error, stopReason: "error", errorMessage: PROVIDER_ERROR } };
				}
				const relayedEvent = relayed(event, options.host, status);
				// pi's result is the `done` event's message, so the call is named there.
				out.push(relayedEvent.type === "done" ? { ...relayedEvent, message: withCall(relayedEvent.message, call) } : relayedEvent);
				if (now() - lastFlush > TEXT_FLUSH_MS) {
					lastFlush = now();
					flush();
				}
			}
			final = withArguments(await events.result(), reparsed);
			if (timedOut() && final.stopReason === "aborted") final = { ...final, stopReason: "error", errorMessage: PROVIDER_ERROR };
		} catch (error) {
			const stopped = stops.some((signal) => signal.aborted);
			if (timedOut()) options.host.log(`The model provider did not answer within ${Math.round(quietMs / 1000)} s.`);
			else if (!stopped && !runEnded) options.host.log(`The model stream failed (${[errorClass(error) ?? "an error", ...(status === undefined ? [] : [`status ${status}`])].join(", ")}).`);
			const text = runEnded ? RUN_ENDED_TEXT : stopped ? "Request was aborted" : PROVIDER_ERROR;
			final = { ...failed(text, upstream.model), stopReason: stopped ? "aborted" : "error" };
			out.push({ type: "error", reason: final.stopReason as "error" | "aborted", error: final });
		} finally {
			clearTimeout(quietTimer);
		}
		flush();
		// Settled once the provider accepted the request (a 200, a stream or not: one with no body is
		// unmetered), or when the run or pi stopped the call before any answer came; a call the provider
		// refused, or that never reached it, is counted but neither metered nor unmetered.
		const accepted = streamed || status === 200;
		if (accepted) {
			const usage = reportedUsage(final.usage);
			options.host.settled(fence, usage === null ? null : { call, model: upstream.model.id, ...usage });
		}
		else if (!runEnded && status === undefined && stops.some((signal) => signal.aborted)) options.host.settled(fence, null);
		// "This run has ended." is ours, as for a call refused before it was counted.
		out.end(runEnded ? final : screened(final));
	})();
	return out;
}

/**
 * A tool call's arguments read again with `parseJson`, when its text could hold an escaped key (one with a
 * backslash) and is a JSON object; otherwise pi-ai's parse stands (it also repairs malformed text, which
 * `parseJson` refuses). Doing it here, before pi validates and stores the call, means pi's validation and
 * transcript see the keys the model wrote.
 */
function reparse(text: string): JsonObject | undefined {
	if (!text.includes("\\")) return undefined;
	try {
		const value = parseJson(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

/** The message with the re-read arguments in its tool calls. */
function withArguments(message: AssistantMessage, reparsed: ReadonlyMap<string, JsonObject>): AssistantMessage {
	if (!reparsed.size) return message;
	return {
		...message,
		content: message.content.map((block) => (block.type === "toolCall" && reparsed.has(block.id) ? { ...block, arguments: reparsed.get(block.id) as JsonObject } : block)),
	};
}

/** The diagnostic that names the call that wrote a message: the 8-hex id its deltas were published with. */
const CALL_DIAGNOSTIC = "minerva.call";

/** A screened message with its call named, in `diagnostics`, which pi-ai keeps wherever it copies a message. */
function withCall(message: AssistantMessage, call: string): AssistantMessage {
	return { ...message, diagnostics: [...(message.diagnostics ?? []), { type: CALL_DIAGNOSTIC, timestamp: message.timestamp, details: { call } }] };
}

/** The model call that wrote a message pi stored, when the wrapper named it. */
export function callOf(message: AssistantMessage): string | undefined {
	const call = message.diagnostics?.find((diagnostic) => diagnostic.type === CALL_DIAGNOSTIC)?.details?.call;
	return typeof call === "string" ? call : undefined;
}

/** An upstream event as pi gets it (tap.ts `screenedEvent`); a failure is logged without the provider's text. */
function relayed(event: AssistantMessageEvent, host: ModelHost, status: number | undefined): AssistantMessageEvent {
	if (event.type === "error" && event.reason === "error") host.log(failureSummary(event.error, status));
	return screenedEvent(event);
}
