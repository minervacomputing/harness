// Starting a run in the Workspace (ARCHITECTURE.md: Starting a run), over node:sqlite: beginRun's
// checks in order with their messages, the snapshot, idempotency, reservations, activation and
// its answers, release, expiry, the run index, and the fault cases: a crash inside beginRun, a lost
// activate answer, a revoke before the run exists and one between beginRun and activation.

import { describe, expect, test } from "vitest";
import { SAFETY_INSTRUCTIONS } from "../../src/gateway/tools.ts";
import { splitParts } from "../../src/lib/text.ts";
import { START_FAILED } from "../../src/conversation/events.ts";
import { NOT_FOUND, START_TTL_MS } from "../../src/workspace/core.ts";
import type { RefusalCode } from "../../src/shared/rpc.ts";
import {
	ADA,
	GRACE,
	USER,
	WORKSPACE,
	attach,
	begin,
	connectMixed,
	conversation,
	defaultAgent,
	grant,
	harness,
	outbox,
	registered,
	running,
	type Harness,
} from "./workspace-support.ts";

/** An upload Ada (or `caller`) has finished sending. */
async function uploaded(h: Harness, name = "notes.txt", size = 9, caller = ADA): Promise<string> {
	const reserved = await h.core.reserveUpload(caller, { name, size });
	if (!reserved.ok) throw new Error(reserved.refusal.detail);
	const completed = await h.core.completeUpload(caller, reserved.value.id, { sha256: "a".repeat(64), size, mediaType: "text/plain" });
	if (!completed.ok) throw new Error(completed.refusal.detail);
	return reserved.value.id;
}

async function withTools(h: Harness, actions: string[] = ["read", "create"]): Promise<string> {
	const id = await connectMixed(h, { scopes: ["files", "labels"] });
	await attach(h, await defaultAgent(h), [id]);
	await grant(h, id, { inbox: actions });
	return id;
}

