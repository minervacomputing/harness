// The Workspace's provisioning, agents and conversation index, over node:sqlite: tenancy as Workspace
// invariants, and agents.

import { NewAgent } from "@minerva/contract";
import { describe, expect, test } from "vitest";
import { CHOOSE_CONNECTIONS, DEFAULT_AGENT, KEEP_ONE_AGENT, NOT_FOUND } from "../../src/workspace/core.ts";
import { ADA, GRACE, OTHER, USER, WORKSPACE, attach, connectMixed, conversation, database, defaultAgent, harness } from "./workspace-support.ts";

describe("provisioning", () => {
	test("a workspace starts with an unrestricted ceiling, the owner's restricted layer and one agent", async () => {
		const h = await harness();
		expect(h.sql.exec("SELECT id, level, subject, restricted FROM layers ORDER BY id")).toEqual([
			{ id: "ceiling", level: "ceiling", subject: null, restricted: 0 },
			{ id: `user:${USER}`, level: "user", subject: USER, restricted: 1 },
		]);
		const agents = await h.core.listAgents(ADA);
		expect(agents).toEqual([
			{ id: expect.any(String), name: DEFAULT_AGENT.name, instructions: DEFAULT_AGENT.instructions, connectionIds: [], canEdit: true, createdAt: new Date(h.timers.now()).toISOString() },
		]);
		expect(h.sql.exec("SELECT owner_id, model_alias FROM agents")).toEqual([{ owner_id: USER, model_alias: "default" }]);
		expect(h.core.workspaceRef()).toEqual({ id: WORKSPACE, jurisdiction: null });
	});

	test("init is idempotent and refuses another workspace's identity", async () => {
		const h = await harness();
		await h.core.init({ workspace: { id: WORKSPACE, jurisdiction: null }, kind: "personal", ownerId: USER, createdAt: 1 });
		expect(await h.core.listAgents(ADA)).toHaveLength(1);
		await expect(h.core.init({ workspace: { id: WORKSPACE, jurisdiction: "eu" }, kind: "personal", ownerId: USER, createdAt: 1 })).rejects.toThrow(/another workspace/);
		await expect(h.core.init({ workspace: { id: "0199a000-0000-7000-8000-0000000000dd", jurisdiction: null }, kind: "personal", ownerId: USER, createdAt: 1 })).rejects.toThrow();
	});

	test("two workspaces see only their own agents", async () => {
		const mine = await harness();
		const theirs = await harness({ db: database() });
		await theirs.core.createAgent(GRACE, NewAgent.parse({ name: "Theirs" }));
		expect((await mine.core.listAgents(ADA)).map((agent) => agent.name)).toEqual(["Assistant"]);
		expect((await theirs.core.listAgents(GRACE)).map((agent) => agent.name)).toEqual(["Assistant", "Theirs"]);
	});

	test("a workspace that was never initialized refuses what needs it", async () => {
		const h = await harness();
		const fresh = await harness({ db: database() });
		fresh.sql.exec("DELETE FROM workspace");
		expect(() => fresh.core.workspaceRef()).toThrow(/not initialized/);
		expect(h.core.workspaceRef().id).toBe(WORKSPACE);
	});
});

