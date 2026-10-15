// The fake Laravel (docs/plans/contract.md): the `laravel` half of the internal contract, implemented with oRPC over state a
// test sets, behind the same bearer check Laravel's Sanctum routes make. One implementation over two backings: `FakeLaravel`
// keeps its state in memory for the platform tests, whose `install()` routes the engine's client (src/laravel/client.ts) to it
// in process; `SqlLaravel` keeps it in rows of the test build's FaultProvider (provider.ts), which hosts it per workspace at
// MINERVA_LARAVEL_URL (settings.ts), so what it applied survives the crashes of the objects that call it, and its own.
//
// It does what Laravel does: it answers only within its environment, for runs it holds under the scope named, and a lease
// or report only for a connection in the run's authorized set; it applies facts of the conversation's runs in order per
// conversation, once, and stops a conversation whose repeat differs (contract/scenarios/facts.json, which it must pass).
// It records each call's operation and ids, never a secret.

import { type Fact, INTERNAL_REFUSALS, type InternalRefusalCode, type Scope, laravel } from "@minerva/contract/internal";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, implement } from "@orpc/server";
import { LARAVEL_NETWORK } from "../laravel/client.ts";
import { canonicalJson } from "../lib/canonical.ts";
import { parseJson } from "../lib/json.ts";

export interface FakeRun {
	scope: Scope;
	conversation: string;
	/** Starting or running: only an active run is lent credentials. */
	active: boolean;
	/** The connections its snapshot can reach. */
	authorized: string[];
}

export interface FakeConnection {
	kind: "oauth2" | "api_key" | "builtin";
	secret: string;
	scopes: string[] | null;
	generation: number;
	expiresAt: string | null;
	/** `error`: the provider refused it, so it needs reconnecting. */
	status: "active" | "error";
}

export interface Call {
	operation: "leaseToken" | "reportUnauthorized" | "deliverFacts";
	run?: string;
	connection?: string;
	conversation?: string;
}

/** How far a conversation's facts are applied. */
interface Watermark {
	held: number;
	/** A repeat differed: nothing more is applied until the operator looks. */
	stopped: boolean;
}

/**
 * What the fake Laravel keeps. Every method is synchronous, so a request reads and writes what it touches with no await in
 * between: in a Durable Object, the input gate keeps each request's changes atomic.
 */
interface LaravelState {
	run(id: string): FakeRun | null;
	conversation(id: string): Scope | null;
	connection(id: string): FakeConnection | null;
	needsReconnect(connection: string): void;
	/** `conversation` is the one the call named, whatever the call records. */
	record(conversation: string, call: Call): void;
	/** Whether this delivery fails, as a Laravel that is down would: it takes one of those left to fail. */
	failDelivery(): boolean;
	watermark(conversation: string): Watermark;
	/** The fact applied at `seq`, as canonical JSON, or null. */
	applied(conversation: string, seq: number): string | null;
	/** Applies new facts (canonical JSON by sequence) and moves the watermark to `held`. */
	apply(conversation: string, facts: ReadonlyMap<number, string>, held: number): void;
	stop(conversation: string): void;
}

interface Options {
	/** The token Sanctum would accept, and the environment this Laravel serves. */
	token: string;
	environment: string;
	/** Settles when a lease for the run may be answered; none for a run whose leases are not held. */
	leaseHold?: (run: string) => Promise<void> | undefined;
}

function refusal(code: InternalRefusalCode, message: string, data?: { acknowledged: number }): ORPCError<InternalRefusalCode, unknown> {
	return new ORPCError(code, { defined: true, status: INTERNAL_REFUSALS[code], message, ...(data ? { data } : {}) });
}

const sameScope = (a: Scope, b: Scope) => a.environment === b.environment && a.organization === b.organization && a.workspace === b.workspace;

