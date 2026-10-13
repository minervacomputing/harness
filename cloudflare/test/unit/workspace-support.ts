// Test support for the Workspace's logic (src/workspace/core.ts) over node:sqlite: the SQL surface, a clock
// that only moves when told, fake Conversation objects, a fake bucket, a fake token endpoint and a
// provider that rotates refresh tokens. `restart()` builds a new core over the same database, which is
// how the tests crash the object at a chosen point: what the old instance had in memory is gone, what it
// committed stays.

import { expect } from "vitest";
import { z } from "zod";
import type { CancelAck } from "../../src/conversation/conversation.ts";
import type { CancelReason } from "../../src/conversation/events.ts";
import type { ConversationInit } from "../../src/conversation/store.ts";
import { ACCOUNT_KIND, type Connector, type Prepared, defineOperation } from "../../src/gateway/connector.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { type Binding, EncryptionKeys, credentialBinding } from "../../src/lib/encryption.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import type { AccessOut } from "../../src/shared/api.ts";
import type { Caller, ConversationId, Outcome, RunId, UserId } from "../../src/shared/rpc.ts";
import { WorkspaceCore, type WorkspaceDeps } from "../../src/workspace/core.ts";
import type { ClientCredentials, ConversationClient, Delay, OAuthClients, ObjectStore, Timers, WorkspaceSettings } from "../../src/workspace/ports.ts";
import { type Sql, type SqlValue, sqliteSql } from "../../src/lib/sql.ts";
import { FakeServer, keyedConnector, mixedConnector } from "./fakes.ts";
import { openDatabase } from "./sqlite.ts";

export type Database = ReturnType<typeof openDatabase>;

export function database(): Database {
	return openDatabase();
}

/** lib/sql.ts's adapter over node:sqlite; nested transactions are savepoints, as transactionSync's are. */
export function nodeSql(db: Database): Sql {
	return sqliteSql(db);
}

