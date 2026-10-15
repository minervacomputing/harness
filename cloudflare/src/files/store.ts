// A conversation's folder in its Durable Object (ARCHITECTURE.md: Starting a run, Checkpoints, Files): versions with their lineage, the blobs they name by hash, what each run may read,
// the attachments a message adds at the start of its run, checkpoints, publishing at a run's end, the
// listing and downloads, and the sweep that deletes objects nothing names. The logic is over lib/sql.ts, so
// it runs on a Durable Object's SQLite and, in the unit tests, on node:sqlite; R2 and the Workspace are
// ports (objects.ts, `ByteCounter`).
//
// Blobs belong to the conversation (option A): `blobs/<ws>/<conv>/<sha256>/<random>`, one stored
// object per contents, deduplicated within the conversation only, under a key never reused, so deleting an
// object never races a later write of the same contents (files risk 24). Every object is recorded before
// it is written (a `loose` row, due an hour later) and claimed in the transaction that names it; the sweep
// deletes what was never claimed, and what a run left unnamed when it ended, twice, a day apart. The
// conversation's byte total, everything recorded and not yet deleted, is reported to the Workspace as an
// absolute number before any new object is written and after the sweep deleted some, one report at a time,
// so the Workspace never counts less than the bucket holds, whatever crashes in between.
//
// Every change someone acts on (a claim, a checkpoint, warnings, a charge) is made outside pi's open
// transactions (`outside`, conversation/store.ts), in one synchronous transaction with its checks.

import { utf8Strict } from "../lib/bytes.ts";
import { canonicalJson, hashLabel } from "../lib/canonical.ts";
import { parseJson } from "../lib/json.ts";
import { tokenHex, uuid7 } from "../lib/random.ts";
import { first, type Sql, type SqlValue } from "../lib/sql.ts";
import { splitParts, VALUE_PART } from "../lib/text.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult, HydratePlan } from "../sandbox/folder.ts";
import type { Attachment, Folder, FolderChanges } from "@minerva/contract";
import { type AttemptFence, type ConversationId, type EpochMs, type Outcome, type RunId, type Sha256, type VersionId, type WorkspaceId, refuse } from "../shared/rpc.ts";
import {
	BLOB_GONE,
	CONFLICT,
	type FolderLimit,
	LOOSE_GRACE_MS,
	NO_LONGER_AVAILABLE,
	NO_ROOM,
	QuotaExceeded,
	SECOND_DELETION_MS,
	STALE,
	folderBytes,
	overFolder,
	quotaRefusal,
	unreadableMessage,
} from "./limits.ts";
import {
	type FolderWarnings,
	InvalidManifest,
	type Manifest,
	type StoredEntries,
	type StoredWarnings,
	type WireManifest,
	entriesBytes,
	entryCountOf,
	filesOf,
	folderChanges,
	hashesOf,
	parseManifest,
	parseWarnings,
	rootNames,
	sameManifest,
	storedEntries,
} from "./manifest.ts";
import { numbered } from "./names.ts";
import { type Bucket, blobKey, conversationPrefix, deletePrefix } from "./objects.ts";
import { sha256HexSync } from "./sha256.ts";
import type { ReservedUpload } from "./uploads.ts";

/** A file a signed download link may name (ARCHITECTURE.md: Files, Downloads). */
export interface DownloadTarget {
	versionId: VersionId;
	path: string;
	/** `blobs/<ws>/<conv>/<sha256>/<random>`. */
	key: string;
	sha256: Sha256;
	size: number;
}

/**
 * `base`: a message's attachments added to the folder. `checkpoint`: a run's last saved state (at most one
 * per run, transient). `turn`: a checkpoint its run published. Contents are immutable; `kind` and `parent`
 * may change when a checkpoint is published.
 */
export type VersionKind = "base" | "checkpoint" | "turn";

/** A conversation's folder as a new run sees it: its current version and how full it is. */
export interface FolderUsage {
	versionId: VersionId | null;
	/** In pages, as the store counts it. */
	bytes: number;
	entries: number;
	/** First path segments of every file and directory at the root: what attachment names are numbered against. */
	rootNames: string[];
}

/**
 * What a checkpoint takes (ARCHITECTURE.md: Checkpoints): the scan's report as the container
 * made it, untrusted (ScanResult's `manifest`, `sizes` and `warnings`), and the version the working copy
 * was built on, which must still be the run's (its last checkpoint, else its base version).
 */
export interface CheckpointScan {
	/**
	 * The version the working copy was built on: the one the attempt hydrated (`HydratePlan.versionId`), then
	 * each accepted checkpoint's `versionId`. Anything else is `conflict`, so a scan taken before
	 * a newer checkpoint can never replace it.
	 */
	parent: VersionId | null;
	manifest: WireManifest;
	/** Bytes per path, as the scan measured them; only the files to upload are sized from it. */
	sizes: { [path: string]: number };
	/** Null or omitted: the run's warnings stay as they were; otherwise they replace them, also when nothing else changed. */
	warnings?: FolderWarnings | null;
}

/** `CheckpointRefused`'s codes; `conflict` is the version the working copy was built on having moved. */
export type CheckpointRefusalCode = "stale" | "conflict" | "invalid_manifest" | "unknown_blob" | "quota";

/**
 * A checkpoint's outcome. `versionId` is the run's version afterwards: the current one for an identical
 * manifest (null for a run that never had files). A `quota` refusal names its limit and fails the turn with
 * `folder_limit`; any other refusal, or a failed upload, ends the attempt.
 */
export type CheckpointOutcome =
	| { ok: true; versionId: VersionId | null; uploaded: number }
	| { ok: false; code: CheckpointRefusalCode; message: string; limit?: FolderLimit }
	| { ok: false; code: "upload"; reason: "changed" | "mismatch" | "failed"; path: string; message: string };

/** The keys a checkpoint's plan writes: not those of contents only hashed. */
function keysOf(plan: CheckpointUploadPlan): string[] {
	return plan.files.flatMap((file) => (file.key === null ? [] : [file.key]));
}

/** The Workspace's byte counter (workspace/core.ts `setConversationBytes`). */
export interface ByteCounter {
	setConversationBytes(conversationId: ConversationId, total: number, revision: number): Promise<{ ok: true } | { ok: false; limit: Extract<FolderLimit, "workspace"> }>;
}

export interface FolderSettings {
	folderBytes: number;
	folderEntries: number;
	runUploadBytes: number;
}

