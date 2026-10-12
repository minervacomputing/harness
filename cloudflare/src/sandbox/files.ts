// File operations (contracts/sandbox.ts FsRequest), each answered by minerva-fs as the agent's user through
// the wrapper, by a long-lived server process (`serve`) that runs them one at a time: one JSON line,
// sometimes followed by bytes whose length it gives. Its answers are the container's and so untrusted: each is checked for its shape before it goes
// back. A binary reader is a minerva-fs process that holds its file open and answers requests on stdin, so
// reads keep seeing the file that was opened even after a rename (pi's BinaryReader).

import type { FileErrorCode, FileInfo, LineScan } from "@earendil-works/pi-durable/env";
import type { FileHandle, FsAnswers, FsRequest, FsResponse, WatchSnapshot } from "../contracts/sandbox.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { ByteReader } from "./bytes.ts";
import { FILE_OPERATION_SECONDS, MAX_READ_BYTES, MAX_TEXT_BYTES } from "./constants.ts";
import { resolvePath } from "./paths.ts";
import { ContainerGone, helper, type Machine, startWrapped, type Wrapped } from "./process.ts";

const CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];
const KINDS = ["file", "directory", "symlink"];
const LINE_BYTES = 4 * 1024 * 1024;
/** A reader may stay open this long; killing strays ends it sooner. */
const READER_SECONDS = 600;
/** Readers open at once in an incarnation. */
const READERS = 64;

type Answer = { ok: true; value: Json } | { ok: false; code: FileErrorCode; message: string };

export class Malformed extends Error {}

/**
 * Sets an own property of a plain object, a path named `__proto__` included. Workers RPC cannot clone an
 * object without a prototype, so a map keyed by paths is a plain object with properties defined this way.
 */
export function setOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function failure(code: FileErrorCode, message: string): FsResponse {
	return { ok: false, code, message };
}

const UNAVAILABLE = (): FsResponse => failure("unknown", "The file operation failed in the sandbox.");

function decode(line: Uint8Array): Answer {
	const parsed = parseJson(new TextDecoder().decode(line));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Malformed("not an object");
	if (parsed.ok === true) return { ok: true, value: parsed.value ?? null };
	if (parsed.ok === false && typeof parsed.code === "string" && (CODES as readonly string[]).includes(parsed.code) && typeof parsed.message === "string") {
		return { ok: false, code: parsed.code as FileErrorCode, message: parsed.message };
	}
	throw new Malformed("not an answer");
}

function isObject(value: Json): value is { [key: string]: Json } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: Json): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function info(value: Json): FileInfo {
	if (!isObject(value) || typeof value.name !== "string" || typeof value.path !== "string" || typeof value.kind !== "string" || !KINDS.includes(value.kind)) {
		throw new Malformed("not a file's information");
	}
	if (!finite(value.size ?? null) || (value.size as number) < 0 || !finite(value.mtimeMs ?? null)) throw new Malformed("not a file's information");
	return { name: value.name, path: value.path, kind: value.kind as FileInfo["kind"], size: value.size as number, mtimeMs: value.mtimeMs as number };
}

function scan(value: Json): LineScan {
	const names = ["newlines", "start", "end", "firstLineEnd", "lastLineStart", "selectedBytes", "firstLineBytes"] as const;
	if (!isObject(value)) throw new Malformed("not a line scan");
	const out = {} as Record<(typeof names)[number], number>;
	for (const name of names) {
		const field = value[name];
		if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Malformed("not a line scan");
		out[name] = field;
	}
	return out;
}

function lengthOf(value: Json, max: number): number {
	if (!isObject(value) || typeof value.length !== "number" || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > max) {
		throw new Malformed("not a length");
	}
	return value.length;
}

function snapshot(value: Json): WatchSnapshot {
	if (!isObject(value)) throw new Malformed("not a snapshot");
	if (value.overflow === true) return { overflow: true };
	const entries = value.entries ?? null;
	if (!isObject(entries)) throw new Malformed("not a snapshot");
	const out: { [path: string]: string } = {};
	for (const [path, signature] of Object.entries(entries)) {
		if (typeof signature !== "string") throw new Malformed("not a snapshot");
		setOwn(out, path, signature);
	}
	return { entries: out };
}

