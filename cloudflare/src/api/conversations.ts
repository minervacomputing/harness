// Conversations, messages, runs, uploads and a conversation's files (contract/src/conversations.ts), over the
// Workspace Durable Object (the index of conversations, the run registry, uploads) and each Conversation
// Durable Object (messages, runs, events, the folder). The conversation or run in the URL is checked against
// the workspace's own index before its object is addressed: an id from another workspace, another user's, or
// none at all is 404 without reaching an object (addressing.ts). The objects still check the caller themselves.
//
// A conversation's or a run's events have no size bound, and Workers RPC refuses a result over 32 MiB, so
// the objects answer heads and the body is streamed here, each run's events paged up to the seq its head
// was read with (plan: Events and the stream, Reading runs).
//
// Downloads stay a Hono route: they are checked here, then redirected to a link signed for the download
// Worker (minerva-cf-files, files/links.ts), which serves the object from its own origin as a sandboxed
// attachment. Agent files are never served from this origin.

import type { Context } from "hono";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { conversationObject } from "../addressing.ts";
import { settings } from "../config.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { START_KEY } from "../conversation/start-keys.ts";
import type { ConversationHead, RunHead } from "../conversation/store.ts";
import { downloadLinkFor } from "../files/links.ts";
import { HttpError, errorAnswer } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import type { ConversationId, RunId } from "../shared/rpc.ts";
import { canonicalUuid } from "./input.ts";
import { type Member, member, param } from "./members.ts";
import { api, checkStopped, inWorkspace, refusal, unwrap } from "./procedures.ts";

export const INVALID_KEY = "The Idempotency-Key header must be 1 to 255 visible ASCII characters.";

type ConversationStub = DurableObjectStub<Conversation>;

/** Events per page while a body is streamed; the object also stops a page at 4 MiB. */
const EVENT_PAGE = 1000;

/** The caller's conversation in this workspace, or 404. */
async function ownConversation(env: Env, m: Member, conversationId: ConversationId): Promise<ConversationStub> {
	if (!(await m.object.ownsConversation(m.caller, conversationId))) throw refusal("NOT_FOUND", "Not found.");
	return conversationObject(env, m.workspace, conversationId);
}

/** The object of the caller's run in this workspace, or 404. */
async function ownRun(env: Env, m: Member, runId: RunId): Promise<ConversationStub> {
	const located = await m.object.locateRun(m.caller, runId);
	if (located === null) throw refusal("NOT_FOUND", "Not found.");
	return conversationObject(env, m.workspace, located.conversationId);
}

function found<T>(value: T | null): T {
	if (value === null) throw refusal("NOT_FOUND", "Not found.");
	return value;
}

/**
 * A JSON body written while it is read: `produce` emits its text in order, each piece once the reader took the
 * one before. A failure after the first byte cuts the body short (the client sees invalid JSON and asks again);
 * it is logged. The mount labels it JSON (api/orpc.ts).
 */
function streamedJson(produce: (emit: (text: string) => Promise<void>) => Promise<void>): ReadableStream<Uint8Array> {
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
	return readable;
}

/** A run as the contract's `Run`: its fields, then every event up to the seq its head was read with, a page at a time. */
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

function runBody(stub: ConversationStub, m: Member, run: RunHead): ReadableStream<Uint8Array> {
	return streamedJson((emit) => emitRun(emit, stub, m, run));
}

function conversationBody(stub: ConversationStub, m: Member, head: ConversationHead): ReadableStream<Uint8Array> {
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

const conversations = api.conversations.use(inWorkspace);
const runs = api.runs.use(inWorkspace);
const uploads = api.uploads.use(inWorkspace);

export const conversationProcedures = conversations.router({
	list: conversations.list.handler(({ context: { member } }) => member.object.listConversations(member.caller)),

	create: conversations.create.handler(async ({ context: { member }, input }) => unwrap(await member.object.createConversation(member.caller, input.agentId))),

	get: conversations.get.handler(async ({ context, input }) => {
		const stub = await ownConversation(context.env, context.member, input.conversationId);
		return conversationBody(stub, context.member, found(await stub.getConversation(context.member.caller)));
	}),

	delete: conversations.delete.handler(async ({ context: { member }, input }) => {
		checkStopped(unwrap(await member.object.deleteConversation(member.caller, input.conversationId)).revocation);
	}),

	send: conversations.send.handler(async ({ context, input: { params, headers, body } }) => {
		const key = headers["idempotency-key"] ?? null;
		if (key !== null && !START_KEY.test(key)) throw refusal("INVALID_IDEMPOTENCY_KEY", INVALID_KEY);
		const stub = await ownConversation(context.env, context.member, params.conversationId);
		return unwrap(await stub.postMessage(context.member.caller, body, key));
	}),

	files: conversations.files.handler(async ({ context, input }) => {
		const stub = await ownConversation(context.env, context.member, input.conversationId);
		return found(await stub.listFiles(context.member.caller, input.version ?? null));
	}),
});

export const runProcedures = runs.router({
	get: runs.get.handler(async ({ context, input }) => {
		const stub = await ownRun(context.env, context.member, input.runId);
		return runBody(stub, context.member, found(await stub.getRun(context.member.caller, input.runId)));
	}),

	cancel: runs.cancel.handler(async ({ context, input }) => {
		const stub = await ownRun(context.env, context.member, input.runId);
		return runBody(stub, context.member, found(await stub.cancelRun(context.member.caller, input.runId)));
	}),
});

export const uploadProcedures = uploads.router({
	delete: uploads.delete.handler(async ({ context: { member }, input }) => {
		await member.object.deleteUpload(member.caller, input.uploadId);
	}),
});

/**
 * `GET …/files/download?path=&version=` (contract `downloadPath`): signed out 401; anything else wrong 404
 * (not a member, an invalid version, another user's conversation, a checkpoint, no such path). A file
 * found is a 302 to a link signed for the download origin, good for five minutes.
 */
async function download(c: Context<AppEnv>): Promise<Response> {
	const session = await currentSession(c.env, c.req.raw);
	if (!session.user || !session.sessionId) return withSessionCookies(errorAnswer("UNAUTHORIZED", "Unauthorized"), session);
	const missing = () => withSessionCookies(errorAnswer("NOT_FOUND", "Not found."), session);
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

export function downloadRoutes(app: App): void {
	app.get(`/api/workspaces/:workspace${UUID}/conversations/:conversation${UUID}/files/download`, download);
}
