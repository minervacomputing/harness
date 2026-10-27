// Laravel's `startRun` and `cancelRun` in workerd: through the internal mount behind an
// Access assertion, the recovery index in D1, and the Conversation object, whose turns answer with the fake model.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { connectorRegistry } from "../../src/connectors/index.ts";
import type { Conversation } from "../../src/conversation/conversation.ts";
import { PI_SETTLE_MS } from "../../src/conversation/pi-stops.ts";
import { defaultPorts, PORTS, type PortsContext } from "../../src/conversation/ports.ts";
import { FOLDER_PORTS } from "../../src/files/folder.ts";
import { COPY_BOUND_MS } from "../../src/files/limits.ts";
import type { Bucket } from "../../src/files/objects.ts";
import { catalogOf } from "../../src/internal/catalog.ts";
import { inputDigest } from "../../src/internal/start.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { commands, objectOf, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

/** Every model request's transcript, in order, of the file's runs. */
const contexts: TranscriptContext[] = [];
const realBucket = FOLDER_PORTS.bucket;
const realCounter = FOLDER_PORTS.counter;
let point: ((context: PortsContext, name: string, detail?: string) => Promise<void>) | null = null;
let copyBoundMs = COPY_BOUND_MS;
let piSettleMs = PI_SETTLE_MS;

beforeAll(() => {
	PORTS.factory = () => ({
		...defaultPorts,
		upstream: () => fakeUpstream({ onCall: (_call, context) => contexts.push(context) }),
		point: async (context, name, detail) => point?.(context, name, detail),
		copyBoundMs: () => copyBoundMs,
		piSettleMs: () => piSettleMs,
	});
});

afterEach(() => {
	FOLDER_PORTS.bucket = realBucket;
	FOLDER_PORTS.counter = realCounter;
	point = null;
	copyBoundMs = COPY_BOUND_MS;
	piSettleMs = PI_SETTLE_MS;
	contexts.length = 0;
});

const UNAVAILABLE = "An attached file is no longer available. Remove it and attach it again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 8000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(20);
	}
}

/** A message the fake model answers with this script. */
const scripted = (script: FakeScript) => JSON.stringify({ fake: script });

/** An answer that streams for about ten seconds, so the run stays running until it is cancelled. */
const SLOW = scripted({ turns: [{ text: "a".repeat(160) }], chunkChars: 8, delayMs: 500 });

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

function settled(start: StartRun): Promise<RunRow | null> {
	return until(
		() => runRow(start),
		(row) => row !== null && !ACTIVE.includes(row.status),
	);
}

function running(start: StartRun): Promise<RunRow | null> {
	return until(
		() => runRow(start),
		(row) => row?.status === "running",
	);
}

function cancelOf(start: StartRun, reason: "cancelled" | "member_removed" | "start_expired" = "cancelled") {
	return commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason });
}

/** A second run in the same conversation. */
function next(start: StartRun, change: Partial<StartRun> = {}): StartRun {
	return startOf(start.scope, { conversation: start.conversation, ...change });
}

function stage(workspace: string, contents: string | Uint8Array): Promise<string> {
	const key = `uploads/${workspace}/${uuid7()}`;
	return env.FILES_EU.put(key, contents).then(() => key);
}

function bucketWith(change: (inner: Bucket) => Partial<Bucket>): void {
	FOLDER_PORTS.bucket = (context) => {
		const inner = realBucket(context);
		return {
			get: (key) => inner.get(key),
			put: (key, value, options) => inner.put(key, value, options),
			list: (options) => inner.list(options),
			delete: (keys) => inner.delete(keys),
			...change(inner),
		};
	};
}

/**
 * Counts the bytes the first read of each staged object takes from the bucket; `sizes` gives an object another size than
 * it holds. A later read of an object waits for `release`, so none is made before the test has read the counts.
 */