// Node's, which the Workers' types do not declare.
const setImmediate = (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate;

/** Lets pending callbacks run, WebCrypto's included. */
export async function settle(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A clock that moves only on `advance`, which fires the delays that came due. */
export class FakeTimers implements Timers {
	current = Date.UTC(2026, 9, 12, 14, 3, 59);
	readonly #pending = new Set<{ at: number; resolve: () => void }>();

	now(): number {
		return this.current;
	}

	delay(ms: number): Delay {
		let entry: { at: number; resolve: () => void } | undefined;
		const promise = new Promise<void>((resolve) => {
			entry = { at: this.current + ms, resolve };
			this.#pending.add(entry);
		});
		return { promise, cancel: () => entry && this.#pending.delete(entry) };
	}

	/** How many delays are waiting. */
	get waiting(): number {
		return this.#pending.size;
	}

	async advance(ms: number): Promise<void> {
		this.current += ms;
		for (const entry of [...this.#pending].sort((a, b) => a.at - b.at)) {
			if (entry.at > this.current) continue;
			this.#pending.delete(entry);
			entry.resolve();
			await settle();
		}
		await settle();
	}
}

type CancelCall = { conversationId: ConversationId; runId: RunId; reason: CancelReason; entryId: number };

/**
 * Conversation objects as the outbox sees them. `stored` runs answer `stopping`, `ended` ones `ended`, others
 * `tombstoned`. `mode`: `answer`; `fail` (unreachable); `hang` (never answers); `lose` (stops the run, then
 * the answer is lost on the way back).
 */
export class FakeConversations implements ConversationClient {
	readonly inits: ConversationInit[] = [];
	readonly cancels: CancelCall[] = [];
	readonly destroyed: ConversationId[] = [];
	/** Runs the object has stopped (it set its local revoked flag), with the reason. */
	readonly stopped = new Map<RunId, CancelReason>();
	readonly stored = new Set<RunId>();
	readonly ended = new Set<RunId>();
	mode: "answer" | "fail" | "hang" | "lose" | "hold" = "answer";
	/** With `hold`, each cancel waits here until released. */
	readonly held: (() => void)[] = [];
	initFails = false;
	destroyDone = true;
	destroyFails = false;

	async init(input: ConversationInit): Promise<void> {
		if (this.initFails) throw new Error("The conversation object could not be reached.");
		this.inits.push(input);
	}

	async cancel(conversationId: ConversationId, runId: RunId, reason: CancelReason, entryId: number): Promise<CancelAck> {
		this.cancels.push({ conversationId, runId, reason, entryId });
		if (this.mode === "fail") throw new Error("The conversation object could not be reached.");
		if (this.mode === "hang") return new Promise<never>(() => {});
		if (this.mode === "hold") await new Promise<void>((resolve) => this.held.push(resolve));
		if (!this.stopped.has(runId)) this.stopped.set(runId, reason);
		const state = this.ended.has(runId) ? "ended" : this.stored.has(runId) ? "stopping" : "tombstoned";
		if (this.mode === "lose") throw new Error("The answer was lost.");
		return { runId, state };
	}

	async destroy(conversationId: ConversationId): Promise<{ done: boolean }> {
		this.destroyed.push(conversationId);
		if (this.destroyFails) throw new Error("The conversation object could not be reached.");
		return { done: this.destroyDone };
	}
}

export class FakeObjects implements ObjectStore {
	readonly deleted: string[] = [];
	fails = false;

	async delete(keys: string[]): Promise<void> {
		if (this.fails) throw new Error("R2 is unavailable.");
		this.deleted.push(...keys);
	}
}

export class FakeOAuth implements OAuthClients {
	readonly clients = new Map<string, { clientId: string; clientSecret: string }>([["mixed", { clientId: "id", clientSecret: "secret" }]]);
	readonly registered = new Map<string, ClientCredentials>();

	configured(app: string) {
		return this.clients.get(app) ?? null;
	}

	async stored(app: string, redirectUri: string) {
		return this.registered.get(`${app} ${redirectUri}`) ?? null;
	}
}

export interface Sent {
	url: string;
	method: string;
	headers: { [name: string]: string };
	body: string;
	fields: { [name: string]: string };
}

/**
 * Token endpoints: each request is recorded in `sent` and answered by `answer`, by default the next of
 * `responses` (a Response, an Error to throw, or a promise to wait for).
 */
export class TokenEndpoint {
	readonly sent: Sent[] = [];
	readonly responses: (Response | Error | Promise<Response>)[] = [];
	answer: (sent: Sent) => Promise<Response> = async () => {
		const next = this.responses.shift();
		if (next === undefined) throw new Error("No response was queued.");
		if (next instanceof Error) throw next;
		return next;
	};

	readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const body = typeof init?.body === "string" ? init.body : "";
		const fields = headers["content-type"] === "application/json" ? (parseJson(body) as { [name: string]: string }) : Object.fromEntries(new URLSearchParams(body));
		const sent = { url: String(input), method: init?.method ?? "GET", headers, body, fields };
		this.sent.push(sent);
		return this.answer(sent);
	};
}

export function tokens(body: JsonObject, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A provider that rotates refresh tokens (Atlassian, Xero, Slack, Linear): each refresh token works once and
 * is replaced; a spent one is refused with `invalid_grant`. `hold` keeps answers back until released.
 */
export class RotatingProvider {
	current = "r1";
	issued = 0;
	readonly spent: string[] = [];
	held: (() => void)[] = [];
	hold = false;

	async answer(sent: Sent): Promise<Response> {
		const token = sent.fields.refresh_token as string;
		if (token !== this.current) return tokens({ error: "invalid_grant" }, 400);
		this.spent.push(token);
		this.issued++;
		this.current = `r${this.issued + 1}`;
		const reply = tokens({ access_token: `a${this.issued + 1}`, refresh_token: this.current, expires_in: 3600 });
		if (!this.hold) return reply;
		await new Promise<void>((resolve) => this.held.push(resolve));
		return reply;
	}
}

export const USER: UserId = "0199a000-0000-7000-8000-0000000000aa";
export const OTHER: UserId = "0199a000-0000-7000-8000-0000000000bb";
export const WORKSPACE = "0199a000-0000-7000-8000-0000000000cc";
export const ADA: Caller = { userId: USER, role: "owner" };
export const GRACE: Caller = { userId: OTHER, role: "member" };

export const SETTINGS: WorkspaceSettings = {
	siteUrl: "http://localhost",
	runTimeoutMs: null,
	folderBytes: 268_435_456,
	folderEntries: 10_000,
	workspaceBytes: null,
	messageAttachments: 10,
};

/** A built-in service, as the Web is: added without signing in anywhere. */
export function builtinConnector(): Connector {
	const Lookup = z.strictObject({});
	return {
		slug: "webby",
		name: "Webby",
		kinds: [{ id: ACCOUNT_KIND, label: "Account", actions: ["read"] }],
		actions: [{ id: "read", label: "Read" }],
		auth: { type: "builtin" },
		operations: [
			defineOperation<z.output<typeof Lookup>>({
				name: "lookup",
				title: "Look up",
				description: "Looks something up.",
				input: Lookup,
				needs: [[ACCOUNT_KIND, "read"]],
				async prepare(binding): Promise<Prepared> {
					return { requirements: [{ need: binding.account(), action: "read" }], execute: async () => ({ records: [] }) };
				},
			}),
		],
		client: () => ({ close: async () => {} }),
		account: async () => ({ id: "builtin", label: "Webby" }),
		discover: async () => ({ items: [] }),
		describe: async () => ({}),
	};
}

export const KEYS = "v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

/** What a connection of the test workspace is encrypted for. */
export function binding(connectionId: string): Binding {
	return credentialBinding(WORKSPACE, connectionId);
}

export interface Harness {
	db: Database;
	sql: Sql;
	timers: FakeTimers;
	conversations: FakeConversations;
	objects: FakeObjects;
	oauth: FakeOAuth;
	endpoint: TokenEndpoint;
	server: FakeServer;
	keys: EncryptionKeys;
	registry: Registry;
	settings: WorkspaceSettings;
	logs: { message: string; fields: unknown }[];
	/** Every time the core brought its alarm forward. */
	wakes: number[];
	core: WorkspaceCore;
	/** A new instance of the object over the same storage, as after a crash or an eviction. */
	restart(): WorkspaceCore;
}

export async function harness(options: { settings?: Partial<WorkspaceSettings>; db?: Database; connectors?: Connector[] } = {}): Promise<Harness> {
	const db = options.db ?? database();
	const sql = nodeSql(db);
	const server = new FakeServer();
	const registry = await Registry.create([mixedConnector(server), keyedConnector(server), builtinConnector(), ...(options.connectors ?? [])]);
	const keys = await EncryptionKeys.parse(KEYS);
	const h = {
		db,
		sql,
		timers: new FakeTimers(),
		conversations: new FakeConversations(),
		objects: new FakeObjects(),
		oauth: new FakeOAuth(),
		endpoint: new TokenEndpoint(),
		server,
		keys,
		registry,
		settings: { ...SETTINGS, ...options.settings },
		logs: [] as { message: string; fields: unknown }[],
		wakes: [] as number[],
	} as Harness;
	const deps = (): WorkspaceDeps => ({
		sql,
		timers: h.timers,
		keys,
		registry,
		settings: h.settings,
		conversations: h.conversations,
		objects: h.objects,
		oauth: h.oauth,
		fetch: h.endpoint.fetch,
		log: (message, fields) => h.logs.push({ message, fields }),
		wake: (at) => h.wakes.push(at),
	});
	h.restart = () => {
		h.core = new WorkspaceCore(deps());
		return h.core;
	};
	h.restart();
	await h.core.init({ workspace: { id: WORKSPACE, jurisdiction: null }, kind: "personal", ownerId: USER, createdAt: h.timers.now() });
	return h;
}

/** The connection's decrypted credentials, as stored. */
/** The access of an answer that must have one. */
export function accessOf(outcome: Outcome<AccessOut>): AccessOut {
	if (!outcome.ok) throw new Error(`No access: ${outcome.refusal.code} ${outcome.refusal.detail}`);
	return outcome.value;
}

export async function credentials(h: Harness, connectionId: string): Promise<JsonObject> {
	const row = h.sql.exec<{ ciphertext: string; key_version: string }>("SELECT ciphertext, key_version FROM connections WHERE id = ?", connectionId)[0];
	if (!row) throw new Error("No such connection.");
	return (await h.keys.decrypt(binding(connectionId), { ciphertext: row.ciphertext, version: row.key_version })) as JsonObject;
}

/** A column of a connection. */
export function column(h: Harness, connectionId: string, name: string): SqlValue | undefined {
	return h.sql.exec(`SELECT ${name} AS v FROM connections WHERE id = ?`, connectionId)[0]?.v;
}

/** Saves an OAuth connection of the mixed connector for Ada (or `caller`), as a callback would. */
export async function connectMixed(h: Harness, payload: JsonObject, extra: { caller?: Caller; account?: string; connectionId?: string | null } = {}): Promise<string> {
	const saved = await h.core.saveConnection(extra.caller ?? ADA, {
		provider: "mixed",
		account: { id: extra.account ?? "acct-1", label: "Fake account" },
		credentials: { kind: "oauth2", access_token: "a1", refresh_token: null, scopes: null, ...payload } as never,
		connectionId: extra.connectionId ?? null,
	});
	if (!saved.ok) throw new Error(saved.refusal.detail);
	return saved.value.id;
}

/** Replaces a connection's credentials in place. */
export async function setCredentials(h: Harness, connectionId: string, payload: Json): Promise<void> {
	const sealed = await h.keys.encrypt(binding(connectionId), payload);
	const expiresAt = (payload as JsonObject).expires_at;
	h.sql.exec(
		"UPDATE connections SET ciphertext = ?, key_version = ?, generation = generation + 1, expires_at = ?, refresh_state = 'fresh', status = 'active' WHERE id = ?",
		sealed.ciphertext,
		sealed.version,
		typeof expiresAt === "number" ? expiresAt : null,
		connectionId,
	);
	const scopes = (payload as JsonObject).scopes;
	h.sql.exec("UPDATE connections SET scopes = ? WHERE id = ?", Array.isArray(scopes) ? JSON.stringify(scopes) : null, connectionId);
}

/** The default agent of the workspace. */
export async function defaultAgent(h: Harness): Promise<string> {
	const agents = await h.core.listAgents(ADA);
	return (agents[0] as { id: string }).id;
}

/** Gives the agent these connections. */
export async function attach(h: Harness, agentId: string, connectionIds: string[], caller: Caller = ADA): Promise<void> {
	const agent = await h.core.getAgent(caller, agentId);
	if (agent === null) throw new Error("No such agent.");
	const updated = await h.core.updateAgent(caller, agentId, { name: agent.name, instructions: agent.instructions, connection_ids: connectionIds });
	if (!updated.ok) throw new Error(updated.refusal.detail);
}

/** A conversation of the default agent for `caller`. */
export async function conversation(h: Harness, caller: Caller = ADA, agentId?: string): Promise<string> {
	const created = await h.core.createConversation(caller, agentId ?? (await defaultAgent(h)));
	if (!created.ok) throw new Error(created.refusal.detail);
	return created.value.id;
}

let runs = 0;

export function runId(): string {
	runs++;
	return `0199a000-0000-7000-9000-${String(runs).padStart(12, "0")}`;
}

/** A run start as the Conversation object asks for it, for `caller` in `conversationId` (a new one by default). */
export async function begin(
	h: Harness,
	options: { conversationId?: string; caller?: Caller; uploadIds?: string[]; folder?: { bytes: number; entries: number }; runId?: string } = {},
) {
	const caller = options.caller ?? ADA;
	const conversationId = options.conversationId ?? (await conversation(h, caller));
	const row = h.sql.exec<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", conversationId)[0];
	const input = {
		runId: options.runId ?? runId(),
		conversationId,
		userId: caller.userId,
		agentId: row?.agent_id ?? "",
		uploadIds: options.uploadIds ?? [],
		folder: options.folder ?? { bytes: 0, entries: 0 },
	};
	return { input, answer: await h.core.beginRun(input) };
}

/** A run started and activated, as the Conversation object does once it stored it. */
export async function running(h: Harness, options: Parameters<typeof begin>[1] = {}) {
	const started = await begin(h, options);
	if (!started.answer.ok) throw new Error(started.answer.refusal.detail);
	h.conversations.stored.add(started.input.runId);
	expect(await h.core.activate(started.input.runId)).toEqual({ state: "active" });
	return started;
}

/** The registry's row of a run. */
export function registered(h: Harness, runId: string) {
	return h.sql.exec<{ state: string; revoked: string | null }>("SELECT state, revoked FROM runs WHERE id = ?", runId)[0] ?? null;
}

/** The outbox, oldest first. */
export function outbox(h: Harness) {
	return h.sql.exec<{ id: number; run_id: string; reason: string; acknowledged_at: number | null; ack_state: string | null; attempts: number }>(
		"SELECT id, run_id, reason, acknowledged_at, ack_state, attempts FROM outbox ORDER BY id",
	);
}

/** Grants the user these actions on mixed folders: {folder: actions}. */
export async function grant(h: Harness, connectionId: string, folders: { [folder: string]: string[] }, caller: Caller = ADA) {
	const changes = Object.entries(folders).map(([id, actions]) => ({ kind: "folder", id, actions }));
	const applied = await h.core.applyGrantChanges(caller, connectionId, changes, {});
	if (!applied.ok) throw new Error(applied.refusal.detail);
	return applied.value;
}
