// The Workspace Durable Object: one per workspace (plan: Data placement), a thin wrapper around
// WorkspaceCore (core.ts), which holds the logic over the object's SQLite storage. It builds the core once
// per instance, before any event is delivered, passes every RPC through, and keeps the object's one alarm
// at the earliest time the core has work due (deliveries, expiries, sweeps, deletions).

import { DurableObject } from "cloudflare:workers";
import type { AccessOut, AgentIn, AgentOut, ConnectionOut, ConversationOut, UploadOut } from "../contracts/api.ts";
import type { AgentId, Caller, ConnectionId, ConversationId, Outcome, Revocation, RunId, Sha256, UploadId, UserId } from "../contracts/common.ts";
import type { FolderLimit } from "../contracts/files.ts";
import type { GrantChange } from "../contracts/policy.ts";
import type { RunStatus } from "../contracts/runs.ts";
import type { BeginRunInput, BeginRunResult, ConnectionAccount, Registration, SaveConnectionInput, WorkspaceApi, WorkspaceInit } from "../contracts/workspace.ts";
import { type About, identity } from "../lib/about.ts";
import { KeyRing } from "../lib/fernet.ts";
import { appliedMigrations } from "../lib/sqlite.ts";
import { connectorRegistry } from "../connectors/index.ts";
import { type LeaseAnswer, WorkspaceCore, type WorkspaceDeps } from "./core.ts";
import { conversationClient, oauthClients, objectStore, workspaceSettings } from "./env.ts";
import { realTimers } from "./ports.ts";
import { durableSql } from "../lib/sql.ts";

/**
 * Replaces some of the core's ports and builds it again, for platform tests through `runInDurableObject`
 * (a fake Conversation client, say). Keyed by a symbol, so Workers RPC cannot reach it.
 */
export const REPLACE_PORTS: unique symbol = Symbol("Workspace ports");

export type ReplaceablePorts = Partial<Pick<WorkspaceDeps, "conversations" | "objects" | "oauth" | "fetch" | "registry" | "timers" | "settings">>;

/**
 * The ports every Workspace object replaces, from the ones it would use: none in the Worker; the test build
 * (src/faults/) puts its fake provider and fault points here, as `PORTS` does for the Conversation.
 */
export const WORKSPACE_PORTS: { factory: (deps: WorkspaceDeps, ctx: DurableObjectState, env: Env) => ReplaceablePorts } = { factory: () => ({}) };