describe("agents", () => {
	test("every member sees every agent; only its owner or an admin may change it", async () => {
		const h = await harness();
		const created = await h.core.createAgent(GRACE, NewAgent.parse({ name: "Grace's", instructions: "Be brief." }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value).toMatchObject({ name: "Grace's", instructions: "Be brief.", connectionIds: [], canEdit: true });
		const seen = await h.core.listAgents({ userId: USER, role: "member" });
		expect(seen.map((agent) => [agent.name, agent.canEdit])).toEqual([
			["Assistant", true],
			["Grace's", false],
		]);
		expect(await h.core.updateAgent({ userId: USER, role: "member" }, created.value.id, NewAgent.parse({ name: "Mine now" }))).toEqual({
			ok: false,
			refusal: { code: "CANNOT_CHANGE_AGENT", detail: "You cannot change this agent." },
		});
		expect(await h.core.deleteAgent({ userId: USER, role: "member" }, created.value.id)).toMatchObject({ ok: false, refusal: { code: "CANNOT_CHANGE_AGENT" } });
		// An owner or admin may.
		expect(await h.core.updateAgent({ userId: USER, role: "admin" }, created.value.id, NewAgent.parse({ name: "Renamed" }))).toMatchObject({ ok: true });
		expect(await h.core.getAgent(ADA, "0199a000-0000-7000-8000-0000000000ff")).toBeNull();
		expect(await h.core.updateAgent(ADA, "0199a000-0000-7000-8000-0000000000ff", NewAgent.parse({ name: "x" }))).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
	});

	test("unknown body fields from an older client never reach the answer", async () => {
		const h = await harness();
		for (const value of [true, false]) {
			const created = await h.core.createAgent(ADA, NewAgent.parse({ name: "Scripted", code_mode: value }));
			expect(created.ok && Object.keys(created.value).sort()).toEqual(["canEdit", "connectionIds", "createdAt", "id", "instructions", "name"]);
		}
		const updated = await h.core.updateAgent(ADA, await defaultAgent(h), NewAgent.parse({ name: "Assistant", code_mode: false }));
		expect(updated.ok && "code_mode" in updated.value.agent).toBe(false);
	});

	test("a PUT is a full replace: omitted fields reset to their defaults", async () => {
		const h = await harness();
		const agent = await defaultAgent(h);
		const connection = await connectMixed(h, {});
		await h.core.updateAgent(ADA, agent, NewAgent.parse({ name: "A", instructions: "Do things.", connectionIds: [connection] }));
		const replaced = await h.core.updateAgent(ADA, agent, NewAgent.parse({ name: "B" }));
		expect(replaced.ok && replaced.value.agent).toMatchObject({ name: "B", instructions: "", connectionIds: [] });
	});

	test("agents can only use connections of their user", async () => {
		const h = await harness();
		const graces = await connectMixed(h, {}, { caller: GRACE, account: "acct-grace" });
		const foreign = "0199a000-0000-7000-8000-0000000000ee";
		for (const ids of [[graces], [foreign]]) {
			expect(await h.core.createAgent(ADA, NewAgent.parse({ name: "Sneaky", connectionIds: ids }))).toEqual({ ok: false, refusal: { code: "CHOOSE_CONNECTIONS", detail: CHOOSE_CONNECTIONS } });
		}
		// The same id twice is one connection.
		const mine = await connectMixed(h, {});
		const created = await h.core.createAgent(ADA, NewAgent.parse({ name: "Fine", connectionIds: [mine, mine] }));
		expect(created.ok && created.value.connectionIds).toEqual([mine]);
	});

	test("an agent keeps a connection that needs reconnecting, and cannot add it back", async () => {
		const h = await harness();
		const agent = await defaultAgent(h);
		const connection = await connectMixed(h, {});
		await attach(h, agent, [connection]);
		h.sql.exec("UPDATE connections SET status = 'error'");
		expect(await h.core.updateAgent(ADA, agent, NewAgent.parse({ name: "Renamed", connectionIds: [connection] }))).toMatchObject({ ok: true });
		expect(await h.core.updateAgent(ADA, agent, NewAgent.parse({ name: "Renamed", connectionIds: [] }))).toMatchObject({ ok: true });
		// Adding it back is adding a connection, which must be usable.
		expect(await h.core.updateAgent(ADA, agent, NewAgent.parse({ name: "Renamed", connectionIds: [connection] }))).toEqual({ ok: false, refusal: { code: "CHOOSE_CONNECTIONS", detail: CHOOSE_CONNECTIONS } });
	});

	test("an agent keeps someone else's connection it already has", async () => {
		const h = await harness();
		const agent = await h.core.createAgent(GRACE, NewAgent.parse({ name: "Shared work" }));
		if (!agent.ok) throw new Error("not created");
		const graces = await connectMixed(h, {}, { caller: GRACE, account: "acct-grace" });
		await attach(h, agent.value.id, [graces], GRACE);
		// An admin edits Grace's agent: her connection may stay, but the admin cannot add one of her others.
		const admin = { userId: USER, role: "admin" } as const;
		expect(await h.core.updateAgent(admin, agent.value.id, NewAgent.parse({ name: "Renamed", connectionIds: [graces] }))).toMatchObject({ ok: true });
		const another = await connectMixed(h, {}, { caller: GRACE, account: "acct-grace-2" });
		expect(await h.core.updateAgent(admin, agent.value.id, NewAgent.parse({ name: "Renamed", connectionIds: [graces, another] }))).toMatchObject({ ok: false, refusal: { code: "CHOOSE_CONNECTIONS" } });
	});

	test("deleting a connection removes it from every agent", async () => {
		const h = await harness();
		const agent = await defaultAgent(h);
		const connection = await connectMixed(h, {});
		await attach(h, agent, [connection]);
		expect(await h.core.deleteConnection(ADA, connection)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect((await h.core.getAgent(ADA, agent))?.connectionIds).toEqual([]);
	});

	test("the last agent cannot be deleted; deleting one removes its conversations", async () => {
		const h = await harness();
		const first = await defaultAgent(h);
		expect(await h.core.deleteAgent(ADA, first)).toEqual({ ok: false, refusal: { code: "KEEP_ONE_AGENT", detail: KEEP_ONE_AGENT } });
		const second = await h.core.createAgent(ADA, NewAgent.parse({ name: "Second" }));
		if (!second.ok) throw new Error("not created");
		const chat = await conversation(h, ADA, second.value.id);
		const kept = await conversation(h, ADA, first);
		expect(await h.core.deleteAgent(ADA, second.value.id)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect((await h.core.listAgents(ADA)).map((agent) => agent.id)).toEqual([first]);
		expect((await h.core.listConversations(ADA)).map((row) => row.id)).toEqual([kept]);
		expect(h.conversations.destroyed).toEqual([chat]);
		expect(await h.core.createConversation(ADA, second.value.id)).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
		expect(h.sql.exec("SELECT id FROM layers WHERE level = 'agent'")).toEqual([]);
	});
});

describe("the conversation index", () => {
	test("a conversation needs an agent of the workspace and initializes its object", async () => {
		const h = await harness();
		expect(await h.core.createConversation(ADA, "0199a000-0000-7000-8000-0000000000ff")).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
		const agent = await defaultAgent(h);
		const created = await h.core.createConversation(ADA, agent);
		expect(created).toEqual({ ok: true, value: { id: expect.any(String), agent_id: agent, title: "", updated_at: new Date(h.timers.now()).toISOString() } });
		expect(h.conversations.inits).toEqual([
			{ conversationId: created.ok && created.value.id, workspace: { id: WORKSPACE, jurisdiction: null }, userId: USER, agentId: agent, createdAt: h.timers.now() },
		]);
	});

	test("each user lists their own, newest first, at most 100", async () => {
		const h = await harness();
		const agent = await defaultAgent(h);
		const ids: string[] = [];
		for (let i = 0; i < 102; i++) {
			ids.push(await conversation(h, ADA, agent));
			await h.timers.advance(1);
		}
		await conversation(h, GRACE, agent);
		const listed = await h.core.listConversations(ADA);
		expect(listed.map((row) => row.id)).toEqual(ids.slice(2).reverse());
		await h.core.conversationTouched(ids[0] as string, { title: "Back on top", updatedAt: h.timers.now() + 1000 });
		expect((await h.core.listConversations(ADA))[0]).toMatchObject({ id: ids[0], title: "Back on top" });
		// An older touch does not move it back.
		await h.core.conversationTouched(ids[0] as string, { title: "Back on top", updatedAt: 0 });
		expect((await h.core.listConversations(ADA))[0]?.id).toBe(ids[0]);
		expect((await h.core.listConversations(GRACE)).map((row) => row.agent_id)).toEqual([agent]);
	});

	test("another user's conversation is not found", async () => {
		const h = await harness();
		const theirs = await conversation(h, GRACE);
		expect(await h.core.deleteConversation(ADA, theirs)).toEqual({ ok: false, refusal: { code: "NOT_FOUND", detail: NOT_FOUND } });
		expect(await h.core.listConversations(ADA)).toEqual([]);
	});

	test("ownsConversation: the caller's ready conversation only, never a deleted, foreign or unknown one", async () => {
		const h = await harness();
		const mine = await conversation(h, ADA);
		const theirs = await conversation(h, GRACE);
		expect(await h.core.ownsConversation(ADA, mine)).toBe(true);
		expect(await h.core.ownsConversation(ADA, theirs)).toBe(false);
		expect(await h.core.ownsConversation(ADA, "0199a000-0000-7000-8000-0000000000ff")).toBe(false);
		h.conversations.initFails = true;
		await expect(h.core.createConversation(ADA, await defaultAgent(h))).rejects.toThrow(/could not be reached/);
		const [unready] = h.sql.exec<{ id: string }>("SELECT id FROM conversations WHERE ready = 0");
		expect(await h.core.ownsConversation(ADA, unready?.id as string)).toBe(false);
		h.conversations.initFails = false;
		await h.core.deleteConversation(ADA, mine);
		expect(await h.core.ownsConversation(ADA, mine)).toBe(false);
	});

	test("a conversation whose object could not be initialized is deleted again", async () => {
		const h = await harness();
		h.conversations.initFails = true;
		await expect(h.core.createConversation(ADA, await defaultAgent(h))).rejects.toThrow(/could not be reached/);
		expect(h.sql.exec("SELECT deleted_at IS NOT NULL AS deleted, ready FROM conversations")).toEqual([{ deleted: 1, ready: 0 }]);
		expect(h.sql.exec("SELECT count(*) AS n FROM purges")).toEqual([{ n: 1 }]);
		expect(await h.core.listConversations(ADA)).toEqual([]);
	});

	test("a conversation whose creation crashed before it was ready is deleted after ten minutes", async () => {
		const h = await harness();
		const agent = await defaultAgent(h);
		h.sql.exec("INSERT INTO conversations (id, user_id, agent_id, created_at, updated_at) VALUES ('c-crashed', ?, ?, ?, ?)", OTHER, agent, h.timers.now(), h.timers.now());
		expect(h.core.nextWake()).toBe(h.timers.now() + 10 * 60 * 1000);
		await h.timers.advance(10 * 60 * 1000);
		await h.core.alarm();
		expect(h.conversations.destroyed).toEqual(["c-crashed"]);
	});
});