export interface FolderDeps {
	sql: Sql;
	bucket: Bucket;
	counter: ByteCounter;
	workspaceId: WorkspaceId;
	conversationId: ConversationId;
	settings: FolderSettings;
	now(): EpochMs;
	/** Runs `change` once no asynchronous transaction of pi's is open (conversation/store.ts `outside`). */
	outside<T>(change: () => T): Promise<T>;
	/** The run's checks (conversation/store.ts `isCurrent`): acting, not revoked, deadline not passed, the attempt equal. */
	isCurrent(fence: AttemptFence): boolean;
	/** The conversation's folder now, and whether it was deleted; null before it is initialized. */
	conversation(): { folderVersionId: VersionId | null; deleted: boolean } | null;
	/** The sweep should run at `at` (a Lifecycle job of the Conversation); an earlier one stays. */
	schedule(at: EpochMs): void;
	log(message: string, error?: unknown): void;
	/** The random part of a blob's key (32 hex digits); replaced in tests. */
	random?(): string;
}

/** A parent that no longer exists; its message is empty. */
export class StaleParent extends Error {
	constructor() {
		super("");
		this.name = "StaleParent";
	}
}

/** A manifest names contents the store does not have, sorted. */
export class UnknownBlob extends Error {
	readonly hashes: Sha256[];

	constructor(hashes: Sha256[]) {
		super(`${hashes.length} blob(s) are not in this workspace's store.`);
		this.name = "UnknownBlob";
		this.hashes = hashes;
	}
}

export interface VersionRow {
	id: string;
	parent_id: string | null;
	kind: VersionKind;
	run_id: string | null;
	attempt: number | null;
	size: number;
	file_count: number;
	entry_count: number;
	digest: string;
	parts: number;
	created_at: number;
	[key: string]: SqlValue;
}

export interface BlobRow {
	key: string;
	sha256: string;
	size: number;
	state: "loose" | "stored" | "doomed";
	run_id: string | null;
	created_at: number;
	due_at: number | null;
	deletions: number;
	attempts: number;
	[key: string]: SqlValue;
}

interface RunFolder {
	status: string;
	attempt: number;
	base_version_id: string | null;
	checkpoint_version_id: string | null;
	uploaded_bytes: number;
	[key: string]: SqlValue;
}

/** What `prepareAttachments` leaves for `commitAttachments`. */
export interface AttachmentPlan {
	parentId: VersionId | null;
	entries: StoredEntries;
	attachments: Attachment[];
	/** Keys claimed when the start is stored: one copy per contents the conversation did not hold. */
	copies: { sha256: Sha256; key: string }[];
	/** Contents the conversation already held, which the base version names as they are. */
	reused: Sha256[];
}

/** Objects deleted at once by the sweep (R2's limit per delete). */
const DELETE_BATCH = 1000;
/** Uploads and copies that stream at once ("Transfers per run"). */
const TRANSFERS = 4;
const RETRY_MS = 30_000;
/** Parsed versions kept in memory, by the length of their stored text: a version at the limits is about 1.5 MB of it. */
const CACHED_CHARS = 8_000_000;
/** Reports in a row while the total keeps moving under them; the sweep reports whatever is left. */
const REPORTS = 4;

/** Thrown inside a transaction to roll it back with an answer. */
class Refused<T> extends Error {
	readonly answer: T;

	constructor(answer: T) {
		super("refused");
		this.answer = answer;
	}
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** R2's refusal of a put whose body does not hash to the SHA-256 it was given (10037). */
export function isChecksumMismatch(error: unknown): boolean {
	return /\(10037\)|SHA-256 checksum/.test(String(error));
}

export class FolderStore {
	readonly #deps: FolderDeps;
	readonly #sql: Sql;
	/** Parsed entries by version id: versions never change, so a copy is good until the version is deleted. */
	readonly #entries = new Map<VersionId, { entries: StoredEntries; chars: number }>();
	#cachedChars = 0;
	/** The last byte report in flight: reports go one at a time, so a smaller total never overtakes a larger one. */
	#reporting: Promise<unknown> = Promise.resolve();
	/**
	 * Keys handed to a writer by a call of this instance that has not finished: never reused by another call,
	 * so no call's clean-up can delete what another is writing. A dead instance's writes may still land; they
	 * hold the same bytes (R2 checks the hash), and a key they land in after its deletion is deleted again.
	 */
	readonly #writing = new Set<string>();

	constructor(deps: FolderDeps) {
		this.#deps = deps;
		this.#sql = deps.sql;
	}

	// Versions.

	version(id: VersionId): VersionRow | null {
		return first<VersionRow>(this.#sql, "SELECT * FROM folder_versions WHERE id = ?", id);
	}

	/** A version's stored entries, sorted by path. */
	entries(id: VersionId): StoredEntries {
		const cached = this.#entries.get(id);
		if (cached) return cached.entries;
		const parts = this.#sql.exec<{ text: string }>("SELECT text FROM folder_version_parts WHERE version_id = ? ORDER BY part", id);
		if (parts.length === 0) throw new Error(`The folder version ${id} has no entries.`);
		const text = parts.map((part) => part.text).join("");
		const entries = parseJson(text) as unknown as StoredEntries;
		this.#remember(id, entries, text.length);
		return entries;
	}

	#remember(id: VersionId, entries: StoredEntries, chars: number): void {
		this.#forget(id);
		// The newest is always kept; older ones make room for it.
		for (const [old, cached] of this.#entries) {
			if (this.#cachedChars + chars <= CACHED_CHARS) break;
			this.#entries.delete(old);
			this.#cachedChars -= cached.chars;
		}
		this.#entries.set(id, { entries, chars });
		this.#cachedChars += chars;
	}

	#forget(id: VersionId): void {
		const cached = this.#entries.get(id);
		if (!cached) return;
		this.#entries.delete(id);
		this.#cachedChars -= cached.chars;
	}

	/**
	 * Stores a version: its entries as canonical JSON (lib/canonical.ts), the digest's input after its label
	 * (manifest.ts `digestOf`), in parts under the 2 MB a value or a row may have (a manifest at the limits
	 * is about 1.5 MB), with its size, counts and digest. Inside the caller's transaction.
	 */
	#insertVersion(input: { kind: VersionKind; parentId: VersionId | null; runId: RunId | null; attempt: number | null; entries: StoredEntries }): VersionRow {
		const now = this.#deps.now();
		const id = uuid7(now);
		const text = canonicalJson(input.entries, { identity: true });
		const parts = splitParts(text, VALUE_PART);
		const row: VersionRow = {
			id,
			parent_id: input.parentId,
			kind: input.kind,
			run_id: input.runId,
			attempt: input.attempt,
			size: entriesBytes(input.entries),
			file_count: Object.keys(input.entries.files).length,
			entry_count: entryCountOf(input.entries),
			digest: sha256HexSync(utf8Strict(hashLabel("folder-version") + text)),
			parts: parts.length,
			created_at: now,
		};
		this.#sql.exec(
			"INSERT INTO folder_versions (id, parent_id, kind, run_id, attempt, size, file_count, entry_count, digest, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			row.id,
			row.parent_id,
			row.kind,
			row.run_id,
			row.attempt,
			row.size,
			row.file_count,
			row.entry_count,
			row.digest,
			row.parts,
			row.created_at,
		);
		parts.forEach((part, index) => this.#sql.exec("INSERT INTO folder_version_parts (version_id, part, text) VALUES (?, ?, ?)", id, index, part));
		this.#remember(id, input.entries, text.length);
		return row;
	}

