// The fake Laravel the test build hosts (src/faults/laravel.ts, provider.ts): a Laravel run whose engine reaches its Laravel
// at the test build's origin leases from the workspace's FaultProvider and delivers its facts there, and what the fake wrote
// before its object was reset survives for the engine's retries.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Fact, StartRun } from "@minerva/contract/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { FakeConnection, LaravelView } from "../../src/faults/laravel.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { FOLDER, heldRun, notesConnection, notesLayers, notesLease } from "../../src/faults/world.ts";
import { LaravelUnreachable, laravelClient } from "../../src/laravel/client.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { commands, notesStart, objectOf, scope, signedAssertions } from "./internal-support.ts";

signedAssertions();

const DELIVERY = { ...FACT_DELIVERY };

beforeAll(() => {
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	// A failed delivery is tried again within a test's time.
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterAll(() => {
	Object.assign(FACT_DELIVERY, DELIVERY);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(50);
	}
}

const LIST = { fake: { turns: [{ tools: [{ name: "notes_list_notes", arguments: { folder: "inbox" } }] }, { text: "Listed." }] } } satisfies { fake: FakeScript };

/** A Laravel run that lists the inbox through a Notes connection Laravel lends as `notesLease()` changed by `lease`, in a fresh workspace. */
async function notesRun(lease: Partial<FakeConnection> = {}) {
	const within = scope();
	const provider = providerOf(env, within.workspace);
	await provider.reset();
	const connectionId = uuid7();
	await provider.laravelConnection(connectionId, { ...notesLease(), ...lease });
	const start = notesStart(within, connectionId, { message: { id: uuid7(), content: JSON.stringify(LIST), attachments: [] } });
	await provider.laravelHold(start.run, heldRun(start));
	return { provider, start, connectionId };
}

/** The fake's view of the conversation once it holds the run's last fact, `run.settled`, through a new stub: a reset breaks the
 * old ones, and a read the reset cuts short fails with the fault's reason, so it counts as nothing held yet. */
function settled(start: StartRun) {
	return until(
		() =>
			providerOf(env, start.scope.workspace)
				.laravelState(start.conversation)
				.catch((error: unknown): LaravelView => {
					if (error instanceof Error && error.message.startsWith("fault: ")) return { facts: [], calls: [], connections: {} };
					throw error;
				}),
		(state) => state.facts.some((fact) => fact.type === "run.settled" && fact.run === start.run),
	);
}

/** The engine's delivery once Laravel's acknowledgement of everything written has reached it. */
function acknowledged(start: StartRun) {
	return until(
		() => runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<{ written: number; acknowledged: number; stopped: string | null }>("SELECT written, acknowledged, stopped FROM fact_delivery").one()),
		(delivery) => delivery.acknowledged === delivery.written,
	);
}

/** What the Notes provider was asked, and answered. */
async function notesRequests(start: StartRun) {
	const { requests } = await providerOf(env, start.scope.workspace).state();
	return requests.map(({ method, path, token, status }) => ({ method, path, token, status }));
}

const LISTED = { method: "GET", path: "/folders/inbox/notes", token: "notes-access-0", status: 200 };

const inOrder = (facts: Fact[]) => facts.map((fact) => fact.seq);
const counted = (facts: Fact[]) => facts.map((_fact, index) => index + 1);

test("a run leases its connection from the hosted fake and delivers its facts there", async () => {
	const { provider, start, connectionId } = await notesRun();
	expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", authorized: [connectionId] });
	const state = await settled(start);
	expect(inOrder(state.facts)).toEqual(counted(state.facts));
	expect(state.facts.at(-2)).toMatchObject({ type: "run.finished", data: { status: "completed" } });
	expect(state.facts.find((fact) => fact.type === "run.tool_call")?.data).toMatchObject({ tool: "notes_list_notes", decision: "allowed" });
	expect(state.calls.filter((call) => call.operation === "leaseToken")).toEqual([{ operation: "leaseToken", run: start.run, connection: connectionId }]);
	// The provider was called with the secret the fake lent, and saw none of Laravel's requests.
	expect(await notesRequests(start)).toEqual([LISTED]);
	expect(await acknowledged(start)).toMatchObject({ written: state.facts.length, acknowledged: state.facts.length, stopped: null });

	await provider.reset();
	expect(await provider.laravelState(start.conversation)).toEqual({ facts: [], calls: [], connections: {} });
});

test("what the fake wrote before its object was reset, and before it answered, is what the engine's retries find", async () => {
	const { provider, start, connectionId } = await notesRun();
	await provider.faultPlan([
		{ point: "laravel:leaseToken", mode: "abort" },
		{ point: "laravel:deliverFacts", mode: "abort" },
	]);
	await commands.startRun(start);
	const state = await settled(start);
	expect((await providerOf(env, start.scope.workspace).faultFired()).map((fired) => fired.point)).toEqual(["laravel:leaseToken", "laravel:deliverFacts"]);
	// The lease was asked again and lent from the same registrations; the delivery the reset cut short was sent again and
	// taken as the repeat it was, so every fact is held once, in order, and the watermark covers them all.
	expect(state.calls.filter((call) => call.operation === "leaseToken")).toHaveLength(2);
	expect(await notesRequests(start)).toEqual([LISTED]);
	expect(state.calls.filter((call) => call.operation === "deliverFacts").length).toBeGreaterThanOrEqual(2);
	expect(inOrder(state.facts)).toEqual(counted(state.facts));
	expect(state.facts.at(-2)).toMatchObject({ type: "run.finished", data: { status: "completed" } });
	expect(state.connections[connectionId]?.status).toBe("active");
	expect(await acknowledged(start)).toMatchObject({ written: state.facts.length, acknowledged: state.facts.length, stopped: null });
});

test("a delivery the reset cut short before its answer is held, and its repeat is acknowledged as the same facts", async () => {
	const { provider, start } = await notesRun();
	await provider.faultPlan([{ point: "laravel:deliverFacts", mode: "abort" }]);
	const facts: Fact[] = [
		{ seq: 1, run: start.run, type: "run.status", at: new Date().toISOString(), data: { status: "provisioning", attempt: 1 } },
		{ seq: 2, run: start.run, type: "run.status", at: new Date().toISOString(), data: { status: "running", attempt: 1 } },
	];
	const batch = { scope: start.scope, conversation: start.conversation, facts };
	await expect(laravelClient(env).deliverFacts(batch)).rejects.toThrow(LaravelUnreachable);
	expect((await providerOf(env, start.scope.workspace).laravelState(start.conversation)).facts).toEqual(facts);
	expect(await laravelClient(env).deliverFacts(batch)).toEqual({ acknowledged: 2 });
	const third = { seq: 3, run: start.run, type: "run.status", at: new Date().toISOString(), data: { status: "running", attempt: 2 } } satisfies Fact;
	expect(await laravelClient(env).deliverFacts({ ...batch, facts: [third] })).toEqual({ acknowledged: 3 });
	expect((await providerOf(env, start.scope.workspace).laravelState(start.conversation)).facts).toEqual([...facts, third]);
});

test("a report the fake marked before its object was reset stays marked", async () => {
	// The provider refuses the lent secret, so the run reports the connection; the reset loses only the report's answer.
	const { provider, start, connectionId } = await notesRun({ secret: "a-revoked-token" });
	await provider.faultPlan([{ point: "laravel:reportUnauthorized", mode: "abort" }]);
	await commands.startRun(start);
	const state = await settled(start);
	expect((await providerOf(env, start.scope.workspace).faultFired()).map((fired) => fired.point)).toEqual(["laravel:reportUnauthorized"]);
	expect(state.calls.filter((call) => call.operation === "reportUnauthorized")).toEqual([{ operation: "reportUnauthorized", run: start.run, connection: connectionId }]);
	expect(state.connections[connectionId]?.status).toBe("error");
	expect(inOrder(state.facts)).toEqual(counted(state.facts));
});

test("an attended run's held call reaches the hosted fake as run.held_call, which it applies whole", async () => {
	const { provider, start, connectionId } = await notesRun();
	const save = { fake: { turns: [{ tools: [{ name: "notes_save_note", arguments: { folder: "inbox", title: "Draft" } }] }, { text: "It waits for your approval." }] } } satisfies { fake: FakeScript };
	const layers = notesLayers(connectionId, [
		{ kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" },
		{ kind: FOLDER, resource: "*", name: "", actions: ["create"], effect: "ask" },
	]);
	const asked = { ...start, attended: true as const, message: { id: uuid7(), content: JSON.stringify(save), attachments: [] }, authority: { connections: [notesConnection(connectionId)], layers } };
	expect(await commands.startRun(asked)).toMatchObject({ outcome: "accepted" });
	const state = await settled(asked);
	expect(inOrder(state.facts)).toEqual(counted(state.facts));
	const held = state.facts.find((fact) => fact.type === "run.held_call");
	const write = held?.type === "run.held_call" ? held.data.write : "";
	expect(held).toEqual({
		seq: expect.any(Number),
		run: asked.run,
		at: expect.any(String),
		type: "run.held_call",
		data: {
			position: 1,
			tool: "notes_save_note",
			label: "Notes: Save a note",
			connection: connectionId,
			provider: "notes",
			operation: "save_note",
			requirements: [{ kind: FOLDER, kindLabel: "Folder", resource: "inbox", name: "Inbox", action: "create", actionLabel: "Create notes", effect: "ask", asked: ["user"] }],
			arguments: '{"folder":"inbox","title":"Draft"}',
			write: expect.stringMatching(/^[0-9a-f]{32}$/),
		},
	});
	expect(state.facts.find((fact) => fact.type === "run.tool_call")?.data).toMatchObject({ tool: "notes_save_note", decision: "denied", code: "APPROVAL_REQUIRED", write });
	expect(state.facts.at(-2)).toMatchObject({ type: "run.finished", data: { status: "completed" } });
	// The hold read the folder's name; the note was never saved.
	expect(await notesRequests(asked)).toEqual([{ method: "GET", path: "/folders", token: "notes-access-0", status: 200 }]);
	expect(await acknowledged(asked)).toMatchObject({ written: state.facts.length, acknowledged: state.facts.length, stopped: null });
	await provider.reset();
});
