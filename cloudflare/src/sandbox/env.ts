// The ExecutionEnv pi's local tools get (plan: The local tools):
// pi's `FileSystem & Shell`, each call forwarded to the Sandbox Durable Object of the run's incarnation. It
// is a thin client, made per tool call: paths are resolved here as pi's NodeExecutionEnv resolves them
// (with the container's HOME), arguments are checked here as pi checks them, and everything else happens
// in the container as the agent's user. Expected failures come back as pi's Results, never as throws.
//
// When the Sandbox refuses a call for its fence (stale, not verified) or the call itself fails, the
// container is gone or in doubt: the call fails, and `lost` tells the Conversation, which ends the attempt
// and replaces the container from the last checkpoint (plan: The local tools).

import {
	type BinaryReader,
	type DirReader,
	err,
	ExecutionError,
	type ExecutionEnv,
	FileError,
	type FileInfo,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { ExecOutputSink, ExecRequest, ExecResult } from "./commands.ts";
import { commandEnvironment, MAX_BINARY_BYTES, MAX_TEXT_BYTES, WORKSPACE } from "./constants.ts";
import type { Refused, SandboxFence } from "./core.ts";
import { type FsRequest, type FsResponse, MAX_ENTRIES, type Opened, type WatchSnapshot } from "./files.ts";
import type { Delivered } from "./output.ts";
import { join, resolvePath } from "./paths.ts";

type Context = Parameters<ExecutionEnv["exec"]>[2];

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** How often a watch compares snapshots; changes show within about this plus a call. */
const POLL_MS = 250;
/** Entries a watch may cover; beyond it the watcher stops with an error. */
const WATCH_ENTRIES = 10_000;
/** A listing's entries and their full paths' units, which come into this isolate. */
const LIST_ENTRIES = 100_000;
const LIST_UNITS = 16 * 1024 * 1024;

/** The Sandbox calls the environment makes: a stub of the object, or the object itself in tests. */
export interface SandboxClient {
	exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused>;
	cancel(fence: SandboxFence, execId: string): Promise<void>;
	fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused>;
	killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused>;
}

export interface SandboxEnvOptions {
	sandbox: SandboxClient;
	fence: SandboxFence;
	/** Where relative paths resolve and commands start; /workspace. */
	cwd?: string;
	/** The run's deadline: a command without its own timeout stops there. */
	deadline?: number | null;
	/** Makes the RpcTarget the Sandbox sends a command's output to (sink.ts in a Durable Object). */
	sink(output: (chunk: Delivered) => void): ExecOutputSink;
	/** The container is gone or in doubt. Called once. */
	lost?(reason: string): void;
	now?(): number;
	pollMs?: number;
}

function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

function aborted(context: Context, path?: string): Result<never, FileError> | undefined {
	return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

let execCounter = 0;

/** pi's ExecutionEnv over the Sandbox of one incarnation. */
export class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #options: SandboxEnvOptions;
	#lost = false;

	constructor(options: SandboxEnvOptions) {
		this.#options = options;
		// The incarnation, so pi's per-file mutation queues are keyed by the container they change.
		this.id = `sandbox:${options.fence.incarnation}`;
		this.cwd = options.cwd ?? WORKSPACE;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	#gone(reason: string): void {
		if (this.#lost) return;
		this.#lost = true;
		this.#options.lost?.(reason);
	}

	/** One file operation; a refusal or a failed call loses the sandbox and fails with `unknown`. */
	async #fs(request: FsRequest, path?: string): Promise<{ ok: true; value: unknown } | { ok: false; error: FileError }> {
		let response: FsResponse | Refused;
		try {
			response = await this.#options.sandbox.fs(this.#options.fence, request);
		} catch (error) {
			this.#gone(`A file operation failed: ${error instanceof Error ? error.message : String(error)}`);
			return { ok: false, error: new FileError("unknown", "The sandbox stopped.", path) };
		}
		if (isRefused(response)) {
			this.#gone(response.message);
			return { ok: false, error: new FileError("unknown", response.message, path) };
		}
		if (!response.ok) return { ok: false, error: new FileError(response.code, response.message, path) };
		return { ok: true, value: response.value };
	}

	async #value<T>(request: FsRequest, path: string | undefined, context: Context): Promise<Result<T, FileError>> {
		const stopped = aborted(context, path);
		if (stopped) return stopped;
		const answer = await this.#fs(request, path);
		return answer.ok ? ok(answer.value as T) : err(answer.error);
	}

	async #done(request: FsRequest, path: string, context: Context): Promise<Result<void, FileError>> {
		const result = await this.#value<null>(request, path, context);
		if (!result.ok) return result;
		return aborted(context, path) ?? ok(undefined);
	}

	#resolve(path: string): string {
		return resolvePath(this.cwd, path);
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.#resolve(path);
		const bytes = await this.#value<Uint8Array>({ op: "readFile", path: resolved, maxBytes: MAX_TEXT_BYTES }, resolved, context);
		if (!bytes.ok) return bytes;
		// Node's readFile as UTF-8: a byte order mark is kept and invalid sequences become U+FFFD.
		return ok(new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.value));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = this.#resolve(path);
		const text = await this.readTextFile(resolved, context);
		if (!text.ok) return text;
		// pi's line reader decodes as a stream, which drops a leading byte order mark.
		let rest: string | null = text.value.startsWith("﻿") ? text.value.slice(1) : text.value;
		let closed = false;
		return ok({
			async readLine(lineContext: Context): Promise<Result<TextLine | undefined, FileError>> {
				const stopped = aborted(lineContext, resolved);
				if (stopped) return stopped;
				if (closed) return err(new FileError("invalid", "Text line reader is closed", resolved));
				if (rest === null) return ok(undefined);
				const newline = rest.indexOf("\n");
				if (newline !== -1) {
					const line = rest.slice(0, newline);
					rest = rest.slice(newline + 1);
					return ok({ text: line, terminated: true });
				}
				const last = rest;
				rest = null;
				return last === "" ? ok(undefined) : ok({ text: last, terminated: false });
			},
			async close(): Promise<void> {
				closed = true;
				rest = null;
			},
		});
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.#resolve(path);
		return this.#value<Uint8Array>({ op: "readFile", path: resolved, maxBytes: MAX_BINARY_BYTES }, resolved, context);
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const resolved = this.#resolve(path);
		const noFollow = options?.noFollow === true;
		const opened = await this.#value<FileInfo>({ op: "open", path: resolved, noFollow }, resolved, context);
		if (!opened.ok) return opened;
		return aborted(context, resolved) ?? ok(this.#reader(resolved, { size: opened.value.size, mtimeMs: opened.value.mtimeMs, noFollow }));
	}

	/**
	 * A reader that reads its path again on every call and refuses a file that is no longer the one it
	 * opened (shorter, or rewritten at the same size); a file appended to is still the same file.
	 */
	#reader(path: string, opened: Opened): BinaryReader {
		let closed = false;
		const refused = (context: Context) => aborted(context, path) ?? (closed ? err<never, FileError>(new FileError("invalid", "Binary reader is closed", path)) : undefined);
		return {
			info: async (context: Context): Promise<Result<FileInfo, FileError>> => {
				return refused(context) ?? this.#value<FileInfo>({ op: "stat", path, opened }, path, context);
			},
			read: async (offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> => {
				const stopped = refused(context);
				if (stopped) return stopped;
				if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
					return err(new FileError("invalid", "Offset and length must be non-negative safe integers", path));
				}
				// The bytes come into this isolate: a read is bounded, as a whole binary read is.
				if (length > MAX_BINARY_BYTES) return err(new FileError("invalid", `A read takes at most ${MAX_BINARY_BYTES} bytes`, path));
				if (length === 0) return ok(new Uint8Array(0));
				const bytes = await this.#value<Uint8Array>({ op: "read", path, opened, offset, length }, path, context);
				if (!bytes.ok) return bytes;
				return aborted(context, path) ?? bytes;
			},
			scanLines: async (options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> => {
				const stopped = refused(context);
				if (stopped) return stopped;
				const end = options.endLine ?? Number.POSITIVE_INFINITY;
				if (!Number.isSafeInteger(options.startLine) || options.startLine < 0 || !(end > options.startLine) || (end !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(end))) {
					return err(new FileError("invalid", "Invalid line range", path));
				}
				return this.#value<LineScan>({ op: "scanLines", path, opened, startLine: options.startLine, ...(options.endLine === undefined ? {} : { endLine: options.endLine }) }, path, context);
			},
			close: async (): Promise<void> => {
				closed = true;
			},
		};
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		return this.#done({ op: "writeFile", path: resolved, content: bytes }, resolved, context);
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		return this.#done({ op: "appendFile", path: resolved, content: bytes }, resolved, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const stopped = aborted(context, resolved);
		if (stopped) return stopped;
		if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		return this.#done({ op: "truncate", path: resolved, size }, resolved, context);
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		return this.#done({ op: "flush", path: resolved }, resolved, context);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.#resolve(sourcePath);
		const destination = this.#resolve(destinationPath);
		const stopped = aborted(context, destination);
		if (stopped) return stopped;
		const answer = await this.#fs({ op: "rename", from: source, to: destination }, source);
		return answer.ok ? ok(undefined) : err(answer.error);
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.#resolve(path);
		return this.#value<FileInfo>({ op: "lstat", path: resolved }, resolved, context);
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const opened = await this.openDirReader(path, context);
		if (!opened.ok) return opened;
		const entries: FileInfo[] = [];
		try {
			for (;;) {
				const page = await opened.value.next(MAX_ENTRIES, context);
				if (!page.ok) return page;
				entries.push(...page.value.entries);
				if (page.value.done) return ok(entries);
			}
		} finally {
			await opened.value.close(context);
		}
	}

	/** The directory's names are read at once; each page's entries are `lstat`ed as it is asked for. */
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = this.#resolve(path);
		const listed = await this.#value<string[]>({ op: "readDirectory", path: resolved }, resolved, context);
		if (!listed.ok) return listed;
		const stopped = aborted(context, resolved);
		if (stopped) return stopped;
		const names = listed.value;
		let units = 0;
		// Each name is kept, then becomes a full path.
		for (const name of names) units += name.length + resolved.length + 1;
		if (names.length > LIST_ENTRIES || units > LIST_UNITS) return err(new FileError("unknown", `The directory holds more than ${LIST_ENTRIES} entries`, resolved));
		let closed = false;
		let next = 0;
		return ok({
			next: async (maxEntries: number, nextContext: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> => {
				const nextStopped = aborted(nextContext, resolved);
				if (nextStopped) return nextStopped;
				if (closed) return err(new FileError("invalid", "Directory reader is closed", resolved));
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", resolved));
				if (next >= names.length) return ok({ entries: [], done: true });
				const paths = names.slice(next, next + Math.min(maxEntries, MAX_ENTRIES)).map((name) => join(resolved, name));
				const page = await this.#value<(FileInfo | null)[]>({ op: "entries", paths }, resolved, nextContext);
				if (!page.ok) return page;
				next += paths.length;
				return ok({ entries: page.value.filter((entry) => entry !== null), done: next >= names.length });
			},
			close: async (): Promise<void> => {
				closed = true;
			},
		});
	}

	async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const stopped = aborted(context);
		if (stopped) return stopped;
		const resolved: WatchTarget[] = targets.map((target) => ({ ...target, path: this.#resolve(target.path) }));
		const take = async (): Promise<Result<WatchSnapshot, FileError>> => this.#value<WatchSnapshot>({ op: "snapshot", targets: resolved, maxEntries: WATCH_ENTRIES }, undefined, {} as Context);
		const first = await take();
		if (!first.ok) return first;
		if ("overflow" in first.value) return err(new FileError("unknown", `The watched files are more than ${WATCH_ENTRIES}.`));
		let previous = first.value.entries;
		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let polling: Promise<void> = Promise.resolve();
		const report = (change: WatchChange) => {
			if (!closed) onChange(change);
		};
		const poll = async () => {
			if (closed) return;
			const next = await take();
			if (closed) return;
			if (!next.ok || "overflow" in next.value) {
				// The watcher stops: no calls follow an error.
				report({ error: next.ok ? new FileError("unknown", `The watched files grew past ${WATCH_ENTRIES}.`) : next.error });
				closed = true;
				return;
			}
			const current = next.value.entries;
			const changed: string[] = [];
			for (const path of Object.keys(previous)) if (previous[path] !== current[path]) changed.push(path);
			for (const path of Object.keys(current)) if (!(path in previous)) changed.push(path);
			previous = current;
			if (changed.length) report({ paths: changed });
			if (!closed) timer = setTimeout(() => (polling = poll()), this.#options.pollMs ?? POLL_MS);
		};
		timer = setTimeout(() => (polling = poll()), this.#options.pollMs ?? POLL_MS);
		if (context.abortSignal?.aborted) {
			closed = true;
			clearTimeout(timer);
			return err(new FileError("aborted", "aborted"));
		}
		return ok({
			mode: "polling",
			close: async () => {
				closed = true;
				clearTimeout(timer);
				await polling.catch(() => undefined);
			},
		});
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.#resolve(path);
		return this.#value<string>({ op: "canonical", path: resolved }, resolved, context);
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : err(info.error);
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const result = await this.#value<null>({ op: "mkdir", path: resolved, recursive: options?.recursive ?? true }, resolved, context);
		return result.ok ? ok(undefined) : result;
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#resolve(path);
		const result = await this.#value<null>({ op: "remove", path: resolved, recursive: options?.recursive ?? false, force: options?.force ?? false }, resolved, context);
		return result.ok ? ok(undefined) : result;
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#value<string>({ op: "mktemp", kind: "dir", prefix: prefix ?? "tmp-", suffix: "" }, undefined, context);
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#value<string>({ op: "mktemp", kind: "file", prefix: options?.prefix ?? "", suffix: options?.suffix ?? "" }, undefined, context);
	}

	async cleanup(_context: Context): Promise<void> {
		try {
			const result = await this.#options.sandbox.killStrays(this.#options.fence);
			if (isRefused(result)) this.#gone(result.message);
			else if (!result.ok) this.#gone(result.message);
		} catch (error) {
			this.#gone(`Killing strays failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined) {
			if (!Number.isFinite(timeout) || timeout <= 0) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			if (timeout * 1000 > MAX_TIMEOUT_MS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
		}
		if (typeof command !== "string" && command.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		let seconds = timeout ?? 0;
		const deadline = this.#options.deadline;
		if (deadline !== undefined && deadline !== null) {
			const left = (deadline - this.#now()) / 1000;
			if (left <= 0) return err(new ExecutionError("timeout", `timeout:${timeout}`));
			seconds = seconds === 0 ? left : Math.min(seconds, left);
		}
		const env = options?.inheritEnv === false ? { ...(options.env ?? {}) } : { ...commandEnvironment(), ...(options?.env ?? {}) };
		const execId = `x${++execCounter}-${this.#now()}`;
		const request: ExecRequest = {
			execId,
			command: typeof command === "string" ? command : [...command],
			cwd: options?.cwd ? this.#resolve(options.cwd) : this.cwd,
			env,
			timeoutSeconds: seconds,
			...(options?.spill ? { spill: options.spill } : {}),
			...(options?.window ? { window: options.window } : {}),
		};
		let settled = false;
		let callbackError: ExecutionError | undefined;
		const cancel = () => void this.#options.sandbox.cancel(this.#options.fence, execId).catch(() => undefined);
		const onOutput = options?.onOutput;
		const sink = onOutput
			? this.#options.sink((chunk) => {
					if (settled || callbackError !== undefined) return;
					try {
						onOutput(chunk.text, context, { stream: chunk.stream, ...(chunk.skipped ? { skipped: chunk.skipped } : {}) });
					} catch (error) {
						const cause = error instanceof Error ? error : new Error(String(error));
						callbackError = new ExecutionError("callback_error", cause.message, cause);
						cancel();
					}
				})
			: null;
		signal?.addEventListener("abort", cancel, { once: true });
		let result: ExecResult | Refused;
		try {
			result = await this.#options.sandbox.exec(this.#options.fence, request, sink);
		} catch (error) {
			this.#gone(`A command failed: ${error instanceof Error ? error.message : String(error)}`);
			return err(new ExecutionError("unknown", "The sandbox stopped."));
		} finally {
			settled = true;
			signal?.removeEventListener("abort", cancel);
		}
		if (isRefused(result)) {
			this.#gone(result.message);
			return err(new ExecutionError("unknown", result.message));
		}
		if (callbackError) return err(callbackError);
		if (result.ok) return ok({ exitCode: result.exitCode, ...(result.spillPath === undefined ? {} : { spillPath: result.spillPath }) });
		const failure =
			result.code === "timeout"
				? new ExecutionError("timeout", `timeout:${timeout}`)
				: result.code === "aborted"
					? new ExecutionError("aborted", "aborted")
					: new ExecutionError(result.code, result.message);
		if (result.spillPath !== undefined) failure.spillPath = result.spillPath;
		return err(failure);
	}
}
