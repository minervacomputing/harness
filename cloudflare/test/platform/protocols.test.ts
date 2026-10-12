// The protocols end to end in local workerd (plan: Testing, fault injection): the real Workspace and
// Conversation objects over RPC, the executor with its ledger and page tokens in the Conversation's SQLite,
// credentials leased from the Workspace and refreshed against the fake provider, the fake Notes connector
// (src/faults/), and the deterministic fake model. Faults come from the test build's points (src/faults/
// ports.ts) and from the platform's own resets (`ctx.abort()`, abortAllDurableObjects).

import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test } from "vitest";
import { conversationObject, workspaceObject } from "../../src/addressing.ts";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import type { Caller, RunId, WorkspaceRef } from "../../src/contracts/common.ts";
import type { RunEvent } from "../../src/contracts/events.ts";
import type { RunHead } from "../../src/contracts/runs.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { NOTES_CLIENT, NOTES_TOKEN_URL, notesConnector } from "../../src/faults/connector.ts";
import type { Conversation, Workspace } from "../../src/faults/index.ts";
import type { Fault } from "../../src/faults/plan.ts";
import { faultConversationPorts, faultWorkspacePorts, NOT_FAKE, providerFetch, providerOf } from "../../src/faults/ports.ts";
import { setUpWorkspace } from "../../src/faults/routes.ts";
import { EncryptionKeys, credentialBinding } from "../../src/lib/encryption.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeTurn } from "../../src/model/fake.ts";
import { START_FAILED } from "../../src/workspace/core.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";

const USER = "0199a000-0000-7000-8000-0000000e2e01";
const CALLER: Caller = { userId: USER, role: "owner" };
const LIST = "notes_list_notes";
const SAVE = "notes_save_note";

type ConversationStub = DurableObjectStub<Conversation>;
type WorkspaceStub = DurableObjectStub<Workspace>;

/** A workspace with a Notes connection and a conversation. A stub breaks once its object was reset, so each use gets a new one. */
interface World {
	ref: WorkspaceRef;
	readonly ws: WorkspaceStub;
	readonly conversation: ConversationStub;
	conversationId: string;
	connectionId: string;
	agentId: string;
}

beforeAll(() => {
	// The test build's wiring, as src/faults/index.ts sets it (another test file may have replaced it).
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

async function world(
	options: { faults?: Fault[]; workspaceFaults?: Fault[]; expired?: boolean; delays?: { [prefix: string]: number }; jurisdiction?: "eu" | null } = {},
): Promise<World> {
	const ref: WorkspaceRef = { id: uuid7(), jurisdiction: options.jurisdiction ?? null };
	const { connectionId, agentId } = await setUpWorkspace(env, ref, USER, options);
	const ws = () => workspaceObject(env, ref) as unknown as WorkspaceStub;
	if (options.workspaceFaults) await ws().faultPlan(options.workspaceFaults);
	const created = await ws().createConversation(CALLER, agentId);
	if (!created.ok) throw new Error(created.refusal.detail);
	const conversationId = created.value.id;
	const conversation = () => conversationObject(env, ref, conversationId) as unknown as ConversationStub;
	if (options.faults) await conversation().faultPlan(options.faults);
	return {
		ref,
		get ws() {
			return ws();
		},
		get conversation() {
			return conversation();
		},
		conversationId,
		connectionId,
		agentId,
	};
}

function script(turns: FakeTurn[]): string {
	return JSON.stringify({ fake: { turns } });
}

async function post(w: World, turns: FakeTurn[]): Promise<RunId> {
	const outcome = await w.conversation.postMessage(CALLER, { content: script(turns), attachments: [] });
	if (!outcome.ok) throw new Error(`Refused: ${outcome.refusal.status} ${outcome.refusal.detail}`);
	return outcome.value.run.id;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 10_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		let value: T | undefined;
		try {
			value = await read();
		} catch {
			// A reset object refuses the call that was in flight; the next one reaches its new instance.
		}
		if (value !== undefined && done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(25);
	}
}

const ACTIVE = ["queued", "provisioning", "running"];

async function settled(w: World, runId: RunId, timeout?: number): Promise<RunHead> {
	return until(async () => (await w.conversation.getRun(CALLER, runId)) as RunHead, (run) => !ACTIVE.includes(run.status), timeout);
}

async function eventsOf(w: World, runId: RunId): Promise<RunEvent[]> {
	return (await w.conversation.getRunEvents(CALLER, runId, { after: 0, upTo: 1_000_000, limit: 1000 })) ?? [];
}

function statuses(events: RunEvent[]) {
	return events.filter((event) => event.type === "status").map((event) => event.data);
}

function toolCalls(events: RunEvent[]) {
	return events.filter((event) => event.type === "tool_call").map((event) => event.data as { tool: string; decision: string; code?: string; message?: string; repeat?: boolean; count?: number });
}

/** Waits until the object logged that it reached a fault point. */
async function reached(read: () => Promise<{ point: string }[]>, point: string): Promise<void> {
	await until(read, (fired) => fired.some((entry) => entry.point === point));
}

/** How often the object logged a point. */
async function times(read: () => Promise<{ point: string }[]>, point: string): Promise<number> {
	return (await read()).filter((entry) => entry.point === point).length;
}

/** Whether a promise has settled by now, without waiting for it. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(
		() => (done = true),
		() => (done = true),
	);
	await sleep(0);
	return done;
}

/**
 * The platform's refusal of a value or a row over 2 MB ("string or blob too big"), which local workerd does
 * not enforce, for the start's tables: rows of `runs` and `run_snapshots`.
 */
async function enforceValueLimit(stub: ConversationStub): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		for (const [table, column] of [
			["runs", "snapshot"],
			["run_snapshots", "text"],
		]) {
			state.storage.sql.exec(
				`CREATE TRIGGER limit_${table} BEFORE INSERT ON ${table} WHEN length(CAST(NEW.${column} AS BLOB)) > 2097152 BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END`,
			);
		}
	});
}

