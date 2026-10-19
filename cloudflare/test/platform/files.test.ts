// Agent files in local workerd (ARCHITECTURE.md: Files), as Laravel's commands reach them (startRun, folder, resolveDownload,
// deleteConversation through the internal mount) with the fake Laravel: the uploads Laravel staged under `uploads/<workspace>/`
// in the EU bucket, measured, hashed and sniffed by the start (files/staging.ts); the folder's store on a Durable Object's own
// SQLite; attachments copied into a conversation's blobs; and the fault rows Files (ARCHITECTURE.md: Testing): an
// attachment's copy crashed and sent again, an R2 acknowledgement lost, a copy that lands while its conversation is deleted;
// and the bytes a conversation keeps, on its runs' `run.finished`.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { StartRun } from "@minerva/contract/internal";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { filesBucket } from "../../src/addressing.ts";
import { FACT_DELIVERY } from "../../src/conversation/facts.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import type { Conversation } from "../../src/faults/index.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { FOLDER_PORTS } from "../../src/files/folder.ts";
import { parseManifest } from "../../src/files/manifest.ts";
import type { Bucket } from "../../src/files/objects.ts";
import { FolderStore } from "../../src/files/store.ts";
import { hex } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { durableSql } from "../../src/lib/sql.ts";
import { fakeUpstream } from "../../src/model/fake.ts";
import { commands, held, objectOf, refusalOf, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

const DONE = JSON.stringify({ fake: { turns: [{ text: "Noted." }] } });
const UNAVAILABLE = { outcome: "refused", code: "ATTACHMENT_UNAVAILABLE", message: "An attached file is no longer available. Remove it and attach it again." };

type Stub = DurableObjectStub<Conversation>;

const realBucket = FOLDER_PORTS.bucket;
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
	FOLDER_PORTS.bucket = realBucket;
	uninstall();
	Object.assign(FACT_DELIVERY, DELIVERY);
});

async function sha(data: Uint8Array | string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data)));
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

type Attachments = StartRun["message"]["attachments"];

/** An object Laravel's signed PUT left under the workspace's staging prefix, and the attachment a start names it with. */
async function staged(workspace: string, name: string, data: Uint8Array | string, size?: number): Promise<Attachments[number]> {
	const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const upload = `uploads/${workspace}/${uuid7()}`;
	await env.FILES_EU.put(upload, content);
	return { upload, name, size: size ?? content.length, mediaType: "application/octet-stream" };
}

/** A start Laravel holds, in a new conversation or the given one's, with these attachments; not sent. */
function attaching(within: StartRun["scope"], attachments: Attachments, conversation?: string): StartRun {
	return held(fake, startOf(within, { ...(conversation ? { conversation } : {}), message: { id: uuid7(), content: DONE, attachments } }));
}

const ACTIVE = ["queued", "provisioning", "running"];

function settled(start: StartRun): Promise<RunHead> {
	return until(
		async () => (await objectOf(start).faultView(start.run)).head as RunHead,
		(run) => run !== null && !ACTIVE.includes(run.status),
	);
}

const prefixOf = (start: StartRun) => `blobs/${start.scope.workspace}/${start.conversation}/`;

/** Keys under the conversation's prefix, sorted. */
async function blobs(start: StartRun): Promise<string[]> {
	return (await env.FILES_EU.list({ prefix: prefixOf(start) })).objects.map((object) => object.key).sort();
}

function rows<T>(stub: Stub, query: string): Promise<T[]> {
	return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(query).toArray() as T[]);
}

/**
 * Runs the Conversation's folder sweep as if every loose key had waited its hour, with a loose key of its own under the
 * conversation's prefix that it must delete, and waits until it has deleted each once. The platform runs the alarm set for
 * now (retention.test.ts `due`).
 */
