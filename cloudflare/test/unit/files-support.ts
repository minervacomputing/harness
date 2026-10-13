// Helpers for the files tests: an in-memory R2 bucket with fault hooks, a Workspace byte
// counter, and a conversation's folder over node:sqlite with the Conversation's own schema, its runs and a
// `finish` that publishes as conversation/store.ts does.

import type { AttemptFence, RunId, Sha256, VersionId } from "../../src/contracts/common.ts";
import type { CheckpointScan, FileMode, FolderWarnings } from "../../src/contracts/files.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult } from "../../src/contracts/sandbox.ts";
import type { ReservedUpload } from "../../src/contracts/workspace.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { CHECK_MISMATCH } from "../../src/sandbox/ports.ts";
import type { Bucket, StoredObject } from "../../src/files/objects.ts";
import { type ByteCounter, type FolderDeps, FolderStore } from "../../src/files/store.ts";
import { hex } from "../../src/lib/bytes.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";
import { migrate, type Sql, sqliteSql } from "../../src/lib/sql.ts";
import { openDatabase } from "./sqlite.ts";

export const WORKSPACE = "0199a000-0000-7000-8000-00000000f0a1";
export const CONVERSATION = "0199a000-0000-7000-8000-00000000f0c1";
export const UPLOADER = "0199a000-0000-7000-8000-00000000f0d1";
export const START = 1_760_000_000_000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

const encoder = new TextEncoder();

export function bytes(data: string | Uint8Array): Uint8Array {
	return typeof data === "string" ? encoder.encode(data) : data;
}

export async function sha(data: string | Uint8Array): Promise<Sha256> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(data))));
}

async function readAll(value: ReadableStream<Uint8Array> | Uint8Array | string): Promise<Uint8Array> {
	if (typeof value === "string") return encoder.encode(value);
	if (value instanceof Uint8Array) return value;
	const chunks: Uint8Array[] = [];
	const reader = value.getReader();
	for (;;) {
		const { done, value: chunk } = await reader.read();
		if (done) break;
		chunks.push(chunk);
	}
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/** What R2 says for a put whose body does not hash to the SHA-256 given (10037). */
export const CHECKSUM_MISMATCH = "put: The SHA-256 checksum you specified did not match what we received. (10037)";

/**
 * An R2 bucket in memory. `faults.put` decides each put: `write` as R2 does, `lose` writes and then throws
 * (an answer lost), `refuse` throws without writing; `faults.delete` refuses deletes while true.
 */
export class MemoryBucket implements Bucket {
	readonly objects = new Map<string, Uint8Array>();
	readonly puts: string[] = [];
	readonly deletes: string[][] = [];
	faults: { put?: (key: string) => "write" | "lose" | "refuse"; delete?: boolean; get?: (key: string) => "read" | "refuse" } = {};

	async get(key: string): Promise<StoredObject | null> {
		if (this.faults.get?.(key) === "refuse") throw new Error("get: We encountered an internal error. Please try again. (10001)");
		const data = this.objects.get(key);
		if (!data) return null;
		return { body: new ReadableStream({ start: (controller) => (controller.enqueue(data.slice()), controller.close()) }), size: data.length };
	}

	async put(key: string, value: ReadableStream<Uint8Array> | Uint8Array | string, options: { sha256?: string } = {}): Promise<{ size: number } | null> {
		const fault = this.faults.put?.(key) ?? "write";
		if (fault === "refuse") throw new Error("put: Network connection lost.");
		const data = await readAll(value);
		if (options.sha256 !== undefined && (await sha(data)) !== options.sha256) throw new Error(CHECKSUM_MISMATCH);
		this.puts.push(key);
		this.objects.set(key, data);
		if (fault === "lose") throw new Error("put: Network connection lost.");
		return { size: data.length };
	}

	async delete(keys: string | string[]): Promise<void> {
		const list = typeof keys === "string" ? [keys] : keys;
		if (this.faults.delete) throw new Error("delete: We encountered an internal error. Please try again. (10001)");
		this.deletes.push(list);
		for (const key of list) this.objects.delete(key);
	}

	async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }> {
		const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
		const start = options.cursor ? Number(options.cursor) : 0;
		const limit = options.limit ?? 1000;
		const page = keys.slice(start, start + limit);
		const truncated = start + limit < keys.length;
		return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
	}

	/** Keys under a prefix, sorted. */
	keys(prefix = "blobs/"): string[] {
		return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
	}

	/** Bytes held under a prefix. */
	bytes(prefix = "blobs/"): number {
		return this.keys(prefix).reduce((sum, key) => sum + (this.objects.get(key) as Uint8Array).length, 0);
	}
}

