// The run event stream (web-api 10.3; frontend 8; plan: Events and the stream): `GET
// /api/workspaces/{ws}/runs/{run}/stream` as server-sent events, relayed from the Conversation Durable
// Object's hibernatable WebSocket (conversation/stream.ts). Signed out is 401 `Unauthorized`; not a member,
// or not the caller's run in this workspace, 404 `Not found` (lowercase, as today's view answers, and
// unlike the JSON API's 401). The cursor is Last-Event-ID, else `?after=`, else 0; a value that is not all
// digits counts as 0.
//
// Each event is written as `id: <seq>\nevent: <type>\ndata: <JSON on one line>\n\n`, `event: end\ndata: {}`
// once the run is inactive and every event was sent, and `: keepalive` after 15 s of silence. The object
// sends the backlog and subscribes in one synchronous step, so nothing falls between them; the relay skips
// any seq it already sent, so nothing is sent twice either. When the object closes its socket with 1013
// (a backlog over its limit, or a socket inherited by a new instance that cannot know what the old one
// missed), the relay opens a new socket from the last seq it sent; any other close, a client too slow to
// keep up, or a session that ended or a membership that did (checked every 60 s, which today's view does
// not) ends the response, and the browser's EventSource reconnects with Last-Event-ID and loses nothing. A
// response ended that way drops the frames the client has not taken yet.

import type { Context } from "hono";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { conversationObject } from "../addressing.ts";
import type { RunId, UserId } from "../contracts/common.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { STREAM_PATH } from "../conversation/stream.ts";
import { HttpError, detail, unauthorized } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import { parseJson } from "../lib/json.ts";
import { type Member, member, param } from "./members.ts";

/** Timings and limits of a relayed stream; the tests shorten them. */
export const STREAM_TIMING = {
	keepaliveMs: 15_000,
	sessionCheckMs: 60_000,
	/**
	 * Bytes written that the client has not read yet; past this the response is closed and the client
	 * resumes. Above the object's backlog per socket (4 MiB), whose next part is asked for only once the
	 * client has read the last one.
	 */
	bufferLimit: 16 * 1024 * 1024,
	/** New sockets after a 1013 without an event in between, before the response is closed instead. */
	reopens: 3,
};

/** The largest cursor the object takes (15 digits, conversation/stream.ts `cursorOf`). */
const MAX_CURSOR = 999_999_999_999_999;

const KEEPALIVE = ": keepalive\n\n";
const END = "event: end\ndata: {}\n\n";
const RECONNECT = 1013;

function streamNotFound(): Response {
	return detail(404, "Not found");
}

/** Last-Event-ID, else the last `?after=`, else "0"; all digits or 0 (runs/stream.py). */
export function streamCursor(request: Request): number {
	const header = request.headers.get("Last-Event-ID");
	const raw = header || new URL(request.url).searchParams.getAll("after").at(-1) || "0";
	return /^[0-9]+$/.test(raw) ? Math.min(Number(raw), MAX_CURSOR) : 0;
}

type Stub = DurableObjectStub<Conversation>;

/** The object's socket for the run from `after`, or null when the object does not know the run or the user. */
async function openSocket(stub: Stub, runId: RunId, userId: UserId, after: number): Promise<WebSocket | null> {
	const query = new URLSearchParams({ run: runId, after: String(after), user: userId });
	const response = await stub.fetch(`http://conversation${STREAM_PATH}?${query}`, { headers: { Upgrade: "websocket" } });
	if (response.status !== 101 || !response.webSocket) {
		await response.body?.cancel();
		return null;
	}
	return response.webSocket;
}

/**
 * One SSE response: the object's frames as SSE, keepalives, the session and membership rechecked, and its
 * end. Frames wait in the relay's own queue until the runtime pulls them, a whole frame at a time, so an end
 * forced on the response drops what the client has not taken and closes it cleanly, never mid-frame.
 */
class Relay {
	readonly readable: ReadableStream<Uint8Array>;
	readonly #encoder = new TextEncoder();
	readonly #reopen: (after: number) => Promise<WebSocket | null>;
	readonly #allowed: () => Promise<boolean>;
	#socket: WebSocket | null = null;
	/** The last seq written. */
	#cursor: number;
	/** Frames written that the runtime has not taken yet, and their bytes. */
	#queue: Uint8Array[] = [];
	#pending = 0;
	/** The runtime's pull, waiting for a frame. */
	#waiting: (() => void) | null = null;
	/** Settles once the queue is empty. */
	#drained: PromiseWithResolvers<void> | null = null;
	#reopens = 0;
	#done = false;
	#keepalive: ReturnType<typeof setTimeout> | undefined;
	#session: ReturnType<typeof setInterval> | undefined;

