// The shapes every Durable Object's RPC and the Worker share: ids, the workspace a call is addressed to,
// the verified caller, the attempt fence, a run's status and refusals with their codes. Types that belong to one object or module live with
// it; only what crosses between all of them is here.
//
// A Durable Object method's argument and return types must be structured-cloneable and must not contain
// `unknown` (Workers' RPC types turn an object with an `unknown` field into `never`). Use lib/json.ts's
// `Json` for free-form values.

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

/** `queued → provisioning → running → completed | failed | cancelled | timed_out`. */
export type RunStatus = "queued" | "provisioning" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/**
 * Every refusal the API sends, by code, with its status (Better Auth's routes answer in their own format).
 * A code names one meaning and always has the same status; its text, `detail`, may vary. The answer is
 * `{"code": …, "detail": …}` (http/errors.ts `refused`); a validation failure's detail is its issues.
 */
export const REFUSALS = {
	// Any request.
	UNAUTHORIZED: 401,
	CROSS_SITE: 403,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	TOO_MANY_SESSION_COOKIES: 400,
	INTERNAL_SERVER_ERROR: 500,
	// Bodies and query strings.
	INVALID_JSON: 400,
	PAYLOAD_TOO_LARGE: 413,
	UNSUPPORTED_MEDIA_TYPE: 415,
	VALIDATION_FAILED: 422,
	// The instance's setup and administration.
	INVALID_SETUP_KEY: 403,
	ALREADY_SET_UP: 409,
	INSTANCE_ADMINS_ONLY: 403,
	NO_SUCH_USER: 404,
	KEEP_ONE_ADMIN: 422,
	// Agents.
	CANNOT_CHANGE_AGENT: 403,
	CHOOSE_CONNECTIONS: 422,
	KEEP_ONE_AGENT: 422,
	/** The change was saved, but runs it stops have not all stopped yet: sending it again does nothing new. */
	RUNS_STILL_STOPPING: 503,
	// Connections and their access.
	UNKNOWN_PROVIDER: 404,
	WORKSPACE_ADMINS_ONLY: 403,
	WRONG_CONNECTION_METHOD: 422,
	UNKNOWN_ACTION: 422,
	CONNECTION_REMOVED: 422,
	DIFFERENT_ACCOUNT: 422,
	ALREADY_CONNECTED: 422,
	KEY_REFUSED: 422,
	INVALID_ACCESS_CHANGE: 422,
	UNKNOWN_RESOURCE_KIND: 422,
	CANNOT_BROWSE: 422,
	RESOURCE_NOT_VISIBLE: 422,
	INVALID_RESOURCE_ID: 422,
	INVALID_CURSOR: 422,
	RECONNECT_NEEDED: 502,
	PROVIDER_FAILED: 502,
	/** An OAuth connection that cannot be started now: the provider is not configured, or its registration failed. */
	CONNECT_UNAVAILABLE: 503,
	// Messages and run starts.
	INVALID_IDEMPOTENCY_KEY: 400,
	IDEMPOTENCY_KEY_REUSED: 422,
	EMPTY_MESSAGE: 400,
	CONVERSATION_BUSY: 409,
	RUN_STOPPED: 409,
	/** The start failed and left nothing behind: the message may be sent again. */
	START_FAILED: 503,
	TOO_MANY_ATTACHMENTS: 400,
	ATTACHED_TWICE: 400,
	ATTACHMENT_UNAVAILABLE: 400,
	INVALID_ATTACHMENTS: 400,
	FOLDER_FULL: 413,
	// Uploads.
	LENGTH_REQUIRED: 411,
	INVALID_CONTENT_LENGTH: 400,
	CONTENT_LENGTH_MISMATCH: 400,
	FILE_TOO_LARGE: 413,
	FILE_NAME_MISSING: 400,
	UPLOAD_TIMEOUT: 408,
	TOO_MANY_UPLOADS_AT_ONCE: 429,
	TOO_MANY_UPLOADS_WAITING: 429,
	WORKSPACE_FULL: 413,
} as const;

export type RefusalCode = keyof typeof REFUSALS;

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
