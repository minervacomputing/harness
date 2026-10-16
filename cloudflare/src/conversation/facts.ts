// A Laravel conversation's facts (docs/plans/credentials-and-facts.md, The outbox of facts): what its runs did, as the
// contract's `Fact`s (contract/src/internal/facts.ts), written by the store in the transaction that makes the change each
// describes and delivered to Laravel in order. This module holds the pure parts: the facts' shapes as the store makes them,
// and the delivery's rules for reading Laravel's answers.

import { type Fact, MAX_ARGUMENTS, MAX_FACTS } from "@minerva/contract/internal";
import type { ToolCallEventData } from "@minerva/contract";
import type { Json } from "../lib/json.ts";
import type { CallSettlement } from "../model/provider.ts";
import type { Tokens } from "../model/tap.ts";

/** A fact before the store gives it its sequence, run and time. */
export type NewFact = Fact extends infer F ? (F extends Fact ? { type: F["type"]; data: F["data"] } : never) : never;

/** A batch delivered, or a page replayed, stops at this much JSON (and at MAX_FACTS facts), with at least one fact. */
export const FACT_PAGE_BYTES = 4 * 1024 * 1024;
export { MAX_FACTS };

export const BACKLOG_MESSAGE = "This conversation is catching up. Try again in a few minutes.";

/** The delivery's limits and waits; the tests shorten them. */
export const FACT_DELIVERY = {
	/** Past this many facts written and not acknowledged, a start in the conversation is refused (`FACTS_BACKLOG`). */
	backlog: 10_000,
	/** A delivery that failed waits 2^failures times this, at most `maxBackoffMs`. */
	backoffMs: 1000,
	maxBackoffMs: 5 * 60_000,
	/** A conversation whose delivery Laravel refused as conflicting is tried again this often, for the operator. */
	conflictRetryMs: 60 * 60_000,
};
/** `FACT_GAP`s answered in a row before the delivery backs off. */
export const MAX_GAPS = 3;

/** When a delivery that failed `failures` times in a row is tried again. */
export function backoffMs(failures: number): number {
	return Math.min(2 ** Math.min(failures, 20) * FACT_DELIVERY.backoffMs, FACT_DELIVERY.maxBackoffMs);
}

/**
 * A `run.tool_call` fact's data: the event's, with the call's own arguments as their JSON cut to its first 2000 characters,
 * one fewer where the cut would split a surrogate pair. Made from the arguments rather than the event's `{truncated}` form,
 * which a call's real arguments could also have.
 */
export function toolCallFact(event: ToolCallEventData, args: Json | undefined): NewFact {
	const text = JSON.stringify(args ?? {});
	const cut = text.length <= MAX_ARGUMENTS ? text : text.slice(0, MAX_ARGUMENTS);
	const argumentsText = cut.isWellFormed() ? cut : cut.slice(0, -1);
	const { arguments: _shown, ...rest } = event;
	return { type: "run.tool_call", data: { ...rest, arguments: argumentsText, truncated: argumentsText.length < text.length } };
}

/**
 * A settled model call's fact: `run.usage` with what it reported, else `run.unmetered`, a refusal at no tokens and every
 * other at `tokens` (its reservation), estimated. `requestBytes` only for a call that built a request; `costMicros` and
 * `prices` only for a call that was charged.
 */
export function callFact(record: { call: string; provider: string; model: string }, settlement: CallSettlement, tokens: Tokens, charge: { costMicros: number; prices: string } | null): NewFact {
	const call = { call: record.call, provider: record.provider, model: record.model };
	const bytes = settlement.requestBytes === null ? {} : { requestBytes: settlement.requestBytes };
	const priced = charge === null ? {} : { costMicros: charge.costMicros, prices: charge.prices };
	switch (settlement.outcome) {
		case "reported":
			return {
				type: "run.usage",
				data: { ...call, inputTokens: tokens.input, outputTokens: tokens.output, cachedTokens: tokens.cached, cacheWriteTokens: tokens.cacheWrite, reasoningTokens: tokens.reasoning, ...bytes, ...priced },
			};
		case "refused":
			return { type: "run.unmetered", data: { ...call, cause: "refused", inputTokens: 0, outputTokens: 0, estimated: false, ...bytes, ...(charge === null ? {} : { costMicros: 0, prices: charge.prices }) } };
		case "unmetered":
			return { type: "run.unmetered", data: { ...call, cause: settlement.cause, inputTokens: tokens.input, outputTokens: tokens.output, estimated: true, ...bytes, ...priced } };
	}
}

/** What a delivery makes of Laravel's answer to a batch (docs/plans/credentials-and-facts.md, Delivered in order). */
export type DeliveryVerdict =
	/** Laravel holds the batch: its new watermark. */
	| { kind: "acknowledged"; acknowledged: number }
	/** Laravel holds less than the engine thought: send again from its watermark. */
	| { kind: "gap"; acknowledged: number }
	/** A fact differs from the one Laravel applied: delivery waits for the operator. */
	| { kind: "conflict" }
	/** Anything else, retried after a backoff; `error` when it is a bug or a misconfiguration to log as one. */
	| { kind: "failed"; reason: string; error: boolean };

/**
 * An acknowledgement of a batch whose last fact is `last`, with `written` facts written: Laravel applies a batch whole, so
 * it must hold at least `last`, and cannot hold more than was written.
 */
export function acknowledgement(acknowledged: number, last: number, written: number): DeliveryVerdict {
	if (!Number.isSafeInteger(acknowledged) || acknowledged < last || acknowledged > written) {
		return { kind: "failed", reason: `Laravel acknowledged ${acknowledged} for a batch up to ${last} of ${written}.`, error: true };
	}
	return { kind: "acknowledged", acknowledged };
}

/** A `FACT_GAP`'s watermark, which may be below what Laravel acknowledged before (it was restored), never above `written`. */
export function gap(acknowledged: unknown, written: number): DeliveryVerdict {
	if (typeof acknowledged !== "number" || !Number.isSafeInteger(acknowledged) || acknowledged < 0 || acknowledged > written) {
		return { kind: "failed", reason: `Laravel answered a gap at ${String(acknowledged)} of ${written}.`, error: true };
	}
	return { kind: "gap", acknowledged };
}
