// The Sandbox's lifecycle (src/sandbox/core.ts) over a scripted container and node:sqlite, without Docker:
// the states and what each admits, fences, a failed start, hardening and destroy, the alarm's retries and
// leases, a restart in each state, an admission failure and a container lost under a call. The same paths
// against the real image are in sandbox-local.test.ts.

import { describe, expect, test, vi } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { migrate, type Sql, sqliteSql } from "../../src/lib/sql.ts";
import { DEADLINE_GRACE_MS, IDLE_MS, sandboxSpec, type SandboxSpec, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import type { ContainerPort, SandboxPorts } from "../../src/sandbox/ports.ts";
import { prepareSandbox } from "../../src/sandbox/session.ts";
import { readState, SANDBOX_MIGRATIONS } from "../../src/sandbox/store.ts";
import { openDatabase } from "./sqlite.ts";

const CGROUP = "/sys/fs/cgroup/agent";
const SPEC = sandboxSpec({ id: "w", jurisdiction: null }, "c", { folderBytes: 1 << 20, folderEntries: 50 }, null);

function stream(text: string): ReadableStream<Uint8Array> {
	return new Blob([text]).stream();
}

function process(stdout: string, exitCode: number): ExecProcess {
	return {
		stdin: new WritableStream(),
		stdout: stream(stdout),
		stderr: stream(""),
		pid: 42,
		isPty: false,
		exitCode: Promise.resolve(exitCode),
		async output() {
			return { stdout: new TextEncoder().encode(stdout).buffer as ArrayBuffer, stderr: new ArrayBuffer(0), exitCode };
		},
		kill() {},
		resize() {},
	};
}

/** A process that never exits and never ends its output, killed or not. */
function hung(): ExecProcess {
	return { ...process("", 0), stdout: new ReadableStream(), stderr: new ReadableStream(), exitCode: new Promise(() => {}) };
}

/** Facts a verification would report for `spec` in a well-hardened container. */
function facts(spec: SandboxSpec): string {
	const ws = Math.floor(spec.folderBytes / 4096) * 4096;
	return JSON.stringify({
		mountinfo: [
			"1 0 0:1 / / ro,relatime - btrfs /dev/vda rw",
			`2 1 0:2 / /workspace rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=${ws / 1024}k,nr_inodes=${spec.folderEntries + 1},mode=755,uid=1000,gid=1000`,
			`3 1 0:3 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=${spec.tmpBytes / 1024}k`,
		].join("\n"),
		"/tmp": { dir: true, uid: 0, gid: 0, mode: 0o1777 },
		"/tmp/home": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
		"/tmp/matplotlib": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
		"pids.max": String(spec.pidsMax),
		"memory.max": String(spec.memoryBytes),
		tmp_exec: "EACCES",
		etc_write: "EROFS",
		dropped: {
			exit: 0,
			stdout: "\u0006Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n---\n0::/agent\n",
		},
	});
}

class ScriptedContainer implements ContainerPort {
	running = false;
	starts = 0;
	verifications = 0;
	failDestroys = 0;
	ready = true;
	failHardeningAt: string | null = null;
	/** What a wrapped command answers: its stdout (after the wrapper's byte) and exit, or a failed admission. */
	command: { stdout: string; exitCode: number; admitted: boolean } = { stdout: "", exitCode: 0, admitted: true };
	lostOnExec = false;
	/** A verification whose exec never answers, or whose process never ends. */
	hangVerification: "exec" | "process" | null = null;
	/** A wrapped command whose exec never answers. */
	hangCommands = false;
	/** While set, a wrapped process joins the cgroup (and its exec answers) only once it resolves. */
	joining: Promise<void> | null = null;
	/** While set, a kill of strays answers only once it resolves. */
	killGate: Promise<void> | null = null;
	killsRunning = 0;
	mostKillsRunning = 0;
	readonly log: string[] = [];
	#spec: SandboxSpec | null = null;

	start(): void {
		this.starts++;
		this.running = true;
	}

	async exec(argv: string[]): Promise<ExecProcess> {
		if (!this.running || this.lostOnExec) throw new Error("exec() cannot be called on a container that is not running");
		const script = argv[2] ?? "";
		if (argv[0] === "/bin/true") return process("", this.ready ? 0 : 1);
		if (argv[0] === "/bin/bash" && script.includes("step readonly_root")) {
			this.log.push("harden");
			const [size, inodes, tmp, pids, memory] = argv.slice(3).map(Number) as number[];
			this.#spec = { ...SPEC, folderBytes: size as number, folderEntries: (inodes as number) - 1, tmpBytes: tmp as number, pidsMax: pids as number, memoryBytes: memory as number };
			const steps = ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"];
			const until = this.failHardeningAt ? steps.indexOf(this.failHardeningAt) + 1 : steps.length;
			const out = steps.slice(0, until).map((step) => `step ${step}\n`).join("") + (this.failHardeningAt ? "" : "step done\n");
			return process(out, this.failHardeningAt ? 1 : 0);
		}
		if (argv[3] === "-c" && argv[4]?.includes("mountinfo")) {
			this.verifications++;
			this.log.push("verify");
			if (this.hangVerification === "exec") return await new Promise<never>(() => {});
			if (this.hangVerification === "process") return hung();
			return process(facts(this.#spec ?? SPEC), 0);
		}
		if (script.includes("cgroup.kill")) {
			this.killsRunning++;
			this.mostKillsRunning = Math.max(this.mostKillsRunning, this.killsRunning);
			if (this.killGate) await this.killGate;
			this.killsRunning--;
			this.log.push("kill");
			return process("", 0);
		}
		if (script.includes("cgroup.procs")) {
			if (this.joining) await this.joining;
			if (this.hangCommands) return await new Promise<never>(() => {});
			this.log.push("command");
			if (!this.command.admitted) return process("", 125);
			return process(`\u0006${this.command.stdout}`, this.command.exitCode);
		}
		this.log.push(`root ${argv[0]}`);
		return process("", 0);
	}

	async destroy(): Promise<void> {
		this.log.push("destroy");
		if (this.failDestroys > 0) {
			this.failDestroys--;
			throw new Error("internal error");
		}
		this.running = false;
	}

	async setInactivityTimeout(): Promise<void> {}
}

interface Rig {
	core: SandboxCore;
	sql: Sql;
	container: ScriptedContainer;
	alarms: (number | null)[];
	clock: { now: number };
	ports(): SandboxPorts;
	restart(): Promise<SandboxCore>;
}

function rig(): Rig {
	const sql = sqliteSql(openDatabase());
	migrate(sql, SANDBOX_MIGRATIONS, 0);
	const container = new ScriptedContainer();
	const alarms: (number | null)[] = [];
	const clock = { now: 1_800_000_000_000 };
	const ports = (): SandboxPorts => ({
		container,
		sql,
		bucket: () => ({ get: async () => null, put: async () => {}, check: async () => {} }),
		now: () => clock.now,
		id: () => uuid7(),
		alarm: async (at) => {
			alarms.push(at);
		},
		background: () => {},
		log: () => {},
		cgroup: CGROUP,
	});
	const made: Rig = {
		core: new SandboxCore(ports()),
		sql,
		container,
		alarms,
		clock,
		ports,
		async restart() {
			const core = new SandboxCore(ports());
			await core.recover();
			made.core = core;
			return core;
		},
	};
	return made;
}

async function ready(made: Rig, spec: SandboxSpec = SPEC, attempt = 1, runId = uuid7()): Promise<SandboxFence> {
	const prepared = await prepareSandbox(made.core, { runId, attempt }, spec);
	if (!prepared.ok) throw new Error(prepared.message);
	return prepared.fence;
}

const command = (made: Rig, fence: SandboxFence, execId = uuid7()) =>
	made.core.exec(fence, { execId, command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 10 }, null);

describe("the lifecycle", () => {
	test("start, harden and verify, each state written before its step", async () => {
		const made = rig();
		const fence = await ready(made);
		expect(made.core.status()).toMatchObject({ state: "verified", incarnation: fence.incarnation, runId: fence.runId, attempt: 1, cleanupPending: false });
		expect(readState(made.sql)).toMatchObject({ state: "verified", hardened: true, spec: SPEC });
		expect(made.container.log).toEqual(["harden", "verify"]);
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
		expect(readState(made.sql).state).toBe("in_use");
		// An idle hour without a deadline, then the alarm destroys it.
		expect(made.alarms.at(-1)).toBe(made.clock.now + IDLE_MS);
	});

	test("nothing is admitted before verification, and each step only once", async () => {
		const made = rig();
		const started = await made.core.start({ runId: uuid7(), attempt: 1 }, SPEC);
		if (!("incarnation" in started)) throw new Error("no start");
		const real: SandboxFence = { runId: readState(made.sql).runId as string, attempt: 1, incarnation: started.incarnation };
		expect(await command(made, real)).toMatchObject({ refused: "not_verified" });
		expect(await made.core.verify(real)).toMatchObject({ refused: "not_verified" });
		expect(await made.core.harden(real)).toMatchObject({ ok: true });
		expect(await made.core.harden(real)).toMatchObject({ refused: "not_verified" });
		expect(await command(made, real)).toMatchObject({ refused: "not_verified" });
		expect(await made.core.verify(real)).toMatchObject({ ok: true });
		expect(await made.core.verify(real)).toMatchObject({ refused: "not_verified" });
		expect(await command(made, real)).toEqual({ ok: true, exitCode: 0 });
	});

	test("an older attempt cannot start; a newer one replaces the container", async () => {
		const made = rig();
		const runId = uuid7();
		const second = await ready(made, SPEC, 2, runId);
		expect(await made.core.start({ runId, attempt: 1 }, SPEC)).toMatchObject({ refused: "stale" });
		expect(await made.core.start({ runId: "00000000-0000-7000-8000-000000000000", attempt: 9 }, SPEC)).toMatchObject({ refused: "stale" });
		const third = await ready(made, SPEC, 3, runId);
		expect(made.container.starts).toBe(2);
		expect(made.container.log.filter((entry) => entry === "destroy")).toHaveLength(1);
		expect(await command(made, second)).toMatchObject({ refused: "stale" });
		expect(await made.core.destroy(second, "late cleanup")).toMatchObject({ refused: "stale" });
		expect(made.core.status().state).toBe("verified");
		expect(await command(made, third)).toEqual({ ok: true, exitCode: 0 });
	});

	test("a newer attempt is the newest seen even when the container it replaces cannot be destroyed", async () => {
		const made = rig();
		const runId = uuid7();
		await ready(made, SPEC, 1, runId);
		made.container.failDestroys = 1;
		expect(await made.core.start({ runId, attempt: 2 }, SPEC)).toEqual({ failed: "The previous container could not be destroyed." });
		expect(made.core.status()).toMatchObject({ runId, attempt: 2, cleanupPending: true });
		// A late start of the replaced attempt starts nothing, now or after a restart.
		expect(await made.core.start({ runId, attempt: 1 }, SPEC)).toMatchObject({ refused: "stale" });
		await made.restart();
		expect(await made.core.start({ runId, attempt: 1 }, SPEC)).toMatchObject({ refused: "stale" });
		expect(made.container.starts).toBe(1);
		await ready(made, SPEC, 2, runId);
		expect(made.container.starts).toBe(2);
	});

	test("limits that make no sense, or a container that never answers, fail the start", async () => {
		const made = rig();
		expect(await made.core.start({ runId: uuid7(), attempt: 1 }, { ...SPEC, folderBytes: 100 })).toEqual({ failed: "The sandbox's limits are invalid." });
		expect(await made.core.start({ runId: uuid7(), attempt: 1 }, { ...SPEC, memoryBytes: 1.5 })).toEqual({ failed: "The sandbox's limits are invalid." });
		made.container.ready = false;
		const clock = made.clock;
		const advancing = setInterval(() => (clock.now += 60_000), 50);
		try {
			expect(await made.core.start({ runId: uuid7(), attempt: 1 }, SPEC)).toEqual({ failed: "The container did not become ready." });
		} finally {
			clearInterval(advancing);
		}
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(made.container.running).toBe(false);
	});

	test("a failed hardening step destroys the container", async () => {
		const made = rig();
		made.container.failHardeningAt = "cgroup";
		const prepared = await prepareSandbox(made.core, { runId: uuid7(), attempt: 1 }, SPEC);
		expect(prepared).toEqual({ ok: false, stage: "harden", message: "The sandbox could not be hardened (cgroup)." });
		expect(made.container.running).toBe(false);
		expect(made.core.status()).toMatchObject({ state: "none", cleanupPending: false });
	});
});

describe("destroying", () => {
	test("a destroy that fails stays owed, and the alarm retries until it is done", async () => {
		const made = rig();
		const fence = await ready(made);
		// One for the destroy, one for the restart's, one for the first alarm.
		made.container.failDestroys = 3;
		expect(await made.core.destroy(fence, "turn over")).toEqual({ destroyed: false });
		expect(made.core.status()).toMatchObject({ state: "destroying", cleanupPending: true });
		expect(made.alarms.at(-1)).toBe(made.clock.now + 30_000);
		// The owed destroy survives a restart.
		await made.restart();
		expect(made.core.status()).toMatchObject({ state: "destroying", cleanupPending: true });
		await made.core.alarm();
		expect(made.core.status()).toMatchObject({ cleanupPending: true });
		await made.core.alarm();
		expect(made.core.status()).toMatchObject({ state: "none", cleanupPending: false, incarnation: null });
		expect(made.container.running).toBe(false);
		expect(made.alarms.at(-1)).toBeNull();
		expect(await command(made, fence)).toMatchObject({ refused: "stale" });
	});

	test("the alarm destroys a container past its run's deadline, unless a call is running", async () => {
		const made = rig();
		const deadline = made.clock.now + 60_000;
		const fence = await ready(made, { ...SPEC, deadline });
		expect(made.alarms.at(-1)).toBe(deadline + DEADLINE_GRACE_MS);
		made.clock.now = deadline + DEADLINE_GRACE_MS;
		let release: () => void = () => {};
		made.container.command = { stdout: "", exitCode: 0, admitted: true };
		const blocked = made.container.exec.bind(made.container);
		made.container.exec = async (argv) => {
			if ((argv[2] ?? "").includes("cgroup.procs")) await new Promise<void>((resolve) => (release = resolve));
			return blocked(argv);
		};
		const running = command(made, fence);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await made.core.alarm();
		expect(made.core.status().state).toBe("in_use");
		release();
		await running;
		made.clock.now += 10 * 60_000;
		await made.core.alarm();
		expect(made.core.status().state).toBe("none");
		expect(made.container.running).toBe(false);
	});
});

describe("restarts", () => {
	test("a running container verified before is verified again before its next use", async () => {
		const made = rig();
		const fence = await ready(made);
		await made.restart();
		expect(made.container.verifications).toBe(1);
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
		expect(made.container.verifications).toBe(2);
	});

	test("a running container in any other state is destroyed at once", async () => {
		for (const stop of ["started", "hardened"] as const) {
			const made = rig();
			const started = await made.core.start({ runId: uuid7(), attempt: 1 }, SPEC);
			if (!("incarnation" in started)) throw new Error("no start");
			if (stop === "hardened") await made.core.harden({ runId: readState(made.sql).runId as string, attempt: 1, incarnation: started.incarnation });
			await made.restart();
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		}
	});

	test("a container that stopped while the object was away is forgotten", async () => {
		const made = rig();
		const fence = await ready(made);
		made.container.running = false;
		await made.restart();
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(await command(made, fence)).toMatchObject({ refused: "stale" });
	});
});

describe("calls", () => {
	test("folder steps and commands exclude each other", async () => {
		const made = rig();
		const fence = await ready(made);
		let release: () => void = () => {};
		const original = made.container.exec.bind(made.container);
		made.container.exec = async (argv) => {
			if ((argv[2] ?? "").includes("cgroup.procs") && argv.includes("scan")) await new Promise<void>((resolve) => (release = resolve));
			return original(argv);
		};
		const scanning = made.core.scan(fence, { rehashAll: false });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await command(made, fence)).toMatchObject({ refused: "busy" });
		expect(await made.core.hydrate(fence, { versionId: null, files: [], dirs: [] })).toMatchObject({ refused: "busy" });
		release();
		await scanning;
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
	});

	test("a command the agent cgroup does not admit destroys the container", async () => {
		const made = rig();
		const fence = await ready(made);
		made.container.command = { stdout: "", exitCode: 125, admitted: false };
		expect(await command(made, fence)).toMatchObject({ ok: false, code: "spawn_error" });
		expect(made.container.running).toBe(false);
		expect(made.core.status()).toMatchObject({ state: "none" });
	});

	test("a container lost under a call ends the incarnation", async () => {
		const made = rig();
		const fence = await ready(made);
		made.container.lostOnExec = true;
		expect(await made.core.fs(fence, { op: "lstat", path: "/workspace/a" })).toEqual({ refused: "not_verified", message: "The sandbox stopped." });
		expect(made.core.status()).toMatchObject({ state: "none" });
		expect(await command(made, fence)).toMatchObject({ refused: "stale" });
	});

	test.each(["exec", "process"] as const)("a verification whose %s never answers fails, destroys the container and frees the lifecycle", async (hang) => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const runId = uuid7();
			const started = await made.core.start({ runId, attempt: 1 }, SPEC);
			if (!("incarnation" in started)) throw new Error("no start");
			const fence: SandboxFence = { runId, attempt: 1, incarnation: started.incarnation };
			expect(await made.core.harden(fence)).toMatchObject({ ok: true });
			made.container.hangVerification = hang;
			const verifying = made.core.verify(fence);
			// Queued behind the verification.
			const destroying = made.core.destroy(fence, "The run ended.");
			await vi.advanceTimersByTimeAsync(70_000);
			expect(await verifying).toMatchObject({ ok: false });
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none", incarnation: null, cleanupPending: false });
			expect(await destroying).toMatchObject({ refused: "stale" });
			made.container.hangVerification = null;
			const next = await ready(made, SPEC, 2, runId);
			expect(made.core.status()).toMatchObject({ state: "verified", incarnation: next.incarnation });
		} finally {
			vi.useRealTimers();
		}
	});

	test("a command whose exec never answers ends the incarnation", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const fence = await ready(made);
			made.container.hangCommands = true;
			const running = command(made, fence);
			await vi.advanceTimersByTimeAsync(70_000);
			expect(await running).toEqual({ refused: "not_verified", message: "The sandbox stopped." });
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("strays are killed only once every wrapped process already starting has joined the cgroup", async () => {
		const made = rig();
		const fence = await ready(made);
		const joining = Promise.withResolvers<void>();
		made.container.joining = joining.promise;
		const running = command(made, fence);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const killed = made.core.killStrays(fence);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The kill would find the cgroup empty, and the command would join it afterwards.
		expect(made.container.log).toEqual(["harden", "verify"]);
		joining.resolve();
		expect(await killed).toEqual({ ok: true });
		expect(await running).toEqual({ ok: true, exitCode: 0 });
		expect(made.container.log).toEqual(["harden", "verify", "command", "kill"]);
	});

	test("kills asked for at once run one after the other, and nothing is admitted until both are done", async () => {
		const made = rig();
		const fence = await ready(made);
		const gate = Promise.withResolvers<void>();
		made.container.killGate = gate.promise;
		const first = made.core.killStrays(fence);
		const second = made.core.killStrays(fence);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const running = command(made, fence);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(made.container.log).toEqual(["harden", "verify"]);
		gate.resolve();
		expect(await first).toEqual({ ok: true });
		expect(await second).toEqual({ ok: true });
		expect(await running).toEqual({ ok: true, exitCode: 0 });
		expect(made.container.mostKillsRunning).toBe(1);
		expect(made.container.log).toEqual(["harden", "verify", "kill", "kill", "command"]);
	});

	test("a cancel that arrives while the command starts still reaches it", async () => {
		const made = rig();
		const fence = await ready(made);
		let spawned: () => void = () => {};
		const original = made.container.exec.bind(made.container);
		let exit: (code: number) => void = () => {};
		made.container.exec = async (argv) => {
			if ((argv[2] ?? "").includes("cgroup.procs")) {
				await new Promise<void>((resolve) => (spawned = resolve));
				const running = process("\u0006", 0);
				return { ...running, exitCode: new Promise<number>((resolve) => (exit = resolve)) };
			}
			if ((argv[2] ?? "").startsWith("kill -KILL")) exit(137);
			return original(argv);
		};
		const result = command(made, fence, "early");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await made.core.cancel(fence, "early");
		spawned();
		expect(await result).toEqual({ ok: false, code: "aborted", message: "aborted" });
	});

	test("a cancel that arrives while the command waits for its admission still reaches it", async () => {
		const made = rig();
		const fence = await ready(made);
		await made.restart();
		// The restart's verification is held, so the command waits for its admission.
		let verified: () => void = () => {};
		const original = made.container.exec.bind(made.container);
		made.container.exec = async (argv) => {
			if (argv[3] === "-c" && argv[4]?.includes("mountinfo")) await new Promise<void>((resolve) => (verified = resolve));
			return original(argv);
		};
		const result = command(made, fence, "waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await made.core.cancel(fence, "waiting");
		verified();
		expect(await result).toEqual({ ok: false, code: "aborted", message: "aborted" });
		expect(made.container.log.filter((entry) => entry === "command")).toHaveLength(0);
	});

	test("work of a replaced incarnation that still runs does not hold the next one's admissions", async () => {
		const made = rig();
		const runId = uuid7();
		const first = await ready(made, SPEC, 1, runId);
		let release: () => void = () => {};
		const held = new Promise<null>((resolve) => (release = () => resolve(null)));
		const core = new SandboxCore({ ...made.ports(), bucket: () => ({ get: async () => held, put: async () => {}, check: async () => {} }) });
		await core.recover();
		const hydrating = core.hydrate(first, { versionId: null, files: [{ path: "a", sha256: "a".repeat(64), size: 1, mode: 0o644, mtime: 0, key: "k" }], dirs: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const prepared = await prepareSandbox(core, { runId, attempt: 2 }, SPEC);
		if (!prepared.ok) throw new Error(prepared.message);
		expect(await core.exec(prepared.fence, { execId: "next", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 5 }, null)).toEqual({ ok: true, exitCode: 0 });
		release();
		expect(await hydrating).toMatchObject({ ok: false });
	});

	test("a call of a replaced incarnation that fails late never touches the next container", async () => {
		const made = rig();
		const runId = uuid7();
		const first = await ready(made, SPEC, 1, runId);
		let fail: (error: Error) => void = () => {};
		const original = made.container.exec.bind(made.container);
		made.container.exec = async (argv) => {
			// The file operation's exec, held until the next incarnation exists.
			if (argv[0] === "/usr/local/bin/sandbox-shim") return new Promise<ExecProcess>((_, reject) => (fail = reject));
			return original(argv);
		};
		const late = made.core.fs(first, { op: "lstat", path: "/workspace/a" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await ready(made, SPEC, 2, runId);
		made.container.exec = original;
		fail(new Error("exec() cannot be called on a container that is not running"));
		expect(await late).toEqual({ refused: "not_verified", message: "The sandbox stopped." });
		expect(made.core.status()).toMatchObject({ state: "verified", incarnation: second.incarnation });
		expect(made.container.running).toBe(true);
		expect(await command(made, second)).toEqual({ ok: true, exitCode: 0 });
	});

	test("an exec id is used once at a time, and a cancel reaches the command by it", async () => {
		const made = rig();
		const fence = await ready(made);
		let exit: (code: number) => void = () => {};
		const original = made.container.exec.bind(made.container);
		const killed: string[] = [];
		made.container.exec = async (argv) => {
			if ((argv[2] ?? "").includes("cgroup.procs")) {
				const running = process("\u0006", 0);
				return { ...running, exitCode: new Promise<number>((resolve) => (exit = resolve)) };
			}
			if ((argv[2] ?? "").startsWith("kill -KILL")) {
				killed.push(argv[3] as string);
				exit(137);
			}
			return original(argv);
		};
		const first = command(made, fence, "same");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await command(made, fence, "same")).toEqual({ ok: false, code: "spawn_error", message: "An exec needs an id of its own." });
		await made.core.cancel({ ...fence, attempt: 2 }, "same");
		expect(killed).toEqual([]);
		await made.core.cancel(fence, "same");
		expect(await first).toEqual({ ok: false, code: "aborted", message: "aborted" });
		expect(killed).toEqual(["42"]);
	});
});
