// Conversations, messages, runs, the event stream, uploads and downloads through the Worker, over D1, the
// real Workspace and Conversation objects, the local buckets and the fake model of the test build.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { conversationObject } from "../../src/addressing.ts";
import { STREAM_TIMING } from "../../src/api/stream.ts";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { type DownloadEnv, serveDownload } from "../../src/files/download.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";
import { type Answer, Browser, ORIGIN, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

const TIMING = { ...STREAM_TIMING };

beforeAll(() => {
	// The test build's wiring, as src/faults/index.ts sets it (another test file may have replaced it).
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

afterEach(() => {
	Object.assign(STREAM_TIMING, TIMING);
});

interface Account {
	browser: Browser;
	userId: string;
	/** The personal workspace. */
	ws: string;
	agent: string;
}

async function account(name = "ada"): Promise<Account> {
	const { browser, userId } = await signedIn(`${name}-${uuid7().slice(-12)}@example.com`);
	const me = await browser.call("GET", "/api/me");
	const ws = me.body.workspaces[0].id as string;
	const agents = await browser.call("GET", `/api/workspaces/${ws}/agents`);
	return { browser, userId, ws, agent: agents.body[0].id };
}

/** A message the fake model answers with this script. */
function say(script: FakeScript): string {
	return JSON.stringify({ fake: script });
}

const SLOW: FakeScript = { chunkChars: 1, delayMs: 50, turns: [{ text: "y".repeat(400) }] };

async function newConversation(a: Account, ws = a.ws, agent = a.agent): Promise<string> {
	const created = await a.browser.call("POST", `/api/workspaces/${ws}/conversations`, { agent_id: agent });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	return created.body.id;
}

function post(a: Account, conversation: string, content: string, attachments: string[] = [], headers: Record<string, string> = {}, ws = a.ws): Promise<Answer> {
	return a.browser.call("POST", `/api/workspaces/${ws}/conversations/${conversation}/messages`, { content, attachments }, headers);
}

async function posted(a: Account, conversation: string, content: string, attachments: string[] = []): Promise<{ run: string; base: string | null }> {
	const answer = await post(a, conversation, content, attachments);
	expect(answer.status, JSON.stringify(answer.body)).toBe(201);
	return { run: answer.body.run.id, base: answer.body.run.base_version_id };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(25);
	}
}

async function settled(a: Account, run: string, ws = a.ws): Promise<Answer> {
	return until(
		() => a.browser.call("GET", `/api/workspaces/${ws}/runs/${run}`),
		(answer) => answer.status === 200 && !["queued", "provisioning", "running"].includes(answer.body.status),
	);
}

interface Frame {
	id?: string;
	event?: string;
	data?: string;
	comment?: string;
}

/** An SSE response read frame by frame, as EventSource parses it. */
class Sse {
	readonly response: Response;
	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	readonly #decoder = new TextDecoder();
	#buffer = "";
	#done = false;
	/** Why the response broke off, if it did (an aborted response), rather than ending. */
	failure: unknown = null;

	constructor(response: Response) {
		this.response = response;
	}

	get #body(): ReadableStreamDefaultReader<Uint8Array> {
		this.#reader ??= (this.response.body as ReadableStream<Uint8Array>).getReader();
		return this.#reader;
	}

	/** The next frame or comment, or null once the response ended. */
	async next(timeout = 15_000): Promise<Frame | null> {
		const deadline = Date.now() + timeout;
		for (;;) {
			const split = this.#buffer.indexOf("\n\n");
			if (split >= 0) {
				const block = this.#buffer.slice(0, split);
				this.#buffer = this.#buffer.slice(split + 2);
				const frame: Frame = {};
				for (const line of block.split("\n")) {
					if (line.startsWith(":")) frame.comment = line.slice(1).trim();
					else {
						const colon = line.indexOf(":");
						const name = line.slice(0, colon) as "id" | "event" | "data";
						frame[name] = line.slice(colon + 1).replace(/^ /, "");
					}
				}
				return frame;
			}
			if (this.#done) return null;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`No frame within ${timeout} ms; buffered: ${this.#buffer.slice(0, 200)}`);
			let read: ReadableStreamReadResult<Uint8Array> | null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				read = await Promise.race([this.#body.read(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), left)))]);
			} catch (error) {
				this.failure = error;
				this.#done = true;
				continue;
			} finally {
				clearTimeout(timer);
			}
			if (read === null) continue;
			if (read.done) this.#done = true;
			else this.#buffer += this.#decoder.decode(read.value, { stream: true });
		}
	}

	/** Every frame up to the end of the response or its break (comments left out). */
	async rest(): Promise<Frame[]> {
		const frames: Frame[] = [];
		for (let frame = await this.next(); frame !== null; frame = await this.next()) if (frame.comment === undefined) frames.push(frame);
		return frames;
	}

	cancel(): Promise<void> {
		return this.#body.cancel();
	}
}

async function stream(a: Account, run: string, options: { after?: number; lastEventId?: string; ws?: string } = {}): Promise<Sse> {
	const query = options.after === undefined ? "" : `?after=${options.after}`;
	const headers: Record<string, string> = options.lastEventId === undefined ? {} : { "Last-Event-ID": options.lastEventId };
	const response = await a.browser.fetch(`/api/workspaces/${options.ws ?? a.ws}/runs/${run}/stream${query}`, { headers });
	return new Sse(response);
}

function eventsOf(frames: Frame[]) {
	return frames.filter((frame) => frame.event !== "end").map((frame) => ({ seq: Number(frame.id), type: frame.event, data: JSON.parse(frame.data as string) }));
}

/** Adds events of 1 MiB each to a finished run, as a long answer would leave them. */
async function addEvents(a: Account, conversation: string, run: string, count: number): Promise<void> {
	const big = "x".repeat(1024 * 1024);
	await runInDurableObject(conversationObject(env, { id: a.ws, jurisdiction: null }, conversation), (_instance, state) => {
		for (let i = 0; i < count; i++) {
			const seq = state.storage.sql.exec<{ event_seq: number }>("UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq", run).one().event_seq;
			state.storage.sql.exec("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)", run, seq, "text_delta", JSON.stringify({ text: big, call: "0badc0de" }), Date.now());
		}
	});
}

/** An upload through the route, as the browser sends one. */
function upload(a: Account, data: string | Uint8Array, name: string | null = "notes.txt", ws = a.ws, headers: Record<string, string> = {}): Promise<Answer> {
	const query = name === null ? "" : `?name=${encodeURIComponent(name)}`;
	return a.browser.call("POST", `/api/workspaces/${ws}/uploads${query}`, typeof data === "string" ? data : (data as unknown as string), {
		"Content-Type": "application/octet-stream",
		...headers,
	});
}

async function uploaded(a: Account, data: string, name = "notes.txt", ws = a.ws): Promise<string> {
	const answer = await upload(a, data, name, ws);
	expect(answer.status, JSON.stringify(answer.body)).toBe(201);
	return answer.body.id;
}

/** A team workspace with these members, as 5c's tests make one. */
async function teamWorkspace(members: Account[]): Promise<string> {
	const now = Date.now();
	const organization = uuid7();
	const ws = uuid7();
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Team', ?, ?)`).bind(organization, organization, new Date(now).toISOString()),
		env.DB.prepare("INSERT INTO workspaces (id, organization_id, kind, name, created_at) VALUES (?, ?, 'team', 'Team', ?)").bind(ws, organization, now),
		...members.map((m, index) =>
			env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(ws, m.userId, index === 0 ? "owner" : "member", now + index),
		),
	]);
	return ws;
}

describe("a chat turn", () => {
	test("a message starts a run whose events stream over SSE to the end; the conversation then holds them all", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations`)).body).toEqual([{ id: conversation, agent_id: a.agent, title: "", updated_at: expect.any(String) }]);
		const content = say({ turns: [{ thinking: "Let me think.", text: "Hello there, friend." }] });
		const answer = await post(a, conversation, content);
		expect(answer.status).toBe(201);
		expect(answer.body.message).toMatchObject({ role: "user", content, attachments: [], run_id: answer.body.run.id });
		expect(answer.body.run).toMatchObject({ status: "queued", error_message: "", finished_at: null, events: [{ seq: 1, type: "status", data: { status: "queued" } }] });
		const run = answer.body.run.id as string;

		const sse = await stream(a, run, { after: 1 });
		expect(sse.response.status).toBe(200);
		expect(["Content-Type", "Cache-Control", "X-Accel-Buffering"].map((name) => sse.response.headers.get(name))).toEqual(["text/event-stream", "no-store", "no"]);
		const frames = await sse.rest();
		expect(frames.at(-1)).toEqual({ event: "end", data: "{}" });
		const streamed = eventsOf(frames);
		expect(streamed.map((event) => event.seq)).toEqual(streamed.map((_event, index) => index + 2));
		expect(streamed.filter((event) => event.type === "status").map((event) => event.data.status)).toEqual(["provisioning", "running", "completed"]);
		expect(streamed.some((event) => event.type === "reasoning_delta")).toBe(true);
		expect(streamed.filter((event) => event.type === "text_delta").map((event) => event.data.text).join("")).toBe("Hello there, friend.");

		const detail = await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${conversation}`);
		expect(detail.status).toBe(200);
		expect(Object.keys(detail.body)).toEqual(["id", "agent_id", "title", "updated_at", "messages", "runs"]);
		expect(detail.body.title).toBe([...content].slice(0, 80).join(""));
		expect(detail.body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
		expect(detail.body.messages[1].content).toBe("Hello there, friend.");
		expect(Object.keys(detail.body.runs[0])).toEqual([
			"id",
			"status",
			"error_message",
			"created_at",
			"finished_at",
			"base_version_id",
			"result_version_id",
			"folder_changes",
			"folder_warnings",
			"events",
		]);
		expect(detail.body.runs[0].events).toEqual([{ seq: 1, type: "status", data: { status: "queued" } }, ...streamed]);
		const got = await a.browser.call("GET", `/api/workspaces/${a.ws}/runs/${run}`);
		expect(got.body).toEqual(detail.body.runs[0]);
		// A stream opened after the end replays what follows the cursor and ends at once.
		const late = await (await stream(a, run, { after: streamed.length - 1 })).rest();
		expect(late).toEqual([...frames.slice(-3)]);
	});

	test("one run at a time: a second message is 409 and leaves nothing; an empty one is 400", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const first = await post(a, conversation, say(SLOW));
		expect(first.status).toBe(201);
		const busy = await post(a, conversation, "again");
		expect([busy.status, busy.body]).toEqual([409, { code: "CONVERSATION_BUSY", detail: "Wait for the current answer to finish, or stop it." }]);
		const empty = await post(a, conversation, "  \n ");
		expect([empty.status, empty.body]).toEqual([400, { code: "EMPTY_MESSAGE", detail: "Write a message or attach a file." }]);
		const detail = await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${conversation}`);
		expect([detail.body.messages.length, detail.body.runs.length]).toEqual([1, 1]);
		await a.browser.call("POST", `/api/workspaces/${a.ws}/runs/${first.body.run.id}/cancel`);
	});

	test("a deleted conversation is gone, its running answer stopped: 204, then 404 for it, its run and its stream", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, say(SLOW));
		const path = `/api/workspaces/${a.ws}/conversations/${conversation}`;
		const deleted = await a.browser.call("DELETE", path);
		expect([deleted.status, deleted.body]).toEqual([204, null]);
		expect((await a.browser.call("GET", path)).status).toBe(404);
		expect((await a.browser.call("DELETE", path)).status).toBe(404);
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/runs/${run}`)).status).toBe(404);
		expect((await stream(a, run)).response.status).toBe(404);
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations`)).body).toEqual([]);
	});

	test("bodies are validated after membership and before the conversation is looked up", async () => {
		const a = await account();
		const nowhere = "0199a000-0000-7000-8000-0000000000ff";
		const long = await post(a, nowhere, "x".repeat(20_001));
		expect([long.status, long.body.detail[0].type, long.body.detail[0].loc]).toEqual([422, "too_big", ["body", "content"]]);
		// Lengths count UTF-16 units: an emoji is two.
		expect((await post(a, nowhere, "😀".repeat(10_000))).status).toBe(404);
		expect((await post(a, nowhere, "😀".repeat(10_001))).status).toBe(422);
		const surrogate = await a.browser.call("POST", `/api/workspaces/${a.ws}/conversations/${nowhere}/messages`, '{"content": "\\ud800"}');
		expect([surrogate.status, surrogate.body.detail[0].type]).toEqual([422, "invalid_format"]);
		const ids = await post(a, nowhere, "x", ["nope"]);
		expect([ids.status, ids.body.detail[0].type, ids.body.detail[0].loc]).toEqual([422, "invalid_format", ["body", "attachments", 0]]);
		const missing = await a.browser.call("POST", `/api/workspaces/${a.ws}/conversations`, {});
		expect([missing.status, missing.body.detail[0].type]).toEqual([422, "invalid_type"]);
		const unknownAgent = await a.browser.call("POST", `/api/workspaces/${a.ws}/conversations`, { agent_id: nowhere });
		expect(unknownAgent.status).toBe(404);
		const version = await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${nowhere}/files?version=nope`);
		expect([version.status, version.body.detail[0].type]).toEqual([422, "invalid_format"]);
		const key = await post(a, nowhere, "x", [], { "Idempotency-Key": "has space" });
		expect([key.status, key.body]).toEqual([400, { code: "INVALID_IDEMPOTENCY_KEY", detail: "The Idempotency-Key header must be 1 to 255 visible ASCII characters." }]);
	});
});

