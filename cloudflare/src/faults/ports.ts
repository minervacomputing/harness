// The test build's ports (src/faults/): the Conversation's and the Workspace's own ports with the fake
// provider behind their network and fault points (plan.ts) around the steps the protocols must survive.
// Points, by object:
//
// Conversation
// - `tool:before`, `tool:after`: around the executor's answer for a tool call (filter `tool`);
// - `provider:write:before`: a write claimed in the ledger, before it is sent (`abort` or `throw` only:
//   claimed, never sent);
// - `provider:write:applied`: a write the provider applied, before its response reaches the executor
//   (`lose` drops the response as a lost connection would; `abort` crashes while it is dispatched);
// - `model:delta`: before a delta of the fake model's stream (filters `step`, `delta`);
// - `start:begin`: before `beginRun` is asked;
// - `start:copy`: between `beginRun`'s answer and the start's transaction (where the copies happen);
// - `activate:before`, `activate:lost`: around the activation (`lose` drops the Workspace's answer);
// - `lease:before`: before the Workspace is asked for a credential lease;
// - `gate:decided`, `gate:committed`: in the attempt gate, once it decided to end or restart a run, before
//   its transaction, and after the transaction and its sync (detail: the decision);
// Workspace
// - `refresh:before`, `refresh:answered`: around the token endpoint's answer (`lose` drops it);
// - `cancel:before`, `cancel:lost`: around delivering a cancel (`lose` drops the acknowledgement).
//
// Each model call and tool execution pi starts is counted per run (`FaultPlan.entered`).
//
// A workspace whose plan sets `run_timeout_ms` starts its runs with that deadline.
// A conversation whose plan sets `model` to `workers-ai` gets Workers AI instead of the fake model. Never
// part of the production Worker.

import type { ExecutorContext } from "../contracts/executor.ts";
import type { ConversationPorts, PortsContext, WorkspaceClient } from "../conversation/ports.ts";
import type { ConversationClient, OAuthClients } from "../workspace/ports.ts";
import type { WorkspaceDeps } from "../workspace/core.ts";
import type { ReplaceablePorts } from "../workspace/workspace.ts";
import { fakeUpstream } from "../model/fake.ts";
import { upstreamOf } from "../model/route.ts";
import { NOTES, NOTES_CLIENT } from "./connector.ts";
import { type FaultPlan, planOf } from "./plan.ts";
import type { FaultProvider } from "./provider.ts";

/** Every request to a `*.fake.invalid` host goes to the workspace's FaultProvider; nothing else is allowed. */
export const FAKE_HOST_SUFFIX = ".fake.invalid";
export const NOT_FAKE = "The test build reaches only *.fake.invalid hosts.";

export function providerOf(env: Env, scope: string): DurableObjectStub<FaultProvider> {
	return (env as unknown as { FAULT_PROVIDER: DurableObjectNamespace<FaultProvider> }).FAULT_PROVIDER.getByName(scope);
}

/**
 * The network of the test build's executor and refreshes: the fake provider, and nothing else, refused as a
 * blocked egress would be, so a real connector in its registry (step 6) cannot reach its provider from a
 * Worker the token-gated driver controls. Models go through the AI binding, not here.
 */
export function providerFetch(env: Env, scope: string): typeof fetch {
	return async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		if (!new URL(request.url).hostname.endsWith(FAKE_HOST_SUFFIX)) throw new TypeError(NOT_FAKE);
		const signal = request.signal;
		signal.throwIfAborted();
		const answer = providerOf(env, scope).fetch(request);
		// A request cut by its caller (a revocation, a timeout) stops waiting for the provider.
		return await new Promise<Response>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	};
}

const LOST = () => new TypeError("Network connection lost.");

function isWrite(request: Request): boolean {
	return !["GET", "HEAD"].includes(request.method);
}

/** The Conversation's network, with a fault point after the provider applied a write. */
function conversationFetch(context: PortsContext, plan: FaultPlan): typeof fetch {
	const send = providerFetch(context.env, context.workspace.id);
	return async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const write = isWrite(request) && new URL(request.url).hostname.endsWith(FAKE_HOST_SUFFIX);
		const detail = new URL(request.url).pathname;
		// Only a crash or a throw: the request was admitted already (CallIo), so a hold here would send it later.
		if (write) await plan.at("provider:write:before", { detail }, ["abort", "throw"]);
		const response = await send(request);
		if (write && (await plan.at("provider:write:applied", { detail })) === "lose") throw LOST();
		return response;
	};
}

