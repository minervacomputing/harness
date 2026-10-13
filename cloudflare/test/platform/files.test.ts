// Agent files in local workerd (plan: Files): uploads streamed into R2 while hashed and
// recorded in the real Workspace object, the download origin's handler on the local buckets, the folder's
// store on a Durable Object's own SQLite, attachments copied into a conversation's blobs by the real start
// protocol, and the fault rows Files (plan: Testing): an attachment's copy crashed and retried, an R2
// acknowledgement lost, a write that lands while its conversation is deleted.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { conversationObject, filesBucket, workspaceObject } from "../../src/addressing.ts";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import type { Conversation, Workspace } from "../../src/faults/index.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { type DownloadEnv, serveDownload } from "../../src/files/download.ts";
import { FOLDER_PORTS } from "../../src/files/folder.ts";
import { BODY_LONGER, BODY_SHORTER, NO_LONGER_AVAILABLE, TOO_SLOW } from "../../src/files/limits.ts";
import { signDownload } from "../../src/files/links.ts";
import { parseManifest } from "../../src/files/manifest.ts";
import type { Bucket } from "../../src/files/objects.ts";
import { FolderStore } from "../../src/files/store.ts";
import { receiveUpload, type UploadBucket, type UploadRecorder } from "../../src/files/uploads.ts";
import { hex } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { durableSql } from "../../src/lib/sql.ts";
import type { Caller, RunId, WorkspaceRef } from "../../src/shared/rpc.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";

const USER = "0199a000-0000-7000-8000-00000000f11e";
const CALLER: Caller = { userId: USER, role: "owner" };
const DONE = JSON.stringify({ fake: { turns: [{ text: "Noted." }] } });

type ConversationStub = DurableObjectStub<Conversation>;
type WorkspaceStub = DurableObjectStub<Workspace>;

const realBucket = FOLDER_PORTS.bucket;

beforeAll(() => {
	// The test build's wiring, as src/faults/index.ts sets it (another test file may have replaced it).
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

afterEach(() => {
	FOLDER_PORTS.bucket = realBucket;
});

async function sha(data: Uint8Array | string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data)));
}

function body(data: Uint8Array | string): ReadableStream<Uint8Array> {
	return new Response(data).body as ReadableStream<Uint8Array>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 10_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		let value: T | undefined;
		try {
			value = await read();
		} catch {
			// A reset object refuses the call that was in flight; the next one reaches its new instance.
		}
		if (value !== undefined && done(value)) return value;
		if (Date.now() - started > timeout) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(25);
	}
}

