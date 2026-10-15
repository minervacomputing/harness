// Uploads and bytes in the Workspace (ARCHITECTURE.md: Files), over node:sqlite: an upload is
// recorded pending with a byte reservation before its object is written and complete after; a run start
// reserves it and activation consumes it; alarms delete what was left behind. The workspace's bytes are
// checked after every crash point: they are derived from the rows, so a crash can never leave them wrong.

import { describe, expect, test } from "vitest";
import { NO_ROOM } from "../../src/files/limits.ts";
import { NOT_FOUND } from "../../src/workspace/core.ts";
import { PENDING_UPLOAD_LIFETIME_MS, TOO_MANY_UPLOADS, UPLOAD_LIFETIME_MS, UPLOADING_TOO_MANY } from "../../src/workspace/limits.ts";
import { ADA, GRACE, USER, WORKSPACE, begin, conversation, harness, type Harness } from "./workspace-support.ts";

async function reserve(h: Harness, size: number, caller = ADA, name = "notes.txt") {
	const reserved = await h.core.reserveUpload(caller, { name, size });
	if (!reserved.ok) throw new Error(reserved.refusal.detail);
	return reserved.value;
}

async function complete(h: Harness, id: string, size: number, caller = ADA) {
	const completed = await h.core.completeUpload(caller, id, { sha256: "c".repeat(64), size, mediaType: "text/plain" });
	if (!completed.ok) throw new Error(completed.refusal.detail);
	return completed.value;
}

describe("recording uploads", () => {
	test("pending first, with its key; complete after, idempotently", async () => {
		const h = await harness();
		const { id, key } = await reserve(h, 9);
		expect(key).toBe(`uploads/${WORKSPACE}/${USER}/${id}`);
		expect(h.sql.exec("SELECT state, size FROM uploads")).toEqual([{ state: "pending", size: 9 }]);
		expect(await complete(h, id, 9)).toEqual({ id, name: "notes.txt", size: 9, mediaType: "text/plain" });
		expect(await complete(h, id, 9)).toEqual({ id, name: "notes.txt", size: 9, mediaType: "text/plain" });
		expect(await h.core.completeUpload(GRACE, id, { sha256: "c".repeat(64), size: 9, mediaType: "text/plain" })).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
	});

	test("at most three arriving at once per user; one past the body's deadline is not arriving", async () => {
		const h = await harness();
		for (let i = 0; i < 3; i++) await reserve(h, 1);
		expect(await h.core.reserveUpload(ADA, { name: "x", size: 1 })).toEqual({ ok: false, refusal: { code: "TOO_MANY_UPLOADS_AT_ONCE", detail: UPLOADING_TOO_MANY } });
		expect((await h.core.reserveUpload(GRACE, { name: "x", size: 1 })).ok).toBe(true);
		await h.timers.advance(15 * 60 * 1000);
		expect((await h.core.reserveUpload(ADA, { name: "x", size: 1 })).ok).toBe(true);
	});

	test("at most 30 waiting to be sent per user", async () => {
		const h = await harness();
		for (let i = 0; i < 30; i++) await complete(h, (await reserve(h, 1)).id, 1);
		expect(await h.core.reserveUpload(ADA, { name: "x", size: 1 })).toEqual({ ok: false, refusal: { code: "TOO_MANY_UPLOADS_WAITING", detail: TOO_MANY_UPLOADS } });
		expect((await h.core.reserveUpload(GRACE, { name: "x", size: 1 })).ok).toBe(true);
		const [first] = h.sql.exec<{ id: string }>("SELECT id FROM uploads WHERE user_id = ? ORDER BY id LIMIT 1", USER);
		await h.core.deleteUpload(ADA, first?.id as string);
		expect((await h.core.reserveUpload(ADA, { name: "x", size: 1 })).ok).toBe(true);
	});

	test("names are kept as cleaned, lone surrogates replaced", async () => {
		const h = await harness();
		const { id } = await reserve(h, 1, ADA, "a\ud800.txt");
		expect((await complete(h, id, 1)).name).toBe("a�.txt");
	});
});

