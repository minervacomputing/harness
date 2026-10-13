// The Sandbox's logic against the real image in a local Docker container (sandbox-docker.ts): the
// lifecycle and its fences, the hardening and its verification, commands and file operations through the
// wrapper as the agent's user, pi's ExecutionEnv conformance suite (24 cases) over the adapter, hydration,
// scans and checkpoints, killing strays, the fork and folder limits, and the Sandbox fault rows of the plan
// (each hardening step failing, cgroup admission failing, a lost destroy, a restart with a container still
// running). Skipped without Docker or the image: `pnpm sandbox:image` builds it.

import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { migrate, type Sql, sqliteSql } from "../../src/lib/sql.ts";
import type { ExecRequest } from "../../src/sandbox/commands.ts";
import { commandEnvironment, sandboxSpec, type SandboxSpec, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import { SandboxExecutionEnv } from "../../src/sandbox/env.ts";
import type { HydratePlan, ScanResult } from "../../src/sandbox/folder.ts";
import type { Delivered } from "../../src/sandbox/output.ts";
import type { ContainerPort, SandboxPorts } from "../../src/sandbox/ports.ts";
import { prepareSandbox } from "../../src/sandbox/session.ts";
import { SANDBOX_MIGRATIONS } from "../../src/sandbox/store.ts";
import { DockerContainer, dockerReady, MemoryBucket, sha256Hex } from "./sandbox-docker.ts";
import { openDatabase } from "../unit/sqlite.ts";

const READY = dockerReady();
/** A context without cancellation: the adapter only reads its abort signal. */
const NONE = {} as Parameters<SandboxExecutionEnv["readTextFile"]>[1];
const KiB = 1024;
const MiB = 1024 * KiB;

const WS = { id: "0190a000-0000-7000-8000-000000000001", jurisdiction: null } as const;
const CONVERSATION = "0190a000-0000-7000-8000-000000000002";

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
	return { ...sandboxSpec(WS, CONVERSATION, { folderBytes: 8 * MiB, folderEntries: 100 }, null), ...overrides };
}

interface Rig {
	core: SandboxCore;
	sql: Sql;
	container: DockerContainer;
	bucket: MemoryBucket;
	logs: string[];
	ports(container?: ContainerPort): SandboxPorts;
}

function rig(): Rig {
	const sql = sqliteSql(openDatabase());
	migrate(sql, SANDBOX_MIGRATIONS, Date.now());
	const container = new DockerContainer();
	const bucket = new MemoryBucket();
	const logs: string[] = [];
	const ports = (port: ContainerPort = container): SandboxPorts => ({
		container: port,
		sql,
		bucket: () => bucket,
		now: () => Date.now(),
		id: () => uuid7(),
		alarm: async () => {},
		background: () => {},
		log: (message) => logs.push(message),
		cgroup: container.cgroup,
	});
	return { core: new SandboxCore(ports()), sql, container, bucket, logs, ports };
}

const plainSink = (output: (chunk: Delivered) => void) => ({ output });

const rigs: Rig[] = [];
function track(made: Rig): Rig {
	rigs.push(made);
	return made;
}

afterAll(() => {
	for (const made of rigs) made.container.remove();
});

async function ready(made: Rig, overrides: Partial<SandboxSpec> = {}): Promise<SandboxFence> {
	const prepared = await prepareSandbox(made.core, { runId: uuid7(), attempt: 1 }, spec(overrides));
	if (!prepared.ok) throw new Error(`${prepared.stage}: ${prepared.message}`);
	return prepared.fence;
}

