// The Sandbox's lifecycle (src/sandbox/core.ts) over a scripted container and node:sqlite, without Docker:
// the states and what each admits, fences, a failed start, hardening and destroy, the alarm's retries and
// leases, a restart in each state, an admission failure and a container lost under a call, each
// incarnation's span and a run's seal, and parking a container for the conversation's next run. The same
// paths against the real image are in sandbox-local.test.ts.

import { describe, expect, test, vi } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { migrate, type Sql, sqliteSql } from "../../src/lib/sql.ts";
import { DEADLINE_GRACE_MS, IDLE_MS, PARKED_MS, sandboxSpec, type SandboxSpec, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import { PARK_LINKED } from "../../src/sandbox/hardening.ts";
import type { ContainerPort, SandboxPorts } from "../../src/sandbox/ports.ts";
import { prepareSandbox } from "../../src/sandbox/session.ts";
import { containerCharge, readSpans, readState, SANDBOX_MIGRATIONS, type SealedSpans } from "../../src/sandbox/store.ts";
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

/** A process that never exits and never ends its output after `stdout`, killed or not, until `ended` is called. */
function hung(stdout: string, ended: (end: () => void) => void): ExecProcess {
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const output = (text: string) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				if (text) controller.enqueue(new TextEncoder().encode(text));
				streams.push(controller);
			},
		});
	const exitCode = new Promise<number>((_, reject) => {
		ended(() => {
			for (const stream of streams) stream.error(new Error("The container was destroyed."));
			reject(new Error("The container was destroyed."));
		});
	});
	return { ...process("", 0), stdout: output(stdout), stderr: output(""), exitCode };
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
	/** How many hardening execs from now never answer. */
	hangHardenings = 0;
	/** What a wrapped command answers: its stdout (after the wrapper's byte) and exit, or a failed admission. */
	command: { stdout: string; exitCode: number; admitted: boolean } = { stdout: "", exitCode: 0, admitted: true };
	lostOnExec = false;
	/** A verification whose exec never answers, or whose process never ends. */
	hangVerification: "exec" | "process" | null = null;
	/** A wrapped command whose exec never answers, or whose process never ends. */
	hangCommands: "exec" | "process" | null = null;
	/** Root kills of a process group whose exec never answers. */
	hangKills = false;
	hangDestroys = false;
	hangKeepAlive = false;
	/** The park exec's exit status. */
	parkExit = 0;
	/** A verification whose report says nothing it can read. */
	failVerification = false;
	readonly destroyReasons: string[] = [];
	/** Ends the hung processes, as a destroy does. */
	#hung: (() => void)[] = [];
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
			if (this.hangHardenings > 0) {
				this.hangHardenings--;
				return await new Promise<never>(() => {});
			}
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
			if (this.hangVerification === "process") return hung("", (end) => this.#hung.push(end));
			return process(this.failVerification ? "{}" : facts(this.#spec ?? SPEC), 0);
		}
		if (script.includes("-links +1")) {
			this.log.push("park");
			return process("", this.parkExit);
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
			if (this.hangCommands === "exec") return await new Promise<never>(() => {});
			if (this.hangCommands === "process") return hung("\u0006", (end) => this.#hung.push(end));
			this.log.push("command");
			if (!this.command.admitted) return process("", 125);
			return process(`\u0006${this.command.stdout}`, this.command.exitCode);
		}
		if (this.hangKills && script.includes("kill -KILL")) return await new Promise<never>(() => {});
		this.log.push(`root ${argv[0]}`);
		return process("", 0);
	}

	async destroy(reason?: string): Promise<void> {
		this.log.push("destroy");
		this.destroyReasons.push(reason ?? "");
		if (this.hangDestroys) return await new Promise<never>(() => {});
		if (this.failDestroys > 0) {
			this.failDestroys--;
			throw new Error("internal error");
		}
		this.running = false;
		for (const end of this.#hung.splice(0)) end();
	}

	async setInactivityTimeout(): Promise<void> {
		if (this.hangKeepAlive) await new Promise<never>(() => {});
	}
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

/**
 * `promise` once it settles, fake time advancing a second at a time meanwhile: a call sets each timer only
 * once the step before it is done.
 */
async function outwait<T>(promise: Promise<T>): Promise<T> {
	let settled = false;
	promise.then(
		() => (settled = true),
		() => (settled = true),
	);
	for (let second = 0; !settled && second < 3600; second++) await vi.advanceTimersByTimeAsync(1000);
	return await promise;
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

	test("a container that stops answering its hardening is replaced once, then the start fails", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			made.container.hangHardenings = 1;
			const replaced = await outwait(prepareSandbox(made.core, { runId: uuid7(), attempt: 1 }, SPEC));
			expect(replaced).toMatchObject({ ok: true });
			expect(made.container.starts).toBe(2);
			expect(made.container.log).toEqual(["harden", "destroy", "harden", "verify"]);
			expect(made.core.status()).toMatchObject({ state: "verified" });

			made.container.hangHardenings = 2;
			const given = await outwait(prepareSandbox(made.core, { runId: uuid7(), attempt: 1 }, SPEC));
			expect(given).toEqual({ ok: false, stage: "start", message: "The container did not answer its hardening." });
			expect(made.container.starts).toBe(4);
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none", cleanupPending: false });
		} finally {
			vi.useRealTimers();
		}
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
			expect(await outwait(verifying)).toEqual({ lost: "The container did not answer its verification." });
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
			made.container.hangCommands = "exec";
			expect(await outwait(command(made, fence))).toEqual({ refused: "not_verified", message: "The sandbox stopped." });
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("a kill of a command's processes that the container never runs ends the incarnation", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const fence = await ready(made);
			made.container.hangCommands = "process";
			made.container.hangKills = true;
			const execId = uuid7();
			const running = command(made, fence, execId);
			await vi.advanceTimersByTimeAsync(10);
			await made.core.cancel(fence, execId);
			expect(await outwait(running)).toMatchObject({ ok: false, code: "aborted" });
			expect(made.container.running).toBe(false);
			expect(made.core.status()).toMatchObject({ state: "none" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("a destroy that never answers stays owed and frees the lifecycle; a keep-alive that never answers delays nothing", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const runId = uuid7();
			made.container.hangKeepAlive = true;
			const fence = await outwait(ready(made, SPEC, 1, runId));
			made.container.hangDestroys = true;
			expect(await outwait(made.core.destroy(fence, "The run ended."))).toEqual({ destroyed: false });
			expect(made.core.status()).toMatchObject({ state: "destroying", cleanupPending: true });
			// The alarm retries it, and a start waits for nothing.
			made.container.hangDestroys = false;
			made.container.hangKeepAlive = false;
			await made.core.alarm();
			expect(made.core.status()).toMatchObject({ state: "none", cleanupPending: false });
			await ready(made, SPEC, 2, runId);
			expect(made.core.status().state).toBe("verified");
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

describe("spans and seals", () => {
	const T0 = 1_800_000_000_000;
	const MINUTE = 60_000;

	test("a span opens at the start, follows the lease, and closes destroyed when the destroy answers", async () => {
		const made = rig();
		const fence = await ready(made);
		made.clock.now += 10 * MINUTE;
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
		made.clock.now += MINUTE;
		expect(await made.core.destroy(fence, "turn over")).toEqual({ destroyed: true });
		expect(readSpans(made.sql, fence.runId)).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + 10 * MINUTE + IDLE_MS, endedAt: T0 + 11 * MINUTE, ended: "destroyed" }] });
	});

	test("a destroy that fails keeps the span open until the alarm's destroy answers", async () => {
		const made = rig();
		const fence = await ready(made);
		made.container.failDestroys = 1;
		made.clock.now += MINUTE;
		expect(await made.core.destroy(fence, "turn over")).toEqual({ destroyed: false });
		expect(readSpans(made.sql, fence.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: null, ended: null }]);
		made.clock.now += MINUTE;
		await made.core.alarm();
		expect(readSpans(made.sql, fence.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + 2 * MINUTE, ended: "destroyed" }]);
	});

	test("a container found stopped ends its span as gone, when the object noticed", async () => {
		const failedDestroy = rig();
		const destroyed = await ready(failedDestroy);
		failedDestroy.container.failDestroys = 1;
		failedDestroy.container.running = false;
		failedDestroy.clock.now += MINUTE;
		expect(await failedDestroy.core.destroy(destroyed, "turn over")).toEqual({ destroyed: true });

		const restarted = rig();
		const recovered = await ready(restarted);
		restarted.container.running = false;
		restarted.clock.now += MINUTE;
		await restarted.restart();

		const unusable = rig();
		const used = await ready(unusable);
		unusable.container.running = false;
		unusable.clock.now += MINUTE;
		expect(await unusable.core.fs(used, { op: "lstat", path: "/workspace/a" })).toEqual({ refused: "not_verified", message: "The sandbox stopped." });

		for (const [made, fence] of [[failedDestroy, destroyed], [restarted, recovered], [unusable, used]] as const) {
			expect(readSpans(made.sql, fence.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "gone" }]);
		}
	});

	test("a start that replaces another run's container closes that run's span and opens its own", async () => {
		const made = rig();
		const first = await ready(made);
		made.clock.now += MINUTE;
		const second = await ready(made);
		expect(readSpans(made.sql, first.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "destroyed" }]);
		expect(readSpans(made.sql, second.runId).spans).toEqual([{ startedAt: T0 + MINUTE, leaseUntil: T0 + MINUTE + IDLE_MS, endedAt: null, ended: null }]);
	});

	test("a seal destroys the run's container, refuses its later starts, and answers the same spans again", async () => {
		const made = rig();
		const fence = await ready(made);
		made.clock.now += MINUTE;
		const sealed = { since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "destroyed" }] };
		expect(await made.core.seal(fence.runId)).toEqual(sealed);
		expect(made.container.running).toBe(false);
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(await made.core.start({ runId: fence.runId, attempt: 2 }, SPEC)).toEqual({ refused: "stale", message: "This run has ended." });
		expect(made.container.starts).toBe(1);
		made.clock.now += MINUTE;
		expect(await made.core.seal(fence.runId)).toEqual(sealed);
		await made.restart();
		expect(await made.core.start({ runId: fence.runId, attempt: 3 }, SPEC)).toEqual({ refused: "stale", message: "This run has ended." });
		// Sealing it again, once another run has the container, leaves that container alone.
		const next = await ready(made);
		expect(await made.core.seal(fence.runId)).toEqual(sealed);
		expect(made.core.status()).toMatchObject({ state: "verified", incarnation: next.incarnation });
		expect(made.container.running).toBe(true);
	});

	test("a seal whose destroy fails answers the span open, leaves the owed destroy to the alarm, and closes it once that answers", async () => {
		const made = rig();
		const fence = await ready(made);
		made.container.failDestroys = 1;
		expect(await made.core.seal(fence.runId)).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: null, ended: null }] });
		// A seal while the destroy is owed answers at once and leaves it to the alarm.
		made.container.hangDestroys = true;
		expect(await made.core.seal(fence.runId)).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: null, ended: null }] });
		expect(made.container.log.filter((entry) => entry === "destroy")).toHaveLength(1);
		made.container.hangDestroys = false;
		made.clock.now += MINUTE;
		await made.core.alarm();
		expect(await made.core.seal(fence.runId)).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "destroyed" }] });
	});

	test("a seal waits for a start in flight, then destroys what it started; a start queued behind it starts nothing", async () => {
		const made = rig();
		const runId = uuid7();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const original = made.container.exec.bind(made.container);
		made.container.exec = async (argv) => {
			if (argv[0] === "/bin/true") await held;
			return original(argv);
		};
		const starting = made.core.start({ runId, attempt: 1 }, SPEC);
		const sealing = made.core.seal(runId);
		const retrying = made.core.start({ runId, attempt: 2 }, SPEC);
		await new Promise((resolve) => setTimeout(resolve, 10));
		made.clock.now += MINUTE;
		release();
		const started = await starting;
		if (!("incarnation" in started)) throw new Error("no start");
		expect(await sealing).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "destroyed" }] });
		expect(await retrying).toEqual({ refused: "stale", message: "This run has ended." });
		expect(made.container.starts).toBe(1);
		expect(made.container.running).toBe(false);
		expect(await made.core.harden({ runId, attempt: 1, incarnation: started.incarnation })).toMatchObject({ refused: "stale" });
	});

	test("a run sealed between a start that did not come up and its retry gets no second container", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const runId = uuid7();
			made.container.hangHardenings = 1;
			let starts = 0;
			let sealed: unknown = null;
			const sealing = {

				start: async (fence: { runId: string; attempt: number }, spec: SandboxSpec) => {
					if (++starts === 2) sealed = await made.core.seal(runId);
					return made.core.start(fence, spec);
				},
				harden: (fence: SandboxFence) => made.core.harden(fence),
				verify: (fence: SandboxFence) => made.core.verify(fence),
				destroy: (fence: SandboxFence, reason: string) => made.core.destroy(fence, reason),
			};
			expect(await outwait(prepareSandbox(sealing, { runId, attempt: 1 }, SPEC))).toEqual({ ok: false, stage: "start", message: "This run has ended." });
			expect(made.container.starts).toBe(1);
			expect(sealed).toEqual({ since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0, ended: "destroyed" }] });
		} finally {
			vi.useRealTimers();
		}
	});

	test("an object that kept its state before spans keeps them since its last write then; a new one since always", async () => {
		const made = rig();
		expect(readSpans(made.sql, uuid7())).toEqual({ since: 0, spans: [] });

		// An older version's container, running when the object takes the new code: it has no span.
		const sql = sqliteSql(openDatabase());
		migrate(sql, SANDBOX_MIGRATIONS.slice(0, 1), 0);
		const legacy = uuid7(T0 - MINUTE);
		sql.exec(
			"INSERT INTO sandbox_state (id, state, incarnation, run_id, attempt, hardened, started_at, lease_until, updated_at) VALUES (1, 'in_use', 'old', ?, 1, 1, ?, ?, ?)",
			legacy,
			T0 - MINUTE,
			T0 + IDLE_MS,
			T0,
		);
		migrate(sql, SANDBOX_MIGRATIONS, T0 + MINUTE);
		made.container.running = false;
		const core = new SandboxCore({ ...made.ports(), sql });
		await core.recover();
		const sealed = await core.seal(legacy);
		expect(sealed).toEqual({ since: T0, spans: [] });
		expect(containerCharge(sealed, T0 - MINUTE)).toEqual({ containers: 0, containerMs: 0, containerEstimated: true });
		expect(containerCharge(sealed, T0 + 1)).toEqual({ containers: 0, containerMs: 0, containerEstimated: false });
	});

	test("step 3 keeps the row and spans the previous version wrote, and a container can park on the result", async () => {
		const sql = sqliteSql(openDatabase());
		migrate(sql, SANDBOX_MIGRATIONS.slice(0, 2), 0);
		const earlier = uuid7(T0 - MINUTE);
		sql.exec("INSERT INTO sandbox_state (id, state, incarnation, run_id, attempt, hardened, started_at, lease_until, updated_at) VALUES (1, 'destroying', 'old', ?, 1, 1, ?, ?, ?)", earlier, T0 - MINUTE, T0 + IDLE_MS, T0);
		sql.exec("INSERT INTO container_spans (incarnation, run_id, attempt, started_at, lease_until) VALUES ('old', ?, 1, ?, ?)", earlier, T0 - MINUTE, T0 + IDLE_MS);
		migrate(sql, SANDBOX_MIGRATIONS, T0);
		expect(readState(sql)).toMatchObject({ state: "destroying", incarnation: "old", runId: earlier, hardening: null, parkedVersion: null });
		expect(readSpans(sql, earlier)).toEqual({ since: 0, spans: [{ startedAt: T0 - MINUTE, leaseUntil: T0 + IDLE_MS, endedAt: null, ended: null }] });

		const made = rig();
		const core = new SandboxCore({ ...made.ports(), sql });
		const prepared = await prepareSandbox(core, { runId: uuid7(), attempt: 1 }, SPEC);
		if (!prepared.ok) throw new Error(prepared.message);
		expect(await core.park(prepared.fence, null)).toEqual({ parked: true });
		expect(readState(sql)).toMatchObject({ state: "parked", parkedVersion: null, hardening: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(readSpans(sql, earlier).spans).toEqual([{ startedAt: T0 - MINUTE, leaseUntil: T0 + IDLE_MS, endedAt: T0, ended: "destroyed" }]);
		expect(readSpans(sql, prepared.fence.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0, ended: "parked" }]);
	});
});