describe("beginRun", () => {
	test("snapshots the policy, the tools and the instructions, and registers the run", async () => {
		const h = await harness();
		const connection = await withTools(h);
		const { input, answer } = await begin(h);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		const { snapshot, uploads } = answer.value;
		expect(uploads).toEqual([]);
		expect(snapshot.permissions.map((layer) => layer.name)).toEqual(["ceiling", "user", "agent"]);
		expect(snapshot.tools.map((tool) => tool.name)).toEqual(["mixed_list_folders", "mixed_copy_file"]);
		expect(snapshot.connectionIds).toEqual([connection]);
		expect(snapshot).toMatchObject({ workspaceId: WORKSPACE, conversationId: input.conversationId, userId: USER, modelAlias: "default", deadline: null, createdAt: h.timers.now() });
		expect(snapshot.instructions).toBe(`${SAFETY_INSTRUCTIONS}\nThe run started on Monday, 2026-10-12 14:03 UTC.\n\nYou are a helpful, concise assistant.`);
		expect(registered(h, input.runId)).toEqual({ state: "starting", revoked: null });
		expect(await h.core.locateRun(ADA, input.runId)).toEqual({ conversationId: input.conversationId });
		expect(await h.core.locateRun(GRACE, input.runId)).toBeNull();
	});

	test("without create, the write is not offered; without grants, nothing is", async () => {
		const h = await harness();
		await withTools(h, ["read"]);
		const read = await begin(h);
		expect(read.answer.ok && read.answer.value.snapshot.tools.map((tool) => tool.name)).toEqual(["mixed_list_folders"]);
		const bare = await harness();
		await attach(bare, await defaultAgent(bare), [await connectMixed(bare, {})]);
		const none = await begin(bare);
		expect(none.answer.ok && none.answer.value.snapshot.tools).toEqual([]);
	});

	test("stored scopes decide consent: unknown passes, none known fails", async () => {
		const tools = async (scopes: string[] | null) => {
			const h = await harness();
			const id = await connectMixed(h, { scopes });
			await attach(h, await defaultAgent(h), [id]);
			await h.core.applyGrantChanges(ADA, id, [{ kind: "label", id: "red", actions: ["read"] }], {});
			const { answer } = await begin(h);
			return answer.ok ? answer.value.snapshot.tools.map((tool) => tool.name) : [];
		};
		expect(await tools(null)).toEqual(["mixed_list_labels"]);
		expect(await tools([])).toEqual([]);
		expect(await tools(["files"])).toEqual([]);
		expect(await tools(["labels"])).toEqual(["mixed_list_labels"]);
	});

	test("the deadline is fixed at start from the run timeout", async () => {
		const h = await harness({ settings: { runTimeoutMs: 60_000 } });
		const { answer } = await begin(h);
		expect(answer.ok && answer.value.snapshot.deadline).toBe(h.timers.now() + 60_000);
	});

	test("called again with the same run id, it returns the same answer and registers nothing more", async () => {
		const h = await harness();
		await withTools(h);
		const upload = await uploaded(h);
		const first = await begin(h, { uploadIds: [upload] });
		await h.timers.advance(1000);
		const again = await h.core.beginRun(first.input);
		expect(again).toEqual(first.answer);
		expect(h.sql.exec("SELECT count(*) AS n FROM runs")).toEqual([{ n: 1 }]);
		// After a restart too.
		h.restart();
		expect(await h.core.beginRun(first.input)).toEqual(first.answer);
	});

	test("refusals carry their statuses and messages, in order, and leave nothing behind", async () => {
		const h = await harness();
		const theirs = await conversation(h, GRACE);
		const mine = await conversation(h);
		const pending = await h.core.reserveUpload(ADA, { name: "half.txt", size: 3 });
		const foreign = await uploaded(h, "theirs.txt", 1, GRACE);
		// One after the other: at most three may be arriving at once.
		const ids: string[] = [];
		for (let i = 0; i < 11; i++) ids.push(await uploaded(h, `f${i}.txt`, 1));
		const cases: [Parameters<typeof begin>[1], RefusalCode, string][] = [
			[{ conversationId: theirs }, "NOT_FOUND", NOT_FOUND],
			[{ uploadIds: ids }, "TOO_MANY_ATTACHMENTS", "Attach at most 10 files to a message."],
			[{ uploadIds: [...ids.slice(0, 9), ids[0] as string, ids[0] as string] }, "TOO_MANY_ATTACHMENTS", "Attach at most 10 files to a message."],
			[{ uploadIds: [ids[0] as string, ids[0] as string] }, "ATTACHED_TWICE", "A file is attached twice."],
			[{ uploadIds: [foreign] }, "ATTACHMENT_UNAVAILABLE", "An attached file is no longer available. Remove it and attach it again."],
			[{ uploadIds: [pending.ok ? pending.value.id : ""] }, "ATTACHMENT_UNAVAILABLE", "An attached file is no longer available. Remove it and attach it again."],
			[{ uploadIds: ["0199a000-0000-7000-8000-0000000000ff"] }, "ATTACHMENT_UNAVAILABLE", "An attached file is no longer available. Remove it and attach it again."],
			[{ uploadIds: [ids[0] as string], folder: { bytes: 0, entries: 10_000 } }, "FOLDER_FULL", "These files would put more than 10,000 files and folders in this conversation's folder."],
			[{ uploadIds: [ids[0] as string], folder: { bytes: 268_435_456, entries: 10_000 } }, "FOLDER_FULL", "These files would put more than 10,000 files and folders in this conversation's folder."],
			[{ uploadIds: [ids[0] as string], folder: { bytes: 268_435_456 - 4095, entries: 0 } }, "FOLDER_FULL", "These files would make this conversation's folder larger than 256 MB."],
		];
		for (const [options, code, detail] of cases) {
			const { input, answer } = await begin(h, { conversationId: mine, ...options });
			expect(answer, detail).toEqual({ ok: false, refusal: { code, detail } });
			expect(registered(h, input.runId)).toBeNull();
		}
		expect(h.sql.exec("SELECT count(*) AS n FROM uploads WHERE run_id IS NOT NULL")).toEqual([{ n: 0 }]);
		expect(h.sql.exec("SELECT count(*) AS n FROM run_answers")).toEqual([{ n: 0 }]);
		// Exactly at the limits is fine: one more page, one more entry.
		const fits = await begin(h, { conversationId: mine, uploadIds: [ids[0] as string], folder: { bytes: 268_435_456 - 4096, entries: 9_999 } });
		expect(fits.answer.ok).toBe(true);
	});

	test("the size limit's message follows the setting (size_text)", async () => {
		for (const [bytes, text] of [
			[100 * 2 ** 20, "100 MB"],
			[2 * 2 ** 30, "2 GB"],
			[300_000_000, "286.102 MB"],
		] as const) {
			const h = await harness({ settings: { folderBytes: bytes } });
			const upload = await uploaded(h, "big.bin", 1);
			const { answer } = await begin(h, { uploadIds: [upload], folder: { bytes, entries: 0 } });
			expect(answer).toEqual({ ok: false, refusal: { code: "FOLDER_FULL", detail: `These files would make this conversation's folder larger than ${text}.` } });
		}
	});

	test("reserved uploads, in the order the message named them", async () => {
		const h = await harness();
		const second = await uploaded(h, "data.csv", 4);
		const first = await uploaded(h, "notes.txt", 9);
		const { input, answer } = await begin(h, { uploadIds: [first, second] });
		expect(answer.ok && answer.value.uploads).toEqual([
			{ id: first, name: "notes.txt", size: 9, mediaType: "text/plain", sha256: "a".repeat(64), key: `uploads/${WORKSPACE}/${USER}/${first}` },
			{ id: second, name: "data.csv", size: 4, mediaType: "text/plain", sha256: "a".repeat(64), key: `uploads/${WORKSPACE}/${USER}/${second}` },
		]);
		// Another start cannot attach what this one reserved, until this one lets go.
		const other = await begin(h, { uploadIds: [first] });
		expect(other.answer).toMatchObject({ ok: false, refusal: { code: "ATTACHMENT_UNAVAILABLE" } });
		await h.core.release(input.runId, "refused");
		expect((await begin(h, { uploadIds: [first] })).answer.ok).toBe(true);
	});

	test("a conversation that was deleted, or whose agent changed, starts nothing", async () => {
		const h = await harness();
		const chat = await conversation(h);
		await h.core.deleteConversation(ADA, chat);
		expect((await begin(h, { conversationId: chat })).answer).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
		const live = await conversation(h);
		const { input } = await begin(h, { conversationId: live });
		expect(await h.core.beginRun({ ...input, runId: "0199a000-0000-7000-9000-00000000ffff", agentId: "0199a000-0000-7000-8000-0000000000ff" })).toMatchObject({ ok: false, refusal: { code: "NOT_FOUND" } });
	});

	test("a crash inside beginRun leaves nothing behind", async () => {
		const h = await harness();
		const connection = await withTools(h);
		const upload = await uploaded(h);
		// A stored row the snapshot cannot read makes beginRun throw after its checks.
		h.sql.exec("UPDATE grants SET actions = 'not json' WHERE connection_id = ?", connection);
		const chat = await conversation(h);
		await expect(begin(h, { conversationId: chat, uploadIds: [upload] })).rejects.toThrow();
		expect(h.sql.exec("SELECT count(*) AS n FROM runs")).toEqual([{ n: 0 }]);
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: null }]);
	});

	test("a large answer is stored in parts and returned whole", async () => {
		const h = await harness();
		const connection = await withTools(h);
		const layer = `user:${USER}`;
		for (let i = 0; i < 1500; i++) {
			h.sql.exec("INSERT INTO grants (layer_id, connection_id, kind, resource_id, actions, effect) VALUES (?, ?, 'folder', ?, '[\"create\",\"read\"]', 'allow')", layer, connection, `${"é".repeat(190)}${i}`);
		}
		const { input, answer } = await begin(h);
		expect(h.sql.exec<{ n: number }>("SELECT count(*) AS n FROM run_answers WHERE run_id = ?", input.runId)[0]?.n).toBeGreaterThan(1);
		expect(await h.core.beginRun(input)).toEqual(answer);
		expect(splitParts("ab😀cd", 3)).toEqual(["ab", "😀c", "d"]);
		expect(splitParts("", 3)).toEqual([]);
		expect(() => splitParts("x", 1)).toThrow(RangeError);
	});
});