describe("the event stream", () => {
	test("a reconnect resumes after Last-Event-ID (the URL keeping its first ?after=): no gaps, no duplicates", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, say({ chunkChars: 2, delayMs: 25, turns: [{ text: "z".repeat(160) }] }));
		const first = await stream(a, run, { after: 1 });
		const seen: Frame[] = [];
		while (seen.length < 4) {
			const frame = await first.next();
			if (frame?.event) seen.push(frame);
		}
		await first.cancel();
		const second = await stream(a, run, { after: 1, lastEventId: seen.at(-1)?.id as string });
		const rest = await second.rest();
		expect(rest.at(-1)?.event).toBe("end");
		const all = eventsOf([...seen, ...rest]);
		const stored = (await a.browser.call("GET", `/api/workspaces/${a.ws}/runs/${run}`)).body.events;
		expect(all).toEqual(stored.slice(1));
		// Not all digits counts as 0; the header wins over ?after=, and an empty one does not.
		const replay = eventsOf(await (await stream(a, run, { after: 3, lastEventId: "x7" })).rest());
		expect(replay.map((event) => event.seq)).toEqual(stored.map((event: { seq: number }) => event.seq));
		const fromAfter = eventsOf(await (await stream(a, run, { after: 3, lastEventId: "" })).rest());
		expect(fromAfter[0]?.seq).toBe(4);
	});

	test("a stop during a run: the run is cancelled, Stopped., and the stream says so, then ends", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, say(SLOW));
		const sse = await stream(a, run, { after: 0 });
		for (let frame = await sse.next(); frame?.event !== "text_delta"; frame = await sse.next()) expect(frame).not.toBeNull();
		const cancelled = await a.browser.call("POST", `/api/workspaces/${a.ws}/runs/${run}/cancel`);
		expect(cancelled.status).toBe(200);
		expect(cancelled.body).toMatchObject({ id: run, status: "cancelled", error_message: "Stopped.", finished_at: expect.any(String) });
		expect(cancelled.body.events.at(-1)).toMatchObject({ type: "status", data: { status: "cancelled", message: "Stopped." } });
		const rest = await sse.rest();
		expect(rest.at(-1)).toEqual({ event: "end", data: "{}" });
		expect(eventsOf(rest).at(-1)).toMatchObject({ type: "status", data: { status: "cancelled" } });
		// Idempotent: a finished run stays as it was.
		const again = await a.browser.call("POST", `/api/workspaces/${a.ws}/runs/${run}/cancel`);
		expect([again.status, again.body.status, again.body.events.length]).toEqual([200, "cancelled", cancelled.body.events.length]);
		// The conversation takes the next message.
		expect((await post(a, conversation, "Next")).status).toBe(201);
	});

	test("a keepalive comment after silence; the stream closes once its session ends", async () => {
		STREAM_TIMING.keepaliveMs = 150;
		STREAM_TIMING.sessionCheckMs = 200;
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, say({ chunkChars: 400, delayMs: 3000, turns: [{ text: "w".repeat(400) }] }));
		const sse = await stream(a, run, { after: 1 });
		let frame = await sse.next();
		while (frame !== null && frame.comment === undefined) frame = await sse.next();
		expect(frame).toEqual({ comment: "keepalive" });
		expect((await a.browser.call("POST", "/api/auth/sign-out", {})).status).toBe(200);
		const rest = await sse.rest();
		// Cut off without `end`: the browser reconnects, and a signed-out reconnect is 401.
		expect([rest.some((item) => item.event === "end"), sse.failure]).toEqual([false, null]);
		const again = await stream(a, run, { lastEventId: "1" });
		expect([again.response.status, await again.response.json()]).toEqual([401, { code: "UNAUTHORIZED", detail: "Unauthorized" }]);
	});

	test("a member removed from the workspace loses the stream at the next check", async () => {
		STREAM_TIMING.sessionCheckMs = 200;
		const grace = await account("grace");
		const ada = await account("ada");
		const team = await teamWorkspace([grace, ada]);
		const agent = (await ada.browser.call("GET", `/api/workspaces/${team}/agents`)).body[0].id;
		const conversation = await newConversation(ada, team, agent);
		const answer = await post(ada, conversation, say(SLOW), [], {}, team);
		expect(answer.status).toBe(201);
		const run = answer.body.run.id as string;
		const sse = await stream(ada, run, { after: 1, ws: team });
		for (let frame = await sse.next(); frame?.event !== "text_delta"; frame = await sse.next()) expect(frame).not.toBeNull();
		await env.DB.prepare("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").bind(team, ada.userId).run();
		const rest = await sse.rest();
		expect([rest.some((item) => item.event === "end"), sse.failure]).toEqual([false, null]);
		expect((await stream(ada, run, { ws: team, lastEventId: "1" })).response.status).toBe(404);
		await env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(team, ada.userId, Date.now()).run();
		expect((await ada.browser.call("POST", `/api/workspaces/${team}/runs/${run}/cancel`)).status).toBe(200);
	});

	test("a client that does not read is cut off rather than buffered for, and resumes from what it read", async () => {
		STREAM_TIMING.bufferLimit = 64 * 1024;
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, "Hi");
		const before = (await settled(a, run)).body.events.length as number;
		await addEvents(a, conversation, run, 8);
		const sse = await stream(a, run, { after: 0 });
		await sleep(500);
		const frames = await sse.rest();
		expect(frames.some((frame) => frame.event === "end")).toBe(false);
		const read = eventsOf(frames);
		expect(read.length).toBeLessThan(before + 8);
		Object.assign(STREAM_TIMING, TIMING);
		const resumed = await (await stream(a, run, { lastEventId: String(read.at(-1)?.seq ?? 0) })).rest();
		expect(resumed.at(-1)?.event).toBe("end");
		expect([...read, ...eventsOf(resumed)].map((event) => event.seq)).toEqual(Array.from({ length: before + 8 }, (_v, i) => i + 1));
	});

	test("a backlog past the object's 4 MiB per socket, and a conversation past 32 MiB of events, arrive whole", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const { run } = await posted(a, conversation, "Hi");
		const done = await settled(a, run);
		const before = done.body.events.length as number;
		const added = 34;
		await addEvents(a, conversation, run, added);
		const response = await a.browser.fetch(`/api/workspaces/${a.ws}/conversations/${conversation}`);
		const text = await response.text();
		expect(text.length).toBeGreaterThan(32 * 1024 * 1024);
		const detail = JSON.parse(text);
		expect(detail.runs[0].events.map((event: { seq: number }) => event.seq)).toEqual(Array.from({ length: before + added }, (_v, i) => i + 1));
		const frames = await (await stream(a, run, { after: 0 })).rest();
		expect(frames.at(-1)?.event).toBe("end");
		expect(eventsOf(frames).map((event) => event.seq)).toEqual(Array.from({ length: before + added }, (_v, i) => i + 1));
	}, 60_000);
});

