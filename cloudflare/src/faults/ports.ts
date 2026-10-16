// The test build's ports (src/faults/): the Conversation's own ports with the fake provider behind their network
// and fault points (plan.ts) around the steps the protocols must survive:
//
// - `tool:before`, `tool:after`: around the executor's answer for a tool call (filter `tool`);
// - `provider:write:before`: a write claimed in the ledger, before it is sent (`abort` or `throw` only:
//   claimed, never sent);
// - `provider:write:applied`: a write the provider applied, before its response reaches the executor
//   (`lose` drops the response as a lost connection would; `abort` crashes while it is dispatched);
// - `model:delta`: before a delta of the fake model's stream (filters `step`, `delta`);
// - `start:copy`: before a start copies its attachments into the folder, ahead of its transaction;
// - `gate:decided`, `gate:committed`: in the attempt gate, once it decided to end or restart a run, before
//   its transaction, and after the transaction and its sync (detail: the decision);
// - `local:prepared`: an attempt's container started, hardened, verified and hydrated;
// - `checkpoint:scanned`, `checkpoint:uploaded`, `checkpoint:recorded`: a checkpoint's scan taken, its
//   files stored in R2 but the checkpoint not recorded, and recorded but its held results not released;
// - `local:released`: a local call's result released by its checkpoint, before pi has it (filter `tool`).
//
// Each model call and tool execution pi starts is counted per run (`FaultPlan.entered`).
//
// A conversation whose plan sets `run_timeout_ms` starts Laravel's runs with that deadline.
// A conversation whose plan sets `model` to `workers-ai` gets Workers AI instead of the fake model. Never
// part of the production Worker.

import type { ConversationPorts, PortsContext } from "../conversation/ports.ts";
import type { ExecutorContext } from "../gateway/executor.ts";
import { fakeUpstream } from "../model/fake.ts";
import { upstreamOf } from "../model/route.ts";
import { parseJson } from "../lib/json.ts";
import { type FaultPlan, planOf } from "./plan.ts";
import type { FaultProvider } from "./provider.ts";
import { LARAVEL_HOST } from "./settings.ts";

/** Every request to a `*.fake.invalid` host goes to the workspace's FaultProvider; nothing else is allowed. */
export const FAKE_HOST_SUFFIX = ".fake.invalid";
export const NOT_FAKE = "The test build reaches only *.fake.invalid hosts.";

export function providerOf(env: Env, scope: string): DurableObjectStub<FaultProvider> {
	return (env as unknown as { FAULT_PROVIDER: DurableObjectNamespace<FaultProvider> }).FAULT_PROVIDER.getByName(scope);
}

/**
 * The network of the test build's executor: the fake provider, and nothing else, refused as a
 * blocked egress would be, so a real connector in its registry cannot reach its provider from a
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

/**
 * The network of the test build's client of Laravel: the fake Laravel of the workspace the request's scope names, hosted by its
 * FaultProvider (laravel.ts), and nothing else.
 */
export function laravelFetch(env: Env): typeof fetch {
	return async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		if (new URL(request.url).hostname !== LARAVEL_HOST) throw new TypeError(`The test build reaches Laravel only at ${LARAVEL_HOST}.`);
		const body = parseJson(await request.clone().text()) as { scope?: { workspace?: unknown } };
		const workspace = body.scope?.workspace;
		if (typeof workspace !== "string") return Response.json({ defined: false, code: "BAD_REQUEST", status: 400, message: "The request names no workspace." }, { status: 400 });
		return providerFetch(env, workspace)(request);
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
		point: (context, name, detail) =>
			planOf(context.ctx)
				.at(name, name === "local:released" ? { tool: detail, detail: detail ?? "" } : { detail: detail ?? "" }, ["abort", "oom", "throw", "hold", "note"])
				.then(() => {}),
		entered: (context, kind, runId) => planOf(context.ctx).enter(runId, kind),
		runTimeoutMs: (context) => {
			const configured = planOf(context.ctx).config("run_timeout_ms");
			return configured === null ? base.runTimeoutMs(context) : Number(configured);
		},
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