/** The Workspace's `setConversationBytes`: absolute totals, growth refused past `limit`; `fail` throws. */
export class Counter implements ByteCounter {
	value: number | null = null;
	limit: number | null = null;
	fail = false;
	readonly calls: number[] = [];
	readonly revisions: number[] = [];

	async setConversationBytes(_conversationId: string, total: number, revision: number) {
		this.calls.push(total);
		this.revisions.push(revision);
		if (this.fail) throw new Error("The Workspace did not answer.");
		if (this.limit !== null && total > (this.value ?? 0) && total > this.limit) return { ok: false as const, limit: "workspace" as const };
		this.value = total;
		return { ok: true as const };
	}
}

export interface RunOptions {
	status?: "queued" | "provisioning" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
	baseVersionId?: VersionId | null;
	attempt?: number;
}

export interface FileSpec {
	path: string;
	data: string | Uint8Array;
	mode?: FileMode;
	mtime?: number;
}

/** A conversation's folder over node:sqlite, its clock at `now`. */
export class World {
	readonly db = openDatabase();
	readonly sql: Sql = sqliteSql(this.db);
	readonly bucket = new MemoryBucket();
	readonly counter = new Counter();
	readonly scheduled: number[] = [];
	readonly logs: string[] = [];
	readonly settings = { folderBytes: 268_435_456, folderEntries: 10_000, runUploadBytes: 1_073_741_824 };
	now = START;
	#random = 0;
	store: FolderStore;

	constructor(settings: Partial<World["settings"]> = {}) {
		Object.assign(this.settings, settings);
		migrate(this.sql, MIGRATIONS, START);
		this.sql.exec(
			"INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
			CONVERSATION,
			WORKSPACE,
			UPLOADER,
			"0199a000-0000-7000-8000-00000000f0e1",
			START,
			START,
		);
		this.store = this.open();
	}

