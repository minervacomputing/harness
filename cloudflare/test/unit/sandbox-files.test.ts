// The Sandbox's file operations (src/sandbox/files.ts) without a container: Linux errors as pi's codes,
// shim answers past the bounds of the pnpm patch of @cloudflare/sandbox (a data frame's length, a stat's, a
// listing's entries), a wrapped command that never ends, and the watch's `find` and how its output is
// read. The operations against the real image are in sandbox-local.test.ts.

import { Files } from "@cloudflare/sandbox";
import { describe, expect, test } from "vitest";
import { errnoFailure, fileOperation, snapshotCommand, snapshotEntries } from "../../src/sandbox/files.ts";
import type { Machine } from "../../src/sandbox/process.ts";
import { ACK } from "../../src/sandbox/wrapper.ts";

describe("Linux errors", () => {
	test("each maps to pi's code through one table, with a message naming the path", () => {
		const cases: [string, string, string][] = [
			["ENOENT", "not_found", "No such file or directory: /workspace/a"],
			["EACCES", "permission_denied", "Permission denied: /workspace/a"],
			["EPERM", "permission_denied", "Operation not permitted: /workspace/a"],
			["ENOTDIR", "not_directory", "Not a directory: /workspace/a"],
			["EISDIR", "is_directory", "Is a directory: /workspace/a"],
			["EINVAL", "invalid", "Invalid argument: /workspace/a"],
			["ENXIO", "invalid", "No such device or address: /workspace/a"],
			["ENOSPC", "unknown", "No space left on device: /workspace/a"],
			["EROFS", "unknown", "Read-only file system: /workspace/a"],
			["ENOTEMPTY", "unknown", "Directory not empty: /workspace/a"],
			["EWHATEVER", "unknown", "Failed with EWHATEVER: /workspace/a"],
			["UNKNOWN", "unknown", "Failed with an unknown error: /workspace/a"],
			["constructor", "unknown", "Failed with an unknown error: /workspace/a"],
		];
		for (const [errno, code, message] of cases) expect(errnoFailure(errno, "/workspace/a")).toEqual({ ok: false, code, message });
	});
});

/** A shim process whose stdout holds `bytes` and then stays open, as a hostile one could keep it, or `ends`. */
function shim(bytes: Uint8Array, ends = false): ExecProcess {
	let read = false;
	return {
		stdin: null,
		stdout: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (read) return ends ? controller.close() : new Promise(() => {});
				read = true;
				controller.enqueue(bytes);
			},
		}),
		stderr: null,
		pid: 7,
		isPty: false,
		exitCode: ends ? Promise.resolve(0) : new Promise(() => {}),
		async output() {
			throw new Error("not read whole");
		},
		kill() {},
		resize() {},
	};
}

/** A data frame's header declaring `length` bytes. */
function dataFrame(length: number): Uint8Array {
	const header = new Uint8Array(10);
	header.set([0x53, 0x42, 0x58, 0x46, 1, 2]);
	new DataView(header.buffer).setUint32(6, length, true);
	return header;
}

/** A machine whose every process is `process(options)`. */
function machineOf(process: (options: ContainerExecOptions) => ExecProcess): Machine {
	return {
		container: { running: true, image: "", start() {}, exec: async (_argv, options) => process(options ?? {}), destroy: async () => {}, setInactivityTimeout: async () => {}, snapshot: async () => ({ id: "", size: 0 }) },
		cgroup: "/sys/fs/cgroup/agent",
	};
}

