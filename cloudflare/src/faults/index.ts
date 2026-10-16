// The test build's Worker (cloudflare.config.ts, modes `faults` and `test`): the same Worker as src/index.ts, plus the fake
// Notes connector and its provider (connector.ts, provider.ts), which also hosts the fake Laravel the engine calls
// (laravel.ts, settings.ts), fault points in the Conversation's ports (ports.ts, plan.ts), and a
// token-gated driver at /api/faults/ for the account tests (routes.ts). It is deployed only as a test instance; the
// production build's entry is src/index.ts, which imports nothing from here (a unit test checks it), so none of this is in
// production.

import type { RunEvent } from "@minerva/contract";
import { createLocalJWKSet } from "jose";
import worker from "../index.ts";
import { PRICE_SOURCE } from "../budget/prices.ts";
import { CONNECTOR_SOURCE, servedConnectors } from "../connectors/index.ts";
import { Conversation as BaseConversation } from "../conversation/conversation.ts";
import { defaultPorts, PORTS } from "../conversation/ports.ts";
import { PAGE_LIMIT, type RunHead, RunStore } from "../conversation/store.ts";
import type { RunId } from "../shared/rpc.ts";
import { ACCESS_KEYS } from "../internal/access.ts";
import { PROVIDER_NETWORK } from "../internal/providers.ts";
import { LARAVEL_NETWORK } from "../laravel/client.ts";
import { notesConnector } from "./connector.ts";
import { hostedToken } from "./laravel.ts";
import { type Fault, type Fired, planOf } from "./plan.ts";
import { type CallMarks, type Calibration, executorContextOf, faultConversationPorts, laravelFetch, marksOf, providerFetch } from "./ports.ts";
import { faultPriceTable } from "./prices.ts";
import { faultRoutes } from "./routes.ts";
import { FAULTS_SETTINGS } from "./settings.ts";

CONNECTOR_SOURCE.connectors = async () => [...(await servedConnectors()), notesConnector()];
PORTS.factory = () => faultConversationPorts(defaultPorts);
// The fake model is charged too, and time at round numbers (prices.ts).
PRICE_SOURCE.table = faultPriceTable;
// The settings calls' provider requests (src/internal/providers.ts) reach the fake provider too, and nothing else.
PROVIDER_NETWORK.fetch = (env, workspace) => providerFetch(env, workspace.id);
// The default Access issuer is a placeholder (settings.ts): its keys are never fetched, so every assertion is refused.
const accessKeys = ACCESS_KEYS.of;
ACCESS_KEYS.of = (issuer) => (issuer === FAULTS_SETTINGS.MINERVA_ACCESS_ISSUER ? createLocalJWKSet({ keys: [] }) : accessKeys(issuer));
// Laravel is the fake each workspace's FaultProvider hosts (laravel.ts), reached with a token it checks.
LARAVEL_NETWORK.fetch = laravelFetch;
LARAVEL_NETWORK.token = hostedToken;

/** What a test reads of a run besides its API view: attempts, the ledger and pi's executions. */
export interface RunInternals {
	run: { [column: string]: SqlStorageValue } | null;
	attempts: { attempt: number; ended: string | null }[];
	writes: { key: string; status: string; attempt: number }[];
	executions: { call_id: string; executions: number }[];
	/** The tools the run's snapshot offers. */
	tools: string[];
	/** The model calls and tool executions pi started for the run, counted before any check. */
	entered: { model: number; tool: number };
	/** Each model call's marks, as this instance took them (ports.ts, `CallMarks`). */
	marks: CallMarks[];
}

/**
 * A run as a test reads it: its head (null before it is stored), its internals, the points that fired, and one page of its
 * events, bounded as RunStore's pages are, so no answer nears Workers RPC's limit.
 */
export interface RunView {
	head: RunHead | null;
	events: RunEvent[];
	internals: RunInternals;
	fired: Fired[];
}

/** The Conversation with a fault plan and a view of its tables for the tests. */
export class Conversation extends BaseConversation {
	faultPlan(faults: Fault[], config: { model?: string | null; runTimeoutMs?: number | null; calibrate?: Calibration | null } = {}): void {
		const plan = planOf(this.ctx);
		plan.set(faults);
		if (config.model !== undefined) plan.setConfig("model", config.model);
		if (config.calibrate !== undefined) plan.setConfig("calibrate", config.calibrate === null ? null : JSON.stringify(config.calibrate));
		if (config.runTimeoutMs !== undefined) plan.setConfig("run_timeout_ms", config.runTimeoutMs === null ? null : String(config.runTimeoutMs));
	}

