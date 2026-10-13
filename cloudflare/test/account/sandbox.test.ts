// The sandbox on the account (plan: Testing, Account tests; The sandbox lifecycle), through the test Worker
// minerva-cf-test's sandbox lab (lab.ts), which runs production's Sandbox object with its container: one
// container, prepared once and used by each test in turn: the hardening's postconditions, pi's ExecutionEnv
// conformance suite (24 cases, one skipped) over the adapter with output through an RpcTarget, the probe
// (network over HTTP and TLS, its checks at once), commands as the bash tool runs them, strays and a fork bomb
// in the cgroup, and a folder through R2: hydration, scans, and a checkpoint of the changed files.
//
// The Sandbox's fault rows and the folder's limits are sandbox-faults.test.ts's, on sandboxes of their own,
// at the same time. With MINERVA_SBX_TIMINGS=<file> the tests also measure (two more prepares, exec and file
// operation latency, a folder of 50 MB in 500 files) and write the timings there as JSON. Run with
// `pnpm test:faults` after `pnpm run deploy:test`; it fails without the test Worker's settings.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { type Answer, destroyAll, lab, MiB, sh } from "./lab.ts";

const TIMINGS = process.env.MINERVA_SBX_TIMINGS;
const timings: Record<string, unknown> = {};

function record(name: string, value: unknown): void {
	timings[name] = value;
	if (TIMINGS) writeFileSync(TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
}

afterAll(destroyAll, 180_000);

describe("the sandbox on the account", { timeout: 600_000 }, () => {
	const main = `main-${Date.now()}`;

	test("a container starts, is hardened and passes every check of its verification", async () => {
		const runs: unknown[] = [];
		for (let i = 0; i < (TIMINGS ? 3 : 1); i++) {
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
		// A binary reader reads its path again on each call instead of holding the file open, so a rename during
		// reading gives an error or the new contents.
		const skipped = ["binary reader keeps reading the file it opened after a rename"];
		expect(answer.results.filter((entry: Answer) => !entry.ok && !skipped.includes(entry.name))).toEqual([]);
	});

	test("the probe's checks hold", async () => {
		// Another container would be at 10.0.0.2 or fd00::12; each sees itself at 10.0.0.1 (spike results).
		// Run as an argv, so its environment is the one given, not bash's additions for its children.
		const argv = ["/usr/bin/python3", "-I", "-S", "/opt/minerva/probe", "268435456", "10000", "256", "0::/agent", "10.0.0.2:8000", "[fd00::12]:8000"];
		const answer = await lab("exec", { name: main, request: { command: argv, timeoutSeconds: 290 } });
		expect(answer.result, answer.stderr).toEqual({ ok: true, exitCode: 0 });
		const report = JSON.parse(answer.stdout) as { checks: Record<string, boolean>; details: Record<string, string> };
		record("probe", { ms: answer.ms, ...report });
		const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => `${name}: ${report.details[name]}`);
		expect(failed).toEqual([]);
		expect(Object.keys(report.checks)).toHaveLength(21);
		console.info(`the probe: ${answer.ms} ms`);
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
		// The spill file mktemp makes in /tmp: created exclusively, with 10 random characters (commands.ts).
		expect(spilled.result.spillPath).toMatch(/^\/tmp\/pi-output-[A-Za-z0-9]{10}\.log$/);
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

	test("a folder through R2: hydrated, scanned, changed, and its changed files checkpointed to R2", async () => {
		// 50 files of 5 MiB in all; with MINERVA_SBX_TIMINGS, 500 of 50 MB and the latency of exec and file operations.
		if (TIMINGS) record("exec", await lab("timings", { name: main }));
		const folder = await lab("folder", { name: main, files: TIMINGS ? 500 : 50, bytes: TIMINGS ? 50 * MiB : 5 * MiB }, 590_000);
		record("folder", folder);
		const count = TIMINGS ? 500 : 50;
		expect(folder.hydrated).toEqual({ ok: true });
		expect(folder.first).toMatchObject({ files: count, dirs: ["empty"], warnings: { total: 0, items: [] } });
		expect(folder.third).toMatchObject({ files: count });
		expect(folder.stored).toEqual({ files: count });
		expect(folder.sampleChecksum).toBe(folder.sampleExpected);
		expect(folder.sampleSize).toBe(folder.each + 1);
		console.info(`a folder of ${count} files: puts ${folder.putMs} ms, hydration ${folder.hydrateMs} ms, checkpoint ${folder.checkpointMs} ms`);
	});
});