/** Operations whose repetition changes nothing: a failed server may run them again on a new one. */
const IDEMPOTENT = new Set(["snapshot", "exists", "info", "canonical", "read-text", "opendir", "list", "truncate", "flush"]);

/** Whether running the operation twice leaves what running it once would: a whole write does, an append does not. */
function idempotent(op: string, args: readonly string[]): boolean {
	if (IDEMPOTENT.has(op)) return true;
	if (op === "write") return args[1] === "write";
	if (op === "mkdir") return args[1] === "1";
	return false;
}
/** Servers of one incarnation; calls queue for a free one. */
const SERVERS = 2;

class ServerGone extends Error {}

interface Server {
	wrapped: Wrapped;
	writer: WritableStreamDefaultWriter<Uint8Array>;
	busy: boolean;
	dead: boolean;
}

/**
 * Long-lived minerva-fs processes (`serve`) that answer the file operations, so a call costs no interpreter
 * start (about 40 ms in the VM). Each runs as the agent's user in its cgroup like any helper, so killing
 * strays ends them and the next call starts another. An answer is the bytes the operation alone would have
 * written. A call that outlives FILE_OPERATION_SECONDS kills its server.
 */
export class Servers {
	readonly #servers: Server[] = [];
	readonly #waiting: (() => void)[] = [];
	/** Bumped by `forget`: a server that finishes starting after it is stopped instead of kept. */
	#epoch = 0;

	async #take(machine: Machine): Promise<Server> {
		for (;;) {
			const idle = this.#servers.find((server) => !server.busy && !server.dead);
			if (idle) {
				idle.busy = true;
				return idle;
			}
			this.#prune();
			if (this.#servers.length < SERVERS) {
				const placeholder: Server = { wrapped: null as unknown as Wrapped, writer: null as unknown as WritableStreamDefaultWriter<Uint8Array>, busy: true, dead: false };
				this.#servers.push(placeholder);
				const epoch = this.#epoch;
				try {
					const wrapped = await startWrapped(machine, helper("serve", [], 0), { stdin: "pipe", stderr: "ignore" });
					if (epoch !== this.#epoch) {
						wrapped.stop();
						throw new Malformed("the file servers were stopped while this one started");
					}
					if (!wrapped.admission.started) throw new Malformed(`the file server did not start (${wrapped.admission.reason})`);
					placeholder.wrapped = wrapped;
					placeholder.writer = (wrapped.proc.stdin as WritableStream<Uint8Array>).getWriter();
					void wrapped.proc.exitCode.then(
						() => this.#kill(placeholder),
						() => this.#kill(placeholder),
					);
					return placeholder;
				} catch (error) {
					placeholder.dead = true;
					this.#prune();
					this.#waiting.shift()?.();
					// A container gone is the incarnation's end; anything else is this server's.
					if (error instanceof ContainerGone || error instanceof Malformed) throw error;
					throw new Malformed(error instanceof Error ? error.message : String(error));
				}
			}
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
	}

	#prune(): void {
		for (let i = this.#servers.length - 1; i >= 0; i--) if (this.#servers[i]?.dead) this.#servers.splice(i, 1);
	}

