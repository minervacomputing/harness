// The test build's driver (src/faults/): POST /api/faults/<op> with a JSON body, for the account tests.
// It answers only a request with `X-Minerva-Faults: <faultsToken(MINERVA_SECRET_KEY)>`; any other request
// is passed on to the Worker, which answers 404 as for a path with no route. It calls the objects through
// addressing.ts as the API will (step 5), as a fixed test user, against the fake provider only.

import { conversationObject, workspaceObject } from "../addressing.ts";
import type { Caller, WorkspaceRef } from "../contracts/common.ts";
import type { GrantChange } from "../contracts/policy.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { FOLDER, NOTES, NOTES_CLIENT, NOTES_TOKEN_URL } from "./connector.ts";
import type { Conversation, Workspace } from "./index.ts";
import type { Fault } from "./plan.ts";
import { providerOf } from "./ports.ts";
import { FAULTS_HEADER, faultsToken } from "./token.ts";

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

async function operation(op: string, body: Body, env: Env): Promise<unknown> {
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
		case "workspace-faults":
			await ws.faultPlan((body.faults ?? []) as unknown as Fault[]);
			return { ok: true };
		case "post":
			return conversationOf(env, ref, String(body.conversationId)).postMessage(caller, { content: String(body.content), attachments: [] });
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
export async function faultRoutes(request: Request, env: Env): Promise<Response | null> {
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
		const result = await operation(url.pathname.slice(PREFIX.length), body, env);
		return result === null ? answer(404, { detail: "No such operation." }) : answer(200, result);
	} catch (error) {
		return answer(500, { detail: error instanceof Error ? error.message : String(error) });
	}
}