describe.skipIf(!READY)("a sandbox in a local container", () => {
	let made: Rig;
	let fence: SandboxFence;

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
	}, 120_000);

	test("hardening and verification hold every postcondition", async () => {
		const status = made.core.status();
		expect(status.state).toBe("verified");
		const mounts = made.container.shell("cat /proc/self/mountinfo").stdout;
		expect(mounts).toMatch(/ \/workspace rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=8192k,nr_inodes=101,mode=755,uid=1000,gid=1000\n/);
		expect(mounts).toMatch(/ \/tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=262144k\n/);
		expect(mounts).toMatch(/ \/ ro,relatime - /);
		expect(made.container.shell(`cat ${made.container.cgroup}/pids.max ${made.container.cgroup}/memory.max`).stdout.split("\n")).toEqual([
			"256",
			String(1024 * MiB + 8 * MiB + 256 * MiB),
			"",
		]);
	});

	test("a command runs as the agent in its cgroup with exactly the environment it is given", async () => {
		const chunks: Delivered[] = [];
		// The shell's own environment is the command's: /proc/$$/environ, not a child's, which bash extends.
		const script = "id -u; id -g; id -G; pwd; cat /proc/self/cgroup; tr '\\0' '\\n' < /proc/$$/environ | sort; grep -E '^(CapEff|CapBnd|NoNewPrivs)' /proc/self/status";
		const result = await made.core.exec(
			fence,
			{ execId: "env-1", command: script, cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 30 },
			plainSink((chunk) => chunks.push(chunk)),
		);
		expect(result).toEqual({ ok: true, exitCode: 0 });
		const text = chunks.map((chunk) => chunk.text).join("");
		const environment = Object.entries(commandEnvironment())
			.map(([name, value]) => `${name}=${value}`)
			.sort();
		expect(text.split("\n")).toEqual([
			"1000",
			"1000",
			"1000",
			WORKSPACE,
			`0::${made.container.cgroup.replace("/sys/fs/cgroup", "")}`,
			...environment,
			"CapEff:\t0000000000000000",
			"CapBnd:\t0000000000000000",
			"NoNewPrivs:\t1",
			"",
		]);
	});

	test("pi's ExecutionEnv conformance suite passes against the container", { timeout: 600_000 }, async () => {
		let n = 0;
		const failures: string[] = [];
		const cases = createEnvConformance({
			assertions: {
				ok: (value, message) => assert.ok(value, message),
				strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
				deepEqual: (actual, expected) => assert.deepEqual(actual, expected),
				partialDeepEqual: (actual, expected) => expect(actual).toMatchObject(expected as object),
				greaterThan: (actual, expected) => assert.isAbove(actual, expected),
				rejects: async (operation, includes) => {
					await expect(operation).rejects.toThrow(includes);
				},
			},
			withEnv: async (use) => {
				const root = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
				const cwd = `${WORKSPACE}/case-${++n}`;
				getOrThrow(await root.createDir(cwd, undefined, NONE));
				await use(new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink, cwd, pollMs: 100 }));
			},
		});
		expect(cases).toHaveLength(24);
		for (const entry of cases) {
			try {
				await entry.run();
			} catch (error) {
				failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		expect(failures).toEqual([]);
	});
});

