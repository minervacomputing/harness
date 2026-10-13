// The stream tap's pure parts:
// text and reasoning collected into segments, flushed every 0.25 s per model call, provider text kept out
// of everything pi gets (a context overflow still classified as one), and usage read from the last report.

import { type AssistantMessage, type AssistantMessageEvent, isContextOverflow, type Usage } from "@earendil-works/pi-ai";

/** What streamed since the last flush, published as one `text_delta` or `reasoning_delta` per segment. */
export type Segment = [kind: "text" | "reasoning", text: string];

/** After each upstream event, the collected segments are published once this long has passed since the last flush. */
export const TEXT_FLUSH_MS = 250;

/** What users and the transcript see instead of a provider's own error text. */
export const PROVIDER_ERROR = "The model provider reported an error.";
/**
 * What a provider's context overflow becomes instead of its own text: our words, which pi-ai's
 * `isContextOverflow` still recognises (its "exceeds the context window" pattern, and none of its
 * not-an-overflow ones), so pi-durable compacts and asks again, as it would with the provider's text.
 */
export const CONTEXT_OVERFLOW = "The request exceeds the context window of the model.";
/** An abort's text: pi-ai's own, whatever the upstream put there. */
export const ABORTED = "Request was aborted";

/**
 * Text and reasoning of one model call, in arrival order, adjacent segments of a kind joined. A new
 * reasoning part (a different thinking block than the previous reasoning delta) is preceded by "\n\n",
 * as the Responses tap does for a new `(item_id, summary_index, content_index)`. pi-ai's Responses API
 * appends "\n\n" itself after every summary part, the last one included, so a delta of exactly "\n\n" is
 * held as a part break and written only when more reasoning follows: one summary in two parts publishes
 * "Looking at the list.\n\nThen the answer.", with no break at the end.
 */
export class DeltaBuffer {
	#segments: Segment[] = [];
	#part: number | undefined;
	#reasoned = false;
	#breakPending = false;

	text(delta: string): void {
		this.#add("text", delta);
	}

	reasoning(contentIndex: number, delta: string): void {
		if (!delta) return;
		if (delta === "\n\n") {
			if (this.#reasoned) this.#breakPending = true;
			return;
		}
		if (this.#part !== undefined && contentIndex !== this.#part) this.#breakPending = true;
		this.#part = contentIndex;
		if (this.#breakPending && this.#reasoned) this.#add("reasoning", "\n\n");
		this.#breakPending = false;
		this.#reasoned = true;
		this.#add("reasoning", delta);
	}

	/** The segments collected since the last call, in order. */
	take(): Segment[] {
		const segments = this.#segments;
		this.#segments = [];
		return segments;
	}

	#add(kind: Segment[0], text: string): void {
		if (!text) return;
		const last = this.#segments.at(-1);
		if (last && last[0] === kind) last[1] += text;
		else this.#segments.push([kind, text]);
	}
}

/**
 * A message as pi may keep it: no provider text in it, as the relay replaced the provider's before the
 * worker read it. pi stores the final message in its transcript, its error text in its records, and keeps
 * the latest partial; createAI copies a failure's text into `diagnostics` (and a fallback's earlier failures
 * into a successful message's), so every message is a copy without them. A terminal one keeps only what is
 * ours or pi-ai's (its content, usage and identity, not the provider's ids or raw stop reason), with its
 * text replaced: a context overflow, as pi-ai classifies the provider's text, by CONTEXT_OVERFLOW; any
 * other error by PROVIDER_ERROR; an abort by pi-ai's own words.
 */
export function screened(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") {
		const { diagnostics: _diagnostics, ...kept } = message;
		return kept;
	}
	const kept: AssistantMessage = {
		role: "assistant",
		content: message.content,
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: message.usage,
		stopReason: message.stopReason,
		errorMessage: message.stopReason === "aborted" ? ABORTED : isContextOverflow(message) ? CONTEXT_OVERFLOW : PROVIDER_ERROR,
		timestamp: message.timestamp,
	};
	if (message.durationMs !== undefined) kept.durationMs = message.durationMs;
	return kept;
}

/** An upstream event as pi gets it: every message it carries screened, the live partial as a copy. */
export function screenedEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "error") return { ...event, error: screened(event.error) };
	if (event.type === "done") return { ...event, message: screened(event.message) };
	return { ...event, partial: screened(event.partial) };
}

/** createAI's failure codes (CloudflareAIError's `code`): its own classification, never the provider's text. */
const FAILURE_CODES = new Set(["auth", "rate-limit", "not-found", "bad-request", "provider-error", "gateway-error", "unknown"]);
/** An error's class, as the code that threw it named it. */
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** A thrown value's class, when it is a plain identifier; never its message. */
export function errorClass(error: unknown): string | null {
	const name = error instanceof Error ? error.name : null;
	return name !== null && ERROR_CLASS.test(name) ? name : null;
}

/**
 * What the operator's log says of a failed call: whether it was a context overflow, its HTTP status, and,
 * from createAI's diagnostic, the error's class and createAI's code for it. Never the provider's text,
 * which can echo a request's credentials (an `Authorization` header) or an account's details.
 */
export function failureSummary(message: AssistantMessage, status: number | undefined): string {
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.error !== undefined);
	const reported = failure?.details?.status;
	const code = failure?.error?.code;
	const name = failure?.error?.name;
	const parts = [message.stopReason === "error" && isContextOverflow(message) ? "a context overflow" : "an error"];
	const known = status ?? (typeof reported === "number" ? reported : undefined);
	if (known !== undefined && Number.isInteger(known) && known >= 100 && known <= 599) parts.push(`status ${known}`);
	if (typeof name === "string" && ERROR_CLASS.test(name)) parts.push(name);
	if (typeof code === "string" && FAILURE_CODES.has(code)) parts.push(`code ${code}`);
	return `The model provider reported ${parts.join(", ")}.`;
}

/**
 * The tokens a call reported, or null when it settled without a usage report (an unmetered call).
 * The input is the provider's own count, cached tokens included, as the relay read `input_tokens` or
 * `prompt_tokens`: pi-ai reports cache reads and writes apart from `input`. pi's message always has a
 * usage, so a report of none in and none out cannot be told from no report, and counts as none.
 */
export function reportedUsage(usage: Usage | undefined): { input: number; output: number } | null {
	if (!usage) return null;
	const counts = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0];
	if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
	const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (input === 0 && usage.output === 0) return null;
	return { input, output: usage.output };
}
