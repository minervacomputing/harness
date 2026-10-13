// A conversation's folder in its Durable Object (src/files/store.ts) over node:sqlite with the
// Conversation's own schema and an in-memory bucket: versions, checkpoints and what a run may read,
// publish at every end and the next run's start, attachments at a run's start, the sweep and loose
// objects, and the Workspace's byte count after every crash point (plan: Files).
//
// In the Durable Object a run uploads only within a checkpoint: the Sandbox writes each file whose
// contents the run may not read under a key recorded first, so "an upload" below is a checkpoint's.

import { describe, expect, test } from "vitest";
import type { FolderWarnings, WireManifest } from "../../src/contracts/files.ts";
import { BLOB_GONE, CONFLICT, LOOSE_GRACE_MS, NO_LONGER_AVAILABLE, NO_ROOM, QuotaExceeded, SECOND_DELETION_MS, STALE } from "../../src/files/limits.ts";
import { digestOf, parseManifest } from "../../src/files/manifest.ts";
import { StaleParent, UnknownBlob } from "../../src/files/store.ts";
import { parseJson } from "../../src/lib/json.ts";
import { CHECKSUM_MISMATCH, CONVERSATION, DAY, START, WORKSPACE, World, sandboxUpload, sha } from "./files-support.ts";

const PREFIX = `blobs/${WORKSPACE}/${CONVERSATION}/`;
const EMPTY = { files: [], dirs: [] };

async function manifestOf(files: { [path: string]: string }, dirs: string[] = []) {
	const entries = [];
	for (const [path, data] of Object.entries(files)) entries.push({ path, sha256: await sha(data), mode: 0o644 as const, mtime: 0 });
	return parseManifest({ files: entries, dirs }, 10_000);
}

type Checkpointed = Awaited<ReturnType<World["checkpoint"]>>;

/** A checkpoint that must succeed; its version id. */
async function saved(promise: Promise<Checkpointed>): Promise<string | null> {
	const { outcome } = await promise;
	if (!outcome.ok) throw new Error(`Refused: ${JSON.stringify(outcome)}`);
	return outcome.versionId;
}

function refusedWith(error: unknown): { name: string; limit?: string; hashes?: string[] } {
	if (error instanceof QuotaExceeded) return { name: "QuotaExceeded", limit: error.limit };
	if (error instanceof UnknownBlob) return { name: "UnknownBlob", hashes: error.hashes };
	return { name: (error as Error).constructor.name };
}

function attempt(call: () => unknown): ReturnType<typeof refusedWith> | null {
	try {
		call();
		return null;
	} catch (error) {
		return refusedWith(error);
	}
}

// Versions

describe("versions", () => {
	test("a version records the sizes of its files", async () => {
		const w = new World();
		await w.blob("hello");
		await w.blob("x".repeat(5000));
		const manifest = await manifestOf({ "a.txt": "hello", "big.bin": "x".repeat(5000) });
		const recorded = w.sql.transaction(() => w.store.recordVersion("turn", manifest));
		const entries = w.open().entries(recorded.id);
		expect(entries.files["a.txt"]).toEqual({ sha256: await sha("hello"), size: 5, mode: 0o644, mtime: 0 });
		expect(entries.files["big.bin"]?.size).toBe(5000);
		expect(recorded.size).toBe(4096 + 8192);
		expect([recorded.file_count, recorded.entry_count, recorded.parts]).toEqual([2, 2, 1]);
		expect(recorded.digest).toBe(digestOf(entries));
	});

	test("a version needs every blob in this conversation's store, the missing ones sorted", async () => {
		const w = new World();
		await w.blob("ours");
		// Another conversation's or workspace's blob is in another object: this one has no row for it.
		const manifest = await manifestOf({ ours: "ours", theirs: "theirs", missing: "missing" });
		expect(attempt(() => w.sql.transaction(() => w.store.recordVersion("turn", manifest)))).toEqual({
			name: "UnknownBlob",
			hashes: [await sha("theirs"), await sha("missing")].sort(),
		});
		expect(w.versions()).toEqual([]);
	});

	test("a version takes the sizes of files it keeps from its parent", async () => {
		const w = new World();
		await w.blob("kept");
		const first = w.sql.transaction(() => w.store.recordVersion("turn", parseManifest(EMPTY, 10)));
		const parentManifest = await manifestOf({ a: "kept" });
		const base = w.sql.transaction(() => w.store.recordVersion("turn", parentManifest, { parentId: first.id }));
		await w.blob("new");
		// Only blobs new relative to the parent are looked up: the kept file's row is not needed.
		w.sql.exec("DELETE FROM folder_blobs WHERE sha256 = ?", await sha("kept"));
		const manifest = await manifestOf({ a: "kept", b: "new" });
		const second = w.sql.transaction(() => w.store.recordVersion("checkpoint", manifest, { parentId: base.id }));
		expect(second.parent_id).toBe(base.id);
		expect(w.store.entries(second.id).files.a?.size).toBe(4);
	});

	test("a version refuses a parent that is gone", async () => {
		const w = new World();
		await w.blob("hello");
		const gone = w.sql.transaction(() => w.store.recordVersion("turn", parseManifest(EMPTY, 10)));
		w.sql.exec("DELETE FROM folder_versions WHERE id = ?", gone.id);
		const manifest = await manifestOf({ a: "hello" });
		expect(attempt(() => w.sql.transaction(() => w.store.recordVersion("turn", manifest, { parentId: gone.id })))).toEqual({ name: "StaleParent" });
		expect(new StaleParent().message).toBe("");
	});

	test("a version is limited in size", async () => {
		const w = new World({ folderBytes: 4096 });
		await w.blob("a");
		await w.blob("b");
		const one = await manifestOf({ a: "a" });
		const two = await manifestOf({ a: "a", b: "b" });
		w.sql.transaction(() => w.store.recordVersion("turn", one));
		expect(attempt(() => w.sql.transaction(() => w.store.recordVersion("turn", two)))).toEqual({ name: "QuotaExceeded", limit: "folder_bytes" });
	});

	test("record_version checks its arguments", () => {
		const w = new World();
		const empty = parseManifest(EMPTY, 10);
		expect(() => w.store.recordVersion("draft" as never, empty)).toThrow(TypeError);
		expect(() => w.store.recordVersion("turn", empty, { runId: "0199a000-0000-7000-8000-0000000000ff" })).toThrow("The run belongs to a different conversation.");
		expect(w.store.recordVersion("turn", empty).size).toBe(0);
	});

	test("blob identity and version contents cannot change; a version's kind and parent can", async () => {
		const w = new World();
		const { key } = await w.blob("hello");
		const manifest = await manifestOf({ a: "hello" });
		const recorded = w.sql.transaction(() => w.store.recordVersion("checkpoint", manifest));
		for (const [column, value] of [
			["size", 1],
			["sha256", "0".repeat(64)],
			["key", "elsewhere"],
		] as const) {
			expect(() => w.sql.exec(`UPDATE folder_blobs SET ${column} = ? WHERE key = ?`, value, key)).toThrow(/identity cannot change/);
		}
		for (const [column, value] of [
			["size", 0],
			["digest", "0".repeat(64)],
			["file_count", 9],
			["run_id", "x"],
		] as const) {
			expect(() => w.sql.exec(`UPDATE folder_versions SET ${column} = ? WHERE id = ?`, value, recorded.id)).toThrow(/contents cannot change/);
		}
		expect(() => w.sql.exec("UPDATE folder_version_parts SET text = '{}' WHERE version_id = ?", recorded.id)).toThrow(/contents cannot change/);
		// What a version is used for may change: publishing a checkpoint turns it into a turn version.
		w.sql.exec("UPDATE folder_versions SET kind = 'turn', parent_id = NULL WHERE id = ?", recorded.id);
		expect(w.versions()[0]?.kind).toBe("turn");
	});

	test("a version too large for one value is kept in parts under the 2 MB a value may have", async () => {
		const w = new World();
		const { sha256 } = await w.blob("x");
		const files = Array.from({ length: 9000 }, (_, i) => ({ path: `${"d".repeat(100)}/${i.toString().padStart(6, "0")}-${"é".repeat(40)}.txt`, sha256, mode: 0o644, mtime: START }));
		const recorded = w.sql.transaction(() => w.store.recordVersion("turn", parseManifest({ files, dirs: [] }, 20_000)));
		expect(recorded.parts).toBeGreaterThan(1);
		for (const part of w.sql.exec<{ text: string }>("SELECT text FROM folder_version_parts WHERE version_id = ?", recorded.id)) {
			expect(new TextEncoder().encode(part.text).length).toBeLessThan(2 * 1024 * 1024);
		}
		const entries = w.open().entries(recorded.id);
		expect(Object.keys(entries.files)).toHaveLength(9000);
		expect(digestOf(entries)).toBe(recorded.digest);
	});
});