/** Runs a command and collects its output, as the bash tool would see it. */
async function run(core: SandboxCore, fence: SandboxFence, command: string | string[], options: Partial<ExecRequest> = {}) {
	const chunks: Delivered[] = [];
	const result = await core.exec(
		fence,
		{ execId: `c${Math.random()}`, command, cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 60, ...options },
		plainSink((chunk) => chunks.push(chunk)),
	);
	const stdout = chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("");
	const stderr = chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("");
	return { result, stdout, stderr, chunks };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!READY)("commands", () => {
	let made: Rig;
	let fence: SandboxFence;

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
	}, 120_000);

	test("a timeout stops the command's process group and says so", { timeout: 30_000 }, async () => {
		const started = Date.now();
		const { result } = await run(made.core, fence, "sleep 30 & sleep 31; echo never", { timeoutSeconds: 1 });
		expect(result).toEqual({ ok: false, code: "timeout", message: "timeout:1" });
		expect(Date.now() - started).toBeLessThan(10_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(made.container.shell("pgrep -u 1000 -x sleep || true").stdout.trim()).toBe("");
	});

	test("a command that exits on its own with 124 is not a timeout", async () => {
		expect((await run(made.core, fence, "exit 124", { timeoutSeconds: 30 })).result).toEqual({ ok: true, exitCode: 124 });
	});

	test("a cancel kills the command and its group", { timeout: 30_000 }, async () => {
		const running = made.core.exec(
			fence,
			{ execId: "cancel-1", command: "sleep 600 & sleep 601 & wait", cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 0 },
			null,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await made.core.cancel(fence, "cancel-1");
		expect(await running).toEqual({ ok: false, code: "aborted", message: "aborted" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(made.container.shell("pgrep -u 1000 -x sleep || true").stdout.trim()).toBe("");
	});

	test("a background process holding the output does not hold the call", { timeout: 30_000 }, async () => {
		const started = Date.now();
		const { result, stdout } = await run(made.core, fence, "sleep 20 & echo done");
		expect(result).toEqual({ ok: true, exitCode: 0 });
		expect(stdout).toBe("done\n");
		expect(Date.now() - started).toBeLessThan(5000);
		await made.core.killStrays(fence);
	});

	test("a detached process that keeps writing to the output holds the call no more than ten seconds", { timeout: 30_000 }, async () => {
		const started = Date.now();
		const { result } = await run(made.core, fence, "setsid bash -c 'while true; do echo x; sleep 0.01; done' & echo started");
		expect(result).toEqual({ ok: true, exitCode: 0 });
		// Docker ends an exec's streams a while after its process; the platform keeps them (the account test).
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(await made.core.killStrays(fence)).toEqual({ ok: true });
	});

	test("a caller slower than the command loses no output, even long after the exit", { timeout: 60_000 }, async () => {
		let first = true;
		let received = 0;
		const result = await made.core.exec(
			fence,
			{ execId: "slow-caller", command: "head -c 6000000 /dev/zero | tr '\\0' a", cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 60 },
			{
				async output(chunk: Delivered) {
					if (first) {
						first = false;
						await new Promise((resolve) => setTimeout(resolve, 12_000));
					}
					received += chunk.text.length;
				},
			},
		);
		expect(result).toEqual({ ok: true, exitCode: 0 });
		expect(received).toBe(6_000_000);
	});

	test("a signal's exit code is 128 plus its number, and stdin is empty", async () => {
		expect((await run(made.core, fence, "kill -9 $$")).result).toEqual({ ok: true, exitCode: 137 });
		const read = await run(made.core, fence, "head -c 1; echo read-$?", { timeoutSeconds: 10 });
		expect(read.stdout).toBe("read-0\n");
	});

	test("missing directories, programs and NUL bytes are spawn errors", async () => {
		expect((await run(made.core, fence, "true", { cwd: "/workspace/missing" })).result).toEqual({
			ok: false,
			code: "spawn_error",
			message: "Working directory does not exist: /workspace/missing\nCannot execute bash commands.",
		});
		expect((await run(made.core, fence, ["no-such-program-here"])).result).toEqual({ ok: false, code: "spawn_error", message: "spawn no-such-program-here ENOENT" });
		expect((await run(made.core, fence, ["/bin/no-such"])).result).toMatchObject({ ok: false, code: "spawn_error" });
		expect((await run(made.core, fence, "echo a\u0000b")).result).toMatchObject({ ok: false, code: "spawn_error" });
		// PATH as execvp reads it: an empty component, a trailing one included, is the working directory.
		await run(made.core, fence, "mkdir -p bin && printf '#!/bin/sh\\necho here\\n' > bin/here && chmod 755 bin/here && printf x > bin/plain");
		const inBin = (env: { [name: string]: string }, program = "here") => run(made.core, fence, [program], { cwd: `${WORKSPACE}/bin`, env });
		expect((await inBin({ PATH: "" })).stdout).toBe("here\n");
		expect((await inBin({ PATH: "/missing:" })).stdout).toBe("here\n");
		expect((await inBin({ PATH: "/missing::/bin" })).stdout).toBe("here\n");
		expect((await inBin({ PATH: "/usr/bin" })).result).toEqual({ ok: false, code: "spawn_error", message: "spawn here ENOENT" });
		expect((await inBin({ PATH: "" }, "plain")).result).toEqual({ ok: false, code: "spawn_error", message: "spawn plain EACCES" });
		await run(made.core, fence, "rm -rf bin");
		// A command that is not found inside the shell is an ordinary exit.
		expect((await run(made.core, fence, "no-such-program-here")).result).toEqual({ ok: true, exitCode: 127 });
	});

	test("output past pi's thresholds is spilled, complete and in order, to a file the agent can read", { timeout: 60_000 }, async () => {
		const { result, stdout, stderr } = await run(made.core, fence, "for i in $(seq 1 3000); do echo out-$i; echo err-$i >&2; done", {
			spill: { afterBytes: 50 * 1024, afterLines: 2000 },
		});
		expect(result).toMatchObject({ ok: true, exitCode: 0 });
		const path = (result as { spillPath?: string }).spillPath as string;
		expect(path).toMatch(/^\/tmp\/tmp-[A-Za-z0-9]{6}\/pi-output-[0-9a-f-]{36}\.log$/);
		const spilled = made.container.shell(`cat ${path}`).stdout;
		expect(spilled.length).toBe(stdout.length + stderr.length);
		expect(spilled.split("\n").filter((line) => line.startsWith("out-"))).toEqual(stdout.trimEnd().split("\n"));
		expect(made.container.shell(`stat -c %u ${path}`).stdout.trim()).toBe("1000");
	});

	test("a window keeps the exact tail and counts what it skipped", { timeout: 60_000 }, async () => {
		const window = { maxBytes: 200, maxLines: 5, minIntervalMs: 50, bytesPerSecond: 1_000_000 };
		const { result, chunks } = await run(made.core, fence, "for i in $(seq 0 19999); do echo line-$i; done", { window });
		expect(result).toEqual({ ok: true, exitCode: 0 });
		let total = 0;
		let lines = 0;
		let tail = "";
		for (const chunk of chunks) {
			if (chunk.skipped) {
				total += chunk.skipped.bytes;
				lines += chunk.skipped.newlines;
				tail = "";
			}
			total += new TextEncoder().encode(chunk.text).length;
			lines += chunk.text.split("\n").length - 1;
			tail += chunk.text;
		}
		const expected = Array.from({ length: 20000 }, (_, index) => `line-${index}\n`);
		expect(total).toBe(expected.join("").length);
		expect(lines).toBe(20000);
		expect(tail.endsWith(expected.slice(-5).join(""))).toBe(true);
		expect(chunks.some((chunk) => chunk.skipped)).toBe(true);
	});

	test("file operations refuse a FIFO at once and never hang", { timeout: 30_000 }, async () => {
		made.container.shell("mkfifo /workspace/fifo && chown 1000:1000 /workspace/fifo");
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		const started = Date.now();
		const read = await env.readTextFile("fifo", NONE);
		const write = await env.writeFile("fifo", "x", NONE);
		const reader = await env.openBinaryReader("fifo", undefined, NONE);
		const exists = await env.exists("fifo", NONE);
		expect([read, write, reader, exists].map((result) => (result.ok ? "ok" : result.error.code))).toEqual(["invalid", "invalid", "invalid", "invalid"]);
		expect(Date.now() - started).toBeLessThan(5000);
		made.container.shell("rm /workspace/fifo");
	});

	test("file operations go on after their server is killed, as strays are", { timeout: 30_000 }, async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		getOrThrow(await env.writeFile("served.txt", "one", NONE));
		expect(made.container.shell("pgrep -u 1000 -f '^/usr/bin/python3 -I -S /opt/minerva/minerva-fs serve' | wc -l").stdout.trim()).toBe("1");
		made.container.shell("pkill -9 -u 1000 -f 'minerva-fs serve'; sleep 0.3");
		expect(await env.readTextFile("served.txt", NONE)).toEqual({ ok: true, value: "one" });
		made.container.shell("pkill -9 -u 1000 -f 'minerva-fs serve'; sleep 0.3");
		getOrThrow(await env.writeFile("served.txt", "two", NONE));
		expect(await env.readTextFile("served.txt", NONE)).toEqual({ ok: true, value: "two" });
		expect(await made.core.killStrays(fence)).toEqual({ ok: true });
		expect(await env.exists("served.txt", NONE)).toEqual({ ok: true, value: true });
		getOrThrow(await env.remove("served.txt", undefined, NONE));
	});

	test("writes past the folder's size fail with ENOSPC, and the root is read-only", { timeout: 30_000 }, async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		const big = await env.writeFile("big.bin", new Uint8Array(9 * MiB), NONE);
		expect(big.ok ? "ok" : big.error.message).toMatch(/^ENOSPC: no space left on device, write/);
		getOrThrow(await env.remove("big.bin", undefined, NONE));
		const root = await env.writeFile("/etc/probe", "x", NONE);
		expect(root.ok ? "ok" : `${root.error.code} ${root.error.message}`).toMatch(/^unknown EROFS: read-only file system, open/);
	});
});