/** Laravel's answer to one request, after Sanctum's bearer check. */
function laravelFetch(state: LaravelState, options: Options): (request: Request) => Promise<Response> {
	const { environment } = options;
	/** The run under that scope and conversation, or null: one in another environment, organization or workspace is unknown. */
	const runOf = (scope: Scope, conversation: string, id: string): FakeRun | null => {
		const run = state.run(id);
		if (run === null || scope.environment !== environment || !sameScope(run.scope, scope) || run.conversation !== conversation) return null;
		return run;
	};

	/**
	 * A batch, in one go: each fact checked in order, the first problem refusing the whole batch. Its run must be the
	 * conversation's, a repeat must equal what was applied, and a new fact must come right after what is held.
	 */
	const apply = (scope: Scope, conversation: string, facts: readonly Fact[]): number => {
		const watermark = state.watermark(conversation);
		if (watermark.stopped) throw refusal("FACT_CONFLICT", "This conversation's delivery is stopped.");
		const added = new Map<number, string>();
		let last = 0;
		let held = watermark.held;
		for (const fact of facts) {
			if (runOf(scope, conversation, fact.run) === null) throw refusal("NOT_FOUND", `No such run in this conversation: ${fact.run}.`);
			if (fact.seq <= last) throw refusal("FACT_GAP", "A batch's facts must be in order.", { acknowledged: watermark.held });
			last = fact.seq;
			const text = canonicalJson(fact);
			if (fact.seq <= watermark.held) {
				if (state.applied(conversation, fact.seq) !== text) {
					state.stop(conversation);
					throw refusal("FACT_CONFLICT", `Fact ${fact.seq} differs from the one applied.`);
				}
				continue;
			}
			if (fact.seq !== held + 1) throw refusal("FACT_GAP", `Expected fact ${held + 1}.`, { acknowledged: watermark.held });
			added.set(fact.seq, text);
			held = fact.seq;
		}
		state.apply(conversation, added, held);
		return held;
	};

	const os = implement(laravel);
	const handler = new OpenAPIHandler(
		os.router({
			leaseToken: os.leaseToken.handler(async ({ input }) => {
				state.record(input.conversation, { operation: "leaseToken", run: input.run, connection: input.connection });
				await options.leaseHold?.(input.run);
				const run = runOf(input.scope, input.conversation, input.run);
				if (run === null || !run.active) return { outcome: "refused" as const, code: "RUN_NOT_ACTIVE", message: "This run is no longer active." };
				if (!run.authorized.includes(input.connection)) return { outcome: "refused" as const, code: "NOT_AUTHORIZED", message: "This run cannot use the connection." };
				const connection = state.connection(input.connection);
				if (connection === null || connection.status === "error") return { outcome: "refused" as const, code: "RECONNECT_NEEDED", message: "The connection needs reconnecting." };
				const { kind, secret, scopes, generation, expiresAt } = connection;
				return { outcome: "leased" as const, kind, secret, scopes, generation, expiresAt };
			}),
			reportUnauthorized: os.reportUnauthorized.handler(({ input }) => {
				state.record(input.conversation, { operation: "reportUnauthorized", run: input.run, connection: input.connection });
				const run = runOf(input.scope, input.conversation, input.run);
				const connection = state.connection(input.connection);
				if (run === null || !run.authorized.includes(input.connection) || connection === null) return { marked: false };
				if (connection.status !== "active" || connection.generation !== input.generation) return { marked: false };
				state.needsReconnect(input.connection);
				return { marked: true };
			}),
			deliverFacts: os.deliverFacts.handler(({ input }) => {
				state.record(input.conversation, { operation: "deliverFacts", conversation: input.conversation });
				if (state.failDelivery()) throw refusal("UNAVAILABLE", "Laravel is down.");
				const scope = state.conversation(input.conversation);
				if (input.scope.environment !== environment || scope === null || !sameScope(scope, input.scope)) {
					throw refusal("NOT_FOUND", "No such conversation.");
				}
				return { acknowledged: apply(input.scope, input.conversation, input.facts) };
			}),
		}),
	);
	return async (request) => {
		if (request.headers.get("Authorization") !== `Bearer ${options.token}`) {
			return Response.json({ defined: true, code: "UNAUTHORIZED", status: 401, message: "Unauthenticated." }, { status: 401 });
		}
		const { matched, response } = await handler.handle(request, { context: {} });
		return matched ? response : Response.json({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }, { status: 404 });
	};
}

/** The platform tests' fake Laravel, in memory. */
export class FakeLaravel {
	readonly runs = new Map<string, FakeRun>();
	readonly connections = new Map<string, FakeConnection>();
	/** Conversations Laravel holds, by id, with their scope. */
	readonly conversations = new Map<string, Scope>();
	readonly calls: Call[] = [];
	/** Deliveries to answer 503, as a Laravel that is down would, before the next is applied. */
	failDeliveries = 0;
	readonly #delivered = new Map<string, Watermark & { applied: Map<number, string> }>();
	readonly #holds = new Map<string, Promise<void>>();

	/** The token Sanctum would accept, and the environment this Laravel serves. */
	readonly token: string;
	readonly environment: string;
	/** Laravel's answer to one request, after Sanctum's bearer check. */
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

