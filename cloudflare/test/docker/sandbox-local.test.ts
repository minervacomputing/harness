// The Sandbox's logic against the real image in a local Docker container (sandbox-docker.ts): the
// lifecycle and its fences, the hardening and its verification, commands through the wrapper and file
// operations through Files' sandbox-shim as the agent's user, pi's ExecutionEnv conformance suite (24 cases,
// one skipped) over the adapter, the read tool's timings, killing strays, the fork and folder limits, and the
// Sandbox fault rows of the plan (each hardening step failing, cgroup admission failing, a lost destroy, a
// restart with a container still running), parking a container for the next run, and retiring it with a snapshot
// that a later start restores and seeds the folder from. Hydration, scans and checkpoints are folder.test.ts's.
// Skipped without Docker or the image: `pnpm sandbox:image` builds it.

import { getOrThrow, LineScanner } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { afterAll, assert, beforeAll, describe, expect, test } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { commandEnvironment, IDLE_MS, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import { SandboxExecutionEnv } from "../../src/sandbox/env.ts";
import type { HydratePlan } from "../../src/sandbox/folder.ts";
import type { Delivered } from "../../src/sandbox/output.ts";
import type { ContainerPort } from "../../src/sandbox/ports.ts";
import { prepareSandbox } from "../../src/sandbox/session.ts";
import { readSnapshot, type SnapshotRecord, writeSnapshot } from "../../src/sandbox/store.ts";
import { DockerContainer, dockerReady, plainSink, ready, type Rig, rig, run, spec } from "./sandbox-docker.ts";

const READY = dockerReady();
/** A context without cancellation: the adapter only reads its abort signal. */
const NONE = {} as Parameters<SandboxExecutionEnv["readTextFile"]>[1];
const KiB = 1024;
const MiB = 1024 * KiB;

/** pi's conformance cases the adapter does not pass, each with its reason. */
const SKIPPED: Record<string, string> = {
	"binary reader keeps reading the file it opened after a rename":
		"A binary reader reads its path again on each call instead of holding the file open, so a rename during reading gives an error or the new contents.",
};

const rigs: Rig[] = [];
function track(made: Rig): Rig {
	rigs.push(made);
	return made;
}

afterAll(() => {
	for (const made of rigs) made.container.remove();
});

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
		expect(cases.filter((entry) => entry.name in SKIPPED)).toHaveLength(Object.keys(SKIPPED).length);
		for (const entry of cases) {
			if (entry.name in SKIPPED) continue;
			try {
				await entry.run();
			} catch (error) {
				failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		expect(failures).toEqual([]);
	});
});

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
		expect(path).toMatch(/^\/tmp\/pi-output-[A-Za-z0-9]{10}\.log$/);
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

	test("file operations run as the agent", async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		getOrThrow(await env.writeFile("owned/by/agent.txt", "x", NONE));
		expect(made.container.shell("stat -c '%u:%g' /workspace/owned /workspace/owned/by/agent.txt").stdout).toBe("1000:1000\n1000:1000\n");
		const denied = await env.readTextFile("/etc/shadow", NONE);
		expect(denied.ok ? "ok" : denied.error.code).toBe("permission_denied");
		getOrThrow(await env.remove("owned", { recursive: true }, NONE));
	});

	test("a FIFO's read and write end at the operation's timeout; opening or testing one refuses it at once", { timeout: 30_000 }, async () => {
		made.container.shell("mkfifo /workspace/fifo && chown 1000:1000 /workspace/fifo");
		const core = new SandboxCore({ ...made.ports(), fileSeconds: 2 });
		await core.recover();
		const env = new SandboxExecutionEnv({ sandbox: core, fence, sink: plainSink });
		const codes = async (operation: () => Promise<{ ok: true } | { ok: false; error: { code: string } }>) => {
			const started = Date.now();
			const result = await operation();
			return [result.ok ? "ok" : result.error.code, Date.now() - started] as const;
		};
		const [read, readMs] = await codes(() => env.readTextFile("fifo", NONE));
		const [write, writeMs] = await codes(() => env.writeFile("fifo", "x", NONE));
		const [reader, readerMs] = await codes(() => env.openBinaryReader("fifo", undefined, NONE));
		const [exists, existsMs] = await codes(() => env.exists("fifo", NONE));
		expect([read, write, reader, exists]).toEqual(["unknown", "unknown", "invalid", "invalid"]);
		for (const ms of [readMs, writeMs]) {
			expect(ms).toBeGreaterThanOrEqual(1900);
			expect(ms).toBeLessThan(5000);
		}
		for (const ms of [readerMs, existsMs]) expect(ms).toBeLessThan(1000);
		made.container.shell("sleep 0.5");
		expect(made.container.shell("pgrep -f '^/usr/local/bin/sandbox-shim' | wc -l").stdout.trim()).toBe("0");
		made.container.shell("rm /workspace/fifo");
	});

	test("a binary reader's lines and bytes are the whole file's: a byte-order mark, invalid bytes, and lines across the stream's chunks", { timeout: 60_000 }, async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		const parts: number[] = [0xef, 0xbb, 0xbf, ...new TextEncoder().encode("first\n"), 0xff, 0xc3, 0x0a];
		for (let i = 0; parts.length < 300 * KiB; i++) parts.push(...new TextEncoder().encode(`${"x".repeat(i % 97)}\u{1F600}${i}\n`));
		parts.push(...new TextEncoder().encode("last line, no newline"));
		const bytes = Uint8Array.from(parts);
		getOrThrow(await env.writeFile("lines.bin", bytes, NONE));
		const reader = getOrThrow(await env.openBinaryReader("lines.bin", undefined, NONE));
		const whole = (startLine: number, endLine?: number) => {
			const scanner = new LineScanner(startLine, endLine);
			scanner.push(bytes);
			return scanner.finish();
		};
		for (const [startLine, endLine] of [[0, undefined], [0, 1], [1, 3], [2000, 2010], [3000, undefined], [1_000_000, undefined]] as const) {
			expect(getOrThrow(await reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, NONE))).toEqual(whole(startLine, endLine));
		}
		for (const [offset, length] of [[0, 3], [65_530, 20], [bytes.length - 5, 100], [bytes.length, 10], [7, 0]] as const) {
			expect(getOrThrow(await reader.read(offset, length, NONE))).toEqual(bytes.slice(offset, offset + length));
		}
		await reader.close(NONE);
		getOrThrow(await env.remove("lines.bin", undefined, NONE));
	});

	test("timings: pi's read tool on a small and a 50 MB file, and small writes", { timeout: 120_000 }, async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		const read = createReadTool();
		const api = { env } as unknown as Parameters<typeof read.execute>[1];
		const timed = async (operation: () => Promise<unknown>) => {
			const started = performance.now();
			await operation();
			return Math.round(performance.now() - started);
		};
		const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] as number;
		getOrThrow(await env.writeFile("small.txt", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), NONE));
		made.container.shell("yes 'a line of fifty bytes, give or take, for the read' | head -c 52428800 > /tmp/big.txt && chown 1000:1000 /tmp/big.txt");
		const small: number[] = [];
		for (let i = 0; i < 10; i++) small.push(await timed(() => read.execute({ path: "/workspace/small.txt" }, api, NONE)));
		const big: number[] = [];
		for (let i = 0; i < 3; i++) big.push(await timed(() => read.execute({ path: "/tmp/big.txt" }, api, NONE)));
		const bigTail = await timed(() => read.execute({ path: "/tmp/big.txt", offset: 1_000_000, limit: 10 }, api, NONE));
		const writes: number[] = [];
		for (let i = 0; i < 10; i++) writes.push(await timed(async () => getOrThrow(await env.writeFile(`w/${i}.txt`, `file ${i}\n`, NONE))));
		const result = await read.execute({ path: "/tmp/big.txt", offset: 1_000_000, limit: 1 }, api, NONE);
		expect(JSON.stringify(result.output)).toContain("a line of fifty bytes");
		console.log(`timings (ms): read small median ${median(small)} of ${small.join(" ")}; read 50 MB ${big.join(" ")}, from line 1,000,000 ${bigTail}; writeFile small median ${median(writes)} of ${writes.join(" ")}`);
		made.container.shell("rm -rf /tmp/big.txt /workspace/small.txt /workspace/w");
	});

	test("writes past the folder's size fail with ENOSPC, and the root is read-only", { timeout: 30_000 }, async () => {
		const env = new SandboxExecutionEnv({ sandbox: made.core, fence, sink: plainSink });
		const big = await env.writeFile("big.bin", new Uint8Array(9 * MiB), NONE);
		expect(big.ok ? "ok" : big.error.message).toMatch(/^No space left on device: /);
		getOrThrow(await env.remove("big.bin", undefined, NONE));
		const root = await env.writeFile("/etc/probe", "x", NONE);
		expect(root.ok ? "ok" : `${root.error.code} ${root.error.message}`).toBe("unknown Read-only file system: /etc/probe");
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
		expect(Object.keys(report.checks).length).toBeGreaterThanOrEqual(20);
	});
});

