// The test build's ports (src/faults/): the Conversation's own ports with the fake provider behind their network
// and fault points (plan.ts) around the steps the protocols must survive:
//
// - `tool:before`, `tool:after`: around the executor's answer for a tool call (filter `tool`);
// - `provider:write:before`: a write claimed in the ledger, before it is sent (`abort` or `throw` only:
//   claimed, never sent);
// - `provider:write:applied`: a write the provider applied, before its response reaches the executor
//   (`lose` drops the response as a lost connection would; `abort` crashes while it is dispatched);
// - `model:delta`: before a delta of the fake model's stream (filters `step`, `delta`);
// - `model:recorded`: a model call recorded, before its request is sent; `model:settle`: the upstream's terminal event
//   held, before the call's settlement; `model:settled`: the call settled, before pi hears its answer (detail: the call's
//   id). A `throw` at any of them resets the object, as a failed settlement does;
// - `settle:sealed`: a run's settlement job sealed its Sandbox and has its spans, before it writes `run.settled`;
//   `settle:written`: after that write, before the job ends (detail: the run's id);
// - `retain:step`: after each step of a retention pass committed, before the next (detail: the step, `facts`, `runs`, `pi`
//   or `orphan`), and after each step of a deleted conversation's purge (`clean`, `mark`, `blobs`, and `storage` between
//   the deletion of its storage and its `destroy()`, a fault taken before the deletion and logged again after it);
// - `retain:pass`: at a retention pass's start and end (detail: `start` or `end`; no end for a pass that destroyed the object),
//   whose notes time a pass on the object's clock (the perf probe);
// - `loop:created`: a run's pi session created, before the run claims it (detail: the session's id);
// - `pi:stop`: a run's end, before it marks pi's orphaned work (detail: the run's id); no other stop reaches it;
// - `start:copy`: before a start copies its attachments into the folder, ahead of its transaction;
// - `gate:decided`, `gate:committed`: in the attempt gate, once it decided to end or restart a run, before
//   its transaction, and after the transaction and its sync (detail: the decision);
// - `local:prepared`: an attempt's container started, hardened, verified and hydrated;
// - `checkpoint:scanned`, `checkpoint:uploaded`, `checkpoint:recorded`: a checkpoint's scan taken, its
//   files stored in R2 but the checkpoint not recorded, and recorded but its held results not released;
// - `local:released`: a local call's result released by its checkpoint, before pi has it (filter `tool`).
//
// Each model call and tool execution pi starts is counted per run (`FaultPlan.entered`), the run being the newest that names
// the call's session.
//
// A conversation whose plan sets `run_timeout_ms` starts Laravel's runs with that deadline, one whose plan sets `pi_settle_ms`
// lets a start wait that long for pi's earlier work before it resets the object (the bound, pi-stops.ts), and one whose plan
// sets `retention` keeps what it holds for those periods instead of RETENTION's,
// such as minutes.
// A conversation whose plan sets `model` to `workers-ai` gets Workers AI instead of the fake model. Never
// part of the production Worker.
//
// `model` set to `fake-remote` gets the fake model with one request to FAKE_MODEL_HOST before each answer (the perf probe),
// so each call sends a real outbound message, which the output gate holds until the object's
// writes are durable. Each call of a run is marked in memory (`CallMarks`, read with `faultView`), on the object's clock,
// which moves only when I/O completes. `calibrate` ({bytes, write}) writes that many random bytes through `outside` before
// each such request, as a record written before the send would, to show that the marks see a write; with `write` false it
// only generates them, the control for that CPU.

import type { ConversationPorts, PortsContext } from "../conversation/ports.ts";
import type { RetentionPeriods } from "../conversation/retention.ts";
import type { ExecutorContext } from "../gateway/executor.ts";
import { type FakeCall, type FakeOptions, fakeUpstream } from "../model/fake.ts";
import { type Upstream, upstreamOf } from "../model/route.ts";
import { parseJson } from "../lib/json.ts";
import { type FaultPlan, planOf } from "./plan.ts";
import type { FaultProvider } from "./provider.ts";
import { FAKE_MODEL_HOST, LARAVEL_HOST } from "./settings.ts";

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

/** One model call's marks, in Date.now() milliseconds; null until reached. */
export interface CallMarks {
	/** The wrapper's `host.begin` (ConversationPorts.entered). */
	begin: number;
	/** `fake-remote`'s request answered. */
	answered: number | null;
	/** The upstream's terminal event. */
	last: number | null;
}

/** Each run's model calls in the order they began, per object; lost with the instance. */
const callMarks = new WeakMap<DurableObjectState, Map<string, CallMarks[]>>();