function countingReads(sizes: Map<string, number> = new Map()): { pulled: Map<string, number>; release: () => void } {
	const pulled = new Map<string, number>();
	const released = Promise.withResolvers<void>();
	bucketWith((inner) => ({
		async get(key) {
			if (pulled.has(key)) {
				await released.promise;
				return inner.get(key);
			}
			const object = await inner.get(key);
			if (object === null) return object;
			pulled.set(key, 0);
			const data = new Uint8Array(await new Response(object.body).arrayBuffer());
			let offset = 0;
			// A default read is handed a view of 64 KiB; a read with a view of its own, no more than that view.
			const body = new ReadableStream(
				{
					type: "bytes",
					autoAllocateChunkSize: 65_536,
					pull(controller) {
						const request = controller.byobRequest as ReadableStreamBYOBRequest;
						const view = request.view as Uint8Array;
						if (offset >= data.byteLength) {
							controller.close();
							request.respond(0);
							return;
						}
						const size = Math.min(data.byteLength - offset, view.byteLength);
						new Uint8Array(view.buffer, view.byteOffset, size).set(data.subarray(offset, offset + size));
						request.respond(size);
						offset += size;
						pulled.set(key, (pulled.get(key) ?? 0) + size);
					},
				},
				{ highWaterMark: 0 },
			);
			return { body, size: sizes.get(key) ?? object.size };
		},
	}));
	return { pulled, release: () => released.resolve() };
}

async function attaching(within: ReturnType<typeof scope>, contents: string[], options: { conversation?: string; content?: string } = {}): Promise<StartRun> {
	const attachments = await Promise.all(
		contents.map(async (data, index) => ({ upload: await stage(within.workspace, data), name: `${String.fromCharCode(97 + index)}.txt`, size: data.length, mediaType: "text/plain" })),
	);
	const message = { id: uuid7(), content: options.content ?? `Read ${contents.length} files`, attachments };
	return startOf(within, { message, ...(options.conversation ? { conversation: options.conversation } : {}) });
}

function attachmentsOf(start: StartRun) {
	return runInDurableObject(objectOf(start), (_instance, state) => {
		const sql = state.storage.sql;
		return {
			rows: sql.exec("SELECT position, name, size, media_type, path FROM run_attachments WHERE run_id = ? ORDER BY position", start.run).toArray(),
			base: sql.exec<{ base: string | null }>("SELECT base_version_id AS base FROM runs WHERE id = ?", start.run).toArray()[0]?.base ?? null,
			folder: sql.exec<{ folder: string | null }>("SELECT folder_version_id AS folder FROM conversation").toArray()[0]?.folder ?? null,
			blobs: sql.exec<{ key: string; state: string }>("SELECT key, state FROM folder_blobs ORDER BY created_at, key").toArray(),
		};
	});
}

function eventsOf(start: StartRun): Promise<string[]> {
	return runInDurableObject(objectOf(start), (_instance, state) =>
		state.storage.sql.exec<{ data: string }>("SELECT data FROM run_events WHERE run_id = ? ORDER BY seq", start.run).toArray().map((event) => event.data),
	);
}

/** The run's watch made due now, as Lifecycle runs it once its time comes (retention.test.ts `due`). */
async function watchNow(start: StartRun): Promise<void> {
	await runInDurableObject(objectOf(start), async (_instance, state) => {
		state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0, running = 0 WHERE id = ?", `watch:${start.run}`);
		await state.storage.setAlarm(Date.now());
	});
}

const lastTranscript = () => JSON.stringify(contexts.at(-1));

