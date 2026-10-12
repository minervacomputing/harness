// The sandbox on the account (plan: Testing, Account tests; The sandbox lifecycle), through the test
// Worker minerva-cf-test's sandbox lab (src/faults/lab.ts, `POST /api/faults/sandbox/<op>` behind the
// driver's token), which runs production's Sandbox object with its container and the fault seams of
// src/faults/sandbox.ts: the hardening's postconditions, pi's ExecutionEnv conformance suite (24 cases) over
// the adapter with output through an RpcTarget, the reworked probe (no loopback-only check; network over
// HTTP and TLS), commands as the bash tool runs them, a fork bomb in the cgroup, ENOSPC at the folder's size
// and entry limit, symlinked parents refused by the scan, FIFOs that do not hang, the fault rows of the plan
// (each hardening step failing, cgroup admission failing, a lost destroy, a restart with a container still
// running), and the timings (start, hardening, exec, and hydration and a checkpoint of 50 MB in 500 files).
//
// The lab keeps nothing: each test keeps the fence its prepare (or start) answered and sends it with each
// later operation on that sandbox. Timings are written to MINERVA_SBX_TIMINGS when it is set. Run with
// `pnpm test:faults` after `pnpm run deploy:test`; it fails without the test Worker's settings.

import { writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const MiB = 1024 * 1024;

/** The test Worker. Missing or misdirected settings fail the run (a skipped sandbox lab would look like a pass). */
function target(): { origin: string; token: string } {
	const worker = testWorker();
	return { origin: worker.origin, token: worker.secretKey };
}

const WORKER = target();
const TOKEN = await faultsToken(WORKER.token);
const timings: Record<string, unknown> = {};
/** Each sandbox's fence, from its prepare or start. */
const fences = new Map<string, unknown>();

function record(name: string, value: unknown): void {
	timings[name] = value;
	if (process.env.MINERVA_SBX_TIMINGS) writeFileSync(process.env.MINERVA_SBX_TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
}

// biome-ignore lint: free-form answers from the lab.
type Answer = any;

async function lab(op: string, body: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<Answer> {
	const name = typeof body.name === "string" ? body.name : undefined;
	const sent = name !== undefined && body.fence === undefined && fences.has(name) ? { ...body, fence: fences.get(name) } : body;
	const reply = await fetchDeployed(`${WORKER.origin}/api/faults/sandbox/${op}`, {
		method: "POST",
		headers: { "content-type": "application/json", [FAULTS_HEADER]: TOKEN },
		body: JSON.stringify(sent),
		timeoutMs,
	});
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 500)}`);
	const answer = JSON.parse(reply.text) as Answer;
	if (name !== undefined && op === "prepare" && answer.prepared?.ok) fences.set(name, answer.prepared.fence);
	if (name !== undefined && op === "start" && answer.fence) fences.set(name, answer.fence);
	return answer;
}

const sh = (name: string, command: string, extra: Record<string, unknown> = {}) => lab("exec", { name, request: { command, timeoutSeconds: 120, ...extra } });

describe("the sandbox on the account", { timeout: 600_000 }, () => {
	const main = `main-${Date.now()}`;

	test("a container starts, is hardened and passes every check of its verification", async () => {
		const runs: unknown[] = [];
		for (let i = 0; i < 3; i++) {
			const name = i === 0 ? main : `timing-${Date.now()}-${i}`;
			const answer = await lab("prepare", { name });
			expect(answer.prepared.ok, JSON.stringify(answer)).toBe(true);
			runs.push(answer.prepared.ms);
			if (i > 0) await lab("destroy", { name, reason: "timing run over" });
		}
		record("prepare", runs);
		expect((await lab("status", { name: main })).status.state).toBe("verified");
		// A second root look at what the hardening left.
		const facts = await lab("root", { name: main, script: "grep -E ' /workspace | /tmp | / ' /proc/self/mountinfo; cat /sys/fs/cgroup/agent/pids.max /sys/fs/cgroup/agent/memory.max; stat -c '%U %a' /tmp/home /tmp/matplotlib" });
		expect(facts.stdout).toMatch(/ \/workspace rw,nosuid,nodev[^ ]* .*- tmpfs tmpfs rw,size=262144k,nr_inodes=10001,mode=755,uid=1000,gid=1000/);
		expect(facts.stdout).toMatch(/ \/tmp rw,nosuid,nodev,noexec[^ ]* .*- tmpfs tmpfs rw,size=262144k/);
		expect(facts.stdout).toMatch(/ \/ ro[, ]/);
		expect(facts.stdout).toContain(`256\n${1024 * MiB + 256 * MiB + 256 * MiB}\n`);
		expect(facts.stdout).toContain("agent 755\nagent 755\n");
		record("mounts", facts.stdout);
	});

	test("pi's ExecutionEnv conformance suite passes against the container", async () => {
		const answer = await lab("conformance", { name: main }, 590_000);
		record("conformance", answer.results.map((entry: Answer) => ({ name: entry.name, ok: entry.ok, ms: entry.ms })));
		expect(answer.results).toHaveLength(24);
		expect(answer.results.filter((entry: Answer) => !entry.ok)).toEqual([]);
	});

	test("the probe's checks hold", async () => {
		// Another container would be at 10.0.0.2 or fd00::12; each sees itself at 10.0.0.1 (spike results).
		// Run as an argv, so its environment is the one given, not bash's additions for its children.
		const argv = ["/usr/bin/python3", "-I", "-S", "/opt/minerva/probe", "268435456", "10000", "256", "0::/agent", "10.0.0.2:8000", "[fd00::12]:8000"];
		const answer = await lab("exec", { name: main, request: { command: argv, timeoutSeconds: 290 } });
		expect(answer.result, answer.stderr).toEqual({ ok: true, exitCode: 0 });
		const report = JSON.parse(answer.stdout) as { checks: Record<string, boolean>; details: Record<string, string> };
		record("probe", report);
		const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => `${name}: ${report.details[name]}`);
		expect(failed).toEqual([]);
		expect(Object.keys(report.checks)).toHaveLength(20);
	});

	test("commands run as the bash tool runs them", async () => {
		const env = await sh(main, "id -u; id -G; pwd; cat /proc/self/cgroup; tr '\\0' '\\n' < /proc/$$/environ | sort; head -c 1; echo stdin-$?");
		expect(env.result).toEqual({ ok: true, exitCode: 0 });
		expect(env.stdout).toBe(
			"1000\n1000\n/workspace\n0::/agent\nHOME=/tmp/home\nLANG=C.UTF-8\nMPLCONFIGDIR=/tmp/matplotlib\nPATH=/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nTMPDIR=/tmp\nstdin-0\n",
		);
		const timedOut = await sh(main, "sleep 30 & sleep 31", { timeoutSeconds: 2 });
		expect(timedOut.result).toEqual({ ok: false, code: "timeout", message: "timeout:2" });
		expect(timedOut.ms).toBeLessThan(10_000);
		expect((await sh(main, "exit 124", { timeoutSeconds: 30 })).result).toEqual({ ok: true, exitCode: 124 });
		expect((await sh(main, "kill -9 $$")).result).toEqual({ ok: true, exitCode: 137 });
		const detached = await sh(main, "setsid bash -c 'while true; do echo x; sleep 0.01; done' & echo started");
		expect(detached.result).toEqual({ ok: true, exitCode: 0 });
		expect(detached.ms).toBeLessThan(15_000);
		expect(await lab("kill-strays", { name: main })).toEqual({ ok: true });
		const holder = await sh(main, "sleep 30 & echo done");
		expect(holder).toMatchObject({ result: { ok: true, exitCode: 0 }, stdout: "done\n" });
		expect(holder.ms).toBeLessThan(5000);
		const cancelled = await lab("cancel", { name: main, command: "sleep 600 & sleep 601 & wait", afterMs: 1000 });
		expect(cancelled.result).toEqual({ ok: false, code: "aborted", message: "aborted" });
		const spilled = await sh(main, "seq 1 30000", { spill: { afterBytes: 51200, afterLines: 2000 }, window: { maxBytes: 51200, maxLines: 2000, minIntervalMs: 250, bytesPerSecond: 102400 } });
		expect(spilled.result.ok).toBe(true);
		expect(spilled.result.spillPath).toMatch(/^\/tmp\/tmp-[A-Za-z0-9]{6}\/pi-output-[0-9a-f-]{36}\.log$/);
		expect(spilled.stdout.endsWith("29999\n30000\n")).toBe(true);
		const complete = await sh(main, `wc -l < ${spilled.result.spillPath}; tail -n 1 ${spilled.result.spillPath}`);
		expect(complete.stdout).toBe("30000\n30000\n");
		const missing = await lab("exec", { name: main, request: { command: ["no-such-program"], timeoutSeconds: 5 } });
		expect(missing.result).toEqual({ ok: false, code: "spawn_error", message: "spawn no-such-program ENOENT" });
		record("commands", { timeoutMs: timedOut.ms, detachedMs: detached.ms, holderMs: holder.ms, cancelMs: cancelled.ms, spilledChunks: spilled.chunks, spilledSkips: spilled.skipped });
	});

	test("strays die with the cgroup, setsid's included, and a fork bomb stays in its limit", async () => {
		expect(await lab("kill-strays", { name: main })).toEqual({ ok: true });
		await sh(main, "setsid sleep 600 > /dev/null 2>&1 & nohup sleep 601 > /dev/null 2>&1 & (sleep 602 &); echo started");
		expect((await lab("root", { name: main, script: "pgrep -u 1000 -c -x sleep" })).stdout.trim()).toBe("3");
		expect(await lab("kill-strays", { name: main })).toEqual({ ok: true });
		expect((await lab("root", { name: main, script: "cat /sys/fs/cgroup/agent/cgroup.procs | wc -l; pgrep -u 1000 -c . || true" })).stdout).toBe("0\n0\n");
		await sh(main, "b() { b | b & }; b; sleep 3", { timeoutSeconds: 10 });
		const peak = await lab("root", { name: main, script: "cat /sys/fs/cgroup/agent/pids.peak 2>/dev/null || cat /sys/fs/cgroup/agent/pids.current; cat /sys/fs/cgroup/agent/pids.events" });
		record("forkBomb", peak.stdout);
		expect(Number(peak.stdout.split("\n")[0])).toBeLessThanOrEqual(256);
		expect(peak.stdout).toMatch(/max [1-9]/);
		expect(await lab("kill-strays", { name: main })).toEqual({ ok: true });
		expect((await sh(main, "echo alive")).stdout).toBe("alive\n");
	});

	test("the folder fills with ENOSPC at its size and entry limit, and the scan refuses symlinked parents", async () => {
		const small = `small-${Date.now()}`;
		expect((await lab("prepare", { name: small, folderBytes: 8 * MiB, folderEntries: 100 })).prepared.ok).toBe(true);
		const big = await lab("write", { name: small, path: "big.bin", bytes: 9 * MiB });
		expect(big).toMatchObject({ ok: false, code: "unknown", message: expect.stringMatching(/^ENOSPC: no space left on device, write/) });
		const fill = await sh(small, "rm -f big.bin; head -c 20000000 /dev/zero > fill 2>/dev/null; echo $?; stat -c %s fill; rm fill");
		const [status, size] = fill.stdout.trim().split("\n");
		expect(status).not.toBe("0");
		expect(Number(size)).toBeGreaterThan(8 * MiB - 64 * 1024);
		expect(Number(size)).toBeLessThanOrEqual(8 * MiB);
		const entries = await sh(small, "mkdir many; for i in $(seq 1 150); do touch many/$i 2>/dev/null || break; done; ls many | wc -l; rm -rf many");
		expect(Number(entries.stdout.trim())).toBe(99);
		await sh(small, "mkdir real; echo inside > real/f; ln -s real linked; ln -s /etc etc; mkfifo pipe");
		const scanned = await lab("scan", { name: small });
		expect(scanned.ok).toBe(true);
		expect(scanned.warnings).toEqual({ total: 3, items: [{ path: "etc", reason: "symlink" }, { path: "linked", reason: "symlink" }, { path: "pipe", reason: "special" }] });
		expect(await lab("pull", { name: small, files: [{ path: "linked/f", sha256: "0".repeat(64), size: 7, key: `lab/${small}/never` }] })).toMatchObject({ ok: false, reason: "changed" });
		const fifo = await lab("fs", { name: small, path: "/workspace/pipe" });
		expect(fifo.codes).toEqual({ readText: "invalid", write: "invalid", open: "invalid", exists: "invalid" });
		expect(fifo.ms).toBeLessThan(10_000);
		await lab("destroy", { name: small });
	});

	test("timings: exec, file operations, and a folder of 50 MB in 500 files", async () => {
		const exec = await lab("timings", { name: main });
		record("exec", exec);
		const folder = await lab("folder", { name: main, files: 500, bytes: 50 * MiB }, 590_000);
		record("folder", folder);
		expect(folder.hydrated).toEqual({ ok: true });
		expect(folder.first).toMatchObject({ files: 500, dirs: ["empty"], warnings: { total: 0, items: [] } });
		expect(folder.third).toMatchObject({ files: 500 });
		expect(folder.stored).toEqual({ files: 500 });
		expect(folder.sampleChecksum).toBe(folder.sampleExpected);
		expect(folder.sampleSize).toBe(folder.each + 1);
		await lab("destroy", { name: main, reason: "tests over" });
	});
});

describe("the Sandbox's fault rows on the account", { timeout: 600_000 }, () => {
	for (const step of ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"]) {
		test(`a hardening that fails at ${step} destroys the container`, async () => {
			const name = `harden-${step}-${Date.now()}`;
			await lab("faults", { name, faults: { failHardeningAt: step } });
			const answer = await lab("prepare", { name });
			expect(answer.prepared).toEqual({ ok: false, stage: "harden", message: `The sandbox could not be hardened (${step}).` });
			expect(answer.status).toMatchObject({ state: "none", incarnation: null, cleanupPending: false });
			expect((await lab("status", { name })).running).toBe(false);
		});
	}

	test("a command the cgroup does not admit destroys the container", async () => {
		const name = `admission-${Date.now()}`;
		expect((await lab("prepare", { name })).prepared.ok).toBe(true);
		expect((await lab("root", { name, script: "rmdir /sys/fs/cgroup/agent && echo removed" })).stdout).toBe("removed\n");
		const answer = await sh(name, "echo never");
		expect(answer.result).toMatchObject({ ok: false, code: "spawn_error", message: expect.stringMatching(/could not admit/) });
		expect(answer.stdout).toBe("");
		const status = await lab("status", { name });
		expect(status).toMatchObject({ status: { state: "none", incarnation: null }, running: false });
		expect((await sh(name, "echo late")).result).toMatchObject({ refused: "stale" });
	});

	test("a lost destroy stays owed until the alarm finishes it", async () => {
		const name = `destroy-${Date.now()}`;
		expect((await lab("prepare", { name })).prepared.ok).toBe(true);
		await lab("faults", { name, faults: { failDestroys: 1 } });
		expect(await lab("destroy", { name })).toEqual({ destroyed: false });
		expect(await lab("status", { name })).toMatchObject({ status: { state: "destroying", cleanupPending: true }, running: true });
		const started = Date.now();
		let status: Answer;
		do {
			await new Promise((resolve) => setTimeout(resolve, 5000));
			status = await lab("status", { name });
		} while (status.status.cleanupPending && Date.now() - started < 120_000);
		record("ownedDestroyMs", Date.now() - started);
		expect(status).toMatchObject({ status: { state: "none", cleanupPending: false }, running: false });
	});

	test("a restart verifies a running verified container again, and destroys one it had not verified", async () => {
		const name = `restart-${Date.now()}`;
		expect((await lab("prepare", { name })).prepared.ok).toBe(true);
		await sh(name, "echo kept > kept.txt");
		const aborted = await lab("abort", { name });
		expect(aborted.aborted).not.toBeNull();
		const after = await sh(name, "cat kept.txt");
		expect(after).toMatchObject({ result: { ok: true, exitCode: 0 }, stdout: "kept\n" });
		// A command in flight loses its call with the object's restart; its process is a stray until killed.
		const lost = await lab("lost", { name });
		expect(lost.call.error).toBeDefined();
		expect((await lab("root", { name, script: "pgrep -u 1000 -c -x sleep" })).stdout.trim()).toBe("1");
		expect(await lab("kill-strays", { name })).toEqual({ ok: true });
		expect((await lab("root", { name, script: "pgrep -u 1000 -c -x sleep || true" })).stdout.trim()).toBe("0");
		await lab("destroy", { name });

		const unverified = `restart-unverified-${Date.now()}`;
		const started = await lab("start", { name: unverified });
		expect(started).toMatchObject({ status: { state: "starting" }, running: true });
		await lab("abort", { name: unverified });
		expect(await lab("status", { name: unverified })).toMatchObject({ status: { state: "none", incarnation: null }, running: false });
		expect(await lab("harden", { name: unverified })).toMatchObject({ refused: "stale" });
	});
});
