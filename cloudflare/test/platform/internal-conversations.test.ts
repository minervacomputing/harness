// Laravel's `folder`, `resolveDownload` and `deleteConversation` in workerd (the app's docs/plans/conversations.md, 12a):
// through the internal mount behind an Access assertion, the recovery index in D1 and the Conversation object, with the fake
// model and the fake Laravel that takes the conversation's facts.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { StartRun } from "@minerva/contract/internal";
import { SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { createApp } from "../../src/http/router.ts";
import { base64url } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { fakeUpstream } from "../../src/model/fake.ts";
import { STREAM_AUDIENCE, STREAM_PURPOSE } from "../../src/stream/token.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { ORIGIN, commands, held, objectOf, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

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

/** An answer that streams for about ten seconds, so the run stays running until it is stopped. */
const SLOW = JSON.stringify({ fake: { turns: [{ text: "a".repeat(160) }], chunkChars: 8, delayMs: 500 } });

interface RunRow {
	status: string;
	error_code: string;
	revoked: number;
	[key: string]: SqlStorageValue;
}

async function runRow(start: StartRun): Promise<RunRow | null> {
	return runInDurableObject(objectOf(start), (_instance, state) => {
		const rows = state.storage.sql.exec<RunRow>("SELECT status, error_code, revoked FROM runs WHERE id = ?", start.run).toArray();
		return rows[0] ?? null;
	});
}

const ACTIVE = ["queued", "provisioning", "running"];

const settled = (start: StartRun) => until(() => runRow(start), (row) => row !== null && !ACTIVE.includes(row.status));

function stage(workspace: string, contents: string): Promise<string> {
	const key = `uploads/${workspace}/${uuid7()}`;
	return env.FILES_EU.put(key, contents).then(() => key);
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads the response to its end, which must come before the timeout. */
async function drained(response: Response, timeout = 5000): Promise<void> {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const deadline = Date.now() + timeout;
	for (;;) {
		const read = await Promise.race([reader.read(), sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
		if (read === null) throw new Error("The stream was not closed.");
		if (read.done) return;
	}
}

const deletedAt = (conversation: string) => env.DB.prepare("SELECT deleted_at FROM recovery_conversations WHERE id = ?").bind(conversation).first<{ deleted_at: number | null }>();

/** A finished conversation whose message attached `report.txt` ("hello"), and the folder's version after its run. */
async function withFile(): Promise<{ start: StartRun; version: string }> {
	const within = scope();
	const staged = await stage(within.workspace, "hello");
	const start = held(fake, startOf(within, { message: { id: uuid7(), content: "Read this", attachments: [{ upload: staged, name: "report.txt", size: 5, mediaType: "text/plain" }] } }));
	await commands.startRun(start);
	await settled(start);
	const folder = await commands.folder({ scope: start.scope, conversation: start.conversation, version: null });
	expect(folder.versionId).not.toBeNull();
	return { start, version: folder.versionId as string };
}

describe("folder", () => {
	test("lists the current folder, and a version by its id", async () => {
		const { start, version } = await withFile();
		const current = await commands.folder({ scope: start.scope, conversation: start.conversation, version: null });
		expect(current).toEqual({ versionId: version, files: [{ path: "report.txt", size: 5, mtime: expect.any(Number) }], dirs: [] });
		expect(await commands.folder({ scope: start.scope, conversation: start.conversation, version })).toEqual(current);
	});

	test("a version the conversation does not hold, an unknown conversation and another scope are refused", async () => {
		const { start } = await withFile();
		expect(await refusalOf(commands.folder({ scope: start.scope, conversation: start.conversation, version: uuid7() }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(await refusalOf(commands.folder({ scope: start.scope, conversation: uuid7(), version: null }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		const other = { ...start.scope, organization: uuid7() };
		expect(await refusalOf(commands.folder({ scope: other, conversation: start.conversation, version: null }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
	});
});

describe("resolveDownload", () => {
	test("answers the file's object, its size, hash and sniffed type", async () => {
		const { start, version } = await withFile();
		const found = await commands.resolveDownload({ scope: start.scope, conversation: start.conversation, version, path: "report.txt" });
		expect(found).toEqual({ outcome: "found", key: expect.stringMatching(new RegExp(`^blobs/${start.scope.workspace}/${start.conversation}/[0-9a-f]{64}/[0-9a-f]{32}$`)), size: 5, sha256: await sha256("hello"), mediaType: "text/plain" });
		if (found.outcome !== "found") throw new Error("Not found.");
		expect(await (await env.FILES_EU.get(found.key))?.text()).toBe("hello");
		// The current folder, when no version is named.
		expect(await commands.resolveDownload({ scope: start.scope, conversation: start.conversation, version: null, path: "report.txt" })).toEqual(found);
	});

	test("a path that is not a file of the version, or a version it does not hold, is missing", async () => {
		const { start, version } = await withFile();
		for (const [at, path] of [
			[version, "other.txt"],
			[version, "REPORT.TXT"],
			[uuid7(), "report.txt"],
		] as const) {
			expect(await commands.resolveDownload({ scope: start.scope, conversation: start.conversation, version: at, path })).toEqual({ outcome: "missing" });
		}
		const other = { ...start.scope, workspace: uuid7() };
		expect(await refusalOf(commands.resolveDownload({ scope: other, conversation: start.conversation, version, path: "report.txt" }))).toMatchObject({ code: "SCOPE_MISMATCH" });
	});

	test("a file whose blob R2 no longer holds is missing, an empty one too", async () => {
		const within = scope();
		const [report, empty] = [await stage(within.workspace, "hello"), await stage(within.workspace, "")];
		const attachments = [
			{ upload: report, name: "report.txt", size: 5, mediaType: "text/plain" },
			{ upload: empty, name: "empty.txt", size: 0, mediaType: "text/plain" },
		];
		const start = held(fake, startOf(within, { message: { id: uuid7(), content: "Read these", attachments } }));
		await commands.startRun(start);
		await settled(start);
		const read = { scope: start.scope, conversation: start.conversation, version: null };
		const blank = await commands.resolveDownload({ ...read, path: "empty.txt" });
		expect(blank).toMatchObject({ outcome: "found", size: 0, sha256: await sha256("") });
		const full = await commands.resolveDownload({ ...read, path: "report.txt" });
		if (blank.outcome !== "found" || full.outcome !== "found") throw new Error("Not found.");
		await env.FILES_EU.delete([blank.key, full.key]);
		expect(await commands.resolveDownload({ ...read, path: "empty.txt" })).toEqual({ outcome: "missing" });
		expect(await commands.resolveDownload({ ...read, path: "report.txt" })).toEqual({ outcome: "missing" });
	});
});

describe("deleteConversation", () => {
	const KEY = new Uint8Array(32).fill(7);
	const streamEnv = { ...env, MINERVA_STREAM_KEYS: `s1:${base64url(KEY, { pad: false })}` } as Env;

	function token(start: StartRun): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ aud: STREAM_AUDIENCE, purpose: STREAM_PURPOSE, env: "test", org: start.scope.organization, conversation: start.conversation, run: start.run })
			.setProtectedHeader({ alg: "HS256", kid: "s1" })
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.sign(KEY);
	}

	async function stream(start: StartRun): Promise<Response> {
		return await createApp().fetch(new Request(`${ORIGIN}/stream/v1`, { headers: { Authorization: `Bearer ${await token(start)}` } }), streamEnv);
	}

	test("stops the active run, refuses the next start, the reads and the stream, and still delivers the run's facts", async () => {
		const { start: earlier, version } = await withFile();
		const start = held(fake, startOf(earlier.scope, { conversation: earlier.conversation, message: { id: uuid7(), content: SLOW, attachments: [] } }));
		await commands.startRun(start);
		await until(() => runRow(start), (row) => row?.status === "running");
		const live = await stream(start);
		expect(live.status).toBe(200);

		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		expect(await runRow(start)).toMatchObject({ status: "cancelled", error_code: "conversation_deleted", revoked: 1 });
		expect((await deletedAt(start.conversation))?.deleted_at).toEqual(expect.any(Number));

		// The open stream is closed by the engine, and a new one is not found.
		await drained(live);
		const again = await stream(start);
		expect(again.status).toBe(404);
		await again.body?.cancel();

		const after = held(fake, startOf(start.scope, { conversation: start.conversation }));
		expect(await commands.startRun(after)).toEqual({ outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." });
		expect(await refusalOf(commands.folder({ scope: start.scope, conversation: start.conversation, version }))).toMatchObject({ code: "NOT_FOUND" });
		expect(await refusalOf(commands.resolveDownload({ scope: start.scope, conversation: start.conversation, version, path: "report.txt" }))).toMatchObject({ code: "NOT_FOUND" });

		// The cancelled run's end still reaches Laravel, which acknowledges it for a tombstone; replay still answers.
		const finished = await until(
			() => fake.facts(start.conversation).filter((fact) => fact.type === "run.finished" && fact.run === start.run),
			(facts) => facts.length === 1,
		);
		expect(finished[0]).toMatchObject({ data: { status: "cancelled" } });
		const replay = await commands.replayFacts({ scope: start.scope, conversation: start.conversation, after: 0, limit: 500 });
		expect(replay.facts.some((fact) => fact.type === "run.finished" && fact.run === start.run)).toBe(true);
		// The folder's blobs stay until retention removes them (chunk 15).
		expect((await env.FILES_EU.list({ prefix: `blobs/${start.scope.workspace}/${start.conversation}/` })).objects).toHaveLength(1);
	});

	test("answers a repeat as the first, without moving the deletion", async () => {
		const { start } = await withFile();
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const first = await deletedAt(start.conversation);
		await sleep(5);
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		expect(await deletedAt(start.conversation)).toEqual(first);
	});

	test("deletes a conversation no command named before, whose start then arrives too late", async () => {
		const start = held(fake, startOf(scope()));
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const row = await env.DB.prepare("SELECT organization_id, workspace_id, deleted_at FROM recovery_conversations WHERE id = ?").bind(start.conversation).first();
		expect(row).toEqual({ organization_id: start.scope.organization, workspace_id: start.scope.workspace, deleted_at: expect.any(Number) });
		expect(await commands.startRun(start)).toEqual({ outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." });
		expect(await runRow(start)).toBeNull();
	});

	test("a deletion that stopped after the index is finished by the next start, which an earlier start's answer still replays past", async () => {
		const { start } = await withFile();
		const accepted = await commands.startRun(start);
		await env.DB.prepare("UPDATE recovery_conversations SET deleted_at = ? WHERE id = ?").bind(Date.now(), start.conversation).run();
		const after = held(fake, startOf(start.scope, { conversation: start.conversation }));
		expect(await commands.startRun(after)).toEqual({ outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." });
		const marked = await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec<{ deleted_at: number | null }>("SELECT deleted_at FROM conversation").one());
		expect(marked.deleted_at).toEqual(expect.any(Number));
		expect(await commands.startRun(start)).toEqual(accepted);
	});

	test("answers a start whose try was lost after its preparation, so the preparation goes", async () => {
		const { start } = await withFile();
		const lost = uuid7();
		await runInDurableObject(objectOf(start), (_instance, state) => {
			state.storage.sql.exec("INSERT INTO internal_starts (run_id, part, text) VALUES (?, 0, '{}')", lost);
		});
		expect(await commands.deleteConversation({ scope: start.scope, conversation: start.conversation })).toEqual({ outcome: "deleted" });
		const left = await runInDurableObject(objectOf(start), (_instance, state) => ({
			prepared: state.storage.sql.exec("SELECT 1 FROM internal_starts").toArray().length,
			answer: state.storage.sql.exec<{ answer: string }>("SELECT answer FROM internal_answers WHERE run_id = ?", lost).one().answer,
		}));
		expect(left.prepared).toBe(0);
		expect(JSON.parse(left.answer)).toMatchObject({ outcome: "refused", code: "CONVERSATION_DELETED" });
	});

	test("in another organization's or workspace's scope changes nothing", async () => {
		const start = held(fake, startOf(scope()));
		await commands.startRun(start);
		await settled(start);
		for (const other of [
			{ ...start.scope, organization: uuid7() },
			{ ...start.scope, workspace: uuid7() },
		]) {
			expect(await refusalOf(commands.deleteConversation({ scope: other, conversation: start.conversation }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		}
		expect((await deletedAt(start.conversation))?.deleted_at).toBeNull();
		const next = held(fake, startOf(start.scope, { conversation: start.conversation }));
		expect(await commands.startRun(next)).toMatchObject({ outcome: "accepted" });
		await settled(next);
	});
});