describe.skipIf(!READY)("the folder", () => {
	let made: Rig;
	let fence: SandboxFence;
	const blob = (text: string) => ({ bytes: bytes(text), sha256: sha256Hex(bytes(text)) });
	const a = blob("alpha\n");
	const b = blob("#!/bin/sh\necho beta\n");

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
		made.bucket.objects.set("k/a", a.bytes);
		made.bucket.objects.set("k/b", b.bytes);
	}, 120_000);

	test("hydration writes each blob once, with modes, mtimes and empty directories, and a scan reads it back", { timeout: 60_000 }, async () => {
		const plan: HydratePlan = {
			versionId: null,
			files: [
				{ path: "docs/a.txt", sha256: a.sha256, size: a.bytes.length, mode: 0o644, mtime: 1_700_000_000_500, key: "k/a" },
				{ path: "copy of a.txt", sha256: a.sha256, size: a.bytes.length, mode: 0o755, mtime: 1_600_000_000_000, key: "k/a" },
				{ path: "bin/b.sh", sha256: b.sha256, size: b.bytes.length, mode: 0o755, mtime: 1_700_000_001_000, key: "k/b" },
			],
			dirs: ["empty", "deep/er"],
		};
		const gets = made.bucket.gets;
		expect(await made.core.hydrate(fence, plan)).toEqual({ ok: true });
		expect(made.bucket.gets - gets).toBe(2);
		const scanned = await made.core.scan(fence, { rehashAll: false });
		expect(scanned).toEqual({
			ok: true,
			manifest: {
				files: [
					{ path: "bin/b.sh", sha256: b.sha256, mode: 0o755, mtime: 1_700_000_001_000 },
					{ path: "copy of a.txt", sha256: a.sha256, mode: 0o755, mtime: 1_600_000_000_000 },
					{ path: "docs/a.txt", sha256: a.sha256, mode: 0o644, mtime: 1_700_000_000_500 },
				],
				dirs: ["deep/er", "empty"],
			},
			sizes: { "bin/b.sh": b.bytes.length, "copy of a.txt": a.bytes.length, "docs/a.txt": a.bytes.length },
			warnings: { total: 0, items: [] },
		});
		// Workers RPC clones plain objects only: a map by path must keep Object's prototype.
		expect(Object.getPrototypeOf((scanned as { sizes: object }).sizes)).toBe(Object.prototype);
		// The files belong to the agent and run.
		expect((await run(made.core, fence, "./bin/b.sh && stat -c '%u %a' docs/a.txt")).stdout).toBe("beta\n1000 644\n");
		expect(await made.core.hydrate(fence, { versionId: null, files: [], dirs: [] })).toMatchObject({ ok: false, reason: "not_empty" });
	});

	test("a checkpoint streams changed files into the bucket under their keys, checked against their hashes", { timeout: 60_000 }, async () => {
		await run(made.core, fence, "printf 'new contents' > docs/new.txt; mkfifo pipe; ln -s /etc/passwd link; mkdir real; echo inside > real/f; ln -s real linked");
		const scanned = (await made.core.scan(fence, { rehashAll: false })) as ScanResult & { ok: true };
		expect(scanned.ok).toBe(true);
		expect(scanned.warnings).toEqual({ total: 3, items: [{ path: "link", reason: "symlink" }, { path: "linked", reason: "symlink" }, { path: "pipe", reason: "special" }] });
		const file = scanned.manifest.files.find((entry) => entry.path === "docs/new.txt") as { sha256: string };
		expect(file.sha256).toBe(sha256Hex(bytes("new contents")));
		const stored = await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: "blobs/new" }] });
		expect(stored).toEqual({ ok: true, stored: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: "blobs/new" }] });
		expect(new TextDecoder().decode(made.bucket.objects.get("blobs/new"))).toBe("new contents");
		// A wrong hash is refused by the bucket; a changed size, or a path through a symbolic link, by the container.
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: "0".repeat(64), size: 12, key: "blobs/bad" }] })).toMatchObject({ ok: false, reason: "mismatch" });
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 13, key: "blobs/bad" }] })).toMatchObject({ ok: false, reason: "changed" });
		expect(await made.core.checkpoint(fence, { files: [{ path: "linked/f", sha256: sha256Hex(bytes("inside\n")), size: 7, key: "blobs/bad" }] })).toMatchObject({ ok: false, reason: "changed" });
		expect(made.bucket.objects.has("blobs/bad")).toBe(false);
		// Without a key (contents the conversation stores already) the bytes are hashed and nothing is written.
		const objects = made.bucket.objects.size;
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: null }] })).toEqual({
			ok: true,
			stored: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: null }],
		});
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: "0".repeat(64), size: 12, key: null }] })).toMatchObject({ ok: false, reason: "mismatch" });
		expect(made.bucket.objects.size).toBe(objects);
		await run(made.core, fence, "rm -rf pipe link linked real");
	});

	test("the scan measures sizes before hashing and counts every entry", { timeout: 60_000 }, async () => {
		await run(made.core, fence, "truncate -s 1G sparse");
		expect(await made.core.scan(fence, { rehashAll: false })).toEqual({ ok: false, limit: "folder_bytes" });
		// tmpfs runs out of inodes at the entry limit, so only hard links, which share one, can pass it.
		const created = await run(made.core, fence, "rm sparse; mkdir many; for i in $(seq 1 120); do touch many/$i 2>/dev/null; done; ls many | wc -l");
		expect(Number(created.stdout.trim())).toBeLessThan(100);
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ ok: true });
		// tmpfs counts a hard link as an inode too, so the entry limit holds for links as well.
		const linked = await run(made.core, fence, "rm -rf many; mkdir many; touch many/0; for i in $(seq 1 120); do ln many/0 many/$i 2>/dev/null; done; ls many | wc -l");
		expect(Number(linked.stdout.trim())).toBeLessThan(100);
		await run(made.core, fence, "rm -rf many");
		expect(await made.core.scan(fence, { rehashAll: true })).toMatchObject({ ok: true });
	});

	test("folder steps need the folder to themselves", { timeout: 30_000 }, async () => {
		const running = made.core.exec(fence, { execId: "busy-1", command: "sleep 2", cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 10 }, null);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ refused: "busy" });
		await running;
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ ok: true });
	});
});

