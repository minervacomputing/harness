// Strict revocation (plan: Strict revocation), over node:sqlite with fake
// Conversation objects: which runs each change stops and with which reason, the outbox written in the
// change's own transaction, the acknowledgement barrier and its 10 s limit, the alarm's retries, the
// emergency stop, and the fault cases: a crash after the grant commit, a lost acknowledgement, a
// Conversation that cannot be reached, and a second change while a cancel is still owed.

import { describe, expect, test } from "vitest";
import type { Caller } from "../../src/contracts/common.ts";
import { BARRIER_MS } from "../../src/workspace/core.ts";
import { ADA, GRACE, accessOf, attach, begin, conversation, connectMixed, defaultAgent, grant, harness, outbox, registered, running, settle, type Harness } from "./workspace-support.ts";

/** Advances the clock in steps until the promise settles. */
async function until<T>(h: Harness, promise: Promise<T>, step = 500, limit = 100): Promise<T> {
	let done = false;
	const watched = promise.finally(() => {
		done = true;
	});
	for (let i = 0; i < limit && !done; i++) await h.timers.advance(step);
	if (!done) throw new Error("Still waiting.");
	return watched;
}

/** A workspace where Ada and Grace may both use a shared connection on the default agent. */
async function shared(): Promise<{ h: Harness; connection: string; agent: string }> {
	const h = await harness();
	const connection = await connectMixed(h, {});
	h.sql.exec("UPDATE connections SET owner_id = NULL");
	const agent = await defaultAgent(h);
	await attach(h, agent, [connection]);
	await grant(h, connection, { inbox: ["read"] });
	await grant(h, connection, { inbox: ["read"] }, GRACE);
	return { h, connection, agent };
}

const reasons = (h: Harness) => Object.fromEntries(outbox(h).map((entry) => [entry.run_id, entry.reason]));