	#give(server: Server): void {
		server.busy = false;
		// A server forgotten while it answered is not kept.
		if (!this.#servers.includes(server)) {
			server.dead = true;
			server.wrapped?.stop();
		}
		this.#waiting.shift()?.();
	}

	#kill(server: Server): void {
		if (!server.dead) {
			server.dead = true;
			server.wrapped?.stop();
		}
		this.#prune();
		this.#waiting.shift()?.();
	}

	/** One operation's output, as running it alone would have written it. */
	async call(machine: Machine, op: string, args: string[], stdin?: Uint8Array): Promise<Uint8Array> {
		for (let tries = 0; ; tries++) {
			const server = await this.#take(machine);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let sent = false;
			try {
				const request = new TextEncoder().encode(`${JSON.stringify({ op, args, stdin: stdin?.length ?? 0 })}\n`);
				const answer = (async () => {
					await server.writer.write(request);
					sent = true;
					if (stdin?.length) await server.writer.write(stdin);
					const line = await server.wrapped.stdout.line(64 * 1024);
					if (line === null) throw new ServerGone("the file server ended");
					const header = parseJson(new TextDecoder().decode(line));
					const length = (header as { length?: unknown }).length;
					if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_TEXT_BYTES + LINE_BYTES) {
						throw new ServerGone("the file server's answer is unreadable");
					}
					return await server.wrapped.stdout.exactly(length);
				})();
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new ServerGone("a file operation took too long")), FILE_OPERATION_SECONDS * 1000);
				});
				const bytes = await Promise.race([answer, timeout]);
				this.#give(server);
				return bytes;
			} catch (error) {
				this.#kill(server);
				// A server that took the request and broke before answering may or may not have done it; one that
				// never took it (it had died, say with killed strays) did nothing.
				if (tries === 0 && (!sent || idempotent(op, args)) && !(error instanceof Malformed)) continue;
				throw new Malformed(error instanceof Error ? error.message : String(error));
			} finally {
				clearTimeout(timer);
			}
		}
	}

	/** Forgets every server: their processes are gone (killed strays, a destroyed container). */
	forget(): void {
		this.#epoch++;
		for (const server of this.#servers) {
			server.dead = true;
			server.wrapped?.stop();
		}
		this.#servers.length = 0;
		for (const wake of this.#waiting.splice(0)) wake();
	}
}

/** Runs one helper operation on a server and reads its answer, and the bytes after it when `bytes` says how many may follow. */
async function run(machine: Machine, servers: Servers, op: string, args: string[], options: { stdin?: Uint8Array; bytes?: number } = {}): Promise<{ answer: Answer; data: Uint8Array | null }> {
	const output = await servers.call(machine, op, args, options.stdin);
	const reader = new ByteReader(new Blob([output as Uint8Array<ArrayBuffer>]).stream());
	const line = await reader.line(LINE_BYTES);
	if (line === null) throw new Malformed("no answer");
	const answer = decode(line);
	let data: Uint8Array | null = null;
	if (answer.ok && options.bytes !== undefined) data = await reader.exactly(lengthOf(answer.value, options.bytes));
	return { answer, data };
}

interface Reader {
	handle: FileHandle;
	wrapped: Wrapped;
	out: ByteReader;
	writer: WritableStreamDefaultWriter<Uint8Array>;
	queue: Promise<unknown>;
	closed: boolean;
}

