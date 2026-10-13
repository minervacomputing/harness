// Conversations, messages, runs and a conversation's files, over the Workspace Durable Object (the index of
// conversations, the run registry, uploads) and each Conversation Durable Object (messages, runs, events,
// the folder). Every route checks membership first (members.ts), then the request's schema (422), then
// the conversation or run in the URL against the workspace's own index before its object is addressed:
// an id from another workspace, another user's, or none at all is 404 without reaching an object
// (addressing.ts). The objects still check the caller themselves.
//
// A conversation's or a run's events have no size bound, and Workers RPC refuses a result over 32 MiB, so
// the objects answer heads and the body is streamed here, each run's events paged up to the seq its head
// was read with (plan: Events and the stream, Reading runs).
//
// Downloads are checked here, then redirected to a link
// signed for the download Worker (minerva-cf-files, files/links.ts), which serves the object from its own
// origin as a sandboxed attachment. Agent files are never served from this origin.

import type { Context } from "hono";
import { z } from "zod";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { conversationObject } from "../addressing.ts";
import { settings } from "../config.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { START_KEY } from "../conversation/start-keys.ts";
import type { ConversationHead, RunHead } from "../conversation/store.ts";
import { downloadLinkFor } from "../files/links.ts";
import { HttpError, detail, json, notFound, unauthorized, validationError } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import type { ConversationId, RunId } from "../shared/rpc.ts";
import { canonicalUuid, readBody, readQuery, uuid } from "./input.ts";
import { type Member, afterRevocation, member, memberRoute, param, valueOf } from "./members.ts";

export const ConversationIn = z.object({ agent_id: uuid() });

/** `MessageIn`: at most 20,000 characters and 100 uploads. */
export const MessageIn = z.object({
	content: z.string().max(20_000),
	attachments: z.array(uuid()).max(100).default([]),
});

const FilesQuery = z.object({ version: uuid().optional() });

/** The header a client may send with a message it may send again (Conversation `postMessage`). */
export const IDEMPOTENCY_KEY = "Idempotency-Key";
export const INVALID_KEY = "The Idempotency-Key header must be 1 to 255 visible ASCII characters.";

const BASE = `/api/workspaces/:workspace${UUID}`;
const CONVERSATIONS = `${BASE}/conversations`;
const CONVERSATION = `${CONVERSATIONS}/:conversation${UUID}`;
const RUN = `${BASE}/runs/:run${UUID}`;

type ConversationStub = DurableObjectStub<Conversation>;

/** Events per page while a body is streamed; the object also stops a page at 4 MiB. */
const EVENT_PAGE = 1000;

function debugOf(c: Context<AppEnv>): boolean {
	return settings(c.env).debug;
}

/** The caller's conversation in this workspace, or `get_object_or_404`'s 404. */
async function ownConversation(c: Context<AppEnv>, m: Member, conversationId: ConversationId): Promise<ConversationStub> {
	if (!(await m.object.ownsConversation(m.caller, conversationId))) throw new HttpError(notFound("No Conversation matches the given query.", debugOf(c)));
	return conversationObject(c.env, m.workspace, conversationId);
}

/** The object of the caller's run in this workspace, or 404. */
async function ownRun(c: Context<AppEnv>, m: Member, runId: RunId): Promise<ConversationStub> {
	const located = await m.object.locateRun(m.caller, runId);
	if (located === null) throw new HttpError(notFound("No Run matches the given query.", debugOf(c)));
	return conversationObject(c.env, m.workspace, located.conversationId);
}

/** Refuses content holding a lone surrogate, which JSON can carry but is not text. */
function wellFormed(content: string): void {
	if (content.isWellFormed()) return;
	throw new HttpError(validationError([{ type: "invalid_format", loc: ["body", "content"], msg: "Invalid string: lone surrogate" }]));
}

/** The client's Idempotency-Key, if it sent one; 400 for one the object would not take. */
function startKey(request: Request): string | null {
	const key = request.headers.get(IDEMPOTENCY_KEY);
	if (key === null) return null;
	if (!START_KEY.test(key)) throw new HttpError(detail(400, INVALID_KEY));
	return key;
}

/**
 * A JSON body written while it is read: `produce` emits its text in order. A failure after the first byte
 * cuts the body short (the client sees invalid JSON and asks again); it is logged.
 */