describe("a shim's answer", () => {
	test("a data frame declared past 16 MiB is refused before it is read, and fails the operation as unknown", async () => {
		const files = new Files({ exec: async () => shim(dataFrame(0xffff_ffff)) });
		await expect(files.lstat("/workspace/a")).rejects.toThrow(/exceeded its size limit/);
		const machine = machineOf(() => shim(dataFrame(16 * 1024 * 1024 + 1)));
		expect(await fileOperation(machine, { op: "lstat", path: "/workspace/a" }, 5)).toEqual({ ok: false, code: "unknown", message: "The file operation failed in the sandbox." });
	});

	test("a stat's data frame declared past its 45 bytes is refused before it is read", async () => {
		await expect(new Files({ exec: async () => shim(dataFrame(46)) }).lstat("/workspace/a")).rejects.toThrow(/exceeded its size limit/);
		await expect(new Files({ exec: async () => shim(dataFrame(16 * 1024 * 1024)) }).stat("/workspace/a")).rejects.toThrow(/exceeded its size limit/);
	});

	test("a listing of more than 100,000 entries is refused before any is decoded", async () => {
		const listing = (count: number) => {
			const payload = new Uint8Array(4);
			new DataView(payload.buffer).setUint32(0, count, true);
			const frame = new Uint8Array(14);
			frame.set(dataFrame(4));
			frame.set(payload, 10);
			return frame;
		};
		await expect(new Files({ exec: async () => shim(listing(100_001), true) }).readDirectory("/workspace")).rejects.toThrow(/too many directory entries/);
		// Within the bound, the same frame is only short of its entries.
		await expect(new Files({ exec: async () => shim(listing(100_000), true) }).readDirectory("/workspace")).rejects.toThrow(/truncated directory data/);
	});
});

describe("a wrapped file command", () => {
	test("that was admitted and then never ends fails at the operation's limit, and is killed", async () => {
		let signal: AbortSignal | undefined;
		const machine = machineOf((options) => {
			signal = options.signal;
			return shim(Uint8Array.of(ACK));
		});
		const started = Date.now();
		expect(await fileOperation(machine, { op: "canonical", path: "/workspace/a" }, 0.2)).toEqual({ ok: false, code: "unknown", message: "The file operation timed out: /workspace/a" });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(signal?.aborted).toBe(true);
	});
});

describe("the watch's snapshot", () => {
	test("a target's find follows the target alone, stops at its entries unless recursive, and prunes excluded names below it", () => {
		const printf = ["-printf", "%y\\t%s\\t%T@\\t%C@\\t%i\\t%l\\0%p\\0"];
		expect(snapshotCommand({ path: "/workspace/AGENTS.md" })).toEqual(["find", "-H", "/workspace/AGENTS.md", "-maxdepth", "1", ...printf]);
		expect(snapshotCommand({ path: "/workspace/a*b", recursive: true, exclude: { hidden: true, names: ["node_modules", "x?"] } })).toEqual([
			"find",
			"-H",
			"/workspace/a*b",
			"(",
			"-path",
			"/workspace/a\\*b/*",
			"(",
			"-name",
			".*",
			"-o",
			"-name",
			"node_modules",
			"-o",
			"-name",
			"x\\?",
			")",
			"-prune",
			")",
			"-o",
			...printf,
		]);
	});

	test("its output becomes a signature per path: a directory by its inode, anything else by everything find printed", () => {
		const output = new TextEncoder().encode("d\t4096\t1.5\t1.5\t11\t\0/workspace/s\0f\t3\t2.25\t2.5\t12\t\0/workspace/s/a\tb\0l\t9\t3.0\t3.0\t13\tgone\ttarget\0/workspace/s/l\0");
		expect(snapshotEntries(output, 3)).toEqual(
			new Map([
				["/workspace/s", "d:11"],
				["/workspace/s/a\tb", "f:3:2.25:2.5:12:"],
				["/workspace/s/l", "l:9:3.0:3.0:13:gone\ttarget"],
			]),
		);
		expect(snapshotEntries(output, 2)).toBe("overflow");
		expect(snapshotEntries(new Uint8Array(0), 1)).toEqual(new Map());
		expect(snapshotEntries(new TextEncoder().encode("f\t1\t1\t1\t1\t\0/workspace/a"), 1)).toBeNull();
		expect(snapshotEntries(new TextEncoder().encode("f\t1\0/workspace/a\0"), 1)).toBeNull();
		expect(snapshotEntries(new TextEncoder().encode("f\t1\t1\t1\t1\t\0relative\0"), 1)).toBeNull();
	});
});
