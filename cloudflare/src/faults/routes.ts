// The test build's driver (src/faults/): POST /api/faults/<op> with a JSON body, for the account tests.
// It answers only a request with `X-Minerva-Faults-Token: <faultsToken(MINERVA_SECRET_KEY)>`; any other request
// is passed on to the Worker, which answers 404 as for a path with no route. It calls the objects through
// addressing.ts as the API does, as a fixed test user, against the fake provider only. Operations
// under `sandbox/` drive a Sandbox object of their own (lab.ts). `emails` and `emails-clear` read and empty
// the mailbox the build's emails go to (mailbox.ts); `download` serves a signed download link as the
// download origin (files-worker/) would, from the test Worker's own buckets, for the platform tests (the
// browser walk downloads through minerva-cf-files-test, the deployed download origin). `web/get`, `web/get-many`
// and `web/raw` fetch web addresses as the Web connector does (web.ts), for test/account/web-egress.test.ts.
// `setup-reopen` deletes the instance's setup claim (not the admins it made), so each browser walk claims the
// first-run setup through its page. `scrypt` hashes one password with the given parameters and nothing else,
// so the request's CPU time is the hash's: how the scrypt parameters were measured on the edge.

import { conversationObject, filesBucket, sandboxObject, workspaceObject } from "../addressing.ts";
import { hashPassword } from "../accounts/passwords.ts";
import type { GrantChange } from "../gateway/grants.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import { serveDownload } from "../files/download.ts";
import { receiveUpload } from "../files/uploads.ts";
import { type Json, parseJson } from "../lib/json.ts";
import type { Caller, WorkspaceRef } from "../shared/rpc.ts";
import { FOLDER, NOTES, NOTES_CLIENT, NOTES_TOKEN_URL } from "./connector.ts";
import type { Conversation, Workspace } from "./index.ts";
import { SandboxLab } from "./lab.ts";
import { mailboxOf } from "./mailbox.ts";
import type { Fault } from "./plan.ts";
import type { FaultSandbox } from "./sandbox.ts";
import { providerOf } from "./ports.ts";
import { FAULTS_HEADER, faultsToken } from "./token.ts";
import { webGet, webGetMany, webRaw } from "./web.ts";

const PREFIX = "/api/faults/";

interface Body {
	workspace: WorkspaceRef;
	userId: string;
	[key: string]: Json | WorkspaceRef | undefined;
}

function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function workspaceOf(env: Env, ref: WorkspaceRef): DurableObjectStub<Workspace> {
	return workspaceObject(env, ref) as unknown as DurableObjectStub<Workspace>;
}

function conversationOf(env: Env, ref: WorkspaceRef, id: string): DurableObjectStub<Conversation> {
	return conversationObject(env, ref, id) as unknown as DurableObjectStub<Conversation>;
}

/** The test user's grants: every folder, read and create. */
export const ALL_FOLDERS: GrantChange[] = [{ kind: FOLDER, id: "*", actions: ["read", "create"] }];

/** A workspace with a Notes connection the test user may read and write, on the default agent. */
export async function setUpWorkspace(
	env: Env,
	ref: WorkspaceRef,
	userId: string,
	options: { expired?: boolean; delays?: { [prefix: string]: number }; grants?: GrantChange[] } = {},
): Promise<{ connectionId: string; agentId: string }> {
	const caller: Caller = { userId, role: "owner" };
	await providerOf(env, ref.id).reset({ delays: options.delays ?? {} });
	const ws = workspaceOf(env, ref);
	await ws.init({ workspace: ref, kind: "personal", ownerId: userId, createdAt: Date.now() });
	const now = Math.floor(Date.now() / 1000);
	const saved = await ws.saveConnection(caller, {
		provider: NOTES,
		account: { id: "notes-account-1", label: "Notes account" },
		credentials: {
			kind: "oauth2",
			access_token: "notes-access-0",
			refresh_token: "notes-refresh-0",
			scopes: ["notes"],
			expires_at: options.expired ? now - 10 : now + 3600,
			client_id: NOTES_CLIENT.clientId,
			token_url: NOTES_TOKEN_URL,
		},
		connectionId: null,
	});
	if (!saved.ok) throw new Error(`The connection was refused: ${saved.refusal.detail}`);
	const connectionId = saved.value.id;
	const granted = await ws.applyGrantChanges(caller, connectionId, options.grants ?? ALL_FOLDERS, {});
	if (!granted.ok) throw new Error(`The grants were refused: ${granted.refusal.detail}`);
	const [agent] = await ws.listAgents(caller);
	if (!agent) throw new Error("The workspace has no agent.");
	const updated = await ws.updateAgent(caller, agent.id, { name: agent.name, instructions: "You are a test agent. Use the tools when asked.", connection_ids: [connectionId] });
	if (!updated.ok) throw new Error(`The agent was refused: ${updated.refusal.detail}`);
	return { connectionId, agentId: agent.id };
}

