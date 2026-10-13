// What a tool call shows: the result as the model sees it, the `tool_call` event the chat folds into
// cards, and how a result becomes the model's content. The text the model reads is the result's JSON, or
// the error's message.

import type { RunId } from "../contracts/common.ts";
import type { CoreErrorCode, ErrorCode } from "../contracts/connectors.ts";
import type { ToolCallAllowed, ToolCallRefused } from "../contracts/events.ts";
import type { DeniedCode, ToolCallOutcome, ToolResult } from "../contracts/executor.ts";
import type { ToolRef } from "../contracts/runs.ts";
import { saltedHmacHex } from "../lib/hash.ts";
import { isDict, type Json, type JsonObject } from "../lib/json.ts";
import { sliceText } from "../lib/text.ts";
import { OperationError } from "./connector.ts";
import type { Registry } from "./registry.ts";
import { toolLabel } from "./tools.ts";

function frozen<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) frozen(item);
		Object.freeze(value);
	}
	return value;
}

/** Every tool's output schema, declared to the model and to scripts. */
export const RESULT_SCHEMA: JsonObject = frozen({
	type: "object",
	properties: {
		items: { type: "array", items: { type: "object" }, description: "Records this run may see. Their fields depend on the tool." },
		count: { type: "integer", minimum: 0, description: "The number of items in this result, not a total across pages." },
		incomplete: { const: true, description: "A provider or connector limit left something out." },
		next_cursor: {
			type: "string",
			minLength: 1,
			description: "More items may follow: repeat the call with the same arguments and this as cursor.",
		},
		outcome: { const: "applied_without_result", description: "The write took effect, but its result could not be read back." },
	},
	required: ["items", "count"],
	additionalProperties: false,
});

/** A write that took effect but whose response could not be read: a success, remembered for repeats. */
export function appliedWithoutResult(): ToolResult {
	return { items: [], count: 0, outcome: "applied_without_result" };
}

/** The codes whose refusal the chat shows as "Not allowed"; every other failure is `error`. */
export const DENIAL_CODES: ReadonlySet<string> = new Set<DeniedCode>([
	"POLICY_DENIED",
	"LIMIT_REACHED",
	"WRITE_UNCERTAIN",
	"WRITE_IN_PROGRESS",
	"INVALID_CURSOR",
	"CONSENT_REQUIRED",
	"OPERATION_CHANGED",
]);

export const FAILED_MESSAGE = "The operation could not be completed. Check the connection and try again.";

/** Only an owned error's message reaches the model or the UI; anything else is FAILED with the generic message. */
export function publicError(error: unknown): { code: ErrorCode | Extract<CoreErrorCode, "FAILED">; message: string } {
	if (error instanceof OperationError) return { code: error.code, message: error.message };
	return { code: "FAILED", message: FAILED_MESSAGE };
}

/**
 * The arguments as recorded: themselves when their JSON is at most 2000 UTF-16 units, else its first 2000,
 * one fewer where the cut would split a surrogate pair.
 */
export function argumentsSummary(args: Json | undefined): { [key: string]: Json } | { truncated: string } {
	const value = args ?? {};
	const text = JSON.stringify(value);
	if (text.length <= 2000 && isDict(value)) return value;
	const cut = text.slice(0, 2000);
	return { truncated: cut.isWellFormed() ? cut : cut.slice(0, -1) };
}

/**
 * Lets the chat match a repeated write to its own card, whose arguments may be shown cut short: the salted
 * HMAC of `{run}:{key}` under MINERVA_SECRET_KEY (lib/hash.ts), 32 hex. Keyed, so it
 * tells nothing about the arguments, and it differs between runs.
 */
export async function writeId(secretKey: string, runId: RunId, writeKey: string): Promise<string> {
	return (await saltedHmacHex("minerva.gateway.write", `${runId}:${writeKey}`, secretKey)).slice(0, 32);
}

/** The part of a `tool_call` event fixed before the call runs. */
export interface ShownCall {
	tool: string;
	label: string;
	arguments: { [key: string]: Json } | { truncated: string };
}

/**
 * Tool names are at most 64 characters, so a longer one is unknown and only its start is recorded; the
 * label is looked up by that start, and is the bare name for an unknown tool.
 */
export function shownCall(registry: Registry, refs: ReadonlyMap<string, ToolRef>, name: string, args: Json | undefined): ShownCall {
	const tool = sliceText(name, 0, 64);
	return { tool, label: toolLabel(registry, refs.get(tool), tool), arguments: argumentsSummary(args) };
}

export function allowedEvent(shown: ShownCall, title: string, count: number | null, write: string | null, repeat: boolean): ToolCallAllowed {
	const event: ToolCallAllowed = { ...shown, decision: "allowed", title, count };
	if (write !== null) event.write = write;
	if (repeat) event.repeat = true;
	return event;
}

export function refusedEvent(shown: ShownCall, code: string, message: string): ToolCallRefused {
	return { ...shown, decision: DENIAL_CODES.has(code) ? "denied" : "error", code, message };
}

/** The result a call returns, in MCP's shape (`CallToolResult`). */
export interface CallToolResult {
	content: { type: string; text?: string }[];
	structuredContent?: ToolResult;
	isError: boolean;
}

/** What the loop hands the model for an outcome: the result's JSON plus the result, or the message. */
export function callToolResult(outcome: ToolCallOutcome): CallToolResult {
	if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.result) }], structuredContent: outcome.result, isError: false };
	return { content: [{ type: "text", text: outcome.error.message }], isError: true };
}

/**
 * The model's content for a result: text as it is, anything else as `[<type> content omitted]`, and the
 * structured result as indented JSON when there is no content. The tool declares TOOL_RESULT_LIMITS, so pi
 * keeps results whole up to 1 MiB: the paging fields at their end must not be cut off.
 */
export function modelContent(result: CallToolResult): { type: "text"; text: string }[] {
	if (result.content.length === 0 && result.structuredContent !== undefined) {
		return [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
	}
	return result.content.map((block) =>
		block.type === "text" && typeof block.text === "string" ? { type: "text", text: block.text } : { type: "text", text: `[${block.type} content omitted]` },
	);
}

/** `outputLimits` of every connector tool's registration: 1 MiB, any number of lines, the head kept. */
export const TOOL_RESULT_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" as const });