describe("a start retried with the same key", () => {
	test("is one run: concurrent copies share it, a later copy answers with it, another message under the key is 422", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const content = say({ chunkChars: 4, delayMs: 20, turns: [{ text: "k".repeat(80) }] });
		const key = { "Idempotency-Key": `send-${uuid7()}` };
		const [one, two] = await Promise.all([post(a, conversation, content, [], key), post(a, conversation, content, [], key)]);
		expect([one.status, two.status]).toEqual([201, 201]);
		expect([two.body.run.id, two.body.message.id]).toEqual([one.body.run.id, one.body.message.id]);
		const other = await post(a, conversation, "Something else", [], key);
		expect([other.status, other.body]).toEqual([422, { code: "IDEMPOTENCY_KEY_REUSED", detail: "This Idempotency-Key was used for a different message." }]);
		expect((await post(a, conversation, content)).status).toBe(409);
		await settled(a, one.body.run.id);
		const later = await post(a, conversation, content, [], key);
		expect([later.status, later.body.run.id, later.body.run.status]).toEqual([201, one.body.run.id, "completed"]);
		const detail = await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${conversation}`);
		expect([detail.body.messages.filter((message: { role: string }) => message.role === "user").length, detail.body.runs.length]).toEqual([1, 1]);
	});
});

describe("tenancy", () => {
	test("another user's workspace is 401 on the JSON API, 404 on the stream and downloads; anonymous is 401", async () => {
		const ada = await account("ada");
		const grace = await account("grace");
		const theirs = await newConversation(grace);
		const { run } = await posted(grace, theirs, "secret");
		const upload = await uploaded(grace, "theirs");
		const base = `/api/workspaces/${grace.ws}`;
		for (const [method, path] of [
			["GET", "/conversations"],
			["POST", "/conversations"],
			["GET", `/conversations/${theirs}`],
			["DELETE", `/conversations/${theirs}`],
			["POST", `/conversations/${theirs}/messages`],
			["GET", `/conversations/${theirs}/files`],
			["GET", `/runs/${run}`],
			["POST", `/runs/${run}/cancel`],
			["DELETE", `/uploads/${upload}`],
		] as const) {
			const answer = await ada.browser.call(method, `${base}${path}`, method === "POST" ? { content: "x", agent_id: grace.agent } : undefined);
			expect([method, path, answer.status, answer.body]).toEqual([method, path, 401, { code: "UNAUTHORIZED", detail: "Unauthorized" }]);
		}
		expect((await upload_(ada, grace.ws)).status).toBe(401);
		const sse = await stream(ada, run, { ws: grace.ws });
		expect([sse.response.status, await sse.response.json()]).toEqual([404, { code: "NOT_FOUND", detail: "Not found." }]);
		const download = await ada.browser.call("GET", `${base}/conversations/${theirs}/files/download?path=x`);
		expect([download.status, download.body]).toEqual([404, { code: "NOT_FOUND", detail: "Not found." }]);
		// Anonymous.
		const anonymous = new Browser();
		for (const path of [`/api/workspaces/${ada.ws}/conversations`, `${base}/runs/${run}/stream`, `${base}/conversations/${theirs}/files/download?path=x`]) {
			const answer = await anonymous.call("GET", path);
			expect([path, answer.status, answer.body]).toEqual([path, 401, { code: "UNAUTHORIZED", detail: "Unauthorized" }]);
		}
		// Their upload is still theirs.
		expect((await grace.browser.call("DELETE", `${base}/uploads/${upload}`)).status).toBe(204);
	});

	test("another user's conversation and run through one's own workspace are 404, as are files and downloads", async () => {
		const ada = await account("ada");
		const grace = await account("grace");
		const theirs = await newConversation(grace);
		const { run } = await posted(grace, theirs, "secret");
		const mine = `/api/workspaces/${ada.ws}`;
		for (const [method, path] of [
			["GET", `/conversations/${theirs}`],
			["DELETE", `/conversations/${theirs}`],
			["POST", `/conversations/${theirs}/messages`],
			["GET", `/conversations/${theirs}/files`],
			["GET", `/conversations/${theirs}/files/download?path=x`],
			["GET", `/runs/${run}`],
			["POST", `/runs/${run}/cancel`],
		] as const) {
			const answer = await ada.browser.call(method, `${mine}${path}`, method === "POST" ? { content: "x" } : undefined);
			expect([method, path, answer.status, answer.body]).toEqual([method, path, 404, { code: "NOT_FOUND", detail: "Not found." }]);
		}
		const sse = await stream(ada, run);
		expect([sse.response.status, await sse.response.json()]).toEqual([404, { code: "NOT_FOUND", detail: "Not found." }]);
		expect((await settled(grace, run)).body.status).toBe("completed");
		const detail = await grace.browser.call("GET", `/api/workspaces/${grace.ws}/conversations/${theirs}`);
		expect(detail.body.messages.map((message: { content: string }) => message.content)).toEqual(["secret", "Done."]);
	});

	test("one's own conversation through another workspace one belongs to is 404", async () => {
		const ada = await account("ada");
		const grace = await account("grace");
		const team = await teamWorkspace([grace, ada]);
		const conversation = await newConversation(ada);
		const { run } = await posted(ada, conversation, "Personal");
		await settled(ada, run);
		const other = `/api/workspaces/${team}`;
		for (const path of [`/conversations/${conversation}`, `/conversations/${conversation}/files`, `/conversations/${conversation}/files/download?path=x`, `/runs/${run}`]) {
			const answer = await ada.browser.call("GET", `${other}${path}`);
			expect([path, answer.status]).toEqual([path, 404]);
		}
		expect((await post(ada, conversation, "x", [], {}, team)).status).toBe(404);
		expect((await stream(ada, run, { ws: team })).response.status).toBe(404);
		// The team's agent is any member's, and its conversations are each user's own.
		const teamAgent = (await grace.browser.call("GET", `${other}/agents`)).body[0].id;
		const shared = await newConversation(ada, team, teamAgent);
		expect((await grace.browser.call("GET", `${other}/conversations`)).body).toEqual([]);
		expect((await grace.browser.call("GET", `${other}/conversations/${shared}`)).status).toBe(404);
		// An upload in a shared workspace is deleted only by its owner; another member's DELETE is a no-op 204.
		const upload = await uploaded(ada, "mine", "notes.txt", team);
		expect((await grace.browser.call("DELETE", `${other}/uploads/${upload}`)).status).toBe(204);
		expect((await post(ada, shared, say({ turns: [{ text: "Got it." }] }), [upload], {}, team)).status).toBe(201);
	});
});

/** An upload of a few bytes to a workspace, for the 401s. */
function upload_(a: Account, ws: string): Promise<Answer> {
	return upload(a, "x", "x.txt", ws);
}

describe("uploads", () => {
	test("an upload streams into the workspace's bucket and is recorded, its name cleaned and type sniffed", async () => {
		const a = await account();
		const answer = await upload(a, "%PDF-1.7 hello", "../Q3 report.pdf");
		expect(answer.status).toBe(201);
		expect(answer.body).toEqual({ id: expect.any(String), name: "Q3 report.pdf", size: 14, media_type: "application/pdf" });
		expect(answer.response.headers.get("Cache-Control")).toBe("no-store");
		const listed = await env.FILES.list({ prefix: `uploads/${a.ws}/${a.userId}/` });
		expect(listed.objects.map((object) => object.key)).toEqual([`uploads/${a.ws}/${a.userId}/${answer.body.id}`]);
		expect((await a.browser.call("DELETE", `/api/workspaces/${a.ws}/uploads/${answer.body.id}`)).status).toBe(204);
		expect((await a.browser.call("DELETE", `/api/workspaces/${a.ws}/uploads/${answer.body.id}`)).status).toBe(204);
	});

	test("refused before its body is read, in order", async () => {
		const a = await account();
		const grace = await account("grace");
		const path = `/api/workspaces/${a.ws}/uploads`;
		const send = (browser: Browser, query: string, headers: Record<string, string>, method = "POST") =>
			browser.fetcher(new Request(`${ORIGIN}${path}${query}`, { method, headers: { "CF-Connecting-IP": browser.ip, ...headers }, body: method === "GET" ? undefined : "hello" }));
		const cookies = (browser: Browser) => [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		const good = (browser: Browser) => ({ Cookie: cookies(browser), Origin: ORIGIN });
		const refused = { code: "CROSS_SITE", detail: "Cross-site request refused." };
		const usePost = { code: "METHOD_NOT_ALLOWED", detail: "Use POST." };
		const nameIt = { code: "FILE_NAME_MISSING", detail: "Name the file with ?name=." };
		const unauthorized = { code: "UNAUTHORIZED", detail: "Unauthorized" };
		const cases: [string, Response, number, object][] = [
			["no origin", await send(a.browser, "", { Cookie: cookies(a.browser) }), 403, refused],
			["foreign origin", await send(a.browser, "", { ...good(a.browser), Origin: "https://evil.example" }), 403, refused],
			["same-site origin", await send(a.browser, "", { ...good(a.browser), Origin: "http://app.localhost", "Sec-Fetch-Site": "same-site" }), 403, refused],
			["foreign PUT", await send(a.browser, "?name=a.txt", { ...good(a.browser), Origin: "https://evil.example" }, "PUT"), 403, refused],
			["PUT", await send(a.browser, "?name=a.txt", good(a.browser), "PUT"), 405, usePost],
			["GET", await send(a.browser, "?name=a.txt", {}, "GET"), 405, usePost],
			["no name", await send(a.browser, "", good(a.browser)), 400, nameIt],
			["two names", await send(a.browser, "?name=a&name=b", good(a.browser)), 400, nameIt],
			["anonymous", await send(new Browser(), "?name=a.txt", { Origin: ORIGIN }), 401, unauthorized],
			["same origin by Sec-Fetch-Site", await send(new Browser(), "?name=a.txt", { "Sec-Fetch-Site": "same-origin" }), 401, unauthorized],
			["not a member", await send(grace.browser, "?name=a.txt", good(grace.browser)), 401, unauthorized],
		];
		for (const [name, response, status, body] of cases) expect([name, response.status, await response.json()]).toEqual([name, status, body]);
		// Over the upload limit (50 MB), by its declared length.
		const big = await a.browser.fetcher(
			new Request(`${ORIGIN}${path}?name=big.bin`, {
				method: "POST",
				headers: { ...good(a.browser), "CF-Connecting-IP": a.browser.ip, "Content-Length": String(52_428_801) },
				body: new Uint8Array(52_428_801),
			}),
		);
		expect([big.status, await big.json()]).toEqual([413, { code: "FILE_TOO_LARGE", detail: "A file can be at most 50 MB." }]);
		expect((await env.FILES.list({ prefix: `uploads/${a.ws}/` })).objects).toEqual([]);
	});

	test("concurrent uploads race the reservation: at most 3 arriving and 30 waiting per user", async () => {
		const a = await account();
		const path = `/api/workspaces/${a.ws}/uploads`;
		// Three bodies held open, then a fourth.
		const held = [0, 1, 2].map(() => Promise.withResolvers<void>());
		const slow = held.map((hold, index) =>
			a.browser.fetch(`${path}?name=slow${index}.txt`, {
				method: "POST",
				headers: { "Content-Length": "4" },
				body: new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("sl"));
						await hold.promise;
						controller.enqueue(new TextEncoder().encode("ow"));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
		);
		const arriving = async () => (await env.FILES.list({ prefix: `uploads/${a.ws}/` })).objects.length;
		await sleep(300);
		const fourth = await upload(a, "fast");
		expect([fourth.status, fourth.body]).toEqual([429, { code: "TOO_MANY_UPLOADS_AT_ONCE", detail: "You are uploading too many files at once." }]);
		for (const hold of held) hold.resolve();
		expect((await Promise.all(slow)).map((response) => response.status)).toEqual([201, 201, 201]);
		expect(await arriving()).toBe(3);
		// 27 more waiting makes 30; of three racing for the last places, two get them.
		for (let i = 0; i < 25; i++) await uploaded(a, `n${i}`, `n${i}.txt`);
		const racing = await Promise.all([0, 1, 2].map((i) => upload(a, `r${i}`, `r${i}.txt`)));
		expect(racing.map((answer) => answer.status).sort()).toEqual([201, 201, 429]);
		expect(racing.find((answer) => answer.status === 429)?.body).toEqual({ code: "TOO_MANY_UPLOADS_WAITING", detail: "You have too many files waiting to be sent. Send or remove some, or try again tomorrow." });
		expect((await upload(a, "one more")).status).toBe(429);
	}, 60_000);

	test("attachments: the folder the run starts from; refusals leave no message, no run, and the uploads attachable", async () => {
		const a = await account();
		const conversation = await newConversation(a);
		const ids = [];
		for (let i = 0; i < 11; i++) ids.push(await uploaded(a, `file ${i}`, `f${i}.txt`));
		const tooMany = await post(a, conversation, "", ids);
		expect([tooMany.status, tooMany.body]).toEqual([400, { code: "TOO_MANY_ATTACHMENTS", detail: "Attach at most 10 files to a message." }]);
		const twice = await post(a, conversation, "hi", [ids[0] as string, ids[0] as string]);
		expect([twice.status, twice.body]).toEqual([400, { code: "ATTACHED_TWICE", detail: "A file is attached twice." }]);
		const grace = await account("grace");
		const theirs = await uploaded(grace, "theirs");
		const foreign = await post(a, conversation, "hi", [theirs]);
		expect([foreign.status, foreign.body]).toEqual([400, { code: "ATTACHMENT_UNAVAILABLE", detail: "An attached file is no longer available. Remove it and attach it again." }]);
		const detail = await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${conversation}`);
		expect([detail.body.title, detail.body.messages, detail.body.runs]).toEqual(["", [], []]);
		const answer = await post(a, conversation, "", ids.slice(0, 2));
		expect(answer.status).toBe(201);
		expect(answer.body.message.attachments).toEqual([
			{ path: "f0.txt", size: 6, media_type: "text/plain" },
			{ path: "f1.txt", size: 6, media_type: "text/plain" },
		]);
		expect(answer.body.run.base_version_id).toEqual(expect.any(String));
		await settled(a, answer.body.run.id);
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${conversation}`)).body.title).toBe("f0.txt, f1.txt");
	});
});

describe("files and downloads", () => {
	const downloadEnv = (): DownloadEnv => ({ FILES: env.FILES, FILES_EU: env.FILES_EU, MINERVA_DOWNLOAD_KEY: env.MINERVA_DOWNLOAD_KEY, MINERVA_DOWNLOAD_ORIGIN: env.MINERVA_DOWNLOAD_ORIGIN });

	async function withFile(a: Account, name = "zażółć report.html", data = "<script>alert(1)</script>") {
		const conversation = await newConversation(a);
		const upload = await uploaded(a, data, name);
		const { run, base } = await posted(a, conversation, say({ turns: [{ text: "Noted." }] }), [upload]);
		await settled(a, run);
		return { conversation, run, base: base as string };
	}

	test("the folder is listed for its owner; a file downloads through a signed link as an attachment that cannot run", async () => {
		const a = await account();
		const { conversation, base } = await withFile(a);
		const files = `/api/workspaces/${a.ws}/conversations/${conversation}/files`;
		const folder = await a.browser.call("GET", files);
		expect(folder.body).toEqual({ version_id: expect.any(String), files: [{ path: "zażółć report.html", size: 25, mtime: expect.any(Number) }], dirs: [] });
		expect((await a.browser.call("GET", `${files}?version=${base}`)).body.version_id).toBe(base);
		// The lax UUID forms name the same version.
		expect((await a.browser.call("GET", `${files}?version=${base.toUpperCase()}`)).body.version_id).toBe(base);
		const empty = await newConversation(a);
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${empty}/files`)).body).toEqual({ version_id: null, files: [], dirs: [] });
		expect((await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${empty}/files?version=${base}`)).status).toBe(404);

		const query = new URLSearchParams({ path: "zażółć report.html", version: base });
		const redirect = await a.browser.fetch(`${files}/download?${query}`, { redirect: "manual" });
		expect(redirect.status).toBe(302);
		expect([redirect.headers.get("Cache-Control"), redirect.headers.get("Referrer-Policy")]).toEqual(["no-store", "strict-origin-when-cross-origin"]);
		const link = redirect.headers.get("Location") as string;
		expect(link.startsWith(`${env.MINERVA_DOWNLOAD_ORIGIN}/download?`)).toBe(true);
		const response = await serveDownload(new Request(link), downloadEnv());
		expect(response.status).toBe(200);
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("<script>alert(1)</script>");
		expect(Object.fromEntries(["Content-Type", "Content-Length", "Content-Disposition", "X-Content-Type-Options", "Content-Security-Policy", "Cache-Control"].map((name) => [name, response.headers.get(name)]))).toEqual({
			"Content-Type": "application/octet-stream",
			"Content-Length": "25",
			"Content-Disposition": "attachment; filename*=utf-8''za%C5%BC%C3%B3%C5%82%C4%87%20report.html",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Cache-Control": "private, no-store",
		});
		// Without a version: the current folder.
		expect((await a.browser.fetch(`${files}/download?path=${encodeURIComponent("zażółć report.html")}`, { redirect: "manual" })).status).toBe(302);
	});

	test("an unknown path, an invalid or foreign version is 404; an expired, tampered or misdirected link is refused", async () => {
		const a = await account();
		const { conversation } = await withFile(a, "notes.txt", "hello");
		const other = await withFile(a, "other.txt", "other");
		const download = `/api/workspaces/${a.ws}/conversations/${conversation}/files/download`;
		for (const query of ["path=missing.txt", "path=notes.txt&version=nope", `path=notes.txt&version=${other.base}`, ""]) {
			const answer = await a.browser.call("GET", `${download}?${query}`);
			expect([query, answer.status, answer.body]).toEqual([query, 404, { code: "NOT_FOUND", detail: "Not found." }]);
		}
		const link = (await a.browser.fetch(`${download}?path=notes.txt`, { redirect: "manual" })).headers.get("Location") as string;
		const now = Date.now();
		expect((await serveDownload(new Request(link), downloadEnv(), now)).status).toBe(200);
		// Five minutes, then nothing.
		expect((await serveDownload(new Request(link), downloadEnv(), now + 6 * 60 * 1000)).status).toBe(404);
		const tampered = (edit: (query: URLSearchParams) => void) => {
			const url = new URL(link);
			edit(url.searchParams);
			return new Request(url);
		};
		for (const edit of [
			(q: URLSearchParams) => q.set("p", "other.txt"),
			(q: URLSearchParams) => q.set("k", q.get("k")?.replace(conversation, other.conversation) as string),
			(q: URLSearchParams) => q.set("e", String(Number(q.get("e")) + 3600)),
			// Never a no-op: one signature in 4096 already ends in "AA".
			(q: URLSearchParams) => q.set("s", `${q.get("s")?.slice(0, -2)}${q.get("s")?.endsWith("AA") ? "BB" : "AA"}`),
		]) {
			const response = await serveDownload(tampered(edit), downloadEnv(), now);
			expect([response.status, await response.json()]).toEqual([404, { detail: "Not Found" }]);
		}
		expect((await serveDownload(tampered((q) => q.delete("s")), downloadEnv(), now)).status).toBe(401);
		// Only on the origin it was signed for.
		const elsewhere = new URL(link);
		elsewhere.host = "localhost:9999";
		expect((await serveDownload(new Request(elsewhere), downloadEnv(), now)).status).toBe(404);
	});
});