export function marksOf(ctx: DurableObjectState, runId: string): CallMarks[] {
	let runs = callMarks.get(ctx);
	if (!runs) callMarks.set(ctx, (runs = new Map()));
	let marks = runs.get(runId);
	if (!marks) runs.set(runId, (marks = []));
	return marks;
}

/** The FaultProvider that answers a workspace's `fake-remote` requests: not the one hosting its Notes and fake Laravel. */
export function modelScope(workspace: string): string {
	return `${workspace}:model`;
}

/** The perf probe's calibration (`FaultPlan.ballast`), as a conversation's plan sets it. */
export interface Calibration {
	bytes: number;
	write: boolean;
}

/**
 * The newest run that names a session: its provider session for a model call, its pi session for a tool. While each run has
 * sessions of its own (chunk 19a), that is the call's own run, active or not.
 */
function runNaming(context: PortsContext, kind: "model" | "tool", session: string): string | null {
	const column = kind === "model" ? "provider_session" : "session";
	return context.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM runs WHERE ${column} = ? ORDER BY created_at DESC, id DESC LIMIT 1`, session).toArray()[0]?.id ?? null;
}

/** The fake model, sending one request to FAKE_MODEL_HOST before each answer and marking the call. */
function fakeRemote(context: PortsContext, plan: FaultPlan, onDelta: FakeOptions["onDelta"]): Upstream {
	const send = providerFetch(context.env, modelScope(context.workspace.id));
	// Taken when the call starts, before its request: a stream that ends late marks its own call, never a later one.
	const marksByCall = new WeakMap<FakeCall, CallMarks>();
	return fakeUpstream({
		onCall: (call, _context, options) => {
			const runId = options?.sessionId ? runNaming(context, "model", options.sessionId) : null;
			const marks = runId ? marksOf(context.ctx, runId).at(-1) : undefined;
			if (marks) marksByCall.set(call, marks);
		},
		onDelta,
		request: async (call, options) => {
			const calibration = plan.config("calibrate");
			if (calibration !== null) {
				const { bytes, write } = parseJson(calibration) as unknown as Calibration;
				await context.store.outside(() => plan.ballast(bytes, write));
			}
			const response = await send(`https://${FAKE_MODEL_HOST}/v1/messages`, { method: "POST", body: JSON.stringify({ step: call.step }), signal: options?.signal ?? null });
			await response.arrayBuffer();
			const marks = marksByCall.get(call);
			if (marks) marks.answered = Date.now();
		},
		onEnd: (call) => {
			const marks = marksByCall.get(call);
			if (marks) marks.last = Date.now();
		},
	});
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
		arm: (context, name, detail) => planOf(context.ctx).arm(name, { detail }, ["abort", "note"]),
		gate: (context, point, decision) => planOf(context.ctx).at(`gate:${point}`, { detail: decision }).then(() => {}),
		point: (context, name, detail) =>
			planOf(context.ctx)
				.at(name, name === "local:released" ? { tool: detail, detail: detail ?? "" } : { detail: detail ?? "" }, ["abort", "oom", "throw", "hold", "note"])
				.then(() => {}),
		entered: (context, kind, session) => {
			const runId = runNaming(context, kind, session);
			if (runId === null) return;
			if (kind === "model") marksOf(context.ctx, runId).push({ begin: Date.now(), answered: null, last: null });
			planOf(context.ctx).enter(runId, kind);
		},
		runTimeoutMs: (context) => {
			const configured = planOf(context.ctx).config("run_timeout_ms");
			return configured === null ? base.runTimeoutMs(context) : Number(configured);
		},
		piSettleMs: (context) => {
			const configured = planOf(context.ctx).config("pi_settle_ms");
			return configured === null ? base.piSettleMs(context) : Number(configured);
		},
		retention: (ctx) => {
			const configured = planOf(ctx).config("retention");
			return configured === null ? base.retention(ctx) : { ...base.retention(ctx), ...(parseJson(configured) as unknown as Partial<RetentionPeriods>) };
		},
		upstream: (route, context) => {
			const plan = planOf(context.ctx);
			const model = plan.config("model");
			if (model === "workers-ai") return upstreamOf({ ...route, provider: "workers-ai" }, (context.env as { AI?: Ai }).AI);
			const onDelta: FakeOptions["onDelta"] = async (call, index) => {
				await plan.at("model:delta", { step: call.step, delta: index });
			};
			return model === "fake-remote" ? fakeRemote(context, plan, onDelta) : fakeUpstream({ onDelta });
		},
	};
}