describe("which runs a change stops", () => {
	test("a grant change stops all of that user's active runs, queued ones included, and no one else's", async () => {
		const { h, connection } = await shared();
		const active = await running(h);
		const starting = await begin(h);
		const graces = await running(h, { caller: GRACE });
		const changed = await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect(reasons(h)).toEqual({ [active.input.runId]: "permissions_changed", [starting.input.runId]: "permissions_changed" });
		expect(registered(h, graces.input.runId)).toEqual({ state: "active", revoked: null });
		expect(h.conversations.stopped.get(active.input.runId)).toBe("permissions_changed");
		expect(outbox(h).map((entry) => entry.ack_state)).toEqual(["stopping", "tombstoned"]);
	});

	test("removing a connection stops the deleting user's runs only, even on a shared connection", async () => {
		const { h, connection } = await shared();
		const adas = await running(h);
		const graces = await running(h, { caller: GRACE });
		expect(await h.core.deleteConnection(ADA, connection)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect(reasons(h)).toEqual({ [adas.input.runId]: "connection_removed" });
		expect(registered(h, graces.input.runId)?.revoked).toBeNull();
	});

	test("changing an agent's connections stops its runs, every user's; renaming it does not", async () => {
		const { h, agent } = await shared();
		const adas = await running(h);
		const graces = await running(h, { caller: GRACE });
		const other = await h.core.createAgent(ADA, { name: "Other" });
		if (!other.ok) throw new Error("not created");
		const elsewhere = await running(h, { conversationId: await conversation(h, ADA, other.value.id) });
		const connections = (await h.core.getAgent(ADA, agent))?.connection_ids ?? [];
		const renamed = await h.core.updateAgent(ADA, agent, { name: "Renamed", connection_ids: connections });
		expect(renamed.ok && renamed.value.revocation).toBe("acknowledged");
		expect(outbox(h)).toEqual([]);
		await h.core.updateAgent(ADA, agent, { name: "Renamed", connection_ids: [] });
		expect(reasons(h)).toEqual({ [adas.input.runId]: "agent_connections_changed", [graces.input.runId]: "agent_connections_changed" });
		expect(registered(h, elsewhere.input.runId)?.revoked).toBeNull();
	});

	test("deleting an agent or a conversation is a plain cancel", async () => {
		const { h } = await shared();
		const second = await h.core.createAgent(ADA, { name: "Second" });
		if (!second.ok) throw new Error("not created");
		const ofAgent = await running(h, { conversationId: await conversation(h, ADA, second.value.id) });
		const ofChat = await running(h);
		const untouched = await running(h);
		await h.core.deleteAgent(ADA, second.value.id);
		await h.core.deleteConversation(ADA, ofChat.input.conversationId);
		expect(reasons(h)).toEqual({ [ofAgent.input.runId]: "cancelled", [ofChat.input.runId]: "cancelled" });
		expect(registered(h, untouched.input.runId)?.revoked).toBeNull();
	});

	test("an emergency stop cancels every active run of the workspace", async () => {
		const { h } = await shared();
		const adas = await running(h);
		const graces = await running(h, { caller: GRACE });
		const done = await running(h);
		await h.core.release(done.input.runId, "completed");
		expect(await h.core.emergencyStop("security fix")).toEqual({ runs: 2, revocation: "acknowledged" });
		expect(reasons(h)).toEqual({ [adas.input.runId]: "emergency_stop", [graces.input.runId]: "emergency_stop" });
		expect(h.logs).toContainEqual({ message: "Emergency stop", fields: { reason: "security fix", runs: 2 } });
		expect(await h.core.emergencyStop("again")).toEqual({ runs: 2, revocation: "acknowledged" });
		expect(outbox(h)).toHaveLength(2);
	});

	test("a change with no active run to stop answers at once", async () => {
		const { h, connection } = await shared();
		const changed = await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect(h.conversations.cancels).toEqual([]);
	});
});

describe("the barrier", () => {
	test("the change answers only once the cancel is acknowledged", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hold";
		let answered = false;
		const change = h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {}).then((result) => {
			answered = true;
			return result;
		});
		await settle();
		// Saved, and the run is marked revoked, before any acknowledgement.
		expect(registered(h, run.input.runId)?.revoked).toBe("permissions_changed");
		expect(answered).toBe(false);
		for (const release of h.conversations.held) release();
		const result = await change;
		expect(result.ok && result.value.revocation).toBe("acknowledged");
		expect(result.ok && result.value.access.grants.map((g) => g.id)).toEqual(["archive", "inbox"]);
	});

	test("a Conversation that never answers: 503 after 10 s, the change saved, the alarm keeps delivering", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hang";
		const change = h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		await h.timers.advance(BARRIER_MS - 1);
		await h.timers.advance(1);
		const result = await change;
		expect(result.ok && result.value.revocation).toBe("pending");
		expect(result.ok && result.value.access.grants.map((g) => g.id)).toEqual(["archive", "inbox"]);
		expect(outbox(h)).toMatchObject([{ acknowledged_at: null, attempts: 1 }]);
		h.conversations.mode = "answer";
		const due = h.core.nextWake() as number;
		expect(due).toBe(h.timers.now() + 1000);
		await h.timers.advance(due - h.timers.now());
		await h.core.alarm();
		expect(outbox(h)).toMatchObject([{ ack_state: "stopping" }]);
		expect(h.conversations.stopped.get(run.input.runId)).toBe("permissions_changed");
		expect(h.core.nextWake()).toBeNull();
	});

	test("an unreachable Conversation is retried within the 10 s before the change answers", async () => {
		const { h, connection } = await shared();
		await running(h);
		h.conversations.mode = "fail";
		const change = h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		await h.timers.advance(500);
		h.conversations.mode = "answer";
		const result = await until(h, change);
		expect(result.ok && result.value.revocation).toBe("acknowledged");
		expect(h.conversations.cancels.length).toBeGreaterThanOrEqual(2);
	});

	test("a lost acknowledgement: the cancel took effect, the answer did not arrive; a retry acknowledges it", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "lose";
		const result = await until(h, h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {}));
		expect(result.ok && result.value.revocation).toBe("pending");
		// The run already stopped: the cancel reached it.
		expect(h.conversations.stopped.get(run.input.runId)).toBe("permissions_changed");
		h.conversations.mode = "answer";
		await h.timers.advance(60_000);
		await h.core.alarm();
		expect(outbox(h)).toMatchObject([{ ack_state: "stopping" }]);
	});

	test("the Conversation may acknowledge a delivery itself", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "lose";
		await until(h, h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {}));
		const [entry] = outbox(h);
		await h.core.acknowledgeCancel(entry?.id as number, "0199a000-0000-7000-9000-0000000fffff");
		expect(outbox(h)[0]?.acknowledged_at).toBeNull();
		await h.core.acknowledgeCancel(entry?.id as number, run.input.runId);
		expect(outbox(h)[0]).toMatchObject({ ack_state: "stopping" });
	});

	test("a run that ended no longer needs its cancel acknowledged", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hang";
		const change = h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		await h.core.release(run.input.runId, "cancelled");
		const result = await until(h, change);
		expect(result.ok && result.value.revocation).toBe("acknowledged");
		expect(outbox(h)).toMatchObject([{ ack_state: "ended" }]);
	});

	test("a cancel answered `ended` ends the run in the registry and lets its uploads go", async () => {
		const { h, connection } = await shared();
		const reserved = await h.core.reserveUpload(ADA, { name: "a.txt", size: 1 });
		if (!reserved.ok) throw new Error("not reserved");
		await h.core.completeUpload(ADA, reserved.value.id, { sha256: "b".repeat(64), size: 1, mediaType: "text/plain" });
		const { input } = await begin(h, { uploadIds: [reserved.value.id] });
		h.conversations.ended.add(input.runId);
		await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(registered(h, input.runId)?.state).toBe("ended");
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: null }]);
	});

	test("a second change waits for a cancel the first still owes, without writing another", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hang";
		const first = await until(h, h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {}));
		expect(first.ok && first.value.revocation).toBe("pending");
		const second = await until(h, h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "secret", actions: ["read"] }], {}));
		expect(second.ok && second.value.revocation).toBe("pending");
		expect(outbox(h)).toHaveLength(1);
		h.conversations.mode = "answer";
		await h.timers.advance(60_000);
		const third = await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "secret", actions: [] }], {});
		expect(third.ok && third.value.revocation).toBe("acknowledged");
		expect(outbox(h)).toMatchObject([{ run_id: run.input.runId, reason: "permissions_changed", ack_state: "stopping" }]);
	});

	test("an agent deleted while its update waits for the cancels: the update answers the agent as it saved it", async () => {
		const { h, agent } = await shared();
		await h.core.createAgent(ADA, { name: "Other" });
		await running(h);
		h.conversations.mode = "hold";
		const update = h.core.updateAgent(ADA, agent, { name: "Changed", connection_ids: [] });
		await settle();
		const deletion = h.core.deleteAgent(ADA, agent);
		await settle();
		for (const release of h.conversations.held) release();
		expect((await deletion).ok).toBe(true);
		const updated = await update;
		expect(updated.ok && updated.value.agent).toMatchObject({ id: agent, name: "Changed", connection_ids: [] });
	});

	test("a delivery in flight is shared by the request and the alarm", async () => {
		const { h, connection } = await shared();
		await running(h);
		h.conversations.mode = "hold";
		const change = h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		const alarm = h.core.alarm();
		await settle();
		expect(h.conversations.cancels).toHaveLength(1);
		for (const release of h.conversations.held) release();
		await alarm;
		expect((await change).ok).toBe(true);
	});
});

