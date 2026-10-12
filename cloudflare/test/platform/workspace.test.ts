// The Workspace Durable Object in local workerd: the wrapper around WorkspaceCore over the object's own
// SQLite storage, reached by RPC, with a fake Conversation client and fake connectors put in through
// REPLACE_PORTS. Covers a start, strict revocation and its acknowledgement, the alarm that keeps
// delivering, credentials sealed with the Worker's key, upload objects deleted from the workspace's own
// bucket (EU included), and that the port hook cannot be reached over RPC.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { filesBucket, workspaceObject } from "../../src/addressing.ts";
import type { Caller, WorkspaceRef } from "../../src/contracts/common.ts";
import type { CancelAck, ConversationInit } from "../../src/contracts/conversation.ts";
import type { CancelReason } from "../../src/contracts/runs.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { EncryptionKeys, credentialBinding } from "../../src/lib/encryption.ts";
import type { JsonObject } from "../../src/lib/json.ts";
import type { ConversationClient, Timers } from "../../src/workspace/ports.ts";
import { realTimers } from "../../src/workspace/ports.ts";
import { REPLACE_PORTS, type ReplaceablePorts, type Workspace } from "../../src/workspace/workspace.ts";
import { keyedConnector, mixedConnector } from "../unit/fakes.ts";

const USER = "0199a000-0000-7000-8000-0000000000aa";
const ADA: Caller = { userId: USER, role: "owner" };

class Conversations implements ConversationClient {
	readonly inits: ConversationInit[] = [];
	readonly cancels: { conversationId: string; runId: string; reason: CancelReason; entryId: number }[] = [];
	readonly stored = new Set<string>();
	mode: "answer" | "hang" = "answer";

	async init(input: ConversationInit): Promise<void> {
		this.inits.push(input);
	}

	async cancel(conversationId: string, runId: string, reason: CancelReason, entryId: number): Promise<CancelAck> {
		this.cancels.push({ conversationId, runId, reason, entryId });
		if (this.mode === "hang") return new Promise<never>(() => {});
		return { runId, state: this.stored.has(runId) ? "stopping" : "tombstoned" };
	}

	async destroy(): Promise<{ done: boolean }> {
		return { done: true };
	}
}

/** The platform's timers on a clock the test moves; waits are cut short so a 10 s barrier takes 20 ms. */
function clockTimers(): Timers & { at: number } {
	const timers = {
		at: Date.now(),
		now: () => timers.at,
		delay: (ms: number) => realTimers.delay(Math.min(ms, 20)),
	};
	return timers;
}

async function workspace(ref: WorkspaceRef, ports: ReplaceablePorts) {
	const stub = workspaceObject(env, ref);
	await runInDurableObject(stub, (instance: Workspace) => instance[REPLACE_PORTS](ports));
	await stub.init({ workspace: ref, kind: "personal", ownerId: USER, createdAt: Date.now() });
	return stub;
}