	deps(): FolderDeps {
		return {
			sql: this.sql,
			bucket: this.bucket,
			counter: this.counter,
			workspaceId: WORKSPACE,
			conversationId: CONVERSATION,
			settings: this.settings,
			now: () => this.now,
			outside: async (change) => change(),
			isCurrent: (fence) => {
				const run = this.sql.exec<{ status: string; attempt: number; revoked: number; deadline: number | null }>(
					"SELECT status, attempt, revoked, deadline FROM runs WHERE id = ?",
					fence.runId,
				)[0];
				return (
					run !== undefined &&
					run.attempt === fence.attempt &&
					(run.status === "provisioning" || run.status === "running") &&
					run.revoked === 0 &&
					(run.deadline === null || run.deadline > this.now)
				);
			},
			conversation: () => {
				const row = this.sql.exec<{ folder_version_id: string | null; deleted_at: number | null }>("SELECT folder_version_id, deleted_at FROM conversation")[0];
				return row ? { folderVersionId: row.folder_version_id, deleted: row.deleted_at !== null } : null;
			},
			schedule: (at) => this.scheduled.push(at),
			log: (message) => this.logs.push(message),
			random: () => (++this.#random).toString(16).padStart(32, "0"),
		};
	}

	/** A new store over the same database: what an object that restarted would have. */
	open(): FolderStore {
		this.store = new FolderStore(this.deps());
		return this.store;
	}

	folder(): VersionId | null {
		return this.sql.exec<{ folder_version_id: string | null }>("SELECT folder_version_id FROM conversation")[0]?.folder_version_id ?? null;
	}

	setFolder(versionId: VersionId | null): void {
		this.sql.exec("UPDATE conversation SET folder_version_id = ?", versionId);
	}

	/** A run of this conversation, running by default, built on the folder unless told otherwise. */
	run(options: RunOptions = {}): RunId {
		const id = `0199a000-0000-7000-8000-${(this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runs")[0]?.n ?? 0).toString(16).padStart(12, "0")}`;
		this.sql.exec(
			"INSERT INTO runs (id, status, attempt, attempt_started_at, snapshot, base_version_id, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?)",
			id,
			options.status ?? "running",
			options.attempt ?? 1,
			this.now,
			options.baseVersionId === undefined ? this.folder() : options.baseVersionId,
			this.now,
		);
		return id;
	}

	runRow(runId: RunId) {
		return this.sql.exec<{
			status: string;
			attempt: number;
			base_version_id: string | null;
			checkpoint_version_id: string | null;
			result_version_id: string | null;
			folder_changes: string | null;
			folder_warnings: string | null;
			uploaded_bytes: number;
		}>("SELECT * FROM runs WHERE id = ?", runId)[0];
	}

	warnings(runId: RunId): Json {
		const text = this.runRow(runId)?.folder_warnings ?? null;
		return text === null ? null : parseJson(text);
	}

	/** The restart gate's new attempt: the attempt counted up, the status provisioning, the checkpoint kept. */
	restart(runId: RunId): number {
		const attempt = (this.runRow(runId)?.attempt ?? 0) + 1;
		this.sql.exec("UPDATE runs SET attempt = ?, status = 'running' WHERE id = ?", attempt, runId);
		return attempt;
	}

	/** conversation/store.ts `finish`: status, the folder published, the conversation's folder set, in one transaction. */
	finish(runId: RunId, status: "completed" | "failed" | "cancelled" | "timed_out" = "completed", options: { revoke?: boolean } = {}): void {
		this.sql.transaction(() => {
			if (options.revoke) this.sql.exec("UPDATE runs SET revoked = 1 WHERE id = ?", runId);
			const row = this.sql.exec<{ base_version_id: string | null; checkpoint_version_id: string | null }>(
				"UPDATE runs SET status = ? WHERE id = ? AND status IN ('queued', 'provisioning', 'running') RETURNING base_version_id, checkpoint_version_id",
				status,
				runId,
			)[0];
			if (!row) return;
			const published = this.store.publish(runId, { baseVersionId: row.base_version_id, checkpointVersionId: row.checkpoint_version_id });
			this.sql.exec(
				"UPDATE runs SET result_version_id = ?, folder_changes = ? WHERE id = ?",
				published.resultVersionId,
				published.changes === null ? null : JSON.stringify(published.changes),
				runId,
			);
			this.setFolder(published.resultVersionId);
		});
	}

	fence(runId: RunId): AttemptFence {
		return { runId, attempt: this.runRow(runId)?.attempt ?? 0 };
	}

	/** A checkpoint of these files, the Sandbox's side played by writing their bytes to the bucket. */
	async checkpoint(runId: RunId, files: FileSpec[], options: { dirs?: string[]; warnings?: FolderWarnings | null; parent?: VersionId | null; fence?: AttemptFence; upload?: Uploader } = {}) {
		const scan = await scanOf(files, options.dirs ?? []);
		// As the barrier does: the version the working copy was built on, unless the test names another.
		const row = this.runRow(runId);
		const parent = options.parent !== undefined ? options.parent : (row?.checkpoint_version_id ?? row?.base_version_id ?? null);
		const request: CheckpointScan = { parent, manifest: scan.manifest, sizes: scan.sizes };
		if (options.warnings !== undefined) request.warnings = options.warnings;
		const contents = new Map(files.map((file) => [file.path, bytes(file.data)]));
		const uploads: CheckpointUploadPlan[] = [];
		const upload: Uploader =
			options.upload ??
			(async (plan) => {
				uploads.push(plan);
				return sandboxUpload(this.bucket, contents)(plan);
			});
		const outcome = await this.store.checkpoint(options.fence ?? this.fence(runId), request, upload);
		return { outcome, uploads };
	}

	/** A stored blob of this conversation, as an earlier run would have left it. */
	async blob(data: string | Uint8Array, runId: RunId | null = null): Promise<{ sha256: Sha256; key: string }> {
		const content = bytes(data);
		const sha256 = await sha(content);
		const key = `blobs/${WORKSPACE}/${CONVERSATION}/${sha256}/${"f".repeat(24)}${(++this.#random).toString(16).padStart(8, "0")}`;
		this.bucket.objects.set(key, content);
		this.sql.exec("INSERT INTO folder_blobs (key, sha256, size, state, run_id, created_at) VALUES (?, ?, ?, 'stored', ?, ?)", key, sha256, content.length, runId, this.now);
		return { sha256, key };
	}

	/** An upload in the Workspace's part of the bucket, reserved for a start. */
	async upload(name: string, data: string | Uint8Array, mediaType = "text/plain"): Promise<ReservedUpload> {
		const content = bytes(data);
		const id = `0199a000-0000-7000-8000-${(++this.#random).toString(16).padStart(12, "0")}`;
		const key = `uploads/${WORKSPACE}/${UPLOADER}/${id}`;
		this.bucket.objects.set(key, content);
		return { id, name, size: content.length, mediaType, sha256: await sha(content), key };
	}

	blobRows() {
		return this.sql.exec<{ key: string; sha256: string; size: number; state: string; deletions: number; due_at: number | null; run_id: string | null }>(
			"SELECT key, sha256, size, state, deletions, due_at, run_id FROM folder_blobs ORDER BY created_at, key",
		);
	}

	versions() {
		return this.sql.exec<{ id: string; kind: string; parent_id: string | null; run_id: string | null; attempt: number | null; size: number; file_count: number }>(
			"SELECT id, kind, parent_id, run_id, attempt, size, file_count FROM folder_versions ORDER BY created_at, id",
		);
	}

	/** Runs the sweep with the clock at `at`. */
	async sweepAt(at: number) {
		this.now = at;
		return this.store.sweep();
	}

	/** The Workspace never counts less than the conversation's objects hold, whatever crashed. */
	countsEnough(): boolean {
		return (this.counter.value ?? 0) >= this.bucket.bytes(`blobs/${WORKSPACE}/${CONVERSATION}/`);
	}
}

export type Uploader = (plan: CheckpointUploadPlan) => Promise<CheckpointUploadResult>;

/** The Sandbox's checkpoint upload: each planned file's bytes into its key, with its hash, which the bucket checks. */
export function sandboxUpload(bucket: Bucket, contents: Map<string, Uint8Array>): Uploader {
	return async (plan) => {
		const stored: { path: string; sha256: Sha256; size: number; key: string | null }[] = [];
		for (const file of plan.files) {
			const data = contents.get(file.path);
			if (data === undefined) return { ok: false, reason: "changed", path: file.path, message: "A file changed while the folder was saved." };
			try {
				// Contents the conversation stores already are hashed, not written.
				if (file.key === null) {
					if ((await sha(data)) !== file.sha256) throw new Error(CHECK_MISMATCH);
				} else await bucket.put(file.key, data, { sha256: file.sha256 });
			} catch {
				return { ok: false, reason: "mismatch", path: file.path, message: "The contents do not match the hash." };
			}
			stored.push({ path: file.path, sha256: file.sha256, size: data.length, key: file.key });
		}
		return { ok: true, stored };
	};
}

/** What the container's scan reports for these files. */
export async function scanOf(files: FileSpec[], dirs: string[]): Promise<{ manifest: CheckpointScan["manifest"]; sizes: { [path: string]: number } }> {
	const sizes: { [path: string]: number } = {};
	const manifest: CheckpointScan["manifest"] = { files: [], dirs };
	for (const file of files) {
		const content = bytes(file.data);
		manifest.files.push({ path: file.path, sha256: await sha(content), mode: file.mode ?? 0o644, mtime: file.mtime ?? 0 });
		sizes[file.path] = content.length;
	}
	return { manifest, sizes };
}