/** A workspace with its default agent and a conversation, both objects reached by fresh stubs. */
async function world(jurisdiction: "eu" | null = null) {
	const ref: WorkspaceRef = { id: uuid7(), jurisdiction };
	const ws = () => workspaceObject(env, ref) as unknown as WorkspaceStub;
	await ws().init({ workspace: ref, kind: "personal", ownerId: USER, createdAt: Date.now() });
	const [agent] = await ws().listAgents(CALLER);
	const created = await ws().createConversation(CALLER, agent?.id as string);
	if (!created.ok) throw new Error(created.refusal.detail);
	const conversationId = created.value.id;
	const conversation = () => conversationObject(env, ref, conversationId) as unknown as ConversationStub;
	const recorder: UploadRecorder = {
		reserveUpload: (caller, upload) => ws().reserveUpload(caller, upload),
		completeUpload: (caller, id, stored) => ws().completeUpload(caller, id, stored),
		abandonUpload: (caller, id) => ws().abandonUpload(caller, id),
	};
	const bucket = filesBucket(env, ref);
	const upload = async (name: string, data: string | Uint8Array) => {
		const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
		const outcome = await receiveUpload(recorder, bucket, CALLER, { name, size: content.length, body: body(content) });
		if (!outcome.ok) throw new Error(outcome.refusal.detail);
		return outcome.value;
	};
	const prefix = `blobs/${ref.id}/${conversationId}/`;
	return {
		ref,
		get ws() {
			return ws();
		},
		get conversation() {
			return conversation();
		},
		conversationId,
		recorder,
		bucket,
		upload,
		prefix,
		/** Keys under the conversation's prefix, sorted. */
		async blobs(): Promise<string[]> {
			return (await bucket.list({ prefix })).objects.map((object) => object.key).sort();
		},
		/** The Workspace's rows. */
		workspaceRows<T>(query: string, ...bindings: (string | number)[]): Promise<T[]> {
			return runInDurableObject(ws(), (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
		},
		conversationRows<T>(query: string, ...bindings: (string | number)[]): Promise<T[]> {
			return runInDurableObject(conversation(), (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
		},
	};
}

type World = Awaited<ReturnType<typeof world>>;

async function settled(w: World, runId: RunId): Promise<RunHead> {
	return until(async () => (await w.conversation.getRun(CALLER, runId)) as RunHead, (run) => run !== null && !["queued", "provisioning", "running"].includes(run.status));
}

/** Makes a Lifecycle job of the Conversation due now and runs its alarm. */
async function due(stub: ConversationStub, job: string): Promise<void> {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0 WHERE id = ?", job);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(stub);
}

/** Runs the Conversation's folder sweep as if every loose key had waited its hour. */
async function sweepNow(w: World): Promise<void> {
	await runInDurableObject(w.conversation, (_instance, state) => {
		state.storage.sql.exec("UPDATE folder_blobs SET due_at = 0 WHERE state <> 'stored'");
		state.storage.sql.exec(
			"INSERT INTO cf_agents_jobs (id, capability, fn, time, running) VALUES ('files', 'host', 'files', 0, 0) ON CONFLICT (id) DO UPDATE SET time = 0, running = 0",
		);
	});
	await due(w.conversation, "files");
}

describe("uploads", () => {
	test("an upload streams into R2 while it is hashed, recorded pending then complete in the Workspace", async () => {
		const w = await world();
		const data = "%PDF-1.7 hello";
		const outcome = await receiveUpload(w.recorder, w.bucket, CALLER, { name: "Q3 report.pdf", size: 14, body: body(data) });
		expect(outcome).toEqual({ ok: true, value: { id: expect.any(String), name: "Q3 report.pdf", size: 14, mediaType: "application/pdf" } });
		const id = outcome.ok ? outcome.value.id : "";
		const [row] = await w.workspaceRows<{ state: string; sha256: string; key: string; user_id: string }>("SELECT state, sha256, key, user_id FROM uploads WHERE id = ?", id);
		expect(row).toEqual({ state: "complete", sha256: await sha(data), key: `uploads/${w.ref.id}/${USER}/${id}`, user_id: USER });
		expect(await (await w.bucket.get(row?.key as string))?.text()).toBe(data);
	});

	test("a large upload hashes right, sniffed from its head only", async () => {
		const w = await world();
		const data = new Uint8Array(5 * 1024 * 1024 + 7);
		for (let i = 0; i < data.length; i += 65_536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65_536, data.length)));
		data.set(new TextEncoder().encode("PK\x03\x04"));
		const outcome = await receiveUpload(w.recorder, w.bucket, CALLER, { name: "sheet.xlsx", size: data.length, body: body(data) });
		expect(outcome).toMatchObject({ ok: true, value: { size: data.length, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
		const [row] = await w.workspaceRows<{ sha256: string }>("SELECT sha256 FROM uploads");
		expect(row?.sha256).toBe(await sha(data));
	});

	test("an empty upload is text", async () => {
		const w = await world();
		expect(await receiveUpload(w.recorder, w.bucket, CALLER, { name: "empty", size: 0, body: null })).toMatchObject({ ok: true, value: { size: 0, mediaType: "text/plain" } });
	});

	test("a body longer or shorter than declared is refused and leaves nothing", async () => {
		const w = await world();
		expect(await receiveUpload(w.recorder, w.bucket, CALLER, { name: "a", size: 4, body: body("hello") })).toEqual({ ok: false, refusal: { code: "CONTENT_LENGTH_MISMATCH", detail: BODY_LONGER } });
		expect(await receiveUpload(w.recorder, w.bucket, CALLER, { name: "a", size: 6, body: body("hello") })).toEqual({ ok: false, refusal: { code: "CONTENT_LENGTH_MISMATCH", detail: BODY_SHORTER } });
		expect(await w.workspaceRows("SELECT * FROM uploads")).toEqual([]);
		expect((await w.bucket.list({ prefix: `uploads/${w.ref.id}/` })).objects).toEqual([]);
	});

	test("a body still arriving at the deadline is refused (408) and abandoned", async () => {
		const w = await world();
		const stalled = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array(3)) });
		expect(await receiveUpload(w.recorder, w.bucket, CALLER, { name: "slow", size: 10, body: stalled }, { deadlineMs: 50 })).toEqual({ ok: false, refusal: { code: "UPLOAD_TIMEOUT", detail: TOO_SLOW } });
		expect(await w.workspaceRows("SELECT * FROM uploads")).toEqual([]);
		// Its write was stopped with it: nothing is stored, now or later.
		await sleep(50);
		expect((await w.bucket.list({ prefix: `uploads/${w.ref.id}/` })).objects).toEqual([]);
	});

	/** The bucket with its write held until `release()`: a write that ends after the upload's deadline. */
	function heldBucket(bucket: UploadBucket) {
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let settled = false;
		return {
			bucket: {
				put: async (key: string, value: ReadableStream<Uint8Array>) => {
					await gate;
					const stored = await bucket.put(key, value);
					settled = true;
					return stored;
				},
				delete: (key: string) => bucket.delete(key),
			} satisfies UploadBucket,
			release,
			get settled() {
				return settled;
			},
		};
	}

	test("a write that ends just after the deadline leaves no object behind", async () => {
		// The body is whole and the put is held past the deadline, then lands: the abandonment waits for it, so the
		// Workspace's delete (with its next alarm) follows the write instead of preceding it.
		const w = await world();
		const held = heldBucket(w.bucket);
		setTimeout(held.release, 150);
		const data = new TextEncoder().encode("a whole body");
		const answer = await receiveUpload(w.recorder, held.bucket, CALLER, { name: "late", size: data.length, body: body(data) }, { deadlineMs: 50 });
		expect(answer).toEqual({ ok: false, refusal: { code: "UPLOAD_TIMEOUT", detail: TOO_SLOW } });
		// It answered after the write ended, not before.
		expect(held.settled).toBe(true);
		expect(await w.workspaceRows("SELECT * FROM uploads")).toEqual([]);
		await until(
			async () => (await w.bucket.list({ prefix: `uploads/${w.ref.id}/` })).objects,
			(objects) => objects.length === 0,
		);
	});

	test("a write that ends after the settle wait too has its object deleted when it does", async () => {
		const w = await world();
		const held = heldBucket(w.bucket);
		const work: Promise<unknown>[] = [];
		const data = new TextEncoder().encode("a whole body");
		const answer = await receiveUpload(
			w.recorder,
			held.bucket,
			CALLER,
			{ name: "later", size: data.length, body: body(data) },
			{ deadlineMs: 50, settleMs: 20, waitUntil: (promise) => work.push(promise) },
		);
		expect(answer).toEqual({ ok: false, refusal: { code: "UPLOAD_TIMEOUT", detail: TOO_SLOW } });
		expect(held.settled).toBe(false);
		expect(work).toHaveLength(1);
		held.release();
		await Promise.all(work);
		expect(held.settled).toBe(true);
		expect((await w.bucket.list({ prefix: `uploads/${w.ref.id}/` })).objects).toEqual([]);
	});

	test("the Workspace's refusals come before the body is read", async () => {
		const w = await world();
		let pulled = false;
		const watched = () =>
			new ReadableStream<Uint8Array>(
				{
					pull: (controller) => {
						pulled = true;
						controller.enqueue(new Uint8Array(1));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
		for (let i = 0; i < 30; i++) await w.upload(`f${i}`, "x");
		expect(await receiveUpload(w.recorder, w.bucket, CALLER, { name: "one too many", size: 1, body: watched() })).toEqual({
			ok: false,
			refusal: { code: "TOO_MANY_UPLOADS_WAITING", detail: "You have too many files waiting to be sent. Send or remove some, or try again tomorrow." },
		});
		expect(pulled).toBe(false);
	});
});

describe("the download origin", () => {
	const ORIGIN = "http://localhost:8788";
	const downloadEnv = (): DownloadEnv => ({ FILES: env.FILES, FILES_EU: env.FILES_EU, MINERVA_DOWNLOAD_KEY: env.MINERVA_DOWNLOAD_KEY, MINERVA_DOWNLOAD_ORIGIN: ORIGIN });

	async function stored(bucket: R2Bucket, data: string, path = "reports/zażółć report.html", jurisdiction: "eu" | null = null) {
		const workspaceId = uuid7();
		const conversationId = uuid7();
		const key = `blobs/${workspaceId}/${conversationId}/${await sha(data)}/${"0".repeat(31)}1`;
		await bucket.put(key, data);
		const link = await signDownload(env.MINERVA_DOWNLOAD_KEY, ORIGIN, { workspaceId, jurisdiction, conversationId, versionId: uuid7(), path, userId: USER, key });
		return { key, link };
	}

	test("a file downloads as an attachment that cannot run", async () => {
		const { link } = await stored(env.FILES, "<script>alert(1)</script>");
		const response = await serveDownload(new Request(link), downloadEnv());
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<script>alert(1)</script>");
		expect(Object.fromEntries(["Content-Type", "Content-Length", "Content-Disposition", "X-Content-Type-Options", "Content-Security-Policy", "Cache-Control"].map((name) => [name, response.headers.get(name)]))).toEqual({
			"Content-Type": "application/octet-stream",
			"Content-Length": "25",
			"Content-Disposition": "attachment; filename*=utf-8''za%C5%BC%C3%B3%C5%82%C4%87%20report.html",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Cache-Control": "private, no-store",
		});
	});

	test("ranges: one range served as 206, a suffix resolved, one past the end 416", async () => {
		const { link } = await stored(env.FILES, "0123456789", "digits.txt");
		const ranged = (range: string) => serveDownload(new Request(link, { headers: { Range: range } }), downloadEnv());
		const part = await ranged("bytes=2-4");
		expect([part.status, await part.text(), part.headers.get("Content-Range"), part.headers.get("Content-Length")]).toEqual([206, "234", "bytes 2-4/10", "3"]);
		const suffix = await ranged("bytes=-3");
		expect([suffix.status, await suffix.text(), suffix.headers.get("Content-Range")]).toEqual([206, "789", "bytes 7-9/10"]);
		const open = await ranged("bytes=8-");
		expect([open.status, await open.text(), open.headers.get("Content-Range")]).toEqual([206, "89", "bytes 8-9/10"]);
		const past = await ranged("bytes=20-");
		expect([past.status, past.headers.get("Content-Range")]).toEqual([416, "bytes */10"]);
		const ignored = await ranged("bytes=0-1,4-5");
		expect([ignored.status, await ignored.text()]).toEqual([200, "0123456789"]);
		expect(part.headers.get("Content-Disposition")).toBe('attachment; filename="digits.txt"');
	});

	test("an EU workspace's link reads its EU bucket", async () => {
		const { link } = await stored(env.FILES_EU, "eu bytes", "eu.txt", "eu");
		const response = await serveDownload(new Request(link), downloadEnv());
		expect([response.status, await response.text()]).toEqual([200, "eu bytes"]);
	});

	test("every refusal is the same 404, but a link without a signature is 401", async () => {
		const { key, link } = await stored(env.FILES, "secret");
		const notFound = { status: 404, body: { detail: "Not Found" } };
		const answer = async (request: Request, at?: number) => {
			const response = await serveDownload(request, downloadEnv(), at);
			expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
			return { status: response.status, body: (await response.json()) as unknown };
		};
		const tampered = new URL(link);
		tampered.searchParams.set("p", "other.txt");
		expect(await answer(new Request(tampered))).toEqual(notFound);
		expect(await answer(new Request(link), Date.now() + 6 * 60 * 1000)).toEqual(notFound);
		expect(await answer(new Request(link.replace(ORIGIN, "http://127.0.0.1:8788")))).toEqual(notFound);
		expect(await answer(new Request(link, { method: "POST" }))).toEqual(notFound);
		expect(await answer(new Request(link.replace("/download?", "/elsewhere?")))).toEqual(notFound);
		const unsigned = new URL(link);
		unsigned.searchParams.delete("s");
		expect(await answer(new Request(unsigned))).toEqual({ status: 401, body: { detail: "Unauthorized" } });
		await env.FILES.delete(key);
		expect(await answer(new Request(link))).toEqual(notFound);
	});
});

describe("the folder's store on a Durable Object's SQLite", () => {
	test("checkpoints, publish, listing and the sweep run on the object's own schema and the local bucket", async () => {
		const w = await world();
		await runInDurableObject(w.conversation, async (_instance, state) => {
			const sql = durableSql(state.storage);
			const runId = uuid7();
			sql.exec("INSERT INTO runs (id, status, attempt, attempt_started_at, snapshot, created_at) VALUES (?, 'running', 1, ?, '{}', ?)", runId, Date.now(), Date.now());
			const scheduled: number[] = [];
			const store = new FolderStore({
				sql,
				bucket: w.bucket as unknown as Bucket,
				counter: { setConversationBytes: (conversationId, total, revision) => w.ws.setConversationBytes(conversationId, total, revision) },
				workspaceId: w.ref.id,
				conversationId: w.conversationId,
				settings: { folderBytes: 268_435_456, folderEntries: 10_000, runUploadBytes: 1 << 30 },
				now: () => Date.now(),
				outside: async (change) => change(),
				isCurrent: (fence) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM runs WHERE id = ? AND attempt = ? AND status = 'running'", fence.runId, fence.attempt)[0]?.n === 1,
				conversation: () => ({ folderVersionId: sql.exec<{ v: string | null }>("SELECT folder_version_id AS v FROM conversation")[0]?.v ?? null, deleted: false }),
				schedule: (at) => scheduled.push(at),
				log: () => {},
			});
			const contents = new Map([
				["a.txt", "hello"],
				["dir/b.txt", "world"],
				["dir/c.txt", "hello"],
			]);
			const manifest = { files: await Promise.all([...contents].map(async ([path, data]) => ({ path, sha256: await sha(data), mode: 0o644 as const, mtime: 7 }))), dirs: ["empty"] };
			const sizes = Object.fromEntries([...contents].map(([path, data]) => [path, data.length]));
			const outcome = await store.checkpoint({ runId, attempt: 1 }, { parent: null, manifest, sizes, warnings: { total: 1, items: [{ path: "link", reason: "symlink" }] } }, async (plan) => {
				for (const file of plan.files) await w.bucket.put(file.key as string, contents.get(file.path) as string, { sha256: file.sha256 });
				return { ok: true, stored: plan.files };
			});
			expect(outcome).toMatchObject({ ok: true, uploaded: 2 });
			const versionId = outcome.ok ? outcome.versionId : null;
			const published = store.publish(runId, { baseVersionId: null, checkpointVersionId: versionId });
			expect(published.resultVersionId).toBe(versionId);
			expect(published.changes).toMatchObject({ counts: { added: 3, dirs_added: 2 } });
			sql.exec("UPDATE conversation SET folder_version_id = ?", versionId);
			expect(store.list(null)?.files.map((file) => file.path)).toEqual(["a.txt", "dir/b.txt", "dir/c.txt"]);
			expect(store.resolve(null, "dir/c.txt")?.key).toBe(store.resolve(null, "a.txt")?.key);
			expect(parseManifest({ files: [], dirs: [] }, 1)).toBeDefined();
			expect(await store.sweep()).toBeUndefined();
			expect(store.reported()).toBe(10);
		});
		const [row] = await w.workspaceRows<{ bytes: number }>("SELECT bytes FROM conversations WHERE id = ?", w.conversationId);
		expect(row?.bytes).toBe(10);
		expect(await w.blobs()).toHaveLength(2);
	});
});

describe("attachments at a run's start", () => {
	test("uploads are copied into the conversation's blobs and added at the folder's root; the uploads are consumed", async () => {
		const w = await world();
		const notes = await w.upload("notes.txt", "new notes");
		const data = await w.upload("data.csv", "a,b\n");
		const posted = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [notes.id, data.id] });
		if (!posted.ok) throw new Error(posted.refusal.detail);
		expect(posted.value.message.attachments).toEqual([
			{ path: "notes.txt", size: 9, media_type: "text/plain" },
			{ path: "data.csv", size: 4, media_type: "text/csv" },
		]);
		const baseVersionId = posted.value.run.baseVersionId;
		expect(baseVersionId).toEqual(expect.any(String));
		expect((await settled(w, posted.value.run.id)).status).toBe("completed");
		expect(await w.conversation.listFiles(CALLER, null)).toEqual({
			versionId: baseVersionId,
			files: [
				{ path: "data.csv", size: 4, mtime: expect.any(Number) },
				{ path: "notes.txt", size: 9, mtime: expect.any(Number) },
			],
			dirs: [],
		});
		const target = await w.conversation.resolveDownload(CALLER, baseVersionId, "notes.txt");
		expect(target).toMatchObject({ versionId: baseVersionId, path: "notes.txt", sha256: await sha("new notes"), size: 9 });
		expect(target?.key.startsWith(w.prefix)).toBe(true);
		expect(await (await w.bucket.get(target?.key as string))?.text()).toBe("new notes");
		expect(await w.blobs()).toHaveLength(2);
		// Activated: the uploads are consumed, and their objects deleted by the Workspace's alarm.
		await until(() => w.workspaceRows("SELECT id FROM uploads"), (rows) => rows.length === 0);
		await runInDurableObject(w.ws, (_instance, state) => state.storage.setAlarm(Date.now()));
		await runDurableObjectAlarm(w.ws);
		expect((await w.bucket.list({ prefix: `uploads/${w.ref.id}/` })).objects).toEqual([]);
		// The Workspace counts the conversation's copies.
		await until(() => w.workspaceRows<{ bytes: number }>("SELECT bytes FROM conversations WHERE id = ?", w.conversationId), (rows) => rows[0]?.bytes === 13);
		// Another user, or a stranger's view, sees none of it.
		expect(await w.conversation.listFiles({ userId: uuid7(), role: "owner" }, null)).toBeNull();
		expect(await w.conversation.resolveDownload({ userId: uuid7(), role: "owner" }, null, "notes.txt")).toBeNull();
	});

	test("an upload whose object is gone refuses the start and leaves nothing; the upload is attachable again", async () => {
		const w = await world();
		const kept = await w.upload("kept.txt", "kept");
		const gone = await w.upload("gone.txt", "gone");
		const [row] = await w.workspaceRows<{ key: string }>("SELECT key FROM uploads WHERE id = ?", gone.id);
		await w.bucket.delete(row?.key as string);
		const posted = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [kept.id, gone.id] });
		expect(posted).toEqual({ ok: false, refusal: { code: "ATTACHMENT_UNAVAILABLE", detail: NO_LONGER_AVAILABLE } });
		const head = await w.conversation.getConversation(CALLER);
		expect([head?.messages, head?.runs]).toEqual([[], []]);
		// Released: attachable again.
		await until(() => w.workspaceRows<{ run_id: string | null }>("SELECT run_id FROM uploads WHERE id = ?", kept.id), (rows) => rows[0]?.run_id === null);
		// The copy made before the refusal is deleted by the folder's sweep.
		await sweepNow(w);
		expect(await w.blobs()).toEqual([]);
		const again = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [kept.id] });
		expect(again.ok).toBe(true);
	});

	test("an attachment whose contents the conversation holds is not copied again", async () => {
		const w = await world();
		const first = await w.upload("a.txt", "same");
		const posted = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [first.id] });
		if (!posted.ok) throw new Error(posted.refusal.detail);
		await settled(w, posted.value.run.id);
		const second = await w.upload("a.txt", "same");
		const again = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [second.id] });
		if (!again.ok) throw new Error(again.refusal.detail);
		expect(again.value.message.attachments).toEqual([{ path: "a (2).txt", size: 4, media_type: "text/plain" }]);
		expect(await w.blobs()).toHaveLength(1);
	});
});