describe("activation", () => {
	test("consumes the reservations: the upload rows go, their objects are deleted, once", async () => {
		const h = await harness();
		const upload = await uploaded(h);
		const { input } = await begin(h, { uploadIds: [upload] });
		expect(await h.core.activate(input.runId)).toEqual({ state: "active" });
		expect(h.sql.exec("SELECT count(*) AS n FROM uploads")).toEqual([{ n: 0 }]);
		// The answer was lost: asked again, it answers the same and consumes nothing more.
		expect(await h.core.activate(input.runId)).toEqual({ state: "active" });
		expect(h.core.nextWake()).toBe(h.timers.now());
		await h.core.alarm();
		expect(h.objects.deleted).toEqual([`uploads/${WORKSPACE}/${USER}/${upload}`]);
		h.restart();
		expect(await h.core.activate(input.runId)).toEqual({ state: "active" });
		await h.core.alarm();
		expect(h.objects.deleted).toHaveLength(1);
	});

	test("answers where the registration stands: revoked with its reason, expired, ended", async () => {
		const h = await harness();
		const connection = await withTools(h);
		const revoked = await begin(h);
		await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(await h.core.activate(revoked.input.runId)).toEqual({ state: "revoked", reason: "permissions_changed" });
		const ended = await running(h);
		await h.core.release(ended.input.runId, "completed");
		expect(await h.core.activate(ended.input.runId)).toEqual({ state: "ended" });
		expect(await h.core.activate("0199a000-0000-7000-9000-0000000fffff")).toEqual({ state: "expired" });
	});

	test("a start not activated within ten minutes expires: its uploads are attachable again, a late answer cannot start it", async () => {
		const h = await harness();
		const upload = await uploaded(h);
		const { input } = await begin(h, { uploadIds: [upload] });
		expect(h.core.nextWake()).toBe(h.timers.now() + START_TTL_MS);
		await h.timers.advance(START_TTL_MS - 1);
		await h.core.alarm();
		expect(registered(h, input.runId)?.state).toBe("starting");
		await h.timers.advance(1);
		await h.core.alarm();
		expect(registered(h, input.runId)?.state).toBe("expired");
		expect(await h.core.activate(input.runId)).toEqual({ state: "expired" });
		expect(await h.core.beginRun(input)).toEqual({ ok: false, refusal: { code: "START_FAILED", detail: START_FAILED } });
		expect((await begin(h, { uploadIds: [upload] })).answer.ok).toBe(true);
	});

	test("a start past its ten minutes is expired when it is asked about, even before the alarm ran", async () => {
		const h = await harness();
		const upload = await uploaded(h);
		const late = await begin(h, { uploadIds: [upload] });
		const repeated = await begin(h);
		await h.timers.advance(START_TTL_MS);
		expect(await h.core.activate(late.input.runId)).toEqual({ state: "expired" });
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: null }]);
		expect(await h.core.beginRun(repeated.input)).toEqual({ ok: false, refusal: { code: "START_FAILED", detail: START_FAILED } });
		expect(registered(h, repeated.input.runId)?.state).toBe("expired");
	});

	test("an activated run is not expired, and survives a restart", async () => {
		const h = await harness();
		const { input } = await running(h);
		h.restart();
		await h.timers.advance(START_TTL_MS * 2);
		await h.core.alarm();
		expect(registered(h, input.runId)).toEqual({ state: "active", revoked: null });
		expect(await h.core.activate(input.runId)).toEqual({ state: "active" });
	});
});