async function sweepNow(start: StartRun): Promise<void> {
	const stub = objectOf(start);
	const control = `${prefixOf(start)}${await sha("control")}/${"0".repeat(32)}`;
	await env.FILES_EU.put(control, "control");
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("INSERT INTO folder_blobs (key, sha256, size, state, run_id, created_at, due_at) VALUES (?, ?, 7, 'loose', NULL, 0, 0)", control, await sha("control"));
		state.storage.sql.exec("UPDATE folder_blobs SET due_at = 0 WHERE state <> 'stored'");
		state.storage.sql.exec(
			"INSERT INTO cf_agents_jobs (id, capability, fn, time, running) VALUES ('files', 'host', 'files', 0, 0) ON CONFLICT (id) DO UPDATE SET time = 0, running = 0",
		);
		await state.storage.setAlarm(Date.now());
	});
	await until(
		() => rows<{ n: number }>(stub, "SELECT count(*) AS n FROM folder_blobs WHERE state <> 'stored' AND deletions = 0"),
		([row]) => row?.n === 0,
	);
	expect(await env.FILES_EU.head(control)).toBeNull();
}

async function resolved(start: StartRun, path: string) {
	const found = await commands.resolveDownload({ scope: start.scope, conversation: start.conversation, version: null, path });
	if (found.outcome !== "found") throw new Error(`${path} is missing.`);
	return found;
}

describe("staged uploads", () => {
	test("a large one hashes right, sniffed from its head only", async () => {
		const within = scope();
		const data = new Uint8Array(5 * 1024 * 1024 + 7);
		for (let i = 0; i < data.length; i += 65_536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65_536, data.length)));
		data.set(new TextEncoder().encode("PK\x03\x04"));
		const start = attaching(within, [await staged(within.workspace, "sheet.xlsx", data)]);
		expect(await commands.startRun(start)).toMatchObject({
			outcome: "accepted",
			attachments: [{ path: "sheet.xlsx", size: data.length, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
		});
		await settled(start);
		expect(await resolved(start, "sheet.xlsx")).toMatchObject({ size: data.length, sha256: await sha(data) });
	});

	test("an empty one is text", async () => {
		const within = scope();
		const start = held(fake, startOf(within, { message: { id: uuid7(), content: "", attachments: [await staged(within.workspace, "empty", "")] } }));
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", attachments: [{ path: "empty", size: 0, mediaType: "text/plain" }] });
		await settled(start);
		expect(await resolved(start, "empty")).toMatchObject({ size: 0, sha256: await sha("") });
	});

	test("one larger or smaller than declared is refused and leaves nothing; the staged object is kept", async () => {
		const within = scope();
		for (const declared of [4, 6]) {
			const attachment = await staged(within.workspace, "a.txt", "hello", declared);
			const start = attaching(within, [attachment]);
			expect(await commands.startRun(start), `declared ${declared}`).toEqual(UNAVAILABLE);
			expect((await objectOf(start).faultView(start.run)).head).toBeNull();
			expect(await blobs(start)).toEqual([]);
			expect(await env.FILES_EU.head(attachment.upload)).not.toBeNull();
		}
	});
});