	faultFired(): Fired[] {
		return planOf(this.ctx).fired();
	}

	faultRelease(point: string): void {
		planOf(this.ctx).release(point);
	}

	/**
	 * A late call from `attempt`, through the ports this object built for the run's executor (its own
	 * RunStatePort and CredentialPort): a write claim, a tool call's count and a credential lease.
	 */
	async faultLateCall(runId: RunId, attempt: number, connectionId: string): Promise<{ dispatch: unknown; counted: boolean; lease: unknown }> {
		const run = executorContextOf(this.ctx, runId);
		if (!run) throw new Error("This instance built no executor for the run.");
		const fence = { runId, attempt };
		return { dispatch: await run.run.dispatchWrite(fence, "k".repeat(64)), counted: run.run.countToolCall(fence), lease: await run.credentials.lease(fence, connectionId) };
	}

	/** A credential lease for `attempt`, through the object's own CredentialPort for the run. */
	async faultLease(runId: RunId, attempt: number, connectionId: string): Promise<unknown> {
		const run = executorContextOf(this.ctx, runId);
		if (!run) throw new Error("This instance built no executor for the run.");
		const lease = await run.credentials.lease({ runId, attempt }, connectionId);
		return "refused" in lease ? lease : { connectionId: lease.connectionId, generation: lease.generation };
	}

	/** The object's scheduled host jobs (the Agents SDK's queue), by id. */
	faultJobs(): { id: string; fn: string }[] {
		return this.ctx.storage.sql.exec<{ id: string; fn: string }>("SELECT id, fn FROM cf_agents_jobs ORDER BY id").toArray();
	}

	/**
	 * The run with its events after `after`, up to `upTo`: the head's `eventSeq` when null. A reader passes the `eventSeq` of
	 * its first page to the next ones, so the pages it joins end where that head did.
	 */
	faultView(runId: RunId, after = 0, upTo: number | null = null): RunView {
		const store = new RunStore(this.ctx.storage);
		const row = store.run(runId);
		const head = row ? store.runHead(row) : null;
		const events = head ? store.events(runId, { after, upTo: upTo ?? head.eventSeq, limit: PAGE_LIMIT }) : [];
		return { head, events, internals: this.faultRun(runId), fired: this.faultFired() };
	}

	faultRun(runId: RunId): RunInternals {
		const sql = this.ctx.storage.sql;
		const stored = sql.exec("SELECT 1 FROM runs WHERE id = ?", runId).toArray().length > 0;
		const tools = stored ? new RunStore(this.ctx.storage).snapshot({ id: runId }).tools.map((tool) => tool.name) : [];
		return {
			tools,
			entered: planOf(this.ctx).entered(runId),
			marks: marksOf(this.ctx, runId),
			run: sql.exec("SELECT id, status, attempt, error_code, error_message, revoked, activated, writes_uncertain, tool_calls, model_calls, allowance FROM runs WHERE id = ?", runId).toArray()[0] ?? null,
			attempts: sql.exec<{ attempt: number; ended: string | null }>("SELECT attempt, ended FROM attempts WHERE run_id = ? ORDER BY attempt", runId).toArray(),
			writes: sql.exec<{ key: string; status: string; attempt: number }>("SELECT key, status, attempt FROM run_writes WHERE run_id = ? ORDER BY dispatched_at", runId).toArray(),
			executions: sql.exec<{ call_id: string; executions: number }>("SELECT call_id, executions FROM tool_executions WHERE run_id = ? ORDER BY call_id", runId).toArray(),
		};
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return (await faultRoutes(request, env, ctx)) ?? worker.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { FaultProvider } from "./provider.ts";
// The Sandbox with the fault seams of the Sandbox row of ARCHITECTURE.md's Testing table (sandbox.ts), under production's export name.
export { FaultSandbox as Sandbox } from "./sandbox.ts";
export { Scripts } from "../scripts/scripts.ts";
