// The Sandbox Durable Object in local workerd, which has no containers: its schema on the object's SQLite,
// its RPC surface and refusals, its alarm, the lifecycle (src/sandbox/core.ts) over the object's own
// storage with a scripted container, and a run's span read back through the object's seal. The real container is tested locally in Docker
// (test/docker/sandbox-local.test.ts) and on the account (test/account/sandbox.test.ts, sandbox-faults.test.ts).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { sandboxObject } from "../../src/addressing.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { durableSql } from "../../src/lib/sql.ts";
import { sandboxSpec, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import { CHECK_MISMATCH, r2Bucket, type SandboxPorts } from "../../src/sandbox/ports.ts";
import { OutputSink } from "../../src/sandbox/sink.ts";
import { readState, writeState } from "../../src/sandbox/store.ts";
import { prepareSandbox } from "../../src/sandbox/session.ts";
import type { WorkspaceRef } from "../../src/shared/rpc.ts";
import { ScriptedContainer } from "./sandbox-container.ts";

const WS: WorkspaceRef = { id: "0199b000-0000-7000-8000-000000000001", jurisdiction: null };
const SPEC = sandboxSpec(WS, "c", { folderBytes: 1 << 20, folderEntries: 50 }, null);

function sandbox(name = uuid7()) {
	return sandboxObject(env, exports, WS, name);
}

/** Ports over the object's own storage with a scripted container, in place of the object's. */
function scripted(storage: DurableObjectStorage, container: ScriptedContainer, alarms: (number | null)[], now: () => number = Date.now): SandboxPorts {
	return {
		container,
		sql: durableSql(storage),
		bucket: () => ({ get: async () => null, put: async () => {}, check: async () => {} }),
		now,
		id: () => uuid7(),
		alarm: async (at) => {
			alarms.push(at);
		},
		background: () => {},
		log: () => {},
	};
}

describe("the Sandbox object", () => {
	test("its schema, its status, and a start without a container", async () => {
		const stub = sandbox();
		expect(await stub.about()).toMatchObject({ kind: "sandbox", migrations: [1, 2, 3, 4] });
		expect(await stub.status()).toEqual({ state: "none", incarnation: null, runId: null, attempt: null, cleanupPending: false, startedAt: null, snapshot: null });
		expect(await stub.start({ runId: uuid7(), attempt: 1 }, SPEC)).toEqual({ failed: "This Worker has no container." });
	});

	test("every call names its incarnation, run and attempt", async () => {
		const stub = sandbox();
		const fence: SandboxFence = { runId: uuid7(), attempt: 1, incarnation: "nothing" };
		expect(await stub.harden(fence)).toMatchObject({ refused: "stale" });
		expect(await stub.verify(fence)).toMatchObject({ refused: "stale" });
		expect(await stub.exec(fence, { execId: "x", command: "true", cwd: WORKSPACE, env: {}, timeoutSeconds: 1 }, null)).toMatchObject({ refused: "stale" });
		expect(await stub.fs(fence, { op: "lstat", path: "/workspace" })).toMatchObject({ refused: "stale" });
		expect(await stub.scan(fence, { rehashAll: false })).toMatchObject({ refused: "stale" });
		expect(await stub.killStrays(fence)).toMatchObject({ refused: "stale" });
		expect(await stub.destroy(fence, "late")).toMatchObject({ refused: "stale" });
		expect(await stub.park(fence, null)).toMatchObject({ refused: "stale" });
		expect(await stub.acquire({ runId: fence.runId, attempt: 1 }, SPEC, null)).toEqual({ acquired: false, reason: "Nothing is parked." });
		await stub.cancel(fence, "x");
	});

	test("the alarm finishes an owed destroy", async () => {
		const stub = sandbox();
		await runInDurableObject(stub, async (_instance, state) => {
			const sql = durableSql(state.storage);
			writeState(sql, { ...readState(sql), state: "destroying", incarnation: "old", runId: uuid7(), attempt: 1, startedAt: Date.now(), leaseUntil: Date.now() + 60_000, cleanupPending: true, cleanupReason: "owed" }, Date.now());
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stub.status()).toMatchObject({ state: "none", incarnation: null, cleanupPending: false });
	});

	test("the lifecycle on the object's own SQLite, with a scripted container", async () => {
		const stub = sandbox();
		await runInDurableObject(stub, async (_instance, state) => {
			const container = new ScriptedContainer(SPEC);
			const alarms: (number | null)[] = [];
			const ports = () => scripted(state.storage, container, alarms);
			const core = new SandboxCore(ports());
			const prepared = await prepareSandbox(core, { runId: uuid7(), attempt: 1 }, SPEC);
			if (!prepared.ok) throw new Error(prepared.message);
			const chunks: string[] = [];
			const sink = new OutputSink((chunk) => chunks.push(chunk.text));
			expect(await core.exec(prepared.fence, { execId: "a", command: "echo hi", cwd: WORKSPACE, env: {}, timeoutSeconds: 5 }, sink)).toEqual({ ok: true, exitCode: 0 });
			expect(chunks.join("")).toBe("hi\n");
			expect(readState(durableSql(state.storage))).toMatchObject({ state: "in_use", hardened: true });
			// A restart reads the same row and verifies the running container again.
			const restarted = new SandboxCore(ports());
			await restarted.recover();
			expect(await restarted.exec(prepared.fence, { execId: "b", command: "echo again", cwd: WORKSPACE, env: {}, timeoutSeconds: 5 }, null)).toEqual({ ok: true, exitCode: 0 });
			expect(container.verifications).toBe(2);
			expect(await restarted.destroy(prepared.fence, "done")).toEqual({ destroyed: true });
			expect(readState(durableSql(state.storage))).toMatchObject({ state: "none", incarnation: null });
			// A container parked on the object's own SQLite, then acquired by the next run.
			const parking = await prepareSandbox(restarted, { runId: uuid7(), attempt: 1 }, SPEC);
			if (!parking.ok) throw new Error(parking.message);
			expect(await restarted.park(parking.fence, null)).toEqual({ parked: true });
			expect(readState(durableSql(state.storage))).toMatchObject({ state: "parked", parkedVersion: null });
			const next = { runId: uuid7(), attempt: 1 };
			const acquired = await restarted.acquire(next, SPEC, null);
			if (!("incarnation" in acquired)) throw new Error(JSON.stringify(acquired));
			expect(readState(durableSql(state.storage))).toMatchObject({ state: "verified", incarnation: acquired.incarnation, runId: next.runId });
			expect(await restarted.destroy({ ...next, incarnation: acquired.incarnation }, "done")).toEqual({ destroyed: true });
			expect(alarms.at(-1)).toBeNull();
		});
	});
});

describe("a run's container time", () => {
	test("a run's container leaves one span after the run's end, which the object's seal answers; the run starts nothing after", async () => {
		const stub = sandbox();
		const runId = uuid7();
		const clock = { now: 1_800_000_000_000 };
		await runInDurableObject(stub, async (_instance, state) => {
			const core = new SandboxCore(scripted(state.storage, new ScriptedContainer(SPEC), [], () => clock.now));
			const prepared = await prepareSandbox(core, { runId, attempt: 1 }, SPEC);
			if (!prepared.ok) throw new Error(prepared.message);
			clock.now += 5000;
			expect(await core.exec(prepared.fence, { execId: "a", command: "echo hi", cwd: WORKSPACE, env: {}, timeoutSeconds: 5 }, null)).toEqual({ ok: true, exitCode: 0 });
			clock.now += 5000;
			expect(await core.destroy(prepared.fence, "The run ended.")).toEqual({ destroyed: true });
		});
		const spans = { since: 0, spans: [{ startedAt: 1_800_000_000_000, leaseUntil: 1_800_003_600_000, endedAt: 1_800_000_010_000, ended: "destroyed" }] };
		expect(await stub.seal(runId)).toEqual(spans);
		expect(await stub.start({ runId, attempt: 2 }, SPEC)).toEqual({ refused: "stale", message: "This run has ended." });
		expect(await stub.seal(runId)).toEqual(spans);
		expect(await stub.seal(uuid7())).toEqual({ since: 0, spans: [] });
	});
});

describe("R2 as the checkpoint's bucket", () => {
	test("a put R2 refuses before reading the file cancels the file's stream, and settles both sides", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(64 * 1024));
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		const refused = new Error("refused");
		const bucket = r2Bucket({
			put: async () => {
				throw refused;
			},
		} as unknown as R2Bucket);
		await expect(bucket.put("k", body, { size: 10 * 1024 * 1024, sha256: "0".repeat(64) })).rejects.toBe(refused);
		expect(cancelled).toBe(true);
	});

	test("a check hashes exactly the file's bytes and stores nothing", async () => {
		const puts: string[] = [];
		const bucket = r2Bucket({
			put: async (key: string) => {
				puts.push(key);
			},
		} as unknown as R2Bucket);
		const data = new TextEncoder().encode("hello");
		const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		await expect(bucket.check(new Blob([data]).stream(), { size: 5, sha256 })).resolves.toBeUndefined();
		await expect(bucket.check(new Blob([data]).stream(), { size: 5, sha256: "0".repeat(64) })).rejects.toThrow(CHECK_MISMATCH);
		await expect(bucket.check(new Blob([data]).stream(), { size: 6, sha256 })).rejects.toThrow();
		expect(puts).toEqual([]);
	});

	test("a read gives the object's bytes, and its body fails at its end unless they have the SHA-256 asked for", async () => {
		const bucket = r2Bucket(env.FILES);
		const data = new Uint8Array(300_000).map((_, i) => i % 251);
		const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const key = `sandbox-read/${uuid7()}`;
		await env.FILES.put(key, data);
		const right = await bucket.get(key, sha256);
		expect(right?.size).toBe(data.length);
		expect(new Uint8Array(await new Response(right?.body).arrayBuffer())).toEqual(data);
		const wrong = await bucket.get(key, "0".repeat(64));
		await expect(new Response(wrong?.body).arrayBuffer()).rejects.toThrow(CHECK_MISMATCH);
		expect(await bucket.get(`${key}/missing`, sha256)).toBeNull();
		await env.FILES.delete(key);
	});
});