describe("fault rows: Files", () => {
	test("a crash during the attachments' copy: the start is sent again by its watch, and the first copy is swept", async () => {
		const w = await world();
		const upload = await w.upload("notes.txt", "notes");
		let crashes = 0;
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				...inner,
				get: (key) => inner.get(key),
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				async put(key, value, options) {
					const stored = await inner.put(key, value, options);
					if (crashes++ === 0) context.ctx.abort("fault: copy:after");
					return stored;
				},
			};
		};
		await expect(w.conversation.postMessage(CALLER, { content: DONE, attachments: [upload.id] })).rejects.toThrow();
		const [start] = await until(() => w.conversationRows<{ run_id: string }>("SELECT run_id FROM starts"), (rows) => rows.length === 1);
		const runId = start?.run_id as string;
		expect(await w.blobs()).toHaveLength(1);
		await due(w.conversation, `watch:${runId}`);
		const run = await settled(w, runId);
		expect(run.status).toBe("completed");
		const head = await w.conversation.getConversation(CALLER);
		expect(head?.messages[0]?.attachments).toEqual([{ path: "notes.txt", size: 5, media_type: "text/plain" }]);
		// The start sent again copied into the key it recorded the first time: one object, counted once.
		const target = await w.conversation.resolveDownload(CALLER, null, "notes.txt");
		expect(await w.blobs()).toEqual([target?.key]);
		await sweepNow(w);
		expect(await w.blobs()).toEqual([target?.key]);
		await until(() => w.workspaceRows<{ bytes: number }>("SELECT bytes FROM conversations WHERE id = ?", w.conversationId), (rows) => rows[0]?.bytes === 5);
	});

	test("an R2 acknowledgement lost during a copy: copied again under its key, counted once", async () => {
		const w = await world();
		const upload = await w.upload("notes.txt", "notes");
		let puts = 0;
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				get: (key) => inner.get(key),
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				async put(key, value, options) {
					const stored = await inner.put(key, value, options);
					if (puts++ === 0) throw new Error("put: Network connection lost.");
					return stored;
				},
			};
		};
		const posted = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [upload.id] });
		if (!posted.ok) throw new Error(posted.refusal.detail);
		expect(puts).toBe(2);
		await settled(w, posted.value.run.id);
		const states = await w.conversationRows<{ state: string }>("SELECT state FROM folder_blobs");
		expect(states.map((row) => row.state)).toEqual(["stored"]);
		await sweepNow(w);
		const target = await w.conversation.resolveDownload(CALLER, null, "notes.txt");
		expect(await w.blobs()).toEqual([target?.key]);
		await until(() => w.workspaceRows<{ bytes: number }>("SELECT bytes FROM conversations WHERE id = ?", w.conversationId), (rows) => rows[0]?.bytes === 5);
	});

	test("a write that lands while its conversation is deleted is deleted an hour later, with the prefix", async () => {
		const w = await world();
		const upload = await w.upload("notes.txt", "notes");
		const posted = await w.conversation.postMessage(CALLER, { content: DONE, attachments: [upload.id] });
		if (!posted.ok) throw new Error(posted.refusal.detail);
		await settled(w, posted.value.run.id);
		// The Conversation's own copy, held in flight while the conversation is deleted. Only this
		// conversation's keys are held, and the deletion waits until the copy is really in its put: a
		// deletion that overtakes the start before that refuses it instead (the Workspace answers 413 to
		// growth in a deleted conversation) and leaves nothing, which is a different case.
		const held = Promise.withResolvers<void>();
		let copying = false;
		const late = await w.upload("late.txt", "late bytes");
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				get: (key) => inner.get(key),
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				async put(key, value, options) {
					if (key.startsWith(w.prefix)) {
						copying = true;
						await held.promise;
					}
					return inner.put(key, value, options);
				},
			};
		};
		// The object restarts, so its new instance builds its folder with the held bucket.
		await runInDurableObject(w.conversation, (_instance, state) => state.abort("fault: reload")).catch(() => {});
		const inFlight = w.conversation.postMessage(CALLER, { content: DONE, attachments: [late.id] }).catch(() => null);
		await until(async () => copying, (reached) => reached);
		const deleted = await w.ws.deleteConversation(CALLER, w.conversationId);
		expect(deleted).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		await until(() => w.workspaceRows<{ first_done_at: number | null }>("SELECT first_done_at FROM purges"), (rows) => rows[0]?.first_done_at !== null);
		expect(await w.blobs()).toEqual([]);
		expect((await w.workspaceRows<{ bytes: number }>("SELECT bytes FROM conversations"))[0]?.bytes).toBe(0);
		// The reset object's write is refused with it: nothing lands, and nothing was stored.
		held.resolve();
		expect(await inFlight).toBeNull();
		expect(await w.blobs()).toEqual([]);
		expect(await w.conversation.getConversation(CALLER)).toBeNull();
		// A write from outside the object (the Sandbox writes R2 itself) can land after the first deletion.
		await w.bucket.put(`${w.prefix}${await sha("late bytes")}/${"0".repeat(32)}`, "late bytes");
		// The second deletion, an hour later, takes it.
		await runInDurableObject(w.ws, async (_instance, state) => {
			state.storage.sql.exec("UPDATE purges SET next_attempt_at = 0");
			await state.storage.setAlarm(Date.now());
		});
		await runDurableObjectAlarm(w.ws);
		await until(() => w.workspaceRows<{ done_at: number | null }>("SELECT done_at FROM purges"), (rows) => rows[0]?.done_at !== null);
		expect(await w.blobs()).toEqual([]);
	});
});