/** Makes a Lifecycle job of the Conversation due now and runs its alarm. */
async function due(stub: ConversationStub, job: string): Promise<void> {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0 WHERE id = ?", job);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(stub);
}

async function provider(w: World) {
	return providerOf(env, w.ref.id).state();
}

const STOPPED_PERMISSIONS = "Stopped because permissions changed.";
const READ_ONLY = [{ kind: "folder", id: "*", actions: ["read"] }];
const LIST_INBOX: FakeTurn = { tools: [{ name: LIST, arguments: { folder: "inbox" } }] };
const save = (title: string): FakeTurn => ({ tools: [{ name: SAVE, arguments: { folder: "inbox", title } }] });
const SEEDED = ["Buy milk", "Call Ada", "Old note"];

describe("the wiring", () => {
	test("a read and a write through the executor, the ledger and a lease from the Workspace", async () => {
		const w = await world();
		const runId = await post(w, [LIST_INBOX, save("From the test"), { text: "Saved." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		const calls = toolCalls(events);
		expect(calls).toEqual([
			expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }),
			expect.objectContaining({ tool: SAVE, decision: "allowed", count: 1, write: expect.stringMatching(/^[0-9a-f]{32}$/) }),
		]);
		expect(calls[1]).not.toHaveProperty("repeat");
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "From the test"]);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
		expect(internals.run).toMatchObject({ tool_calls: 2, writes_uncertain: 0 });
	});

	test("an EU workspace's objects reach each other in its jurisdiction (addressing.ts)", async () => {
		const w = await world({ jurisdiction: "eu" });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" })]);
		// Locally an EU object is named `eu:<id>` (no jurisdictions in workerd): the plain one is another, empty object.
		expect(await w.ws.about()).toMatchObject({ name: `eu:${w.ref.id}` });
		const plain = workspaceObject(env, { id: w.ref.id, jurisdiction: null });
		expect(await plain.listAgents(CALLER)).toEqual([]);
		expect(await conversationObject(env, { id: w.ref.id, jurisdiction: null }, w.conversationId).getRun(CALLER, runId)).toBeNull();
	});
});

