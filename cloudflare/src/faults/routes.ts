// The test build's driver (src/faults/): POST /api/faults/<op> with a JSON body, for the account tests, and Laravel's
// commands at /api/faults/internal/<path>, any method, served as /internal/<path> is past its Access check.
// It answers only a request with `X-Minerva-Faults-Token: <faultsToken(MINERVA_SECRET_KEY)>`; any other request
// is passed on to the Worker, which answers as it would without the driver (404). Its worlds are Laravel's: the workspace
// a body's `scope` names has the fake provider and the fake Laravel (provider.ts, laravel.ts), and its conversations are
// in the EU, as Laravel's are. The driver sets a world up and reads it; its runs are started, cancelled and read back
// through Laravel's commands. Operations under `sandbox/` drive a Sandbox object of their own (lab.ts).

import type { Scope } from "@minerva/contract/internal";
import { conversationObject, sandboxObject } from "../addressing.ts";
import { conversationPrefix } from "../files/objects.ts";
import { serveInternal } from "../internal/mount.ts";
import { stagingPrefix } from "../internal/start.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { uuid7 } from "../lib/random.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import type { Conversation } from "./index.ts";
import type { FakeRun } from "./laravel.ts";
import { SandboxLab } from "./lab.ts";
import type { Fault } from "./plan.ts";
import { providerOf } from "./ports.ts";
import type { FaultSandbox } from "./sandbox.ts";
import { FAULTS_HEADER, faultsToken } from "./token.ts";
import { notesLease } from "./world.ts";

const PREFIX = "/api/faults/";
/** Laravel's commands, as the internal API serves them past its Access check (src/internal/mount.ts). */
const INTERNAL = `${PREFIX}internal/`;

type Body = { [key: string]: Json };

function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Where a Laravel conversation lives: its workspace in the EU. */
function euRef(scope: Scope): WorkspaceRef {
	return { id: scope.workspace, jurisdiction: "eu" };
}

function conversationOf(env: Env, ref: WorkspaceRef, id: string): DurableObjectStub<Conversation> {
	return conversationObject(env, ref, id) as unknown as DurableObjectStub<Conversation>;
}

/**
 * Stages an upload as the browser's PUT to a URL Laravel signed would, under the workspace's staging prefix in the EU bucket:
 * `text`, or `bytes` of one byte value (`fill`, 120 by default) streamed in 1 MiB pieces so a 50 MiB upload does not sit in
 * the isolate's memory; different values make different contents. Answers its staging key and size.
 */
async function stage(bucket: R2Bucket, workspace: string, body: Body): Promise<{ upload: string; size: number }> {
	const upload = `${stagingPrefix(workspace)}${uuid7()}`;
	const filler = Number(body.bytes ?? 0);
	if (filler <= 0) {
		const data = new TextEncoder().encode(String(body.text ?? ""));
		await bucket.put(upload, data);
		return { upload, size: data.length };
	}
	const piece = new Uint8Array(Math.min(filler, 1 << 20)).fill(Number(body.fill ?? 120));
	let left = filler;
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (left <= 0) return controller.close();
			const next = left >= piece.length ? piece : piece.subarray(0, left);
			left -= next.length;
			controller.enqueue(next.slice());
		},
	});
	const sized = new FixedLengthStream(filler);
	const storing = bucket.put(upload, sized.readable);
	await source.pipeTo(sized.writable);
	await storing;
	return { upload, size: filler };
}

/** The operations on a Laravel world: the workspace `scope` names, and its conversation `conversationId`. */
async function laravelOperation(op: string, body: Body, env: Env, exports: Cloudflare.Exports): Promise<unknown> {
	const scope = body.scope as unknown as Scope;
	const provider = providerOf(env, scope.workspace);
	const conversationId = String(body.conversationId);
	switch (op) {
		case "setup": {
			// The fake provider starts over (the fake Laravel with it), and Laravel holds a Notes connection that lends the
			// provider's seeded token.
			await provider.reset({ delays: (body.delays ?? {}) as { [prefix: string]: number } });
			const connectionId = uuid7();
			await provider.laravelConnection(connectionId, notesLease());
			return { connectionId };
		}
		case "conversation":
			// Before the conversation's first start: its faults, its model (`workers-ai`, or null for the fake) and its deadline.
			await conversationOf(env, euRef(scope), conversationId).faultPlan((body.faults ?? []) as unknown as Fault[], {
				model: (body.model ?? null) as string | null,
				runTimeoutMs: (body.runTimeoutMs ?? null) as number | null,
			});
			return { ok: true };
		case "hold":
			// Laravel holds the run before it sends the start.
			await provider.laravelHold(String(body.runId), body.run as unknown as FakeRun);
			return { ok: true };
		case "stage":
			return stage(env.FILES_EU, scope.workspace, body);
		case "run":
			return conversationOf(env, euRef(scope), conversationId).faultView(String(body.runId), Number(body.after ?? 0), (body.upTo ?? null) as number | null);
		case "laravel": {
			// The connections without the secrets they lend.
			const { facts, calls, connections } = await provider.laravelState(conversationId);
			return { facts, calls, connections: Object.fromEntries(Object.entries(connections).map(([id, { status, generation, kind }]) => [id, { kind, status, generation }])) };
		}
		case "provider":
			return provider.state();
		case "object": {
			// A file of the conversation as a download would read it: its object in R2, the first 4,000 characters of it.
			const key = String(body.key);
			if (!key.startsWith(conversationPrefix(scope.workspace, conversationId))) return { size: null, text: null };
			const object = await env.FILES_EU.get(key);
			return { size: object?.size ?? null, text: object ? (await object.text()).slice(0, 4000) : null };
		}
		case "conversation-sandbox": {
			const sandbox = sandboxObject(env, exports, euRef(scope), conversationId) as unknown as DurableObjectStub<FaultSandbox>;
			return { status: await sandbox.status(), running: await sandbox.faultRunning() };
		}
		default:
			return null;
	}
}

async function operation(op: string, body: Body, env: Env, exports: Cloudflare.Exports): Promise<unknown> {
	if (op.startsWith("sandbox/")) return new SandboxLab(env, exports).run(op.slice("sandbox/".length), body);
	if (body.scope !== undefined) return laravelOperation(op, body, env, exports);
	return null;
}

/** The driver's answer, or null for a request that is not the driver's (the Worker answers it). */
export async function faultRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(PREFIX)) return null;
	if (!timingSafeEqual(request.headers.get(FAULTS_HEADER) ?? "", await faultsToken(env.MINERVA_SECRET_KEY))) return null;
	if (url.pathname.startsWith(INTERNAL)) {
		url.pathname = `/internal/${url.pathname.slice(INTERNAL.length)}`;
		try {
			return await serveInternal(new Request(url, request), env, "faults");
		} catch (error) {
			return answer(500, { detail: error instanceof Error ? error.message : String(error) });
		}
	}
	if (request.method !== "POST") return null;
	let body: Body;
	try {
		body = parseJson(await request.text()) as Body;
	} catch {
		return answer(400, { detail: "The body is not JSON." });
	}
	try {
		const op = url.pathname.slice(PREFIX.length);
		const result = await operation(op, body, env, ctx.exports);
		return result === null ? answer(404, { detail: "No such operation." }) : answer(200, result);
	} catch (error) {
		return answer(500, { detail: error instanceof Error ? error.message : String(error) });
	}
}