/** Polls until `check` passes: the platform also runs a due alarm by itself, at a time of its choosing. */
async function eventually(check: () => Promise<void>, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			return await check();
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

async function registry(): Promise<Registry> {
	return Registry.create([mixedConnector(), keyedConnector()]);
}

describe("the Workspace object", () => {
	test("provisions its workspace, with its schema", async () => {
		const ref = { id: "0199a000-0000-7000-8000-000000000a01", jurisdiction: null };
		const stub = await workspace(ref, {});
		expect(await stub.about()).toEqual({ kind: "workspace", name: ref.id, jurisdiction: null, migrations: [1, 2] });
		expect((await stub.listAgents(ADA)).map((agent) => agent.name)).toEqual(["Assistant"]);
		// The outbox's AUTOINCREMENT and the STRICT tables work in the object's SQLite.
		await runInDurableObject(stub, (_, state) => {
			const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((row) => row.name);
			expect(tables).toEqual(expect.arrayContaining(["agents", "connections", "grants", "outbox", "runs", "uploads", "sqlite_sequence"]));
		});
	});

	test("the port hook is not reachable over RPC", async () => {
		const stub = workspaceObject(env, { id: "0199a000-0000-7000-8000-000000000a02", jurisdiction: null });
		await stub.about();
		expect(typeof (stub as unknown as Record<symbol, unknown>)[REPLACE_PORTS]).not.toBe("function");
	});

	test("a start, then a grant change: the run is revoked and the cancel acknowledged before the answer", async () => {
		const ref = { id: "0199a000-0000-7000-8000-000000000a03", jurisdiction: null };
		const conversations = new Conversations();
		const stub = await workspace(ref, { conversations, registry: await registry() });
		const saved = await stub.saveConnection(ADA, {
			provider: "mixed",
			account: { id: "acct-1", label: "Fake account" },
			credentials: { kind: "oauth2", access_token: "a1", refresh_token: null, scopes: null },
			connectionId: null,
		});
		if (!saved.ok) throw new Error(saved.refusal.detail);
		const connection = saved.value.id;
		const [agent] = await stub.listAgents(ADA);
		await stub.updateAgent(ADA, agent?.id as string, { name: "Assistant", connection_ids: [connection] });
		await stub.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "inbox", actions: ["read"] }], {});
		const created = await stub.createConversation(ADA, agent?.id as string);
		if (!created.ok) throw new Error(created.refusal.detail);
		expect(conversations.inits).toMatchObject([{ conversationId: created.value.id, workspace: ref, userId: USER }]);
		const runId = "0199a000-0000-7000-9000-000000000a03";
		const begun = await stub.beginRun({ runId, conversationId: created.value.id, userId: USER, agentId: agent?.id as string, uploadIds: [], folder: { bytes: 0, entries: 0 } });
		expect(begun.ok && begun.value.snapshot.tools.map((tool) => tool.name)).toEqual(["mixed_list_folders"]);
		expect(await stub.activate(runId)).toEqual({ state: "active" });
		conversations.stored.add(runId);
		// The lease is sealed with the Worker's key; only the caller decrypts it.
		const lease = await stub.lease(connection, { run: runId, userId: USER });
		if ("refused" in lease) throw new Error(lease.message);
		const keys = await EncryptionKeys.parse(env.MINERVA_ENCRYPTION_KEYS);
		expect(((await keys.decrypt(credentialBinding(ref.id, connection), lease.sealed)) as JsonObject).access_token).toBe("a1");
		const changed = await stub.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect(conversations.cancels).toEqual([{ conversationId: created.value.id, runId, reason: "permissions_changed", entryId: 1 }]);
		expect(await stub.lease(connection, { run: runId, userId: USER })).toEqual({ refused: "RUN_ENDED", message: "This run is no longer active." });
		expect(await stub.activate(runId)).toEqual({ state: "revoked", reason: "permissions_changed" });
		expect(await stub.locateRun(ADA, runId)).toEqual({ conversationId: created.value.id });
	});

	test("a cancel that is not acknowledged: the change answers pending, the alarm delivers it later", async () => {
		const ref = { id: "0199a000-0000-7000-8000-000000000a04", jurisdiction: null };
		const conversations = new Conversations();
		const timers = clockTimers();
		const stub = await workspace(ref, { conversations, timers });
		const [agent] = await stub.listAgents(ADA);
		const created = await stub.createConversation(ADA, agent?.id as string);
		if (!created.ok) throw new Error(created.refusal.detail);
		const runId = "0199a000-0000-7000-9000-000000000a04";
		await stub.beginRun({ runId, conversationId: created.value.id, userId: USER, agentId: agent?.id as string, uploadIds: [], folder: { bytes: 0, entries: 0 } });
		await stub.activate(runId);
		conversations.stored.add(runId);
		conversations.mode = "hang";
		expect(await stub.emergencyStop("test")).toEqual({ runs: 1, revocation: "pending" });
		const owed = () => runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT acknowledged_at, ack_state FROM outbox").toArray());
		expect(await owed()).toEqual([{ acknowledged_at: null, ack_state: null }]);
		expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).not.toBeNull();
		conversations.mode = "answer";
		timers.at += 60_000;
		await runDurableObjectAlarm(stub);
		await eventually(async () => expect(await owed()).toEqual([{ acknowledged_at: timers.at, ack_state: "stopping" }]));
		expect(await stub.activate(runId)).toEqual({ state: "revoked", reason: "emergency_stop" });
		// Nothing is left to wake for.
		await eventually(async () => expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull());
	});

	test("upload objects are deleted from the workspace's own bucket, an EU workspace's from the EU one", async () => {
		for (const jurisdiction of [null, "eu"] as const) {
			const ref = { id: "0199a000-0000-7000-8000-000000000a05", jurisdiction };
			const stub = await workspace(ref, {});
			const reserved = await stub.reserveUpload(ADA, { name: "notes.txt", size: 5 });
			if (!reserved.ok) throw new Error(reserved.refusal.detail);
			const { id, key } = reserved.value;
			expect(key).toBe(`uploads/${ref.id}/${USER}/${id}`);
			const own = filesBucket(env, ref);
			const other = filesBucket(env, { ...ref, jurisdiction: jurisdiction === "eu" ? null : "eu" });
			await own.put(key, "hello");
			await other.put(key, "other");
			await stub.abandonUpload(ADA, id);
			// Due now: the alarm may also run by itself.
			await runDurableObjectAlarm(stub);
			await eventually(async () => expect(await own.head(key)).toBeNull());
			expect(await other.head(key)).not.toBeNull();
			await other.delete(key);
		}
	});
});