describe("start and revocation", () => {
	test("a grant change before the run exists is in its snapshot: the write is denied", async () => {
		const w = await world();
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		const runId = await post(w, [save("Not allowed"), { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		// The write is not offered at all (gateway/tools.ts): pi answers the model's call itself.
		expect((await w.conversation.faultRun(runId)).tools).toEqual([LIST]);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
		expect((await provider(w)).requests).toEqual([]);
	});

	test("a revocation between beginRun and the start's transaction leaves a tombstone: the run is stored cancelled", async () => {
		const w = await world({ faults: [{ point: "start:copy", mode: "hold" }, { point: "activate:before", mode: "note", times: 10 }] });
		const posting = w.conversation.postMessage(CALLER, { content: script([LIST_INBOX, { text: "Done." }]), attachments: [] });
		await reached(() => w.conversation.faultFired(), "start:copy");
		// The Workspace registered the run; the Conversation has only its marker.
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		await w.conversation.faultRelease("start:copy");
		const outcome = await posting;
		if (!outcome.ok) throw new Error(outcome.refusal.detail);
		// The start's own transaction stored it cancelled, from the tombstone: never queued for activation.
		expect(outcome.value.run).toMatchObject({ status: "cancelled", error_message: STOPPED_PERMISSIONS });
		expect(statuses(outcome.value.run.events)).toEqual([{ status: "queued" }, { status: "cancelled", message: STOPPED_PERMISSIONS }]);
		const run = await settled(w, outcome.value.run.id);
		expect(run).toMatchObject({ status: "cancelled", error_message: STOPPED_PERMISSIONS });
		const internals = await w.conversation.faultRun(run.id);
		expect(internals.run).toMatchObject({ error_code: "permissions_changed", revoked: 1, activated: 0 });
		await sleep(200);
		expect(await times(() => w.conversation.faultFired(), "activate:before")).toBe(0);
		expect((await provider(w)).requests).toEqual([]);
	});

	test("a revocation during a read in flight: the run stops before the answer, and nothing starts after it", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 1500 } });
		const runId = await post(w, [LIST_INBOX, LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		const answered = Date.now();
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		// The browser is told only after the run's local flag is set and the run is stopped.
		const run = (await w.conversation.getRun(CALLER, runId)) as RunHead;
		expect(run).toMatchObject({ status: "cancelled", error_message: STOPPED_PERMISSIONS });
		await sleep(2000);
		const requests = (await provider(w)).requests;
		expect(requests).toHaveLength(1);
		expect(requests.every((request) => request.at < answered)).toBe(true);
		// The read's answer came back to a run that had ended: no tool_call event.
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
	});

	test("a revocation while a write is in flight: it completes, and its call's next request is never sent", async () => {
		const w = await world({ delays: { "POST /folders/inbox/notes": 1500 } });
		// file_note saves, then reads the note back: two requests of one call.
		const runId = await post(w, [{ tools: [{ name: "notes_file_note", arguments: { folder: "inbox", title: "Filed" } }] }, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		const answered = Date.now();
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		await sleep(2500);
		// The write was sent before the change and completes ("no further effects", not rollback); the read
		// that would follow it is refused before it is sent, though the call goes on to settle its write.
		const state = await provider(w);
		expect(state.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /folders/inbox/notes"]);
		expect(state.requests.every((request) => request.at < answered)).toBe(true);
		expect(state.notes.map((note) => note.title)).toEqual([...SEEDED, "Filed"]);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "succeeded" })]);
		expect(toolCalls(await eventsOf(w, runId))).toEqual([]);
	});

	test("the change answers only once the cancel is acknowledged, and the run is stopped by then", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 4000 }, workspaceFaults: [{ point: "cancel:before", mode: "hold" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		const changing = w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		await reached(() => w.ws.faultFired(), "cancel:before");
		await sleep(300);
		// Committed, but the cancel is held on its way: no answer yet, and the run still acts.
		expect(await settledYet(changing)).toBe(false);
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ status: "running", revoked: 0 });
		await w.ws.faultRelease("cancel:before");
		const changed = await changing;
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ status: "cancelled", revoked: 1 });
	});

	test("a crash between storing the run and its activation: the restarted object activates it, attempt 1", async () => {
		const w = await world({ faults: [{ point: "activate:before", mode: "abort" }] });
		const runId = await post(w, [{ text: "Done." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		expect(statuses(await eventsOf(w, runId))).toEqual([{ status: "queued" }, { status: "provisioning" }, { status: "running" }, { status: "completed" }]);
		expect((await w.conversation.faultRun(runId)).attempts).toEqual([{ attempt: 1, ended: "completed" }]);
	});

	test("a lost activation answer: the watch sends it again, and the Workspace answers the same", async () => {
		const w = await world({ faults: [{ point: "activate:lost", mode: "lose" }] });
		const runId = await post(w, [{ text: "Done." }]);
		await reached(() => w.conversation.faultFired(), "activate:lost");
		expect(((await w.conversation.getRun(CALLER, runId)) as RunHead).status).toBe("queued");
		await due(w.conversation, `watch:${runId}`);
		expect((await settled(w, runId)).status).toBe("completed");
	});

	test("a crash after the grant commit: the outbox delivers the cancel from the next instance", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 1000 }, workspaceFaults: [{ point: "cancel:before", mode: "abort" }] });
		const runId = await post(w, [LIST_INBOX, LIST_INBOX, LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		await expect(w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {})).rejects.toThrow();
		// The change was saved in the transaction that wrote the cancel.
		const access = await w.ws.getAccess(CALLER, w.connectionId);
		expect(access.ok && access.value.grants.map((grant) => grant.actions)).toEqual([["read"]]);
		await until(async () => {
			await runDurableObjectAlarm(w.ws).catch(() => false);
			return (await w.conversation.getRun(CALLER, runId)) as RunHead;
		}, (run) => run.status === "cancelled");
		expect(((await w.conversation.getRun(CALLER, runId)) as RunHead).error_message).toBe(STOPPED_PERMISSIONS);
	});

	test("a lost cancel acknowledgement: delivered again within the barrier, and the change answers acknowledged", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 1000 }, workspaceFaults: [{ point: "cancel:lost", mode: "lose" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect((await w.ws.faultFired()).map((entry) => entry.point)).toEqual(["cancel:lost"]);
		expect(((await w.conversation.getRun(CALLER, runId)) as RunHead)).toMatchObject({ status: "cancelled", error_message: STOPPED_PERMISSIONS });
	});

});

/**
 * A start concurrent with a revocation (plan: Testing), each interleaving forced with a held point: the
 * change lands before beginRun (in the snapshot), between beginRun and the start's transaction (a
 * tombstone, above), between the transaction and activation (the cancel finds the stored run), or while the
 * Workspace's cancel is still on its way (activation answers revoked). None writes under the old grants.
 */
