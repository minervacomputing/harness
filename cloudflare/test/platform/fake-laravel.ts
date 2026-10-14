// The fake Laravel the engine's platform tests use (docs/plans/contract.md): the `laravel` half of the internal contract,
// implemented with oRPC over state a test sets, behind the same bearer check Laravel's Sanctum routes make. `install()`
// routes the engine's client (src/laravel/client.ts) to it, so the engine's real client reaches it in process.
//
// It does what Laravel does: it answers only within its environment, for runs it holds under the scope named, and a lease
// or report only for a connection in the run's authorized set; it applies facts of the conversation's runs in order per
// conversation, once, and stops a conversation whose repeat differs (contract/scenarios/facts.json, which it must pass).
// It records each call's operation and ids, never a secret.

import { type Fact, INTERNAL_REFUSALS, type InternalRefusalCode, type Scope, laravel } from "@minerva/contract/internal";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, implement } from "@orpc/server";
import { canonicalJson } from "../../src/lib/canonical.ts";
import { LARAVEL_NETWORK } from "../../src/laravel/client.ts";

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

interface Delivered {
	/** Applied facts by sequence, as canonical JSON, to compare repeats with. */
	applied: Map<number, string>;
	held: number;
	/** A repeat differed: nothing more is applied until the operator looks. */
	stopped: boolean;
}

function refusal(code: InternalRefusalCode, message: string, data?: { acknowledged: number }): ORPCError<InternalRefusalCode, unknown> {
	return new ORPCError(code, { defined: true, status: INTERNAL_REFUSALS[code], message, ...(data ? { data } : {}) });
}

const sameScope = (a: Scope, b: Scope) => a.environment === b.environment && a.organization === b.organization && a.workspace === b.workspace;

export class FakeLaravel {
	readonly origin = "https://laravel.example";
	readonly runs = new Map<string, FakeRun>();
	readonly connections = new Map<string, FakeConnection>();
	/** Conversations Laravel holds, by id, with their scope. */
	readonly conversations = new Map<string, Scope>();
	readonly calls: Call[] = [];
	readonly #delivered = new Map<string, Delivered>();
	readonly #handler: OpenAPIHandler<Record<never, never>>;

	/** The token Sanctum would accept, and the environment this Laravel serves. */
	readonly token: string;
	readonly environment: string;

	constructor(token: string, environment = "test") {
		this.token = token;
		this.environment = environment;
		const os = implement(laravel);
		this.#handler = new OpenAPIHandler(
			os.router({
				leaseToken: os.leaseToken.handler(({ input }) => {
					this.calls.push({ operation: "leaseToken", run: input.run, connection: input.connection });
					const run = this.#run(input.scope, input.conversation, input.run);
					if (run === null || !run.active) return { outcome: "refused" as const, code: "RUN_NOT_ACTIVE", message: "This run is no longer active." };
					if (!run.authorized.includes(input.connection)) return { outcome: "refused" as const, code: "NOT_AUTHORIZED", message: "This run cannot use the connection." };
					const connection = this.connections.get(input.connection);
					if (connection === undefined || connection.status === "error") return { outcome: "refused" as const, code: "RECONNECT_NEEDED", message: "The connection needs reconnecting." };
					const { kind, secret, scopes, generation, expiresAt } = connection;
					return { outcome: "leased" as const, kind, secret, scopes, generation, expiresAt };
				}),
				reportUnauthorized: os.reportUnauthorized.handler(({ input }) => {
					this.calls.push({ operation: "reportUnauthorized", run: input.run, connection: input.connection });
					const run = this.#run(input.scope, input.conversation, input.run);
					const connection = this.connections.get(input.connection);
					if (run === null || !run.authorized.includes(input.connection) || connection === undefined) return { marked: false };
					if (connection.status !== "active" || connection.generation !== input.generation) return { marked: false };
					connection.status = "error";
					return { marked: true };
				}),
				deliverFacts: os.deliverFacts.handler(({ input }) => {
					this.calls.push({ operation: "deliverFacts", conversation: input.conversation });
					const scope = this.conversations.get(input.conversation);
					if (input.scope.environment !== this.environment || scope === undefined || !sameScope(scope, input.scope)) {
						throw refusal("NOT_FOUND", "No such conversation.");
					}
					return { acknowledged: this.#apply(input.scope, input.conversation, input.facts) };
				}),
			}),
		);
	}

	/** The run under that scope and conversation, or null: one in another environment, organization or workspace is unknown. */
	#run(scope: Scope, conversation: string, id: string): FakeRun | null {
		const run = this.runs.get(id);
		if (run === undefined || scope.environment !== this.environment || !sameScope(run.scope, scope) || run.conversation !== conversation) return null;
		return run;
	}

	/**
	 * A batch, in one go: each fact checked in order, the first problem refusing the whole batch. Its run must be the
	 * conversation's, a repeat must equal what was applied, and a new fact must come right after what is held.
	 */
	#apply(scope: Scope, conversation: string, facts: readonly Fact[]): number {
		const state = this.#delivered.get(conversation) ?? { applied: new Map<number, string>(), held: 0, stopped: false };
		this.#delivered.set(conversation, state);
		if (state.stopped) throw refusal("FACT_CONFLICT", "This conversation's delivery is stopped.");
		const added = new Map<number, string>();
		let last = 0;
		let held = state.held;
		for (const fact of facts) {
			if (this.#run(scope, conversation, fact.run) === null) throw refusal("NOT_FOUND", `No such run in this conversation: ${fact.run}.`);
			if (fact.seq <= last) throw refusal("FACT_GAP", "A batch's facts must be in order.", { acknowledged: state.held });
			last = fact.seq;
			const text = canonicalJson(fact);
			if (fact.seq <= state.held) {
				if (state.applied.get(fact.seq) !== text) {
					state.stopped = true;
					throw refusal("FACT_CONFLICT", `Fact ${fact.seq} differs from the one applied.`);
				}
				continue;
			}
			if (fact.seq !== held + 1) throw refusal("FACT_GAP", `Expected fact ${held + 1}.`, { acknowledged: state.held });
			added.set(fact.seq, text);
			held = fact.seq;
		}
		for (const [seq, text] of added) state.applied.set(seq, text);
		state.held = held;
		return held;
	}

	/** Laravel's answer to one request, after Sanctum's bearer check. */
	readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		if (request.headers.get("Authorization") !== `Bearer ${this.token}`) {
			return Response.json({ defined: true, code: "UNAUTHORIZED", status: 401, message: "Unauthenticated." }, { status: 401 });
		}
		const { matched, response } = await this.#handler.handle(request, { context: {} });
		return matched ? response : Response.json({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }, { status: 404 });
	};

	/** Routes the engine's client of Laravel here until the returned function is called. */
	install(): () => void {
		const previous = LARAVEL_NETWORK.fetch;
		LARAVEL_NETWORK.fetch = () => this.fetch;
		return () => {
			LARAVEL_NETWORK.fetch = previous;
		};
	}
}
