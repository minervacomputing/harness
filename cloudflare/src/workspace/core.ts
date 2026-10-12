// The Workspace's logic (contracts/workspace.ts, WorkspaceApi), over the small SQL surface of sql.ts so it
// runs, and is unit-tested, on node:sqlite as on a Durable Object's storage; workspace.ts is the object
// around it. One instance is one incarnation of the object: building it converts refreshes a dead
// instance left `refreshing` into `refresh_uncertain` (plan: Credentials and refresh).
//
// Every check and the writes it decides happen in one synchronous transaction, with no await in between
// (plan: Starting a run; Strict revocation). Awaits come only before (decrypting, encrypting, asking the
// provider) or after (delivering cancels), and a write that depends on what an await saw re-checks it
// first (compare-and-set on the credential generation).

import type { AccessOut, AgentIn, AgentOut, ConnectionOut, ConversationOut, UploadOut } from "../contracts/api.ts";
import type {
	AgentId,
	Caller,
	ConnectionId,
	ConversationId,
	Outcome,
	Refusal,
	Revocation,
	RunId,
	Sha256,
	UploadId,
	UserId,
	WorkspaceRef,
} from "../contracts/common.ts";
import type { CancelAck } from "../contracts/conversation.ts";
import type { CredentialLease } from "../contracts/executor.ts";
import type { FolderLimit } from "../contracts/files.ts";
import type { GrantChange, GrantRow } from "../contracts/policy.ts";
import type { CancelReason, RunStatus, StartSnapshot } from "../contracts/runs.ts";
import type {
	BeginRunInput,
	BeginRunResult,
	ConnectionAccount,
	RefreshState,
	Registration,
	ReservedUpload,
	SaveConnectionInput,
	WorkspaceApi,
	WorkspaceInit,
} from "../contracts/workspace.ts";
import { ACCOUNT_KIND } from "../gateway/connector.ts";
import { InvalidGrants, type LayerRows, checkChanges, planGrantChanges, resourceKey } from "../gateway/grants.ts";
import type { Registry } from "../gateway/registry.ts";
import { type ConnectionInfo, startSnapshot } from "../gateway/tools.ts";
import type { KeyRing, Sealed } from "../lib/fernet.ts";
import { type JsonObject, parseJson } from "../lib/json.ts";
import { compareCodePoints, sortByCodePoint } from "../lib/order.ts";
import { uuid7 } from "../lib/random.ts";
import { VALUE_PART, sliceCodePoints, splitParts } from "../lib/text.ts";
import { EXPIRED, asPayload, expiresAtOf, keepRefreshToken, needsRefresh, planRefresh, type RefreshResult, scopesOf } from "./credentials.ts";
import {
	ATTACHED_TWICE,
	NO_LONGER_AVAILABLE,
	NO_ROOM,
	PENDING_UPLOAD_LIFETIME_MS,
	PENDING_UPLOADS,
	TOO_MANY_UPLOADS,
	UPLOAD_DEADLINE_MS,
	UPLOAD_LIFETIME_MS,
	UPLOADING_TOO_MANY,
	UPLOADS_IN_FLIGHT,
	overFolder,
	pages,
	tooManyAttachments,
} from "./limits.ts";
import { type AgentView, type ConnectionView, accessOut, agentOut, connectionOut, conversationOut, isAdmin } from "./out.ts";
import type { ConversationClient, Log, OAuthClients, ObjectStore, Timers, WorkspaceSettings } from "./ports.ts";
import { MIGRATIONS } from "./schema.ts";
import { type SqlRow as Row, type Sql, type SqlValue, first, migrate } from "../lib/sql.ts";

/** A start not activated within this is expired and its reservations released (plan: Starting a run). */
export const START_TTL_MS = 10 * 60 * 1000;
/** How long a change waits for the cancels' acknowledgements before it answers 503 (plan: Strict revocation). */
export const BARRIER_MS = 10_000;
/** One delivery attempt, a destroy, or a deletion's wait in the request. */
export const CALL_TIMEOUT_MS = 10_000;
/** Between delivery attempts while a request waits. */
export const RETRY_PAUSE_MS = 500;
/** A deleted conversation's prefix is deleted again this long after the first deletion (plan: Files, Deletion). */
export const PURGE_AGAIN_MS = 60 * 60 * 1000;
/** A conversation whose object was not initialized within this is deleted. */
export const CREATE_TTL_MS = 10 * 60 * 1000;
/** Display names are kept to the 300 characters of today's column. */
const RESOURCE_NAME_MAX = 300;

export const NOT_FOUND = "Not Found";
/** `_usable`'s refusal of another user's connection (connections/api.py), which differs from a missing one's. */
export const NOT_YOURS = "Not found.";
export const RUN_ENDED = "This run is no longer active.";
export const CHOOSE_CONNECTIONS = "Choose connections you can use.";
export const CANNOT_CHANGE = "You cannot change this agent.";
export const KEEP_ONE_AGENT = "Keep at least one agent.";
export const UNKNOWN_PROVIDER = "Unknown provider.";
export const ALREADY_CONNECTED = "This account is already connected by someone else in this workspace.";
export const START_FAILED = "The agent could not finish this run. Try again.";

export const DEFAULT_AGENT = { name: "Assistant", instructions: "You are a helpful, concise assistant.", modelAlias: "default" } as const;

type Status = Refusal["status"];

function ok<T>(value: T): Outcome<T> {
	return { ok: true, value };
}

function refuse<T>(status: Status, detail: string): Outcome<T> {
	return { ok: false, refusal: { status, detail } };
}

/** How a run stopped from outside ends (RunEnd in contracts/runs.ts). */
export function stopMessage(reason: CancelReason): string {
	return reason === "cancelled" || reason === "emergency_stop" ? "Stopped." : "Stopped because permissions changed.";
}

