// The event stream's Durable Object side (plan: Events and the stream; frontend 8; contracts/conversation.ts,
// StreamRequest). The Worker checks the session and the run's owner, then opens a hibernatable WebSocket
// here with `after`; the Worker's SSE relay (step 5) writes each frame as `id`, `event`, `data`.
//
// The backlog after `after` is sent and the socket subscribed in one synchronous step, so no event falls
// between them: the socket is accepted (and so reached by every later broadcast) in the same turn that
// reads and sends the backlog. Then one text frame per event, `JSON.stringify(event)`, and `{"type":"end"}`
// once the run is inactive and every event was sent, after which the socket is closed.
//
// Backpressure: a backlog is sent up to 4 MiB of frames; past that the socket is closed with 1013 so the
// client reconnects from the last event it got (Last-Event-ID) and loses nothing. workerd's WebSocket has no
// `bufferedAmount` and closes a socket by itself when its buffer is full; where a runtime exposes it, a
// socket buffering more than the same limit is dropped before the next frame.
//
// Only the instance that accepted a socket knows it sent every event committed since: hibernatable sockets
// outlive their instance, and one that died may have committed events it never sent. Each socket is tagged
// with the instance that accepted it; a later instance never writes to one it inherited, not a frame and not
// `end`, but closes it with 1013 the first time it would (and every one when it starts), so the client
// reconnects from its Last-Event-ID and gets the backlog, then `end`, from the new socket.

import type { LifecycleCapability } from "agents/lifecycle";
import type { RunId } from "../contracts/common.ts";
import type { RunEvent } from "../contracts/events.ts";
import { isUuid } from "../lib/random.ts";
import { ACTIVE } from "./events.ts";
import type { RunStore } from "./store.ts";

export const STREAM_PATH = "/stream";
const TAG = "minerva-stream";
const INSTANCE_TAG = "instance:";
/** How many bytes of frames a socket may hold or be sent in one backlog before it is dropped. */
export const STREAM_BUFFER_LIMIT = 4 * 1024 * 1024;
const END_FRAME = JSON.stringify({ type: "end" });
/** "Try again later": the client reconnects and resumes from its last event. */
const RECONNECT = 1013;

function runTag(runId: RunId): string {
	return `run:${runId}`;
}

/** `after` as the Worker sends it: digits only, else 0 (frontend 8.2). */
export function cursorOf(value: string | null): number {
	return value !== null && /^[0-9]{1,15}$/.test(value) ? Number(value) : 0;
}

function notFound(): Response {
	return new Response(JSON.stringify({ detail: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

/** Sends a frame unless the socket is over its limit, in which case it is dropped. */
function send(ws: WebSocket, frame: string): boolean {
	const buffered = (ws as { bufferedAmount?: unknown }).bufferedAmount;
	if (typeof buffered === "number" && buffered > STREAM_BUFFER_LIMIT) {
		close(ws, RECONNECT, "Reconnect to continue.");
		return false;
	}
	try {
		ws.send(frame);
		return true;
	} catch {
		return false;
	}
}

function close(ws: WebSocket, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
}

/**
 * The Lifecycle capability that claims `/stream` upgrades and the sockets it accepted; everything else goes
 * to the Agent's own WebSockets capability, which a Conversation does not use.
 */
export class RunStream implements Pick<LifecycleCapability, "claims"> {
	readonly claims = "selective" as const;
	readonly #ctx: DurableObjectState;
	readonly #store: () => RunStore;
	/** This instance's tag on the sockets it accepts: only those were sent every event since. */
	readonly #instance = `${INSTANCE_TAG}${crypto.randomUUID()}`;

	constructor(ctx: DurableObjectState, store: () => RunStore) {
		this.#ctx = ctx;
		this.#store = store;
	}

	/** Every upgrade is ours: the stream's, or a 404, so the Agent's own WebSockets never accept a socket here. */
	onWebSocketUpgrade({ request }: { request: Request }): Response {
		const url = new URL(request.url);
		if (url.pathname !== STREAM_PATH) return notFound();
		const runId = url.searchParams.get("run") ?? "";
		const user = url.searchParams.get("user") ?? "";
		const after = cursorOf(url.searchParams.get("after"));
		const store = this.#store();
		const conversation = store.conversation();
		const run = isUuid(runId) ? store.run(runId) : null;
		if (!conversation || conversation.deleted_at !== null || conversation.user_id !== user || !run) return notFound();
		const pair = new WebSocketPair();
		const server = pair[1];
		// From here to the end of the backlog nothing awaits, so no event is appended in between.
		this.#ctx.acceptWebSocket(server, [TAG, runTag(runId), this.#instance]);
		let sent = 0;
		let cursor = after;
		let complete = true;
		for (const { seq, frame } of store.eventFrames(runId, after)) {
			if (sent + frame.length > STREAM_BUFFER_LIMIT && sent > 0) {
				complete = false;
				break;
			}
			if (!send(server, frame)) return new Response(null, { status: 101, webSocket: pair[0] });
			sent += frame.length;
			cursor = seq;
		}
		if (!complete) close(server, RECONNECT, "Reconnect to continue.");
		else if (!ACTIVE.has(run.status) && cursor >= run.event_seq) {
			send(server, END_FRAME);
			close(server, 1000, "The run ended.");
		}
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/** One frame to every socket of the run this instance accepted, in the turn the event was committed. */
	broadcast(runId: RunId, event: RunEvent): void {
		const frame = JSON.stringify(event);
		for (const ws of this.#accepted(runId)) send(ws, frame);
	}

	/** The run is inactive and every event was sent: `end`, then close. */
	end(runId: RunId): void {
		for (const ws of this.#accepted(runId)) {
			send(ws, END_FRAME);
			close(ws, 1000, "The run ended.");
		}
	}

	/**
	 * When an instance starts: every socket it inherited is closed with 1013, whether or not its run ended,
	 * since it may have missed what an earlier instance committed and did not get to send, and no cursor is
	 * kept per socket. The client reconnects from its Last-Event-ID and gets the rest, and `end` if the run
	 * is over, from a socket this instance accepts.
	 */
	resetInherited(): void {
		for (const ws of this.#ctx.getWebSockets(TAG)) if (!this.#ours(ws)) close(ws, RECONNECT, "Reconnect to continue.");
	}

	/** The run's sockets this instance accepted; any other one is closed with 1013 (inherited, see above). */
	#accepted(runId: RunId): WebSocket[] {
		const accepted: WebSocket[] = [];
		for (const ws of this.#ctx.getWebSockets(runTag(runId))) {
			if (this.#ours(ws)) accepted.push(ws);
			else close(ws, RECONNECT, "Reconnect to continue.");
		}
		return accepted;
	}

	#ours(ws: WebSocket): boolean {
		try {
			return this.#ctx.getTags(ws).includes(this.#instance);
		} catch {
			return false;
		}
	}

	/** Drops every socket, for a deleted conversation. */
	closeAll(): void {
		for (const ws of this.#ctx.getWebSockets(TAG)) close(ws, 1000, "The conversation was deleted.");
	}

	#owns(ws: WebSocket): boolean {
		try {
			return this.#ctx.getTags(ws).includes(TAG);
		} catch {
			return false;
		}
	}

	/** A stream carries nothing from the client. */
	onWebSocketMessage(ws: WebSocket): boolean {
		return this.#owns(ws);
	}

	onWebSocketClose(ws: WebSocket, code: number, reason: string): boolean {
		if (!this.#owns(ws)) return false;
		close(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
		return true;
	}

	onWebSocketError(ws: WebSocket): boolean {
		return this.#owns(ws);
	}
}