/** The binary readers of one incarnation, by id. */
/** `promise`, or a Malformed failure after `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Malformed(`${what} took too long`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export class Readers {
	readonly #readers = new Map<string, Reader>();
	/** Opens under way: they count against the cap before they are readers. */
	#opening = 0;
	#next = 0;

	get size(): number {
		return this.#readers.size;
	}

	async open(machine: Machine, path: string, noFollow: boolean): Promise<FsResponse> {
		if (this.#readers.size + this.#opening >= READERS) return failure("unknown", `More than ${READERS} files are open for reading.`);
		this.#opening++;
		try {
			return await this.#open(machine, path, noFollow);
		} finally {
			this.#opening--;
		}
	}

	async #open(machine: Machine, path: string, noFollow: boolean): Promise<FsResponse> {
		const wrapped = await startWrapped(machine, helper("reader", [path, noFollow ? "1" : "0"], READER_SECONDS), { stdin: "pipe", stderr: "ignore" });
		const writer = (wrapped.proc.stdin as WritableStream<Uint8Array>).getWriter();
		try {
			if (!wrapped.admission.started) throw new Malformed("the reader did not start");
			const out = wrapped.stdout;
			// A reader the agent stopped before it answered must not hold the call either.
			const line = await within(out.line(LINE_BYTES), FILE_OPERATION_SECONDS * 1000, "opening a file");
			if (line === null) throw new Malformed("no answer");
			const answer = decode(line);
			if (!answer.ok) {
				await writer.close().catch(() => undefined);
				await within(wrapped.proc.exitCode, 2000, "a reader's exit").catch(() => wrapped.stop());
				return answer;
			}
			const opened = info(answer.value);
			const extra = answer.value as { dev?: Json; ino?: Json };
			const id = `r${++this.#next}`;
			const handle: FileHandle = {
				id,
				path: opened.path,
				dev: finite(extra.dev ?? null) ? (extra.dev as number) : 0,
				ino: finite(extra.ino ?? null) ? (extra.ino as number) : 0,
				size: opened.size,
				mtimeMs: opened.mtimeMs,
			};
			this.#readers.set(id, { handle, wrapped, out, writer, queue: Promise.resolve(), closed: false });
			void wrapped.proc.exitCode.then(
				() => this.#gone(id),
				() => this.#gone(id),
			);
			return { ok: true, value: handle };
		} catch (error) {
			wrapped.stop();
			if (error instanceof Malformed) return UNAVAILABLE();
			throw error;
		}
	}

	#gone(id: string): void {
		const reader = this.#readers.get(id);
		if (!reader) return;
		reader.closed = true;
		this.#readers.delete(id);
	}

	/** One request to an open reader, answered in order. */
	request(handle: FileHandle, body: { op: "read"; offset: number; length: number } | { op: "scan"; start: number; end?: number } | { op: "stat" }): Promise<FsResponse> {
		const reader = this.#readers.get(handle.id);
		if (!reader || reader.closed) return Promise.resolve(failure("invalid", "Binary reader is closed"));
		const next = reader.queue.then(async (): Promise<FsResponse> => {
			if (reader.closed) return failure("invalid", "Binary reader is closed");
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const answered = (async (): Promise<FsResponse> => {
					await reader.writer.write(new TextEncoder().encode(`${JSON.stringify(body)}\n`));
					const line = await reader.out.line(LINE_BYTES);
					if (line === null) throw new Malformed("the reader ended");
					const answer = decode(line);
					if (!answer.ok) return answer;
					if (body.op === "read") return { ok: true, value: await reader.out.exactly(lengthOf(answer.value, MAX_READ_BYTES)) };
					if (body.op === "scan") return { ok: true, value: scan(answer.value) };
					return { ok: true, value: info(answer.value) };
				})();
				// A reader the agent stopped (SIGSTOP) must not hold the call: it is closed after the limit.
				const late = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Malformed("the reader took too long")), FILE_OPERATION_SECONDS * 1000);
				});
				return await Promise.race([answered, late]);
			} catch {
				reader.closed = true;
				reader.wrapped.stop();
				this.#readers.delete(handle.id);
				return failure("invalid", "Binary reader is closed");
			} finally {
				clearTimeout(timer);
			}
		});
		reader.queue = next.catch(() => undefined);
		return next;
	}

	async close(handle: FileHandle): Promise<void> {
		const reader = this.#readers.get(handle.id);
		if (!reader) return;
		this.#readers.delete(handle.id);
		reader.closed = true;
		await reader.queue;
		await reader.writer.close().catch(() => undefined);
		const exited = await Promise.race([reader.wrapped.proc.exitCode.then(() => true, () => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000))]);
		if (!exited) reader.wrapped.stop();
	}

	/** Forgets every reader: their processes are gone (killed strays, a destroyed container). */
	forget(): void {
		for (const reader of this.#readers.values()) {
			reader.closed = true;
			reader.wrapped.stop();
		}
		this.#readers.clear();
	}
}

function answerOf<Op extends keyof FsAnswers>(answer: Answer, read: (value: Json) => FsAnswers[Op]): FsResponse {
	if (!answer.ok) return answer;
	return { ok: true, value: read(answer.value) };
}

