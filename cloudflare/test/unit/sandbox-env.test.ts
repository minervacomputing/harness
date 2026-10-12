// The ExecutionEnv adapter (src/sandbox/env.ts) over a fake Sandbox: what it checks itself as pi does,
// what it sends, how answers map to pi's Results, and that a refused or failed call loses the sandbox once.

import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { describe, expect, test } from "vitest";
import type { ExecOutputSink, ExecRequest, ExecResult, FsRequest, FsResponse, Refused, SandboxFence } from "../../src/contracts/sandbox.ts";
import { commandEnvironment, MAX_READ_BYTES } from "../../src/sandbox/constants.ts";
import { type SandboxClient, SandboxExecutionEnv } from "../../src/sandbox/env.ts";
import type { Delivered } from "../../src/sandbox/output.ts";

type Context = Parameters<SandboxExecutionEnv["readTextFile"]>[1];
const NONE = {} as Context;
const FENCE: SandboxFence = { runId: "r", attempt: 1, incarnation: "i1" };

function abortedContext(): Context {
	const controller = new AbortController();
	controller.abort();
	return { abortSignal: controller.signal } as Context;
}

class FakeSandbox implements SandboxClient {
	readonly calls: (FsRequest | ExecRequest | { op: "cancel"; execId: string } | { op: "killStrays" })[] = [];
	fsAnswer: (request: FsRequest) => FsResponse | Refused = () => ({ ok: true, value: null });
	execAnswer: (request: ExecRequest, sink: ExecOutputSink | null) => Promise<ExecResult | Refused> = async () => ({ ok: true, exitCode: 0 });
	throws = false;

