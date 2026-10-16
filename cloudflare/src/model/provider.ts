// The model wrapper (ARCHITECTURE.md: The harness, Model): the one pi-ai provider pi is opened with. pi stores a
// session's model as `minerva/default` (the alias is always `default`) and resolves it at each
// request, so every call, compaction's included, comes through here. For each request the wrapper:
//
// - finds the run it belongs to by pi's provider session id, and refuses it ("This run has ended.", counted
//   nothing) unless that run's current attempt can act: the backstop to the attempt gate's stop;
// - refuses anything but text input and function tools, before anything is counted;
// - records the call before the provider is asked (`ModelHost.record`: once per request, fenced, counted in
//   `model_calls`, never limited), which names it with its 8-hex id;
// - forces the route's model, the output cap and `store: false` on the payload, and adds the route's
//   reasoning settings;
// - asks once more without the reasoning summary when the provider refuses it, and then never asks for one
//   again in this isolate;
// - aborts the upstream request when the run stops, is revoked, passes its deadline or is replaced, and
//   ends a call whose answer has not started within 120 s, or whose answer that is not an event stream
//   has not been read within 120 s more, as an error;
// - taps the stream: text and reasoning published every 0.25 s per call with the call's id (not for a
//   compaction's summary), and tool-call argument text kept as the model sent it;
// - settles the call (`ModelHost.settle`, attempt or not) after the upstream's terminal event and before pi
//   gets it (`outcomeOf`): reported with its last usage report, refused at nothing for a 4xx without an
//   answer, or unmetered at its reservation; a settlement that fails holds the answer for good;
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
import { utf8 } from "../lib/bytes.ts";
import type { AttemptFence } from "../shared/rpc.ts";
import { forcePayload, forModel, isCompaction, outputCap, refusal, reservation } from "./policy.ts";
import { CONTEXT_WINDOW, type ModelRoute, QUIET_MS, type Upstream } from "./route.ts";
import { DeltaBuffer, errorClass, failureSummary, PROVIDER_ERROR, reportedUsage, type Segment, screened, screenedEvent, TEXT_FLUSH_MS, type Tokens } from "./tap.ts";

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
	/**
	 * Records and counts a call about to be sent, in one change with the fence check, outside pi's transactions: the
	 * call's id (8 hex, unique within its run), or null when the attempt can no longer act, or the run's spend reached its
	 * allowance, which ends the run, with nothing recorded.
	 */
	record(fence: AttemptFence, request: CallRequest): Promise<string | null>;
	/** Whether the attempt can still act, checked again before a request is sent a second time. */
	current(fence: AttemptFence): boolean;
	/** Fenced: dropped once the attempt is replaced or the run ended. */
	deltas(fence: AttemptFence, call: string, segments: Segment[]): void;
	/** A tool call's argument text, as the model sent it, when its call ends. */
	toolCallText(fence: AttemptFence, callId: string, text: string): void;
	/**
	 * Settles a recorded call once, outside pi's transactions, before pi hears its answer. Not fenced: a call is settled
	 * whichever attempt made it. A rejection holds the answer for good: the host resets the object.
	 */
	settle(fence: AttemptFence, call: string, settlement: CallSettlement): Promise<void>;
	/** For operators' logs only. */
	log(message: string): void;
}

/** What a call is recorded with before its request is sent. */
export interface CallRequest {
	/** The route's provider. */
	provider: string;
	/** The upstream model. */
	model: string;
	/** What the call is counted at if it settles unmetered (policy.ts `reservation`). */
	reserved: { input: number; output: number };
}

/**
 * How a counted call ended (docs/plans/chunk-14a-design.md, Settlement states). `lost` is the restart rule's: a call another
 * instance recorded and never settled (store.ts `settleLost`).
 */
export type CallOutcome = { outcome: "reported"; tokens: Tokens } | { outcome: "refused" } | { outcome: "unmetered"; cause: "no_usage" | "stopped" | "failed" | "lost" };

/** A call's outcome, with the UTF-8 length of the last request it built, null when it built none. */
export type CallSettlement = CallOutcome & { requestBytes: number | null };

/**
 * The settlement table, from what the wrapper saw: an answer (a stream, or a 200) settles with its usage report, or
 * unmetered without one; a refusal (a 4xx and no answer) costs nothing; any other status, or none, is unmetered,
 * `stopped` when the run or pi stopped it.
 */
function outcomeOf(seen: { answered: boolean; tokens: Tokens | null; status: number | undefined; stopped: boolean }): CallOutcome {
	if (seen.answered) return seen.tokens === null ? { outcome: "unmetered", cause: "no_usage" } : { outcome: "reported", tokens: seen.tokens };
	if (seen.status !== undefined) return seen.status >= 400 && seen.status <= 499 ? { outcome: "refused" } : { outcome: "unmetered", cause: "failed" };
	return { outcome: "unmetered", cause: seen.stopped ? "stopped" : "failed" };
}