	constructor(after: number, reopen: (after: number) => Promise<WebSocket | null>, allowed: () => Promise<boolean>) {
		this.#cursor = after;
		this.#reopen = reopen;
		this.#allowed = allowed;
		this.readable = new ReadableStream<Uint8Array>(
			{
				pull: (controller) => this.#pull(controller),
				// The client went away.
				cancel: () => this.finish(true),
			},
			{ highWaterMark: 0 },
		);
		this.#armKeepalive();
		this.#session = setInterval(() => {
			this.#allowed().then(
				(still) => {
					if (!still) this.finish(true);
				},
				// A check that could not be made keeps the stream; the next one decides.
				() => {},
			);
		}, STREAM_TIMING.sessionCheckMs);
	}

	attach(socket: WebSocket): void {
		if (this.#done) {
			close(socket, 1000);
			return;
		}
		this.#socket = socket;
		socket.accept();
		socket.addEventListener("message", (event) => this.#frame(event.data));
		socket.addEventListener("close", (event) => void this.#closed(socket, event.code));
		socket.addEventListener("error", () => void this.#closed(socket, 1006));
	}

	#frame(data: unknown): void {
		if (this.#done || typeof data !== "string") return;
		const frame = parseJson(data) as { type?: unknown; seq?: unknown; data?: unknown };
		if (frame.type === "end") {
			this.#write(END);
			this.finish();
			return;
		}
		if (typeof frame.seq !== "number" || typeof frame.type !== "string") return;
		// Already sent, from an earlier socket of this response.
		if (frame.seq <= this.#cursor) return;
		this.#cursor = frame.seq;
		this.#reopens = 0;
		this.#write(`id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
	}

	async #closed(socket: WebSocket, code: number): Promise<void> {
		if (this.#done || socket !== this.#socket) return;
		this.#socket = null;
		if (code !== RECONNECT || this.#reopens >= STREAM_TIMING.reopens) {
			this.finish();
			return;
		}
		this.#reopens++;
		let next: WebSocket | null = null;
		try {
			// The rest of a long backlog only once the runtime has taken what came before it.
			if (this.#queue.length > 0) {
				this.#drained ??= Promise.withResolvers<void>();
				await this.#drained.promise;
			}
			if (this.#done) return;
			next = await this.#reopen(this.#cursor);
		} catch (error) {
			console.error("The stream's socket could not be opened again", error);
		}
		if (next === null) this.finish();
		else this.attach(next);
	}

	async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
		for (;;) {
			const chunk = this.#queue.shift();
			if (chunk !== undefined) {
				this.#pending -= chunk.byteLength;
				if (this.#queue.length === 0) this.#settleDrained();
				controller.enqueue(chunk);
				return;
			}
			if (this.#done) {
				try {
					controller.close();
				} catch {
					// Cancelled by the client: the cancel's finish woke this pull.
				}
				return;
			}
			await new Promise<void>((resolve) => {
				this.#waiting = resolve;
			});
		}
	}

	#wake(): void {
		const waiting = this.#waiting;
		this.#waiting = null;
		waiting?.();
	}

	#settleDrained(): void {
		this.#drained?.resolve();
		this.#drained = null;
	}

	#write(text: string): void {
		if (this.#done) return;
		const bytes = this.#encoder.encode(text);
		this.#queue.push(bytes);
		this.#pending += bytes.byteLength;
		this.#wake();
		this.#armKeepalive();
		// The client reads too slowly: it resumes from its Last-Event-ID instead of this relay holding more.
		if (this.#pending > STREAM_TIMING.bufferLimit) this.finish(true);
	}

	#armKeepalive(): void {
		clearTimeout(this.#keepalive);
		this.#keepalive = setTimeout(() => this.#write(KEEPALIVE), STREAM_TIMING.keepaliveMs);
	}

	/** Ends the response once the client took what was written; `drop` ends it now, without what is queued. */
	finish(drop = false): void {
		if (this.#done) return;
		this.#done = true;
		clearTimeout(this.#keepalive);
		clearInterval(this.#session);
		if (this.#socket) close(this.#socket, 1000);
		this.#socket = null;
		if (drop) {
			this.#queue = [];
			this.#pending = 0;
		}
		this.#settleDrained();
		this.#wake();
	}
}

function close(socket: WebSocket, code: number): void {
	try {
		socket.close(code, "The stream ended.");
	} catch {
		// Already closed.
	}
}

async function stream(c: Context<AppEnv>): Promise<Response> {
	const session = await currentSession(c.env, c.req.raw);
	if (!session.user || !session.sessionId) return withSessionCookies(unauthorized(), session);
	let m: Member;
	try {
		m = await member(c.env, session, param(c, "workspace"));
	} catch (error) {
		if (error instanceof HttpError) return withSessionCookies(streamNotFound(), session);
		throw error;
	}
	const runId = param(c, "run");
	const located = await m.object.locateRun(m.caller, runId);
	if (located === null) return withSessionCookies(streamNotFound(), session);
	const stub = conversationObject(c.env, m.workspace, located.conversationId);
	const userId = m.caller.userId;
	const after = streamCursor(c.req.raw);
	const socket = await openSocket(stub, runId, userId, after);
	if (socket === null) return withSessionCookies(streamNotFound(), session);
	const request = c.req.raw;
	const workspaceId = param(c, "workspace");
	const relay = new Relay(after, (cursor) => openSocket(stub, runId, userId, cursor), async () => {
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
