// Laravel's `listConversations` in workerd (docs/plans/chunk-15c-design.md, The listing): through the internal mount behind an
// Access assertion, over the recovery index in D1 as the commands and the fake model's turns leave it. Each test names its
// conversations in a block of ids of its own, so a listing from just below the block answers them alone.

import { env } from "cloudflare:workers";
import { INTERNAL_PREFIX, type ListConversations, type StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { markPurged } from "../../src/internal/recovery.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { fakeUpstream } from "../../src/model/fake.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { call, commands, held, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

const DELIVERY = { ...FACT_DELIVERY };
let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	PORTS.factory = () => ({ ...defaultPorts, upstream: () => fakeUpstream() });
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
	Object.assign(FACT_DELIVERY, { backoffMs: 20, maxBackoffMs: 200 });
});

afterEach(() => {
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 8000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(20);
	}
}

/** The `n`th id of a block whose ids start with `prefix` (two hex digits), and the id just below the block. */
const id = (prefix: string, n: number) => `${prefix}000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const below = (prefix: string) => `${prefix}000000-0000-0000-0000-000000000000`;

const list = (input: Omit<ListConversations, "environment">) => commands.listConversations({ environment: "test", ...input });

const factSeq = (conversation: string) =>
	env.DB.prepare("SELECT fact_seq FROM recovery_conversations WHERE id = ?").bind(conversation).first<{ fact_seq: number }>().then((row) => row?.fact_seq);

/** A turn in a conversation of its own, once its settlement reached Laravel and the index holds its last fact's sequence. */
async function turn(conversation: string): Promise<{ start: StartRun; seq: number }> {
	const start = held(fake, startOf(scope(), { conversation }));
	await commands.startRun(start);
	const facts = await until(
		() => fake.facts(conversation),
		(facts) => facts.some((fact) => fact.type === "run.settled" && fact.run === start.run),
	);
	const seq = facts.at(-1)?.seq as number;
	await until(() => factSeq(conversation), (indexed) => indexed === seq);
	return { start, seq };
}

describe("listConversations", () => {
	test("pages through the index in order of id, and from the last id answers the rest", async () => {
		// The highest block, so nothing follows it; bound in another order than the ids'.
		const ids = [3, 1, 5, 2, 4].map((n) => id("ff", n));
		const within = scope();
		for (const conversation of ids) {
			expect(await commands.cancelRun({ scope: within, conversation, run: uuid7(), reason: "cancelled" })).toEqual({ state: "tombstoned" });
		}
		const row = (n: number) => ({ conversation: id("ff", n), organization: within.organization, workspace: within.workspace, factSeq: 0, deletedAt: null, purgedAt: null });

		expect(await list({ after: below("ff"), limit: 2 })).toEqual({ conversations: [row(1), row(2)], more: true });
		expect(await list({ after: id("ff", 2), limit: 2 })).toEqual({ conversations: [row(3), row(4)], more: true });
		expect(await list({ after: id("ff", 4), limit: 2 })).toEqual({ conversations: [row(5)], more: false });
		expect(await list({ after: id("ff", 3), limit: 2 })).toEqual({ conversations: [row(4), row(5)], more: false });
		expect(await list({ after: id("ff", 5), limit: 1000 })).toEqual({ conversations: [], more: false });
	});

	test("with no `after`, starts at the lowest id", async () => {
		const within = scope();
		const lowest = id("00", 0);
		for (const conversation of [id("00", 1), lowest]) {
			expect(await commands.deleteConversation({ scope: within, conversation })).toEqual({ outcome: "deleted" });
		}
		const page = await list({ after: null, limit: 1 });
		expect(page.conversations.map(({ conversation, organization, workspace }) => ({ conversation, organization, workspace }))).toEqual([
			{ conversation: lowest, organization: within.organization, workspace: within.workspace },
		]);
		expect(page.more).toBe(true);
	});

	test("answers a live, a deleted and a purged conversation with their sequences and times", async () => {
		const [live, deleted, purged] = await Promise.all([turn(id("f1", 1)), turn(id("f1", 2)), turn(id("f1", 3))]);
		const deleting = Date.now();
		for (const { start } of [deleted, purged]) {
			expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		}
		const deletedBy = Date.now();
		// As the conversation's retention marks it before it deletes its storage.
		const purgedAt = Date.UTC(2026, 9, 17, 6, 17, 53, 123);
		const { organization, workspace } = purged.start.scope;
		expect(await markPurged(env.DB, { conversation: purged.start.conversation, organization, workspace, now: purgedAt })).toBe(true);

		const page = await list({ after: below("f1"), limit: 3 });
		const entry = ({ start, seq }: { start: StartRun; seq: number }) => ({ conversation: start.conversation, organization: start.scope.organization, workspace: start.scope.workspace, factSeq: seq });
		expect(page.conversations).toEqual([
			{ ...entry(live), deletedAt: null, purgedAt: null },
			{ ...entry(deleted), deletedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), purgedAt: null },
			{ ...entry(purged), deletedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), purgedAt: "2026-10-17T06:17:53.123Z" },
		]);
		for (const conversation of page.conversations.slice(1)) {
			const at = Date.parse(conversation.deletedAt as string);
			expect(at >= deleting && at <= deletedBy, conversation.deletedAt as string).toBe(true);
		}
	});

	test("answers a conversation bound only by its deletion", async () => {
		const within = scope();
		const conversation = id("f2", 1);
		const deleting = Date.now();
		expect(await commands.deleteConversation({ scope: within, conversation })).toEqual({ outcome: "deleted" });
		const page = await list({ after: below("f2"), limit: 1 });
		expect(page.conversations).toEqual([{ conversation, organization: within.organization, workspace: within.workspace, factSeq: 0, deletedAt: expect.any(String), purgedAt: null }]);
		const at = Date.parse(page.conversations[0]?.deletedAt as string);
		expect(at >= deleting && at <= Date.now()).toBe(true);
	});

	test("refuses another environment, a limit of 0 or over 1,000, an `after` that is not an id, and a call without Access", async () => {
		expect(await refusalOf(commands.listConversations({ environment: "staging", after: null, limit: 10 }))).toMatchObject({ code: "WRONG_ENVIRONMENT", status: 409 });
		for (const limit of [0, 1001]) {
			expect(await refusalOf(list({ after: null, limit })), String(limit)).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
		}
		expect(await refusalOf(list({ after: "not-an-id", limit: 10 }))).toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
		const body = JSON.stringify({ environment: "test", after: null, limit: 10 });
		const response = await call(`${INTERNAL_PREFIX}/recovery/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body, client: null });
		expect(response.status).toBe(401);
	});
});