function streamedJson(produce: (emit: (text: string) => Promise<void>) => Promise<void>): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const emit = (text: string) => writer.write(encoder.encode(text));
	produce(emit).then(
		() => writer.close(),
		(error: unknown) => {
			console.error("A streamed body failed", error);
			return writer.abort(error);
		},
	).catch(() => {});
	return new Response(readable, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

/** A run as `RunOut`: its fields, then every event up to the seq its head was read with, a page at a time. */
async function emitRun(emit: (text: string) => Promise<void>, stub: ConversationStub, m: Member, run: RunHead): Promise<void> {
	const { eventSeq, ...fields } = run;
	await emit(`${JSON.stringify(fields).slice(0, -1)},"events":[`);
	let after = 0;
	let first = true;
	while (after < eventSeq) {
		const page = await stub.getRunEvents(m.caller, run.id, { after, upTo: eventSeq, limit: EVENT_PAGE });
		// Null or empty: the conversation went away meanwhile; the body stays valid JSON.
		if (page === null || page.length === 0) break;
		await emit(`${first ? "" : ","}${page.map((event) => JSON.stringify(event)).join(",")}`);
		first = false;
		after = (page.at(-1) as { seq: number }).seq;
	}
	await emit("]}");
}

function runBody(stub: ConversationStub, m: Member, run: RunHead): Response {
	return streamedJson((emit) => emitRun(emit, stub, m, run));
}

function conversationBody(stub: ConversationStub, m: Member, head: ConversationHead): Response {
	const { runs, ...fields } = head;
	return streamedJson(async (emit) => {
		await emit(`${JSON.stringify(fields).slice(0, -1)},"runs":[`);
		for (const [index, run] of runs.entries()) {
			if (index > 0) await emit(",");
			await emitRun(emit, stub, m, run);
		}
		await emit("]}");
	});
}

/**
 * `GET …/files/download?path=&version=`: signed out 401; anything else wrong 404 "Not Found"
 * (not a member, an invalid version, another user's conversation, a checkpoint, no such path). A file
 * found is a 302 to a link signed for the download origin, good for five minutes.
 */
async function download(c: Context<AppEnv>): Promise<Response> {
	const session = await currentSession(c.env, c.req.raw);
	if (!session.user || !session.sessionId) return withSessionCookies(unauthorized(), session);
	const missing = () => withSessionCookies(detail(404, "Not Found"), session);
	let m: Member;
	try {
		m = await member(c.env, session, param(c, "workspace"));
	} catch (error) {
		if (error instanceof HttpError) return missing();
		throw error;
	}
	// A repeated parameter counts with its last value.
	const query = new URL(c.req.url).searchParams;
	const path = query.getAll("path").at(-1) ?? "";
	const rawVersion = query.getAll("version").at(-1) ?? "";
	const version = rawVersion === "" ? null : canonicalUuid(rawVersion);
	if (rawVersion !== "" && version === null) return missing();
	const conversationId = param(c, "conversation");
	if (!(await m.object.ownsConversation(m.caller, conversationId))) return missing();
	const target = await conversationObject(c.env, m.workspace, conversationId).resolveDownload(m.caller, version, path);
	if (target === null) return missing();
	const { downloadOrigin } = settings(c.env);
	const link = await downloadLinkFor(c.env.MINERVA_DOWNLOAD_KEY, downloadOrigin, { workspace: m.workspace, conversationId, userId: m.caller.userId, target });
	// The link is a bearer capability for five minutes: kept out of caches. The redirected request's Referer
	// is this origin only (the security headers' strict-origin-when-cross-origin).
	return withSessionCookies(new Response(null, { status: 302, headers: { Location: link, "Cache-Control": "no-store" } }), session);
}

export function conversationRoutes(app: App): void {
	app.get(
		CONVERSATIONS,
		memberRoute(async (_c, m) => json(200, await m.object.listConversations(m.caller))),
	);

	app.post(
		CONVERSATIONS,
		memberRoute(async (c, m) => {
			const input = await readBody(c.req.raw, ConversationIn);
			return json(201, valueOf(await m.object.createConversation(m.caller, input.agent_id)));
		}),
	);

	app.get(
		CONVERSATION,
		memberRoute(async (c, m) => {
			const stub = await ownConversation(c, m, param(c, "conversation"));
			const head = await stub.getConversation(m.caller);
			if (head === null) return notFound("No Conversation matches the given query.", debugOf(c));
			return conversationBody(stub, m, head);
		}),
	);

	app.delete(
		CONVERSATION,
		memberRoute(async (c, m) => {
			const { revocation } = valueOf(await m.object.deleteConversation(m.caller, param(c, "conversation")));
			return afterRevocation(revocation, json(204, null));
		}),
	);

	app.post(
		`${CONVERSATION}/messages`,
		memberRoute(async (c, m) => {
			const input = await readBody(c.req.raw, MessageIn);
			wellFormed(input.content);
			const key = startKey(c.req.raw);
			const stub = await ownConversation(c, m, param(c, "conversation"));
			return json(201, valueOf(await stub.postMessage(m.caller, { content: input.content, attachments: input.attachments }, key)));
		}),
	);

	app.get(
		`${CONVERSATION}/files`,
		memberRoute(async (c, m) => {
			const query = readQuery(c.req.raw, FilesQuery);
			const stub = await ownConversation(c, m, param(c, "conversation"));
			const folder = await stub.listFiles(m.caller, query.version ?? null);
			return folder === null ? notFound("No FolderVersion matches the given query.", debugOf(c)) : json(200, folder);
		}),
	);

	app.get(`${CONVERSATION}/files/download`, download);

	app.delete(
		`${BASE}/uploads/:upload${UUID}`,
		memberRoute(async (c, m) => {
			await m.object.deleteUpload(m.caller, param(c, "upload"));
			return json(204, null);
		}),
	);

	app.get(
		RUN,
		memberRoute(async (c, m) => {
			const runId = param(c, "run");
			const stub = await ownRun(c, m, runId);
			const run = await stub.getRun(m.caller, runId);
			return run === null ? notFound("No Run matches the given query.", debugOf(c)) : runBody(stub, m, run);
		}),
	);

	app.post(
		`${RUN}/cancel`,
		memberRoute(async (c, m) => {
			const runId = param(c, "run");
			const stub = await ownRun(c, m, runId);
			const run = await stub.cancelRun(m.caller, runId);
			return run === null ? notFound("No Run matches the given query.", debugOf(c)) : runBody(stub, m, run);
		}),
	);
}
