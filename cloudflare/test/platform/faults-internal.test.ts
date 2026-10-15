// Laravel's commands through the test build's driver (src/faults/routes.ts): /api/faults/internal/ serves the internal API
// behind the faults token instead of Access, and a run it starts is read with `faultView`, a page at a time. A conversation's
// fault plan sets the deadline of the runs Laravel starts in it.

import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type StartRun, engine } from "@minerva/contract/internal";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { beforeAll, expect, test } from "vitest";
import { PAGE_LIMIT } from "../../src/conversation/store.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { heldRun } from "../../src/faults/world.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { ORIGIN, commands, objectOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";

signedAssertions();

beforeAll(() => {
	PORTS.factory = () => faultConversationPorts(defaultPorts);
});

const token = () => faultsToken(env.MINERVA_SECRET_KEY);

/** Laravel's client as the account tests' driver builds one: the contract's commands at /api/faults, with the faults token. */
const driven: JsonifiedClient<ContractRouterClient<typeof engine>> = createORPCClient(
	new OpenAPILink(engine, {
		url: `${ORIGIN}/api/faults`,
		fetch: async (request) => {
			const headers = new Headers(request.headers);
			headers.set(FAULTS_HEADER, await token());
			return exports.default.fetch(new Request(request, { headers }));
		},
	}),
);

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

/** A start of a conversation the workspace's hosted fake Laravel holds, which the fake model answers with `script`. */
async function hostedStart(script: FakeScript): Promise<StartRun> {
	const start = startOf(scope(), { message: { id: uuid7(), content: JSON.stringify({ fake: script }), attachments: [] } });
	const provider = providerOf(env, start.scope.workspace);
	await provider.reset();
	await provider.laravelHold(start.run, heldRun(start));
	return start;
}

/** The run's view once it has ended. */
function ended(start: StartRun) {
	return until(
		() => viewOf(objectOf(start), start.run),
		(view) => view.head !== null && !["queued", "provisioning", "running"].includes(view.head.status),
	);
}

test("with the faults token, the catalog is the one Access's callers get", async () => {
	expect(await driven.catalog()).toEqual(await commands.catalog());
});

test("without the faults token, or with another, the forwarded internal API is not served", async () => {
	for (const headers of [new Headers(), new Headers({ [FAULTS_HEADER]: "0".repeat(64) })]) {
		const response = await exports.default.fetch(new Request(`${ORIGIN}/api/faults/internal/v1/catalog`, { headers }));
		expect(response.status).toBe(404);
	}
	// The Worker's API refuses a POST without its own origin before it looks for a route.
	const start = await hostedStart({ turns: [{ text: "Never." }] });
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}/api/faults/internal/v1/runs/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(start) }),
	);
	expect(response.status).toBe(403);
	expect(await objectOf(start).faultView(start.run)).toMatchObject({ head: null, events: [] });
});

test("a start through the driver is accepted, and its run is read a page of events at a time", async () => {
	const start = await hostedStart({ turns: [{ text: "Done." }] });
	expect(await driven.startRun(start)).toMatchObject({ outcome: "accepted" });
	const { head } = await ended(start);
	expect(head).toMatchObject({ id: start.run, status: "completed" });
	// More events than a page holds, committed after the run ended.
	const appended = PAGE_LIMIT + 200;
	await runInDurableObject(objectOf(start), (_instance, state) => {
		for (let index = 0; index < appended; index++) {
			const seq = state.storage.sql.exec<{ event_seq: number }>("UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq", start.run).one().event_seq;
			state.storage.sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, 'phase', ?, ?)", start.run, seq, JSON.stringify({ text: `Phase ${seq}` }), Date.now());
		}
	});
	const eventSeq = (head?.eventSeq ?? 0) + appended;
	const view = await viewOf(objectOf(start), start.run);
	expect(view.head?.eventSeq).toBe(eventSeq);
	expect(view.events.map((event) => event.seq)).toEqual(Array.from({ length: eventSeq }, (_value, index) => index + 1));
	expect(view.events.at(-1)).toEqual({ seq: eventSeq, type: "phase", data: { text: `Phase ${eventSeq}` } });
	expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
	expect((await objectOf(start).faultView(start.run)).events).toHaveLength(PAGE_LIMIT);
	expect((await objectOf(start).faultView(start.run, 1000, 1003)).events.map((event) => event.seq)).toEqual([1001, 1002, 1003]);
});

test("a conversation's plan sets the deadline of the runs Laravel starts in it", async () => {
	// The answer would stream for about ten seconds; the build's setting has no deadline.
	const start = await hostedStart({ turns: [{ text: "a".repeat(160) }], chunkChars: 8, delayMs: 500 });
	await objectOf(start).faultPlan([], { runTimeoutMs: 1500 });
	expect(await driven.startRun(start)).toMatchObject({ outcome: "accepted" });
	const view = await ended(start);
	expect(view.head).toMatchObject({ status: "timed_out", errorMessage: "The run took too long." });
	expect(view.internals.run).toMatchObject({ error_code: "timed_out" });
	const { facts } = await until(
		() => providerOf(env, start.scope.workspace).laravelState(start.conversation),
		(state) => state.facts.some((fact) => fact.type === "run.finished"),
	);
	expect(facts.at(-1)).toMatchObject({ type: "run.finished", data: { status: "timed_out" } });
});