/** Deletes the setup claim, so the next claim through `/setup` succeeds; the admins it made stay admins. */
async function reopenSetup(db: D1Database): Promise<unknown> {
	const deleted = await db.prepare("DELETE FROM instance_setup WHERE id = 1").run();
	return { reopened: (deleted.meta.changes ?? 0) > 0 };
}

/** OWASP's equivalent scrypt settings (r 8, trading memory, 128 · r · N bytes, for CPU), all the measurement may ask for. */
const OWASP_SCRYPT: ReadonlyArray<{ logN: number; r: number; p: number }> = [
	{ logN: 17, r: 8, p: 1 },
	{ logN: 16, r: 8, p: 2 },
	{ logN: 15, r: 8, p: 3 },
	{ logN: 14, r: 8, p: 5 },
	{ logN: 13, r: 8, p: 10 },
];

/** One hash with one of OWASP's settings (or none, `rounds` 0, for the request's own cost), and the clocks around it. */
async function timeScrypt(body: Body): Promise<unknown> {
	const params = OWASP_SCRYPT.find((item) => item.logN === body.logN && item.r === body.r && item.p === body.p);
	if (!params) return { refused: "Only OWASP's equivalent settings are measured." };
	const rounds = body.rounds === 0 ? 0 : 1;
	const wall = Date.now();
	const perf = performance.now();
	if (rounds) await hashPassword("a password for the measurement", params);
	return { params, rounds, dateMs: Date.now() - wall, perfMs: performance.now() - perf };
}