describe("startRun", () => {
	test("is accepted once its run is stored, and its turn runs with the history and prompt Laravel sent", async () => {
		const within = scope();
		const earlier = uuid7();
		const start = startOf(within, {
			message: { id: uuid7(), content: "And now?", attachments: [] },
			history: [
				{ id: uuid7(), role: "user", content: "An earlier question", attachments: [], run: earlier, createdAt: "2026-10-14T10:00:00+00:00", changes: null },
				{ id: uuid7(), role: "assistant", content: "An earlier answer", attachments: [], run: earlier, createdAt: "2026-10-14T10:00:05+00:00", changes: null },
			],
		});
		const answer = await commands.startRun(start);
		expect(answer).toEqual({
			outcome: "accepted",
			catalog: (await catalogOf(await connectorRegistry())).version,
			compiler: "4",
			digest: expect.stringMatching(/^[0-9a-f]{64}$/),
			authorized: [],
			attachments: [],
		});
		// The index's rows were written first, with the input's digest and the jurisdiction the object lives in.
		const conversation = await env.DB.prepare("SELECT organization_id, workspace_id, jurisdiction FROM recovery_conversations WHERE id = ?").bind(start.conversation).first();
		expect(conversation).toEqual({ organization_id: within.organization, workspace_id: within.workspace, jurisdiction: "eu" });
		const run = await env.DB.prepare("SELECT conversation_id, input_digest FROM recovery_runs WHERE id = ?").bind(start.run).first();
		expect(run).toEqual({ conversation_id: start.conversation, input_digest: await inputDigest(start) });

		expect(await settled(start)).toMatchObject({ status: "completed" });
		const transcript = JSON.stringify(contexts.at(-1));
		const [question, reply, prompt] = ["An earlier question", "An earlier answer", "And now?"].map((text) => transcript.indexOf(text));
		expect(question).toBeGreaterThan(-1);
		expect(reply).toBeGreaterThan(question as number);
		expect(prompt).toBeGreaterThan(reply as number);
		expect(transcript).toContain("Be brief.");

		// Sent again, it is answered as it was the first time, and nothing runs again.
		const calls = contexts.length;
		expect(await commands.startRun(start)).toEqual(answer);
		expect(contexts.length).toBe(calls);
	});

	test("stores its run active in the write that answers it, so no state the object keeps holds it queued", async () => {
		const start = startOf(scope());
		const stub = objectOf(start);
		// The run as storage holds it after each of the object's synchronous transactions that has it.
		const committed: { status: string; activated: number; answered: number; events: string[] }[] = [];
		await runInDurableObject(stub, (_instance, state) => {
			const storage = state.storage;
			const transactionSync = storage.transactionSync.bind(storage);
			const record = <T>(closure: () => T): T => {
				const result = transactionSync(closure);
				const run = storage.sql.exec<{ status: string; activated: number }>("SELECT status, activated FROM runs WHERE id = ?", start.run).toArray()[0];
				if (run) {
					const answered = storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM internal_answers WHERE run_id = ?", start.run).one().n;
					const events = storage.sql.exec<{ data: string }>("SELECT data FROM run_events WHERE run_id = ? ORDER BY seq", start.run).toArray().map((event) => event.data);
					committed.push({ ...run, answered, events });
				}
				return result;
			};
			Object.defineProperty(storage, "transactionSync", { value: record, configurable: true, writable: true });
		});
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		expect(committed[0]).toEqual({ status: "provisioning", activated: 1, answered: 1, events: ['{"status":"queued"}', '{"status":"provisioning"}'] });
		expect(await settled(start)).toMatchObject({ status: "completed" });
	});

	test("compiles the authority it is sent: the authorized set is the connections the run's tools reach", async () => {
		const within = scope();
		const [mine, theirs, revoked] = [uuid7(), uuid7(), uuid7()];
		const connection = (id: string, owner: string | null, status: "active" | "revoked") => ({
			id,
			provider: "todoist",
			owner,
			status,
			createdAt: "2026-10-14T09:00:00+00:00",
			scopes: ["data:read_write"],
			revision: 1,
		});
		const start = startOf(within, {
			authority: {
				connections: [connection(mine, "42", "active"), connection(theirs, "7", "active"), connection(revoked, null, "revoked")],
				layers: { ceiling: null, user: { restricted: false, revision: 1, grants: [] }, agent: null },
			},
		});
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", authorized: [mine] });
		await settled(start);
	});

	test("the same run with another input, or under another scope or conversation, is refused, and the index is kept", async () => {
		const within = scope();
		const start = startOf(within);
		const accepted = await commands.startRun(start);
		expect(await refusalOf(commands.startRun({ ...start, message: { ...start.message, content: "Something else" } }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
		expect(await refusalOf(commands.startRun({ ...start, scope: { ...within, workspace: uuid7() } }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		expect(await refusalOf(commands.startRun({ ...start, scope: { ...within, organization: uuid7() } }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		// A conversation named with a run bound to another is not bound by the refused command: its own first start is.
		const unseen = uuid7();
		expect(await refusalOf(commands.startRun({ ...start, conversation: unseen }))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		expect(await env.DB.prepare("SELECT 1 AS found FROM recovery_conversations WHERE id = ?").bind(unseen).first()).toBeNull();
		expect(await commands.startRun(startOf(scope(), { conversation: unseen }))).toMatchObject({ outcome: "accepted" });
		expect(await commands.startRun(start)).toEqual(accepted);
		await settled(start);

		// A run a cancel bound: a start naming it under another conversation sets no digest, so the right one is answered.
		const cancelled = startOf(within);
		expect(await cancelOf(cancelled)).toEqual({ state: "tombstoned" });
		expect(await refusalOf(commands.startRun({ ...cancelled, conversation: uuid7() }))).toMatchObject({ code: "SCOPE_MISMATCH" });
		expect(await env.DB.prepare("SELECT input_digest FROM recovery_runs WHERE id = ?").bind(cancelled.run).first("input_digest")).toBeNull();
		expect(await commands.startRun(cancelled)).toMatchObject({ outcome: "refused", code: "CANCELLED" });
	});

	test("sent twice at once, it is one start with one answer", async () => {
		const within = scope();
		const staged = await stage(within.workspace, "hello");
		const start = startOf(within, { message: { id: uuid7(), content: "Read this", attachments: [{ upload: staged, name: "a.txt", size: 5, mediaType: "text/plain" }] } });
		const [first, second] = await Promise.all([commands.startRun(start), commands.startRun(start)]);
		expect(first).toMatchObject({ outcome: "accepted" });
		expect(second).toEqual(first);
		await settled(start);
		const runs = await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM runs").one().n);
		expect(runs).toBe(1);
	});

	test("a conversation the Workspace made is not Laravel's", async () => {
		const within = scope();
		const start = startOf(within);
		// The row as the Workspace's `init` wrote it: an owner and an agent, no organization.
		await runInDurableObject(objectOf(start), (_instance, state) =>
			void state.storage.sql.exec(
				"INSERT INTO conversation (singleton, id, workspace_id, jurisdiction, user_id, agent_id, created_at, updated_at) VALUES (1, ?, ?, 'eu', ?, ?, ?, ?)",
				start.conversation,
				within.workspace,
				uuid7(),
				uuid7(),
				Date.now(),
				Date.now(),
			),
		);
		expect(await refusalOf(commands.startRun(start))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
		expect(await refusalOf(cancelOf(start))).toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
	});

	test("a busy conversation refuses another run, and the refusal is its answer from then on", async () => {
		const first = startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } });
		await commands.startRun(first);
		const second = next(first);
		const busy = { outcome: "refused", code: "CONVERSATION_BUSY", message: "Wait for the current answer to finish, or stop it." };
		expect(await commands.startRun(second)).toEqual(busy);
		await cancelOf(first);
		await settled(first);
		expect(await commands.startRun(second)).toEqual(busy);
		const third = next(first);
		expect(await commands.startRun(third)).toMatchObject({ outcome: "accepted" });
		await settled(third);
	});

	test("refuses a message with nothing in it, or attachments that cannot be taken", async () => {
		const within = scope();
		const staged = await stage(within.workspace, "hello");
		const file = (upload: string, size = 5) => ({ upload, name: "notes.txt", size, mediaType: "text/plain" });
		const cases: [StartRun["message"]["attachments"], string, string][] = [
			[Array.from({ length: 11 }, () => file(staged)), "TOO_MANY_ATTACHMENTS", "Attach at most 10 files to a message."],
			[[file(staged), file(staged)], "ATTACHED_TWICE", "A file is attached twice."],
			[[file(`uploads/${uuid7()}/elsewhere`)], "ATTACHMENT_UNAVAILABLE", UNAVAILABLE],
			[[file(`uploads/${within.workspace}/${uuid7()}`)], "ATTACHMENT_UNAVAILABLE", UNAVAILABLE],
			[[file(staged), file(`uploads/${within.workspace}/${uuid7()}`)], "ATTACHMENT_UNAVAILABLE", UNAVAILABLE],
			[[file(staged, 6)], "ATTACHMENT_UNAVAILABLE", UNAVAILABLE],
		];
		const empty = startOf(within, { message: { id: uuid7(), content: "  \n", attachments: [] } });
		expect(await commands.startRun(empty)).toEqual({ outcome: "refused", code: "EMPTY_MESSAGE", message: "Write a message or attach a file." });
		for (const [attachments, code, message] of cases) {
			const start = startOf(within, { message: { id: uuid7(), content: "", attachments } });
			expect(await commands.startRun(start), code).toEqual({ outcome: "refused", code, message });
			expect(await commands.startRun(start), code).toEqual({ outcome: "refused", code, message });
			expect(await runRow(start), code).toBeNull();
			expect((await env.FILES_EU.list({ prefix: `blobs/${within.workspace}/${start.conversation}/` })).objects, code).toEqual([]);
			// A refused start leaves its staged upload where it was, and the conversation free: a file staged again attaches.
			expect(await env.FILES_EU.head(staged), code).not.toBeNull();
			const again = next(start, { message: { id: uuid7(), content: "", attachments: [file(await stage(within.workspace, "hello"))] } });
			expect(await commands.startRun(again), code).toMatchObject({ outcome: "accepted", attachments: [{ path: "notes.txt", size: 5 }] });
			await settled(again);
		}
	});

	test("refuses a continuation naming a run the conversation does not hold, and the refusal is its answer from then on", async () => {
		const start = startOf(scope(), { message: { id: uuid7(), content: "Approved.", attachments: [] }, approval: { run: uuid7(), decisions: [{ position: 1, approve: true }] } });
		const refused = { outcome: "refused", code: "APPROVAL_UNKNOWN", message: "These decisions do not match the actions waiting for approval." };
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await runRow(start)).toBeNull();
		const plain = next(start);
		expect(await commands.startRun(plain)).toMatchObject({ outcome: "accepted" });
		await settled(plain);
	});

	test("is accepted after reading at most 8 KiB of each staged object, and the run then copies them into its base version", async () => {
		const within = scope();
		const large = new Uint8Array(1024 * 1024);
		for (let i = 0; i < large.length; i += 65_536) crypto.getRandomValues(large.subarray(i, i + 65_536));
		large.set(new TextEncoder().encode("%PDF-1.7"));
		const [report, notes] = [await stage(within.workspace, large), await stage(within.workspace, "hello")];
		const start = startOf(within, {
			message: {
				id: uuid7(),
				content: "Read this",
				attachments: [
					{ upload: report, name: "report.pdf", size: large.length, mediaType: "application/pdf" },
					{ upload: notes, name: "dir/notes.txt", size: 5, mediaType: "application/x-claimed" },
				],
			},
		});
		const { pulled, release } = countingReads();
		expect(await commands.startRun(start)).toMatchObject({
			outcome: "accepted",
			attachments: [
				{ path: "report.pdf", size: large.length, mediaType: "application/pdf" },
				{ path: "notes.txt", size: 5, mediaType: "text/plain" },
			],
		});
		expect(Object.fromEntries(pulled)).toEqual({ [report]: 8192, [notes]: 5 });
		expect(await attachmentsOf(start)).toEqual({
			rows: [
				{ position: 0, name: "report.pdf", size: large.length, media_type: "application/pdf", path: "report.pdf" },
				{ position: 1, name: "notes.txt", size: 5, media_type: "text/plain", path: "notes.txt" },
			],
			base: null,
			folder: null,
			blobs: [],
		});
		release();
		expect(await settled(start)).toMatchObject({ status: "completed" });
		const after = await attachmentsOf(start);
		expect(after).toMatchObject({ rows: [], base: expect.any(String), folder: expect.any(String) });
		expect(after.blobs.map((blob) => blob.state)).toEqual(["stored", "stored"]);
		expect((await eventsOf(start)).slice(0, 5)).toEqual([
			'{"status":"queued"}',
			'{"status":"provisioning"}',
			'{"text":"Copying the attached files"}',
			'{"status":"running"}',
			'{"text":"Starting the agent"}',
		]);
		expect(lastTranscript()).toContain("[The user attached report.pdf, notes.txt to this message, in your folder.]");
		const blobs = await env.FILES_EU.list({ prefix: `blobs/${within.workspace}/${start.conversation}/` });
		expect(blobs.objects.map((object) => object.size).sort((a, b) => a - b)).toEqual([5, large.length]);
		for (const staged of [report, notes]) {
			await until(
				() => env.FILES_EU.head(staged),
				(object) => object === null,
			);
		}
	});

	test("refuses attachments over the folder's limits from their declared sizes, reading no more than each one's head", async () => {
		const within = scope();
		const MB50 = 50 * 1024 * 1024;
		const keys = await Promise.all(Array.from({ length: 6 }, () => stage(within.workspace, "x".repeat(20_000))));
		const { pulled } = countingReads(new Map(keys.map((key) => [key, MB50])));
		const start = startOf(within, {
			message: { id: uuid7(), content: "", attachments: keys.map((upload, index) => ({ upload, name: `${index}.bin`, size: MB50, mediaType: "application/octet-stream" })) },
		});
		const refused = { outcome: "refused", code: "FOLDER_FULL", message: "These files would make this conversation's folder larger than 256 MB." };
		expect(await commands.startRun(start)).toEqual(refused);
		expect([...pulled.values()]).toEqual(Array.from({ length: 6 }, () => 8192));
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await runRow(start)).toBeNull();
	});

	test("a start cut off by a reset after its inspection stores no answer, and sent again is accepted as first compiled", async () => {
		const within = scope();
		const start = await attaching(within, ["hello"]);
		let resets = 0;
		point = async (context, name) => {
			if (name === "start:planned" && resets++ === 0) context.ctx.abort("fault: start:planned");
		};
		expect((await refusalOf(commands.startRun(start))).status).toBeGreaterThanOrEqual(500);
		const prepared = await runInDurableObject(objectOf(start), (_instance, state) => {
			const parts = state.storage.sql.exec<{ text: string }>("SELECT text FROM internal_starts WHERE run_id = ? ORDER BY part", start.run).toArray();
			const answers = state.storage.sql.exec("SELECT 1 FROM internal_answers WHERE run_id = ?", start.run).toArray();
			const runs = state.storage.sql.exec("SELECT 1 FROM runs").toArray();
			return { preparation: JSON.parse(parts.map((part) => part.text).join("")) as { digest: string }, answers: answers.length, runs: runs.length };
		});
		expect(prepared).toMatchObject({ answers: 0, runs: 0 });
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", digest: prepared.preparation.digest });
		expect(await settled(start)).toMatchObject({ status: "completed" });
		const blobs = await env.FILES_EU.list({ prefix: `blobs/${within.workspace}/${start.conversation}/` });
		expect(blobs.objects).toHaveLength(1);
	});
});

describe("the copy, the run's first step", () => {
	/** A conversation with one completed run, so its pi conversation exists and the next run's input may carry a turn note. */
	async function conversationWithTurn(): Promise<StartRun> {
		const first = startOf(scope());
		await commands.startRun(first);
		expect(await settled(first)).toMatchObject({ status: "completed" });
		return first;
	}

	async function nextTurn(start: StartRun): Promise<string> {
		const after = next(start);
		expect(await commands.startRun(after)).toMatchObject({ outcome: "accepted" });
		expect(await settled(after)).toMatchObject({ status: "completed" });
		return lastTranscript();
	}

	test("a staged object deleted after the acceptance ends the run before its prompt, and the next turn's note leaves it out", async () => {
		const first = await conversationWithTurn();
		const folder = (await attachmentsOf(first)).folder;
		const start = await attaching(first.scope, ["kept", "gone"], { conversation: first.conversation, content: "Never submitted" });
		const gone = (start.message.attachments[1] as { upload: string }).upload;
		let reads = 0;
		bucketWith((inner) => ({
			async get(key) {
				if (key === gone && ++reads === 2) await env.FILES_EU.delete(key);
				return inner.get(key);
			},
		}));
		const calls = contexts.length;
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		expect(await settled(start)).toEqual({ status: "failed", error_code: "attachment_unavailable", revoked: 0 });
		expect(contexts.length).toBe(calls);
		expect(await attachmentsOf(start)).toMatchObject({ rows: [{ path: "a.txt" }, { path: "b.txt" }], base: folder, folder });
		const transcript = await nextTurn(start);
		expect(transcript).not.toContain("Never submitted");
		expect(transcript).not.toMatch(/was stopped before you saw it|did not reach you/);
	});

	test("a workspace with no room for the copies ends the run", async () => {
		FOLDER_PORTS.counter = () => ({ setConversationBytes: async () => ({ ok: false, limit: "workspace" }) });
		const start = await attaching(scope(), ["hello"]);
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", attachments: [{ path: "a.txt", size: 5, mediaType: "text/plain" }] });
		expect(await settled(start)).toEqual({ status: "failed", error_code: "workspace_full", revoked: 0 });
		const error = await runInDurableObject(objectOf(start), (_instance, state) => state.storage.sql.exec("SELECT error_message FROM runs").one().error_message);
		expect(error).toBe("This workspace has no room for more files.");
		expect(await attachmentsOf(start)).toMatchObject({ rows: [{ path: "a.txt" }], base: null, folder: null });
	});

	test("a reset after the copy, before its commit: the next instance copies into the keys it recorded, stored once", async () => {
		const start = await attaching(scope(), ["hello"]);
		let resets = 0;
		point = async (context, name) => {
			if (name === "copy:copied" && resets++ === 0) context.ctx.abort("fault: copy:copied");
		};
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		// The next call reaches a new instance, whose start runs the copy again.
		const done = await until(
			() => objectOf(start).faultView(start.run).catch(() => null),
			(view) => view?.head?.status === "completed",
		);
		expect(resets).toBe(2);
		expect(done?.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		const { blobs } = await attachmentsOf(start);
		expect(blobs.map((blob) => blob.state)).toEqual(["stored"]);
		const stored = await env.FILES_EU.list({ prefix: `blobs/${start.scope.workspace}/${start.conversation}/` });
		expect(stored.objects.map((object) => object.key)).toEqual([blobs[0]?.key]);
	});

	test.each([
		["start_expired", "failed"],
		["cancelled", "cancelled"],
	] as const)("a %s cancel during the copy commits nothing, and the next turn's note leaves the run out", async (reason, status) => {
		const first = await conversationWithTurn();
		const folder = (await attachmentsOf(first)).folder;
		const start = await attaching(first.scope, ["hello"], { conversation: first.conversation, content: "Stopped while copying" });
		const putting = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		bucketWith((inner) => ({
			async put(key, value, options) {
				putting.resolve();
				await hold.promise;
				return inner.put(key, value, options);
			},
		}));
		// The object restarts, so its new instance builds its folder with this bucket.
		await runInDurableObject(objectOf(first), (_instance, state) => state.abort("fault: reload")).catch(() => {});
		const accepted = await commands.startRun(start);
		expect(accepted).toMatchObject({ outcome: "accepted" });
		await putting.promise;
		expect(await cancelOf(start, reason)).toEqual({ state: "cancelled" });
		hold.resolve();
		expect(await settled(start)).toEqual({ status, error_code: reason, revoked: 1 });
		await until(
			() => attachmentsOf(start),
			(held) => held.blobs.length === 1 && held.blobs[0]?.state === "doomed",
		);
		expect(await attachmentsOf(start)).toMatchObject({ rows: [{ path: "a.txt" }], base: folder, folder });
		expect(await commands.startRun(start)).toEqual(accepted);
		const transcript = await nextTurn(start);
		expect(transcript).not.toContain("Stopped while copying");
		expect(transcript).not.toMatch(/was stopped before you saw it|did not reach you/);
	});

	test("a copy that outlasts the section's bound does not reset the object", async () => {
		piSettleMs = 300;
		bucketWith((inner) => ({
			async put(key, value, options) {
				await sleep(1000);
				return inner.put(key, value, options);
			},
		}));
		const start = await attaching(scope(), ["hello"]);
		await commands.startRun(start);
		expect(await settled(start)).toMatchObject({ status: "completed" });
		const view = await objectOf(start).faultView(start.run);
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		expect(view.aborts).toEqual([]);
	});

	test.each([
		["the next try's put works", "completed", ""],
		["the bound has passed", "failed", "attachment_unavailable"],
	])("an R2 error during the copy is tried again by the watch with new keys; %s", async (_case, status, code) => {
		let failing = true;
		bucketWith((inner) => ({
			async put(key, value, options) {
				if (failing || code !== "") throw new Error("put: Network connection lost.");
				return inner.put(key, value, options);
			},
		}));
		const start = await attaching(scope(), ["hello"]);
		await commands.startRun(start);
		await until(
			() => attachmentsOf(start),
			(held) => held.blobs.length === 1 && held.blobs[0]?.state === "doomed",
		);
		failing = false;
		if (code !== "") copyBoundMs = 0;
		await watchNow(start);
		expect(await settled(start)).toMatchObject({ status, error_code: code });
		const { blobs, rows } = await attachmentsOf(start);
		expect(blobs.map((blob) => blob.state)).toEqual(code === "" ? ["doomed", "stored"] : ["doomed", "doomed"]);
		expect(new Set(blobs.map((blob) => blob.key)).size).toBe(2);
		expect(rows).toHaveLength(code === "" ? 0 : 1);
	});
});

describe("cancelRun", () => {
	test("fences a running run, keeps its first reason, and answers the same when repeated", async () => {
		const start = startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } });
		await commands.startRun(start);
		await running(start);
		expect(await cancelOf(start, "member_removed")).toEqual({ state: "cancelled" });
		expect(await runRow(start)).toEqual({ status: "cancelled", error_code: "member_removed", revoked: 1 });
		expect(await cancelOf(start, "cancelled")).toEqual({ state: "cancelled" });
		expect(await runRow(start)).toMatchObject({ error_code: "member_removed" });
		// A lost acceptance sent again after the cancel: the same acceptance, and the run stays stopped.
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		expect(await runRow(start)).toMatchObject({ status: "cancelled" });
	});

	test("answers that a run which ended by itself has ended", async () => {
		const start = startOf(scope());
		await commands.startRun(start);
		await settled(start);
		expect(await cancelOf(start)).toEqual({ state: "ended" });
	});

	test("tombstones a run not received yet, so its start is refused", async () => {
		const start = startOf(scope());
		expect(await cancelOf(start, "start_expired")).toEqual({ state: "tombstoned" });
		const refused = { outcome: "refused", code: "CANCELLED", message: "This run was cancelled before it started." };
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await commands.startRun(start)).toEqual(refused);
		expect(await cancelOf(start)).toEqual({ state: "tombstoned" });
		expect(await runRow(start)).toBeNull();
	});

	test("refuses a run named under another conversation than the one it was bound to", async () => {
		const start = startOf(scope());
		await commands.startRun(start);
		expect(await refusalOf(commands.cancelRun({ scope: start.scope, conversation: uuid7(), run: start.run, reason: "cancelled" }))).toMatchObject({
			code: "SCOPE_MISMATCH",
			status: 409,
		});
		await settled(start);
	});

	/** A bucket whose `which`th get waits until `hold` settles; `reading` settles when it is asked. */
	function holding(which: number) {
		const reading = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		let gets = 0;
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				...inner,
				async get(key) {
					if (++gets === which) {
						reading.resolve();
						await hold.promise;
					}
					return inner.get(key);
				},
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				put: (key, value, options) => inner.put(key, value, options),
			};
		};
		return { reading: reading.promise, release: () => hold.resolve() };
	}

	const cancelledFirst = { outcome: "refused", code: "CANCELLED", message: "This run was cancelled before it started." };

	test("arriving after the start's inspection, before the write that stores its run, refuses the start", async () => {
		const start = await attaching(scope(), ["hello"]);
		const planned = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		point = async (_context, name) => {
			if (name !== "start:planned") return;
			planned.resolve();
			await hold.promise;
		};
		const answer = commands.startRun(start);
		await planned.promise;
		expect(await cancelOf(start)).toEqual({ state: "tombstoned" });
		hold.resolve();
		expect(await answer).toEqual(cancelledFirst);
		expect(await runRow(start)).toBeNull();
		// The conversation is free for the next run.
		const after = next(start);
		expect(await commands.startRun(after)).toMatchObject({ outcome: "accepted" });
		await settled(after);
	});

	test("arriving while the start inspects an attachment that is not there, is the refusal that counts", async () => {
		const within = scope();
		const start = startOf(within, {
			message: { id: uuid7(), content: "Read this", attachments: [{ upload: `uploads/${within.workspace}/${uuid7()}`, name: "a.txt", size: 5, mediaType: "text/plain" }] },
		});
		const inspecting = holding(1);
		const answer = commands.startRun(start);
		await inspecting.reading;
		expect(await cancelOf(start)).toEqual({ state: "tombstoned" });
		inspecting.release();
		expect(await answer).toEqual(cancelledFirst);
		expect(await commands.startRun(start)).toEqual(cancelledFirst);
	});

	test("arriving while pi's transaction is open, is acknowledged only once it is kept", async () => {
		const start = startOf(scope(), { message: { id: uuid7(), content: SLOW, attachments: [] } });
		await commands.startRun(start);
		await running(start);
		const workspace = { id: start.scope.workspace, jurisdiction: "eu" as const };
		const stored = await runInDurableObject(objectOf(start), async (instance, state) => {
			let ack: ReturnType<Conversation["cancelInternal"]> | null = null;
			await state.storage
				.transaction(async () => {
					await Promise.resolve();
					ack = instance.cancelInternal({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" }, workspace, false);
					await Promise.resolve();
					throw new Error("rolled back");
				})
				.catch(() => {});
			expect(await (ack as unknown as ReturnType<Conversation["cancelInternal"]>)).toEqual({ ok: true, value: { state: "cancelled" } });
			return state.storage.sql.exec("SELECT status, revoked, error_code FROM runs WHERE id = ?", start.run).one();
		});
		expect(stored).toEqual({ status: "cancelled", revoked: 1, error_code: "cancelled" });
	});
});