/** The run's ports as the object built them for its executor, last one per run: the tests call them late. */
const executorContexts = new WeakMap<DurableObjectState, Map<string, ExecutorContext>>();

export function executorContextOf(ctx: DurableObjectState, runId: string): ExecutorContext | null {
	return executorContexts.get(ctx)?.get(runId) ?? null;
}

/** The Conversation's ports in the test build, around the ones it would use. */
export function faultConversationPorts(base: ConversationPorts): ConversationPorts {
	return {
		...base,
		fetch: (context) => conversationFetch(context, planOf(context.ctx)),
		executor: (run, context) => {
			const inner = base.executor(run, context);
			const plan = planOf(context.ctx);
			let runs = executorContexts.get(context.ctx);
			if (!runs) executorContexts.set(context.ctx, (runs = new Map()));
			runs.set(run.runId, run);
			return {
				declarations: () => inner.declarations(),
				async invoke(request) {
					await plan.at("tool:before", { tool: request.name });
					const outcome = await inner.invoke(request);
					await plan.at("tool:after", { tool: request.name });
					return outcome;
				},
			};
		},
		workspace: (context) => {
			const inner = base.workspace(context);
			const plan = planOf(context.ctx);
			const client: WorkspaceClient = {
				async beginRun(input) {
					await plan.at("start:begin");
					return inner.beginRun(input);
				},
				async activate(runId) {
					await plan.at("activate:before");
					const answer = await inner.activate(runId);
					if ((await plan.at("activate:lost")) === "lose") throw LOST();
					return answer;
				},
				release: (runId, status) => inner.release(runId, status),
				conversationTouched: (conversationId, change) => inner.conversationTouched(conversationId, change),
				async lease(connectionId, purpose) {
					await plan.at("lease:before");
					return inner.lease(connectionId, purpose);
				},
				markUnauthorized: (connectionId, generation) => inner.markUnauthorized(connectionId, generation),
			};
			return client;
		},
		folder: (context) => {
			const inner = base.folder(context);
			const plan = planOf(context.ctx);
			return {
				...inner,
				async prepareAttachments(runId, uploads) {
					await plan.at("start:copy");
					return inner.prepareAttachments(runId, uploads);
				},
			};
		},
		gate: (context, point, decision) => planOf(context.ctx).at(`gate:${point}`, { detail: decision }).then(() => {}),
		entered: (context, kind, runId) => planOf(context.ctx).enter(runId, kind),
		upstream: (route, context) => {
			const plan = planOf(context.ctx);
			if (plan.config("model") === "workers-ai") return upstreamOf({ ...route, provider: "workers-ai" }, (context.env as { AI?: Ai }).AI);
			return fakeUpstream({
				onDelta: async (call, index) => {
					await plan.at("model:delta", { step: call.step, delta: index });
				},
			});
		},
	};
}

/** The operator's client for the fake provider's app; no other app has one. */
const fakeClients: OAuthClients = {
	configured: (app) => (app === NOTES ? { ...NOTES_CLIENT } : null),
	stored: async () => null,
};

/** The Workspace's ports in the test build. */
export function faultWorkspacePorts(deps: WorkspaceDeps, ctx: DurableObjectState, env: Env): ReplaceablePorts {
	const plan = planOf(ctx);
	// The object is named by the workspace's id (an EU one `eu:<id>` in local runs, addressing.ts).
	const scope = (ctx.id.name ?? "").replace(/^eu:/, "");
	const send = providerFetch(env, scope);
	const conversations: ConversationClient = {
		init: (input) => deps.conversations.init(input),
		async cancel(conversationId, runId, reason, entryId) {
			await plan.at("cancel:before");
			const ack = await deps.conversations.cancel(conversationId, runId, reason, entryId);
			if ((await plan.at("cancel:lost")) === "lose") throw LOST();
			return ack;
		},
		destroy: (conversationId) => deps.conversations.destroy(conversationId),
	};
	const settings = { ...deps.settings };
	Object.defineProperty(settings, "runTimeoutMs", {
		enumerable: true,
		get: () => {
			const configured = plan.config("run_timeout_ms");
			return configured === null ? deps.settings.runTimeoutMs : Number(configured);
		},
	});
	return {
		oauth: fakeClients,
		conversations,
		settings,
		fetch: async (input, init) => {
			await plan.at("refresh:before");
			const response = await send(input, init);
			if ((await plan.at("refresh:answered")) === "lose") throw LOST();
			return response;
		},
	};
}
