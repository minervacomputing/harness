// The Workspace Durable Object: one per workspace, named by its id, in its jurisdiction (plan: Data
// placement). Authoritative for connections (encrypted credentials, status, generation, scopes, refresh
// state), permission layers and grants, agents, unattached uploads with their reservations, the registry
// of runs, the revocation outbox and byte counters; an index of conversations. Reached only by typed
// RPC from our own code, after the Worker checked membership in D1 (web-api 7).

import type { AccessOut, AgentIn, AgentOut, ConnectionOut, ConversationOut, UploadOut } from "./api.ts";
import type {
	AgentId,
	Caller,
	ConnectionId,
	ConversationId,
	EpochMs,
	Outcome,
	Revocation,
	RunId,
	Sha256,
	UploadId,
	UserId,
	WorkspaceRef,
} from "./common.ts";
import type { CredentialPayload } from "./connectors.ts";
import type { CredentialLease } from "./executor.ts";
import type { FolderLimit } from "./files.ts";
import type { GrantChange } from "./policy.ts";
import type { CancelReason, RunStatus, StartSnapshot } from "./runs.ts";

export interface WorkspaceInit {
	workspace: WorkspaceRef;
	kind: "personal" | "team";
	ownerId: UserId;
	createdAt: EpochMs;
}

/**
 * An unattached upload a run start reserved. The Conversation Durable Object copies its object into a blob
 * of its own before the start's transaction (plan: Starting a run, step 3) and adds that to the folder:
 * `uploads/` objects are deleted by the bucket's lifecycle rule a day after they were written, attached or
 * not, so nothing may keep naming one.
 */
export interface ReservedUpload {
	id: UploadId;
	/** The cleaned name; numbered against the folder's root names when added (files 10). */
	name: string;
	size: number;
	mediaType: string;
	sha256: Sha256;
	/** `uploads/<ws>/<user>/<id>` in R2. */
	key: string;
}

export interface BeginRunInput {
	runId: RunId;
	conversationId: ConversationId;
	userId: UserId;
	agentId: AgentId;
	/** As the message named them, in order, duplicates included (the check refuses them). */
	uploadIds: UploadId[];
	/** The folder the run would start from, for the limit checks with the attachments. */
	folder: { bytes: number; entries: number };
}

/**
 * `beginRun` refusals carry today's statuses and messages (runs 3.1; files 10): 404 for an unknown agent;
 * 400 "Attach at most {n} files to a message.", "A file is attached twice.", "An attached file is no
 * longer available. Remove it and attach it again."; 413 "These files would put more than 10,000 files and
 * folders in this conversation's folder." or "These files would make this conversation's folder larger
 * than 256 MB." (thousands separator here). A refused or revoked start leaves nothing behind.
 */
export type BeginRunResult = Outcome<{ snapshot: StartSnapshot; uploads: ReservedUpload[] }>;

/**
 * Where a registered run stands, as `activate` answers it. `revoked`: a revocation reached it (its cancel
 * is in the outbox too). `expired`: not activated within ten minutes, so its reservations were released.
 */
export type Registration = { state: "active" } | { state: "revoked"; reason: CancelReason } | { state: "expired" } | { state: "ended" };

/** A run in the registry (plan: Data placement). */
export interface RegisteredRun {
	runId: RunId;
	conversationId: ConversationId;
	userId: UserId;
	agentId: AgentId;
	connectionIds: ConnectionId[];
	state: "starting" | "active" | "ended" | "expired";
	revoked: CancelReason | null;
	registeredAt: EpochMs;
}

/** One cancellation to deliver; written in the same transaction as the change that causes it. */
export interface OutboxEntry {
	id: number;
	runId: RunId;
	conversationId: ConversationId;
	reason: CancelReason;
	createdAt: EpochMs;
	attempts: number;
	acknowledgedAt: EpochMs | null;
}

/**
 * Where a connection's credentials stand (plan: Credentials and refresh). `refreshing` is recorded at
 * generation g before the token endpoint is called; found after a restart it becomes `refresh_uncertain`,
 * and the next use makes exactly one refresh with the stored token, while no other request uses the
 * connection. A reconnect or delete during a refresh wins: a result for a generation that moved is dropped.
 */
export type RefreshState = "fresh" | "refreshing" | "refresh_uncertain";

export interface SaveConnectionInput {
	provider: string;
	/** From `connector.account()` with the new secret. */
	account: { id: string; label: string };
	credentials: CredentialPayload;
	/** Set when reconnecting or replacing a key: the same provider and external account are required. */
	connectionId: ConnectionId | null;
}

/** A connection's provider account and owner (null: shared), as `connectionAccount` answers. */
export interface ConnectionAccount {
	provider: string;
	accountId: string;
	label: string;
	ownerId: UserId | null;
}

/**
 * The Workspace Durable Object's RPC surface. `Caller` is the Worker's verified user and role; every
 * refusal is `{status, detail}` with today's wording (web-api 8.3 to 8.5, connectors 13).
 */
