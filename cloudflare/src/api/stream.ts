// The run event stream (ARCHITECTURE.md: Events and the stream; contract `runEventsPath`): `GET
// /api/workspaces/{ws}/runs/{run}/stream` as server-sent events, relayed from the Conversation Durable
// Object's hibernatable WebSocket (conversation/stream.ts). Signed out is 401 `Unauthorized`; not a member,
// or not the caller's run in this workspace, 404 `NOT_FOUND` (unlike the JSON API's 401). The cursor is Last-Event-ID, else `?after=`, else 0; a value that is not all
// digits counts as 0.
//
// Each event is written as `id: <seq>\nevent: <type>\ndata: <JSON on one line>\n\n`, `event: end\ndata: {}`
// once the run is inactive and every event was sent, and `: keepalive` after 15 s of silence; never an
// unnamed `data:` frame, which the browser would dispatch as `message` and settle the turn. The object
// sends the backlog and subscribes in one synchronous step, so nothing falls between them; the relay skips
// any seq it already sent, so nothing is sent twice either. When the object closes its socket with 1013
// (a backlog over its limit, or a socket inherited by a new instance that cannot know what the old one
// missed), the relay opens a new socket from the last seq it sent; any other close, a client too slow to
// keep up, or a session that ended or a membership that did (checked every 60 s) ends the
// response, and the browser's EventSource reconnects with Last-Event-ID and loses nothing. A
// response ended that way drops the frames the client has not taken yet.

import type { Context } from "hono";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { conversationObject } from "../addressing.ts";
import { HttpError, errorAnswer } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import { Relay, openSocket, streamCursor } from "../stream/relay.ts";
import { type Member, member, param } from "./members.ts";

async function stream(c: Context<AppEnv>): Promise<Response> {
	const session = await currentSession(c.env, c.req.raw);
	if (!session.user || !session.sessionId) return withSessionCookies(errorAnswer("UNAUTHORIZED", "Unauthorized"), session);
	let m: Member;
	try {
		m = await member(c.env, session, param(c, "workspace"));
	} catch (error) {
		if (error instanceof HttpError) return withSessionCookies(errorAnswer("NOT_FOUND", "Not found."), session);
		throw error;
	}
	const runId = param(c, "run");
	const located = await m.object.locateRun(m.caller, runId);
	if (located === null) return withSessionCookies(errorAnswer("NOT_FOUND", "Not found."), session);
	const stub = conversationObject(c.env, m.workspace, located.conversationId);
	const userId = m.caller.userId;
	const after = streamCursor(c.req.raw);
	const socket = await openSocket(stub, runId, { user: userId }, after);
	if (socket === null) return withSessionCookies(errorAnswer("NOT_FOUND", "Not found."), session);
	const request = c.req.raw;
	const workspaceId = param(c, "workspace");
	const relay = new Relay(after, (cursor) => openSocket(stub, runId, { user: userId }, cursor), async () => {
		// Still signed in as the same user, and still a member of the workspace.
		const now = await currentSession(c.env, request);
		if (now.user?.id !== userId || !now.sessionId) return false;
		try {
			await member(c.env, now, workspaceId);
			return true;
		} catch (error) {
			if (error instanceof HttpError) return false;
			throw error;
		}
	});
	relay.attach(socket);
	const response = new Response(relay.readable, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
	});
	return withSessionCookies(response, session);
}

export function streamRoutes(app: App): void {
	app.get(`/api/workspaces/:workspace${UUID}/runs/:run${UUID}/stream`, stream);
}