describe.skipIf(!READY)("strays and limits", () => {
	let made: Rig;
	let fence: SandboxFence;

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
	}, 120_000);

	test("killing strays ends every agent process, setsid's included, and nothing else", { timeout: 30_000 }, async () => {
		await run(made.core, fence, "setsid sleep 600 > /dev/null 2>&1 & nohup sleep 601 > /dev/null 2>&1 & (sleep 602 &) ; echo started");
		expect(made.container.shell("pgrep -u 1000 -c -x sleep").stdout.trim()).toBe("3");
		expect(await made.core.killStrays(fence)).toEqual({ ok: true });
		expect(made.container.shell(`cat ${made.container.cgroup}/cgroup.procs | wc -l`).stdout.trim()).toBe("0");
		expect(made.container.shell("pgrep -c tini").stdout.trim()).toBe("1");
		expect((await run(made.core, fence, "echo again")).stdout).toBe("again\n");
	});

	test("a fork bomb stays inside the cgroup's process limit and the sandbox stays usable", { timeout: 60_000 }, async () => {
		// The bomb's processes outlive the command, forking until the cgroup is full; strays are then killed.
		await run(made.core, fence, "b() { b | b & }; b; sleep 3", { timeoutSeconds: 8 });
		expect(Number(made.container.shell(`cat ${made.container.cgroup}/pids.peak 2>/dev/null || cat ${made.container.cgroup}/pids.current`).stdout.trim())).toBeLessThanOrEqual(256);
		expect(await made.core.killStrays(fence)).toEqual({ ok: true });
		expect((await run(made.core, fence, "echo alive")).stdout).toBe("alive\n");
	});

	test("the probe's checks hold", { timeout: 120_000 }, async () => {
		const cgroupLine = `0::${made.container.cgroup.replace("/sys/fs/cgroup", "")}`;
		const probe = await run(made.core, fence, ["/usr/bin/python3", "-I", "-S", "/opt/minerva/probe", String(8 * MiB), "100", "256", cgroupLine], { timeoutSeconds: 110 });
		expect(probe.result).toEqual({ ok: true, exitCode: 0 });
		const report = JSON.parse(probe.stdout) as { checks: Record<string, boolean>; details: Record<string, string> };
		const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => `${name}: ${report.details[name]}`);
		expect(failed).toEqual([]);
		expect(Object.keys(report.checks).length).toBeGreaterThanOrEqual(19);
	});
});

