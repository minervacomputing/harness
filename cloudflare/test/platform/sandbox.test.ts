// The Sandbox Durable Object in local workerd, which has no containers: its schema on the object's SQLite,
// its RPC surface and refusals, its alarm, and the lifecycle (src/sandbox/core.ts) over the object's own
// storage with a scripted container. The real container is tested locally in Docker
// (test/unit/sandbox-local.test.ts) and on the account (test/account/sandbox.test.ts).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { sandboxObject } from "../../src/addressing.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { durableSql } from "../../src/lib/sql.ts";
import { sandboxSpec, WORKSPACE } from "../../src/sandbox/constants.ts";
import { SandboxCore, type SandboxFence } from "../../src/sandbox/core.ts";
import { CHECK_MISMATCH, r2Bucket } from "../../src/sandbox/ports.ts";
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

describe("the Sandbox object", () => {
	test("its schema, its status, and a start without a container", async () => {
		const stub = sandbox();
		expect(await stub.about()).toMatchObject({ kind: "sandbox", migrations: [1] });
		expect(await stub.status()).toEqual({ state: "none", incarnation: null, runId: null, attempt: null, cleanupPending: false, startedAt: null });
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
		await stub.cancel(fence, "x");
	});

	test("the alarm finishes an owed destroy", async () => {
		const stub = sandbox();
		await runInDurableObject(stub, async (_instance, state) => {
			const sql = durableSql(state.storage);
			writeState(sql, { ...readState(sql), state: "destroying", incarnation: "old", runId: uuid7(), attempt: 1, cleanupPending: true, cleanupReason: "owed" }, Date.now());
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
			const ports = () => ({
				container,
				sql: durableSql(state.storage),
				bucket: () => ({ get: async () => null, put: async () => {}, check: async () => {} }),
				now: () => Date.now(),
				id: () => uuid7(),
				alarm: async (at: number | null) => {
					alarms.push(at);
				},
				background: () => {},
				log: () => {},
			});
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
			expect(alarms.at(-1)).toBeNull();
		});
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