describe("parking", () => {
	const T0 = 1_800_000_000_000;
	const MINUTE = 60_000;
	const V1 = "0199b000-0000-7000-8000-0000000000a1";

	/** A run's container used once and parked with `version`. */
	async function parked(made: Rig, version: string | null = V1): Promise<SandboxFence> {
		const fence = await ready(made);
		expect(await command(made, fence)).toEqual({ ok: true, exitCode: 0 });
		expect(await made.core.park(fence, version)).toEqual({ parked: true });
		return fence;
	}

	/** What `find` would list of the folder: each entry's flag (`r` readable, `u` not), type, mode and path. */
	const listing = (...entries: [flag: string, type: string, mode: string, path: string][]) =>
		`1800000000000000000\n${entries.map(([flag, type, mode, path]) => [flag, type, "1", "1700000000.0", "1700000000.0", "12", "34", mode, `${WORKSPACE}/${path}`, ""].join("\0")).join("")}`;

	test("a parked container admits nothing, and the next run acquires it without a start", async () => {
		const made = rig();
		const first = await parked(made);
		expect(made.core.status()).toMatchObject({ state: "parked", incarnation: first.incarnation, runId: first.runId });
		expect(made.alarms.at(-1)).toBe(T0 + PARKED_MS);
		expect(await command(made, first)).toEqual({ refused: "not_verified", message: "The sandbox is not ready." });

		const next = { runId: uuid7(), attempt: 1 };
		const acquired = await made.core.acquire(next, SPEC, V1);
		if (!("incarnation" in acquired)) throw new Error(JSON.stringify(acquired));
		expect(acquired).toEqual({ incarnation: expect.any(String), verifyMs: 0 });
		expect(acquired.incarnation).not.toBe(first.incarnation);
		expect(made.core.status()).toMatchObject({ state: "verified", incarnation: acquired.incarnation, runId: next.runId, attempt: 1 });
		expect(await command(made, { ...next, incarnation: acquired.incarnation })).toEqual({ ok: true, exitCode: 0 });
		expect(made.container.starts).toBe(1);
		expect(made.container.log).toEqual(["harden", "verify", "command", "park", "verify", "command"]);
		// The new run's lease, not the parked one's.
		expect(made.alarms.at(-1)).toBe(T0 + IDLE_MS);
	});

	test("park is refused for another fence, answers the same again for its own, and destroys instead while a command runs", async () => {
		vi.useFakeTimers();
		try {
			const made = rig();
			const fence = await ready(made);
			expect(await made.core.park({ ...fence, attempt: 2 }, V1)).toMatchObject({ refused: "stale" });
			expect(await made.core.park({ ...fence, incarnation: uuid7() }, V1)).toMatchObject({ refused: "stale" });
			expect(await made.core.park(fence, V1)).toEqual({ parked: true });
			expect(await made.core.park(fence, V1)).toEqual({ parked: true });
			expect(made.container.log.filter((entry) => entry === "park")).toHaveLength(1);

			const busy = rig();
			const running = await ready(busy);
			busy.container.hangCommands = "process";
			const held = command(busy, running);
			await vi.advanceTimersByTimeAsync(10);
			expect(await busy.core.park(running, V1)).toEqual({ parked: false });
			expect(busy.container.destroyReasons).toEqual(["Work of the run was still running when it parked its sandbox."]);
			expect(busy.container.running).toBe(false);
			expect(busy.core.status()).toMatchObject({ state: "none", incarnation: null });
			await outwait(held);
		} finally {
			vi.useRealTimers();
		}
	});

	test("park destroys instead when the last scan left out more than links and special files, or a file has two links", async () => {
		const linked = rig();
		const links = await ready(linked);
		linked.container.command = { stdout: listing(["r", "l", "777", "link"], ["r", "p", "644", "pipe"]), exitCode: 0, admitted: true };
		expect(await linked.core.scan(links, { rehashAll: true })).toMatchObject({ ok: true, warnings: { total: 2 } });
		expect(await linked.core.park(links, V1)).toEqual({ parked: true });

		const hidden = rig();
		const unreadable = await ready(hidden);
		hidden.container.command = { stdout: listing(["r", "l", "777", "link"], ["u", "d", "700", "secret"]), exitCode: 0, admitted: true };
		expect(await hidden.core.scan(unreadable, { rehashAll: true })).toMatchObject({ ok: true, warnings: { total: 2 } });
		expect(await hidden.core.park(unreadable, V1)).toEqual({ parked: false });
		expect(hidden.container.destroyReasons).toEqual(["The folder's last scan left out entries a parked folder cannot keep."]);
		expect(hidden.container.log).not.toContain("park");

		const hard = rig();
		const twice = await ready(hard);
		hard.container.parkExit = PARK_LINKED;
		expect(await hard.core.park(twice, V1)).toEqual({ parked: false });
		expect(hard.container.destroyReasons).toEqual(["A file in the folder has more than one link."]);
		expect(hard.core.status()).toMatchObject({ state: "none" });
	});

	test("acquire destroys a parked container of another version, hardened differently or failing its verification, and forgets a stopped one", async () => {
		const cases: { name: string; change(made: Rig): void; spec?: SandboxSpec; version?: string; reason: string }[] = [
			{ name: "version", change: () => {}, version: "0199b000-0000-7000-8000-0000000000a2", reason: "The parked folder is not the version the run starts from." },
			{ name: "hardening", change: () => {}, spec: { ...SPEC, folderEntries: 60 }, reason: "The parked container was hardened differently from what the run asks." },
			{ name: "verification", change: (made) => (made.container.failVerification = true), reason: "The parked container failed its verification." },
		];
		for (const entry of cases) {
			const made = rig();
			await parked(made);
			entry.change(made);
			expect(await made.core.acquire({ runId: uuid7(), attempt: 1 }, entry.spec ?? SPEC, entry.version ?? V1), entry.name).toEqual({ acquired: false, reason: entry.reason });
			expect(made.container.destroyReasons, entry.name).toEqual([entry.reason]);
			expect(made.container.running, entry.name).toBe(false);
			expect(made.core.status(), entry.name).toMatchObject({ state: "none", incarnation: null });
		}

		const stopped = rig();
		await parked(stopped);
		stopped.container.running = false;
		expect(await stopped.core.acquire({ runId: uuid7(), attempt: 1 }, SPEC, V1)).toEqual({ acquired: false, reason: "The parked container stopped." });
		expect(stopped.container.destroyReasons).toEqual([]);
		expect(stopped.core.status()).toMatchObject({ state: "none", incarnation: null });

		const empty = rig();
		expect(await empty.core.acquire({ runId: uuid7(), attempt: 1 }, SPEC, null)).toEqual({ acquired: false, reason: "Nothing is parked." });
	});

	test("the alarm destroys a container parked for PARKED_MS", async () => {
		const made = rig();
		await parked(made);
		made.clock.now += PARKED_MS - 1;
		await made.core.alarm();
		expect(made.core.status().state).toBe("parked");
		made.clock.now += 1;
		await made.core.alarm();
		expect(made.container.destroyReasons).toEqual(["The parked sandbox was not used for 5 minutes."]);
		expect(made.core.status()).toMatchObject({ state: "none", incarnation: null });
		expect(made.alarms.at(-1)).toBeNull();
	});

	test("the parking run's late calls are refused while parked, and stale once the next run acquired the container", async () => {
		const made = rig();
		const first = await parked(made);
		const checkpoint = () => made.core.checkpoint(first, { files: [] });
		const fs = () => made.core.fs(first, { op: "lstat", path: `${WORKSPACE}/a` });
		for (const late of [() => command(made, first), fs, checkpoint, () => made.core.killStrays(first)]) {
			expect(await late()).toEqual({ refused: "not_verified", message: "The sandbox is not ready." });
		}
		const next = await made.core.acquire({ runId: uuid7(), attempt: 1 }, SPEC, V1);
		expect(next).toMatchObject({ incarnation: expect.any(String) });
		for (const late of [() => command(made, first), fs, checkpoint, () => made.core.park(first, V1), () => made.core.destroy(first, "late")]) {
			expect(await late()).toMatchObject({ refused: "stale" });
		}
		expect(made.container.running).toBe(true);
		expect(made.container.log).toEqual(["harden", "verify", "command", "park", "verify"]);
	});

	test("a seal of the parking run leaves the container, before and after the next run acquired it, and its spans charge neither run for the parked time", async () => {
		const made = rig();
		const first = await ready(made);
		made.clock.now += MINUTE;
		expect(await made.core.park(first, V1)).toEqual({ parked: true });
		const firstSpans = { since: 0, spans: [{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0 + MINUTE, ended: "parked" }] };
		expect(await made.core.seal(first.runId)).toEqual(firstSpans);
		expect(made.core.status()).toMatchObject({ state: "parked", incarnation: first.incarnation });
		expect(made.container.running).toBe(true);

		made.clock.now += 2 * MINUTE;
		const second = { runId: uuid7(), attempt: 1 };
		const acquired = await made.core.acquire(second, SPEC, V1);
		if (!("incarnation" in acquired)) throw new Error(JSON.stringify(acquired));
		expect(await made.core.seal(first.runId)).toEqual(firstSpans);
		expect(made.core.status()).toMatchObject({ state: "verified", incarnation: acquired.incarnation, runId: second.runId });
		expect(made.container.running).toBe(true);
		// A start for the sealed run is still refused, and acquires nothing either.
		expect(await made.core.acquire({ runId: first.runId, attempt: 2 }, SPEC, V1)).toEqual({ refused: "stale", message: "This run has ended." });

		made.clock.now += MINUTE;
		const secondSpans = await made.core.seal(second.runId);
		expect(secondSpans).toEqual({ since: 0, spans: [{ startedAt: T0 + 3 * MINUTE, leaseUntil: T0 + 3 * MINUTE + IDLE_MS, endedAt: T0 + 4 * MINUTE, ended: "destroyed" }] });
		expect(made.container.running).toBe(false);
		expect(containerCharge(firstSpans as SealedSpans, T0)).toEqual({ containers: 1, containerMs: MINUTE, containerEstimated: false });
		expect(containerCharge(secondSpans, T0 + 3 * MINUTE)).toEqual({ containers: 1, containerMs: MINUTE, containerEstimated: false });
	});

	test("a restart keeps a running parked container, acquired and verified again later, and forgets a stopped one", async () => {
		const made = rig();
		const first = await parked(made);
		await made.restart();
		expect(made.core.status()).toMatchObject({ state: "parked", incarnation: first.incarnation });
		expect(made.container.running).toBe(true);
		expect(made.container.verifications).toBe(1);
		const acquired = await made.core.acquire({ runId: uuid7(), attempt: 1 }, SPEC, V1);
		expect(acquired).toMatchObject({ incarnation: expect.any(String) });
		expect(made.container.verifications).toBe(2);

		const stopped = rig();
		const gone = await parked(stopped);
		stopped.container.running = false;
		stopped.clock.now += MINUTE;
		await stopped.restart();
		expect(stopped.core.status()).toMatchObject({ state: "none", incarnation: null });
		// The run's span ended when it parked, not when the object noticed the container gone.
		expect(readSpans(stopped.sql, gone.runId).spans).toEqual([{ startedAt: T0, leaseUntil: T0 + IDLE_MS, endedAt: T0, ended: "parked" }]);
	});

	test("a container whose object restarted while it ran is destroyed rather than parked: the last scan's warnings went with the restart", async () => {
		const made = rig();
		const fence = await ready(made);
		await made.restart();
		expect(await made.core.park(fence, V1)).toEqual({ parked: false });
		expect(made.container.destroyReasons).toEqual(["The folder's last scan left out entries a parked folder cannot keep."]);
	});
});
