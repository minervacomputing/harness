// The shapes every Durable Object's RPC and the Worker share: ids, the workspace a call is addressed to, the attempt
// fence, a run's status and refusals with their codes. Types that belong to one object or module live with it; only what
// crosses between all of them is here.
//
// A Durable Object method's argument and return types must be structured-cloneable and must not contain
// `unknown` (Workers' RPC types turn an object with an `unknown` field into `never`). Use lib/json.ts's
// `Json` for free-form values.

import type { RefusalCode } from "@minerva/contract";

/** Lowercase hyphenated UUIDv7, as every id in the API. */
type Uuid = string;
export type UserId = Uuid;
export type WorkspaceId = Uuid;
export type ConversationId = Uuid;
export type AgentId = Uuid;
export type ConnectionId = Uuid;
export type RunId = Uuid;
export type UploadId = Uuid;
export type VersionId = Uuid;

/** Milliseconds since the epoch. Stored times use it; the API writes ISO 8601. */
export type EpochMs = number;

/** A lowercase SHA-256 in hex: 64 characters. */
export type Sha256 = string;

/** Where a workspace's objects live (ARCHITECTURE.md: Data placement, Addressing). The same name with and without a jurisdiction is a different, empty object. */
export interface WorkspaceRef {
	id: WorkspaceId;
	jurisdiction: "eu" | null;
}

/**
 * The run and attempt an asynchronous operation started under. Every operation carries it and is refused
 * when either is no longer current; the one exception is settling a write an older attempt already
 * dispatched, which is always recorded (ARCHITECTURE.md: Attempts and recovery, Fencing).
 */
export interface AttemptFence {
	runId: RunId;
	attempt: number;
}

/** `queued → provisioning → running → completed | failed | cancelled | timed_out`. */
export type RunStatus = "queued" | "provisioning" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** Every refusal the API sends, by code, with its status: the contract's (contract/src/refusals.ts). */
export { REFUSALS, type RefusalCode } from "@minerva/contract";

/** A refusal an API endpoint answers with: its code (and so its status) and a sentence for the user. */
export interface Refusal {
	code: RefusalCode;
	detail: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/** A refused outcome, of any value type. */
export function refuse(code: RefusalCode, detail: string): { ok: false; refusal: Refusal } {
	return { ok: false, refusal: { code, detail } };
}