// A run's uploads

describe("a run's uploads", () => {
	test("new contents are stored once under the conversation's prefix, counted, granted and charged to the run", async () => {
		const w = new World();
		const run = w.run();
		const { outcome, uploads } = await w.checkpoint(run, [{ path: "a.txt", data: "hello" }]);
		expect(outcome).toMatchObject({ ok: true, uploaded: 1 });
		const [blob] = w.blobRows();
		expect(blob).toMatchObject({ sha256: await sha("hello"), size: 5, state: "stored", run_id: run });
		expect(blob?.key).toMatch(new RegExp(`^${PREFIX}${await sha("hello")}/[0-9a-f]{32}$`));
		expect(uploads[0]?.files).toEqual([{ path: "a.txt", sha256: await sha("hello"), size: 5, key: blob?.key }]);
		expect(w.bucket.keys()).toEqual([blob?.key]);
		expect(w.counter.value).toBe(5);
		expect(w.store.readable(run)).toEqual(new Set([await sha("hello")]));
		expect(w.runRow(run)?.uploaded_bytes).toBe(5);

		// The same contents under another name: the run may read them now, so nothing is uploaded or charged.
		const again = await w.checkpoint(run, [
			{ path: "a.txt", data: "hello" },
			{ path: "b.txt", data: "hello" },
		]);
		expect(again.outcome).toMatchObject({ ok: true, uploaded: 0 });
		expect(again.uploads).toEqual([]);
		expect(w.runRow(run)?.uploaded_bytes).toBe(5);
		expect(w.bucket.keys()).toHaveLength(1);
	});

	test("contents another run stored are read again, charged to this run, and not stored twice", async () => {
		const w = new World();
		const first = w.run();
		await saved(w.checkpoint(first, [{ path: "a.txt", data: "hello" }]));
		w.finish(first);
		// The next run deletes a.txt; the one after it writes the same contents again, which it may not read.
		const second = w.run();
		await saved(w.checkpoint(second, []));
		w.finish(second);
		const third = w.run();
		expect(w.store.readable(third)).toEqual(new Set());
		const { outcome, uploads } = await w.checkpoint(third, [{ path: "again.txt", data: "hello" }]);
		expect(outcome).toMatchObject({ ok: true, uploaded: 1 });
		expect(uploads).toHaveLength(1);
		expect(w.runRow(third)?.uploaded_bytes).toBe(5);
		// One stored object per contents: the bytes were hashed, and nothing was written or recorded.
		expect(uploads[0]?.files[0]?.key).toBeNull();
		expect(w.blobRows().map((row) => row.state)).toEqual(["stored"]);
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toHaveLength(1);
		expect(w.counter.value).toBe(5);
		expect(w.store.readable(third).has(await sha("hello"))).toBe(true);
	});

	test("the workspace's quota refuses new contents, and nothing is stored", async () => {
		const w = new World();
		w.counter.limit = 10;
		const run = w.run();
		const { outcome } = await w.checkpoint(run, [{ path: "big", data: "x".repeat(11) }]);
		expect(outcome).toEqual({ ok: false, code: "quota", message: "The folder is over its workspace limit.", limit: "workspace" });
		expect(w.counter.value).toBeNull();
		expect(w.bucket.keys()).toEqual([]);
		await saved(w.checkpoint(run, [{ path: "y", data: "y".repeat(6) }]));
		await saved(w.checkpoint(run, [
			{ path: "y", data: "y".repeat(6) },
			{ path: "z", data: "z".repeat(4) },
		]));
		expect(w.counter.value).toBe(10);
		const over = await w.checkpoint(run, [
			{ path: "y", data: "y".repeat(6) },
			{ path: "z", data: "z".repeat(4) },
			{ path: "!", data: "!" },
		]);
		expect(over.outcome).toMatchObject({ ok: false, code: "quota", limit: "workspace" });
		await w.sweepAt(w.now);
		expect(w.counter.value).toBe(10);
		expect(w.bucket.keys()).toHaveLength(2);
	});

	test("the run's upload budget counts every upload", async () => {
		const w = new World({ runUploadBytes: 8 });
		const run = w.run();
		await saved(w.checkpoint(run, [{ path: "a", data: "hello" }]));
		await saved(w.checkpoint(run, [
			{ path: "a", data: "hello" },
			{ path: "b", data: "abc" },
		]));
		const over = await w.checkpoint(run, [
			{ path: "a", data: "hello" },
			{ path: "b", data: "abc" },
			{ path: "c", data: "!" },
		]);
		expect(over.outcome).toEqual({ ok: false, code: "quota", message: "The folder is over its run_uploads limit.", limit: "run_uploads" });
		expect(over.uploads).toEqual([]);
		expect(w.runRow(run)?.uploaded_bytes).toBe(8);
		expect(w.counter.value).toBe(8);
		expect(w.bucket.keys()).toHaveLength(2);
	});

	test("the budget is checked again when it is charged, so two checkpoints at once cannot pass it", async () => {
		const w = new World({ runUploadBytes: 8 });
		const run = w.run();
		const gate = Promise.withResolvers<void>();
		const counter = w.counter;
		let reports = 0;
		Object.assign(w, {
			counter: {
				setConversationBytes: async (conversationId: string, total: number, revision: number) => {
					if (++reports === 1) await gate.promise;
					return counter.setConversationBytes(conversationId, total, revision);
				},
			},
		});
		w.open();
		Object.assign(w, { counter });
		const first = w.checkpoint(run, [{ path: "a", data: "hello" }]);
		const second = w.checkpoint(run, [{ path: "b", data: "world" }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		gate.resolve();
		const outcomes = [(await first).outcome, (await second).outcome];
		expect(outcomes).toContainEqual({ ok: false, code: "quota", message: "The folder is over its run_uploads limit.", limit: "run_uploads" });
		expect(w.runRow(run)?.uploaded_bytes).toBe(5);
	});

	test("bytes received count against the budget whether or not they are stored", async () => {
		const w = new World({ runUploadBytes: 32 });
		const run = w.run();
		const failing = async () => ({ ok: false as const, reason: "mismatch" as const, path: "f", message: "The contents do not match the hash." });
		for (let i = 0; i < 4; i++) {
			const { outcome } = await w.checkpoint(run, [{ path: "f", data: `bad-${i}...` }], { upload: failing });
			expect(outcome).toMatchObject({ ok: false, code: "upload", reason: "mismatch" });
		}
		expect(w.runRow(run)?.uploaded_bytes).toBe(32);
		// The fifth is refused before anything is read from the container.
		let asked = false;
		const { outcome } = await w.checkpoint(run, [{ path: "f", data: "x" }], {
			upload: async () => {
				asked = true;
				return failing();
			},
		});
		expect(outcome).toMatchObject({ ok: false, code: "quota", limit: "run_uploads" });
		expect(asked).toBe(false);
		expect(w.versions()).toEqual([]);
	});

	test("a failed upload leaves no version, and its keys are deleted, twice", async () => {
		const w = new World();
		const run = w.run();
		w.bucket.faults.put = () => "lose";
		const { outcome } = await w.checkpoint(run, [{ path: "a", data: "hello" }]);
		expect(outcome).toMatchObject({ ok: false, code: "upload" });
		expect(w.versions()).toEqual([]);
		expect(w.runRow(run)?.checkpoint_version_id).toBeNull();
		// The put landed although its answer was lost; the object goes with the next sweep.
		expect(w.bucket.keys()).toHaveLength(1);
		expect(w.countsEnough()).toBe(true);
		w.bucket.faults.put = undefined;
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toEqual([]);
		expect(w.blobRows()).toMatchObject([{ state: "doomed", deletions: 1 }]);
		expect(w.counter.value).toBe(0);
	});

	test("contents the conversation already stores are hashed, not stored again, and need no room in the workspace", async () => {
		const w = new World();
		// Stored for a version the run may not read (a file deleted since, say), in a full workspace.
		const kept = await w.blob("hello");
		await w.store.sweep();
		w.counter.limit = 5;
		const run = w.run();
		const { outcome, uploads } = await w.checkpoint(run, [{ path: "again.txt", data: "hello" }]);
		expect(outcome).toMatchObject({ ok: true, uploaded: 1 });
		expect(uploads[0]?.files).toEqual([{ path: "again.txt", sha256: kept.sha256, size: 5, key: null }]);
		expect(w.bucket.keys()).toEqual([kept.key]);
		expect(w.blobRows()).toMatchObject([{ key: kept.key, state: "stored" }]);
		expect(w.counter.calls).toEqual([5]);
		expect(w.store.readable(run).has(kept.sha256)).toBe(true);
		expect(w.store.hydratePlan(run).files).toMatchObject([{ path: "again.txt", key: kept.key, size: 5 }]);
		// Bytes that do not hash to what the scan said are refused, as a put R2 refuses.
		const other = w.run({ baseVersionId: null });
		const wrong = await w.checkpoint(other, [{ path: "b.txt", data: "hello" }], {
			upload: (plan) => sandboxUpload(w.bucket, new Map([["b.txt", new TextEncoder().encode("jello")]]))(plan),
		});
		expect(wrong.outcome).toMatchObject({ ok: false, code: "upload", reason: "mismatch" });
	});

	test("a checkpoint after one whose upload threw writes the same keys again, so nothing is counted twice", async () => {
		const w = new World();
		w.counter.limit = 5;
		const run = w.run();
		await expect(
			w.checkpoint(run, [{ path: "a", data: "hello" }], {
				upload: async (plan) => {
					for (const file of plan.files) await w.bucket.put(file.key as string, "hello", { sha256: file.sha256 });
					throw new Error("The Sandbox did not answer.");
				},
			}),
		).rejects.toThrow("did not answer");
		const [loose] = w.blobRows();
		// The next attempt saves the same folder.
		w.restart(run);
		w.open();
		const { outcome, uploads } = await w.checkpoint(run, [{ path: "a", data: "hello" }]);
		expect(outcome).toMatchObject({ ok: true, uploaded: 1 });
		expect(uploads[0]?.files[0]?.key).toBe(loose?.key);
		expect(w.blobRows()).toMatchObject([{ key: loose?.key, state: "stored" }]);
		expect([w.counter.value, w.bucket.keys()]).toEqual([5, [loose?.key]]);
	});

	test("a refusal after a reused key keeps that key's record: an earlier try may have written it", async () => {
		const w = new World();
		w.counter.limit = 5;
		const run = w.run();
		await expect(
			w.checkpoint(run, [{ path: "a", data: "hello" }], {
				upload: async (plan) => {
					for (const file of plan.files) await w.bucket.put(file.key as string, "hello", { sha256: file.sha256 });
					throw new Error("The answer was lost.");
				},
			}),
		).rejects.toThrow("lost");
		// The retry needs one byte more than the workspace has: refused, and the written object stays recorded.
		const retry = await w.checkpoint(run, [
			{ path: "a", data: "hello" },
			{ path: "b", data: "!" },
		]);
		expect(retry.outcome).toMatchObject({ ok: false, code: "quota", limit: "workspace" });
		expect(w.blobRows()).toMatchObject([{ state: "loose", size: 5 }]);
		expect(w.countsEnough()).toBe(true);
		await w.sweepAt(w.now + LOOSE_GRACE_MS);
		expect(w.bucket.keys()).toEqual([]);
		expect(w.countsEnough()).toBe(true);
	});

	test("a failed retry leaves the key it reused loose for the hour: the earlier try's write may still land", async () => {
		const w = new World();
		const run = w.run();
		const late = Promise.withResolvers<void>();
		let written: Promise<unknown> = Promise.resolve();
		// The first try's upload is still writing when its object restarts.
		await expect(
			w.checkpoint(run, [{ path: "a", data: "hello" }], {
				upload: async (plan) => {
					const file = plan.files[0] as { key: string; sha256: string };
					written = late.promise.then(() => w.bucket.put(file.key as string, "hello", { sha256: file.sha256 }));
					throw new Error("The object restarted.");
				},
			}),
		).rejects.toThrow("restarted");
		w.restart(run);
		w.open();
		const retry = await w.checkpoint(run, [{ path: "a", data: "hello" }], {
			upload: async () => ({ ok: false, reason: "changed", path: "a", message: "A file changed while the folder was saved." }),
		});
		expect(retry.outcome).toMatchObject({ ok: false, code: "upload" });
		await w.sweepAt(w.now);
		late.resolve();
		await written;
		// Still recorded and counted: the sweep takes it once its hour has passed.
		expect(w.blobRows()).toMatchObject([{ state: "loose" }]);
		expect(w.countsEnough()).toBe(true);
		await w.sweepAt(w.now + LOOSE_GRACE_MS);
		expect(w.bucket.keys()).toEqual([]);
	});

	test("two checkpoints at once never share a key, so the one that loses cannot delete the other's", async () => {
		for (const loser of ["conflict", "upload failed"] as const) {
			const w = new World();
			const run = w.run();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let firstKey = "";
			const first = w.checkpoint(run, [{ path: "a", data: "hello" }], {
				upload: async (plan) => {
					firstKey = plan.files[0]?.key ?? "";
					entered.resolve();
					await release.promise;
					if (loser === "upload failed") return { ok: false, reason: "changed", path: "a", message: "A file changed while the folder was saved." };
					await w.bucket.put(firstKey, "hello", { sha256: plan.files[0]?.sha256 as string });
					return { ok: true, stored: plan.files };
				},
			});
			await entered.promise;
			const second = await w.checkpoint(run, [{ path: "a", data: "hello" }]);
			expect([loser, second.uploads[0]?.files[0]?.key === firstKey]).toEqual([loser, false]);
			release.resolve();
			const late = await first;
			expect(late.outcome).toMatchObject({ ok: false });
			await w.sweepAt(w.now);
			w.finish(run);
			const target = w.store.resolve(null, "a");
			expect([loser, target !== null && w.bucket.objects.has(target.key)]).toEqual([loser, true]);
			expect(w.bucket.keys()).toEqual([target?.key]);
			expect(w.countsEnough()).toBe(true);
		}
	});

	test("an upload the sweep took (it ran past the hour) cannot be claimed, and its object is deleted", async () => {
		const w = new World();
		const run = w.run();
		const { outcome } = await w.checkpoint(run, [{ path: "a", data: "hello" }], {
			upload: async (plan) => {
				await w.sweepAt(w.now + LOOSE_GRACE_MS);
				for (const file of plan.files) await w.bucket.put(file.key as string, "hello", { sha256: file.sha256 });
				return { ok: true, stored: plan.files };
			},
		});
		expect(outcome).toEqual({ ok: false, code: "unknown_blob", message: BLOB_GONE });
		expect(w.versions()).toEqual([]);
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toEqual([]);
	});

	test("an upload that does not match its plan, or whose bytes do not match their hash, is refused", async () => {
		const w = new World();
		const run = w.run();
		const wrongSize = await w.checkpoint(run, [{ path: "a", data: "hello" }], {
			upload: async (plan) => ({ ok: true, stored: plan.files.map((file) => ({ ...file, size: 4 })) }),
		});
		expect(wrongSize.outcome).toMatchObject({ ok: false, code: "upload", reason: "mismatch" });
		const wrongBytes = await w.checkpoint(run, [{ path: "a", data: "hello" }], {
			upload: async (plan) => {
				for (const file of plan.files) {
					await expect(w.bucket.put(file.key as string, "other", { sha256: file.sha256 })).rejects.toThrow(CHECKSUM_MISMATCH);
				}
				return { ok: false, reason: "mismatch", path: "a", message: "The contents do not match the hash." };
			},
		});
		expect(wrongBytes.outcome).toMatchObject({ ok: false, code: "upload", reason: "mismatch", path: "a" });
		expect(w.versions()).toEqual([]);
	});
});

// Checkpoints

const entry = async (path: string, data: string, mode: 0o644 | 0o755 = 0o644, mtime = 0) => ({ path, sha256: await sha(data), mode, mtime });

describe("checkpoints", () => {
	test("checkpoints build on each other", async () => {
		const w = new World();
		const run = w.run();
		const first = await saved(w.checkpoint(run, [{ path: "a.txt", data: "one" }], { dirs: ["empty"], parent: null }));
		expect(w.versions()).toMatchObject([{ id: first, kind: "checkpoint", run_id: run, attempt: 1, parent_id: null }]);
		expect(w.runRow(run)?.checkpoint_version_id).toBe(first);

		// The same folder again: the same version.
		expect(await saved(w.checkpoint(run, [{ path: "a.txt", data: "one" }], { dirs: ["empty"], parent: first }))).toBe(first);
		const second = await saved(
			w.checkpoint(
				run,
				[
					{ path: "a.txt", data: "one" },
					{ path: "dir/b.py", data: "two", mode: 0o755 },
				],
				{ parent: first },
			),
		);
		// A run keeps only its last checkpoint, built on its base version (none here).
		expect(w.versions()).toMatchObject([{ id: second, parent_id: null }]);
		expect(w.store.entries(second as string).files["dir/b.py"]).toEqual({ sha256: await sha("two"), size: 3, mode: 0o755, mtime: 0 });

		// Not on top of the last checkpoint.
		expect((await w.checkpoint(run, [{ path: "a.txt", data: "one" }], { parent: first })).outcome).toEqual({ ok: false, code: "conflict", message: CONFLICT });
		expect((await w.checkpoint(run, [], { parent: null })).outcome).toMatchObject({ ok: false, code: "conflict" });
		expect(w.runRow(run)?.checkpoint_version_id).toBe(second);
	});

	test("a checkpoint names contents the run may not read only once their bytes are uploaded", async () => {
		const w = new World();
		const run = w.run();
		// Another run of the conversation stored these, and they are in no version this run may read.
		await w.blob("theirs");
		for (const data of ["theirs", "missing"]) {
			// A container that only claims the hash, and cannot hand over the bytes.
			const { outcome, uploads } = await w.checkpoint(run, [{ path: "f", data }], {
				upload: async (plan) => ({ ok: false, reason: "changed", path: plan.files[0]?.path ?? "", message: "A file changed while the folder was saved." }),
			});
			expect(outcome).toMatchObject({ ok: false, code: "upload" });
			expect(uploads).toEqual([]);
		}
		expect(w.versions()).toEqual([]);
		expect(w.store.readable(run)).toEqual(new Set());
	});

	test.each<[string, WireManifest | unknown]>([
		["../x", { files: [{ path: "../x", sha256: "a".repeat(64), mode: 420, mtime: 0 }], dirs: [] }],
		["/abs", { files: [], dirs: ["/abs"] }],
		["a list", []],
		["no dirs", { files: [] }],
	])("a malformed checkpoint is refused: %s", async (_name, manifest) => {
		const w = new World();
		const run = w.run();
		const outcome = await w.store.checkpoint(w.fence(run), { parent: null, manifest: manifest as WireManifest, sizes: {} }, async () => {
			throw new Error("Nothing is uploaded.");
		});
		expect(outcome).toMatchObject({ ok: false, code: "invalid_manifest" });
	});

	test("a checkpoint is limited in size and entries", async () => {
		const w = new World({ folderBytes: 8192 });
		const run = w.run();
		// Two files of 5,000 bytes take two pages each.
		const big = "x".repeat(5000);
		const over = await w.checkpoint(run, [
			{ path: "a", data: big },
			{ path: "b", data: big },
		]);
		expect(over.outcome).toEqual({ ok: false, code: "quota", message: "The folder is over its folder_bytes limit.", limit: "folder_bytes" });
		expect(over.uploads).toEqual([]);
		w.settings.folderEntries = 2;
		expect((await w.checkpoint(run, [{ path: "d/e/f", data: big }])).outcome).toMatchObject({ ok: false, code: "quota", limit: "folder_entries" });
		expect((await w.checkpoint(run, [{ path: "d/f", data: big }])).outcome).toMatchObject({ ok: true });
	});

	test("a checkpoint records what the scan left out", async () => {
		const w = new World();
		const run = w.run();
		// The scan shows a control character in a name as U+FFFD.
		const leftOut: FolderWarnings = { total: 3, items: [{ path: "link", reason: "symlink" }, { path: "a�b", reason: "invalid_name" }] };
		const version = await saved(w.checkpoint(run, [{ path: "a", data: "one" }], { warnings: leftOut }));
		expect(w.warnings(run)).toEqual(leftOut);
		// The same folder with less left out is the same version, with the new warnings.
		expect(await saved(w.checkpoint(run, [{ path: "a", data: "one" }], { warnings: { total: 0, items: [] }, parent: version }))).toBe(version);
		expect(w.warnings(run)).toEqual({ total: 0, items: [] });
		// A checkpoint without warnings leaves them as they were.
		expect(await saved(w.checkpoint(run, [{ path: "a", data: "one" }], { parent: version }))).toBe(version);
		expect(await saved(w.checkpoint(run, [{ path: "a", data: "one" }], { warnings: null, parent: version }))).toBe(version);
		expect(w.warnings(run)).toEqual({ total: 0, items: [] });
	});

	test.each([
		[[]],
		[{ total: 0 }],
		[{ total: 0, items: [], more: 1 }],
		[{ total: true, items: [] }],
		[{ total: 0, items: [{ path: "a", reason: "symlink" }] }],
		[{ total: 2 ** 31, items: [] }],
		[{ total: 101, items: Array(101).fill({ path: "a", reason: "symlink" }) }],
		[{ total: 1, items: [{ path: "a", reason: "deleted" }] }],
		[{ total: 1, items: [{ path: "a", reason: [] }] }],
		[{ total: 1, items: [{ path: "a", reason: {} }] }],
		[{ total: 1, items: [{ path: "a", reason: "symlink", size: 1 }] }],
		[{ total: 1, items: [{ path: "", reason: "symlink" }] }],
		[{ total: 1, items: [{ path: "a\nb", reason: "symlink" }] }],
		[{ total: 1, items: [{ path: "a".repeat(1025), reason: "too_long" }] }],
		[{ total: 1, items: [{ path: 1, reason: "symlink" }] }],
	])("malformed warnings refuse the checkpoint: %j", async (warnings) => {
		const w = new World();
		const run = w.run();
		const { outcome, uploads } = await w.checkpoint(run, [{ path: "a", data: "one" }], { warnings: warnings as unknown as FolderWarnings });
		expect(outcome).toMatchObject({ ok: false, code: "invalid_manifest" });
		expect(uploads).toEqual([]);
		expect([w.runRow(run)?.checkpoint_version_id, w.runRow(run)?.folder_warnings]).toEqual([null, null]);
		expect(w.blobRows()).toEqual([]);
	});

	test("an earlier attempt cannot checkpoint; the new one builds on the checkpoint it hydrated", async () => {
		const w = new World();
		const run = w.run();
		const old = w.fence(run);
		const version = await saved(w.checkpoint(run, [{ path: "a", data: "one" }]));
		w.restart(run);
		expect((await w.checkpoint(run, [], { fence: old, parent: version })).outcome).toEqual({ ok: false, code: "stale", message: STALE });
		// Refused before anything else: nothing is read from its container, and its warnings are not kept.
		const late = await w.checkpoint(run, [{ path: "b", data: "two" }], { fence: old, parent: version });
		expect([late.outcome, late.uploads]).toEqual([{ ok: false, code: "stale", message: STALE }, []]);
		const same = await w.checkpoint(run, [{ path: "a", data: "one" }], { fence: old, parent: version, warnings: { total: 1, items: [{ path: "x", reason: "special" }] } });
		expect(same.outcome).toMatchObject({ ok: false, code: "stale" });
		expect(w.warnings(run)).toBeNull();
		expect(w.blobRows()).toHaveLength(1);
		expect(w.store.hydratePlan(run).versionId).toBe(version);
		const next = await saved(w.checkpoint(run, [], { parent: version }));
		expect(w.versions()).toMatchObject([{ id: next, attempt: 2, run_id: run }]);
	});

	test("a run keeps only its last checkpoint, and may still read what the replaced ones held", async () => {
		const w = new World();
		const first = w.run();
		const base = await saved(w.checkpoint(first, [{ path: "a", data: "one" }]));
		w.finish(first);
		const second = w.run();
		let parent = base;
		for (const files of [
			[
				{ path: "a", data: "one" },
				{ path: "b", data: "two" },
			],
			[{ path: "b", data: "two" }],
			[{ path: "a", data: "one" }],
		]) {
			parent = await saved(w.checkpoint(second, files, { parent }));
		}
		const own = w.versions().filter((version) => version.run_id === second);
		expect(own).toMatchObject([{ id: parent, kind: "checkpoint", parent_id: base }]);
		// What the replaced checkpoints held stays readable: it is the base version's, or uploaded by the run.
		expect(w.store.readable(second)).toEqual(new Set([await sha("one"), await sha("two")]));
		expect((await w.checkpoint(second, [{ path: "b", data: "two" }], { parent })).uploads).toEqual([]);
		// A new attempt starts from the last one.
		w.restart(second);
		const plan = w.store.hydratePlan(second);
		expect(plan.versionId).toBe(w.runRow(second)?.checkpoint_version_id);
		expect(plan.files.map((file) => file.path)).toEqual(["b"]);
		expect(w.versions().filter((version) => version.run_id === second)).toHaveLength(1);
	});

	test.each([
		["complete", (w: World, run: string) => w.finish(run, "completed")],
		["cancel", (w: World, run: string) => w.finish(run, "cancelled")],
		["fail", (w: World, run: string) => w.finish(run, "failed")],
		["time out", (w: World, run: string) => w.finish(run, "timed_out")],
		["revoke", (w: World, run: string) => w.finish(run, "cancelled", { revoke: true })],
	])("every way a run ends publishes its last checkpoint: %s", async (_name, end) => {
		const w = new World();
		const run = w.run();
		const first = await saved(w.checkpoint(run, [{ path: "a", data: "one" }]));
		const last = await saved(w.checkpoint(run, [{ path: "a", data: "two" }], { parent: first }));
		end(w, run);
		const row = w.runRow(run);
		expect(["queued", "provisioning", "running"]).not.toContain(row?.status);
		expect([row?.result_version_id, row?.checkpoint_version_id]).toEqual([last, last]);
		expect(w.versions()).toMatchObject([{ id: last, kind: "turn", parent_id: null }]);
		expect(w.folder()).toBe(last);
		expect(parseJson(row?.folder_changes as string)).toMatchObject({ counts: { added: 1 } });
		// No checkpoint after the run ended.
		expect((await w.checkpoint(run, [{ path: "a", data: "one" }], { parent: last })).outcome).toMatchObject({ ok: false, code: "stale" });
		// The first checkpoint's blob is in no version it may keep: deleted with the next sweep.
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toEqual([w.blobRows().find((blob) => blob.state === "stored")?.key]);
	});

	test("the next run starts from the published folder", async () => {
		const w = new World();
		const run = w.run();
		const published = await saved(w.checkpoint(run, [{ path: "a", data: "one" }]));
		w.finish(run);

		const second = w.run();
		expect(w.runRow(second)?.base_version_id).toBe(published);
		const plan = w.store.hydratePlan(second);
		expect(plan).toEqual({
			versionId: published,
			files: [{ path: "a", sha256: await sha("one"), size: 3, mode: 0o644, mtime: 0, key: w.blobRows()[0]?.key }],
			dirs: [],
		});
		// It may read its base version's blobs, but has uploaded nothing.
		expect(w.store.readable(second)).toEqual(new Set([await sha("one")]));

		// A run that changes nothing publishes the version it started from.
		w.finish(second, "cancelled");
		expect(w.runRow(second)?.result_version_id).toBe(published);
		expect(w.folder()).toBe(published);
		expect(w.versions()).toMatchObject([{ id: published, kind: "turn" }]);
		expect(w.runRow(second)?.folder_changes).toBeNull();

		// A checkpoint on top of the base version becomes a turn whose parent is that base.
		const third = w.run();
		await saved(w.checkpoint(third, [], { parent: published }));
		w.finish(third);
		const result = w.versions().find((version) => version.id === w.runRow(third)?.result_version_id);
		expect([result?.kind, result?.parent_id, result?.file_count]).toEqual(["turn", published, 0]);
		expect(parseJson(w.runRow(third)?.folder_changes as string)).toMatchObject({ counts: { deleted: 1 }, deleted: [{ path: "a", size: 3 }] });
		// Earlier turns stay as history; their blobs are kept.
		await w.sweepAt(w.now + DAY);
		expect(w.bucket.keys()).toHaveLength(1);
		expect(w.store.list(published)?.files).toEqual([{ path: "a", size: 3, mtime: 0 }]);
	});

	test("a run without files publishes nothing", async () => {
		const w = new World();
		const run = w.run();
		expect((await w.checkpoint(run, [])).outcome).toEqual({ ok: true, versionId: null, uploaded: 0 });
		w.finish(run);
		expect(w.runRow(run)?.result_version_id).toBeNull();
		expect(w.folder()).toBeNull();
		expect(w.store.list(null)).toEqual({ version_id: null, files: [], dirs: [] });
	});

	test("a checkpoint whose upload is in flight when the run ends is refused, and nothing is published from it", async () => {
		const w = new World();
		const run = w.run();
		const { outcome } = await w.checkpoint(run, [{ path: "a", data: "one" }], {
			upload: async (plan) => {
				w.finish(run, "cancelled");
				for (const file of plan.files) await w.bucket.put(file.key as string, "one", { sha256: file.sha256 });
				return { ok: true, stored: plan.files };
			},
		});
		expect(outcome).toEqual({ ok: false, code: "stale", message: STALE });
		expect(w.runRow(run)?.result_version_id).toBeNull();
		expect(w.versions()).toEqual([]);
		// Its object is deleted now, and again a day later.
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toEqual([]);
	});

	test("a run that ends once its checkpoint is recorded publishes it", async () => {
		const w = new World();
		const run = w.run();
		const version = await saved(w.checkpoint(run, [{ path: "a", data: "one" }]));
		w.finish(run, "cancelled");
		expect(w.runRow(run)?.result_version_id).toBe(version);
	});

	test("a run reads its base and its uploads whatever its checkpoints drop", async () => {
		const w = new World();
		const run = w.run();
		const base = await saved(w.checkpoint(run, [{ path: "a", data: "one" }]));
		w.finish(run);
		const second = w.run();
		await saved(w.checkpoint(second, [{ path: "b", data: "two" }], { parent: base }));
		// Empty the folder, then bring back the base version's file and the upload.
		const emptied = await saved(w.checkpoint(second, [], { parent: w.runRow(second)?.checkpoint_version_id ?? null }));
		const { outcome, uploads } = await w.checkpoint(
			second,
			[
				{ path: "a", data: "one" },
				{ path: "b", data: "two" },
			],
			{ parent: emptied },
		);
		expect(outcome).toMatchObject({ ok: true, uploaded: 0 });
		expect(uploads).toEqual([]);
		const readable = w.store.readable(second);
		expect([await sha("one"), await sha("two"), await sha("three")].map((hash) => readable.has(hash))).toEqual([true, true, false]);
	});

	test("the scan's claims are checked again: sizes for uploads, one size per contents", async () => {
		const w = new World();
		const run = w.run();
		const manifest = { files: [await entry("a", "one"), await entry("b", "one")], dirs: [] };
		const upload = async () => {
			throw new Error("Nothing is uploaded.");
		};
		expect(await w.store.checkpoint(w.fence(run), { parent: null, manifest, sizes: { a: 3 } }, upload)).toMatchObject({ ok: false, code: "invalid_manifest" });
		expect(await w.store.checkpoint(w.fence(run), { parent: null, manifest, sizes: { a: 3, b: 4 } }, upload)).toMatchObject({ ok: false, code: "invalid_manifest" });
		expect(await w.store.checkpoint(w.fence(run), { parent: null, manifest, sizes: { a: 3, b: -1 } }, upload)).toMatchObject({ ok: false, code: "invalid_manifest" });
		expect(await w.store.checkpoint(w.fence(run), { parent: null, manifest, sizes: [] as never }, upload)).toMatchObject({ ok: false, code: "invalid_manifest" });
	});
});

// Attachments

describe("attachments", () => {
	test("attachments are added at the root of the folder the run starts from, numbered against every root name", async () => {
		const w = new World();
		const earlier = w.run();
		const first = await saved(w.checkpoint(earlier, [{ path: "notes.txt", data: "old" }], { dirs: ["data.csv (2)"] }));
		w.finish(earlier);
		const a = await w.upload("notes.txt", "new notes");
		const b = await w.upload("data.csv", "a,b\n", "text/csv");
		const run = w.run({ status: "queued", baseVersionId: null });
		const prepared = await w.store.prepareAttachments(run, [a, b]);
		if (!prepared.ok) throw new Error(prepared.refusal.detail);
		const { baseVersionId, attachments } = w.sql.transaction(() => w.store.commitAttachments(run, prepared.value));
		expect(attachments).toEqual([
			{ path: "notes (2).txt", size: 9, media_type: "text/plain" },
			{ path: "data.csv", size: 4, media_type: "text/csv" },
		]);
		const base = w.versions().find((version) => version.id === baseVersionId);
		expect(base).toMatchObject({ kind: "base", parent_id: first, run_id: run });
		const entries = w.store.entries(baseVersionId as string);
		expect(Object.fromEntries(Object.entries(entries.files).map(([path, file]) => [path, file.sha256]))).toEqual({
			"notes.txt": await sha("old"),
			"notes (2).txt": await sha("new notes"),
			"data.csv": await sha("a,b\n"),
		});
		expect(entries.files["notes (2).txt"]).toMatchObject({ mode: 0o644, mtime: w.now, size: 9 });
		expect(entries.dirs).toEqual(["data.csv (2)"]);
		// The folder names the conversation's own copies, never an `uploads/` key.
		const copies = w.blobRows().filter((row) => row.run_id === run);
		expect(copies.map((row) => [row.sha256, row.state]).sort()).toEqual(
			[
				[await sha("new notes"), "stored"],
				[await sha("a,b\n"), "stored"],
			].sort(),
		);
		for (const copy of copies) expect(copy.key.startsWith(PREFIX)).toBe(true);
		expect(w.counter.value).toBe(3 + 9 + 4);
		expect(w.store.resolve(baseVersionId, "notes (2).txt")).toMatchObject({ key: copies.find((row) => row.size === 9)?.key, size: 9 });
	});

	test("two attachments of one name are numbered against each other; contents the conversation holds are not copied", async () => {
		const w = new World();
		await w.blob("same");
		const uploads = [await w.upload("a.txt", "same"), await w.upload("a.txt", "other"), await w.upload("b.txt", "other")];
		const run = w.run({ status: "queued" });
		const prepared = await w.store.prepareAttachments(run, uploads);
		if (!prepared.ok) throw new Error(prepared.refusal.detail);
		expect(prepared.value?.attachments.map((attachment) => attachment.path)).toEqual(["a.txt", "a (2).txt", "b.txt"]);
		expect(prepared.value?.copies.map((copy) => copy.sha256)).toEqual([await sha("other")]);
		expect(prepared.value?.reused).toEqual([await sha("same")]);
		const { baseVersionId } = w.sql.transaction(() => w.store.commitAttachments(run, prepared.value));
		expect(w.store.list(baseVersionId)?.files.map((file) => file.path)).toEqual(["a (2).txt", "a.txt", "b.txt"]);
	});

	test("a message without attachments starts from the folder, and no version is made", async () => {
		const w = new World();
		const earlier = w.run();
		const first = await saved(w.checkpoint(earlier, [{ path: "notes.txt", data: "old" }]));
		w.finish(earlier);
		const run = w.run({ status: "queued" });
		const prepared = await w.store.prepareAttachments(run, []);
		expect(prepared).toEqual({ ok: true, value: null });
		expect(w.store.commitAttachments(run, null)).toEqual({ baseVersionId: first, attachments: [] });
		expect(w.versions()).toHaveLength(1);
	});

	test("attachments over the folder's limits are refused before anything is copied, in words", async () => {
		const w = new World({ folderBytes: 3 });
		const run = w.run({ status: "queued" });
		const big = await w.upload("big.bin", "mine");
		expect(await w.store.prepareAttachments(run, [big])).toEqual({ ok: false, refusal: { status: 413, detail: "These files would make this conversation's folder larger than 0.00000286102 MB." } });
		w.settings.folderBytes = 268_435_456;
		w.settings.folderEntries = 1;
		const two = [await w.upload("a", "1"), await w.upload("b", "2")];
		expect(await w.store.prepareAttachments(run, two)).toEqual({ ok: false, refusal: { status: 413, detail: "These files would put more than 1 files and folders in this conversation's folder." } });
		w.settings.folderEntries = 10_000;
		expect(w.blobRows()).toEqual([]);
		expect(w.bucket.keys()).toEqual([]);
		expect(w.counter.calls).toEqual([]);
	});

	test("an upload that is gone, or does not hold what was recorded for it, refuses the start and leaves nothing claimed", async () => {
		const w = new World();
		const run = w.run({ status: "queued" });
		const gone = await w.upload("gone.txt", "gone");
		w.bucket.objects.delete(gone.key);
		expect(await w.store.prepareAttachments(run, [await w.upload("fine.txt", "fine"), gone])).toEqual({ ok: false, refusal: { status: 400, detail: NO_LONGER_AVAILABLE } });
		const corrupt = await w.upload("corrupt.txt", "corrupt");
		w.bucket.objects.set(corrupt.key, new TextEncoder().encode("changed"));
		expect(await w.store.prepareAttachments(run, [corrupt])).toEqual({ ok: false, refusal: { status: 400, detail: NO_LONGER_AVAILABLE } });
		expect(w.blobRows().every((row) => row.state === "doomed")).toBe(true);
		await w.sweepAt(w.now);
		expect(w.bucket.keys()).toEqual([]);
		expect(w.counter.value).toBe(0);
	});

	test("a copy whose answer is lost is made again under its key, and counted once", async () => {
		const w = new World();
		const run = w.run({ status: "queued" });
		const upload = await w.upload("a.txt", "hello");
		let puts = 0;
		w.bucket.faults.put = () => (++puts === 1 ? "lose" : "write");
		const prepared = await w.store.prepareAttachments(run, [upload]);
		if (!prepared.ok) throw new Error(prepared.refusal.detail);
		expect(puts).toBe(2);
		expect(w.bucket.keys()).toEqual([prepared.value?.copies[0]?.key]);
		w.sql.transaction(() => w.store.commitAttachments(run, prepared.value));
		expect(w.blobRows().map((row) => row.state)).toEqual(["stored"]);
		expect(w.counter.value).toBe(5);
	});

	test("a start sent again after its object restarted copies into the keys it recorded, so it is not counted twice", async () => {
		const w = new World();
		w.counter.limit = 5;
		const run = w.run({ status: "queued" });
		const upload = await w.upload("a.txt", "hello");
		const first = await w.store.prepareAttachments(run, [upload]);
		if (!first.ok) throw new Error(first.refusal.detail);
		// The object restarts before the start's transaction; its watch sends the start again.
		w.now += 20_000;
		w.open();
		const again = await w.store.prepareAttachments(run, [upload]);
		if (!again.ok) throw new Error(again.refusal.detail);
		expect(again.value?.copies).toEqual(first.value?.copies);
		expect(w.blobRows()).toMatchObject([{ state: "loose", due_at: w.now + LOOSE_GRACE_MS }]);
		expect(w.counter.value).toBe(5);
		w.sql.transaction(() => w.store.commitAttachments(run, again.value));
		expect(w.bucket.keys()).toHaveLength(1);
	});

	test("a copy that fails twice throws (the start's watch sends it again); nothing is claimed", async () => {
		const w = new World();
		const run = w.run({ status: "queued" });
		const upload = await w.upload("a.txt", "hello");
		w.bucket.faults.put = () => "refuse";
		await expect(w.store.prepareAttachments(run, [upload])).rejects.toThrow("Network connection lost");
		expect(w.blobRows().map((row) => row.state)).toEqual(["doomed"]);
		w.bucket.faults.put = undefined;
		// Sent again: new keys, and the start goes through.
		const prepared = await w.store.prepareAttachments(run, [upload]);
		expect(prepared.ok).toBe(true);
	});

	test("the workspace with no room refuses the copies", async () => {
		const w = new World();
		w.counter.limit = 3;
		const run = w.run({ status: "queued" });
		expect(await w.store.prepareAttachments(run, [await w.upload("a.txt", "hello")])).toEqual({ ok: false, refusal: { status: 413, detail: NO_ROOM } });
		expect(w.bucket.keys()).toEqual([]);
	});

	test("the start's transaction refuses a folder that moved, or a copy the sweep took", async () => {
		const w = new World();
		const run = w.run({ status: "queued" });
		const prepared = await w.store.prepareAttachments(run, [await w.upload("a.txt", "hello")]);
		if (!prepared.ok) throw new Error(prepared.refusal.detail);
		w.setFolder("0199a000-0000-7000-8000-00000000beef");
		expect(() => w.sql.transaction(() => w.store.commitAttachments(run, prepared.value))).toThrow("The folder changed");
		w.setFolder(null);
		await w.sweepAt(w.now + LOOSE_GRACE_MS);
		expect(() => w.sql.transaction(() => w.store.commitAttachments(run, prepared.value))).toThrow("was deleted before the start was stored");
		expect(w.versions()).toEqual([]);
	});

	test("a deleted conversation copies nothing", async () => {
		const w = new World();
		w.sql.exec("UPDATE conversation SET deleted_at = ?", w.now);
		expect(await w.store.prepareAttachments(w.run({ status: "queued" }), [await w.upload("a", "a")])).toEqual({ ok: false, refusal: { status: 404, detail: "Not Found" } });
	});
});

// The web's view of the folder.

describe("listing and resolving", () => {
	test("the folder, or a version of it that is not a checkpoint; a path matched exactly", async () => {
		const w = new World();
		const run = w.run();
		const checkpoint = await saved(w.checkpoint(run, [{ path: "zażółć report.html", data: "<script>alert(1)</script>" }]));
		// A checkpoint is still being written: neither listed nor downloaded.
		expect(w.store.list(checkpoint)).toBeNull();
		expect(w.store.resolve(checkpoint, "zażółć report.html")).toBeNull();
		w.finish(run);
		const listed = { version_id: checkpoint, files: [{ path: "zażółć report.html", size: 25, mtime: 0 }], dirs: [] };
		expect(w.store.list(null)).toEqual(listed);
		expect(w.store.list(checkpoint)).toEqual(listed);
		expect(w.store.list("0199a000-0000-7000-8000-00000000beef")).toBeNull();
		expect(w.store.resolve(null, "zażółć report.html")).toMatchObject({ versionId: checkpoint, path: "zażółć report.html", sha256: await sha("<script>alert(1)</script>"), size: 25 });
		for (const path of ["missing.txt", "zażółć report.html ", "ZAŻÓŁĆ REPORT.HTML", "constructor", "__proto__"]) expect(w.store.resolve(null, path)).toBeNull();
	});
});

// The sweep

describe("the sweep", () => {
	test("an object nothing claimed is deleted an hour after it was recorded, and again a day later", async () => {
		const w = new World();
		const run = w.run();
		// A checkpoint whose upload throws (the object died with it, say): its key stays loose.
		await expect(
			w.checkpoint(run, [{ path: "a", data: "hello" }], {
				upload: async (plan) => {
					for (const file of plan.files) await w.bucket.put(file.key as string, "hello", { sha256: file.sha256 });
					throw new Error("The Sandbox did not answer.");
				},
			}),
		).rejects.toThrow("did not answer");
		const [loose] = w.blobRows();
		expect(loose).toMatchObject({ state: "loose", due_at: START + LOOSE_GRACE_MS });
		expect(w.scheduled).toContain(START + LOOSE_GRACE_MS);
		expect(w.countsEnough()).toBe(true);
		expect(await w.sweepAt(START + LOOSE_GRACE_MS - 1)).toEqual({ rescheduleAt: START + LOOSE_GRACE_MS });
		expect(w.bucket.keys()).toHaveLength(1);

		expect(await w.sweepAt(START + LOOSE_GRACE_MS)).toEqual({ rescheduleAt: START + LOOSE_GRACE_MS + SECOND_DELETION_MS });
		expect(w.bucket.keys()).toEqual([]);
		expect(w.blobRows()).toMatchObject([{ state: "doomed", deletions: 1, due_at: START + LOOSE_GRACE_MS + SECOND_DELETION_MS }]);
		expect(w.counter.value).toBe(0);

		// A write still in flight could have recreated it: it is deleted once more a day later.
		w.bucket.objects.set(loose?.key as string, new TextEncoder().encode("late"));
		await w.sweepAt(START + LOOSE_GRACE_MS + 1);
		expect(w.bucket.keys()).toHaveLength(1);
		expect(await w.sweepAt(START + LOOSE_GRACE_MS + SECOND_DELETION_MS)).toBeUndefined();
		expect(w.bucket.keys()).toEqual([]);
		expect(w.blobRows()).toEqual([]);
	});

	test("stored blobs are kept: named by a version, or granted to a run that is still active", async () => {
		const w = new World();
		const first = w.run();
		await saved(w.checkpoint(first, [{ path: "named", data: "named" }]));
		w.finish(first);
		const run = w.run();
		await saved(w.checkpoint(run, [
			{ path: "named", data: "named" },
			{ path: "granted", data: "granted" },
		]));
		// The run drops its upload; its grant keeps it until the run ends.
		await saved(w.checkpoint(run, [{ path: "named", data: "named" }], { parent: w.runRow(run)?.checkpoint_version_id ?? null }));
		await w.sweepAt(w.now + 2 * DAY);
		expect(w.blobRows().map((row) => row.state)).toEqual(["stored", "stored"]);
		expect(w.store.readable(run).has(await sha("granted"))).toBe(true);
		// Once the run finished, the grant and then the blob go in one sweep, and the count drops accordingly.
		w.finish(run);
		expect(w.sql.exec("SELECT * FROM folder_grants")).toEqual([]);
		await w.sweepAt(w.now + 2 * DAY);
		expect(w.blobRows()).toMatchObject([{ sha256: await sha("named"), state: "stored" }, { sha256: await sha("granted"), state: "doomed", deletions: 1 }]);
		expect(w.counter.value).toBe("named".length);
		expect(w.bucket.bytes()).toBe("named".length);
	});

	test("an object that cannot be deleted stays queued and is deleted by a later sweep", async () => {
		const w = new World();
		const run = w.run({ status: "queued" });
		const prepared = await w.store.prepareAttachments(run, [await w.upload("gone", "x")]);
		expect(prepared.ok).toBe(true);
		// Never stored (the start was refused after the copies): its copy is loose.
		w.bucket.faults.delete = true;
		const later = await w.sweepAt(w.now + LOOSE_GRACE_MS);
		expect(later).toEqual({ rescheduleAt: w.now + 30_000 });
		expect(w.blobRows()).toMatchObject([{ state: "doomed", deletions: 0 }]);
		expect(w.bucket.keys()).toHaveLength(1);
		expect(w.counter.value).toBe(1);
		w.bucket.faults.delete = false;
		await w.sweepAt(w.now + 30_000);
		expect(w.blobRows()).toMatchObject([{ state: "doomed", deletions: 1 }]);
		expect(w.bucket.keys()).toEqual([]);
		expect(w.counter.value).toBe(0);
	});

	test("a loose key that a version names is stored, never deleted", async () => {
		const w = new World();
		const run = w.run();
		await saved(w.checkpoint(run, [{ path: "a", data: "hello" }]));
		await w.sweepAt(w.now + 3 * DAY);
		expect(w.bucket.keys()).toHaveLength(1);
		expect(w.blobRows()).toMatchObject([{ state: "stored", due_at: null }]);
	});

	test("deleting the conversation's objects deletes everything under its prefix, recorded or not", async () => {
		const w = new World();
		const run = w.run();
		await saved(w.checkpoint(run, [{ path: "a", data: "hello" }]));
		w.bucket.objects.set(`${PREFIX}${"0".repeat(64)}/stray`, new Uint8Array(1));
		for (let i = 0; i < 1500; i++) w.bucket.objects.set(`${PREFIX}${"1".repeat(64)}/${i}`, new Uint8Array(0));
		w.bucket.objects.set(`blobs/${WORKSPACE}/0199a000-0000-7000-8000-00000000other/x/y`, new Uint8Array(1));
		expect(await w.store.deleteObjects()).toBe(1502);
		expect(w.bucket.keys(PREFIX)).toEqual([]);
		expect(w.bucket.keys()).toHaveLength(1);
	});
});

// The Workspace's byte count (plan: Files): never less than the conversation's objects
// hold, at every point a crash can leave it, and right again once the sweep has run.

describe("the byte count after a crash", () => {
	test("a checkpoint: after its keys are recorded, after the report, after the upload, after the record", async () => {
		for (const crash of ["recorded", "reported", "uploaded", "recorded version"] as const) {
			const w = new World();
			const run = w.run();
			w.counter.fail = crash === "recorded";
			const outcome = w
				.checkpoint(run, [{ path: "a", data: "hello" }], {
					upload: async (plan) => {
						for (const file of plan.files) await w.bucket.put(file.key as string, "hello", { sha256: file.sha256 });
						if (crash === "reported") throw new Error("crash before the upload's answer");
						if (crash === "uploaded") throw new Error("crash after the upload");
						return { ok: true, stored: plan.files };
					},
				})
				.catch(() => null);
			await outcome;
			w.counter.fail = false;
			// The object restarts: nothing in memory survives.
			w.open();
			expect([crash, w.countsEnough()]).toEqual([crash, true]);
			// Something is left for the sweep, unless the checkpoint went through.
			expect([crash, w.store.nextSweep() === null]).toEqual([crash, crash === "recorded version"]);
			await w.sweepAt(w.now + LOOSE_GRACE_MS);
			await w.sweepAt(w.now + SECOND_DELETION_MS);
			expect([crash, w.counter.value, w.bucket.bytes(PREFIX)]).toEqual([crash, w.bucket.bytes(PREFIX), w.store.total()]);
		}
	});

	test("an attachment's copy: after the report, after the put, after the start's transaction", async () => {
		for (const crash of ["reported", "copied", "stored"] as const) {
			const w = new World();
			const run = w.run({ status: "queued" });
			const upload = await w.upload("a.txt", "hello");
			if (crash === "reported") w.bucket.faults.put = () => "refuse";
			const prepared = await w.store.prepareAttachments(run, [upload]).catch(() => null);
			w.bucket.faults.put = undefined;
			if (crash === "stored" && prepared?.ok) w.sql.transaction(() => w.store.commitAttachments(run, prepared.value));
			w.open();
			expect([crash, w.countsEnough()]).toEqual([crash, true]);
			await w.sweepAt(w.now + LOOSE_GRACE_MS);
			await w.sweepAt(w.now + SECOND_DELETION_MS);
			expect([crash, w.counter.value]).toEqual([crash, w.bucket.bytes(PREFIX)]);
			expect([crash, w.bucket.bytes(PREFIX)]).toEqual([crash, crash === "stored" ? 5 : 0]);
		}
	});

	test("the sweep: after its deletion, before it is recorded or reported", async () => {
		const w = new World();
		const run = w.run();
		await saved(w.checkpoint(run, [{ path: "a", data: "hello" }]));
		await saved(w.checkpoint(run, [{ path: "a", data: "world" }], { parent: w.runRow(run)?.checkpoint_version_id ?? null }));
		w.finish(run);
		expect(w.counter.value).toBe(10);
		w.counter.fail = true;
		await w.sweepAt(w.now);
		// Deleted, but the Workspace did not hear: it counts more than there is, never less.
		expect(w.bucket.bytes(PREFIX)).toBe(5);
		expect(w.counter.value).toBe(10);
		w.counter.fail = false;
		w.open();
		expect(w.store.nextSweep()).toBe(w.now);
		await w.sweepAt(w.now);
		expect(w.counter.value).toBe(5);
	});

	test("every report names a revision above the last one sent, also by an earlier instance", async () => {
		const w = new World();
		const run = w.run();
		await w.checkpoint(run, [{ path: "a", data: "hello" }]);
		w.open();
		await w.checkpoint(run, [
			{ path: "a", data: "hello" },
			{ path: "b", data: "world!" },
		]);
		w.open();
		await w.store.sweep();
		expect(w.counter.calls).toEqual([5, 11]);
		const [first, second] = w.counter.revisions;
		expect(first).toBeGreaterThanOrEqual(1);
		expect(second).toBeGreaterThan(first as number);
	});

	test("reports go one at a time, so a smaller total never lands after a larger one", async () => {
		const w = new World();
		const gate = Promise.withResolvers<void>();
		const order: number[] = [];
		const counter = w.counter;
		const slow = {
			setConversationBytes: async (conversationId: string, total: number, revision: number) => {
				order.push(total);
				if (order.length === 1) await gate.promise;
				return counter.setConversationBytes(conversationId, total, revision);
			},
		};
		Object.assign(w, { counter: slow });
		w.open();
		Object.assign(w, { counter });
		const run = w.run();
		const first = w.checkpoint(run, [{ path: "a", data: "hello" }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = w.store.sweep();
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The sweep's report waits for the checkpoint's.
		expect(order).toEqual([5]);
		gate.resolve();
		await first;
		await second;
		expect(counter.value).toBe(5);
	});
});