describe("a start concurrent with a revocation", () => {
	/** Posts a message whose model writes, and waits until its start is held at `hold`. */
	async function race(w: World, hold: string) {
		const posting = w.conversation.postMessage(CALLER, { content: script([save("Raced"), { text: "Done." }]), attachments: [] });
		await reached(() => w.conversation.faultFired(), hold);
		// In an object, so the post is not awaited here.
		return { posting };
	}

	test("before beginRun: the snapshot has the change, and the write is not offered", async () => {
		const w = await world({ faults: [{ point: "start:begin", mode: "hold" }] });
		const { posting } = await race(w, "start:begin");
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		await w.conversation.faultRelease("start:begin");
		const posted = await posting;
		if (!posted.ok) throw new Error(posted.refusal.detail);
		expect((await settled(w, posted.value.run.id)).status).toBe("completed");
		const internals = await w.conversation.faultRun(posted.value.run.id);
		expect(internals.tools).toEqual([LIST]);
		expect(internals.run).toMatchObject({ revoked: 0 });
		expect((await provider(w)).requests).toEqual([]);
	});

	test("after the start's transaction, before activation: the cancel stops the stored run", async () => {
		const w = await world({ faults: [{ point: "activate:before", mode: "hold" }] });
		const posted = await (await race(w, "activate:before")).posting;
		if (!posted.ok) throw new Error(posted.refusal.detail);
		expect(posted.value.run.status).toBe("queued");
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect((await w.conversation.faultRun(posted.value.run.id)).run).toMatchObject({ status: "cancelled", revoked: 1, error_code: "permissions_changed" });
		await w.conversation.faultRelease("activate:before");
		await sleep(200);
		expect(statuses(await eventsOf(w, posted.value.run.id))).toEqual([{ status: "queued" }, { status: "cancelled", message: STOPPED_PERMISSIONS }]);
		expect((await provider(w)).requests).toEqual([]);
	});

	test("while the cancel is on its way: activation answers revoked, and the run never starts", async () => {
		const w = await world({ faults: [{ point: "activate:before", mode: "hold" }], workspaceFaults: [{ point: "cancel:before", mode: "hold" }] });
		const posted = await (await race(w, "activate:before")).posting;
		if (!posted.ok) throw new Error(posted.refusal.detail);
		const changing = w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		await reached(() => w.ws.faultFired(), "cancel:before");
		// The registry has the run revoked; the Conversation has not heard yet, and asks to activate it.
		await w.conversation.faultRelease("activate:before");
		const stopped = await until(async () => (await w.conversation.faultRun(posted.value.run.id)).run, (run) => run?.status === "cancelled");
		expect(stopped).toMatchObject({ revoked: 1, error_code: "permissions_changed", activated: 1 });
		expect(statuses(await eventsOf(w, posted.value.run.id))).toEqual([{ status: "queued" }, { status: "cancelled", message: STOPPED_PERMISSIONS }]);
		await w.ws.faultRelease("cancel:before");
		const changed = await changing;
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect((await provider(w)).requests).toEqual([]);
	});
});

