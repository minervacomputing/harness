// The Sandbox's fault rows and the folder's limits on the account, through the test Worker minerva-cf-test's
// sandbox lab (lab.ts) with production's Sandbox object, its container and the fault seams of
// src/faults/sandbox.ts. Each test has a sandbox of its own, and they all run at once, alongside
// sandbox.test.ts:
//
// - ENOSPC at the folder's size and entry limit, symlinked parents refused by the scan, and FIFOs that do not
//   hang past the file operations' limit;
// - a hardening that fails, early (`workspace`) and after the root is read-only (`readonly_root`), destroys
//   the container (every step's row is in test/docker/sandbox-local.test.ts);
// - a command the cgroup does not admit destroys the container;
// - a lost destroy stays owed until the alarm finishes it;
// - a restart verifies a running verified container again, and destroys one it had not verified.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`; it fails without the test Worker's settings.

import { afterAll, describe, expect, test } from "vitest";
import { type Answer, destroyAll, lab, MiB, sh } from "./lab.ts";

afterAll(destroyAll, 180_000);

describe.concurrent("the Sandbox's fault rows on the account", { timeout: 600_000 }, () => {
	test("the folder fills with ENOSPC at its size and entry limit, and the scan refuses symlinked parents", async () => {
		const small = `small-${Date.now()}`;
		expect((await lab("prepare", { name: small, folderBytes: 8 * MiB, folderEntries: 100 })).prepared.ok).toBe(true);
		const big = await lab("write", { name: small, path: "big.bin", bytes: 9 * MiB });
		expect(big).toMatchObject({ ok: false, code: "unknown", message: "No space left on device: /workspace/big.bin" });
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
		// A FIFO's read and write end at the file operations' limit, shortened here; opening or testing one refuses it.
		await lab("faults", { name: small, faults: { fileSeconds: 3 } });
		const fifo = await lab("fs", { name: small, path: "/workspace/pipe" });
		expect(fifo.codes).toEqual({ readText: "unknown", write: "unknown", open: "invalid", exists: "invalid" });
		expect(fifo.ms).toBeLessThan(15_000);
	});

	for (const step of ["workspace", "readonly_root"]) {
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
			await new Promise((resolve) => setTimeout(resolve, 2000));
			status = await lab("status", { name });
		} while (status.status.cleanupPending && Date.now() - started < 120_000);
		console.info(`an owed destroy finished ${Date.now() - started} ms after it was lost`);
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