describe("release and the run index", () => {
	test("a released run leaves the registry but stays addressable; a refused start lets its uploads go", async () => {
		const h = await harness();
		const upload = await uploaded(h);
		const { input } = await begin(h, { uploadIds: [upload] });
		await h.core.release(input.runId, "refused");
		expect(registered(h, input.runId)?.state).toBe("ended");
		expect(h.sql.exec("SELECT run_id FROM uploads")).toEqual([{ run_id: null }]);
		expect(await h.core.locateRun(ADA, input.runId)).toEqual({ conversationId: input.conversationId });
		expect(await h.core.beginRun(input)).toEqual({ ok: false, refusal: { code: "START_FAILED", detail: START_FAILED } });
		// Releasing again, or an unknown run, changes nothing.
		await h.core.release(input.runId, "completed");
		await h.core.release("0199a000-0000-7000-9000-0000000fffff", "completed");
		expect(h.sql.exec("SELECT end_status FROM runs")).toEqual([{ end_status: "refused" }]);
	});

	test("a run of a deleted conversation is not found", async () => {
		const h = await harness();
		const { input } = await running(h);
		await h.core.deleteConversation(ADA, input.conversationId);
		expect(await h.core.locateRun(ADA, input.runId)).toBeNull();
	});
});

describe("revocation racing a start", () => {
	test("a grant change before the run exists is in its snapshot, and revokes nothing", async () => {
		const h = await harness();
		const connection = await withTools(h);
		await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "inbox", actions: [] }], {});
		const { input, answer } = await begin(h);
		expect(answer.ok && answer.value.snapshot.tools).toEqual([]);
		expect(registered(h, input.runId)).toEqual({ state: "starting", revoked: null });
		expect(outbox(h)).toEqual([]);
	});

	test("one between beginRun and activation revokes it: the cancel leaves a tombstone, activation answers revoked", async () => {
		const h = await harness();
		const connection = await withTools(h);
		const { input } = await begin(h);
		const changed = await h.core.applyGrantChanges(ADA, connection, [{ kind: "folder", id: "inbox", actions: ["read"] }], {});
		expect(changed.ok && changed.value.revocation).toBe("acknowledged");
		expect(h.conversations.cancels).toEqual([{ conversationId: input.conversationId, runId: input.runId, reason: "permissions_changed", entryId: 1 }]);
		expect(outbox(h)).toMatchObject([{ run_id: input.runId, ack_state: "tombstoned" }]);
		// A Conversation that retries its start learns it was revoked; one that stored it learns on activation.
		expect(await h.core.beginRun(input)).toEqual({ ok: false, refusal: { code: "RUN_STOPPED", detail: "Stopped because permissions changed." } });
		expect(await h.core.activate(input.runId)).toEqual({ state: "revoked", reason: "permissions_changed" });
	});
});
