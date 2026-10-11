// Deleting a conversation or an agent (plan: Files, Deletion; runs 8; web-api 8.3, 8.4), over node:sqlite:
// tombstone first, cancel through the outbox and wait for the acknowledgement, then the Conversation
// object destroys itself, and again an hour later; an alarm finishes a deletion that was interrupted.

import { describe, expect, test } from "vitest";
import { NOT_FOUND, PURGE_AGAIN_MS } from "../../src/workspace/core.ts";
import { ADA, GRACE, begin, conversation, harness, outbox, registered, running, settle, type Harness } from "./workspace-support.ts";

function purge(h: Harness, conversationId: string) {
	return h.sql.exec<{ attempts: number; first_done_at: number | null; done_at: number | null; next_attempt_at: number }>(
		"SELECT attempts, first_done_at, done_at, next_attempt_at FROM purges WHERE conversation_id = ?",
		conversationId,
	)[0];
}

describe("deleting a conversation", () => {
	test("tombstone, cancel and wait, destroy, then destroy again an hour later", async () => {
		const h = await harness();
		const { input } = await running(h);
		await h.core.setConversationBytes(input.conversationId, 4096);
		expect(await h.core.deleteConversation(ADA, input.conversationId)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect(outbox(h)).toMatchObject([{ run_id: input.runId, reason: "cancelled", ack_state: "stopping" }]);
		expect(h.conversations.destroyed).toEqual([input.conversationId]);
		expect(purge(h, input.conversationId)).toMatchObject({ first_done_at: h.timers.now(), done_at: null, next_attempt_at: h.timers.now() + PURGE_AGAIN_MS });
		// Its blobs are gone, so they no longer count.
		expect(h.core.usedBytes()).toBe(0);
		// From the tombstone on, nothing starts in it and it is not listed.
		expect((await begin(h, { conversationId: input.conversationId })).answer).toEqual({ ok: false, refusal: { status: 404, detail: NOT_FOUND } });
		expect(await h.core.listConversations(ADA)).toEqual([]);
		expect(await h.core.deleteConversation(ADA, input.conversationId)).toEqual({ ok: false, refusal: { status: 404, detail: NOT_FOUND } });
		expect(h.core.nextWake()).toBe(h.timers.now() + PURGE_AGAIN_MS);
		await h.timers.advance(PURGE_AGAIN_MS);
		await h.core.alarm();
		expect(h.conversations.destroyed).toEqual([input.conversationId, input.conversationId]);
		expect(purge(h, input.conversationId)?.done_at).toBe(h.timers.now());
		expect(h.core.nextWake()).toBeNull();
	});

	test("nothing is destroyed while the run's cancel is not acknowledged", async () => {
		const h = await harness();
		const { input } = await running(h);
		h.conversations.mode = "hang";
		const deletion = h.core.deleteConversation(ADA, input.conversationId);
		await settle();
		await h.timers.advance(10_000);
		await h.timers.advance(10_000);
		expect(await deletion).toEqual({ ok: true, value: { revocation: "pending" } });
		expect(h.conversations.destroyed).toEqual([]);
		h.conversations.mode = "answer";
		await h.timers.advance(60_000);
		await h.core.alarm();
		expect(outbox(h)).toMatchObject([{ ack_state: "stopping" }]);
		// The purge was retried while the cancel was owed; it runs once it is due again.
		await h.timers.advance(60_000);
		await h.core.alarm();
		expect(h.conversations.destroyed).toEqual([input.conversationId]);
	});

	test("the second deletion waits its hour, even when the request gets to it after the alarm did the first", async () => {
		const h = await harness();
		const { input } = await running(h);
		h.conversations.mode = "fail";
		const deletion = h.core.deleteConversation(ADA, input.conversationId);
		await settle();
		// While the request pauses between attempts, the alarm's purge delivers the cancel and destroys the object.
		h.conversations.mode = "answer";
		await h.core.alarm();
		expect(h.conversations.destroyed).toEqual([input.conversationId]);
		await h.timers.advance(500);
		expect(await deletion).toMatchObject({ ok: true });
		expect(h.conversations.destroyed).toEqual([input.conversationId]);
		expect(purge(h, input.conversationId)?.done_at).toBeNull();
		expect(h.core.nextWake()).toBe((purge(h, input.conversationId)?.first_done_at as number) + PURGE_AGAIN_MS);
	});

	test("an object that cannot be destroyed yet is retried by the alarm, also after a restart", async () => {
		const h = await harness();
		const chat = await conversation(h);
		h.conversations.destroyFails = true;
		expect(await h.core.deleteConversation(ADA, chat)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect(purge(h, chat)).toMatchObject({ attempts: 1, first_done_at: null });
		h.restart();
		h.conversations.destroyFails = false;
		h.conversations.destroyDone = false;
		await h.timers.advance(1000);
		await h.core.alarm();
		expect(purge(h, chat)).toMatchObject({ attempts: 2, first_done_at: null });
		h.conversations.destroyDone = true;
		await h.timers.advance(2000);
		await h.core.alarm();
		expect(purge(h, chat)?.first_done_at).toBe(h.timers.now());
		expect(h.logs.map((log) => log.message)).toContain("A conversation could not be destroyed yet");
	});

	test("a run not stored yet is tombstoned in its Conversation, and its start is refused", async () => {
		const h = await harness();
		const { input } = await begin(h);
		await h.core.deleteConversation(ADA, input.conversationId);
		expect(outbox(h)).toMatchObject([{ reason: "cancelled", ack_state: "tombstoned" }]);
		expect(await h.core.beginRun(input)).toEqual({ ok: false, refusal: { status: 409, detail: "Stopped." } });
		expect(await h.core.activate(input.runId)).toEqual({ state: "revoked", reason: "cancelled" });
	});

	test("only the caller's own", async () => {
		const h = await harness();
		const theirs = await conversation(h, GRACE);
		expect(await h.core.deleteConversation(ADA, theirs)).toEqual({ ok: false, refusal: { status: 404, detail: NOT_FOUND } });
		expect(h.conversations.destroyed).toEqual([]);
	});
});

describe("deleting an agent", () => {
	test("cancels its runs, every user's, then deletes its conversations, every user's", async () => {
		const h = await harness();
		const agent = await h.core.createAgent(ADA, { name: "Doomed" });
		if (!agent.ok) throw new Error("not created");
		const adas = await running(h, { conversationId: await conversation(h, ADA, agent.value.id) });
		const graces = await running(h, { conversationId: await conversation(h, GRACE, agent.value.id), caller: GRACE });
		const idle = await conversation(h, GRACE, agent.value.id);
		expect(await h.core.deleteAgent(ADA, agent.value.id)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect(outbox(h).map((entry) => [entry.run_id, entry.reason])).toEqual([
			[adas.input.runId, "cancelled"],
			[graces.input.runId, "cancelled"],
		]);
		expect([...h.conversations.destroyed].sort()).toEqual([adas.input.conversationId, graces.input.conversationId, idle].sort());
		expect(registered(h, adas.input.runId)?.revoked).toBe("cancelled");
		expect(await h.core.locateRun(GRACE, graces.input.runId)).toBeNull();
	});
});
