// The test build's Worker (cloudflare.config.ts, modes `faults` and `test`): the same Worker as
// src/index.ts, plus the fake Notes connector and its provider (connector.ts, provider.ts), fault points in
// the Conversation's and the Workspace's ports (ports.ts, plan.ts), a mailbox that keeps the emails it
// would send (mailbox.ts), and a token-gated driver at /api/faults/ for the account tests (routes.ts). It is deployed only as minerva-cf-test; the production
// build's entry is src/index.ts, which imports nothing from here (a unit test checks it), so none of this
// is in minerva-cf.

import worker from "../index.ts";
import { CONNECTOR_SOURCE, servedConnectors } from "../connectors/index.ts";
import { Conversation as BaseConversation } from "../conversation/conversation.ts";
import { defaultPorts, PORTS } from "../conversation/ports.ts";
import { RunStore } from "../conversation/store.ts";
import { SCRIPT_TIMEOUT_MS } from "../scripts/limits.ts";
import { SCRIPT_CLOCK } from "../scripts/run.ts";
import type { RunId } from "../shared/rpc.ts";
import { Workspace as BaseWorkspace, WORKSPACE_PORTS } from "../workspace/workspace.ts";
import { FLOW_CLIENTS } from "../api/oauth-clients.ts";
import { MAIL_TRANSPORT } from "../accounts/emails.ts";
import { PROVIDER_NETWORK } from "../api/providers.ts";
import { notesConnector } from "./connector.ts";
import { captureEmail } from "./mailbox.ts";
import { type Fault, type Fired, planOf } from "./plan.ts";
import { executorContextOf, faultConversationPorts, faultFlowClients, faultWorkspacePorts, providerFetch } from "./ports.ts";
import { faultRoutes } from "./routes.ts";

CONNECTOR_SOURCE.connectors = async () => [...(await servedConnectors()), notesConnector()];
PORTS.factory = () => faultConversationPorts(defaultPorts);
WORKSPACE_PORTS.factory = (deps, ctx, env) => faultWorkspacePorts(deps, ctx, env);
// The settings pages' provider calls (src/api/providers.ts) reach the fake provider too, and nothing else.
PROVIDER_NETWORK.fetch = (env, workspace) => providerFetch(env, workspace.id);
// Notes is listed and connects through OAuth with its fake provider's client (src/api/flows.ts).
const flowClients = FLOW_CLIENTS.of;
FLOW_CLIENTS.of = (env) => faultFlowClients(flowClients(env));
// Emails go to the mailbox the driver reads, never out (the build has no Email Sending binding).
MAIL_TRANSPORT.send = captureEmail;

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
}

/** The Conversation with a fault plan and a view of its tables for the tests. */
export class Conversation extends BaseConversation {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// A shorter wall clock for scripts, kept in the plan so an instance that restarts keeps it. It is the
		// isolate's: the account tests that set it run one at a time and set it back.
		const clock = planOf(ctx).config("script_clock_ms");
		if (clock !== null) SCRIPT_CLOCK.timeoutMs = Number(clock);
	}

	/** Sets (or, with null, restores) the scripts' wall clock (scripts/run.ts SCRIPT_CLOCK) in this object's isolate. */
	faultScriptClock(ms: number | null): void {
		planOf(this.ctx).setConfig("script_clock_ms", ms === null ? null : String(ms));
		SCRIPT_CLOCK.timeoutMs = ms ?? SCRIPT_TIMEOUT_MS;
	}

	faultPlan(faults: Fault[], config: { model?: string | null } = {}): void {
		const plan = planOf(this.ctx);
		plan.set(faults);
		if (config.model !== undefined) plan.setConfig("model", config.model);
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

	faultRun(runId: RunId): RunInternals {
		const sql = this.ctx.storage.sql;
		const stored = sql.exec("SELECT 1 FROM runs WHERE id = ?", runId).toArray().length > 0;
		const tools = stored ? new RunStore(this.ctx.storage).snapshot({ id: runId }).tools.map((tool) => tool.name) : [];
		return {
			tools,
			entered: planOf(this.ctx).entered(runId),
			run: sql.exec("SELECT id, status, attempt, error_code, error_message, revoked, activated, writes_uncertain, tool_calls, model_calls FROM runs WHERE id = ?", runId).toArray()[0] ?? null,
			attempts: sql.exec<{ attempt: number; ended: string | null }>("SELECT attempt, ended FROM attempts WHERE run_id = ? ORDER BY attempt", runId).toArray(),
			writes: sql.exec<{ key: string; status: string; attempt: number }>("SELECT key, status, attempt FROM run_writes WHERE run_id = ? ORDER BY dispatched_at", runId).toArray(),
			executions: sql.exec<{ call_id: string; executions: number }>("SELECT call_id, executions FROM tool_executions WHERE run_id = ? ORDER BY call_id", runId).toArray(),
		};
	}
}

/** The Workspace with a fault plan and a view of its connections for the tests. */
export class Workspace extends BaseWorkspace {
	faultPlan(faults: Fault[], config: { runTimeoutMs?: number | null } = {}): void {
		const plan = planOf(this.ctx);
		plan.set(faults);
		if (config.runTimeoutMs !== undefined) plan.setConfig("run_timeout_ms", config.runTimeoutMs === null ? null : String(config.runTimeoutMs));
	}

	faultFired(): Fired[] {
		return planOf(this.ctx).fired();
	}

	faultRelease(point: string): void {
		planOf(this.ctx).release(point);
	}

	faultConnection(connectionId: string): { status: string; generation: number; refresh_state: string } | null {
		return (
			this.ctx.storage.sql
				.exec<{ status: string; generation: number; refresh_state: string }>("SELECT status, generation, refresh_state FROM connections WHERE id = ?", connectionId)
				.toArray()[0] ?? null
		);
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return (await faultRoutes(request, env, ctx)) ?? worker.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { FaultProvider } from "./provider.ts";
export { FaultMailbox } from "./mailbox.ts";
// The Sandbox with the fault seams of the plan's Sandbox row (sandbox.ts), under production's export name.
export { FaultSandbox as Sandbox } from "./sandbox.ts";
export { Scripts } from "../scripts/scripts.ts";
