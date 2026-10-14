// A run's events relayed as server-sent events (ARCHITECTURE.md: Events and the stream), shared by the public stream
// (api/stream.ts, with the session) and Laravel's (stream/route.ts, with a stream token): the Conversation object's
// hibernatable WebSocket (conversation/stream.ts) read and written as SSE, with keepalives, reopened after a 1013, and ended
// when the reader may no longer read it.

import type { Conversation } from "../conversation/conversation.ts";
import { STREAM_PATH } from "../conversation/stream.ts";
import { parseJson } from "../lib/json.ts";
import type { RunId, UserId } from "../shared/rpc.ts";

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

/** Last-Event-ID, else the last `?after=`, else "0"; all digits or 0. */
export function streamCursor(request: Request): number {
	const header = request.headers.get("Last-Event-ID");
	const raw = header || new URL(request.url).searchParams.getAll("after").at(-1) || "0";
	return /^[0-9]+$/.test(raw) ? Math.min(Number(raw), MAX_CURSOR) : 0;
}

type Stub = DurableObjectStub<Conversation>;

/**
 * The object's socket for the run from `after`, or null when the object does not know the run, or the reader. The reader is
 * a user (the public stream: a Workspace conversation's owner) or an organization (a Laravel conversation's, with a stream
 * token), never both: the object checks each in its own mode (conversation/stream.ts).
 */
export async function openSocket(stub: Stub, runId: RunId, reader: { user: UserId } | { organization: string }, after: number): Promise<WebSocket | null> {
	const query = new URLSearchParams({ run: runId, after: String(after), ...reader });
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
export class Relay {
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
	#expiry: ReturnType<typeof setTimeout> | undefined;
	/** When the reader's grant ends (epoch ms), or null for none (the public stream, rechecked instead). */
	readonly #expiresAt: number | null;

	/**
	 * `allowed` is checked every `sessionCheckMs`; `expiresAt`, a stream token's end, closes the response hard when it comes,
	 * dropping what the client has not taken: it resumes from its last event with a new token.
	 */
	constructor(after: number, reopen: (after: number) => Promise<WebSocket | null>, allowed: () => Promise<boolean>, expiresAt: number | null = null) {
		this.#cursor = after;
		this.#reopen = reopen;
		this.#allowed = allowed;
		this.#expiresAt = expiresAt;
		if (expiresAt !== null) this.#expiry = setTimeout(() => this.finish(true), Math.max(0, expiresAt - Date.now()));
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
		// The time the socket took to open counts against the grant.
		if (this.#expired()) this.finish(true);
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
			if (this.#expired()) {
				this.finish(true);
				return;
			}
			next = await this.#reopen(this.#cursor);
		} catch (error) {
			console.error("The stream's socket could not be opened again", error);
		}
		if (next === null) this.finish();
		else this.attach(next);
	}

	async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
		for (;;) {
			// A grant that ended drops what is queued, also once the response was ending.
			if (this.#expired()) this.finish(true);
			const chunk = this.#queue.shift();
			if (chunk !== undefined) {
				this.#pending -= chunk.byteLength;
				if (this.#queue.length === 0) this.#settleDrained();
				controller.enqueue(chunk);
				return;
			}
			if (this.#done) {
				clearTimeout(this.#expiry);
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

	#expired(): boolean {
		return this.#expiresAt !== null && Date.now() >= this.#expiresAt;
	}

	#armKeepalive(): void {
		clearTimeout(this.#keepalive);
		this.#keepalive = setTimeout(() => this.#write(KEEPALIVE), STREAM_TIMING.keepaliveMs);
	}

	/**
	 * Ends the response once the client took what was written; `drop` ends it now, without what is queued, also when it was
	 * already ending. The grant's expiry stays armed until the client took the last frame, so it can still drop the rest.
	 */
	finish(drop = false): void {
		if (!this.#done) {
			this.#done = true;
			clearTimeout(this.#keepalive);
			clearInterval(this.#session);
			if (this.#socket) close(this.#socket, 1000);
			this.#socket = null;
		}
		if (drop) {
			clearTimeout(this.#expiry);
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