async function operation(op: string, body: Body, env: Env, exports: Cloudflare.Exports): Promise<unknown> {
	if (op.startsWith("sandbox/")) return new SandboxLab(env, exports).run(op.slice("sandbox/".length), body);
	if (op === "emails") return { emails: await mailboxOf(env).list(typeof body.to === "string" ? body.to : null) };
	if (op === "emails-clear") return { cleared: await mailboxOf(env).clear(typeof body.to === "string" ? body.to : null) };
	if (op === "web/get") return webGet(String(body.url));
	if (op === "web/get-many") return webGetMany(((body.urls ?? []) as Json[]).map(String), body.together === true);
	if (op === "web/raw") return webRaw(String(body.url), typeof body.accept === "string" ? body.accept : null);
	if (op === "setup-reopen") return reopenSetup(env.DB);
	if (op === "scrypt") return timeScrypt(body);
	const ref = body.workspace;
	const caller: Caller = { userId: body.userId, role: "owner" };
	const ws = workspaceOf(env, ref);
	switch (op) {
		case "setup":
			return setUpWorkspace(env, ref, body.userId, { expired: body.expired === true, delays: (body.delays ?? {}) as { [prefix: string]: number } });
		case "conversation": {
			const created = await ws.createConversation(caller, String(body.agentId));
			if (!created.ok) return { refusal: created.refusal };
			await conversationOf(env, ref, created.value.id).faultPlan((body.faults ?? []) as unknown as Fault[], { model: (body.model ?? null) as string | null });
			return { conversationId: created.value.id };
		}
		case "conversation-model":
			// A conversation made through the API (the browser walk) gets Workers AI (`workers-ai`) or the fake
			// model (null). Set it before the conversation's first run: its object keeps the model it first called.
			await conversationOf(env, ref, String(body.conversationId)).faultPlan([], { model: (body.model ?? null) as string | null });
			return { ok: true };
		case "workspace-faults":
			await ws.faultPlan((body.faults ?? []) as unknown as Fault[]);
			return { ok: true };
		case "post":
			return conversationOf(env, ref, String(body.conversationId)).postMessage(caller, {
				content: String(body.content),
				attachments: (body.attachments ?? []) as string[],
			});
		case "upload": {
			// An upload as the step-5 route will make it: the Workspace records it, the body streams into R2 hashed.
			const data = new TextEncoder().encode(String(body.text ?? ""));
			const filler = Number(body.bytes ?? 0);
			if (filler > 0) {
				// `bytes` of one byte value (`fill`, 120 by default), streamed in 1 MiB pieces so a 50 MiB upload
				// does not sit in the isolate's memory; different values make different contents.
				const piece = new Uint8Array(Math.min(filler, 1 << 20)).fill(Number(body.fill ?? 120));
				let left = filler;
				const stream = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (left <= 0) return controller.close();
						const next = left >= piece.length ? piece : piece.subarray(0, left);
						left -= next.length;
						controller.enqueue(next.slice());
					},
				});
				return receiveUpload(ws, filesBucket(env, ref), caller, { name: String(body.name), size: filler, body: stream });
			}
			return receiveUpload(ws, filesBucket(env, ref), caller, { name: String(body.name), size: data.length, body: new Blob([data]).stream() });
		}
		case "files":
			return conversationOf(env, ref, String(body.conversationId)).listFiles(caller, (body.versionId ?? null) as string | null);
		case "file": {
			// A file of a version as a download would read it: its object in R2, the first 4,000 characters of it.
			const target = await conversationOf(env, ref, String(body.conversationId)).resolveDownload(caller, (body.versionId ?? null) as string | null, String(body.path));
			if (!target) return { target: null };
			const object = await filesBucket(env, ref).get(target.key);
			return { target, size: object?.size ?? null, text: object ? (await object.text()).slice(0, 4000) : null };
		}
		case "objects": {
			// The conversation's objects in R2 (blobs/<ws>/<conv>/), for the tests of loose and swept keys.
			const listed = await filesBucket(env, ref).list({ prefix: `blobs/${ref.id}/${String(body.conversationId)}/` });
			return { keys: listed.objects.map((object) => object.key), truncated: listed.truncated };
		}
		case "conversation-sandbox": {
			const sandbox = sandboxObject(env, exports, ref, String(body.conversationId)) as unknown as DurableObjectStub<FaultSandbox>;
			return { status: await sandbox.status(), running: await sandbox.faultRunning() };
		}
		case "script-clock":
			await conversationOf(env, ref, String(body.conversationId)).faultScriptClock((body.ms ?? null) as number | null);
			return { ok: true };
		case "delete-conversation":
			return ws.deleteConversation(caller, String(body.conversationId));
		case "run": {
			const conversation = conversationOf(env, ref, String(body.conversationId));
			const runId = String(body.runId);
			const head = await conversation.getRun(caller, runId);
			if (!head) return { head: null };
			const events = [];
			let after = 0;
			while (after < head.eventSeq) {
				const page = (await conversation.getRunEvents(caller, runId, { after, upTo: head.eventSeq, limit: 1000 })) ?? [];
				if (!page.length) break;
				events.push(...page);
				after = page[page.length - 1]?.seq ?? head.eventSeq;
			}
			return { head, events, internals: await conversation.faultRun(runId), fired: await conversation.faultFired() };
		}
		case "cancel":
			return conversationOf(env, ref, String(body.conversationId)).cancelRun(caller, String(body.runId));
		case "grants": {
			const started = Date.now();
			const changed = await ws.applyGrantChanges(caller, String(body.connectionId), (body.changes ?? []) as unknown as GrantChange[], {});
			return { started, answered: Date.now(), ok: changed.ok, revocation: changed.ok ? changed.value.revocation : null };
		}
		case "provider":
			return providerOf(env, ref.id).state();
		case "provider-authorize":
			// The user consents on the fake provider's page for an authorize URL the API answered (provider.ts).
			return providerOf(env, ref.id).authorize(String(body.url), (body.account ?? undefined) as { id: string; name: string } | undefined);
		case "delays":
			await providerOf(env, ref.id).setDelays((body.delays ?? {}) as { [prefix: string]: number });
			return { ok: true };
		case "connection":
			return { stored: await ws.faultConnection(String(body.connectionId)), listed: (await ws.listConnections(caller)).find((item) => item.id === body.connectionId) ?? null, fired: await ws.faultFired() };
		default:
			return null;
	}
}

/** The driver's answer, or null for a request that is not the driver's (the Worker answers it). */
export async function faultRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(PREFIX) || request.method !== "POST") return null;
	if (!timingSafeEqual(request.headers.get(FAULTS_HEADER) ?? "", await faultsToken(env.MINERVA_SECRET_KEY))) return null;
	let body: Body;
	try {
		body = parseJson(await request.text()) as unknown as Body;
	} catch {
		return answer(400, { detail: "The body is not JSON." });
	}
	try {
		const op = url.pathname.slice(PREFIX.length);
		// The download origin's answer itself, headers and body, for a GET of the link in `url`.
		if (op === "download") return await serveDownload(new Request(String(body.url), { headers: typeof body.range === "string" ? { range: body.range } : {} }), env);
		const result = await operation(op, body, env, ctx.exports);
		return result === null ? answer(404, { detail: "No such operation." }) : answer(200, result);
	} catch (error) {
		return answer(500, { detail: error instanceof Error ? error.message : String(error) });
	}
}