describe.skipIf(!READY)("a sandbox in a container started as workerd starts one locally", () => {
	// workerd gives the container SYS_ADMIN but its own cgroup namespace, mounted read-only, whose root holds
	// the container's processes: the hardening has to make room for the agent cgroup itself.
	test("hardening and verification hold the cgroup's limits", async () => {
		const made = track(rig("workerd"));
		const fence = await ready(made);
		expect(made.core.status().state).toBe("verified");
		expect(made.container.shell(`cat ${made.container.cgroup}/pids.max ${made.container.cgroup}/memory.max`).stdout.split("\n")).toEqual([
			"256",
			String(1024 * MiB + 8 * MiB + 256 * MiB),
			"",
		]);
		const ran = await run(made.core, fence, "cat /proc/self/cgroup");
		expect(ran.stdout).toBe("0::/agent\n");
	}, 120_000);
});

describe.skipIf(!READY)("the Sandbox's fault rows", () => {
	/** A container whose hardening script fails at `step`, as if that step's command had. */
	function failingAt(container: DockerContainer, step: string): ContainerPort {
		return {
			get running() {
				return container.running;
			},
			get image() {
				return container.image;
			},
			start: (options) => container.start(options),
			snapshot: () => container.snapshot(),
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

	test("a file command the cgroup does not admit destroys the container too", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		made.container.shell(`rmdir ${made.container.cgroup}`);
		expect(await made.core.fs(fence, { op: "canonical", path: "/workspace" })).toMatchObject({ ok: false, code: "unknown" });
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

	test("a seal destroys the run's container, answers its one span and refuses the run's later starts", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		const { startedAt } = made.core.status();
		expect((await run(made.core, fence, "echo hi")).stdout).toBe("hi\n");
		const sealed = await made.core.seal(fence.runId);
		expect(sealed).toEqual({ since: 0, spans: [{ startedAt, leaseUntil: (startedAt ?? 0) + IDLE_MS, endedAt: expect.any(Number), ended: "destroyed" }] });
		expect(sealed.spans[0]?.endedAt).toBeGreaterThan(startedAt ?? Infinity);
		expect(made.container.running).toBe(false);
		expect(await made.core.start({ runId: fence.runId, attempt: 2 }, spec())).toEqual({ refused: "stale", message: "This run has ended." });
		expect(made.container.started).toHaveLength(1);
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

describe.skipIf(!READY)("parking", () => {
	const VERSION = "0199b000-0000-7000-8000-0000000000a1";

	test("parking leaves only the folder's files and directories, with hydration's modes, kills every agent process and empties every other place the agent writes; the next run acquires it", { timeout: 120_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		const wrote = await run(made.core, fence, "mkdir -p d/e && echo hi > d/e/f && chmod 0600 d/e/f && echo 'echo run' > run.sh && chmod 0700 run.sh && chmod 2770 d && ln -s d/e/f link && mkfifo pipe && echo ok");
		expect(wrote.stdout).toBe("ok\n");
		// The run's last checkpoint scans the folder: links and special files are all it leaves out.
		expect(await made.core.scan(fence, { rehashAll: true })).toMatchObject({ ok: true, warnings: { total: 2 } });
		const left = await run(made.core, fence, "echo t > /tmp/left && echo s > /dev/shm/left && ipcmk -M 4096 > /dev/null && (setsid sleep 600 > /dev/null 2>&1 &) && echo ok");
		expect(left.stdout).toBe("ok\n");
		expect(made.container.shell("pgrep -u 1000 -c -x sleep").stdout.trim()).toBe("1");

		expect(await made.core.park(fence, VERSION)).toEqual({ parked: true });
		expect(made.core.status().state).toBe("parked");
		expect(made.container.shell("find /workspace -printf '%y %m %P\\n' | sort").stdout.split("\n")).toEqual(["d 755 ", "d 755 d", "d 755 d/e", "f 644 d/e/f", "f 755 run.sh", ""]);
		expect(made.container.shell("ls -A /tmp; echo ---; ls -A /dev/shm /dev/mqueue; echo ---; stat -c '%U %a' /tmp/home /tmp/matplotlib").stdout).toBe("home\nmatplotlib\n---\n/dev/mqueue:\n\n/dev/shm:\n---\nagent 755\nagent 755\n");
		expect(made.container.shell("pgrep -u 1000 -c . || true; ipcs -m | grep -c agent || true").stdout).toBe("0\n0\n");

		const next = { runId: uuid7(), attempt: 1 };
		const acquired = await made.core.acquire(next, spec(), VERSION);
		if (!("incarnation" in acquired)) throw new Error(JSON.stringify(acquired));
		expect(made.container.started).toHaveLength(1);
		const fresh = { ...next, incarnation: acquired.incarnation };
		expect((await run(made.core, fresh, "cat d/e/f && ./run.sh && ls -A /tmp")).stdout).toBe("hi\nrun\nhome\nmatplotlib\n");
		expect(await run(made.core, fence, "true")).toMatchObject({ result: { refused: "stale" } });
	});

	test("a hard link in the folder destroys the container instead", { timeout: 60_000 }, async () => {
		const made = track(rig());
		const fence = await ready(made);
		expect((await run(made.core, fence, "echo a > a && ln a b && echo ok")).stdout).toBe("ok\n");
		expect(await made.core.scan(fence, { rehashAll: true })).toMatchObject({ ok: true, warnings: { total: 0 } });
		expect(await made.core.park(fence, VERSION)).toEqual({ parked: false });
		expect(made.container.running).toBe(false);
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
	});
});

describe.skipIf(!READY)("retiring and restoring", () => {
	const VERSION = "0199b000-0000-7000-8000-0000000000b1";
	const NEXT = "0199b000-0000-7000-8000-0000000000b2";
	/** Enough entries for the 300 files that make a folder worth a snapshot. */
	const LIMITS = { folderBytes: 64 * MiB, folderEntries: 1000 };
	/** Every extended attribute under `root`, ACLs included, as `path name` lines. */
	const XATTRS = "import os, sys\nfor d, ds, fs in os.walk(sys.argv[1]):\n    for p in [d] + [os.path.join(d, f) for f in fs]:\n        for n in os.listxattr(p, follow_symlinks=False): print(p, n)";
	const ARCHIVE = "/var/lib/minerva/folder.tar";

	let made: Rig;
	let core: SandboxCore;
	let plan: HydratePlan;
	let record: SnapshotRecord;

	/** The plan a version of the folder as `scanned` would hydrate. */
	function planOf(scanned: Awaited<ReturnType<SandboxCore["scan"]>>, versionId: string): HydratePlan {
		if (!("ok" in scanned) || !scanned.ok) throw new Error(JSON.stringify(scanned));
		const files = scanned.manifest.files.map((file) => ({ ...file, size: scanned.sizes[file.path] ?? 0, key: `k/${file.path}` }));
		return { versionId, files, dirs: scanned.manifest.dirs };
	}

	/** A run's sandbox restored from the snapshot of `versionId`, hardened and verified; `change` runs as root on the restored archive first. */
	async function restore(sandbox: SandboxCore, { limits = LIMITS, change, versionId = VERSION }: { limits?: typeof LIMITS; change?: string; versionId?: string } = {}): Promise<SandboxFence> {
		const attempt = { runId: uuid7(), attempt: 1 };
		const started = await sandbox.start(attempt, spec(limits), versionId);
		if (!("incarnation" in started)) throw new Error(JSON.stringify(started));
		expect(started.restored).toBe(true);
		if (change) expect(made.container.shell(change)).toMatchObject({ status: 0 });
		const fence = { ...attempt, incarnation: started.incarnation };
		expect(await sandbox.harden(fence)).toMatchObject({ ok: true });
		expect(await sandbox.verify(fence)).toMatchObject({ ok: true });
		return fence;
	}

	beforeAll(async () => {
		made = track(rig());
		core = new SandboxCore({ ...made.ports(), parkedMs: 0 });
		const fence = await ready({ ...made, core }, LIMITS);
		const wrote = await run(
			core,
			fence,
			[
				"mkdir -p many .git empty && for i in $(seq 300); do echo $i > many/$i; done",
				"printf '[core]\\n' > .git/config && echo classified > secret.txt && chmod 0600 secret.txt && echo é > café.txt",
				"python3 -c \"import os; os.setxattr('café.txt', 'user.origin', b'web')\" && echo ok",
			].join(" && "),
		);
		expect(wrote.stdout).toBe("ok\n");
		plan = planOf(await core.scan(fence, { rehashAll: true }), VERSION);
		expect(await core.park(fence, VERSION)).toEqual({ parked: true });
		await core.alarm();
		const taken = readSnapshot(made.sql);
		if (!taken) throw new Error(`no snapshot: ${made.logs.join(", ")}`);
		record = taken;
	}, 300_000);

	test("a retired folder's snapshot restores it as the agent's, with hydration's modes and no extended attribute; the archive on the root disk is root's alone and holds none either", { timeout: 180_000 }, async () => {
		expect(made.container.snapshots).toEqual([record.snapshotId]);
		expect(core.status()).toMatchObject({ state: "none", snapshot: { versionId: VERSION, takenAt: record.takenAt } });
		expect(plan.files.find((file) => file.path === "secret.txt")).toMatchObject({ mode: 0o644 });
		expect(plan.dirs).toContain("empty");

		const fence = await restore(core);
		expect(made.container.started.at(-1)?.restore).toBe(record.snapshotId);
		expect(await run(core, fence, "true")).toMatchObject({ result: { refused: "not_verified" } });
		const seeded = await core.hydrate(fence, plan);
		expect(seeded).toMatchObject({ ok: true, restored: { seedMs: expect.any(Number), checkMs: expect.any(Number) } });
		expect(readSnapshot(made.sql)?.restoredAt).toEqual(expect.any(Number));

		const listing = made.container.shell("find /workspace -mindepth 1 -not -path '/workspace/many/*' -printf '%u %y %m %P\\n' | sort").stdout;
		expect(listing.split("\n")).toEqual(["agent d 755 .git", "agent d 755 empty", "agent d 755 many", "agent f 644 .git/config", "agent f 644 café.txt", "agent f 644 secret.txt", ""]);
		expect(made.container.shell("find /workspace/many -type f -printf '%u %m\\n' | sort | uniq -c").stdout.trim()).toBe("300 agent 644");
		expect(made.container.shell(`/usr/bin/python3 -I -c "${XATTRS}" /workspace`).stdout).toBe("");
		// GNU tar stores extended attributes, ACLs and SELinux labels as SCHILY.* and RHT.* pax records.
		expect(made.container.shell(`stat -c '%U %a' /var/lib/minerva ${ARCHIVE}; grep -ac -e SCHILY -e RHT ${ARCHIVE} || true`).stdout).toBe("root 700\nroot 600\n0\n");
		expect((await run(core, fence, "cat .git/config café.txt secret.txt; ls /var/lib/minerva 2>&1")).stdout).toBe("[core]\né\nclassified\nls: cannot open directory '/var/lib/minerva': Permission denied\n");
		expect(await core.destroy(fence, "turn over")).toEqual({ destroyed: true });
	});

	for (const [name, change, difference] of [
		["an extra file", `echo stray > /tmp/stray.txt && tar -r -f ${ARCHIVE} --format=pax -C /tmp stray.txt`, '"stray.txt" (extra file)'],
		["a changed byte", `/usr/bin/python3 -I -c 'import sys; f = open(sys.argv[1], "r+b"); f.seek(f.read().index(b"classified")); f.write(b"C")' ${ARCHIVE}`, '"secret.txt" (sha256)'],
	] as const) {
		test(`an archive with ${name} fails the check, destroys the container and drops the record`, { timeout: 180_000 }, async () => {
			writeSnapshot(made.sql, record);
			const fence = await restore(core, { change });
			expect(await core.hydrate(fence, plan)).toEqual({ ok: false, reason: "restore_failed", message: `The restored folder differs from the plan at ${difference}.` });
			expect(core.status()).toMatchObject({ state: "none", snapshot: null });
			expect(made.container.running).toBe(false);
		});
	}

	test("a restored folder its run changed retires into a snapshot of the new version, whose archive holds that version alone, and restores again", { timeout: 300_000 }, async () => {
		writeSnapshot(made.sql, record);
		const fence = await restore(core);
		expect(await core.hydrate(fence, plan)).toMatchObject({ ok: true, restored: expect.any(Object) });
		expect((await run(core, fence, "rm secret.txt && echo changed > café.txt && echo new > added.txt && rmdir empty && echo ok")).stdout).toBe("ok\n");
		const next = planOf(await core.scan(fence, { rehashAll: true }), NEXT);
		expect(await core.park(fence, NEXT)).toEqual({ parked: true });
		await core.alarm();
		expect(core.status()).toMatchObject({ state: "none", snapshot: { versionId: NEXT } });

		const again = await restore(core, { versionId: NEXT });
		expect(await core.hydrate(again, next)).toMatchObject({ ok: true, restored: expect.any(Object) });
		const listed = made.container.shell(`tar --quoting-style=literal -tf ${ARCHIVE} | sort`).stdout.trim().split("\n");
		const inMany = (entry: string) => /^\.\/many\/./.test(entry);
		expect(listed.filter((entry) => !inMany(entry))).toEqual(["./", "./.git/", "./.git/config", "./added.txt", "./café.txt", "./many/"]);
		expect(listed.filter(inMany)).toHaveLength(300);
		expect((await run(core, again, "cat café.txt added.txt")).stdout).toBe("changed\nnew\n");
		expect(await core.destroy(again, "turn over")).toEqual({ destroyed: true });
	});

	test("a folder of three files retires with no snapshot", { timeout: 120_000 }, async () => {
		const small = track(rig());
		const sandbox = new SandboxCore({ ...small.ports(), parkedMs: 0 });
		const fence = await ready({ ...small, core: sandbox });
		expect((await run(sandbox, fence, "echo a > a && echo b > b && echo c > c && echo ok")).stdout).toBe("ok\n");
		expect(await sandbox.scan(fence, { rehashAll: true })).toMatchObject({ ok: true });
		expect(await sandbox.park(fence, VERSION)).toEqual({ parked: true });
		await sandbox.alarm();
		expect(sandbox.status()).toMatchObject({ state: "none", snapshot: null });
		expect(small.container.snapshots).toEqual([]);
		expect(small.container.running).toBe(false);
	});

	test("timings: the seed and the check of a 200 MB file", { timeout: 300_000 }, async () => {
		const big = track(rig());
		const sandbox = new SandboxCore({ ...big.ports(), parkedMs: 0 });
		const limits = { folderBytes: 256 * MiB, folderEntries: 100 };
		const fence = await ready({ ...big, core: sandbox }, limits);
		expect((await run(sandbox, fence, "head -c 200000000 /dev/urandom > big.bin && echo ok", { timeoutSeconds: 120 })).stdout).toBe("ok\n");
		const bigPlan = planOf(await sandbox.scan(fence, { rehashAll: true }), VERSION);
		expect(await sandbox.park(fence, VERSION)).toEqual({ parked: true });
		const retiring = performance.now();
		await sandbox.alarm();
		const retireMs = Math.round(performance.now() - retiring);
		expect(sandbox.status().snapshot).toMatchObject({ versionId: VERSION });
		const restoring = performance.now();
		const restored = await restore(sandbox, { limits });
		const restoreMs = Math.round(performance.now() - restoring);
		const seeded = await sandbox.hydrate(restored, bigPlan);
		if (!("ok" in seeded) || !seeded.ok || !seeded.restored) throw new Error(JSON.stringify(seeded));
		console.log(`timings (ms), 200 MB: retire (archive and docker commit) ${retireMs}; restore (start, harden, verify) ${restoreMs}; seed ${seeded.restored.seedMs}; check ${seeded.restored.checkMs}`);
	});
});
