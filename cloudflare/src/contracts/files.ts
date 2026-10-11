// Agent files: manifests, versions, warnings and changes (files 4, 5, 7). The store, versions and uploads
// keep today's semantics; R2 holds blobs at `blobs/<ws>/<conv>/<sha256>/<random>` and uploads at
// `uploads/<ws>/<user>/<id>`, deduplicated within a conversation (plan: Data placement, Files).

import type { ConversationId, EpochMs, RunId, Sha256, VersionId, WorkspaceId } from "./common.ts";

/** 0o644 or 0o755: the owner execute bit decides. */
export type FileMode = 420 | 493;

/**
 * The manifest a scan reports and a checkpoint carries (files 4.1). Sizes are never taken from it: they
 * come from the store's own records. `dirs` lists empty directories only. Every path passes the path
 * check (files 4.2): NFC, no Cc, ≤1,024 UTF-8 bytes, ≤32 segments of ≤255 bytes, none empty, `.` or `..`.
 */
export interface WireManifest {
	files: { path: string; sha256: Sha256; mode: FileMode; mtime: EpochMs }[];
	dirs: string[];
}

/** A version's stored entries, sorted by code point (files 4.3). Hashed with `canonicalUtf8` for `digest`. */
export interface StoredEntries {
	files: { [path: string]: { sha256: Sha256; size: number; mode: FileMode; mtime: EpochMs } };
	dirs: string[];
}

/**
 * `base`: a message's attachments added to the folder. `checkpoint`: a run's last saved state (at most one
 * per run, transient). `turn`: a checkpoint its run published. Contents are immutable; `kind` and `parent`
 * may change when a checkpoint is published (files 5).
 */
export type VersionKind = "base" | "checkpoint" | "turn";

export interface FolderVersion {
	id: VersionId;
	workspaceId: WorkspaceId;
	conversationId: ConversationId;
	parent: VersionId | null;
	kind: VersionKind;
	runId: RunId | null;
	attempt: number | null;
	/** Σ ceil(size/4096)·4096 over the files: what tmpfs charges. */
	size: number;
	fileCount: number;
	/** Files, directories listed and implied, not the root. */
	entryCount: number;
	digest: Sha256 | null;
	createdAt: EpochMs;
}

/** Why the scan left an entry out (files 7.5). */
export type WarningReason = "symlink" | "special" | "invalid_name" | "too_long" | "too_deep" | "unreadable";

/** What the scan could not keep: the first 100 by path bytes, `total` counting all (files 7.5). */
export interface FolderWarnings {
	total: number;
	items: { path: string; reason: WarningReason }[];
}

/** The four limits a folder can hit; the same strings everywhere (files 2). */
export type FolderLimit = "folder_bytes" | "folder_entries" | "run_uploads" | "workspace";

/** A conversation's folder as a new run sees it: its current version and how full it is. */
export interface FolderUsage {
	versionId: VersionId | null;
	/** In pages, as the store counts it. */
	bytes: number;
	entries: number;
	/** First path segments of every file and directory at the root: what attachment names are numbered against (files 10). */
	rootNames: string[];
}