describe("the folder's store on a Durable Object's SQLite", () => {
	test("checkpoints, publish, listing and the sweep run on the object's own schema and the local bucket", async () => {
		const start = startOf(scope());
		const bucket = filesBucket(env, { id: start.scope.workspace, jurisdiction: "eu" });
		const reports: number[] = [];
		await runInDurableObject(objectOf(start), async (_instance, state) => {
			const sql = durableSql(state.storage);
			const runId = uuid7();
			sql.exec("INSERT INTO runs (id, status, attempt, attempt_started_at, snapshot, created_at) VALUES (?, 'running', 1, ?, '{}', ?)", runId, Date.now(), Date.now());
			const scheduled: number[] = [];
			const store = new FolderStore({
				sql,
				bucket: bucket as unknown as Bucket,
				counter: {
					setConversationBytes: async (_conversationId, total) => {
						reports.push(total);
						return { ok: true };
					},
				},
				workspaceId: start.scope.workspace,
				conversationId: start.conversation,
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
				for (const file of plan.files) await bucket.put(file.key as string, contents.get(file.path) as string, { sha256: file.sha256 });
				return { ok: true, stored: plan.files };
			});
			expect(outcome).toMatchObject({ ok: true, uploaded: 2 });
			const versionId = outcome.ok ? outcome.versionId : null;
			const published = store.publish(runId, { baseVersionId: null, checkpointVersionId: versionId });
			expect(published.resultVersionId).toBe(versionId);
			expect(published.changes).toMatchObject({ counts: { added: 3, dirsAdded: 2 } });
			expect(store.list(versionId)?.files.map((file) => file.path)).toEqual(["a.txt", "dir/b.txt", "dir/c.txt"]);
			expect(store.resolve(versionId, "dir/c.txt")?.key).toBe(store.resolve(versionId, "a.txt")?.key);
			expect(parseManifest({ files: [], dirs: [] }, 1)).toBeDefined();
			expect(await store.sweep()).toBeUndefined();
			expect(store.reported()).toBe(10);
		});
		expect(reports.at(-1)).toBe(10);
		expect(await blobs(start)).toHaveLength(2);
	});
});

describe("attachments at a run's start", () => {
	test("an attachment whose contents the conversation holds is not copied again", async () => {
		const within = scope();
		const first = attaching(within, [await staged(within.workspace, "a.txt", "same")]);
		await commands.startRun(first);
		await settled(first);
		const again = attaching(within, [await staged(within.workspace, "a.txt", "same")], first.conversation);
		expect(await commands.startRun(again)).toMatchObject({ outcome: "accepted", attachments: [{ path: "a (2).txt", size: 4, mediaType: "text/plain" }] });
		await settled(again);
		expect(await blobs(first)).toHaveLength(1);
	});
});

describe("stored bytes", () => {
	/** The conversation's `run.finished` for this start, once the fake Laravel holds it. */
	async function finished(start: StartRun) {
		const facts = await until(
			async () => fake.facts(start.conversation),
			(facts) => facts.some((fact) => fact.type === "run.finished" && fact.run === start.run),
		);
		return facts.find((fact) => fact.type === "run.finished" && fact.run === start.run)?.data;
	}

	test("run.finished reports what the conversation keeps in whole pages, and a run that adds nothing reports the same", async () => {
		const within = scope();
		const first = attaching(within, [await staged(within.workspace, "notes.txt", "notes"), await staged(within.workspace, "data.bin", "d".repeat(5000))]);
		await commands.startRun(first);
		expect((await settled(first)).status).toBe("completed");
		expect(await finished(first)).toMatchObject({ status: "completed", storedBytes: 4096 + 8192 });
		const second = attaching(within, [], first.conversation);
		await commands.startRun(second);
		expect((await settled(second)).status).toBe("completed");
		expect(await finished(second)).toMatchObject({ status: "completed", folder: { changes: null }, storedBytes: 4096 + 8192 });
	});
});