describe("starts the store refuses", () => {
	test("a snapshot past the 2 MB a value may have is kept in parts, and the run starts", async () => {
		const w = await world();
		await enforceValueLimit(w.conversation);
		// Four more Notes connections with 500 grants each (the limit) on ids of 195 code points (the limit is
		// 200): about 2.5 MB of snapshot, while no API limit is broken.
		const now = Math.floor(Date.now() / 1000);
		for (let c = 0; c < 4; c++) {
			const saved = await w.ws.saveConnection(CALLER, {
				provider: "notes",
				account: { id: `notes-account-extra-${c}`, label: `Extra ${c}` },
				credentials: { kind: "oauth2", access_token: `x-${c}`, refresh_token: `y-${c}`, scopes: ["notes"], expires_at: now + 3600, client_id: NOTES_CLIENT.clientId, token_url: NOTES_TOKEN_URL },
				connectionId: null,
			});
			if (!saved.ok) throw new Error(saved.refusal.detail);
			for (let batch = 0; batch < 5; batch++) {
				const changes = Array.from({ length: 100 }, (_, i) => ({ kind: "folder", id: `${"界".repeat(190)}-${batch}-${i}`, actions: ["read", "create"] }));
				const granted = await w.ws.applyGrantChanges(CALLER, saved.value.id, changes, {});
				if (!granted.ok) throw new Error(granted.refusal.detail);
			}
		}
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId, 20_000)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 })]);
		const stored = await runInDurableObject(w.conversation, (_instance, state) => ({
			column: state.storage.sql.exec<{ bytes: number }>("SELECT length(CAST(snapshot AS BLOB)) AS bytes FROM runs WHERE id = ?", runId).one().bytes,
			parts: state.storage.sql.exec<{ bytes: number }>("SELECT length(CAST(text AS BLOB)) AS bytes FROM run_snapshots WHERE run_id = ? ORDER BY part", runId).toArray().map((row) => row.bytes),
		}));
		expect(stored.column).toBe(0);
		expect(stored.parts.length).toBeGreaterThan(1);
		expect(stored.parts.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(2 * 1024 * 1024);
		expect(Math.max(...stored.parts)).toBeLessThan(2 * 1024 * 1024);
	}, 120_000);

	test("a start whose transaction is refused answers 503, leaves nothing behind and releases its registration", async () => {
		const w = await world();
		const reserved = await w.ws.reserveUpload(CALLER, { name: "a.txt", size: 10 });
		if (!reserved.ok) throw new Error(reserved.refusal.detail);
		const completed = await w.ws.completeUpload(CALLER, reserved.value.id, { sha256: "a".repeat(64) as never, size: 10, mediaType: "text/plain" });
		if (!completed.ok) throw new Error(completed.refusal.detail);
		// Every run row is refused, as the platform refuses one over 2 MB, every time the start is sent.
		await runInDurableObject(w.conversation, (_instance, state) => {
			state.storage.sql.exec("CREATE TRIGGER refuse_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END");
		});
		// No folder takes attachments until step 3, so the refused start here is one without any.
		const first = await w.conversation.postMessage(CALLER, { content: script([{ text: "Hi." }]), attachments: [] });
		expect(first).toEqual({ ok: false, refusal: { status: 503, detail: START_FAILED } });
		const inside = await runInDurableObject(w.conversation, (_instance, state) => ({
			starts: state.storage.sql.exec("SELECT run_id FROM starts").toArray().length,
			runs: state.storage.sql.exec("SELECT id FROM runs").toArray().length,
		}));
		expect(inside).toEqual({ starts: 0, runs: 0 });
		// The Workspace hears it: the registration ends, so no reservation is held for ten minutes.
		const registry = await until(
			() => runInDurableObject(w.ws, (_instance, state) => state.storage.sql.exec<{ state: string; end_status: string | null }>("SELECT state, end_status FROM runs").toArray()),
			(rows) => rows.length === 1 && rows[0]?.state === "ended",
		);
		expect(registry).toEqual([{ state: "ended", end_status: "refused" }]);
		// The conversation is not held busy: the next message is refused the same way, then accepted.
		expect(await w.conversation.postMessage(CALLER, { content: script([{ text: "Again." }]), attachments: [] })).toEqual(first);
		await runInDurableObject(w.conversation, (_instance, state) => {
			state.storage.sql.exec("DROP TRIGGER refuse_runs");
		});
		const runId = await post(w, [{ text: "Accepted." }]);
		expect((await settled(w, runId)).status).toBe("completed");
	});

	test("a resumed start refused as revoked releases its registration and its uploads", async () => {
		const w = await world({ faults: [{ point: "start:copy", mode: "hold" }] });
		const reserved = await w.ws.reserveUpload(CALLER, { name: "a.txt", size: 10 });
		if (!reserved.ok) throw new Error(reserved.refusal.detail);
		const completed = await w.ws.completeUpload(CALLER, reserved.value.id, { sha256: "a".repeat(64) as never, size: 10, mediaType: "text/plain" });
		if (!completed.ok) throw new Error(completed.refusal.detail);
		const posting = w.conversation.postMessage(CALLER, { content: "With a file.", attachments: [reserved.value.id] }).catch(() => null);
		await reached(() => w.conversation.faultFired(), "start:copy");
		const changed = await w.ws.applyGrantChanges(CALLER, w.connectionId, READ_ONLY, {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		// The Conversation dies while its start waits between beginRun and the transaction; its next instance
		// sends beginRun again, which the Workspace refuses, as it revoked the run meanwhile.
		await abortAllDurableObjects();
		await posting;
		await until(
			async () => {
				await w.conversation.getConversation(CALLER);
				return runInDurableObject(w.conversation, (_instance, state) => state.storage.sql.exec("SELECT run_id FROM starts").toArray().length);
			},
			(count) => count === 0,
		);
		const registry = await until(
			() =>
				runInDurableObject(w.ws, (_instance, state) => ({
					runs: state.storage.sql.exec<{ state: string; revoked: string | null }>("SELECT state, revoked FROM runs").toArray(),
					uploads: state.storage.sql.exec<{ run_id: string | null }>("SELECT run_id FROM uploads WHERE id = ?", reserved.value.id).toArray(),
				})),
			(state) => state.runs[0]?.state === "ended",
		);
		expect(registry).toEqual({ runs: [{ state: "ended", revoked: "permissions_changed" }], uploads: [{ run_id: null }] });
		expect((await w.conversation.getConversation(CALLER))?.runs).toEqual([]);
		// The file can be attached again at once, not only after the ten-minute expiry.
		const again = await w.ws.beginRun({ runId: uuid7(), conversationId: w.conversationId, userId: USER, agentId: w.agentId, uploadIds: [reserved.value.id], folder: { bytes: 0, entries: 0 } });
		expect(again.ok).toBe(true);
	});
});

describe("the test build's network", () => {
	test("reaches only the fake provider: any other host is refused before anything is sent", async () => {
		const send = providerFetch(env, uuid7());
		await expect(send("https://api.todoist.com/api/v1/projects")).rejects.toThrow(NOT_FAKE);
		await expect(send("https://notes.fake.invalid.example/folders")).rejects.toThrow(NOT_FAKE);
	});
});

