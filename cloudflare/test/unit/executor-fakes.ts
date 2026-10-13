// What the executor's tests run against: providers behind an injected `fetch` (an in-memory Todoist for
// the real Todoist connector among them), connectors built on ProviderHTTP, and in-memory fakes of the
// ports around the real ledger and page tokens on node:sqlite. `mixed` has two kinds (one without
// wildcards), an operation that needs different actions on two resources and one gated by provider
// consent, and modes that break the contract on purpose; `keyed` authenticates with an API key and acts on
// its account.

import { z } from "zod";
import type { AttemptFence, ConnectionId, RunId } from "../../src/contracts/common.ts";
import type { Connector, CredentialPayload, Operation, Prepared, ProviderOutput, Requirement } from "../../src/contracts/connectors.ts";
import type { CredentialLease, CredentialPort, RunStatePort, ToolCallOutcome, ToolCallRequest } from "../../src/contracts/executor.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import type { ToolRef } from "../../src/contracts/runs.ts";
import type { ToolCallEventData } from "../../src/contracts/events.ts";
import type { Clock } from "../../src/gateway/clock.ts";
import { ACCOUNT_KIND, OperationError, defineOperation } from "../../src/gateway/connector.ts";
import { type ExecutorHost, type ExecutorLog, type ToolExecutor, createExecutor } from "../../src/gateway/executor.ts";
import { type RunLayers, effectivePolicy } from "../../src/gateway/grants.ts";
import { ProviderHTTP } from "../../src/gateway/http.ts";
import { WriteLedger } from "../../src/gateway/ledger.ts";
import { PageTokens } from "../../src/gateway/page-tokens.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { LedgerRunState, type RunState, type RunTable } from "../../src/gateway/run-state.ts";
import { type ConnectionInfo, toolsFor } from "../../src/gateway/tools.ts";
import type { Json } from "../../src/lib/json.ts";
import { parseJson } from "../../src/lib/json.ts";
import type { Sql } from "../../src/lib/sql.ts";
import { ledgerSql } from "./sqlite.ts";

export const USER = "0199a000-0000-7000-8000-0000000000aa";
export const RUN = "0199a000-0000-7000-8000-0000000000c1";
export const MIXED = "0199a000-0000-7000-8000-000000000001";
export const KEYED = "0199a000-0000-7000-8000-00000000000f";
export const TODOIST = "0199a000-0000-7000-8000-000000000007";
export const SECRET = "test-secret-not-a-real-key";
export const FOLDER = "folder";
export const LABEL = "label";
export const PROJECT = "project";

/** Both clocks, moved by hand. */
export class FakeClock implements Clock {
	epoch = Date.UTC(2026, 9, 12, 12, 0, 0);
	mono = 1_000_000;

	now(): number {
		return this.epoch;
	}

	monotonic(): number {
		return this.mono;
	}

	advance(ms: number): void {
		this.epoch += ms;
		this.mono += ms;
	}
}

/** Resolves when `resolve()` is called; a promise to hold a fake provider's answer with. */
export class Gate {
	readonly promise: Promise<void>;
	resolve!: () => void;

	constructor() {
		this.promise = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}
}

function waitFor(promise: Promise<void>, signal: AbortSignal | null | undefined): Promise<void> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
}