export interface WorkspaceApi {
	/**
	 * Creates the ceiling layer (unrestricted), the owner's user layer (restricted) and the default agent
	 * ("Assistant", "You are a helpful, concise assistant.", model `default`, no connections). Idempotent;
	 * the Worker retries it until it succeeds after the D1 batch that made the user, workspace and
	 * membership (web-api 6.3).
	 */
	init(input: WorkspaceInit): Promise<void>;

	// Agents (web-api 8.3).
	listAgents(caller: Caller): Promise<AgentOut[]>;
	getAgent(caller: Caller, agentId: AgentId): Promise<AgentOut | null>;
	/** 422 "Choose connections you can use." when an added connection is unknown, broken or someone else's. */
	createAgent(caller: Caller, input: AgentIn): Promise<Outcome<AgentOut>>;
	/**
	 * A full replace. 403 "You cannot change this agent." unless the caller owns the agent or is a workspace
	 * owner or admin. A changed connection set revokes the agent's active runs (`agent_connections_changed`)
	 * before answering.
	 */
	updateAgent(caller: Caller, agentId: AgentId, input: AgentIn): Promise<Outcome<{ agent: AgentOut; revocation: Revocation }>>;
	/** 422 "Keep at least one agent."; cancels the agent's runs ("Stopped.") and deletes its conversations. */
	deleteAgent(caller: Caller, agentId: AgentId): Promise<Outcome<{ revocation: Revocation }>>;

	// Connections and access (connectors 11, 13). Provider calls (account, discover, children, describe)
	// happen in the Worker before these are called, with a credential from `lease`.
	listConnections(caller: Caller): Promise<ConnectionOut[]>;
	/** Built-in services: one per user, idempotent; 422 "{Name} is connected through its own sign-in." */
	enableBuiltin(caller: Caller, provider: string): Promise<Outcome<ConnectionOut>>;
	/** After an OAuth callback or a key check; encrypts the credentials and bumps the generation (connectors 11.6). */
	saveConnection(caller: Caller, input: SaveConnectionInput): Promise<Outcome<ConnectionOut>>;
	/** 403 for a shared connection and a non-admin; revokes the caller's runs (`connection_removed`). */
	deleteConnection(caller: Caller, connectionId: ConnectionId): Promise<Outcome<{ revocation: Revocation }>>;
	/**
	 * `_usable`, then the caller's access: 404 "Not Found" when the connection does not exist, "Not found."
	 * when it is another user's personal one. Never calls the provider. The Worker reads a connection's
	 * provider, owner and the caller's grants from this before every settings request (web-api 8.5).
	 */
	getAccess(caller: Caller, connectionId: ConnectionId): Promise<Outcome<AccessOut>>;
	/**
	 * All or nothing, after `checkChanges` and the provider's `describe` of new concrete grants (names
	 * given, keyed by gateway/grants.ts `resourceKey(kind, id)`), then `planGrantChanges`. 422 with
	 * connectors 4.5's messages; at most 500 grants per connection. Revokes the caller's active runs
	 * (`permissions_changed`) in the same transaction, then waits for the acknowledgements.
	 */
	applyGrantChanges(
		caller: Caller,
		connectionId: ConnectionId,
		changes: GrantChange[],
		names: { [key: string]: string },
	): Promise<Outcome<{ access: AccessOut; revocation: Revocation }>>;
	/** The actions allowed on a connection: the caller's, or every member's for a shared one (reconnect scopes). */
	allowedActions(caller: Caller, connectionId: ConnectionId): Promise<string[] | null>;
	/**
	 * The provider account behind a connection and whose connection it is, for an OAuth flow (web-api 9):
	 * `login_hint` on a reconnect and the callback's checks, which tell another user's connection apart from
	 * one that is gone. Null when the connection does not exist.
	 */
	connectionAccount(connectionId: ConnectionId): Promise<ConnectionAccount | null>;

	/**
	 * Credentials for one provider call, refreshed first when they expire within 120 s (single-flight per
	 * connection, fenced by the generation). `purpose` says who asks: a run's executor (RUN_ENDED "This run
	 * is no longer active." unless the run is registered, activated, not revoked and the user's) or a
	 * settings request of the caller. The registry does not know attempts: the Conversation Durable Object
	 * checks the call's AttemptFence before and after this (executor.ts, CredentialPort).
	 */
	lease(
		connectionId: ConnectionId,
		purpose: { run: RunId; userId: UserId } | { settings: Caller },
	): Promise<CredentialLease | { refused: "RUN_ENDED" | "CONNECTION_UNAUTHORIZED" | "PROVIDER_UNAVAILABLE"; message: string }>;
	/** Compare-and-set: `error` only if still `active` at this generation (connectors 9.2). */
	markUnauthorized(connectionId: ConnectionId, generation: number): Promise<void>;