/** The restart marker of each attempt the gate gave the run. */
function restarts(events: RunEvent[]): number[] {
	return statuses(events).flatMap((data) => ("attempt" in data && typeof data.attempt === "number" ? [data.attempt] : []));
}

function reads(requests: { method: string; path: string }[]): number {
	return requests.filter((request) => request.method === "GET" && request.path === "/folders/inbox/notes").length;
}

describe("attempts", () => {
	test("a crash in a safe tool: the read runs again in attempt 2, under the same call", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, [LIST_INBOX, { text: "Two notes." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(reads((await provider(w)).requests)).toBe(2);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.executions).toEqual([{ call_id: expect.any(String), executions: 2 }]);
		expect(internals.attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "completed" },
		]);
		// Each attempt's read reached the provider and is recorded, the first one before its instance died.
		expect(toolCalls(events)).toEqual([expect.objectContaining({ tool: LIST, decision: "allowed" }), expect.objectContaining({ tool: LIST, decision: "allowed" })]);
	});

	test("a crash in an unsafe tool after its write settled: never replayed; the model's retry is answered from the ledger", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: SAVE }] });
		// The retry spells the same write differently: stripped values, and `meta`'s keys (free-form, so their
		// order survives validation) in another order, make the same key, which is sorted at every depth.
		const first: FakeTurn = { tools: [{ name: SAVE, arguments: { folder: "inbox", title: "Once only", meta: { a: "1", b: "2" } } }] };
		const retry: FakeTurn = { tools: [{ name: SAVE, arguments: { meta: { b: "2", a: " 1" }, title: "  Once only ", folder: "inbox" } }] };
		const runId = await post(w, [first, retry, { text: "Saved once." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Once only"]);
		const calls = toolCalls(events);
		// The write is recorded when it settled, before the crash; the retry is a repeat with the same write id.
		expect(calls).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" }), expect.objectContaining({ tool: SAVE, decision: "allowed", repeat: true })]);
		expect(calls[0]).not.toHaveProperty("repeat");
		expect((calls[1] as { write?: string }).write).toBe((calls[0] as { write?: string }).write);
		expect((await w.conversation.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1 })]);
	});

	test("a crash during the model stream: the next attempt asks the model again", async () => {
		const w = await world({ faults: [{ point: "model:delta", mode: "abort", step: 0, delta: 2 }] });
		const runId = await post(w, [{ text: "A sentence long enough for several deltas." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(events.at(-2)).toMatchObject({ type: "message", data: { content: "A sentence long enough for several deltas." } });
	});

	test("resets until the cap: the third attempt's death ends the run as worker_exited, and pi runs nothing after", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST, times: 5 }] });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		const run = await settled(w, runId, 20_000);
		expect(run).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2, 3]);
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		await sleep(500);
		await w.conversation.getRun(CALLER, runId);
		expect(reads((await provider(w)).requests)).toBe(3);
		// The gate stopped pi's live task before pi resumed: one model call (attempt 1's) and one execution of
		// the read per attempt, none after the decision, not even one the refusals would answer.
		expect((await w.conversation.faultRun(runId)).entered).toEqual({ model: 1, tool: 3 });
	});

	test("a crash right after the gate, every time and with nothing synced, still advances the attempts to the cap", async () => {
		// The second fault crashes after each decision without syncing first and keeps no count in SQLite, so
		// only the gate's own sync keeps each attempt: a1, a2, a3, then worker_exited (gate review, major).
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "abort", unsynced: true, times: 6 }] });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		const run = await settled(w, runId, 20_000);
		expect(run).toMatchObject({ status: "failed", error_message: "The worker stopped unexpectedly." });
		expect(restarts(await eventsOf(w, runId))).toEqual([2, 3]);
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		// Only attempt 1 reached the tool: attempts 2 and 3 died before pi resumed.
		expect(reads((await provider(w)).requests)).toBe(1);
	});

	test("a gate that throws runs again on the next event of the same instance, and counts the restart", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:decided", mode: "throw" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Two notes." }]);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		expect(await times(() => w.conversation.faultFired(), "gate:decided")).toBe(1);
		expect(restarts(await eventsOf(w, runId))).toEqual([2]);
		expect((await w.conversation.faultRun(runId)).attempts).toEqual([
			{ attempt: 1, ended: "restarted" },
			{ attempt: 2, ended: "completed" },
		]);
		expect(reads((await provider(w)).requests)).toBe(2);
	});

	test("a run whose deadline passed while the object was away ends timed_out at the gate, with no new attempt", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		await w.ws.faultPlan([], { runTimeoutMs: 3000 });
		const runId = await post(w, [LIST_INBOX, { text: "Never." }]);
		const started = Date.now();
		// Only the provider is watched: a call to the conversation would wake it before its deadline.
		await until(() => provider(w), (state) => state.requests.length > 0);
		await sleep(Math.max(0, started + 4000 - Date.now()));
		const run = await settled(w, runId);
		expect(run).toMatchObject({ status: "timed_out", error_message: "The run took too long." });
		expect(restarts(await eventsOf(w, runId))).toEqual([]);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.run).toMatchObject({ attempt: 1, error_code: "timed_out" });
		expect(internals.attempts).toEqual([{ attempt: 1, ended: "failed" }]);
	});

	test("an eviction between turns is no restart", async () => {
		const w = await world();
		const first = await post(w, [{ text: "One." }]);
		expect((await settled(w, first)).status).toBe("completed");
		await abortAllDurableObjects();
		const second = await post(w, [LIST_INBOX, { text: "Two." }]);
		expect((await settled(w, second)).status).toBe("completed");
		expect(restarts(await eventsOf(w, second))).toEqual([]);
		expect((await w.conversation.faultRun(second)).attempts).toEqual([{ attempt: 1, ended: "completed" }]);
	});

	test("a late call from a replaced attempt is refused by the object's own ports: its write, its count, its lease and its appends", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "lease:before", mode: "note", times: 100 }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const asked = await times(() => w.conversation.faultFired(), "lease:before");
		const set = (status: string) =>
			runInDurableObject(w.conversation, (_instance, state) => {
				state.storage.sql.exec("UPDATE runs SET status = ? WHERE id = ?", status, runId);
			});
		// As the run was while attempt 2 acted, the attempt that died calls in late, through the RunStatePort and
		// CredentialPort this object built for the run's executor.
		await set("running");
		try {
			const late = await w.conversation.faultLateCall(runId, 1, w.connectionId);
			expect(late).toEqual({
				dispatch: { kind: "refused", code: "RUN_ENDED", message: "This run is no longer active." },
				counted: false,
				lease: { refused: "RUN_ENDED", message: "This run is no longer active." },
			});
			// Refused here: the Workspace, which knows runs but not attempts, was not even asked.
			expect(await times(() => w.conversation.faultFired(), "lease:before")).toBe(asked);
			await runInDurableObject(w.conversation, async (_instance, state) => {
				const { RunStore } = await import("../../src/conversation/store.ts");
				const store = new RunStore(state.storage);
				expect(store.isCurrent({ runId, attempt: 2 })).toBe(true);
				expect(store.append(runId, { type: "phase", data: { text: "late" } }, { runId, attempt: 1 })).toBeNull();
			});
		} finally {
			await set("completed");
		}
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ tool_calls: 2 });
	});

	test("an attempt replaced while its lease was being given gets no lease: the Workspace knows runs, not attempts", async () => {
		// The run's own read takes the first lease; the hold catches the next one, the test's.
		const w = await world({ delays: { "GET /folders/inbox/notes": 3000 }, faults: [{ point: "lease:before", mode: "note" }, { point: "lease:before", mode: "hold" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		await until(() => provider(w), (state) => state.requests.length > 0);
		const leasing = w.conversation.faultLease(runId, 1, w.connectionId);
		await until(() => w.conversation.faultFired(), (fired) => fired.filter((entry) => entry.point === "lease:before").length === 2);
		const attempt = (value: number) =>
			runInDurableObject(w.conversation, (_instance, state) => {
				state.storage.sql.exec("UPDATE runs SET attempt = ? WHERE id = ?", value, runId);
			});
		// Attempt 2 takes over while the Workspace is asked; the Workspace still lends to the run.
		await attempt(2);
		await w.conversation.faultRelease("lease:before");
		const lease = await leasing;
		await attempt(1);
		expect(lease).toEqual({ refused: "RUN_ENDED", message: "This run is no longer active." });
		expect(await w.conversation.faultLease(runId, 1, w.connectionId)).toMatchObject({ connectionId: w.connectionId });
		expect((await settled(w, runId)).status).toBe("completed");
	});
});

describe("writes", () => {
	test("applied, then the response lost: uncertain, and every later write of the run pauses", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "lose" }] });
		const runId = await post(w, [save("First"), save("Second"), save("First"), { text: "Stopped writing." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "The write outcome is unknown. Check the provider; further writes in this run are paused." }),
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "A previous write has an unknown outcome. Further writes in this run are paused." }),
			expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." }),
		]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "First"]);
		const internals = await w.conversation.faultRun(runId);
		expect(internals.writes).toEqual([expect.objectContaining({ status: "uncertain" })]);
		expect(internals.run).toMatchObject({ writes_uncertain: 1 });
	});

	test("claimed, then never sent: the crash leaves it dispatched, the gate makes it uncertain, nothing reached the provider", async () => {
		const w = await world({ faults: [{ point: "provider:write:before", mode: "abort" }] });
		const runId = await post(w, [save("Never sent"), save("Never sent"), { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(toolCalls(events)).toEqual([expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." })]);
		expect((await provider(w)).requests.filter((request) => request.method === "POST")).toEqual([]);
		expect((await w.conversation.faultRun(runId)).writes).toEqual([expect.objectContaining({ status: "uncertain", attempt: 1 })]);
	});

	test("a crash while dispatched, after the provider applied it: uncertain at the gate, and the retry under a new call id is refused", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
		const runId = await post(w, [save("Applied once"), save("Applied once"), { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		const events = await eventsOf(w, runId);
		expect(restarts(events)).toEqual([2]);
		expect(toolCalls(events)).toEqual([expect.objectContaining({ decision: "denied", code: "WRITE_UNCERTAIN" })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Applied once"]);
		expect((await w.conversation.faultRun(runId)).run).toMatchObject({ writes_uncertain: 1 });
	});

	test("a write with under 2 s to the run's deadline is not sent, and the run times out", async () => {
		const w = await world();
		await w.ws.faultPlan([], { runTimeoutMs: 4000 });
		// The tool call's arguments stream slowly, so the write is asked for about 3 s into the run, and the
		// answer after it streams past the deadline.
		const turns = [save("Too late"), { text: "An answer that keeps streaming until well after the run's deadline has passed." }];
		const content = JSON.stringify({ fake: { turns, chunkChars: 4, delayMs: 300 } });
		const outcome = await w.conversation.postMessage(CALLER, { content, attachments: [] });
		if (!outcome.ok) throw new Error(outcome.refusal.detail);
		const runId = outcome.value.run.id;
		const run = await settled(w, runId, 15_000);
		expect(run).toMatchObject({ status: "timed_out", error_message: "The run took too long." });
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ decision: "error", code: "TIMED_OUT", message: "The write was not sent because its time ran out." }),
		]);
		expect((await provider(w)).requests.filter((request) => request.method === "POST")).toEqual([]);
		// Not sent, so not applied: forgotten.
		expect((await w.conversation.faultRun(runId)).writes).toEqual([]);
	});
});

describe("refresh", () => {
	test("a crash during a rotating refresh: one refresh with the stored token after the restart, refused, so Needs reconnecting", async () => {
		const w = await world({ expired: true, workspaceFaults: [{ point: "refresh:answered", mode: "abort" }] });
		const runId = await post(w, [LIST_INBOX, LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId))).toEqual([
			expect.objectContaining({ decision: "error", code: "FAILED" }),
			expect.objectContaining({ decision: "error", code: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." }),
		]);
		const state = await provider(w);
		expect(state.requests.filter((request) => request.path === "/token").map((request) => request.status)).toEqual([200, 400]);
		expect(state.rotations).toBe(1);
		// No read used the connection while its refresh was uncertain.
		expect(reads(state.requests)).toBe(0);
		expect(await w.ws.faultConnection(w.connectionId)).toMatchObject({ status: "error", refresh_state: "fresh" });
	});

	test("a crash before the provider heard: the stored token still works, once", async () => {
		const w = await world({ expired: true, workspaceFaults: [{ point: "refresh:before", mode: "abort" }] });
		const runId = await post(w, [LIST_INBOX, LIST_INBOX, { text: "Done." }]);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId)).map((call) => call.decision)).toEqual(["error", "allowed"]);
		const state = await provider(w);
		expect(state.requests.filter((request) => request.path === "/token").map((request) => request.status)).toEqual([200]);
		expect(state.requests.find((request) => request.method === "GET")?.token).toBe("notes-access-1");
		expect(await w.ws.faultConnection(w.connectionId)).toMatchObject({ status: "active", generation: 2, refresh_state: "fresh" });
	});

	test("a reconnect during a refresh: it waits for the refresh in flight, then its credentials replace the refreshed ones", async () => {
		const w = await world({ expired: true, workspaceFaults: [{ point: "refresh:answered", mode: "hold" }] });
		const runId = await post(w, [LIST_INBOX, { text: "Done." }]);
		await reached(() => w.ws.faultFired(), "refresh:answered");
		await providerOf(env, w.ref.id).issue("reconnected-access", "reconnected-refresh");
		const now = Math.floor(Date.now() / 1000);
		const reconnecting = w.ws.saveConnection(CALLER, {
			provider: "notes",
			account: { id: "notes-account-1", label: "Notes account" },
			credentials: { kind: "oauth2", access_token: "reconnected-access", refresh_token: "reconnected-refresh", scopes: ["notes"], expires_at: now + 3600, client_id: "notes-client" },
			connectionId: w.connectionId,
		});
		await sleep(200);
		await w.ws.faultRelease("refresh:answered");
		expect((await reconnecting).ok).toBe(true);
		expect((await settled(w, runId)).status).toBe("completed");
		expect(toolCalls(await eventsOf(w, runId)).map((call) => call.decision)).toEqual(["allowed"]);
		// The refresh stored generation 2, then the reconnect generation 3, whose tokens are lent from now on.
		expect(await w.ws.faultConnection(w.connectionId)).toMatchObject({ status: "active", generation: 3, refresh_state: "fresh" });
		const lease = await w.ws.lease(w.connectionId, { settings: CALLER });
		if ("refused" in lease) throw new Error(lease.message);
		const keys = await EncryptionKeys.parse(env.MINERVA_ENCRYPTION_KEYS);
		expect(await keys.decrypt(credentialBinding(w.ref.id, w.connectionId), lease.sealed)).toMatchObject({ access_token: "reconnected-access", refresh_token: "reconnected-refresh" });
		expect((await provider(w)).requests.filter((request) => request.path === "/token")).toHaveLength(1);
	});
});