function never(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise<never>((_, reject) => {
		if (signal?.aborted) reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * What the next write gets: a status, "bad-json" (200 that is not JSON), "transport" (fetch fails before
 * anything is applied), "lost" (applied, then the connection drops), "hang" (no answer until aborted) or
 * "platform" (the platform's own refusal, 403 "error code: 1003").
 */
export type WriteResponse = number | "bad-json" | "transport" | "lost" | "hang" | "platform";

export type MixedMode =
	| "ok"
	| "omit-source"
	| "enumerate-write"
	| "two-writes"
	| "write-in-prepare"
	| "foreign-record"
	| "swallow-errors"
	| "no-write"
	| "late-write";

/** One in-memory provider behind an injected `fetch`. */
export class FakeServer {
	folders: { [id: string]: string } = { inbox: "Inbox", archive: "Archive", secret: "Secret" };
	labels: { [id: string]: string } = { red: "Red", blue: "Blue" };
	calls: [method: string, path: string][] = [];
	writeResponses: WriteResponse[] = [];
	readStatus = 200;
	/** Holds writes until resolved, to observe a write in flight. */
	gate: Gate | null = null;
	received = new Gate();
	mode: MixedMode = "ok";
	copies: { [key: string]: Json }[] = [];
	/** The client's timeout in seconds. */
	timeout = 20;
	/** A request the connector left running (mode "late-write"), and what releases it. */
	late: Promise<unknown> | null = null;
	lateGate = new Gate();

	posts(): number {
		return this.calls.filter(([method]) => method === "POST").length;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const signal = init?.signal;
		this.calls.push([request.method, url.pathname]);
		if (request.method === "GET") {
			if (this.readStatus !== 200) return jsonResponse(this.readStatus, {});
			if (url.pathname === "/me") return jsonResponse(200, { id: "acct-1", name: "Fake account" });
			if (url.pathname === "/folders") return jsonResponse(200, Object.entries(this.folders).map(([id, name]) => ({ id, name })));
			if (url.pathname === "/labels") return jsonResponse(200, Object.entries(this.labels).map(([id, name]) => ({ id, name })));
			return jsonResponse(404, {});
		}
		this.received.resolve();
		if (this.gate !== null) await waitFor(this.gate.promise, signal);
		const response = this.writeResponses.shift() ?? 200;
		if (response === "transport") throw new TypeError("fetch failed");
		if (response === "hang") return never(signal);
		if (response === "platform") return new Response("error code: 1003 ", { status: 403, headers: { server: "cloudflare", "content-type": "text/plain" } });
		if (response === "bad-json") return new Response("<html>", { status: 200 });
		if (response !== 200 && response !== "lost") return jsonResponse(response, {});
		const body = parseJson(await request.text()) as { [key: string]: Json };
		this.copies.push(body);
		if (response === "lost") throw new TypeError("Network connection lost.");
		return jsonResponse(200, { id: `copy-${this.copies.length}`, ...body });
	};
}

const Id = () => z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/);
const ListInput = z.strictObject({});
const CopyFile = z.strictObject({ source: Id(), dest: Id(), name: z.string().trim().min(1).max(100) });
const Folders = z.array(z.object({ id: z.string(), name: z.string() }));

function client(server: FakeServer, provider: string, base: string, headers: { [name: string]: string }) {
	return (io: Parameters<Connector["client"]>[1]) => new ProviderHTTP(io, { provider, baseUrl: base, headers, timeout: server.timeout });
}

function mixedOperations(server: FakeServer): Operation<never>[] {
	return [
		defineOperation<z.output<typeof ListInput>>({
			name: "list_folders",
			title: "List folders",
			description: "Lists folders.",
			input: ListInput,
			needs: [[FOLDER, "read"]],
			async prepare(binding): Promise<Prepared> {
				const http = binding.client as ProviderHTTP;
				return {
					requirements: [{ enumerate: FOLDER, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const folders = await http.parsed({ method: "GET", path: "/folders" }, Folders);
						const records = folders.map((folder) => ({ resource: binding.resource(FOLDER, folder.id), data: folder }));
						if (server.mode === "foreign-record") {
							records.push({ resource: binding.resource(LABEL, "red"), data: { id: "red", name: "Red" } });
							records.push({ resource: { ...binding.resource(FOLDER, "inbox"), connectionId: "other" }, data: { id: "x", name: "x" } });
						}
						return { records };
					},
				};
			},
		}),
		defineOperation<z.output<typeof CopyFile>>({
			name: "copy_file",
			title: "Copy a file",
			description: "Copies a file from one folder into another.",
			input: CopyFile,
			needs: [
				[FOLDER, "read"],
				[FOLDER, "create"],
			],
			mutates: true,
			async prepare(binding, data): Promise<Prepared> {
				const http = binding.client as ProviderHTTP;
				const mode = server.mode;
				const source: Requirement = { need: binding.resource(FOLDER, data.source), action: "read" };
				const dest: Requirement = { need: binding.resource(FOLDER, data.dest), action: "create" };
				const requirements: Requirement[] =
					mode === "omit-source" ? [dest] : mode === "enumerate-write" ? [{ enumerate: FOLDER, action: "read" }, dest] : [source, dest];
				if (mode === "write-in-prepare") await http.request({ method: "POST", path: "/copies", json: {} });
				return {
					requirements,
					async execute(): Promise<ProviderOutput> {
						const body = { source: data.source, dest: data.dest, name: data.name };
						if (mode === "no-write") return { records: [] };
						if (mode === "late-write") {
							server.late = server.lateGate.promise.then(() => http.request({ method: "POST", path: "/copies", json: body }));
							server.late.catch(() => {});
							return { records: [] };
						}
						let created: Json;
						try {
							created = await http.json({ method: "POST", path: "/copies", json: body });
						} catch (error) {
							if (!(error instanceof OperationError) || mode !== "swallow-errors") throw error;
							return { records: [] };
						}
						if (mode === "two-writes") await http.request({ method: "POST", path: "/copies", json: body });
						return { records: [{ resource: binding.resource(FOLDER, data.dest), data: created as { [key: string]: Json } }] };
					},
				};
			},
		}),
		defineOperation<z.output<typeof ListInput>>({
			name: "list_labels",
			title: "List labels",
			description: "Lists labels.",
			input: ListInput,
			needs: [[LABEL, "read"]],
			consent: [["labels"]],
			async prepare(binding): Promise<Prepared> {
				const http = binding.client as ProviderHTTP;
				return {
					requirements: [{ enumerate: LABEL, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const labels = await http.parsed({ method: "GET", path: "/labels" }, Folders);
						return { records: labels.map((label) => ({ resource: binding.resource(LABEL, label.id), data: label })) };
					},
				};
			},
		}),
	];
}

/** The mixed connector, over ProviderHTTP. */
export function mixedConnector(server: FakeServer): Connector<ProviderHTTP> {
	return {
		slug: "mixed",
		name: "Mixed",
		kinds: [
			{ id: FOLDER, label: "Folder", actions: ["read", "create"], wildcard: true },
			{ id: LABEL, label: "Label", actions: ["read"] },
		],
		actions: [
			{ id: "read", label: "Read" },
			{ id: "create", label: "Create", requires: "read" },
		],
		auth: { type: "oauth2", app: "mixed", authorizeUrl: "https://mixed.example/authorize", tokenUrl: "https://mixed.example/token", scopes: ["files", "labels"] },
		operations: mixedOperations(server),
		client: (secret, io) => client(server, "Mixed", "https://mixed.example", { Authorization: `Bearer ${secret}` })(io),
		async account(http) {
			const me = (await http.json({ method: "GET", path: "/me" })) as { id: string; name: string };
			return { id: me.id, label: me.name };
		},
		async discover(http, kind) {
			const items = (await http.json({ method: "GET", path: kind === FOLDER ? "/folders" : "/labels" })) as { id: string; name: string }[];
			return { items };
		},
		async describe() {
			return {};
		},
	};
}

/** The keyed connector: an API key, acting on its account. */
export function keyedConnector(server: FakeServer): Connector<ProviderHTTP> {
	const Whoami = z.strictObject({});
	return {
		slug: "keyed",
		name: "Keyed",
		kinds: [{ id: ACCOUNT_KIND, label: "Account", actions: ["read"] }],
		actions: [{ id: "read", label: "Read" }],
		auth: { type: "api_key", label: "API key" },
		operations: [
			defineOperation<z.output<typeof Whoami>>({
				name: "whoami",
				title: "Who am I",
				description: "Shows the account.",
				input: Whoami,
				needs: [[ACCOUNT_KIND, "read"]],
				async prepare(binding): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.account(), action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const me = (await http.json({ method: "GET", path: "/me" })) as { [key: string]: Json };
							return { records: [{ resource: binding.account(), data: me }] };
						},
					};
				},
			}),
		],
		client: (secret, io) => client(server, "Keyed", "https://keyed.example", { "X-Key": secret })(io),
		async account(http) {
			const me = (await http.json({ method: "GET", path: "/me" })) as { id: string; name: string };
			return { id: me.id, label: me.name };
		},
		async discover() {
			throw new OperationError("NOT_SUPPORTED", "Nothing to discover.");
		},
		async describe() {
			return {};
		},
	};
}

// An in-memory Todoist for the real Todoist connector (src/connectors/todoist/): two projects and a task in each.

export interface FakeTask {
	id: string;
	project_id: string;
	content: string;
	priority?: number;
}

export class FakeTodoist {
	projects = [
		{ id: "work", name: "Work" },
		{ id: "private", name: "Private" },
	];
	tasks: FakeTask[] = [
		{ id: "t1", project_id: "work", content: "Ship it", priority: 1 },
		{ id: "t2", project_id: "private", content: "Secret", priority: 1 },
	];
	calls: [method: string, path: string][] = [];
	failWrites = false;
	revoked = false;
	pageSize: number | null = null;
	/** Runs when a POST arrives, before it is applied. */
	onWrite: (() => void) | null = null;

	count(method: string, path: string): number {
		return this.calls.filter(([m, p]) => m === method && p === path).length;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/api\/v1/, "");
		this.calls.push([request.method, path]);
		if (this.revoked) return jsonResponse(401, {});
		if (request.method === "GET" && path === "/user") return jsonResponse(200, { id: "u1", full_name: "Ada" });
		if (request.method === "GET" && path === "/projects") return jsonResponse(200, { results: this.projects, next_cursor: null });
		if (request.method === "GET" && path === "/tasks") {
			const project = url.searchParams.get("project_id");
			const items = this.tasks.filter((task) => task.project_id === project);
			if (this.pageSize) {
				const start = Number(url.searchParams.get("cursor") ?? 0);
				const page = items.slice(start, start + this.pageSize);
				const next = start + this.pageSize < items.length ? String(start + this.pageSize) : null;
				return jsonResponse(200, { results: page, next_cursor: next });
			}
			return jsonResponse(200, { results: items, next_cursor: null });
		}
		if (request.method === "GET" && path.startsWith("/tasks/")) {
			const task = this.tasks.find((item) => item.id === path.split("/").pop());
			return task ? jsonResponse(200, task) : jsonResponse(404, {});
		}
		if (request.method === "POST" && path === "/tasks") {
			this.onWrite?.();
			if (this.failWrites) throw new TypeError("timeout");
			const body = parseJson(await request.text()) as { project_id: string; content: string };
			const task = { id: `t${this.tasks.length + 1}`, project_id: body.project_id, content: body.content };
			this.tasks.push(task);
			return jsonResponse(200, task);
		}
		return jsonResponse(404, {});
	};
}

// The ports.

/** The Conversation Durable Object's runs, as the checks read them. */
export class FakeRuns implements RunTable {
	readonly runs = new Map<RunId, RunState & { toolCalls: number }>();

	add(runId: RunId, state: Partial<RunState> = {}): void {
		this.runs.set(runId, { status: "running", attempt: 1, deadline: null, revoked: false, toolCalls: 0, ...state });
	}

	set(runId: RunId, patch: Partial<RunState & { toolCalls: number }>): void {
		const run = this.runs.get(runId);
		if (run === undefined) throw new Error(`No run ${runId}`);
		Object.assign(run, patch);
	}

	get(runId: RunId): RunState | null {
		const run = this.runs.get(runId);
		return run === undefined ? null : { status: run.status, attempt: run.attempt, deadline: run.deadline, revoked: run.revoked };
	}

	toolCalls(runId: RunId): number {
		return this.runs.get(runId)?.toolCalls ?? 0;
	}

	countToolCall(runId: RunId): void {
		const run = this.runs.get(runId);
		if (run !== undefined) run.toolCalls += 1;
	}
}

export interface FakeConnection {
	provider: string;
	status: "active" | "error";
	generation: number;
	payload: CredentialPayload;
}

/** The Workspace Durable Object's credentials, fenced as the contract says. */
export class FakeCredentials implements CredentialPort {
	readonly connections = new Map<ConnectionId, FakeConnection>();
	leases = 0;
	readonly #run: RunStatePort;

	constructor(run: RunStatePort) {
		this.#run = run;
	}

	add(id: ConnectionId, provider: string, payload: CredentialPayload): void {
		this.connections.set(id, { provider, status: "active", generation: 1, payload });
	}

	/** `set_credentials`: new credentials bump the generation. */
	replace(id: ConnectionId, payload: CredentialPayload): void {
		const connection = this.connections.get(id) as FakeConnection;
		connection.payload = payload;
		connection.generation += 1;
	}

	status(id: ConnectionId): string | undefined {
		return this.connections.get(id)?.status;
	}

	async lease(fence: AttemptFence, connectionId: ConnectionId): Promise<CredentialLease | { refused: "RUN_ENDED" | "CONNECTION_UNAUTHORIZED" | "PROVIDER_UNAVAILABLE"; message: string }> {
		if (!this.#run.isCurrent(fence)) return { refused: "RUN_ENDED", message: "This run is no longer active." };
		this.leases += 1;
		await Promise.resolve();
		const connection = this.connections.get(connectionId);
		if (connection === undefined || connection.status !== "active") return { refused: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." };
		if (!this.#run.isCurrent(fence)) return { refused: "RUN_ENDED", message: "This run is no longer active." };
		const scopes = connection.payload.kind === "oauth2" ? connection.payload.scopes : null;
		return { connectionId, provider: connection.provider, generation: connection.generation, sealed: { ciphertext: "sealed", version: "v1" }, scopes };
	}

	async markUnauthorized(connectionId: ConnectionId, generation: number): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (connection !== undefined && connection.status === "active" && connection.generation === generation) connection.status = "error";
	}

	async open(lease: CredentialLease): Promise<CredentialPayload> {
		return (this.connections.get(lease.connectionId) as FakeConnection).payload;
	}
}

/** Logs kept for the assertions, not printed. */
export class MemoryLog implements ExecutorLog {
	readonly errors: string[] = [];
	readonly warnings: string[] = [];

	error(message: string): void {
		this.errors.push(message);
	}

	warn(message: string): void {
		this.warnings.push(message);
	}
}

/** User-layer grants as rows: {id: actions} on `kind`, or [kind, id, actions]. */
export function userGrants(connectionId: ConnectionId, kind: string, grants: { [id: string]: string[] }, others: [string, string, string[]][] = []): GrantRow[] {
	const rows: [string, string, string[]][] = [...Object.entries(grants).map(([id, actions]): [string, string, string[]] => [kind, id, actions]), ...others];
	return rows.map(([rowKind, resourceId, actions]) => ({
		layer: "user",
		subject: USER,
		connectionId,
		kind: rowKind,
		resourceId,
		resourceName: "",
		actions,
		effect: "allow",
	}));
}

export interface ScenarioConnection {
	id: ConnectionId;
	provider: string;
	payload: CredentialPayload;
	/** Defaults to the payload's scopes (null for API keys). */
	scopes?: string[] | null;
}

export interface ScenarioOptions {
	connectors: Connector[];
	connections: ScenarioConnection[];
	user: GrantRow[];
	/** Extra rows of the workspace ceiling (unrestricted unless `ceilingRestricted`). */
	ceiling?: GrantRow[];
	ceilingRestricted?: boolean;
	fetch: typeof fetch;
	deadline?: number | null;
	concurrency?: number;
	clock?: FakeClock;
	sql?: Sql;
	/** Reuses a registry across runs, as one deploy does. */
	registry?: Registry;
	/** Changes the run's tool snapshot, as a stored snapshot from another deploy would differ. */
	editTools?: (tools: ToolRef[]) => ToolRef[];
}

/** A run started and claimed, its executor, and what its calls recorded. */
export class Scenario {
	readonly registry: Registry;
	readonly clock: FakeClock;
	readonly sql: Sql;
	readonly runs = new FakeRuns();
	readonly ledger: WriteLedger;
	readonly tokens: PageTokens;
	readonly state: LedgerRunState;
	readonly credentials: FakeCredentials;
	readonly log = new MemoryLog();
	readonly events: ToolCallEventData[] = [];
	readonly waits: Promise<unknown>[] = [];
	readonly executor: ToolExecutor;
	readonly runId: RunId;
	readonly tools: string[];
	attempt = 1;

	private constructor(registry: Registry, options: ScenarioOptions, runId: RunId) {
		this.registry = registry;
		this.runId = runId;
		this.clock = options.clock ?? new FakeClock();
		this.sql = options.sql ?? ledgerSql();
		this.ledger = new WriteLedger(this.sql, this.clock);
		this.tokens = new PageTokens(this.sql, () => this.clock.now());
		this.state = new LedgerRunState(this.runs, this.ledger, this.tokens, this.clock);
		this.credentials = new FakeCredentials(this.state);
		const deadline = options.deadline === undefined ? this.clock.now() + 300_000 : options.deadline;
		this.runs.add(runId, { deadline });
		const infos: ConnectionInfo[] = options.connections.map((connection, index) => ({
			id: connection.id,
			provider: connection.provider,
			ownerId: USER,
			status: "active",
			createdAt: this.clock.now() + index,
			scopes: connection.scopes !== undefined ? connection.scopes : connection.payload.kind === "oauth2" ? connection.payload.scopes : null,
		}));
		for (const connection of options.connections) this.credentials.add(connection.id, connection.provider, connection.payload);
		const providers = new Map(options.connections.map((connection) => [connection.id, connection.provider]));
		const layers: RunLayers = {
			ceiling: { restricted: options.ceilingRestricted ?? false, grants: options.ceiling ?? [] },
			user: { restricted: true, grants: options.user },
			agent: null,
		};
		const policy = effectivePolicy(layers, registry, (id) => providers.get(id) ?? null);
		const tools = (options.editTools ?? ((refs: ToolRef[]) => refs))(toolsFor(registry, infos, USER, policy));
		this.tools = tools.map((tool) => tool.name);
		const host: ExecutorHost = {
			registry,
			secretKey: SECRET,
			waitUntil: (promise) => this.waits.push(promise),
			clock: this.clock,
			log: this.log,
			...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
		};
		this.executor = createExecutor(
			{ runId, userId: USER, permissions: policy.toJson(), tools, run: this.state, credentials: this.credentials, fetch: options.fetch, deadline },
			host,
		);
	}

	static async start(options: ScenarioOptions, runId: RunId = RUN): Promise<Scenario> {
		return new Scenario(options.registry ?? (await Registry.create(options.connectors)), options, runId);
	}

	fence(attempt = this.attempt): AttemptFence {
		return { runId: this.runId, attempt };
	}

	/** Calls a tool as the loop would, and appends its event as the Conversation Durable Object does. */
	async call(name: string, args?: Json, extra: Partial<ToolCallRequest> = {}): Promise<ToolCallOutcome> {
		const outcome = await this.executor.invoke({ fence: this.fence(), name, arguments: args, ...extra });
		if (outcome.event !== null) this.events.push(outcome.event);
		return outcome;
	}

	/** The call's result, which must succeed. */
	async ok(name: string, args?: Json, extra: Partial<ToolCallRequest> = {}): Promise<Extract<ToolCallOutcome, { ok: true }>> {
		const outcome = await this.call(name, args, extra);
		if (!outcome.ok) throw new Error(`${name} failed with ${outcome.error.code}: ${outcome.error.message}`);
		return outcome;
	}

	/** The error code the call fails with. */
	async code(name: string, args?: Json, extra: Partial<ToolCallRequest> = {}): Promise<string> {
		const outcome = await this.call(name, args, extra);
		if (outcome.ok) throw new Error(`${name} succeeded`);
		return outcome.error.code;
	}

	async error(name: string, args?: Json, extra: Partial<ToolCallRequest> = {}): Promise<{ code: string; message: string }> {
		const outcome = await this.call(name, args, extra);
		if (outcome.ok) throw new Error(`${name} succeeded`);
		return outcome.error;
	}

	writes(): { status: string; key: string; attempt: number }[] {
		return this.ledger.writes(this.runId).map((write) => ({ status: write.status, key: write.key, attempt: write.attempt }));
	}

	paused(): boolean {
		return this.ledger.paused(this.runId);
	}

	/** A new attempt takes over the run, as a restart would. */
	replace(): void {
		this.attempt += 1;
		this.runs.set(this.runId, { attempt: this.attempt });
	}
}

/** The mixed connection with both scopes. */
export function mixedConnection(scopes: string[] | null = ["files", "labels"]): ScenarioConnection {
	return { id: MIXED, provider: "mixed", payload: { kind: "oauth2", access_token: "t", refresh_token: null, scopes } };
}

export function todoistConnection(): ScenarioConnection {
	return { id: TODOIST, provider: "todoist", payload: { kind: "oauth2", access_token: "test-token", refresh_token: null, scopes: null } };
}

export function keyedConnection(): ScenarioConnection {
	return { id: KEYED, provider: "keyed", payload: { kind: "api_key", key: "secret-key" } };
}