describe("the workspace's quota", () => {
	test("reserved when recorded: 11 bytes of 10 are refused, 6 and 4 fit, 1 more does not", async () => {
		const h = await harness({ settings: { workspaceBytes: 10 } });
		expect(await h.core.reserveUpload(ADA, { name: "x", size: 11 })).toEqual({ ok: false, refusal: { code: "WORKSPACE_FULL", detail: NO_ROOM } });
		expect(h.sql.exec("SELECT count(*) AS n FROM uploads")).toEqual([{ n: 0 }]);
		await complete(h, (await reserve(h, 6)).id, 6);
		await reserve(h, 4);
		expect(h.core.usedBytes()).toBe(10);
		expect(await h.core.reserveUpload(ADA, { name: "x", size: 1 })).toEqual({ ok: false, refusal: { code: "WORKSPACE_FULL", detail: NO_ROOM } });
		// Every upload counts, even one with the same 6 bytes as another.
		expect(await h.core.reserveUpload(ADA, { name: "x", size: 6 })).toMatchObject({ ok: false, refusal: { code: "WORKSPACE_FULL" } });
	});

	test("a body larger than reserved is checked again when it completes", async () => {
		const h = await harness({ settings: { workspaceBytes: 10 } });
		const { id } = await reserve(h, 5);
		expect(await h.core.completeUpload(ADA, id, { sha256: "c".repeat(64), size: 11, mediaType: "text/plain" })).toEqual({ ok: false, refusal: { code: "WORKSPACE_FULL", detail: NO_ROOM } });
		expect(await complete(h, id, 8)).toMatchObject({ size: 8 });
		expect(h.core.usedBytes()).toBe(8);
	});

	test("a report older than one the Workspace has seen changes nothing", async () => {
		const h = await harness({ settings: { workspaceBytes: 100 } });
		const chat = await conversation(h);
		expect(await h.core.setConversationBytes(chat, 10, 2)).toEqual({ ok: true });
		// Sent before it by an instance of the conversation that has since reset, and delivered late.
		expect(await h.core.setConversationBytes(chat, 5, 1)).toEqual({ ok: true });
		expect(h.core.usedBytes()).toBe(10);
		// A refused growth is seen too: a report older than it changes nothing either.
		expect(await h.core.setConversationBytes(chat, 101, 4)).toEqual({ ok: false, limit: "workspace" });
		expect(await h.core.setConversationBytes(chat, 7, 3)).toEqual({ ok: true });
		expect(h.core.usedBytes()).toBe(10);
		expect(await h.core.setConversationBytes(chat, 4, 5)).toEqual({ ok: true });
		expect(h.core.usedBytes()).toBe(4);
		// A report without a revision, from a caller older than revisions, cannot undo a revised one.
		expect(await h.core.setConversationBytes(chat, 1)).toEqual({ ok: true });
		expect(h.core.usedBytes()).toBe(4);
	});

	test("conversations report absolute totals: growing past the limit is refused, shrinking never is", async () => {
		const h = await harness({ settings: { workspaceBytes: 100 } });
		const chat = await conversation(h);
		await reserve(h, 30);
		expect(await h.core.setConversationBytes(chat, 70)).toEqual({ ok: true });
		expect(await h.core.setConversationBytes(chat, 70)).toEqual({ ok: true });
		expect(await h.core.setConversationBytes(chat, 71)).toEqual({ ok: false, limit: "workspace" });
		expect(h.core.usedBytes()).toBe(100);
		h.settings.workspaceBytes = 50;
		expect(await h.core.setConversationBytes(chat, 60)).toEqual({ ok: true });
		expect(await h.core.setConversationBytes("0199a000-0000-7000-8000-0000000000ff", 1)).toEqual({ ok: false, limit: "workspace" });
		// A deleted conversation writes nothing new, but may still shrink.
		await h.core.deleteConversation(ADA, chat);
		h.settings.workspaceBytes = null;
		expect(await h.core.setConversationBytes(chat, 61)).toEqual({ ok: false, limit: "workspace" });
	});

	test("without a limit everything fits", async () => {
		const h = await harness();
		expect((await h.core.reserveUpload(ADA, { name: "x", size: 50 * 2 ** 20 })).ok).toBe(true);
	});
});