describe.skipIf(!READY)("the Sandbox's fault rows", () => {
	/** A container whose hardening script fails at `step`, as if that step's command had. */
	function failingAt(container: DockerContainer, step: string): ContainerPort {
		return {
			get running() {
				return container.running;
			},
			start: (options) => container.start(options),
			exec: (argv, options) => {
				const script = argv[2];
				if (argv[0] === "/bin/bash" && typeof script === "string" && script.includes("step readonly_root")) {
					const changed = script.replace(`step ${step}\n`, `step ${step}\nfalse\n`);
					return container.exec([argv[0], argv[1] as string, changed, ...argv.slice(3)], options);
				}
				return container.exec(argv, options);
			},
			destroy: () => container.destroy(),
			setInactivityTimeout: () => container.setInactivityTimeout(),
		};
	}

	for (const step of ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"] as const) {
		test(`a hardening that fails at ${step} destroys the container and fails the start`, { timeout: 60_000 }, async () => {
			const made = track(rig());
			const core = new SandboxCore(made.ports(failingAt(made.container, step)));
			const prepared = await prepareSandbox(core, { runId: uuid7(), attempt: 1 }, spec());
			expect(prepared).toEqual({ ok: false, stage: "harden", message: `The sandbox could not be hardened (${step}).` });
			expect(core.status()).toMatchObject({ state: "none", incarnation: null, cleanupPending: false });
			expect(made.container.running).toBe(false);
		});
	}

	test("a command the cgroup does not admit destroys the container", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		made.container.shell(`rmdir ${made.container.cgroup}`);
		const { result } = await run(made.core, fence, "echo never");
		expect(result).toMatchObject({ ok: false, code: "spawn_error", message: expect.stringMatching(/could not admit/) });
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(made.container.running).toBe(false);
		expect(await made.core.exec(fence, { execId: "late", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 1 }, null)).toMatchObject({ refused: "stale" });
	});

	test("hydration from a store that lacks a blob, holds the wrong one, or fails, fails", { timeout: 120_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		const good = bytes("good");
		made.bucket.objects.set("k/good", good);
		made.bucket.objects.set("k/short", bytes("bad"));
		const file = (path: string, key: string, size = good.length, sha256 = sha256Hex(good)) => ({ path, sha256, size, mode: 0o644 as const, mtime: 0, key });
		const many = Array.from({ length: 40 }, (_, i) => file(`f${i}`, "k/good"));
		expect(await made.core.hydrate(fence, { versionId: null, files: [...many, file("missing", "k/none", 4, "1".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "blob_missing" });
		await run(made.core, fence, "rm -rf /workspace/*");
		expect(await made.core.hydrate(fence, { versionId: null, files: [file("short", "k/short", 4, "2".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "mismatch" });
		await run(made.core, fence, "rm -rf /workspace/*");
		const failing = new SandboxCore({ ...made.ports(), bucket: () => ({ get: async () => Promise.reject(new Error("R2 is down")), put: async () => {}, check: async () => {} }) });
		await failing.recover();
		expect(await failing.hydrate(fence, { versionId: null, files: [file("a", "k/good")], dirs: [] })).toMatchObject({ ok: false, reason: "failed" });
		await run(failing, fence, "rm -rf /workspace/*");
		// A hash the bytes do not have is the container's refusal.
		expect(await failing.hydrate(fence, { versionId: null, files: [], dirs: ["d"] })).toEqual({ ok: true });
		await run(failing, fence, "rmdir /workspace/d");
		expect(await made.core.hydrate(fence, { versionId: null, files: [file("x", "k/good", 4, "3".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "mismatch" });
	});

	test("a file helper the cgroup does not admit destroys the container too", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		made.container.shell(`rmdir ${made.container.cgroup}`);
		expect(await made.core.fs(fence, { op: "exists", path: "/workspace" })).toMatchObject({ ok: false, code: "unknown" });
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(made.container.running).toBe(false);
	});

	test("a lost destroy stays owed and the alarm finishes it", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		made.container.failDestroys = 1;
		expect(await made.core.destroy(fence, "turn over")).toEqual({ destroyed: false });
		expect(made.core.status()).toMatchObject({ state: "destroying", cleanupPending: true });
		expect(made.container.running).toBe(true);
		await made.core.alarm();
		expect(made.core.status()).toMatchObject({ state: "none", cleanupPending: false });
		expect(made.container.running).toBe(false);
	});

	test("a restart verifies a running verified container again before using it", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		await run(made.core, fence, "echo kept > kept.txt");
		const restarted = new SandboxCore(made.ports());
		await restarted.recover();
		expect(restarted.status()).toMatchObject({ state: "in_use", incarnation: fence.incarnation });
		expect((await run(restarted, fence, "cat kept.txt")).stdout).toBe("kept\n");
		// Remounting / writable makes the next restart's verification fail, and the container is destroyed.
		made.container.shell("mount -o remount,rw /");
		const again = new SandboxCore(made.ports());
		await again.recover();
		expect(await again.exec(fence, { execId: "r", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 1 }, null)).toMatchObject({ refused: "not_verified" });
		expect(again.status()).toMatchObject({ state: "none" });
		expect(made.container.running).toBe(false);
	});

	test("a restart destroys a running container it never verified", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const started = await made.core.start({ runId: uuid7(), attempt: 1 }, spec());
		expect(started).toHaveProperty("incarnation");
		expect(made.container.running).toBe(true);
		const restarted = new SandboxCore(made.ports());
		await restarted.recover();
		expect(restarted.status()).toMatchObject({ state: "none", incarnation: null });
		expect(made.container.running).toBe(false);
	});

	test("fences: an older attempt cannot start, and another incarnation's calls are refused", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const runId = uuid7();
		const first = await prepareSandbox(made.core, { runId, attempt: 2 }, spec());
		if (!first.ok) throw new Error(first.message);
		expect(await made.core.start({ runId, attempt: 1 }, spec())).toEqual({ refused: "stale", message: expect.any(String) });
		const wrong = { ...first.fence, attempt: 3 };
		expect(await made.core.exec(wrong, { execId: "w", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 1 }, null)).toMatchObject({ refused: "stale" });
		expect(await made.core.destroy({ ...first.fence, incarnation: "other" }, "late")).toMatchObject({ refused: "stale" });
		expect(made.core.status().state).toBe("verified");
		// A newer attempt's start replaces the container.
		const second = await prepareSandbox(made.core, { runId, attempt: 3 }, spec());
		if (!second.ok) throw new Error(second.message);
		expect(second.fence.incarnation).not.toBe(first.fence.incarnation);
		expect(await made.core.exec(first.fence, { execId: "o", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 1 }, null)).toMatchObject({ refused: "stale" });
		expect(await made.core.harden(second.fence)).toMatchObject({ refused: "not_verified" });
	});
});