	constructor(token: string, environment = "test") {
		this.token = token;
		this.environment = environment;
		const delivered = (conversation: string) => {
			let state = this.#delivered.get(conversation);
			if (state === undefined) this.#delivered.set(conversation, (state = { applied: new Map(), held: 0, stopped: false }));
			return state;
		};
		const answer = laravelFetch(
			{
				run: (id) => this.runs.get(id) ?? null,
				conversation: (id) => this.conversations.get(id) ?? null,
				connection: (id) => this.connections.get(id) ?? null,
				needsReconnect: (id) => {
					const connection = this.connections.get(id);
					if (connection) connection.status = "error";
				},
				record: (_conversation, call) => {
					this.calls.push(call);
				},
				failDelivery: () => {
					if (this.failDeliveries <= 0) return false;
					this.failDeliveries--;
					return true;
				},
				watermark: delivered,
				applied: (conversation, seq) => delivered(conversation).applied.get(seq) ?? null,
				apply: (conversation, facts, held) => {
					const state = delivered(conversation);
					for (const [seq, text] of facts) state.applied.set(seq, text);
					state.held = held;
				},
				stop: (conversation) => {
					delivered(conversation).stopped = true;
				},
			},
			{ token, environment, leaseHold: (run) => this.#holds.get(run) },
		);
		this.fetch = (input, init) => answer(new Request(input, init));
	}

	/** Holds the run's leases once each is recorded, before it reads the run or the connection, until the returned function is called. */
	holdLeases(run: string): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#holds.set(run, promise);
		return () => {
			this.#holds.delete(run);
			resolve();
		};
	}

	/** The facts applied in the conversation, in order. */
	facts(conversation: string): Fact[] {
		const state = this.#delivered.get(conversation);
		if (state === undefined) return [];
		return [...state.applied.entries()].sort(([a], [b]) => a - b).map(([, text]) => parseJson(text) as unknown as Fact);
	}

	/** Laravel restored from a backup: it holds the conversation's facts up to `held` and no further. */
	restore(conversation: string, held: number): void {
		const state = this.#delivered.get(conversation);
		if (state === undefined) return;
		for (const seq of state.applied.keys()) if (seq > held) state.applied.delete(seq);
		state.held = held;
	}

	/**
	 * Routes the engine's client of Laravel here until the returned function is called. `withToken` also has the client send
	 * this Laravel's token, for the objects, whose MINERVA_LARAVEL_TOKEN binding a test cannot set.
	 */
	install(options: { withToken?: boolean } = {}): () => void {
		const previous = { ...LARAVEL_NETWORK };
		LARAVEL_NETWORK.fetch = () => this.fetch;
		if (options.withToken) LARAVEL_NETWORK.token = () => this.token;
		return () => {
			Object.assign(LARAVEL_NETWORK, previous);
		};
	}
}

/** The token the test build's engine sends its Laravel, and the hosted fake accepts: MINERVA_LARAVEL_TOKEN where it is set, else this. */
const HOSTED_TOKEN = "faults-laravel-token";

export function hostedToken(env: Env): string {
	const value = (env as unknown as { MINERVA_LARAVEL_TOKEN?: unknown }).MINERVA_LARAVEL_TOKEN;
	return typeof value === "string" && value ? value : HOSTED_TOKEN;
}

/** What a test reads of the hosted fake: a conversation's facts and calls, and every connection. */
export interface LaravelView {
	facts: Fact[];
	calls: Call[];
	connections: { [id: string]: FakeConnection };
}

