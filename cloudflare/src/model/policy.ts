// What a model request may carry. The request is built by pi-ai from our own transcript, so
// these hold by construction; the wrapper still enforces them, as defence in depth now that the loop is
// trusted code: the instance's model, an output cap, `store: false`, text input only and function tools only.

import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRoute } from "./route.ts";

/** The output cap a request gets: the requested positive integer up to the instance's cap, else the cap. */
export function outputCap(requested: unknown, cap: number): number {
	if (typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0) return Math.min(requested, cap);
	return cap;
}

/** Why a request is refused before anything is sent (nothing is counted), or null. */
export function refusal(context: TranscriptContext): string | null {
	for (const message of context.messages) {
		if (!textOnly(message)) return "Only text can be sent to the model.";
		if (message.role === "system") {
			for (const tool of message.toolsAdded ?? []) {
				// A grammar makes OpenAI send a custom tool rather than a function tool.
				if (tool.constrainedSampling && tool.constrainedSampling.type === "grammar") return "Only function tools can be offered to the model.";
			}
		}
	}
	return null;
}

function textOnly(message: Message): boolean {
	if (message.role === "user" || message.role === "toolResult") {
		return typeof message.content === "string" || message.content.every((part) => part.type === "text");
	}
	return true;
}

/**
 * The compaction prompt pi-durable 1.1.0 sends (harness/compaction.js, not exported): its summary is not an
 * answer, so its text is not published as deltas. test/unit/model-provider.test.ts checks that
 * the installed pi-durable still sends it.
 */
export const COMPACTION_PROMPT_START = "You are a context summarization assistant.";

export function isCompaction(context: TranscriptContext): boolean {
	const first = context.messages[0];
	if (first?.role !== "system") return false;
	const text = typeof first.content === "string" ? first.content : first.content.map((part) => part.text).join("");
	return text.startsWith(COMPACTION_PROMPT_START);
}

type Payload = { [key: string]: unknown };

/** The OpenAI Responses fields never sent: stored state, server-side tools and identification. */
const RESPONSES_DROPPED = ["previous_response_id", "conversation", "background", "prompt", "service_tier", "user", "metadata"];
/** The Chat Completions fields never sent. */
const CHAT_DROPPED = ["user", "logit_bias", "priority", "audio", "max_tokens"];

/**
 * The payload as it leaves: the instance's model, the output cap and `store: false` forced, the fields in
 * CHAT_DROPPED removed, and a payload with a tool that is not a function refused (it throws, so the
 * call ends with an error). Workers AI's payload is the binding's chat body, which has no `model` or
 * `store`; Anthropic's has no `store`.
 */
export function forcePayload(route: ModelRoute, payload: unknown, cap: number): unknown {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const body: Payload = { ...(payload as Payload) };
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools as Payload[]) {
			const type = tool?.type;
			// Anthropic tools have no type; OpenAI's are "function".
			if (type !== undefined && type !== "function") throw new Error("Only function tools can be offered to the model.");
		}
	}
	switch (route.provider) {
		case "workers-ai":
		case "fake":
			body.max_tokens = outputCap(body.max_tokens, cap);
			return body;
		case "anthropic":
			body.model = route.name;
			body.max_tokens = outputCap(body.max_tokens, cap);
			return body;
		case "openai":
			body.model = route.name;
			body.store = false;
			if (route.api === "responses") {
				for (const key of RESPONSES_DROPPED) delete body[key];
				body.max_output_tokens = outputCap(body.max_output_tokens, cap);
				// Reasoning comes from configuration, never the client's, and with an effort its encrypted content
				// is replayed between tool calls. createAI writes `summary: "auto"` itself.
				delete body.reasoning;
				delete body.include;
				if (route.reasoningEffort) {
					body.reasoning = { effort: route.reasoningEffort, ...(route.reasoningSummary ? { summary: route.reasoningSummary } : {}) };
					body.include = ["reasoning.encrypted_content"];
				}
			} else {
				const requested = body.max_completion_tokens ?? body.max_tokens;
				for (const key of CHAT_DROPPED) delete body[key];
				body.max_completion_tokens = outputCap(requested, cap);
			}
			return body;
	}
}