/**
 * The largest image, in bytes of base64, the model is given. pi keeps a tool's result in one transcript row, and
 * a Durable Object's SQLite row holds at most 2 MB (local workerd does not enforce it): a larger image would fail
 * the storage write, and with it the conversation's pi Session.
 */
export const IMAGE_MAX_BYTES = 1536 * 1024;
/** The largest image, in pixels a side, the model is given: pi's default. */
const IMAGE_MAX_SIDE = 2000;

/**
 * The model pi sees: `minerva/default`, with CONTEXT_WINDOW and the route's cap, taking images when the
 * upstream does (`input`, the upstream model's), within IMAGE_MAX_BYTES.
 */
export function minervaModel(route: ModelRoute, input: Model<Api>["input"] = ["text"]): Model<Api> {
	return {
		id: MODEL_ALIAS,
		name: MODEL_ALIAS,
		api: MINERVA_API,
		provider: MINERVA_PROVIDER,
		baseUrl: "",
		// The route adds reasoning settings itself, so pi sends none.
		reasoning: false,
		input,
		inputLimits: { images: { resize: { maxWidth: IMAGE_MAX_SIDE, maxHeight: IMAGE_MAX_SIDE, maxBytes: IMAGE_MAX_BYTES } } },
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
	let input: Model<Api>["input"] | undefined;
	try {
		input = cached.upstream(route).model.input;
	} catch {
		// The model is not available; each call says so.
	}
	return createProvider({
		id: MINERVA_PROVIDER,
		name: "Minerva",
		auth: { apiKey: { name: "Minerva", resolve: async () => ({ auth: {} }) } },
		models: [minervaModel(route, input)],
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
	queueMicrotask(() => endWith(out, failed(text, model)));
	return out;
}

/** Ends a stream with an error pi gets as is. */
function endWith(out: AssistantMessageEventStream, message: AssistantMessage): void {
	out.push({ type: "error", reason: "error", error: message });
	out.end(message);
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
	const now = options.now ?? (() => performance.now());
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
	/** The UTF-8 length of the last payload built, as it leaves; null until one is (the fake builds none). */
	let requestBytes: number | null = null;
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
				const leaving = forcePayload(forced, changed, cap);
				requestBytes = utf8(JSON.stringify(leaving) ?? "").byteLength;
				return leaving;
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
	(async () => {
		let recorded: string | null;
		try {
			recorded = await options.host.record(fence, { provider: route.provider, model: upstream.model.id, reserved: reservation(cap) });
		} catch (error) {
			options.host.log(`A model call could not be recorded (${errorClass(error) ?? "an error"}).`);
			return endWith(out, failed(PROVIDER_ERROR, self));
		}
		// Not recorded and not counted, as a call `begin` refused.
		if (recorded === null) return endWith(out, failed(RUN_ENDED_TEXT, self));
		const call = recorded;
		let lastFlush = now();
		const flush = () => {
			if (!publish) return;
			const segments = buffer.take();
			if (segments.length) options.host.deltas(fence, call, segments);
		};
		let final: AssistantMessage | undefined;
		/** The upstream's terminal event (`done` or `error`) as pi gets it, held until the call is settled. */
		let terminal: AssistantMessageEvent | undefined;
		/** The upstream answered with a stream. */
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
				const events = upstream.provider.streamSimple(upstream.model, forModel(context, upstream.model), request(summary));
				return { events, iterator: events[Symbol.asyncIterator]() };
			};
			let summary = asksSummary(route) && !REASONING_SUMMARY.refused;
			let { events, iterator } = send(summary);
			let next = await nextOf(iterator);
			if (summary && !next.done && summaryRefused(next.value, status)) {
				// Asked once more without the summary; if that is taken, the summary was the problem.
				// The same call and record: if the run ended meanwhile, it settles as the refusal it got.
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
				// pi's result is the terminal event's message, so the call is named there.
				if (relayedEvent.type === "done") terminal = { ...relayedEvent, message: withCall(relayedEvent.message, call) };
				else if (relayedEvent.type === "error") terminal = relayedEvent;
				else out.push(relayedEvent);
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
			terminal = { type: "error", reason: final.stopReason as "error" | "aborted", error: final };
		} finally {
			clearTimeout(quietTimer);
		}
		try {
			flush();
		} catch (error) {
			// Only progress: the call settles all the same.
			options.host.log(`A model call's last text could not be published (${errorClass(error) ?? "an error"}).`);
		}
		const answered = streamed || status === 200;
		const outcome = outcomeOf({ answered, tokens: answered ? reportedUsage(final.usage) : null, status, stopped: stops.some((signal) => signal.aborted) });
		try {
			await options.host.settle(fence, call, { ...outcome, requestBytes });
		} catch (error) {
			options.host.log(`A model call could not be settled (${errorClass(error) ?? "an error"}); its answer is held.`);
			return;
		}
		if (terminal) out.push(terminal);
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