	// Runs (plan: Starting a run).
	/**
	 * Idempotent by run id and synchronous inside (no awaits): checks the agent, the uploads (the user's
	 * own, unattached, complete) and the folder limits with the attachments, reserves the uploads, computes
	 * the snapshot and registers the run as active. Called again with the same run id it returns the same
	 * answer; it refuses a run it has since revoked (409 with the run's end message, "Stopped because
	 * permissions changed." or "Stopped.") or expired or released (503 "The agent could not finish this run.
	 * Try again."). A refused start registers nothing.
	 */
	beginRun(input: BeginRunInput): Promise<BeginRunResult>;
	/**
	 * The run is stored: its reservations become consumption (the upload rows and their objects are deleted;
	 * the run's copies are its own). Idempotent, and answers where the registration stands. The Conversation
	 * Durable Object calls it after storing the run, again on an alarm and on every start of the object for
	 * each stored active run not yet `activated`; it stops a run that comes back `revoked` with that reason
	 * and fails one that comes back `expired` (`start_expired`). An alarm expires starts not activated within
	 * ten minutes, so a late `beginRun` result cannot start them.
	 */
	activate(runId: RunId): Promise<Registration>;
	/** The run ended (or its start was refused after `beginRun`): it leaves the active registry; reservations not consumed are released. */
	release(runId: RunId, status: RunStatus | "refused"): Promise<void>;
	/** For `/runs/{run}` URLs: the caller's run's conversation, else null (frontend 13.1, 6). */
	locateRun(caller: Caller, runId: RunId): Promise<{ conversationId: ConversationId } | null>;
	/** A Conversation Durable Object's acknowledgement of an outbox entry delivered earlier without one. */
	acknowledgeCancel(entryId: number, runId: RunId): Promise<void>;
	/** An operator's command: cancels every active run of the workspace through the outbox (plan: Emergency stop). */
	emergencyStop(reason: string): Promise<{ runs: number; revocation: Revocation }>;

	// Conversations: an index only; each Conversation Durable Object is authoritative for itself.
	/** 404 when the agent is not in the workspace; initializes the Conversation Durable Object idempotently. */
	createConversation(caller: Caller, agentId: AgentId): Promise<Outcome<ConversationOut>>;
	/** The caller's, newest `updated_at` first, at most 100. */
	listConversations(caller: Caller): Promise<ConversationOut[]>;
	/**
	 * Whether the conversation is in this workspace's index, ready, not deleted and the caller's: the Worker
	 * asks before it addresses a Conversation Durable Object by an id from the URL (addressing.ts), so an id
	 * from another workspace, another user's, or none at all is 404 without reaching (or creating) an object.
	 */
	ownsConversation(caller: Caller, conversationId: ConversationId): Promise<boolean>;
	/** Written by the Conversation Durable Object when its title or `updated_at` changes. */
	conversationTouched(conversationId: ConversationId, change: { title: string; updatedAt: EpochMs }): Promise<void>;
	/**
	 * Tombstones the conversation (both objects then refuse new runs, uploads and writes), cancels its active
	 * run through the outbox and waits for the acknowledgement (`revocation` as for a grant change), then has
	 * the Conversation Durable Object destroy itself (`destroy()`: its run ended, its storage and R2 prefix
	 * deleted), again an hour later; an alarm finishes an interrupted deletion (plan: Files, Deletion).
	 */
	deleteConversation(caller: Caller, conversationId: ConversationId): Promise<Outcome<{ revocation: Revocation }>>;

	// Uploads (files 9; plan: Files). Every object is recorded before it is written.
	/**
	 * Records the upload as pending, with its key and a byte reservation against the workspace's quota,
	 * before the Worker streams the body into R2. In files 9.1's order: 429 "You are uploading too many files
	 * at once." (3 pending per user, younger than the body's 15 minutes); 429 "You have too many files waiting
	 * to be sent. Send or remove some, or try again tomorrow." (30 per user); 413 "This workspace has no room
	 * for more files."
	 */
	reserveUpload(caller: Caller, upload: { name: string; size: number }): Promise<Outcome<{ id: UploadId; key: string }>>;
	/** After the put and the hash: the upload is complete and attachable for a day. */
	completeUpload(caller: Caller, id: UploadId, stored: { sha256: Sha256; size: number; mediaType: string }): Promise<Outcome<UploadOut>>;
	/** The body never arrived or failed its checks; the reservation is released and the object deleted if written. */
	abandonUpload(caller: Caller, id: UploadId): Promise<void>;
	/** Only the caller's own unattached upload; always succeeds (204). */
	deleteUpload(caller: Caller, id: UploadId): Promise<void>;

	/**
	 * A conversation's absolute byte total, before it writes new blobs (files 15.2). Refused when the sum
	 * would pass MINERVA_FILES_WORKSPACE_BYTES; absolute totals make it idempotent. `revision` rises with
	 * every report the conversation sends: one no newer than a report already seen changes nothing (it was
	 * sent by an instance that has since reset). One without a revision, as an older caller sends, applies
	 * only until a report with one has been seen.
	 */
	setConversationBytes(conversationId: ConversationId, total: number, revision?: number): Promise<{ ok: true } | { ok: false; limit: Extract<FolderLimit, "workspace"> }>;
}