function backoff(attempts: number): number {
	return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

/** Text from outside (provider names and labels) as SQLite can store it: lone surrogates replaced. */
function storable(text: string): string {
	return text.toWellFormed();
}

function jsonList(text: string): string[] {
	return parseJson(text) as string[];
}

interface WorkspaceRow extends Row {
	id: string;
	jurisdiction: string | null;
	kind: string;
	owner_id: string;
	created_at: number;
}

interface ConnectionRow extends Row {
	id: string;
	provider: string;
	owner_id: string | null;
	label: string;
	external_account_id: string;
	status: "active" | "error" | "revoked";
	ciphertext: string;
	key_version: string;
	generation: number;
	scopes: string | null;
	expires_at: number | null;
	refresh_state: RefreshState;
	refresh_generation: number | null;
	created_at: number;
	updated_at: number;
}

interface GrantDbRow extends Row {
	layer_id: string;
	level: GrantRow["layer"];
	subject: string | null;
	connection_id: string;
	kind: string;
	resource_id: string;
	resource_name: string;
	actions: string;
	effect: GrantRow["effect"];
}

interface AgentRow extends Row {
	id: string;
	owner_id: string;
	name: string;
	instructions: string;
	model_alias: string;
	created_at: number;
	updated_at: number;
}

interface ConversationRow extends Row {
	id: string;
	user_id: string;
	agent_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	bytes: number;
	/** The newest byte report seen (`setConversationBytes`); 0 before the first with a revision. */
	bytes_revision: number;
	ready: number;
	deleted_at: number | null;
}

interface RunRow extends Row {
	id: string;
	conversation_id: string;
	user_id: string;
	agent_id: string;
	connection_ids: string;
	state: "starting" | "active" | "ended" | "expired";
	revoked: CancelReason | null;
	registered_at: number;
	activated_at: number | null;
	ended_at: number | null;
	end_status: string | null;
}

interface UploadRow extends Row {
	id: string;
	user_id: string;
	name: string;
	size: number;
	state: "pending" | "complete";
	sha256: string | null;
	media_type: string | null;
	key: string;
	run_id: string | null;
	created_at: number;
	completed_at: number | null;
}

interface OutboxRow extends Row {
	id: number;
	run_id: string;
	conversation_id: string;
	reason: CancelReason;
	created_at: number;
	attempts: number;
	next_attempt_at: number;
	acknowledged_at: number | null;
	ack_state: string | null;
}

interface PurgeRow extends Row {
	conversation_id: string;
	requested_at: number;
	attempts: number;
	next_attempt_at: number;
	first_done_at: number | null;
	done_at: number | null;
}

/** Which live runs a change stops: today's rules (connectors 4.6; runs 8). */
interface RunMatch {
	userId?: UserId;
	agentId?: AgentId;
	conversationId?: ConversationId;
}

/** How a refresh flight ended, for the leases waiting on it. */
type RefreshOutcome =
	| { kind: "refreshed"; generation: number }
	/** The grant is gone: the connection now needs reconnecting. */
	| { kind: "expired" }
	| { kind: "unavailable"; message: string }
	/** The credentials changed meanwhile (a reconnect or a delete won); look again. */
	| { kind: "moved" };

export type LeaseAnswer = Awaited<ReturnType<WorkspaceApi["lease"]>>;
type LeaseRefusal = Exclude<LeaseAnswer, CredentialLease>;

export interface WorkspaceDeps {
	sql: Sql;
	timers: Timers;
	keys: KeyRing;
	registry: Registry;
	settings: WorkspaceSettings;
	conversations: ConversationClient;
	objects: ObjectStore;
	oauth: OAuthClients;
	fetch: typeof fetch;
	log: Log;
	/** Brings the alarm forward to `at` if it is set later or not at all; synchronous, so nothing waits in between. */
	wake?: (at: number) => void;
}

export class WorkspaceCore implements WorkspaceApi {
	readonly #deps: WorkspaceDeps;
	readonly #sql: Sql;
	/** Refreshes in flight, one per connection (plan: Credentials and refresh). */
	readonly #refreshes = new Map<ConnectionId, Promise<RefreshOutcome>>();
	/** Cancels being delivered, one per outbox entry. */
	readonly #deliveries = new Map<number, Promise<void>>();
	/** Deletions being driven, one per conversation. */
	readonly #purges = new Map<ConversationId, Promise<void>>();

	constructor(deps: WorkspaceDeps) {
		this.#deps = deps;
		this.#sql = deps.sql;
		migrate(this.#sql, MIGRATIONS, deps.timers.now());
		// A refresh this instance did not start was started by one that is gone: its outcome is unknown.
		this.#sql.exec("UPDATE connections SET refresh_state = 'refresh_uncertain' WHERE refresh_state = 'refreshing'");
	}

	#now(): number {
		return this.#deps.timers.now();
	}

	/**
	 * One transaction, then the object's alarm brought forward to whatever it left due, before anything is
	 * awaited: a cancel written now is delivered by the alarm even if this instance dies while it waits for
	 * the acknowledgement.
	 */
	#commit<T>(body: () => T): T {
		const result = this.#sql.transaction(body);
		this.#wakeUp();
		return result;
	}

	#wakeUp(): void {
		const at = this.nextWake();
		if (at !== null) this.#deps.wake?.(at);
	}

	get #registry(): Registry {
		return this.#deps.registry;
	}

	// The workspace itself.

	async init(input: WorkspaceInit): Promise<void> {
		const now = this.#now();
		this.#commit(() => {
			const existing = this.#workspaceRow();
			if (existing !== null) {
				if (existing.id !== input.workspace.id || existing.jurisdiction !== input.workspace.jurisdiction) {
					throw new Error("This Workspace object belongs to another workspace.");
				}
				return;
			}
			this.#sql.exec(
				"INSERT INTO workspace (one, id, jurisdiction, kind, owner_id, created_at) VALUES (1, ?, ?, ?, ?, ?)",
				input.workspace.id,
				input.workspace.jurisdiction,
				input.kind,
				input.ownerId,
				input.createdAt,
			);
			// web-api 6.3: an unrestricted ceiling, the owner's restricted layer, and the default agent.
			this.#sql.exec("INSERT OR IGNORE INTO layers (id, level, subject, restricted, updated_at) VALUES ('ceiling', 'ceiling', NULL, 0, ?)", now);
			this.#ensureUserLayer(input.ownerId, now);
			this.#sql.exec(
				"INSERT INTO agents (id, owner_id, name, instructions, model_alias, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				uuid7(now),
				input.ownerId,
				DEFAULT_AGENT.name,
				DEFAULT_AGENT.instructions,
				DEFAULT_AGENT.modelAlias,
				now,
				now,
			);
		});
	}

	#workspaceRow(): WorkspaceRow | null {
		return first<WorkspaceRow>(this.#sql, "SELECT id, jurisdiction, kind, owner_id, created_at FROM workspace WHERE one = 1");
	}

	/** The workspace this object holds, as `init` recorded it from D1. */
	workspaceRef(): WorkspaceRef {
		const row = this.#workspaceRow();
		if (row === null) throw new Error("The workspace is not initialized.");
		return { id: row.id, jurisdiction: row.jurisdiction === "eu" ? "eu" : null };
	}

	// Layers and grants.

	#ensureUserLayer(userId: UserId, now: number): void {
		this.#sql.exec("INSERT OR IGNORE INTO layers (id, level, subject, restricted, updated_at) VALUES (?, 'user', ?, 1, ?)", `user:${userId}`, userId, now);
	}

	#grants(where: string, ...bindings: SqlValue[]): GrantRow[] {
		const rows = this.#sql.exec<GrantDbRow>(
			`SELECT g.layer_id, l.level, l.subject, g.connection_id, g.kind, g.resource_id, g.resource_name, g.actions, g.effect
			 FROM grants g JOIN layers l ON l.id = g.layer_id WHERE ${where}`,
			...bindings,
		);
		return rows
			.map((row) => ({
				layer: row.level,
				subject: row.subject,
				connectionId: row.connection_id,
				kind: row.kind,
				resourceId: row.resource_id,
				resourceName: row.resource_name,
				actions: jsonList(row.actions),
				effect: row.effect,
			}))
			.sort((a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(a.resourceId, b.resourceId));
	}

	/** `user_grants(connection, user)`: one user's allow grants on the connection, in (kind, id) order. */
	#userGrants(connectionId: ConnectionId, userId: UserId): GrantRow[] {
		return this.#grants("g.layer_id = ? AND g.connection_id = ? AND g.effect = 'allow'", `user:${userId}`, connectionId);
	}

	#layer(id: string): LayerRows | null {
		const row = first<{ restricted: number }>(this.#sql, "SELECT restricted FROM layers WHERE id = ?", id);
		if (row === null) return null;
		return { restricted: row.restricted === 1, grants: this.#grants("g.layer_id = ?", id) };
	}

	// Connections.

	#connection(id: ConnectionId): ConnectionRow | null {
		return first<ConnectionRow>(this.#sql, "SELECT * FROM connections WHERE id = ?", id);
	}

	#connectionByAccount(provider: string, accountId: string): ConnectionRow | null {
		return first<ConnectionRow>(this.#sql, "SELECT * FROM connections WHERE provider = ? AND external_account_id = ?", provider, accountId);
	}

	/** `_usable`: the caller's own or a shared connection; another user's personal one is "Not found.". */
	#usable(caller: Caller, id: ConnectionId): Outcome<ConnectionRow> {
		const row = this.#connection(id);
		if (row === null) return refuse(404, NOT_FOUND);
		if (row.owner_id !== null && row.owner_id !== caller.userId) return refuse(404, NOT_YOURS);
		return ok(row);
	}

	#view(row: ConnectionRow): ConnectionView {
		return {
			id: row.id,
			provider: row.provider,
			ownerId: row.owner_id,
			label: row.label,
			status: row.status,
			createdAt: row.created_at,
			scopes: row.scopes === null ? null : jsonList(row.scopes),
		};
	}

	#info(row: ConnectionRow): ConnectionInfo {
		return { id: row.id, provider: row.provider, ownerId: row.owner_id, status: row.status, createdAt: row.created_at, scopes: row.scopes === null ? null : jsonList(row.scopes) };
	}

	/** The API's view of a connection for the caller; null for a provider no longer declared. */
	#connectionOut(caller: Caller, row: ConnectionRow): ConnectionOut | null {
		const connector = this.#registry.find(row.provider);
		return connector === null ? null : connectionOut(connector, this.#view(row), this.#userGrants(row.id, caller.userId));
	}

	async listConnections(caller: Caller): Promise<ConnectionOut[]> {
		const own = this.#sql.exec<ConnectionRow>("SELECT * FROM connections WHERE owner_id = ? ORDER BY created_at, id", caller.userId);
		const shared = this.#sql.exec<ConnectionRow>("SELECT * FROM connections WHERE owner_id IS NULL ORDER BY created_at, id");
		// Python would fail the whole list for a connection whose connector is gone; it is left out instead.
		return [...own, ...shared].map((row) => this.#connectionOut(caller, row)).filter((out) => out !== null);
	}

	async getAccess(caller: Caller, connectionId: ConnectionId): Promise<Outcome<AccessOut>> {
		const usable = this.#usable(caller, connectionId);
		if (!usable.ok) return usable;
		const connector = this.#registry.find(usable.value.provider);
		// Python fails with a 500 for a connection whose connector is gone; it is not found instead.
		if (connector === null) return refuse(404, NOT_FOUND);
		return ok(accessOut(connector, this.#view(usable.value), this.#userGrants(connectionId, caller.userId)));
	}

	async allowedActions(caller: Caller, connectionId: ConnectionId): Promise<string[] | null> {
		const usable = this.#usable(caller, connectionId);
		if (!usable.ok) return null;
		// A shared connection serves every member who allows something on it.
		const grants =
			usable.value.owner_id === null
				? this.#grants("l.level = 'user' AND g.connection_id = ? AND g.effect = 'allow'", connectionId)
				: this.#userGrants(connectionId, caller.userId);
		return sortByCodePoint(new Set(grants.flatMap((grant) => grant.actions)));
	}

	async connectionAccount(connectionId: ConnectionId): Promise<ConnectionAccount | null> {
		const row = this.#connection(connectionId);
		return row === null ? null : { provider: row.provider, accountId: row.external_account_id, label: row.label, ownerId: row.owner_id };
	}

	#writeCredentials(id: ConnectionId, sealed: Sealed, payload: JsonObject, generation: number, now: number): void {
		this.#sql.exec(
			`UPDATE connections SET ciphertext = ?, key_version = ?, generation = ?, scopes = ?, expires_at = ?,
			 refresh_state = 'fresh', refresh_generation = NULL, updated_at = ? WHERE id = ?`,
			sealed.ciphertext,
			sealed.version,
			generation,
			jsonScopes(payload),
			expiresAtOf(payload),
			now,
			id,
		);
	}

	#insertConnection(fields: { provider: string; ownerId: UserId; label: string; accountId: string; sealed: Sealed; payload: JsonObject }, now: number): ConnectionId {
		const id = uuid7(now);
		this.#sql.exec(
			`INSERT INTO connections (id, provider, owner_id, label, external_account_id, status, ciphertext, key_version, generation,
			 scopes, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?, ?)`,
			id,
			fields.provider,
			fields.ownerId,
			fields.label,
			fields.accountId,
			fields.sealed.ciphertext,
			fields.sealed.version,
			jsonScopes(fields.payload),
			expiresAtOf(fields.payload),
			now,
			now,
		);
		return id;
	}

	async enableBuiltin(caller: Caller, provider: string): Promise<Outcome<ConnectionOut>> {
		const connector = this.#registry.find(provider);
		if (connector === null) return refuse(404, UNKNOWN_PROVIDER);
		if (connector.auth.type !== "builtin") return refuse(422, `${connector.name} is connected through its own sign-in.`);
		// One per user (connectors 11.9), found again by its account id, the user's id.
		const found = this.#connectionByAccount(provider, caller.userId);
		if (found !== null) return ok(this.#connectionOut(caller, found) as ConnectionOut);
		const payload: JsonObject = { kind: "builtin" };
		const sealed = await this.#deps.keys.encrypt(payload);
		const now = this.#now();
		const row = this.#commit(() => {
			const raced = this.#connectionByAccount(provider, caller.userId);
			if (raced !== null) return raced;
			const id = this.#insertConnection({ provider, ownerId: caller.userId, label: connector.name, accountId: caller.userId, sealed, payload }, now);
			return this.#connection(id) as ConnectionRow;
		});
		return ok(this.#connectionOut(caller, row) as ConnectionOut);
	}

	async saveConnection(caller: Caller, input: SaveConnectionInput): Promise<Outcome<ConnectionOut>> {
		const connector = this.#registry.find(input.provider);
		if (connector === null) return refuse(404, UNKNOWN_PROVIDER);
		const tokens = input.credentials as unknown as JsonObject;
		const account = { id: storable(input.account.id), label: storable(input.account.label) };
		const apiKey = connector.auth.type === "api_key";
		// The checks read rows, the previous credentials are decrypted and the new ones encrypted, then the
		// write happens only if the row is still as it was read; otherwise everything is done again.
		for (let round = 0; round < 5; round++) {
			let target: ConnectionRow | null;
			if (input.connectionId !== null) {
				// `_target`: renewing one connection needs the same provider and the same account.
				target = this.#connection(input.connectionId);
				if (target === null || target.provider !== connector.slug) return refuse(422, `This ${connector.name} connection was removed. Connect it again.`);
				// The Worker checks these before asking the provider; checked again where the row is.
				if (target.owner_id !== null && target.owner_id !== caller.userId) return refuse(404, NOT_YOURS);
				if (target.owner_id === null && !isAdmin(caller)) {
					return refuse(403, apiKey ? "Only workspace admins can replace the key of shared connections." : "Only workspace admins can reconnect shared connections.");
				}
				if (target.external_account_id !== account.id) {
					return refuse(
						422,
						apiKey
							? `This key is for a different ${connector.name} account. Use a key for ${target.label}.`
							: `You signed in to a different ${connector.name} account. Sign in as ${target.label}.`,
					);
				}
			} else {
				target = this.#connectionByAccount(connector.slug, account.id);
			}
			// A shared connection (no owner) is only renewed through its own flow, which admins start.
			const shared = target !== null && target.owner_id === null && input.connectionId !== null;
			if (target !== null && target.owner_id !== caller.userId && !shared) return refuse(422, ALREADY_CONNECTED);
			// A refresh in flight may be rotating the refresh token this save would keep: let it finish first,
			// then read again, so the token kept is the one it stored.
			const refreshing = target === null ? undefined : this.#refreshes.get(target.id);
			if (refreshing !== undefined) {
				await refreshing.catch(() => null);
				continue;
			}
			const payload = target === null ? tokens : keepRefreshToken(asPayload(await this.#deps.keys.decrypt(sealedOf(target))), tokens);
			const sealed = await this.#deps.keys.encrypt(payload);
			const now = this.#now();
			const saved = this.#commit((): ConnectionId | null => {
				if (target === null) {
					if (this.#connectionByAccount(connector.slug, account.id) !== null) return null;
					return this.#insertConnection({ provider: connector.slug, ownerId: caller.userId, label: account.label, accountId: account.id, sealed, payload }, now);
				}
				const current = this.#connection(target.id);
				if (current === null || current.generation !== target.generation || current.owner_id !== target.owner_id) return null;
				// A refresh that started during the awaits above may be spending the refresh token kept here:
				// wait for it and read again.
				if (current.refresh_state === "refreshing") return null;
				// New credentials are the next generation, so a failure or a refresh seen with the old ones cannot
				// touch them; a refresh in flight is dropped (plan: Credentials and refresh).
				this.#writeCredentials(target.id, sealed, payload, target.generation + 1, now);
				this.#sql.exec("UPDATE connections SET label = ?, status = 'active' WHERE id = ?", account.label, target.id);
				return target.id;
			});
			if (saved === null) continue;
			return ok(this.#connectionOut(caller, this.#connection(saved) as ConnectionRow) as ConnectionOut);
		}
		throw new Error("The connection kept changing while it was saved.");
	}

	async deleteConnection(caller: Caller, connectionId: ConnectionId): Promise<Outcome<{ revocation: Revocation }>> {
		const usable = this.#usable(caller, connectionId);
		if (!usable.ok) return usable;
		if (usable.value.owner_id === null && !isAdmin(caller)) return refuse(403, "Only workspace admins can remove shared connections.");
		const now = this.#now();
		const entries = this.#commit(() => {
			// Its grants cascade and it leaves every agent; the deleting user's runs stop (connectors 4.6).
			this.#sql.exec("DELETE FROM grants WHERE connection_id = ?", connectionId);
			this.#sql.exec("DELETE FROM agent_connections WHERE connection_id = ?", connectionId);
			this.#sql.exec("DELETE FROM connections WHERE id = ?", connectionId);
			return this.#revoke({ userId: caller.userId }, "connection_removed", now).entries;
		});
		return ok({ revocation: await this.#deliver(entries) });
	}

	async applyGrantChanges(
		caller: Caller,
		connectionId: ConnectionId,
		changes: GrantChange[],
		names: { [key: string]: string },
	): Promise<Outcome<{ access: AccessOut; revocation: Revocation }>> {
		const usable = this.#usable(caller, connectionId);
		if (!usable.ok) return usable;
		const connection = usable.value;
		const connector = this.#registry.find(connection.provider);
		if (connector === null) return refuse(404, NOT_FOUND);
		try {
			checkChanges(connector, connectionId, changes);
		} catch (error) {
			if (error instanceof InvalidGrants) return refuse(422, error.message);
			throw error;
		}
		const named = new Map<string, string>();
		for (const [key, name] of Object.entries(names)) named.set(key, sliceCodePoints(storable(name), 0, RESOURCE_NAME_MAX));
		// Account grants are named with the connection's label and need no provider call (connectors 11.9).
		for (const change of changes) {
			if (change.kind === ACCOUNT_KIND && change.actions.length) named.set(resourceKey(change.kind, change.id), sliceCodePoints(connection.label, 0, RESOURCE_NAME_MAX));
		}
		const now = this.#now();
		const layerId = `user:${caller.userId}`;
		let saved: { entries: number[]; access: AccessOut };
		try {
			saved = this.#commit(() => {
				this.#ensureUserLayer(caller.userId, now);
				const plan = planGrantChanges(connector, this.#userGrants(connectionId, caller.userId), changes, named);
				for (const removed of plan.deletes) {
					this.#sql.exec(
						"DELETE FROM grants WHERE layer_id = ? AND connection_id = ? AND kind = ? AND resource_id = ? AND effect = 'allow'",
						layerId,
						connectionId,
						removed.kind,
						removed.resourceId,
					);
				}
				for (const row of plan.upserts) {
					this.#sql.exec(
						`INSERT INTO grants (layer_id, connection_id, kind, resource_id, resource_name, actions, effect) VALUES (?, ?, ?, ?, ?, ?, 'allow')
						 ON CONFLICT (layer_id, connection_id, kind, resource_id, effect) DO UPDATE SET actions = excluded.actions, resource_name = excluded.resource_name`,
						layerId,
						connectionId,
						row.kind,
						row.resourceId,
						row.resourceName,
						JSON.stringify(row.actions),
					);
				}
				this.#sql.exec("UPDATE layers SET version = version + 1, updated_at = ? WHERE id = ?", now, layerId);
				// Any change to a user's grants stops all of that user's active runs, queued ones included, not
				// only those using this connection (connectors 4.5, step 7).
				const entries = this.#revoke({ userId: caller.userId }, "permissions_changed", now).entries;
				// As saved: the connection may change again, or go, while the cancels are delivered.
				return { entries, access: accessOut(connector, this.#view(connection), this.#userGrants(connectionId, caller.userId)) };
			});
		} catch (error) {
			if (error instanceof InvalidGrants) return refuse(422, error.message);
			throw error;
		}
		const revocation = await this.#deliver(saved.entries);
		return ok({ access: saved.access, revocation });
	}

	async markUnauthorized(connectionId: ConnectionId, generation: number): Promise<void> {
		// A refresh in flight is about to replace the credentials the call was rejected with: wait for it, as
		// Python's update waits for the refresh's row lock, so its new generation is not marked.
		const refreshing = this.#refreshes.get(connectionId);
		if (refreshing !== undefined) await refreshing.catch(() => null);
		// Compare-and-set: credentials replaced since the failed call are not marked (connectors 9.2).
		this.#sql.exec("UPDATE connections SET status = 'error', updated_at = ? WHERE id = ? AND status = 'active' AND generation = ?", this.#now(), connectionId, generation);
	}

	// Credential leases (plan: Credentials and refresh; connectors 9.3).

	/** The purpose's checks, then the connection's: a refusal, or the row to lend. Synchronous. */
	#leaseCheck(connectionId: ConnectionId, purpose: { run: RunId; userId: UserId } | { settings: Caller }): { refusal: LeaseRefusal } | { row: ConnectionRow } {
		const unauthorized = { refusal: { refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED } } as const;
		let userId: UserId;
		if ("run" in purpose) {
			const run = this.#run(purpose.run);
			if (run === null || run.state !== "active" || run.revoked !== null || run.user_id !== purpose.userId) {
				return { refusal: { refused: "RUN_ENDED", message: RUN_ENDED } };
			}
			if (!jsonList(run.connection_ids).includes(connectionId)) return unauthorized;
			userId = run.user_id;
		} else {
			userId = purpose.settings.userId;
		}
		const row = this.#connection(connectionId);
		if (row === null || (row.owner_id !== null && row.owner_id !== userId) || row.status !== "active") return unauthorized;
		return { row };
	}

	#leaseOf(row: ConnectionRow): CredentialLease {
		return {
			connectionId: row.id,
			provider: row.provider,
			generation: row.generation,
			sealed: sealedOf(row),
			scopes: row.scopes === null ? null : jsonList(row.scopes),
		};
	}

	async lease(connectionId: ConnectionId, purpose: { run: RunId; userId: UserId } | { settings: Caller }): Promise<LeaseAnswer> {
		for (let round = 0; round < 4; round++) {
			const checked = this.#leaseCheck(connectionId, purpose);
			if ("refusal" in checked) return checked.refusal;
			const { row } = checked;
			// While a refresh is recorded or its outcome is unknown, nothing else uses the connection: every
			// lease waits for the one flight.
			if (row.refresh_state === "fresh" && !needsRefresh(row.expires_at, this.#now())) return this.#leaseOf(row);
			const outcome = await this.#refreshFlight(connectionId);
			if (outcome.kind === "expired") return { refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED };
			if (outcome.kind === "unavailable") return { refused: "PROVIDER_UNAVAILABLE", message: outcome.message };
			if (outcome.kind === "refreshed") {
				// A token that expires soon again is still lent: one refresh per lease, as today.
				const after = this.#leaseCheck(connectionId, purpose);
				if ("refusal" in after) return after.refusal;
				if (after.row.generation === outcome.generation && after.row.refresh_state === "fresh") return this.#leaseOf(after.row);
			}
		}
		return { refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED };
	}

	/** The one refresh of a connection in flight, joined by every lease that needs it. */
	#refreshFlight(connectionId: ConnectionId): Promise<RefreshOutcome> {
		const running = this.#refreshes.get(connectionId);
		if (running) return running;
		const flight = this.#refresh(connectionId).finally(() => this.#refreshes.delete(connectionId));
		this.#refreshes.set(connectionId, flight);
		return flight;
	}

	async #refresh(connectionId: ConnectionId): Promise<RefreshOutcome> {
		const row = this.#connection(connectionId);
		if (row === null || row.status !== "active") return { kind: "moved" };
		const generation = row.generation;
		const connector = this.#registry.find(row.provider);
		if (connector === null) return { kind: "expired" };
		const tokens = asPayload(await this.#deps.keys.decrypt(sealedOf(row)));
		const plan = await planRefresh(connector, tokens, { clients: this.#deps.oauth, siteUrl: this.#deps.settings.siteUrl, fetch: this.#deps.fetch, now: () => this.#now(), log: this.#deps.log }, connectionId);
		if (plan.kind === "invalid") return this.#settleRefresh(connectionId, generation, { kind: "invalid" });
		// Recorded at generation g before the token endpoint is called, so a restart from here on knows the
		// provider may have rotated the refresh token. The platform holds the request until this is stored.
		const marked = this.#commit(() => {
			const current = this.#connection(connectionId);
			if (current === null || current.generation !== generation || current.status !== "active") return false;
			this.#sql.exec("UPDATE connections SET refresh_state = 'refreshing', refresh_generation = ? WHERE id = ?", generation, connectionId);
			return true;
		});
		if (!marked) return { kind: "moved" };
		const result = await plan.send();
		if (result.kind !== "refreshed") return this.#settleRefresh(connectionId, generation, result);
		const sealed = await this.#deps.keys.encrypt(result.payload);
		const now = this.#now();
		return this.#commit((): RefreshOutcome => {
			const current = this.#connection(connectionId);
			// A reconnect or a delete during the refresh wins: its result is dropped.
			if (current === null || current.generation !== generation || current.refresh_state !== "refreshing" || current.refresh_generation !== generation) {
				return { kind: "moved" };
			}
			this.#writeCredentials(connectionId, sealed, result.payload, generation + 1, now);
			return { kind: "refreshed", generation: generation + 1 };
		});
	}

	/** Records a refresh that did not produce tokens, if the credentials are still the ones it used. */
	#settleRefresh(connectionId: ConnectionId, generation: number, result: Exclude<RefreshResult, { kind: "refreshed" }>): RefreshOutcome {
		const now = this.#now();
		return this.#commit((): RefreshOutcome => {
			const current = this.#connection(connectionId);
			if (current === null || current.generation !== generation) return { kind: "moved" };
			if (result.kind === "invalid") {
				// "Needs reconnecting" (connectors 9.3).
				this.#sql.exec("UPDATE connections SET status = 'error', refresh_state = 'fresh', refresh_generation = NULL, updated_at = ? WHERE id = ?", now, connectionId);
				return { kind: "expired" };
			}
			// A provider that answered left the connection unchanged. One that may not have been reached may
			// have rotated the refresh token, so the next use makes exactly one refresh with the stored one.
			const state = result.reached ? "fresh" : "refresh_uncertain";
			this.#sql.exec("UPDATE connections SET refresh_state = ?, refresh_generation = NULL WHERE id = ?", state, connectionId);
			return { kind: "unavailable", message: result.message };
		});
	}

	// Agents (web-api 8.3).

	#agentRow(id: AgentId): AgentRow | null {
		return first<AgentRow>(this.#sql, "SELECT * FROM agents WHERE id = ?", id);
	}

	#agentConnectionIds(agentId: AgentId): string[] {
		return this.#sql
			.exec<{ id: string }>(
				"SELECT c.id FROM agent_connections a JOIN connections c ON c.id = a.connection_id WHERE a.agent_id = ? ORDER BY c.created_at, c.id",
				agentId,
			)
			.map((row) => row.id);
	}

	#agentView(row: AgentRow): AgentView {
		return { id: row.id, ownerId: row.owner_id, name: row.name, instructions: row.instructions, connectionIds: this.#agentConnectionIds(row.id), createdAt: row.created_at };
	}

	/**
	 * `_connections`: every id names a connection of the workspace, and every added one (not kept from
	 * before) is usable by the editor. Ones the agent already has may stay as they are, so a connection that
	 * needs reconnecting, or belongs to someone else, does not block other changes.
	 */
	#chosenConnections(caller: Caller, ids: readonly string[], kept: ReadonlySet<string>): string[] | null {
		const wanted = [...new Set(ids)];
		const found = this.#sql.exec<ConnectionRow>("SELECT * FROM connections WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(wanted));
		const added = found.filter((row) => !kept.has(row.id));
		if (found.length !== wanted.length || added.some((row) => !usableBy(row, caller.userId))) return null;
		return found.map((row) => row.id);
	}

	#setAgentConnections(agentId: AgentId, connectionIds: readonly string[]): void {
		this.#sql.exec("DELETE FROM agent_connections WHERE agent_id = ?", agentId);
		for (const id of connectionIds) this.#sql.exec("INSERT INTO agent_connections (agent_id, connection_id) VALUES (?, ?)", agentId, id);
	}

	async listAgents(caller: Caller): Promise<AgentOut[]> {
		return this.#sql.exec<AgentRow>("SELECT * FROM agents ORDER BY created_at, id").map((row) => agentOut(caller, this.#agentView(row)));
	}

	async getAgent(caller: Caller, agentId: AgentId): Promise<AgentOut | null> {
		const row = this.#agentRow(agentId);
		return row === null ? null : agentOut(caller, this.#agentView(row));
	}

	async createAgent(caller: Caller, input: AgentIn): Promise<Outcome<AgentOut>> {
		const fields = agentFields(input);
		const now = this.#now();
		const row = this.#commit(() => {
			const connections = this.#chosenConnections(caller, fields.connectionIds, new Set());
			if (connections === null) return null;
			const id = uuid7(now);
			this.#sql.exec(
				"INSERT INTO agents (id, owner_id, name, instructions, model_alias, created_at, updated_at) VALUES (?, ?, ?, ?, 'default', ?, ?)",
				id,
				caller.userId,
				fields.name,
				fields.instructions,
				now,
				now,
			);
			this.#setAgentConnections(id, connections);
			return this.#agentRow(id) as AgentRow;
		});
		return row === null ? refuse(422, CHOOSE_CONNECTIONS) : ok(agentOut(caller, this.#agentView(row)));
	}

	/** `_editable`: 404, then 403 unless the caller owns the agent or administers the workspace. */
	#editable(caller: Caller, agentId: AgentId): Outcome<AgentRow> {
		const row = this.#agentRow(agentId);
		if (row === null) return refuse(404, NOT_FOUND);
		if (row.owner_id !== caller.userId && !isAdmin(caller)) return refuse(403, CANNOT_CHANGE);
		return ok(row);
	}

	async updateAgent(caller: Caller, agentId: AgentId, input: AgentIn): Promise<Outcome<{ agent: AgentOut; revocation: Revocation }>> {
		const editable = this.#editable(caller, agentId);
		if (!editable.ok) return editable;
		// A full replace: omitted fields reset to their defaults.
		const fields = agentFields(input);
		const now = this.#now();
		const saved = this.#commit((): { entries: number[]; agent: AgentOut } | null => {
			const before = new Set(this.#agentConnectionIds(agentId));
			const connections = this.#chosenConnections(caller, fields.connectionIds, before);
			if (connections === null) return null;
			this.#sql.exec("UPDATE agents SET name = ?, instructions = ?, updated_at = ? WHERE id = ?", fields.name, fields.instructions, now, agentId);
			this.#setAgentConnections(agentId, connections);
			const changed = connections.length !== before.size || connections.some((id) => !before.has(id));
			// A changed connection set stops the agent's runs, every user's; a rename leaves them alone.
			const entries = changed ? this.#revoke({ agentId }, "agent_connections_changed", now).entries : [];
			// As saved: the agent may change again, or go, while the cancels are delivered.
			return { entries, agent: agentOut(caller, this.#agentView(this.#agentRow(agentId) as AgentRow)) };
		});
		if (saved === null) return refuse(422, CHOOSE_CONNECTIONS);
		return ok({ agent: saved.agent, revocation: await this.#deliver(saved.entries) });
	}

	async deleteAgent(caller: Caller, agentId: AgentId): Promise<Outcome<{ revocation: Revocation }>> {
		const editable = this.#editable(caller, agentId);
		if (!editable.ok) return editable;
		const now = this.#now();
		const deleted = this.#commit((): { entries: number[]; conversations: string[] } | null => {
			const count = first<{ n: number }>(this.#sql, "SELECT count(*) AS n FROM agents") as { n: number };
			if (count.n <= 1) return null;
			const conversations = this.#sql
				.exec<{ id: string }>("SELECT id FROM conversations WHERE agent_id = ? AND deleted_at IS NULL", agentId)
				.map((row) => row.id);
			// Its runs stop as a plain cancel ("Stopped."), then its conversations go with it (runs 8).
			const entries = this.#revoke({ agentId }, "cancelled", now).entries;
			for (const id of conversations) this.#tombstone(id, now);
			this.#sql.exec("DELETE FROM agent_connections WHERE agent_id = ?", agentId);
			this.#sql.exec("DELETE FROM grants WHERE layer_id = ?", `agent:${agentId}`);
			this.#sql.exec("DELETE FROM layers WHERE id = ?", `agent:${agentId}`);
			this.#sql.exec("DELETE FROM agents WHERE id = ?", agentId);
			return { entries, conversations };
		});
		if (deleted === null) return refuse(422, KEEP_ONE_AGENT);
		const revocation = await this.#deliver(deleted.entries);
		await this.#purgeNow(deleted.conversations);
		return ok({ revocation });
	}

	// Conversations: an index only.

	#conversationRow(id: ConversationId): ConversationRow | null {
		return first<ConversationRow>(this.#sql, "SELECT * FROM conversations WHERE id = ?", id);
	}

	/** The caller's live conversation, or null. */
	#ownConversation(caller: Caller, id: ConversationId): ConversationRow | null {
		const row = this.#conversationRow(id);
		return row !== null && row.user_id === caller.userId && row.ready === 1 && row.deleted_at === null ? row : null;
	}

	/** Marks a conversation deleted, after which runs, uploads into it and object writes are refused, and queues its deletion. */
	#tombstone(conversationId: ConversationId, now: number): void {
		this.#sql.exec("UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", now, conversationId);
		this.#sql.exec("INSERT OR IGNORE INTO purges (conversation_id, requested_at, next_attempt_at) VALUES (?, ?, ?)", conversationId, now, now);
	}

	async createConversation(caller: Caller, agentId: AgentId): Promise<Outcome<ConversationOut>> {
		if (this.#agentRow(agentId) === null) return refuse(404, NOT_FOUND);
		const now = this.#now();
		const id = uuid7(now);
		const workspace = this.workspaceRef();
		// Recorded before its object is initialized: one whose initialization never finished is deleted.
		this.#commit(() => this.#sql.exec("INSERT INTO conversations (id, user_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, caller.userId, agentId, now, now));
		try {
			await this.#deps.conversations.init({ conversationId: id, workspace, userId: caller.userId, agentId, createdAt: now });
		} catch (error) {
			this.#commit(() => this.#tombstone(id, this.#now()));
			throw error;
		}
		const row = this.#commit(() => {
			const current = this.#conversationRow(id);
			// Its agent may have been deleted meanwhile, which deleted it too.
			if (current === null || current.deleted_at !== null || this.#agentRow(agentId) === null) return null;
			this.#sql.exec("UPDATE conversations SET ready = 1 WHERE id = ?", id);
			return current;
		});
		return row === null ? refuse(404, NOT_FOUND) : ok(conversationOut(row));
	}

	async listConversations(caller: Caller): Promise<ConversationOut[]> {
		return this.#sql
			.exec<ConversationRow>(
				"SELECT * FROM conversations WHERE user_id = ? AND ready = 1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 100",
				caller.userId,
			)
			.map(conversationOut);
	}

	async ownsConversation(caller: Caller, conversationId: ConversationId): Promise<boolean> {
		return this.#ownConversation(caller, conversationId) !== null;
	}

	async conversationTouched(conversationId: ConversationId, change: { title: string; updatedAt: number }): Promise<void> {
		this.#sql.exec(
			"UPDATE conversations SET title = ?, updated_at = max(updated_at, ?) WHERE id = ? AND deleted_at IS NULL",
			storable(change.title),
			change.updatedAt,
			conversationId,
		);
	}

	async deleteConversation(caller: Caller, conversationId: ConversationId): Promise<Outcome<{ revocation: Revocation }>> {
		if (this.#ownConversation(caller, conversationId) === null) return refuse(404, NOT_FOUND);
		const now = this.#now();
		const entries = this.#commit(() => {
			// Tombstone first: no new run starts in it from here on. Its active run stops as a plain cancel.
			const revoked = this.#revoke({ conversationId }, "cancelled", now).entries;
			this.#tombstone(conversationId, now);
			return revoked;
		});
		const revocation = await this.#deliver(entries);
		await this.#purgeNow([conversationId]);
		return ok({ revocation });
	}

	// Runs (plan: Starting a run).

	#run(id: RunId): RunRow | null {
		return first<RunRow>(this.#sql, "SELECT * FROM runs WHERE id = ?", id);
	}

	#storeAnswer(runId: RunId, answer: { snapshot: StartSnapshot; uploads: ReservedUpload[] }): void {
		splitParts(JSON.stringify(answer), VALUE_PART).forEach((text, part) => {
			this.#sql.exec("INSERT INTO run_answers (run_id, part, text) VALUES (?, ?, ?)", runId, part, text);
		});
	}

	#answer(runId: RunId): { snapshot: StartSnapshot; uploads: ReservedUpload[] } | null {
		const parts = this.#sql.exec<{ text: string }>("SELECT text FROM run_answers WHERE run_id = ? ORDER BY part", runId);
		if (parts.length === 0) return null;
		return parseJson(parts.map((part) => part.text).join("")) as unknown as { snapshot: StartSnapshot; uploads: ReservedUpload[] };
	}

	/**
	 * Expires a start not activated within ten minutes, whether or not the alarm has run yet: its uploads are
	 * attachable again, and a late answer cannot start it. Inside a transaction; returns whether it expired.
	 */
	#expireOverdue(run: RunRow, now: number): boolean {
		if (run.state !== "starting" || run.registered_at + START_TTL_MS > now) return false;
		this.#sql.exec("UPDATE runs SET state = 'expired', ended_at = ? WHERE id = ?", now, run.id);
		this.#sql.exec("UPDATE uploads SET run_id = NULL WHERE run_id = ?", run.id);
		this.#sql.exec("DELETE FROM run_answers WHERE run_id = ?", run.id);
		return true;
	}

	/** A repeated beginRun: the same answer, unless the run was revoked, expired or released since. */
	#repeatBegin(run: RunRow, input: BeginRunInput, now: number): BeginRunResult {
		if (run.conversation_id !== input.conversationId || run.user_id !== input.userId || run.agent_id !== input.agentId) {
			throw new Error("A run id was reused for another start.");
		}
		if (run.revoked !== null) return refuse(409, stopMessage(run.revoked));
		if (this.#expireOverdue(run, now)) return refuse(503, START_FAILED);
		const answer = run.state === "starting" || run.state === "active" ? this.#answer(run.id) : null;
		if (answer === null) return refuse(503, START_FAILED);
		return ok(answer);
	}

	/** `uploads.attach`'s checks, in its order (files 10, steps 3 to 5). */
	#attachable(input: BeginRunInput): Outcome<UploadRow[]> {
		const ids = input.uploadIds;
		const { messageAttachments } = this.#deps.settings;
		if (ids.length === 0) return ok([]);
		if (ids.length > messageAttachments) return refuse(400, tooManyAttachments(messageAttachments));
		if (new Set(ids).size !== ids.length) return refuse(400, ATTACHED_TWICE);
		// The user's own, complete and not reserved by another start; another user's, a pending or a deleted
		// one is simply not there.
		const rows = this.#sql.exec<UploadRow>(
			"SELECT * FROM uploads WHERE id IN (SELECT value FROM json_each(?)) AND user_id = ? AND state = 'complete' AND run_id IS NULL",
			JSON.stringify(ids),
			input.userId,
		);
		if (rows.length !== ids.length) return refuse(400, NO_LONGER_AVAILABLE);
		const byId = new Map(rows.map((row) => [row.id, row]));
		return ok(ids.map((id) => byId.get(id) as UploadRow));
	}

	async beginRun(input: BeginRunInput): Promise<BeginRunResult> {
		const now = this.#now();
		const { folderBytes, folderEntries, runTimeoutMs } = this.#deps.settings;
		// One synchronous transaction from the first check to the registration, so a grant change processed
		// afterwards revokes this run, and one processed before is in its snapshot (connectors 4.4).
		return this.#commit((): BeginRunResult => {
			const existing = this.#run(input.runId);
			if (existing !== null) return this.#repeatBegin(existing, input, now);
			const conversation = this.#conversationRow(input.conversationId);
			if (
				conversation === null ||
				conversation.ready !== 1 ||
				conversation.deleted_at !== null ||
				conversation.user_id !== input.userId ||
				conversation.agent_id !== input.agentId
			) {
				return refuse(404, NOT_FOUND);
			}
			const agent = this.#agentRow(input.agentId);
			if (agent === null) return refuse(404, NOT_FOUND);
			const attachable = this.#attachable(input);
			if (!attachable.ok) return attachable;
			const uploads = attachable.value;
			if (uploads.length) {
				// Each attachment is a new file at the folder's root: one entry, and its pages (files 10, step 8).
				if (input.folder.entries + uploads.length > folderEntries) return refuse(413, overFolder("folder_entries", folderEntries, folderBytes));
				const bytes = input.folder.bytes + uploads.reduce((sum, upload) => sum + pages(upload.size), 0);
				if (bytes > folderBytes) return refuse(413, overFolder("folder_bytes", folderEntries, folderBytes));
			}
			this.#ensureUserLayer(input.userId, now);
			const workspace = this.workspaceRef();
			const connections = this.#sql.exec<ConnectionRow>(
				"SELECT c.* FROM agent_connections a JOIN connections c ON c.id = a.connection_id WHERE a.agent_id = ?",
				agent.id,
			);
			const providers = new Map(this.#sql.exec<{ id: string; provider: string }>("SELECT id, provider FROM connections").map((row) => [row.id, row.provider]));
			const snapshot = startSnapshot(this.#registry, {
				workspaceId: workspace.id,
				conversationId: input.conversationId,
				userId: input.userId,
				agent: { id: agent.id, instructions: agent.instructions, modelAlias: agent.model_alias },
				connections: connections.map((row) => this.#info(row)),
				layers: { ceiling: this.#layer("ceiling"), user: this.#layer(`user:${input.userId}`), agent: this.#layer(`agent:${agent.id}`) },
				providerOf: (id) => providers.get(id) ?? null,
				createdAt: now,
				runTimeoutMs,
			});
			this.#sql.exec(
				"INSERT INTO runs (id, conversation_id, user_id, agent_id, connection_ids, state, registered_at) VALUES (?, ?, ?, ?, ?, 'starting', ?)",
				input.runId,
				input.conversationId,
				input.userId,
				agent.id,
				JSON.stringify(snapshot.connectionIds),
				now,
			);
			for (const upload of uploads) this.#sql.exec("UPDATE uploads SET run_id = ? WHERE id = ?", input.runId, upload.id);
			const reserved: ReservedUpload[] = uploads.map((upload) => ({
				id: upload.id,
				name: upload.name,
				size: upload.size,
				mediaType: upload.media_type as string,
				sha256: upload.sha256 as Sha256,
				key: upload.key,
			}));
			const answer = { snapshot, uploads: reserved };
			this.#storeAnswer(input.runId, answer);
			return ok(answer);
		});
	}

	async activate(runId: RunId): Promise<Registration> {
		const now = this.#now();
		return this.#commit((): Registration => {
			const run = this.#run(runId);
			if (run === null || run.state === "expired" || this.#expireOverdue(run, now)) return { state: "expired" };
			if (run.state === "ended") return { state: "ended" };
			if (run.state === "starting") {
				// The run is stored with copies of its own: the uploads are consumed, their objects deleted.
				for (const upload of this.#sql.exec<{ id: string; key: string }>("SELECT id, key FROM uploads WHERE run_id = ?", runId)) {
					this.#doom(upload.key, now);
					this.#sql.exec("DELETE FROM uploads WHERE id = ?", upload.id);
				}
				this.#sql.exec("UPDATE runs SET state = 'active', activated_at = ? WHERE id = ?", now, runId);
			}
			return run.revoked !== null ? { state: "revoked", reason: run.revoked } : { state: "active" };
		});
	}

	/** Ends a run in the registry: reservations not consumed are released, cancels still owed are moot. */
	#endRun(runId: RunId, status: string, now: number): void {
		const run = this.#run(runId);
		if (run === null || run.state === "ended" || run.state === "expired") return;
		this.#sql.exec("UPDATE runs SET state = 'ended', ended_at = ?, end_status = ? WHERE id = ?", now, status, runId);
		this.#sql.exec("UPDATE uploads SET run_id = NULL WHERE run_id = ?", runId);
		this.#sql.exec("DELETE FROM run_answers WHERE run_id = ?", runId);
		// A run that ended can make no further request: its cancel needs no acknowledgement any more.
		this.#sql.exec("UPDATE outbox SET acknowledged_at = ?, ack_state = 'ended' WHERE run_id = ? AND acknowledged_at IS NULL", now, runId);
	}

	async release(runId: RunId, status: RunStatus | "refused"): Promise<void> {
		const now = this.#now();
		this.#commit(() => this.#endRun(runId, status, now));
	}

	async locateRun(caller: Caller, runId: RunId): Promise<{ conversationId: ConversationId } | null> {
		const run = this.#run(runId);
		if (run === null || run.user_id !== caller.userId) return null;
		const conversation = this.#conversationRow(run.conversation_id);
		return conversation === null || conversation.deleted_at !== null ? null : { conversationId: run.conversation_id };
	}

	// Strict revocation (plan: Strict revocation).

	/**
	 * In the change's own transaction: marks every matching registered run revoked and writes one outbox
	 * entry per run. A run already revoked keeps its first reason, and its cancels still owed are waited for
	 * too. Returns the entries to wait for and how many runs matched.
	 */
	#revoke(match: RunMatch, reason: CancelReason, now: number): { entries: number[]; runs: number } {
		const clauses = ["state IN ('starting', 'active')"];
		const bindings: SqlValue[] = [];
		for (const [column, value] of [
			["user_id", match.userId],
			["agent_id", match.agentId],
			["conversation_id", match.conversationId],
		] as const) {
			if (value === undefined) continue;
			clauses.push(`${column} = ?`);
			bindings.push(value);
		}
		const runs = this.#sql.exec<RunRow>(`SELECT * FROM runs WHERE ${clauses.join(" AND ")} ORDER BY registered_at, id`, ...bindings);
		const entries: number[] = [];
		for (const run of runs) {
			if (run.revoked === null) {
				this.#sql.exec("UPDATE runs SET revoked = ? WHERE id = ?", reason, run.id);
				const [entry] = this.#sql.exec<{ id: number }>(
					"INSERT INTO outbox (run_id, conversation_id, reason, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
					run.id,
					run.conversation_id,
					reason,
					now,
					now,
				);
				entries.push((entry as { id: number }).id);
			} else {
				for (const owed of this.#sql.exec<{ id: number }>("SELECT id FROM outbox WHERE run_id = ? AND acknowledged_at IS NULL", run.id)) entries.push(owed.id);
			}
		}
		return { entries, runs: runs.length };
	}

	#entry(id: number): OutboxRow | null {
		return first<OutboxRow>(this.#sql, "SELECT * FROM outbox WHERE id = ?", id);
	}

	#acknowledged(ids: readonly number[]): boolean {
		return ids.every((id) => this.#entry(id)?.acknowledged_at != null);
	}

	/**
	 * Delivers the entries and waits for every acknowledgement, retrying failures, for at most 10 s; then the
	 * change is saved but `pending`, and the alarm keeps delivering.
	 */
	async #deliver(ids: readonly number[]): Promise<Revocation> {
		const deadline = this.#now() + BARRIER_MS;
		for (;;) {
			const owed = ids.filter((id) => this.#entry(id)?.acknowledged_at == null);
			if (owed.length === 0) return "acknowledged";
			const left = deadline - this.#now();
			if (left <= 0) return "pending";
			const timer = this.#deps.timers.delay(left);
			let settled = false;
			try {
				await Promise.race([Promise.all(owed.map((id) => this.#deliverOne(id))).then(() => (settled = true)), timer.promise]);
			} finally {
				timer.cancel();
			}
			if (this.#acknowledged(ids)) return "acknowledged";
			if (!settled) return "pending";
			const pause = this.#deps.timers.delay(Math.max(0, Math.min(RETRY_PAUSE_MS, deadline - this.#now())));
			await pause.promise;
		}
	}

	/** One delivery of an entry; concurrent callers share it. Never throws: a failure is retried later. */
	#deliverOne(id: number): Promise<void> {
		const running = this.#deliveries.get(id);
		if (running) return running;
		const flight = (async () => {
			const entry = this.#entry(id);
			if (entry === null || entry.acknowledged_at !== null) return;
			try {
				const ack = await this.#within(this.#deps.conversations.cancel(entry.conversation_id, entry.run_id, entry.reason, entry.id), CALL_TIMEOUT_MS);
				this.#acknowledge(entry, ack.state);
			} catch (error) {
				this.#commit(() =>
					this.#sql.exec(
						"UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND acknowledged_at IS NULL",
						this.#now() + backoff(entry.attempts),
						id,
					),
				);
				this.#deps.log("A cancel was not acknowledged", { entry: id, run: entry.run_id, error: String(error) });
			}
		})().finally(() => this.#deliveries.delete(id));
		this.#deliveries.set(id, flight);
		return flight;
	}

	#acknowledge(entry: OutboxRow, state: CancelAck["state"]): void {
		const now = this.#now();
		this.#commit(() => {
			this.#sql.exec("UPDATE outbox SET acknowledged_at = ?, ack_state = ? WHERE id = ? AND acknowledged_at IS NULL", now, state, entry.id);
			if (state === "ended") this.#endRun(entry.run_id, "ended", now);
		});
	}

	async acknowledgeCancel(entryId: number, runId: RunId): Promise<void> {
		const entry = this.#entry(entryId);
		if (entry !== null && entry.run_id === runId) this.#acknowledge(entry, "stopping");
	}

	async emergencyStop(reason: string): Promise<{ runs: number; revocation: Revocation }> {
		const now = this.#now();
		const revoked = this.#commit(() => this.#revoke({}, "emergency_stop", now));
		this.#deps.log("Emergency stop", { reason, runs: revoked.runs });
		return { runs: revoked.runs, revocation: await this.#deliver(revoked.entries) };
	}

	async #within<T>(promise: Promise<T>, ms: number): Promise<T> {
		const timer = this.#deps.timers.delay(ms);
		try {
			return await Promise.race([
				promise,
				timer.promise.then((): never => {
					throw new Error(`No answer within ${ms} ms.`);
				}),
			]);
		} finally {
			timer.cancel();
		}
	}

	// Deletion (plan: Files, Deletion): once every cancel of the conversation is acknowledged, its object
	// destroys itself (its run ended, storage and R2 prefix deleted); then again an hour later.

	async #purgeNow(conversationIds: readonly ConversationId[]): Promise<void> {
		if (conversationIds.length === 0) return;
		const timer = this.#deps.timers.delay(CALL_TIMEOUT_MS);
		try {
			await Promise.race([Promise.all(conversationIds.map((id) => this.#purge(id))), timer.promise]);
		} finally {
			timer.cancel();
		}
	}

	#purge(conversationId: ConversationId): Promise<void> {
		const running = this.#purges.get(conversationId);
		if (running) return running;
		const flight = this.#purgeOnce(conversationId).finally(() => this.#purges.delete(conversationId));
		this.#purges.set(conversationId, flight);
		return flight;
	}

	async #purgeOnce(conversationId: ConversationId): Promise<void> {
		const row = first<PurgeRow>(this.#sql, "SELECT * FROM purges WHERE conversation_id = ?", conversationId);
		if (row === null || row.done_at !== null) return;
		// The second deletion waits its hour, whoever asks: it is there for a write that was still in flight.
		if (row.first_done_at !== null && row.next_attempt_at > this.#now()) return;
		const owed = this.#sql.exec<{ id: number }>("SELECT id FROM outbox WHERE conversation_id = ? AND acknowledged_at IS NULL", conversationId);
		if (owed.length) {
			await Promise.all(owed.map((entry) => this.#deliverOne(entry.id)));
			if (!this.#acknowledged(owed.map((entry) => entry.id))) {
				this.#retryPurge(conversationId, row.attempts);
				return;
			}
		}
		let done: boolean;
		try {
			done = (await this.#within(this.#deps.conversations.destroy(conversationId), CALL_TIMEOUT_MS)).done;
		} catch (error) {
			this.#deps.log("A conversation could not be destroyed yet", { conversation: conversationId, error: String(error) });
			done = false;
		}
		if (!done) {
			this.#retryPurge(conversationId, row.attempts);
			return;
		}
		const now = this.#now();
		this.#commit(() => {
			if (row.first_done_at === null) {
				// Its blobs are gone: they no longer count against the workspace.
				this.#sql.exec("UPDATE purges SET first_done_at = ?, attempts = 0, next_attempt_at = ? WHERE conversation_id = ?", now, now + PURGE_AGAIN_MS, conversationId);
				this.#sql.exec("UPDATE conversations SET bytes = 0 WHERE id = ?", conversationId);
			} else {
				this.#sql.exec("UPDATE purges SET done_at = ? WHERE conversation_id = ?", now, conversationId);
			}
		});
	}

	#retryPurge(conversationId: ConversationId, attempts: number): void {
		this.#commit(() =>
			this.#sql.exec("UPDATE purges SET attempts = attempts + 1, next_attempt_at = ? WHERE conversation_id = ?", this.#now() + backoff(attempts), conversationId),
		);
	}

	// Uploads and bytes (files 9, 12; plan: Files).

	#doom(key: string, now: number): void {
		this.#sql.exec("INSERT INTO doomed_objects (key, due_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET due_at = min(due_at, excluded.due_at)", key, now);
	}

	/** The workspace's bytes: every conversation's absolute total and every upload's size or reservation. */
	usedBytes(): number {
		const row = first<{ n: number }>(
			this.#sql,
			"SELECT (SELECT coalesce(sum(bytes), 0) FROM conversations) + (SELECT coalesce(sum(size), 0) FROM uploads) AS n",
		) as { n: number };
		return row.n;
	}

	#fits(extra: number): boolean {
		const limit = this.#deps.settings.workspaceBytes;
		return limit === null || this.usedBytes() + extra <= limit;
	}

	async reserveUpload(caller: Caller, upload: { name: string; size: number }): Promise<Outcome<{ id: UploadId; key: string }>> {
		const now = this.#now();
		const workspace = this.workspaceRef();
		return this.#commit((): Outcome<{ id: UploadId; key: string }> => {
			// files 9.1 check 13: uploads still arriving; a pending one older than the body's deadline is not.
			const arriving = first<{ n: number }>(
				this.#sql,
				"SELECT count(*) AS n FROM uploads WHERE user_id = ? AND state = 'pending' AND created_at > ?",
				caller.userId,
				now - UPLOAD_DEADLINE_MS,
			) as { n: number };
			if (arriving.n >= UPLOADS_IN_FLIGHT) return refuse(429, UPLOADING_TOO_MANY);
			const held = first<{ n: number }>(this.#sql, "SELECT count(*) AS n FROM uploads WHERE user_id = ?", caller.userId) as { n: number };
			if (held.n >= PENDING_UPLOADS) return refuse(429, TOO_MANY_UPLOADS);
			// Reserved before the body is written, so concurrent uploads count each other (files 12.1, CHANGE:
			// every upload counts, where today's dedupe charged only new contents).
			if (!this.#fits(upload.size)) return refuse(413, NO_ROOM);
			const id = uuid7(now);
			const key = `uploads/${workspace.id}/${caller.userId}/${id}`;
			this.#sql.exec(
				"INSERT INTO uploads (id, user_id, name, size, state, key, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
				id,
				caller.userId,
				storable(upload.name),
				upload.size,
				key,
				now,
			);
			return ok({ id, key });
		});
	}

	async completeUpload(caller: Caller, id: UploadId, stored: { sha256: Sha256; size: number; mediaType: string }): Promise<Outcome<UploadOut>> {
		const now = this.#now();
		return this.#commit((): Outcome<UploadOut> => {
			const row = first<UploadRow>(this.#sql, "SELECT * FROM uploads WHERE id = ? AND user_id = ?", id, caller.userId);
			if (row === null) return refuse(404, NOT_FOUND);
			if (row.state === "pending") {
				if (stored.size > row.size && !this.#fits(stored.size - row.size)) return refuse(413, NO_ROOM);
				this.#sql.exec(
					"UPDATE uploads SET state = 'complete', sha256 = ?, size = ?, media_type = ?, completed_at = ? WHERE id = ?",
					stored.sha256,
					stored.size,
					stored.mediaType,
					now,
					id,
				);
			}
			const current = first<UploadRow>(this.#sql, "SELECT * FROM uploads WHERE id = ?", id) as UploadRow;
			return ok({ id: current.id, name: current.name, size: current.size, media_type: current.media_type as string });
		});
	}

	/** Deletes the caller's upload unless a start has reserved it; its object goes with the next alarm. */
	#dropUpload(caller: Caller, id: UploadId): void {
		const now = this.#now();
		this.#commit(() => {
			const row = first<UploadRow>(this.#sql, "SELECT * FROM uploads WHERE id = ? AND user_id = ? AND run_id IS NULL", id, caller.userId);
			if (row === null) return;
			this.#doom(row.key, now);
			this.#sql.exec("DELETE FROM uploads WHERE id = ?", id);
		});
	}

	async abandonUpload(caller: Caller, id: UploadId): Promise<void> {
		this.#dropUpload(caller, id);
	}

	async deleteUpload(caller: Caller, id: UploadId): Promise<void> {
		this.#dropUpload(caller, id);
	}

	async setConversationBytes(conversationId: ConversationId, total: number, revision?: number): Promise<{ ok: true } | { ok: false; limit: Extract<FolderLimit, "workspace"> }> {
		if (revision !== undefined && !(Number.isSafeInteger(revision) && revision >= 1)) throw new TypeError("A byte report's revision is a positive integer.");
		return this.#commit((): { ok: true } | { ok: false; limit: "workspace" } => {
			const row = this.#conversationRow(conversationId);
			if (row === null) return { ok: false, limit: "workspace" };
			// Sent before a report already seen, by an instance of the conversation that has since reset: the
			// newer one stands. Answered as accepted, since nobody acts on it.
			// One without a revision, from an older caller, applies only until the first with one has been seen.
			if (revision === undefined ? row.bytes_revision > 0 : revision <= row.bytes_revision) return { ok: true };
			if (revision !== undefined) this.#sql.exec("UPDATE conversations SET bytes_revision = ? WHERE id = ?", revision, conversationId);
			// The uploads a start of this conversation reserved are being copied into it, and are consumed when
			// it is activated: counted once, as attaching them is today, not as the upload and its copy.
			const moving = first<{ n: number }>(
				this.#sql,
				"SELECT coalesce(sum(u.size), 0) AS n FROM uploads u JOIN runs r ON r.id = u.run_id WHERE r.conversation_id = ? AND r.state = 'starting'",
				conversationId,
			) as { n: number };
			// Shrinking is always allowed; a deleted conversation writes nothing new.
			if (total > row.bytes && (row.deleted_at !== null || !this.#fits(total - row.bytes - moving.n))) return { ok: false, limit: "workspace" };
			this.#sql.exec("UPDATE conversations SET bytes = ? WHERE id = ?", total, conversationId);
			return { ok: true };
		});
	}

	// The alarm.

	/** When the alarm should next run: the earliest due outbox entry, expiry, sweep, deletion or purge. */
	nextWake(): number | null {
		// One query each: a Durable Object's SQLite allows only a few terms in a compound SELECT.
		const due = (query: string, ...bindings: SqlValue[]) => first<{ t: number | null }>(this.#sql, query, ...bindings)?.t ?? null;
		const times = [
			due("SELECT min(next_attempt_at) AS t FROM outbox WHERE acknowledged_at IS NULL"),
			due("SELECT min(registered_at) + ? AS t FROM runs WHERE state = 'starting'", START_TTL_MS),
			due("SELECT min(created_at) + ? AS t FROM uploads WHERE state = 'pending'", PENDING_UPLOAD_LIFETIME_MS),
			due("SELECT min(created_at) + ? AS t FROM uploads WHERE state = 'complete' AND run_id IS NULL", UPLOAD_LIFETIME_MS),
			due("SELECT min(due_at) AS t FROM doomed_objects"),
			due("SELECT min(next_attempt_at) AS t FROM purges WHERE done_at IS NULL"),
			due("SELECT min(created_at) + ? AS t FROM conversations WHERE ready = 0 AND deleted_at IS NULL", CREATE_TTL_MS),
		].filter((time) => time !== null);
		return times.length ? Math.min(...times) : null;
	}

	/** Everything that is due: expiries and sweeps in one transaction, then deliveries, deletions and purges. */
	async alarm(): Promise<void> {
		const now = this.#now();
		this.#commit(() => {
			// Starts not activated within ten minutes: expired, so a late beginRun answer cannot start them,
			// and their uploads are attachable again.
			for (const run of this.#sql.exec<RunRow>("SELECT * FROM runs WHERE state = 'starting' AND registered_at + ? <= ?", START_TTL_MS, now)) {
				this.#expireOverdue(run, now);
			}
			const stale = this.#sql.exec<{ id: string; key: string }>(
				"SELECT id, key FROM uploads WHERE (state = 'pending' AND created_at + ? <= ?) OR (state = 'complete' AND run_id IS NULL AND created_at + ? <= ?)",
				PENDING_UPLOAD_LIFETIME_MS,
				now,
				UPLOAD_LIFETIME_MS,
				now,
			);
			for (const upload of stale) {
				this.#doom(upload.key, now);
				this.#sql.exec("DELETE FROM uploads WHERE id = ?", upload.id);
			}
			for (const row of this.#sql.exec<{ id: string }>("SELECT id FROM conversations WHERE ready = 0 AND deleted_at IS NULL AND created_at + ? <= ?", CREATE_TTL_MS, now)) {
				this.#tombstone(row.id, now);
			}
		});
		const due = this.#sql.exec<{ id: number }>("SELECT id FROM outbox WHERE acknowledged_at IS NULL AND next_attempt_at <= ?", now);
		const purges = this.#sql.exec<{ conversation_id: string }>("SELECT conversation_id FROM purges WHERE done_at IS NULL AND next_attempt_at <= ?", now);
		await Promise.all([...due.map((entry) => this.#deliverOne(entry.id)), this.#deleteDoomed(now), ...purges.map((row) => this.#purge(row.conversation_id))]);
	}

	async #deleteDoomed(now: number): Promise<void> {
		const rows = this.#sql.exec<{ key: string; attempts: number }>("SELECT key, attempts FROM doomed_objects WHERE due_at <= ? ORDER BY due_at LIMIT 1000", now);
		if (rows.length === 0) return;
		const keys = rows.map((row) => row.key);
		try {
			await this.#deps.objects.delete(keys);
			this.#sql.exec("DELETE FROM doomed_objects WHERE key IN (SELECT value FROM json_each(?)) AND due_at <= ?", JSON.stringify(keys), now);
		} catch (error) {
			this.#deps.log("Objects could not be deleted yet", { count: keys.length, error: String(error) });
			this.#commit(() => {
				for (const row of rows) this.#sql.exec("UPDATE doomed_objects SET attempts = attempts + 1, due_at = ? WHERE key = ?", this.#now() + backoff(row.attempts), row.key);
			});
		}
	}
}

/** `usable_by(user)`: active, and shared or the user's own. */
function usableBy(row: ConnectionRow, userId: UserId): boolean {
	return row.status === "active" && (row.owner_id === null || row.owner_id === userId);
}

function sealedOf(row: ConnectionRow): Sealed {
	return { ciphertext: row.ciphertext, version: row.key_version };
}

function jsonScopes(payload: JsonObject): string | null {
	const scopes = scopesOf(payload);
	return scopes === null ? null : JSON.stringify(scopes);
}

/** AgentIn with its defaults: a PUT is a full replace (web-api 8.3). Validated by the Worker's schema. */
function agentFields(input: AgentIn): { name: string; instructions: string; connectionIds: string[] } {
	return { name: storable(input.name), instructions: storable(input.instructions ?? ""), connectionIds: input.connection_ids ?? [] };
}
