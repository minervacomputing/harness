// The Sandbox Durable Object: one per conversation, reached as `ctx.exports.Sandbox` (a container class
// cannot be bound by its own Worker's name), named by the conversation's id. It runs one container per
// turn: `durable_object` scheduling, instance `standard-1`, `enableInternet: false`, no outbound
// intercepts, and nothing secret in its environment (plan: The sandbox lifecycle). It is authoritative for
// the container's lifecycle: incarnation, owning run and attempt, hardening state, cleanup pending.
//
// Every operation names the incarnation, run and attempt it is for, and is refused for any other, so a
// late cleanup from one attempt can never touch the next attempt's container.

import type {
	ExecutionEnv,
	ExecutionErrorCode,
	FileErrorCode,
	FileInfo,
	LineScan,
	ShellOutputSkip,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { AttemptFence, ConversationId, EpochMs, Sha256, VersionId, WorkspaceRef } from "./common.ts";
import type { FileMode, FolderLimit, FolderWarnings, WireManifest } from "./files.ts";

/** A container incarnation, from `start`; every later call carries it. */
export interface SandboxFence extends AttemptFence {
	incarnation: string;
}

/**
 * `starting → hardening → verified → in_use → destroying`. Before `verified` no agent command or file
 * operation is admitted. A Sandbox Durable Object that restarts never reuses a running container it did
 * not verify in its current incarnation: it destroys it first. A failed `destroy()` leaves `cleanupPending`
 * and is retried by an alarm.
 */
export type SandboxState = "none" | "starting" | "hardening" | "verified" | "in_use" | "destroying";

export interface SandboxStatus {
	state: SandboxState;
	incarnation: string | null;
	runId: string | null;
	attempt: number | null;
	cleanupPending: boolean;
	startedAt: EpochMs | null;
}

export interface SandboxSpec {
	workspace: WorkspaceRef;
	conversationId: ConversationId;
	/** `/workspace` tmpfs: `size` the folder limit rounded down to pages, `nr_inodes` the entry limit plus one, uid 1000. */
	folderBytes: number;
	folderEntries: number;
	/** `/tmp` tmpfs, noexec; 256 MiB today. */
	tmpBytes: number;
	/** The agent cgroup's `pids.max`: 256 today. */
	pidsMax: number;
	/**
	 * The agent cgroup's `memory.max`: the base (1 GiB today) plus both tmpfs sizes, `/workspace`'s rounded
	 * down to pages (files 2). Pages the agent writes to a tmpfs are charged to its cgroup, so with the base
	 * alone a growing folder would OOM-kill commands, and stay charged, instead of failing with ENOSPC at
	 * the folder's limit. The instance's memory must cover it (`standard-1`: 4 GiB).
	 */
	memoryBytes: number;
	/**
	 * The run's deadline: the container is destroyed a little after it even if nobody asks. Without one, a
	 * container unused for an hour is destroyed.
	 */
	deadline?: EpochMs | null;
}

export type Refused = { refused: "stale" | "not_verified" | "busy"; message: string };

/**
 * One root exec with `set -eu`: tmpfs `/workspace` (size, nr_inodes, uid 1000), tmpfs `/tmp` noexec,
 * `/tmp/home` and `/tmp/matplotlib` owned by uid 1000 (bash's HOME and MPLCONFIGDIR, files 8.5), the
 * cgroup `/sys/fs/cgroup/agent` with pids.max and memory.max (SandboxSpec), `mount -o remount,ro /`. Any
 * failure destroys the container and fails the turn.
 */
export interface HardeningReport {
	ok: boolean;
	failed: "workspace" | "tmp" | "home_dirs" | "cgroup" | "readonly_root" | null;
	output: string;
}

/**
 * A second exec checks each postcondition; any failure, or any doubt, destroys the container: the mounts'
 * options and sizes, `/tmp` not executable, the home directories owned by uid 1000, `/` read-only,
 * `pids.max` and `memory.max` equal to the spec's, and that the dropped wrapper reports no capabilities
 * and `NoNewPrivs: 1`.
 */
export interface VerificationReport {
	ok: boolean;
	checks: {
		name: "workspace_mount" | "tmp_noexec" | "home_dirs" | "root_readonly" | "cgroup_limits" | "dropped_privileges";
		ok: boolean;
		detail: string;
	}[];
}

// Agent commands and file operations. Every command runs through one wrapper, as uid 1000 inside the
// agent cgroup with no capabilities: `echo $$ > /sys/fs/cgroup/agent/cgroup.procs || exit 125; exec
// setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all
// --no-new-privs timeout -k 5 <s> bash -c "$0"`, the command an argument, never interpolated. File
// operations run `python3 -I -S /opt/minerva/minerva-fs …` through the same wrapper.

export interface ExecRequest {
	/** Chosen by the caller, unique within the incarnation; `cancel` names it. */
	execId: string;
	/** A string runs through `bash -c`; an array runs without a shell, arguments unparsed. */
	command: string | string[];
	cwd: string;
	/**
	 * Exactly the command's environment; nothing is inherited. Bash calls get PATH, HOME=/tmp/home,
	 * TMPDIR=/tmp, LANG=C.UTF-8 and MPLCONFIGDIR=/tmp/matplotlib (files 8.5).
	 */
	env: { [name: string]: string };
	/**
	 * Seconds, already cut to the run's deadline; 0 for none. The wrapper's `timeout` stops the command's
	 * process group (TERM, then KILL 5 s later) and the result is `timeout`.
	 */
	timeoutSeconds: number;
	/** Spill the complete output to a file under /tmp past either threshold (pi's ShellSpillOptions). */
	spill?: { afterBytes: number; afterLines: number };
	/** The tail the caller keeps; output outside it may be skipped and reported (pi's ShellOutputWindow). */
	window?: { maxBytes: number; maxLines: number; minIntervalMs: number; bytesPerSecond: number };
}

/** An RpcTarget the caller passes to `exec`, called with output as it arrives, each stream decoded separately. */
export interface ExecOutputSink {
	output(chunk: { stream: "stdout" | "stderr"; text: string; skipped?: ShellOutputSkip }): void;
}

export type ExecResult =
	| { ok: true; exitCode: number; spillPath?: string }
	| { ok: false; code: ExecutionErrorCode; message: string; spillPath?: string };

/**
 * A file opened for positional reads by a reader process that holds it open, so reads keep seeing the file
 * that was opened even after a rename (pi's BinaryReader); `close` ends the process, and so does killing
 * strays. A handle whose reader is gone answers `invalid`.
 */
export interface FileHandle {
	/** The reader's id within the incarnation. */
	id: string;
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

/**
 * File operations, all as the dropped user through `minerva-fs`: paths are arguments, reads are bounded,
 * files open with O_NONBLOCK and are accepted only when `fstat` says regular file, so a FIFO never hangs a
 * call. pi's own tools keep pi's semantics for the paths the agent names (plan: The sandbox lifecycle).
 */
export type FsRequest =
	| { op: "absolute"; path: string; cwd: string }
	| { op: "canonical"; path: string }
	| { op: "exists"; path: string }
	| { op: "info"; path: string }
	| { op: "open"; path: string; noFollow: boolean }
	| { op: "read"; handle: FileHandle; offset: number; length: number }
	| { op: "scanLines"; handle: FileHandle; startLine: number; endLine?: number }
	| { op: "stat"; handle: FileHandle }
	| { op: "close"; handle: FileHandle }
	| { op: "opendir"; path: string }
	| { op: "snapshot"; targets: WatchTarget[]; maxEntries: number }
	| { op: "readText"; path: string; maxBytes: number }
	| { op: "write"; path: string; content: Uint8Array; append: boolean }
	| { op: "truncate"; path: string; size: number }
	| { op: "flush"; path: string }
	| { op: "rename"; from: string; to: string }
	| { op: "list"; path: string; after: string | null; max: number }
	| { op: "mkdir"; path: string; recursive: boolean }
	| { op: "remove"; path: string; recursive: boolean; force: boolean }
	| { op: "mktemp"; kind: "file" | "dir"; prefix?: string; suffix?: string };

/** Each request's answer, by `op`. A read returns at most 4 MiB; RPC payloads are limited to 32 MiB. */
export interface FsAnswers {
	absolute: string;
	canonical: string;
	exists: boolean;
	info: FileInfo;
	open: FileHandle;
	read: Uint8Array;
	scanLines: LineScan;
	stat: FileInfo;
	close: null;
	opendir: null;
	snapshot: WatchSnapshot;
	readText: string;
	write: null;
	truncate: null;
	flush: null;
	rename: null;
	list: { entries: FileInfo[]; next: string | null };
	mkdir: null;
	remove: null;
	mktemp: string;
}

/**
 * What a watch's poll compares (the ExecutionEnv's `watch` polls): a signature per path under the targets
 * (kind, size, mtime, ctime, inode; a symbolic link also by what it points to), excluded entries left out.
 * `overflow` when the targets hold more than `maxEntries` entries.
 */
export type WatchSnapshot = { entries: { [path: string]: string } } | { overflow: true };

/** The answer to a request: its value (`FsAnswers[op]`), or pi's error code. */
export type FsResponse = { ok: true; value: FsAnswers[keyof FsAnswers] } | { ok: false; code: FileErrorCode; message: string };

// The folder (files 8; plan: Checkpoints). File contents never cross an RPC: the Sandbox writes R2 itself.

/** What a run starts from: the hydrate version's files, each read from R2 once per distinct hash. */
export interface HydratePlan {
	versionId: VersionId | null;
	files: { path: string; sha256: Sha256; size: number; mode: FileMode; mtime: EpochMs; key: string }[];
	dirs: string[];
}

export type HydrateResult = { ok: true } | { ok: false; reason: "not_empty" | "invalid_path" | "blob_missing" | "mismatch" | "failed"; message: string };

/**
 * The scan, run in the container as the dropped user, walking `/workspace` one component at a time with
 * O_NOFOLLOW (files 8.2): every entry counts against the entry limit, sizes in pages are checked before
 * hashing, three tries if the folder changes, results sorted by code point. Its claims are untrusted: the
 * Conversation Durable Object validates the manifest and warnings again (files 4.2, 7.5).
 */
export type ScanResult =
	| { ok: true; manifest: WireManifest; sizes: { [path: string]: number }; warnings: FolderWarnings }
	| { ok: false; limit: Extract<FolderLimit, "folder_bytes" | "folder_entries"> }
	| { ok: false; reason: "changed" | "failed"; message: string };

/**
 * Files to save, each already recorded by the Conversation Durable Object under its R2 key before it is
 * written (plan: Files). The Sandbox streams each from the container into R2 with its claimed SHA-256,
 * which R2 checks, and reports what it stored. A file without a key has contents the conversation already
 * stores: its bytes are only hashed, as the proof that the run has them, and nothing is written (today's
 * store_blob writes nothing for contents it has).
 */
export interface CheckpointUploadPlan {
	files: { path: string; sha256: Sha256; size: number; key: string | null }[];
}

export type CheckpointUploadResult =
	| { ok: true; stored: { path: string; sha256: Sha256; size: number; key: string | null }[] }
	| { ok: false; reason: "changed" | "mismatch" | "failed"; path: string; message: string };

/**
 * The Sandbox Durable Object's RPC surface. A refusal for a fence that is not current is `{refused:
 * "stale"}`; before verification, `{refused: "not_verified"}`.
 */
export interface SandboxApi {
	/** Destroys any container left from an earlier incarnation first, then starts one for this attempt. */
	start(fence: AttemptFence, spec: SandboxSpec): Promise<{ incarnation: string } | Refused | { failed: string }>;
	harden(fence: SandboxFence): Promise<HardeningReport | Refused>;
	verify(fence: SandboxFence): Promise<VerificationReport | Refused>;
	exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused>;
	/** Kills one command's processes; idempotent. */
	cancel(fence: SandboxFence, execId: string): Promise<void>;
	fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused>;
	hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused>;
	scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused>;
	checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused>;
	/** `echo 1 > /sys/fs/cgroup/agent/cgroup.kill`, then verify the cgroup is empty; catches setsid processes. */
	killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused>;
	/** Destroys this incarnation's container; refused for any other incarnation. */
	destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused>;
	status(): Promise<SandboxStatus>;
}

/**
 * The ExecutionEnv adapter (plan: The local tools): pi's `ExecutionEnv` (`FileSystem & Shell` from
 * `@earendil-works/pi-durable/env`), implemented in the Conversation Durable Object as a thin client of
 * the Sandbox, created per tool call by the harness's `env` option. It must pass pi's conformance suite
 * (24 cases). `id` is the incarnation, so pi's per-file mutation queue keys stay right. Calls map so:
 *
 * | ExecutionEnv                           | Sandbox                                     |
 * |----------------------------------------|---------------------------------------------|
 * | absolutePath, joinPath                 | computed in the client (POSIX, cwd /workspace), or `fs absolute` |
 * | canonicalPath, exists, fileInfo         | `fs canonical`, `fs exists`, `fs info`      |
 * | readTextFile, readTextLines, openTextLineReader | `fs readText` (bounded)            |
 * | readBinaryFile, openBinaryReader       | `fs open`, then `fs read` and `fs scanLines` on the handle |
 * | writeFile, appendFile, truncateFile, flushFile, renameFile | `fs write`, `fs truncate`, `fs flush`, `fs rename` |
 * | listDir, openDirReader                 | `fs list`, paged                            |
 * | createDir, remove, createTempDir, createTempFile | `fs mkdir`, `fs remove`, `fs mktemp` |
 * | watch                                  | polling over `fs info` and `fs list` (no built-in tool calls it) |
 * | exec                                   | `exec` with an ExecOutputSink; an aborted context calls `cancel` |
 * | cleanup                                | `killStrays`                                |
 *
 * Expected failures come back as pi's `Result` errors with FileErrorCode or ExecutionErrorCode, never as
 * throws. If the Conversation Durable Object restarts mid-turn it loses its exec handles: calls in flight
 * come back interrupted and the container is replaced from the last checkpoint.
 */
export type ExecutionEnvAdapter = ExecutionEnv;