describe("fault rows: Files", () => {
	test("a staged object gone after it was measured refuses the start, the copies made are swept, and the kept one attaches again", async () => {
		const within = scope();
		const kept = await staged(within.workspace, "kept.txt", "kept");
		const gone = await staged(within.workspace, "gone.txt", "gone");
		// The copy of `gone` finds its object deleted, once the copy of `kept` has landed.
		const keptCopied = Promise.withResolvers<void>();
		let goneReads = 0;
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				...inner,
				async get(key) {
					if (key === gone.upload && ++goneReads === 2) {
						await keptCopied.promise;
						await env.FILES_EU.delete(key);
					}
					return inner.get(key);
				},
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				async put(key, value, options) {
					const stored = await inner.put(key, value, options);
					if (options?.sha256 === (await sha("kept"))) keptCopied.resolve();
					return stored;
				},
			};
		};
		const start = attaching(within, [kept, gone]);
		expect(await commands.startRun(start)).toEqual(UNAVAILABLE);
		expect(goneReads).toBe(2);
		expect((await objectOf(start).faultView(start.run)).head).toBeNull();
		expect(await blobs(start)).toHaveLength(1);
		await sweepNow(start);
		expect(await blobs(start)).toEqual([]);
		// The conversation is free, and the staged object that was there attaches.
		const again = attaching(within, [kept], start.conversation);
		expect(await commands.startRun(again)).toMatchObject({ outcome: "accepted", attachments: [{ path: "kept.txt", size: 4, mediaType: "text/plain" }] });
		expect((await settled(again)).status).toBe("completed");
	});

	test("a crash during the attachments' copy: the start sent again copies into the key it recorded, and the sweep keeps it", async () => {
		const within = scope();
		const start = attaching(within, [await staged(within.workspace, "notes.txt", "notes")]);
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
		expect((await refusalOf(commands.startRun(start))).status).toBeGreaterThanOrEqual(500);
		const [copy] = await blobs(start);
		expect(copy).toBeDefined();
		// Laravel sends the start again.
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", attachments: [{ path: "notes.txt", size: 5, mediaType: "text/plain" }] });
		expect((await settled(start)).status).toBe("completed");
		expect(await resolved(start, "notes.txt")).toMatchObject({ key: copy, size: 5, sha256: await sha("notes") });
		expect(await blobs(start)).toEqual([copy]);
		await sweepNow(start);
		expect(await blobs(start)).toEqual([copy]);
	});

	test("an R2 acknowledgement lost during a copy: copied again under its key, stored once", async () => {
		const within = scope();
		const start = attaching(within, [await staged(within.workspace, "notes.txt", "notes")]);
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
		expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted" });
		expect(puts).toBe(2);
		await settled(start);
		const states = await rows<{ state: string }>(objectOf(start), "SELECT state FROM folder_blobs");
		expect(states.map((row) => row.state)).toEqual(["stored"]);
		await sweepNow(start);
		expect(await blobs(start)).toEqual([(await resolved(start, "notes.txt")).key]);
	});

	test("a copy that lands while its conversation is deleted: the start is refused as deleted, and the sweep deletes the copy", async () => {
		const within = scope();
		const first = attaching(within, [await staged(within.workspace, "notes.txt", "notes")]);
		await commands.startRun(first);
		await settled(first);
		const [kept] = await blobs(first);
		// The second start's copy is held in its put while the conversation is deleted. Only this conversation's keys are held,
		// and the deletion waits until the copy is really in its put: a deletion that overtakes the start before that refuses
		// it before any copy, which is a different case.
		const hold = Promise.withResolvers<void>();
		let copying = false;
		const late = attaching(within, [await staged(within.workspace, "late.txt", "late bytes")], first.conversation);
		FOLDER_PORTS.bucket = (context) => {
			const inner = realBucket(context);
			return {
				get: (key) => inner.get(key),
				list: (options) => inner.list(options),
				delete: (keys) => inner.delete(keys),
				async put(key, value, options) {
					if (key.startsWith(prefixOf(first))) {
						copying = true;
						await hold.promise;
					}
					return inner.put(key, value, options);
				},
			};
		};
		// The object restarts, so its new instance builds its folder with the held bucket.
		await runInDurableObject(objectOf(first), (_instance, state) => state.abort("fault: reload")).catch(() => {});
		const inFlight = commands.startRun(late);
		await until(async () => copying, (reached) => reached);
		expect(await commands.deleteConversation({ scope: within, conversation: first.conversation })).toEqual({ outcome: "deleted" });
		hold.resolve();
		expect(await inFlight).toEqual({ outcome: "refused", code: "CONVERSATION_DELETED", message: "This conversation was deleted." });
		expect((await objectOf(late).faultView(late.run)).head).toBeNull();
		// The copy landed, recorded loose; the run's blob stays until retention removes it (chunk 15).
		expect(await blobs(first)).toHaveLength(2);
		await sweepNow(first);
		expect(await blobs(first)).toEqual([kept]);
	});
});