	async fs(_fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused> {
		this.calls.push(request);
		if (this.throws) throw new Error("Durable Object reset");
		return this.fsAnswer(request);
	}

	async exec(_fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused> {
		this.calls.push(request);
		if (this.throws) throw new Error("Durable Object reset");
		return this.execAnswer(request, sink);
	}

	async cancel(_fence: SandboxFence, execId: string): Promise<void> {
		this.calls.push({ op: "cancel", execId });
	}

	async killStrays(): Promise<{ ok: true }> {
		this.calls.push({ op: "killStrays" });
		return { ok: true };
	}
}

function env(sandbox: FakeSandbox, options: { deadline?: number | null; now?: () => number } = {}) {
	const lost: string[] = [];
	const made = new SandboxExecutionEnv({ sandbox, fence: FENCE, sink: (output) => ({ output }), lost: (reason) => lost.push(reason), ...options });
	return { env: made, lost };
}

describe("file operations", () => {
	test("paths resolve against /workspace as pi resolves them, and the id is the incarnation's", async () => {
		const sandbox = new FakeSandbox();
		sandbox.fsAnswer = () => ({ ok: true, value: "text" });
		const { env: made } = env(sandbox);
		expect(made.id).toBe("sandbox:i1");
		expect(made.cwd).toBe("/workspace");
		expect(await made.absolutePath("~/notes", NONE)).toEqual({ ok: true, value: "/tmp/home/notes" });
		expect(await made.joinPath(["/workspace/a", ".."], NONE)).toEqual({ ok: true, value: "/workspace" });
		await made.readTextFile("a/../b.txt", NONE);
		expect(sandbox.calls).toEqual([{ op: "readText", path: "/workspace/b.txt", maxBytes: 8 * 1024 * 1024 }]);
	});

	test("an aborted context is refused before anything is sent", async () => {
		const sandbox = new FakeSandbox();
		const { env: made } = env(sandbox);
		const results = await Promise.all([
			made.readTextFile("a", abortedContext()),
			made.writeFile("a", "x", abortedContext()),
			made.fileInfo("a", abortedContext()),
			made.exists("a", abortedContext()),
			made.openBinaryReader("a", undefined, abortedContext()),
			made.openDirReader(".", abortedContext()),
			made.createDir("d", undefined, abortedContext()),
			made.remove("d", undefined, abortedContext()),
			made.createTempFile(undefined, abortedContext()),
			made.renameFile("a", "b", abortedContext()),
			made.truncateFile("a", 0, abortedContext()),
			made.flushFile("a", abortedContext()),
			made.canonicalPath("a", abortedContext()),
			made.watch([{ path: "a" }], () => {}, abortedContext()),
		]);
		for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(sandbox.calls).toEqual([]);
	});

	test("pi's own argument checks, before anything is sent", async () => {
		const sandbox = new FakeSandbox();
		sandbox.fsAnswer = (request) => (request.op === "open" ? { ok: true, value: { id: "r1", path: "/workspace/a", dev: 1, ino: 2, size: 3, mtimeMs: 4 } } : { ok: true, value: null });
		const { env: made } = env(sandbox);
		expect(await made.truncateFile("a", -1, NONE)).toMatchObject({ ok: false, error: { code: "invalid", message: "File size must be a non-negative safe integer" } });
		const reader = (await made.openBinaryReader("a", undefined, NONE)) as { ok: true; value: import("@earendil-works/pi-durable/env").BinaryReader };
		expect(await reader.value.read(-1, 1, NONE)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await reader.value.read(0, 1.5, NONE)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await reader.value.read(3, 0, NONE)).toEqual({ ok: true, value: new Uint8Array(0) });
		expect(await reader.value.scanLines({ startLine: 2, endLine: 2 }, NONE)).toMatchObject({ ok: false, error: { code: "invalid", message: "Invalid line range" } });
		expect(await reader.value.scanLines({ startLine: -1 }, NONE)).toMatchObject({ ok: false, error: { code: "invalid" } });
		await reader.value.close(NONE);
		await reader.value.close(NONE);
		expect(await reader.value.read(0, 1, NONE)).toMatchObject({ ok: false, error: { code: "invalid", message: "Binary reader is closed" } });
		expect(await reader.value.info(NONE)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(sandbox.calls.map((call) => ("op" in call ? call.op : "exec"))).toEqual(["open", "close"]);
	});

	test("a positional read longer than one answer is read in pieces until it is complete or the file ends", async () => {
		const sandbox = new FakeSandbox();
		const size = MAX_READ_BYTES * 2 + 10;
		sandbox.fsAnswer = (request) => {
			if (request.op === "open") return { ok: true, value: { id: "r1", path: "/workspace/big", dev: 1, ino: 2, size, mtimeMs: 4 } };
			if (request.op === "read") return { ok: true, value: new Uint8Array(Math.max(0, Math.min(request.length, size - request.offset))).fill(7) };
			return { ok: true, value: null };
		};
		const { env: made } = env(sandbox);
		const bytes = await made.readBinaryFile("big", NONE);
		expect(bytes.ok && bytes.value.length).toBe(size);
		const reads = sandbox.calls.filter((call): call is FsRequest & { op: "read" } => "op" in call && call.op === "read");
		expect(reads.map((call) => [call.offset, call.length])).toEqual([
			[0, MAX_READ_BYTES],
			[MAX_READ_BYTES, MAX_READ_BYTES],
			[MAX_READ_BYTES * 2, MAX_READ_BYTES],
			// A short answer is read on from where it stopped; an empty one is the end.
			[size, MAX_READ_BYTES - 10],
			[size, MAX_READ_BYTES],
		]);
	});

	test("a directory reader pages with a cursor and refuses use after close", async () => {
		const sandbox = new FakeSandbox();
		const pages = [
			{ entries: [{ name: "a", path: "/workspace/a", kind: "file" as const, size: 1, mtimeMs: 1 }], next: "61" },
			{ entries: [{ name: "b", path: "/workspace/b", kind: "file" as const, size: 1, mtimeMs: 1 }], next: null },
		];
		sandbox.fsAnswer = (request) => (request.op === "list" ? { ok: true, value: pages.shift() as (typeof pages)[number] } : { ok: true, value: null });
		const { env: made } = env(sandbox);
		const listed = await made.listDir(".", NONE);
		expect(listed.ok && listed.value.map((entry) => entry.name)).toEqual(["a", "b"]);
		const lists = sandbox.calls.filter((call): call is FsRequest & { op: "list" } => "op" in call && call.op === "list");
		expect(lists.map((call) => call.after)).toEqual([null, "61"]);
		const reader = await made.openDirReader(".", NONE);
		if (!reader.ok) throw reader.error;
		expect(await reader.value.next(0, NONE)).toMatchObject({ ok: false, error: { code: "invalid" } });
		await reader.value.close(NONE);
		expect(await reader.value.next(1, NONE)).toMatchObject({ ok: false, error: { code: "invalid", message: "Directory reader is closed" } });
	});

	test("a whole listing is bounded, its last page included", async () => {
		const sandbox = new FakeSandbox();
		const entry = { name: "n".repeat(200), path: `/${"p".repeat(3899)}`, kind: "file" as const, size: 0, mtimeMs: 0 };
		let page = 0;
		sandbox.fsAnswer = (request) => (request.op === "list" ? { ok: true, value: { entries: Array(1000).fill(entry), next: ++page === 5 ? null : `c${page}` } } : { ok: true, value: null });
		const listed = await env(sandbox).env.listDir("/", NONE);
		expect(listed).toMatchObject({ ok: false, error: { code: "unknown" } });
	});

	test("text lines drop a leading byte order mark and know their last line's ending", async () => {
		const sandbox = new FakeSandbox();
		sandbox.fsAnswer = () => ({ ok: true, value: "﻿one\ntwo\nthree" });
		const { env: made } = env(sandbox);
		expect(await made.readTextLines("a", undefined, NONE)).toEqual({ ok: true, value: ["one", "two", "three"] });
		expect(await made.readTextLines("a", { maxLines: 2 }, NONE)).toEqual({ ok: true, value: ["one", "two"] });
		expect(await made.readTextLines("a", { maxLines: 0 }, NONE)).toEqual({ ok: true, value: [] });
		const reader = await made.openTextLineReader("a", NONE);
		if (!reader.ok) throw reader.error;
		const lines = [];
		for (;;) {
			const line = await reader.value.readLine(NONE);
			if (!line.ok || line.value === undefined) break;
			lines.push(line.value);
		}
		expect(lines).toEqual([
			{ text: "one", terminated: true },
			{ text: "two", terminated: true },
			{ text: "three", terminated: false },
		]);
		// readTextFile keeps the mark, as Node's readFile does.
		expect(await made.readTextFile("a", NONE)).toEqual({ ok: true, value: "﻿one\ntwo\nthree" });
	});

	test("expected failures keep pi's code; a refusal or a failed call loses the sandbox once", async () => {
		const sandbox = new FakeSandbox();
		sandbox.fsAnswer = () => ({ ok: false, code: "not_found", message: "ENOENT: no such file or directory, lstat '/workspace/a'" });
		const { env: made, lost } = env(sandbox);
		const missing = await made.fileInfo("a", NONE);
		expect(missing).toMatchObject({ ok: false, error: { code: "not_found", path: "/workspace/a" } });
		expect((missing as { error: unknown }).error).toBeInstanceOf(FileError);
		expect(lost).toEqual([]);
		sandbox.fsAnswer = () => ({ refused: "stale", message: "This sandbox belongs to another incarnation, run or attempt." });
		expect(await made.fileInfo("a", NONE)).toMatchObject({ ok: false, error: { code: "unknown" } });
		sandbox.throws = true;
		expect(await made.exists("a", NONE)).toMatchObject({ ok: false, error: { code: "unknown", message: "The sandbox stopped." } });
		expect(lost).toEqual(["This sandbox belongs to another incarnation, run or attempt."]);
	});
});

describe("commands", () => {
	test("pi's checks of timeouts and argv come first", async () => {
		const sandbox = new FakeSandbox();
		const { env: made } = env(sandbox);
		expect(await made.exec("true", { timeout: 0 }, NONE)).toMatchObject({ ok: false, error: { code: "timeout", message: "Invalid timeout: must be a finite number of seconds" } });
		expect(await made.exec("true", { timeout: 3e6 }, NONE)).toMatchObject({ ok: false, error: { code: "timeout", message: "Invalid timeout: maximum is 2147483.647 seconds" } });
		expect(await made.exec([], undefined, NONE)).toMatchObject({ ok: false, error: { code: "spawn_error", message: "Empty argv: no program to run" } });
		expect(await made.exec("true", undefined, abortedContext())).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(sandbox.calls).toEqual([]);
	});

	test("the environment is exactly the one asked for, and inherited means the image's", async () => {
		const sandbox = new FakeSandbox();
		const { env: made } = env(sandbox);
		await made.exec("true", { inheritEnv: false, env: { ONLY: "this" } }, NONE);
		await made.exec(["printf", "x"], { env: { EXTRA: "1" }, cwd: "sub", timeout: 5 }, NONE);
		const [first, second] = sandbox.calls as ExecRequest[];
		expect(first).toMatchObject({ command: "true", cwd: "/workspace", env: { ONLY: "this" }, timeoutSeconds: 0 });
		expect(second).toMatchObject({ command: ["printf", "x"], cwd: "/workspace/sub", env: { ...commandEnvironment(), EXTRA: "1" }, timeoutSeconds: 5 });
	});

	test("a deadline caps a command, and a passed one stops it before it starts", async () => {
		const sandbox = new FakeSandbox();
		let now = 1_000_000;
		const { env: made } = env(sandbox, { deadline: 1_010_000, now: () => now });
		await made.exec("true", undefined, NONE);
		await made.exec("true", { timeout: 600 }, NONE);
		await made.exec("true", { timeout: 2 }, NONE);
		expect((sandbox.calls as ExecRequest[]).map((call) => call.timeoutSeconds)).toEqual([10, 10, 2]);
		now = 1_010_000;
		expect(await made.exec("true", { timeout: 600 }, NONE)).toMatchObject({ ok: false, error: { code: "timeout", message: "timeout:600" } });
		expect(sandbox.calls).toHaveLength(3);
	});

	test("output reaches onOutput until the command settles; a throwing callback cancels it", async () => {
		const sandbox = new FakeSandbox();
		let late: ((chunk: Delivered) => void) | null = null;
		sandbox.execAnswer = async (_request, sink) => {
			sink?.output({ stream: "stdout", text: "a" });
			sink?.output({ stream: "stderr", text: "b", skipped: { bytes: 3, newlines: 1, endsWithNewline: true } });
			late = (chunk) => sink?.output(chunk);
			return { ok: true, exitCode: 3, spillPath: "/tmp/tmp-abcdef/pi-output-x.log" };
		};
		const { env: made } = env(sandbox);
		const seen: [string, string, unknown][] = [];
		const result = await made.exec("x", { onOutput: (text, _context, info) => seen.push([info.stream, text, info.skipped]) }, NONE);
		expect(result).toEqual({ ok: true, value: { exitCode: 3, spillPath: "/tmp/tmp-abcdef/pi-output-x.log" } });
		(late as unknown as (chunk: Delivered) => void)({ stream: "stdout", text: "after" });
		expect(seen).toEqual([
			["stdout", "a", undefined],
			["stderr", "b", { bytes: 3, newlines: 1, endsWithNewline: true }],
		]);
		sandbox.execAnswer = async (_request, sink) => {
			sink?.output({ stream: "stdout", text: "boom" });
			return { ok: false, code: "aborted", message: "aborted" };
		};
		const failed = await made.exec("x", { onOutput: () => { throw new Error("listener failed"); } }, NONE);
		expect(failed).toMatchObject({ ok: false, error: { code: "callback_error", message: "listener failed" } });
		expect(sandbox.calls.at(-1)).toMatchObject({ op: "cancel" });
	});

	test("timeouts and aborts are pi's errors, with the spill file", async () => {
		const sandbox = new FakeSandbox();
		sandbox.execAnswer = async () => ({ ok: false, code: "timeout", message: "timeout:1", spillPath: "/tmp/x.log" });
		const { env: made, lost } = env(sandbox);
		const timedOut = await made.exec("sleep 9", { timeout: 1 }, NONE);
		expect(timedOut).toMatchObject({ ok: false, error: { code: "timeout", message: "timeout:1", spillPath: "/tmp/x.log" } });
		expect((timedOut as { error: unknown }).error).toBeInstanceOf(ExecutionError);
		const controller = new AbortController();
		sandbox.execAnswer = async (request) => {
			controller.abort();
			await Promise.resolve();
			expect(sandbox.calls.at(-1)).toEqual({ op: "cancel", execId: request.execId });
			return { ok: false, code: "aborted", message: "aborted" };
		};
		expect(await made.exec("sleep 9", undefined, { abortSignal: controller.signal } as Context)).toMatchObject({ ok: false, error: { code: "aborted" } });
		sandbox.execAnswer = async () => ({ refused: "not_verified", message: "The sandbox stopped." });
		expect(await made.exec("true", undefined, NONE)).toMatchObject({ ok: false, error: { code: "unknown" } });
		expect(lost).toEqual(["The sandbox stopped."]);
	});

	test("cleanup kills strays", async () => {
		const sandbox = new FakeSandbox();
		await env(sandbox).env.cleanup(NONE);
		expect(sandbox.calls).toEqual([{ op: "killStrays" }]);
	});
});

describe("watch", () => {
	test("it polls snapshots and reports what changed until it is closed", async () => {
		const sandbox = new FakeSandbox();
		const snapshots: Record<string, string>[] = [{ "/workspace/a": "f:1" }, { "/workspace/a": "f:2", "/workspace/b": "f:1" }, {}];
		sandbox.fsAnswer = () => ({ ok: true, value: { entries: snapshots.length > 1 ? (snapshots.shift() as Record<string, string>) : (snapshots[0] as Record<string, string>) } });
		const made = new SandboxExecutionEnv({ sandbox, fence: FENCE, sink: (output) => ({ output }), pollMs: 5 });
		const changes: unknown[] = [];
		const watcher = await made.watch([{ path: "a" }], (change) => changes.push(change), NONE);
		if (!watcher.ok) throw watcher.error;
		expect(watcher.value.mode).toBe("polling");
		await new Promise((resolve) => setTimeout(resolve, 60));
		await watcher.value.close(NONE);
		const count = changes.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(changes.length).toBe(count);
		expect(changes.slice(0, 2)).toEqual([{ paths: ["/workspace/a", "/workspace/b"] }, { paths: ["/workspace/a", "/workspace/b"] }]);
		expect(sandbox.calls[0]).toEqual({ op: "snapshot", targets: [{ path: "/workspace/a" }], maxEntries: 10_000 });
	});

	test("too many watched entries stop the watcher with an error", async () => {
		const sandbox = new FakeSandbox();
		let first = true;
		sandbox.fsAnswer = () => {
			if (first) {
				first = false;
				return { ok: true, value: { entries: {} } };
			}
			return { ok: true, value: { overflow: true } };
		};
		const made = new SandboxExecutionEnv({ sandbox, fence: FENCE, sink: (output) => ({ output }), pollMs: 5 });
		const changes: unknown[] = [];
		const watcher = await made.watch([{ path: "a", recursive: true }], (change) => changes.push(change), NONE);
		if (!watcher.ok) throw watcher.error;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ error: { code: "unknown" } });
		await watcher.value.close(NONE);
	});
});