describe("faults", () => {
	test("a crash after the grant commit: the change and the cancel are saved; the next instance's alarm delivers it", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hang";
		void h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		h.restart();
		expect(accessOf(await h.core.getAccess(ADA, connection)).grants.map((g) => g.id)).toEqual(["archive", "inbox"]);
		expect(registered(h, run.input.runId)?.revoked).toBe("permissions_changed");
		expect(h.core.nextWake()).toBe(h.timers.now());
		h.conversations.mode = "answer";
		await h.core.alarm();
		expect(outbox(h)).toMatchObject([{ run_id: run.input.runId, ack_state: "stopping" }]);
		expect(h.conversations.stopped.get(run.input.runId)).toBe("permissions_changed");
	});

	test("the alarm is brought forward at the commit, before the change waits for anything", async () => {
		const { h, connection } = await shared();
		await running(h);
		h.conversations.mode = "hang";
		h.wakes.length = 0;
		void h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		// Synchronously with the commit: an instance that dies while it waits still has its alarm set.
		expect(h.wakes).toEqual([h.timers.now()]);
		// A delivery that fails after the request answered brings it forward again, to the retry.
		await settle();
		await h.timers.advance(10_000);
		expect(h.wakes.at(-1)).toBe(h.timers.now() + 1000);
	});

	test("a lease after the commit and before the acknowledgement is refused: the run is revoked in the registry", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		h.conversations.mode = "hang";
		void h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		await settle();
		expect(await h.core.lease(connection, { run: run.input.runId, userId: run.input.userId })).toMatchObject({ refused: "RUN_ENDED" });
	});

	test("the revoked flag outlives the acknowledgement and a restart", async () => {
		const { h, connection } = await shared();
		const run = await running(h);
		await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		h.restart();
		expect(await h.core.activate(run.input.runId)).toEqual({ state: "revoked", reason: "permissions_changed" });
	});

	test("members' roles do not matter to whose runs stop", async () => {
		const { h, connection } = await shared();
		const graces = await running(h, { caller: GRACE });
		const admin: Caller = { userId: ADA.userId, role: "admin" };
		await h.core.applyGrantChanges(admin, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(registered(h, graces.input.runId)?.revoked).toBeNull();
	});
});