export class Workspace extends DurableObject<Env> implements WorkspaceApi {
	#core: WorkspaceCore | null = null;
	readonly #ready: Promise<void>;
	/** The alarm as this instance last set or read it; null when none is set. */
	#alarmAt: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#ready = ctx.blockConcurrencyWhile(() => this.#open({}));
	}

	async #open(replaced: ReplaceablePorts): Promise<void> {
		const keys = await KeyRing.parse(this.env.MINERVA_ENCRYPTION_KEYS);
		const workspace = () => (this.#core as WorkspaceCore).workspaceRef();
		const deps: WorkspaceDeps = {
			sql: durableSql(this.ctx.storage),
			timers: realTimers,
			keys,
			registry: await connectorRegistry(),
			settings: workspaceSettings(this.env),
			conversations: conversationClient(this.env, workspace),
			objects: objectStore(this.env, workspace),
			oauth: oauthClients(this.env, keys),
			fetch: (input, init) => fetch(input, init),
			log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
			wake: (at) => this.#wake(at),
		};
		this.#core = new WorkspaceCore({ ...deps, ...WORKSPACE_PORTS.factory(deps, this.ctx, this.env), ...replaced });
		this.#alarmAt = await this.ctx.storage.getAlarm();
		// An instance that died before it set the alarm left work due; this one sets it.
		await this.#reschedule();
	}

	/** Brings the alarm forward without awaiting: the write goes out with the transaction before it. */
	#wake(at: number): void {
		if (this.#alarmAt !== null && this.#alarmAt <= at) return;
		this.#alarmAt = at;
		// It fails only when the object is being reset, whose next instance sets the alarm from storage.
		this.ctx.storage.setAlarm(at).catch((error: unknown) => console.warn(`workspace: the alarm was not brought forward: ${String(error)}`));
	}

	async [REPLACE_PORTS](replaced: ReplaceablePorts): Promise<void> {
		await this.#ready;
		await this.#open(replaced);
	}

	/** Runs one call on the core, then sets the alarm for whatever it left due. */
	async #call<T>(body: (core: WorkspaceCore) => Promise<T>): Promise<T> {
		await this.#ready;
		try {
			return await body(this.#core as WorkspaceCore);
		} finally {
			await this.#reschedule();
		}
	}

	async #reschedule(): Promise<void> {
		const next = (this.#core as WorkspaceCore).nextWake();
		const current = await this.ctx.storage.getAlarm();
		this.#alarmAt = next;
		if (next === null) {
			if (current !== null) await this.ctx.storage.deleteAlarm();
		} else if (current !== next) {
			await this.ctx.storage.setAlarm(next);
		}
	}

	async alarm(): Promise<void> {
		// The platform cleared the alarm to run this.
		this.#alarmAt = null;
		await this.#call((core) => core.alarm());
	}

	/** What this object is and which schema steps it has; for checks and tests. */
	async about(): Promise<About<"workspace">> {
		await this.#ready;
		return { kind: "workspace", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}

	init(input: WorkspaceInit): Promise<void> {
		return this.#call((core) => core.init(input));
	}

	listAgents(caller: Caller): Promise<AgentOut[]> {
		return this.#call((core) => core.listAgents(caller));
	}

	getAgent(caller: Caller, agentId: AgentId): Promise<AgentOut | null> {
		return this.#call((core) => core.getAgent(caller, agentId));
	}

	createAgent(caller: Caller, input: AgentIn): Promise<Outcome<AgentOut>> {
		return this.#call((core) => core.createAgent(caller, input));
	}

	updateAgent(caller: Caller, agentId: AgentId, input: AgentIn): Promise<Outcome<{ agent: AgentOut; revocation: Revocation }>> {
		return this.#call((core) => core.updateAgent(caller, agentId, input));
	}

	deleteAgent(caller: Caller, agentId: AgentId): Promise<Outcome<{ revocation: Revocation }>> {
		return this.#call((core) => core.deleteAgent(caller, agentId));
	}

	listConnections(caller: Caller): Promise<ConnectionOut[]> {
		return this.#call((core) => core.listConnections(caller));
	}

	enableBuiltin(caller: Caller, provider: string): Promise<Outcome<ConnectionOut>> {
		return this.#call((core) => core.enableBuiltin(caller, provider));
	}

	saveConnection(caller: Caller, input: SaveConnectionInput): Promise<Outcome<ConnectionOut>> {
		return this.#call((core) => core.saveConnection(caller, input));
	}

	deleteConnection(caller: Caller, connectionId: ConnectionId): Promise<Outcome<{ revocation: Revocation }>> {
		return this.#call((core) => core.deleteConnection(caller, connectionId));
	}

	getAccess(caller: Caller, connectionId: ConnectionId): Promise<Outcome<AccessOut>> {
		return this.#call((core) => core.getAccess(caller, connectionId));
	}

	applyGrantChanges(
		caller: Caller,
		connectionId: ConnectionId,
		changes: GrantChange[],
		names: { [key: string]: string },
	): Promise<Outcome<{ access: AccessOut; revocation: Revocation }>> {
		return this.#call((core) => core.applyGrantChanges(caller, connectionId, changes, names));
	}

	allowedActions(caller: Caller, connectionId: ConnectionId): Promise<string[] | null> {
		return this.#call((core) => core.allowedActions(caller, connectionId));
	}

	connectionAccount(connectionId: ConnectionId): Promise<ConnectionAccount | null> {
		return this.#call((core) => core.connectionAccount(connectionId));
	}

	lease(connectionId: ConnectionId, purpose: { run: RunId; userId: UserId } | { settings: Caller }): Promise<LeaseAnswer> {
		return this.#call((core) => core.lease(connectionId, purpose));
	}

	markUnauthorized(connectionId: ConnectionId, generation: number): Promise<void> {
		return this.#call((core) => core.markUnauthorized(connectionId, generation));
	}

	beginRun(input: BeginRunInput): Promise<BeginRunResult> {
		return this.#call((core) => core.beginRun(input));
	}

	activate(runId: RunId): Promise<Registration> {
		return this.#call((core) => core.activate(runId));
	}

	release(runId: RunId, status: RunStatus | "refused"): Promise<void> {
		return this.#call((core) => core.release(runId, status));
	}

	locateRun(caller: Caller, runId: RunId): Promise<{ conversationId: ConversationId } | null> {
		return this.#call((core) => core.locateRun(caller, runId));
	}

	acknowledgeCancel(entryId: number, runId: RunId): Promise<void> {
		return this.#call((core) => core.acknowledgeCancel(entryId, runId));
	}

	emergencyStop(reason: string): Promise<{ runs: number; revocation: Revocation }> {
		return this.#call((core) => core.emergencyStop(reason));
	}

	createConversation(caller: Caller, agentId: AgentId): Promise<Outcome<ConversationOut>> {
		return this.#call((core) => core.createConversation(caller, agentId));
	}

	listConversations(caller: Caller): Promise<ConversationOut[]> {
		return this.#call((core) => core.listConversations(caller));
	}

	ownsConversation(caller: Caller, conversationId: ConversationId): Promise<boolean> {
		return this.#call((core) => core.ownsConversation(caller, conversationId));
	}

	conversationTouched(conversationId: ConversationId, change: { title: string; updatedAt: number }): Promise<void> {
		return this.#call((core) => core.conversationTouched(conversationId, change));
	}

	deleteConversation(caller: Caller, conversationId: ConversationId): Promise<Outcome<{ revocation: Revocation }>> {
		return this.#call((core) => core.deleteConversation(caller, conversationId));
	}

	reserveUpload(caller: Caller, upload: { name: string; size: number }): Promise<Outcome<{ id: UploadId; key: string }>> {
		return this.#call((core) => core.reserveUpload(caller, upload));
	}

	completeUpload(caller: Caller, id: UploadId, stored: { sha256: Sha256; size: number; mediaType: string }): Promise<Outcome<UploadOut>> {
		return this.#call((core) => core.completeUpload(caller, id, stored));
	}

	abandonUpload(caller: Caller, id: UploadId): Promise<void> {
		return this.#call((core) => core.abandonUpload(caller, id));
	}

	deleteUpload(caller: Caller, id: UploadId): Promise<void> {
		return this.#call((core) => core.deleteUpload(caller, id));
	}

	setConversationBytes(conversationId: ConversationId, total: number, revision?: number): Promise<{ ok: true } | { ok: false; limit: Extract<FolderLimit, "workspace"> }> {
		return this.#call((core) => core.setConversationBytes(conversationId, total, revision));
	}
}
