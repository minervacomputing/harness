// Shared shapes of the contracts. Contracts are types and doc comments only: the interfaces that steps 2
// to 6 build against (docs/plans/cloudflare.md, Steps). They cite the plan's sections a rule comes from.
//
// RPC rule: a Durable Object method's argument and return types must be structured-cloneable and must not
// contain `unknown` (Workers' RPC types turn an object with an `unknown` field into `never`). Use `Json`
// for free-form values.

export type { Json } from "../lib/json.ts";

/** Lowercase hyphenated UUIDv7, as every id in the API. */
export type Uuid = string;
export type UserId = Uuid;
export type WorkspaceId = Uuid;
export type ConversationId = Uuid;
export type AgentId = Uuid;
export type ConnectionId = Uuid;
export type RunId = Uuid;
export type MessageId = Uuid;
export type UploadId = Uuid;
export type VersionId = Uuid;

/** Milliseconds since the epoch. Stored times use it; the API writes ISO 8601. */
export type EpochMs = number;

/** A lowercase SHA-256 in hex: 64 characters. */
export type Sha256 = string;

/** Where a workspace's objects live (plan: Data placement, Addressing). The same name with and without a jurisdiction is a different, empty object. */
export interface WorkspaceRef {
	id: WorkspaceId;
	jurisdiction: "eu" | null;
}

export type Role = "owner" | "admin" | "member";

/**
 * Who is asking, as the Worker verified it from the session and D1's memberships. A Durable
 * Object never takes a user from the client; it takes this, and still checks ownership of what it holds
 * (another user's conversation, run or upload is "not found").
 */
export interface Caller {
	userId: UserId;
	role: Role;
}

/**
 * The run and attempt an asynchronous operation started under. Every operation carries it and is refused
 * when either is no longer current; the one exception is settling a write an older attempt already
 * dispatched, which is always recorded (plan: Attempts and recovery, Fencing).
 */
export interface AttemptFence {
	runId: RunId;
	attempt: number;
}

/** A refusal an API endpoint answers with: `{"detail": message}` and this status. */
export interface Refusal {
	status: 400 | 403 | 404 | 405 | 408 | 409 | 411 | 413 | 422 | 429 | 502 | 503;
	detail: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/**
 * How a change that revokes runs was delivered (plan: Strict revocation). `acknowledged`: every affected
 * run's Conversation Durable Object has acknowledged the cancel, so the API may answer. `pending`: the
 * change is saved, but some acknowledgement did not arrive within 10 seconds; the API answers 503 and the
 * Workspace's alarm keeps delivering.
 */
export type Revocation = "acknowledged" | "pending";