describe("what is left behind", () => {
	test("a pending upload whose object never completed is deleted after an hour", async () => {
		const h = await harness();
		const { key } = await reserve(h, 9);
		expect(h.core.nextWake()).toBe(h.timers.now() + PENDING_UPLOAD_LIFETIME_MS);
		await h.timers.advance(PENDING_UPLOAD_LIFETIME_MS);
		await h.core.alarm();
		expect(h.objects.deleted).toEqual([key]);
		expect([h.core.usedBytes(), h.core.nextWake()]).toEqual([0, null]);
	});

	test("an unattached upload is deleted a day after it was recorded; one a start reserved waits for the start", async () => {
		const h = await harness();
		const kept = await reserve(h, 1);
		await complete(h, kept.id, 1);
		const dropped = await reserve(h, 1);
		await complete(h, dropped.id, 1);
		await h.timers.advance(UPLOAD_LIFETIME_MS - 60_000);
		const { input } = await begin(h, { uploadIds: [kept.id] });
		await h.timers.advance(60_000);
		await h.core.alarm();
		expect(h.objects.deleted).toEqual([dropped.key]);
		expect(h.sql.exec("SELECT id, run_id FROM uploads")).toEqual([{ id: kept.id, run_id: input.runId }]);
		// Once the start expires, its upload is free again, and its day is over.
		await h.timers.advance(10 * 60 * 1000);
		await h.core.alarm();
		expect(await h.core.activate(input.runId)).toEqual({ state: "expired" });
		expect(h.objects.deleted).toEqual([dropped.key, kept.key]);
	});

	test("deleting: only the caller's own, not one a start reserved; always quiet", async () => {
		const h = await harness();
		const mine = await reserve(h, 1);
		await complete(h, mine.id, 1);
		await h.core.deleteUpload(GRACE, mine.id);
		await h.core.deleteUpload(ADA, "0199a000-0000-7000-8000-0000000000ff");
		expect(h.sql.exec("SELECT count(*) AS n FROM uploads")).toEqual([{ n: 1 }]);
		const { input } = await begin(h, { uploadIds: [mine.id] });
		await h.core.deleteUpload(ADA, mine.id);
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: input.runId }]);
		await h.core.release(input.runId, "refused");
		await h.core.deleteUpload(ADA, mine.id);
		await h.core.alarm();
		expect([h.sql.exec("SELECT count(*) AS n FROM uploads"), h.objects.deleted]).toEqual([[{ n: 0 }], [mine.key]]);
	});

	test("an abandoned upload releases its reservation and its object is deleted", async () => {
		const h = await harness();
		const { id, key } = await reserve(h, 9);
		await h.core.abandonUpload(ADA, id);
		expect(h.core.usedBytes()).toBe(0);
		await h.core.alarm();
		expect(h.objects.deleted).toEqual([key]);
	});

	test("a bucket that refuses a deletion is retried later", async () => {
		const h = await harness();
		const { id, key } = await reserve(h, 9);
		await h.core.abandonUpload(ADA, id);
		h.objects.fails = true;
		await h.core.alarm();
		expect(h.sql.exec("SELECT key, attempts FROM doomed_objects")).toEqual([{ key, attempts: 1 }]);
		expect(h.core.nextWake()).toBe(h.timers.now() + 1000);
		h.objects.fails = false;
		await h.timers.advance(1000);
		await h.core.alarm();
		expect([h.objects.deleted, h.sql.exec("SELECT count(*) AS n FROM doomed_objects")]).toEqual([[key], [{ n: 0 }]]);
	});
});

describe("bytes after every crash point", () => {
	test("recorded, written, completed, reserved by a start, activated: the count is right after a restart at each", async () => {
		const h = await harness({ settings: { workspaceBytes: 100 } });
		const chat = await conversation(h);
		// Recorded; the instance dies before (or after) the Worker wrote the object.
		const { id, key } = await reserve(h, 40);
		h.restart();
		expect(h.core.usedBytes()).toBe(40);
		// Completed.
		await complete(h, id, 40);
		h.restart();
		expect(h.core.usedBytes()).toBe(40);
		// Reserved by a start; the Conversation copies it into its own blobs and reports its total.
		const { input } = await begin(h, { conversationId: chat, uploadIds: [id] });
		h.restart();
		expect(h.core.usedBytes()).toBe(40);
		expect(await h.core.setConversationBytes(chat, 40)).toEqual({ ok: true });
		h.restart();
		expect(h.core.usedBytes()).toBe(80);
		// Activated: the upload is consumed, the conversation's copy remains.
		expect(await h.core.activate(input.runId)).toEqual({ state: "active" });
		h.restart();
		expect(h.core.usedBytes()).toBe(40);
		await h.core.alarm();
		expect(h.objects.deleted).toEqual([key]);
	});

	test("an attachment is counted once while its start copies it", async () => {
		const h = await harness({ settings: { workspaceBytes: 100 } });
		const chat = await conversation(h);
		const { id } = await reserve(h, 60);
		await complete(h, id, 60);
		const { input } = await begin(h, { conversationId: chat, uploadIds: [id] });
		expect(await h.core.setConversationBytes(chat, 60)).toEqual({ ok: true });
		// Its other growth still counts the upload: 60 + 41 would pass 100 once the upload is consumed.
		expect(await h.core.setConversationBytes(chat, 101)).toEqual({ ok: false, limit: "workspace" });
		await h.core.activate(input.runId);
		expect(h.core.usedBytes()).toBe(60);
		expect(await h.core.setConversationBytes(chat, 101)).toEqual({ ok: false, limit: "workspace" });
		expect(await h.core.setConversationBytes(chat, 100)).toEqual({ ok: true });
	});

	test("a start that crashed before activation releases its upload when it expires", async () => {
		const h = await harness({ settings: { workspaceBytes: 100 } });
		const { id } = await reserve(h, 40);
		await complete(h, id, 40);
		await begin(h, { uploadIds: [id] });
		h.restart();
		await h.timers.advance(10 * 60 * 1000);
		await h.core.alarm();
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: null }]);
		expect(h.core.usedBytes()).toBe(40);
	});
});