	#deleteVersion(id: VersionId): void {
		this.#sql.exec("DELETE FROM folder_version_parts WHERE version_id = ?", id);
		this.#sql.exec("DELETE FROM folder_versions WHERE id = ?", id);
		this.#forget(id);
	}

	/** The stored blobs among `hashes`, by hash. */
	#stored(hashes: Iterable<Sha256>): Map<Sha256, BlobRow> {
		const wanted = [...new Set(hashes)];
		const found = new Map<Sha256, BlobRow>();
		for (let at = 0; at < wanted.length; at += 500) {
			const rows = this.#sql.exec<BlobRow>(
				"SELECT * FROM folder_blobs WHERE state = 'stored' AND sha256 IN (SELECT value FROM json_each(?))",
				json(wanted.slice(at, at + 500)),
			);
			for (const row of rows) found.set(row.sha256, row);
		}
		return found;
	}

	/**
	 * `record_version`: the sizes of hashes the parent has come from the parent, the others from the
	 * stored blobs (UnknownBlob, sorted, for any missing); the size limit is checked here, the entry limit by
	 * the manifest's parse. Inside the caller's transaction. Throws TypeError for a kind that is none or a run
	 * that is not this conversation's, StaleParent, UnknownBlob, QuotaExceeded("folder_bytes").
	 */
	recordVersion(kind: VersionKind, manifest: Manifest, options: { parentId?: VersionId | null; runId?: RunId | null; attempt?: number | null } = {}): VersionRow {
		if (kind !== "base" && kind !== "checkpoint" && kind !== "turn") throw new TypeError(`${String(kind)} is not a version kind.`);
		const runId = options.runId ?? null;
		if (runId !== null && first(this.#sql, "SELECT id FROM runs WHERE id = ?", runId) === null) throw new TypeError("The run belongs to a different conversation.");
		const hashes = hashesOf(manifest);
		const sizes = new Map<Sha256, number>();
		const parentId = options.parentId ?? null;
		if (parentId !== null) {
			if (this.version(parentId) === null) throw new StaleParent();
			for (const entry of Object.values(this.entries(parentId).files)) if (hashes.has(entry.sha256)) sizes.set(entry.sha256, entry.size);
		}
		const fresh = [...hashes].filter((hash) => !sizes.has(hash)).sort();
		if (fresh.length) {
			const found = this.#stored(fresh);
			const missing = fresh.filter((hash) => !found.has(hash));
			if (missing.length) throw new UnknownBlob(missing);
			for (const [hash, row] of found) sizes.set(hash, row.size);
		}
		const size = folderBytes([...manifest.files.values()].map((entry) => sizes.get(entry.sha256) as number));
		if (size > this.#deps.settings.folderBytes) throw new QuotaExceeded("folder_bytes");
		return this.#insertVersion({ kind, parentId, runId, attempt: options.attempt ?? null, entries: storedEntries(manifest, sizes) });
	}

	/** The folder a new run would start from, for `beginRun`'s limit checks. */
	usage(): FolderUsage {
		const versionId = this.#deps.conversation()?.folderVersionId ?? null;
		const row = versionId === null ? null : this.version(versionId);
		if (row === null) return { versionId: null, bytes: 0, entries: 0, rootNames: [] };
		return { versionId, bytes: row.size, entries: row.entry_count, rootNames: [...rootNames(this.entries(row.id))].sort() };
	}

	// Blobs and the byte total.

	#random(): string {
		return this.#deps.random ? this.#deps.random() : tokenHex(16);
	}

	/** A loose row for a new key, due for deletion an hour from now unless it is claimed. Inside a transaction. */
	#recordLoose(sha256: Sha256, size: number, runId: RunId | null): string {
		const now = this.#deps.now();
		const key = blobKey(this.#deps.workspaceId, this.#deps.conversationId, sha256, this.#random());
		this.#sql.exec(
			"INSERT INTO folder_blobs (key, sha256, size, state, run_id, created_at, due_at) VALUES (?, ?, ?, 'loose', ?, ?, ?)",
			key,
			sha256,
			size,
			runId,
			now,
			now + LOOSE_GRACE_MS,
		);
		this.#deps.schedule(now + LOOSE_GRACE_MS);
		return key;
	}

	/**
	 * The run's loose keys by the contents they are for: recorded, never claimed, not yet taken by the sweep,
	 * and not being written by another call of this instance.
	 */
	#looseOf(runId: RunId): Map<Sha256, { key: string; size: number }> {
		const rows = this.#sql.exec<{ key: string; sha256: string; size: number }>("SELECT key, sha256, size FROM folder_blobs WHERE run_id = ? AND state = 'loose' ORDER BY key", runId);
		return new Map(rows.filter((row) => !this.#writing.has(row.key)).map((row) => [row.sha256, { key: row.key, size: row.size }]));
	}

	/** A key for these contents: one the run recorded earlier and never claimed, else a new one (`fresh`). Inside a transaction. */
	#keyFor(sha256: Sha256, size: number, runId: RunId, earlier: Map<Sha256, { key: string; size: number }>, fresh: string[]): string {
		const again = earlier.get(sha256);
		if (again !== undefined && again.size === size) return this.#reuse(again.key);
		const key = this.#recordLoose(sha256, size, runId);
		fresh.push(key);
		return key;
	}

	/** A loose key written again: due an hour from now. Inside a transaction. */
	#reuse(key: string): string {
		const now = this.#deps.now();
		this.#sql.exec("UPDATE folder_blobs SET due_at = ? WHERE key = ? AND state = 'loose'", now + LOOSE_GRACE_MS, key);
		this.#deps.schedule(now + LOOSE_GRACE_MS);
		return key;
	}

	/**
	 * Claims a loose key for the contents it holds: stored, unless the conversation stored the same contents
	 * meanwhile, which makes it unneeded (doomed now). False when it is no longer loose: the sweep took it.
	 */
	#claim(key: string, runId: RunId | null): boolean {
		const row = first<BlobRow>(this.#sql, "SELECT * FROM folder_blobs WHERE key = ?", key);
		if (row === null || row.state !== "loose") return false;
		if (this.#stored([row.sha256]).has(row.sha256)) {
			this.#doom([key]);
			return true;
		}
		this.#sql.exec("UPDATE folder_blobs SET state = 'stored', due_at = NULL, run_id = ? WHERE key = ?", runId, key);
		return true;
	}

	/**
	 * Marks the keys nothing claimed for deletion now (again, for one the sweep deleted already, as a write may
	 * have landed since), never one a call claimed meanwhile.
	 */
	#doomUnclaimed(keys: readonly string[]): void {
		const unclaimed = keys.filter((key) => {
			const state = first<{ state: string }>(this.#sql, "SELECT state FROM folder_blobs WHERE key = ?", key)?.state;
			return state !== undefined && state !== "stored";
		});
		this.#doom(unclaimed);
	}

	/** Marks objects for deletion now (a stored, loose or doomed one alike). */
	#doom(keys: readonly string[]): void {
		if (keys.length === 0) return;
		const now = this.#deps.now();
		for (const key of keys) {
			this.#sql.exec("UPDATE folder_blobs SET state = 'doomed', due_at = ?, deletions = 0, attempts = 0 WHERE key = ? AND (state <> 'doomed' OR deletions > 0)", now, key);
		}
		this.#deps.schedule(now);
	}

	/**
	 * Forgets loose keys this call recorded and no writer was ever given, so no object can exist under them
	 * (a checkpoint or a start refused before its uploads): they stop counting at once. Never a reused key,
	 * which an earlier try may have written. The sweep reports the smaller total.
	 */
	#discard(keys: readonly string[]): void {
		if (keys.length === 0) return;
		for (const key of keys) this.#sql.exec("DELETE FROM folder_blobs WHERE key = ? AND state = 'loose'", key);
		if (this.reported() !== this.total()) this.#deps.schedule(this.#deps.now());
	}

	/**
	 * Everything recorded and not yet deleted: stored, loose, and doomed until its first deletion. A write
	 * that lands more than an hour after its key was recorded (past the sweep's first deletion) goes
	 * uncounted until the second deletion a day later; every writer gives up well within the hour.
	 */
	total(): number {
		const row = first<{ n: number }>(
			this.#sql,
			"SELECT coalesce(sum(size), 0) AS n FROM folder_blobs WHERE state IN ('stored', 'loose') OR (state = 'doomed' AND deletions = 0)",
		);
		return row?.n ?? 0;
	}

	/** The total the Workspace last accepted, or null before the first report. */
	reported(): number | null {
		return first<{ reported: number }>(this.#sql, "SELECT reported FROM folder_counter WHERE singleton = 1")?.reported ?? null;
	}

	/**
	 * Tells the Workspace the total now; false when it refuses the growth (the workspace's quota). Absolute,
	 * so a repeat is harmless, and one at a time, so a report of a smaller total never lands after a larger
	 * one that was sent later. Whatever changed while it was on its way is reported straight after. Across
	 * instances, each report names a revision one above the last one sent, written before it leaves (the
	 * output gate holds it until then): the Workspace ignores a report no newer than one it has seen, so one
	 * a reset instance had already sent cannot land after the next instance's and undo it.
	 */
	#report(): Promise<boolean> {
		const report = this.#reporting.then(
			() => this.#reportNow(),
			() => this.#reportNow(),
		);
		this.#reporting = report.catch(() => {});
		return report;
	}

	async #reportNow(): Promise<boolean> {
		for (let round = 0; round < REPORTS; round++) {
			const { total, revision } = await this.#deps.outside(() =>
				this.#sql.transaction(() => {
					const row = first<{ revision: number }>(
						this.#sql,
						"INSERT INTO folder_report (singleton, revision) VALUES (1, 1) ON CONFLICT (singleton) DO UPDATE SET revision = revision + 1 RETURNING revision",
					) as { revision: number };
					return { total: this.total(), revision: row.revision };
				}),
			);
			const answer = await this.#deps.counter.setConversationBytes(this.#deps.conversationId, total, revision);
			if (!answer.ok) return false;
			const settled = await this.#deps.outside(() => {
				this.#sql.exec(
					"INSERT INTO folder_counter (singleton, reported) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET reported = excluded.reported",
					total,
				);
				return this.total() <= total;
			});
			if (settled) return true;
		}
		// Still growing: what the last report missed is the sweep's to report.
		this.#deps.schedule(this.#deps.now());
		return true;
	}

	/** The hashes a run may read and name: its base version's, its last checkpoint's and its uploads'. */
	readable(runId: RunId): Set<Sha256> {
		const run = this.#run(runId);
		const hashes = new Set<Sha256>();
		if (run === null) return hashes;
		for (const id of [run.base_version_id, run.checkpoint_version_id]) {
			if (id !== null && this.version(id) !== null) for (const hash of hashesOf(this.entries(id))) hashes.add(hash);
		}
		for (const row of this.#sql.exec<{ sha256: string }>("SELECT sha256 FROM folder_grants WHERE run_id = ?", runId)) hashes.add(row.sha256);
		return hashes;
	}

	#run(runId: RunId): RunFolder | null {
		return first<RunFolder>(this.#sql, "SELECT status, attempt, base_version_id, checkpoint_version_id, uploaded_bytes FROM runs WHERE id = ?", runId);
	}

	// Attachments (ARCHITECTURE.md: Starting a run).

	/**
	 * Before the start's transaction: the base version the message's uploads make, at the folder's root with
	 * numbered names, checked against the folder's limits before anything is copied; then a copy of each
	 * upload whose contents the conversation does not hold, recorded as loose first and made with `get` and a
	 * `put` R2 checks against the upload's SHA-256. A failed get or put is made once more. A refusal leaves
	 * nothing the sweep does not delete; an error (R2 unreachable twice) is thrown, and the start is sent
	 * again by its watch, which copies into the same keys.
	 */
	async prepareAttachments(runId: RunId, uploads: ReservedUpload[]): Promise<Outcome<AttachmentPlan | null>> {
		if (uploads.length === 0) return { ok: true, value: null };
		const conversation = this.#deps.conversation();
		if (conversation === null || conversation.deleted) return refuse("NOT_FOUND", "Not found.");
		const parentId = conversation.folderVersionId;
		const parent = parentId === null ? null : this.entries(parentId);
		const files: { path: string; sha256: Sha256; mode: number; mtime: number }[] = [];
		if (parent) for (const [path, entry] of filesOf(parent)) files.push({ path, sha256: entry.sha256, mode: entry.mode, mtime: entry.mtime });
		// The first segment of every root entry, directories included, so a folder's name blocks a file's.
		const taken = rootNames(parent);
		const mtime = this.#deps.now();
		const attachments: Attachment[] = [];
		for (const upload of uploads) {
			const path = numbered(upload.name, taken);
			taken.add(path);
			files.push({ path, sha256: upload.sha256, mode: 0o644, mtime });
			attachments.push({ path, size: upload.size, mediaType: upload.mediaType });
		}
		const { folderBytes: limitBytes, folderEntries } = this.#deps.settings;
		let manifest: Manifest;
		try {
			manifest = parseManifest({ files, dirs: parent ? [...parent.dirs] : [] }, folderEntries);
		} catch (error) {
			if (error instanceof QuotaExceeded) return refuse("FOLDER_FULL", overFolder("folder_entries", folderEntries, limitBytes));
			if (error instanceof InvalidManifest) return refuse("INVALID_ATTACHMENTS", `The files could not be attached: ${error.message}`);
			throw error;
		}
		const sizes = new Map<Sha256, number>();
		if (parent) for (const entry of Object.values(parent.files)) sizes.set(entry.sha256, entry.size);
		for (const upload of uploads) if (!sizes.has(upload.sha256)) sizes.set(upload.sha256, upload.size);
		if (folderBytes([...manifest.files.values()].map((entry) => sizes.get(entry.sha256) as number)) > limitBytes) {
			return refuse("FOLDER_FULL", overFolder("folder_bytes", folderEntries, limitBytes));
		}
		const entries = storedEntries(manifest, sizes);

		// One copy per contents the conversation does not hold, recorded before it is written. A start sent
		// again (its object restarted after a copy, say) copies into the keys it recorded the first time, so
		// it is not counted twice: R2 checks the hash, so a key written twice holds the same bytes.
		const planned = await this.#deps.outside(() =>
			this.#sql.transaction(() => {
				const held = this.#stored(uploads.map((upload) => upload.sha256));
				const earlier = this.#looseOf(runId);
				const copies: { sha256: Sha256; key: string; upload: ReservedUpload }[] = [];
				const fresh: string[] = [];
				const reused = new Set<Sha256>();
				for (const upload of uploads) {
					if (held.has(upload.sha256)) reused.add(upload.sha256);
					else if (!copies.some((copy) => copy.sha256 === upload.sha256)) {
						copies.push({ sha256: upload.sha256, key: this.#keyFor(upload.sha256, upload.size, runId, earlier, fresh), upload });
					}
				}
				for (const copy of copies) this.#writing.add(copy.key);
				return { copies, fresh, reused: [...reused] };
			}),
		);
		// Every key of this start: none is claimed unless the start is stored. A refused or failed start deletes
		// the keys it recorded now; keys reused from an earlier try stay loose for the sweep's hour, as that
		// try's write may still land.
		const keys = planned.copies.map((copy) => copy.key);
		const abandon = () => this.#deps.outside(() => this.#sql.transaction(() => this.#doomUnclaimed(planned.fresh)));
		try {
			if (planned.copies.length && !(await this.#report())) {
				// Refused before any copy was made by this try.
				await this.#deps.outside(() => this.#sql.transaction(() => this.#discard(planned.fresh)));
				return refuse("WORKSPACE_FULL", NO_ROOM);
			}
			let gone = false;
			await eachLimited(planned.copies, TRANSFERS, async (copy) => {
				if (gone) return;
				if ((await this.#copy(copy)) === "gone") gone = true;
			});
			if (gone) {
				await abandon();
				return refuse("ATTACHMENT_UNAVAILABLE", NO_LONGER_AVAILABLE);
			}
		} catch (error) {
			// A copy that failed may still have been written (its answer lost): none is claimed, so all go.
			await abandon().catch((reason: unknown) => this.#deps.log("copies were not marked for deletion", reason));
			throw error;
		} finally {
			for (const key of keys) this.#writing.delete(key);
		}
		return {
			ok: true,
			value: { parentId, entries, attachments, copies: planned.copies.map(({ sha256, key }) => ({ sha256, key })), reused: planned.reused },
		};
	}

	/**
	 * One upload's copy into the conversation's blobs, under its key: `copied`, or `gone` when the upload's
	 * object is missing or does not hold the contents recorded for it. A failed get or put is tried once more
	 * under the same key: the key is loose, so nothing deletes it meanwhile, and a put whose answer was lost
	 * wrote the same bytes.
	 */
	async #copy(copy: { sha256: Sha256; key: string; upload: ReservedUpload }): Promise<"copied" | "gone"> {
		for (let attempt = 0; ; attempt++) {
			try {
				const source = await this.#deps.bucket.get(copy.upload.key);
				if (source === null) return "gone";
				await this.#deps.bucket.put(copy.key, source.body, { sha256: copy.sha256 });
				return "copied";
			} catch (error) {
				if (isChecksumMismatch(error)) return "gone";
				if (attempt > 0) throw error;
				this.#deps.log("an attachment's copy is made again", error);
			}
		}
	}

	/**
	 * Inside the start's transaction: the base version (parent the folder, run the new run), its copies
	 * claimed. A folder that moved since, or a copy the sweep took, throws: the start is refused (503) and
	 * released rather than stored with a folder it did not check.
	 */
	commitAttachments(runId: RunId, plan: AttachmentPlan | null): { baseVersionId: VersionId | null; attachments: Attachment[] } {
		const current = this.#deps.conversation()?.folderVersionId ?? null;
		if (plan === null) return { baseVersionId: current, attachments: [] };
		if (current !== plan.parentId) throw new Error("The folder changed while its attachments were copied.");
		return this.#sql.transaction(() => {
			for (const copy of plan.copies) if (!this.#claim(copy.key, runId)) throw new Error("An attached file's copy was deleted before the start was stored.");
			const missing = plan.reused.filter((hash) => !this.#stored([hash]).has(hash));
			if (missing.length) throw new Error("An attached file's contents are no longer in the store.");
			const row = this.#insertVersion({ kind: "base", parentId: plan.parentId, runId, attempt: null, entries: plan.entries });
			return { baseVersionId: row.id, attachments: plan.attachments };
		});
	}

	// Checkpoints (ARCHITECTURE.md: Checkpoints).

	/**
	 * Records the run's folder as the scan reports it, on top of its last checkpoint (or its base version):
	 * validated in this order (stale, conflict, the manifest, the warnings, identical), then the files whose
	 * contents the run may not read yet are uploaded by `upload` (the Sandbox streams each into R2 under a key
	 * recorded here first, with its hash, which R2 checks) after the folder's size, the run's upload budget
	 * and the workspace's quota allow them, and the checkpoint is recorded with their claims and grants in one
	 * transaction. Warnings replace the run's even when nothing else changed; invalid ones refuse the whole
	 * checkpoint. A run keeps only its last checkpoint.
	 *
	 * Knowing a hash is not enough: only a file whose contents the run may read is named without its
	 * bytes; every other one is read from the container and checked against its hash on the way into R2. The
	 * bytes about to be received count against the run's budget whether or not they are stored.
	 */
	async checkpoint(fence: AttemptFence, scan: CheckpointScan, upload: (plan: CheckpointUploadPlan) => Promise<CheckpointUploadResult>): Promise<CheckpointOutcome> {
		type Planned =
			| { kind: "done"; outcome: CheckpointOutcome }
			| { kind: "upload"; current: VersionId | null; manifest: Manifest; warnings: StoredWarnings | null; plan: CheckpointUploadPlan; fresh: string[]; bytes: number };
		const { folderBytes: limitBytes, folderEntries, runUploadBytes } = this.#deps.settings;
		const planned = await this.#deps.outside((): Planned => {
			const refused = (code: CheckpointRefusalCode, message: string, limit?: FolderLimit): Planned => ({
				kind: "done",
				outcome: limit === undefined ? { ok: false, code, message } : { ok: false, code, message, limit },
			});
			if (!this.#deps.isCurrent(fence)) return refused("stale", STALE);
			const run = this.#run(fence.runId) as RunFolder;
			const current = run.checkpoint_version_id ?? run.base_version_id;
			if (scan.parent !== current) return refused("conflict", CONFLICT);
			let manifest: Manifest;
			let warnings: StoredWarnings | null = null;
			try {
				manifest = parseManifest(scan.manifest, folderEntries);
				if (scan.warnings !== undefined && scan.warnings !== null) warnings = parseWarnings(scan.warnings);
			} catch (error) {
				if (error instanceof InvalidManifest) return refused("invalid_manifest", error.message);
				if (error instanceof QuotaExceeded) return refused("quota", quotaRefusal(error.limit), error.limit);
				throw error;
			}
			if (sameManifest(current === null ? null : this.entries(current), manifest)) {
				// Even for an identical manifest: what was left out can change without what was kept changing.
				if (warnings !== null) this.#sql.exec("UPDATE runs SET folder_warnings = ? WHERE id = ?", json(warnings), fence.runId);
				return { kind: "done", outcome: { ok: true, versionId: current, uploaded: 0 } };
			}
			// Contents the run may read need no upload; every other file's bytes come from the container and
			// prove it has them. One upload per contents, from its first path. Contents the
			// conversation stores already are only hashed: nothing is written, recorded or counted for them.
			const readable = this.readable(fence.runId);
			const known = this.#stored([...hashesOf(manifest)].filter((hash) => readable.has(hash)));
			const claimed = isSizes(scan.sizes) ? scan.sizes : null;
			const toUpload = new Map<Sha256, { path: string; size: number }>();
			const sizes: number[] = [];
			for (const path of [...manifest.files.keys()].sort()) {
				const entry = manifest.files.get(path) as { sha256: Sha256 };
				if (readable.has(entry.sha256)) {
					const size = known.get(entry.sha256)?.size;
					if (size === undefined) return refused("unknown_blob", BLOB_GONE);
					sizes.push(size);
					continue;
				}
				const size = claimed !== null && Object.hasOwn(claimed, path) ? claimed[path] : undefined;
				if (size === undefined || !Number.isSafeInteger(size) || size < 0) return refused("invalid_manifest", "A file's size is missing or invalid.");
				const already = toUpload.get(entry.sha256);
				if (already && already.size !== size) return refused("invalid_manifest", "Files with the same contents have different sizes.");
				if (!already) toUpload.set(entry.sha256, { path, size });
				sizes.push(size);
			}
			if (folderBytes(sizes) > limitBytes) return refused("quota", quotaRefusal("folder_bytes"), "folder_bytes");
			let bytes = 0;
			for (const { size } of toUpload.values()) bytes += size;
			if (run.uploaded_bytes + bytes > runUploadBytes) return refused("quota", quotaRefusal("run_uploads"), "run_uploads");
			// Keys an earlier checkpoint of the run recorded and never claimed (its upload threw, or its object
			// restarted) are written again rather than counted twice: R2 checks the hash, so the bytes are the same.
			const fresh: string[] = [];
			const held = this.#stored(toUpload.keys());
			const files = this.#sql.transaction(() => {
				const earlier = this.#looseOf(fence.runId);
				return [...toUpload].map(([sha256, { path, size }]) => ({ path, sha256, size, key: held.has(sha256) ? null : this.#keyFor(sha256, size, fence.runId, earlier, fresh) }));
			});
			for (const file of files) if (file.key !== null) this.#writing.add(file.key);
			return { kind: "upload", current, manifest, warnings, plan: { files }, fresh, bytes };
		});
		if (planned.kind === "done") return planned.outcome;
		const keys = keysOf(planned.plan);
		try {
			return await this.#upload(fence, planned, upload);
		} finally {
			for (const key of keys) this.#writing.delete(key);
		}
	}

	/** A checkpoint's uploads and its record, once it is planned; its keys are this call's until it returns. */
	async #upload(
		fence: AttemptFence,
		planned: { current: VersionId | null; manifest: Manifest; warnings: StoredWarnings | null; plan: CheckpointUploadPlan; fresh: string[]; bytes: number },
		upload: (plan: CheckpointUploadPlan) => Promise<CheckpointUploadResult>,
	): Promise<CheckpointOutcome> {
		const { runUploadBytes } = this.#deps.settings;
		const { plan } = planned;
		const keys = keysOf(plan);
		// The keys this checkpoint recorded are deleted now when it fails; keys reused from an earlier one stay
		// loose for the sweep's hour, as that one's write (the Sandbox writes R2 itself) may still land.
		const abandon = () => this.#deps.outside(() => this.#sql.transaction(() => this.#doomUnclaimed(planned.fresh)));

		if (plan.files.length) {
			// Contents only hashed add nothing to the total.
			if (keys.length && !(await this.#report())) {
				await this.#deps.outside(() => this.#sql.transaction(() => this.#discard(planned.fresh)));
				return { ok: false, code: "quota", message: quotaRefusal("workspace"), limit: "workspace" };
			}
			// The bytes about to be received count against the run's budget, whether or not they are stored.
			// Checked again with the charge (`charge_run_upload`): another checkpoint may have charged meanwhile.
			const charged = await this.#deps.outside(() =>
				this.#sql.transaction((): "charged" | "stale" | "over" => {
					const answer = !this.#deps.isCurrent(fence)
						? "stale"
						: this.#sql.exec("UPDATE runs SET uploaded_bytes = uploaded_bytes + ? WHERE id = ? AND uploaded_bytes <= ? RETURNING id", planned.bytes, fence.runId, runUploadBytes - planned.bytes).length
							? "charged"
							: "over";
					if (answer !== "charged") this.#discard(planned.fresh);
					return answer;
				}),
			);
			if (charged === "stale") return { ok: false, code: "stale", message: STALE };
			if (charged === "over") return { ok: false, code: "quota", message: quotaRefusal("run_uploads"), limit: "run_uploads" };
			// A failed upload's new keys are deleted now, written or not, and again a day later; one that throws
			// leaves them loose, for the sweep.
			const result = await upload(plan);
			if (!result.ok) {
				await abandon();
				return { ok: false, code: "upload", reason: result.reason, path: result.path, message: result.message };
			}
			const expected = new Map(plan.files.map((file) => [file.path, file]));
			const matches =
				result.stored.length === plan.files.length &&
				new Set(result.stored.map((stored) => stored.path)).size === plan.files.length &&
				result.stored.every((stored) => {
					const wanted = expected.get(stored.path);
					return wanted !== undefined && wanted.sha256 === stored.sha256 && wanted.size === stored.size && wanted.key === stored.key;
				});
			if (!matches) {
				await abandon();
				return { ok: false, code: "upload", reason: "mismatch", path: "", message: "The files stored are not the files planned." };
			}
		}

		const outcome = await this.#deps.outside((): CheckpointOutcome => {
			try {
				return this.#sql.transaction((): CheckpointOutcome => {
					const refuse = (outcome: CheckpointOutcome): never => {
						throw new Refused(outcome);
					};
					if (!this.#deps.isCurrent(fence)) refuse({ ok: false, code: "stale", message: STALE });
					const run = this.#run(fence.runId) as RunFolder;
					const current = run.checkpoint_version_id ?? run.base_version_id;
					if (current !== planned.current) refuse({ ok: false, code: "conflict", message: CONFLICT });
					for (const file of plan.files) {
						// Hashed only: the contents must still be stored, as they were when planned.
						const kept = file.key === null ? this.#stored([file.sha256]).has(file.sha256) : this.#claim(file.key, fence.runId);
						if (!kept) refuse({ ok: false, code: "unknown_blob", message: BLOB_GONE });
						this.#sql.exec("INSERT INTO folder_grants (run_id, sha256) VALUES (?, ?) ON CONFLICT DO NOTHING", fence.runId, file.sha256);
					}
					const readable = this.readable(fence.runId);
					const missing = [...hashesOf(planned.manifest)].filter((hash) => !readable.has(hash));
					if (missing.length) refuse({ ok: false, code: "unknown_blob", message: unreadableMessage(missing.length) });
					let version: VersionRow;
					try {
						version = this.recordVersion("checkpoint", planned.manifest, { parentId: current, runId: fence.runId, attempt: fence.attempt });
					} catch (error) {
						if (error instanceof QuotaExceeded) return refuse({ ok: false, code: "quota", message: quotaRefusal(error.limit), limit: error.limit });
						if (error instanceof UnknownBlob || error instanceof StaleParent) return refuse({ ok: false, code: "unknown_blob", message: BLOB_GONE });
						throw error;
					}
					this.#sql.exec("UPDATE runs SET checkpoint_version_id = ? WHERE id = ?", version.id, fence.runId);
					if (planned.warnings !== null) this.#sql.exec("UPDATE runs SET folder_warnings = ? WHERE id = ?", json(planned.warnings), fence.runId);
					const replaced = current === null ? null : this.version(current);
					if (replaced !== null && replaced.kind === "checkpoint" && replaced.run_id === fence.runId) {
						// A run keeps only its last checkpoint: what it may read is its base version, its last
						// checkpoint and its uploads, and every blob of an earlier checkpoint is one of those.
						this.#sql.exec("UPDATE folder_versions SET parent_id = ? WHERE id = ?", run.base_version_id, version.id);
						this.#deleteVersion(replaced.id);
					}
					return { ok: true, versionId: version.id, uploaded: plan.files.length };
				});
			} catch (error) {
				if (error instanceof Refused) return error.answer as CheckpointOutcome;
				throw error;
			}
		});
		// Refused after its uploads (the run ended meanwhile, say): nothing claimed them.
		if (!outcome.ok && keys.length) await abandon();
		return outcome;
	}

	/** The version a new attempt hydrates: its last checkpoint, else its base version, with each file's key. */
	hydratePlan(runId: RunId): HydratePlan {
		const run = this.#run(runId);
		const versionId = run === null ? null : (run.checkpoint_version_id ?? run.base_version_id);
		if (versionId === null) return { versionId: null, files: [], dirs: [] };
		const entries = this.entries(versionId);
		const stored = this.#stored(hashesOf(entries));
		const files = filesOf(entries).map(([path, entry]) => {
			const blob = stored.get(entry.sha256);
			if (!blob) throw new UnknownBlob([entry.sha256]);
			return { path, sha256: entry.sha256, size: entry.size, mode: entry.mode, mtime: entry.mtime, key: blob.key };
		});
		return { versionId, files, dirs: [...entries.dirs] };
	}

	// Publishing.

	/**
	 * Inside the transaction that ends the run: its last checkpoint becomes a `turn` on top of its base
	 * version and the result, with what the turn changed; else its base version is the result, with no
	 * changes, even if the base added attachments (files risk 9). The run's grants end, and what it stored
	 * that neither version names is deleted.
	 */
	publish(runId: RunId, run: { baseVersionId: VersionId | null; checkpointVersionId: VersionId | null }): { resultVersionId: VersionId | null; changes: FolderChanges | null } {
		return this.#sql.transaction(() => {
			const resultVersionId = run.checkpointVersionId ?? run.baseVersionId;
			let changes: FolderChanges | null = null;
			if (run.checkpointVersionId !== null) {
				this.#sql.exec("UPDATE folder_versions SET kind = 'turn', parent_id = ? WHERE id = ?", run.baseVersionId, run.checkpointVersionId);
			}
			// A run must end whatever its folder holds: entries that cannot be read cost the changes and the
			// clean-up, never the end.
			try {
				if (run.checkpointVersionId !== null) {
					changes = folderChanges(run.baseVersionId === null ? null : this.entries(run.baseVersionId), this.entries(run.checkpointVersionId));
				}
				const named = new Set<Sha256>();
				for (const id of [run.baseVersionId, resultVersionId]) if (id !== null) for (const hash of hashesOf(this.entries(id))) named.add(hash);
				const unnamed = this.#sql
					.exec<{ key: string; sha256: string }>("SELECT key, sha256 FROM folder_blobs WHERE run_id = ? AND state = 'stored'", runId)
					.filter((row) => !named.has(row.sha256))
					.map((row) => row.key);
				this.#doom(unnamed);
			} catch (error) {
				this.#deps.log("a run's folder could not be compared or cleaned up", error);
			}
			this.#sql.exec("DELETE FROM folder_grants WHERE run_id = ?", runId);
			return { resultVersionId, changes };
		});
	}

	// Reading from the web.

	/** `conversation_version`: the folder, or a non-checkpoint version of this conversation; undefined is 404. */
	#readable(versionId: VersionId | null): VersionRow | null | undefined {
		if (versionId === null) {
			const current = this.#deps.conversation()?.folderVersionId ?? null;
			return current === null ? null : (this.version(current) ?? undefined);
		}
		const row = this.version(versionId);
		return row === null || row.kind === "checkpoint" ? undefined : row;
	}

	list(versionId: VersionId | null): Folder | null {
		const row = this.#readable(versionId);
		if (row === undefined) return null;
		if (row === null) return { versionId: null, files: [], dirs: [] };
		const entries = this.entries(row.id);
		return {
			versionId: row.id,
			files: filesOf(entries).map(([path, entry]) => ({ path, size: entry.size, mtime: entry.mtime })),
			dirs: [...entries.dirs],
		};
	}

	/** A file of the version, exactly by path, with the object it is stored in; null is 404. */
	resolve(versionId: VersionId | null, path: string): DownloadTarget | null {
		const row = this.#readable(versionId);
		if (!row || typeof path !== "string") return null;
		const files = this.entries(row.id).files;
		if (!Object.hasOwn(files, path)) return null;
		const entry = files[path] as StoredEntries["files"][string];
		const blob = this.#stored([entry.sha256]).get(entry.sha256);
		if (!blob) return null;
		return { versionId: row.id, path, key: blob.key, sha256: entry.sha256, size: blob.size };
	}

	// The sweep.

	/** When the sweep is next due: the earliest loose or doomed row, or now when the total is not reported yet. */
	nextSweep(): EpochMs | null {
		const due = first<{ t: number | null }>(this.#sql, "SELECT min(due_at) AS t FROM folder_blobs WHERE state <> 'stored'")?.t ?? null;
		if ((this.reported() ?? 0) !== this.total()) return due === null ? this.#deps.now() : Math.min(due, this.#deps.now());
		return due;
	}

	/**
	 * Loose rows an hour old become doomed (the sweep has taken them: a late claim is refused), and doomed
	 * objects are deleted, a batch at a time, then deleted once more a day later, for a write still in
	 * flight; then the total is reported. Returns when to run next, computed last, with no await after it, so
	 * a row recorded while this ran is never left without a sweep.
	 */
	async sweep(): Promise<{ rescheduleAt: EpochMs } | undefined> {
		const now = this.#deps.now();
		const due = await this.#deps.outside(() =>
			this.#sql.transaction(() => {
				this.#sql.exec("UPDATE folder_blobs SET state = 'doomed', deletions = 0, attempts = 0 WHERE state = 'loose' AND due_at <= ?", now);
				return this.#sql.exec<BlobRow>("SELECT * FROM folder_blobs WHERE state = 'doomed' AND due_at <= ? ORDER BY due_at LIMIT ?", now, DELETE_BATCH);
			}),
		);
		let retry = false;
		if (due.length) {
			try {
				await this.#deps.bucket.delete(due.map((row) => row.key));
				await this.#deps.outside(() =>
					this.#sql.transaction(() => {
						for (const row of due) {
							// Guarded by what this sweep saw: a row doomed again meanwhile starts over.
							if (row.deletions === 0) {
								this.#sql.exec(
									"UPDATE folder_blobs SET deletions = 1, attempts = 0, due_at = ? WHERE key = ? AND state = 'doomed' AND deletions = 0",
									now + SECOND_DELETION_MS,
									row.key,
								);
							} else this.#sql.exec("DELETE FROM folder_blobs WHERE key = ? AND state = 'doomed' AND deletions = 1", row.key);
						}
					}),
				);
			} catch (error) {
				retry = true;
				this.#deps.log("objects could not be deleted yet", error);
				await this.#deps.outside(() =>
					this.#sql.transaction(() => {
						for (const row of due) {
							this.#sql.exec("UPDATE folder_blobs SET attempts = attempts + 1, due_at = ? WHERE key = ? AND state = 'doomed' AND deletions = ?", now + backoff(row.attempts), row.key, row.deletions);
						}
					}),
				);
			}
			// A full batch: more may be due.
			if (due.length === DELETE_BATCH) retry = true;
		}
		const conversation = this.#deps.conversation();
		if (conversation !== null && !conversation.deleted && this.reported() !== this.total()) {
			try {
				if (!(await this.#report())) retry = true;
			} catch (error) {
				retry = true;
				this.#deps.log("the byte total could not be reported yet", error);
			}
		}
		const next = first<{ t: number | null }>(this.#sql, "SELECT min(due_at) AS t FROM folder_blobs WHERE state <> 'stored'")?.t ?? null;
		const again = retry ? this.#deps.now() + (due.length === DELETE_BATCH ? 0 : RETRY_MS) : null;
		const at = next === null ? again : again === null ? next : Math.min(next, again);
		return at === null ? undefined : { rescheduleAt: at };
	}

	// Deletion (ARCHITECTURE.md: Files, Deletion).

	/** Deletes every object under the conversation's prefix, recorded or not; returns how many it found. */
	deleteObjects(): Promise<number> {
		return deletePrefix(this.#deps.bucket, conversationPrefix(this.#deps.workspaceId, this.#deps.conversationId));
	}
}

function isSizes(value: unknown): value is { [path: string]: number } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** 30 s, doubling to an hour. */
function backoff(attempts: number): number {
	return Math.min(RETRY_MS * 2 ** attempts, 60 * 60 * 1000);
}

/** Runs `work` for each item, at most `limit` at once; the first failure is thrown once all have settled. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const failures: unknown[] = [];
	const runner = async () => {
		while (next < items.length) {
			const item = items[next++] as T;
			try {
				await work(item);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
	if (failures.length) throw failures[0];
}