/** The hosted fake's tables, created with the FaultProvider's others and cleared with them. */
export const LARAVEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS laravel_conversations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, held INTEGER NOT NULL, stopped INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS laravel_runs (id TEXT PRIMARY KEY, run TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS laravel_connections (id TEXT PRIMARY KEY, connection TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS laravel_calls (seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, call TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS laravel_facts (conversation TEXT NOT NULL, seq INTEGER NOT NULL, fact TEXT NOT NULL, PRIMARY KEY (conversation, seq)) STRICT;
CREATE TABLE IF NOT EXISTS laravel_failures (deliveries INTEGER NOT NULL) STRICT;
`;
export const LARAVEL_TABLES = ["laravel_conversations", "laravel_runs", "laravel_connections", "laravel_calls", "laravel_facts", "laravel_failures"];

/** The fake Laravel the test build hosts, in rows of the FaultProvider's SQLite. */
export class SqlLaravel {
	readonly #storage: DurableObjectStorage;
	readonly fetch: (request: Request) => Promise<Response>;

	constructor(storage: DurableObjectStorage, options: { token: string; environment: string }) {
		this.#storage = storage;
		const sql = storage.sql;
		this.fetch = laravelFetch(
			{
				run: (id) => this.#json<FakeRun>("SELECT run AS value FROM laravel_runs WHERE id = ?", id),
				conversation: (id) => this.#json<Scope>("SELECT scope AS value FROM laravel_conversations WHERE id = ?", id),
				connection: (id) => this.#json<FakeConnection>("SELECT connection AS value FROM laravel_connections WHERE id = ?", id),
				needsReconnect: (id) => {
					sql.exec("UPDATE laravel_connections SET connection = json_set(connection, '$.status', 'error') WHERE id = ?", id);
				},
				record: (conversation, call) => {
					sql.exec("INSERT INTO laravel_calls (conversation, call) VALUES (?, ?)", conversation, JSON.stringify(call));
				},
				failDelivery: () => sql.exec("UPDATE laravel_failures SET deliveries = deliveries - 1 WHERE deliveries > 0 RETURNING deliveries").toArray().length > 0,
				watermark: (conversation) => {
					const found = sql.exec<{ held: number; stopped: number }>("SELECT held, stopped FROM laravel_conversations WHERE id = ?", conversation).toArray()[0];
					return { held: found?.held ?? 0, stopped: found?.stopped === 1 };
				},
				applied: (conversation, seq) => sql.exec<{ fact: string }>("SELECT fact FROM laravel_facts WHERE conversation = ? AND seq = ?", conversation, seq).toArray()[0]?.fact ?? null,
				// Facts reach only a conversation Laravel holds, so its row is there to move.
				apply: (conversation, facts, held) =>
					storage.transactionSync(() => {
						for (const [seq, text] of facts) sql.exec("INSERT INTO laravel_facts (conversation, seq, fact) VALUES (?, ?, ?)", conversation, seq, text);
						sql.exec("UPDATE laravel_conversations SET held = ? WHERE id = ?", held, conversation);
					}),
				stop: (conversation) => {
					sql.exec("UPDATE laravel_conversations SET stopped = 1 WHERE id = ?", conversation);
				},
			},
			options,
		);
	}

	#json<T>(query: string, id: string): T | null {
		const found = this.#storage.sql.exec<{ value: string }>(query, id).toArray()[0];
		return found === undefined ? null : (parseJson(found.value) as unknown as T);
	}

	/** Laravel holds the run, and its conversation under the run's scope: a conversation keeps the scope it was first held under. */
	hold(id: string, run: FakeRun): void {
		const sql = this.#storage.sql;
		this.#storage.transactionSync(() => {
			sql.exec("INSERT INTO laravel_conversations (id, scope, held, stopped) VALUES (?, ?, 0, 0) ON CONFLICT (id) DO NOTHING", run.conversation, JSON.stringify(run.scope));
			sql.exec("INSERT INTO laravel_runs (id, run) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET run = excluded.run", id, JSON.stringify(run));
		});
	}

	setConnection(id: string, connection: FakeConnection): void {
		this.#storage.sql.exec("INSERT INTO laravel_connections (id, connection) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET connection = excluded.connection", id, JSON.stringify(connection));
	}

	/** The next `deliveries` deliveries are answered 503. */
	failDeliveries(deliveries: number): void {
		const sql = this.#storage.sql;
		this.#storage.transactionSync(() => {
			sql.exec("DELETE FROM laravel_failures");
			sql.exec("INSERT INTO laravel_failures (deliveries) VALUES (?)", deliveries);
		});
	}

	view(conversation: string): LaravelView {
		const sql = this.#storage.sql;
		return {
			facts: sql
				.exec<{ fact: string }>("SELECT fact FROM laravel_facts WHERE conversation = ? ORDER BY seq", conversation)
				.toArray()
				.map((found) => parseJson(found.fact) as unknown as Fact),
			calls: sql
				.exec<{ call: string }>("SELECT call FROM laravel_calls WHERE conversation = ? ORDER BY seq", conversation)
				.toArray()
				.map((found) => parseJson(found.call) as unknown as Call),
			connections: Object.fromEntries(
				sql
					.exec<{ id: string; connection: string }>("SELECT id, connection FROM laravel_connections ORDER BY id")
					.toArray()
					.map((found) => [found.id, parseJson(found.connection) as unknown as FakeConnection]),
			),
		};
	}
}