const nothing = (value: Json): null => {
	if (value !== null) throw new Malformed("not empty");
	return null;
};

/** One file operation. Expected failures come back as pi's codes; a helper that answers nonsense is `unknown`. */
export async function fileOperation(machine: Machine, helpers: { readers: Readers; servers: Servers }, request: FsRequest): Promise<FsResponse> {
	const { readers, servers } = helpers;
	try {
		switch (request.op) {
			case "absolute":
				return { ok: true, value: resolvePath(request.cwd, request.path) };
			case "canonical":
				return answerOf((await run(machine, servers, "canonical", [request.path])).answer, (value) => {
					if (typeof value !== "string") throw new Malformed("not a path");
					return value;
				});
			case "exists":
				return answerOf((await run(machine, servers, "exists", [request.path])).answer, (value) => {
					if (typeof value !== "boolean") throw new Malformed("not a boolean");
					return value;
				});
			case "info":
				return answerOf((await run(machine, servers, "info", [request.path])).answer, info);
			case "open":
				return await readers.open(machine, request.path, request.noFollow);
			case "read":
				return await readers.request(request.handle, { op: "read", offset: request.offset, length: Math.min(request.length, MAX_READ_BYTES) });
			case "scanLines":
				return await readers.request(request.handle, { op: "scan", start: request.startLine, ...(request.endLine === undefined ? {} : { end: request.endLine }) });
			case "stat":
				return await readers.request(request.handle, { op: "stat" });
			case "close":
				await readers.close(request.handle);
				return { ok: true, value: null };
			case "readText": {
				const limit = Math.min(request.maxBytes, MAX_TEXT_BYTES);
				const { answer, data } = await run(machine, servers, "read-text", [request.path, String(limit)], { bytes: limit });
				if (!answer.ok) return answer;
				// Node's readFile as UTF-8: a byte order mark is kept and invalid sequences become U+FFFD.
				return { ok: true, value: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data ?? new Uint8Array(0)) };
			}
			case "write":
				return answerOf((await run(machine, servers, "write", [request.path, request.append ? "append" : "write"], { stdin: request.content })).answer, nothing);
			case "truncate":
				return answerOf((await run(machine, servers, "truncate", [request.path, String(request.size)])).answer, nothing);
			case "flush":
				return answerOf((await run(machine, servers, "flush", [request.path])).answer, nothing);
			case "rename":
				return answerOf((await run(machine, servers, "rename", [request.from, request.to])).answer, nothing);
			case "opendir":
				return answerOf((await run(machine, servers, "opendir", [request.path])).answer, nothing);
			case "list":
				return answerOf((await run(machine, servers, "list", [request.path, request.after ?? "", String(request.max)])).answer, (value) => {
					if (!isObject(value) || !Array.isArray(value.entries) || !(value.next === null || typeof value.next === "string")) throw new Malformed("not a page");
					return { entries: value.entries.map(info), next: value.next };
				});
			case "mkdir":
				return answerOf((await run(machine, servers, "mkdir", [request.path, request.recursive ? "1" : "0"])).answer, nothing);
			case "remove":
				return answerOf((await run(machine, servers, "remove", [request.path, request.recursive ? "1" : "0", request.force ? "1" : "0"])).answer, nothing);
			case "mktemp":
				return answerOf((await run(machine, servers, "mktemp", [request.kind, request.prefix ?? (request.kind === "dir" ? "tmp-" : ""), request.suffix ?? ""])).answer, (value) => {
					if (typeof value !== "string") throw new Malformed("not a path");
					return value;
				});
			case "snapshot": {
				const body = new TextEncoder().encode(JSON.stringify({ targets: request.targets, maxEntries: request.maxEntries }));
				return answerOf((await run(machine, servers, "snapshot", [], { stdin: body })).answer, snapshot);
			}
		}
	} catch (error) {
		if (error instanceof Malformed || error instanceof SyntaxError) return UNAVAILABLE();
		throw error;
	}
}
