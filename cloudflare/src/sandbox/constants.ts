// What the sandbox is made of, in one place (ARCHITECTURE.md: The sandbox lifecycle): the agent's user,
// the folder and temporary mounts, the agent cgroup, the commands' environment and the limits the Sandbox
// Durable Object applies. The image (cloudflare/container/Dockerfile) must agree with the paths and with
// COMMAND_PATH; a unit test reads the Dockerfile to check it.

import type { ConversationId, EpochMs, WorkspaceRef } from "../shared/rpc.ts";

export interface SandboxSpec {
	workspace: WorkspaceRef;
	conversationId: ConversationId;
	/** `/workspace` tmpfs: `size` the folder limit rounded down to pages, `nr_inodes` the entry limit plus one, uid 1000. */
	folderBytes: number;
	folderEntries: number;
	/** `/tmp` tmpfs, noexec; 256 MiB. */
	tmpBytes: number;
	/** The agent cgroup's `pids.max`: 256. */
	pidsMax: number;
	/**
	 * The agent cgroup's `memory.max`: the base (1 GiB) plus both tmpfs sizes, `/workspace`'s rounded
	 * down to pages. Pages the agent writes to a tmpfs are charged to its cgroup, so with the base
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

/** The agent's user and group: every command and file operation runs as them, with no capabilities. */
export const AGENT_UID = 1000;
export const AGENT_GID = 1000;

/** The conversation's folder: a tmpfs of the folder's limits, executable, owned by the agent. */
export const WORKSPACE = "/workspace";
/** A tmpfs, noexec: the commands' TMPDIR, with their HOME and matplotlib's cache in it. */
export const TMP = "/tmp";
export const HOME = "/tmp/home";
export const MPLCONFIGDIR = "/tmp/matplotlib";
/**
 * Where else the agent's user can write once the container is hardened, measured in the image under Docker:
 * the shared memory and POSIX message queue mounts. Parking empties them with `/tmp`.
 */
export const AGENT_WRITABLE = ["/dev/shm", "/dev/mqueue"] as const;

/** The cgroup every agent process runs in, with the limits of the spec; `cgroup.kill` ends them all. */
export const AGENT_CGROUP = "/sys/fs/cgroup/agent";

/** The image's PATH for commands (the Dockerfile's ENV PATH): the agent's Python environment first. */
export const COMMAND_PATH = "/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The system's Python, which the verification runs in isolated mode without site packages. */
export const PYTHON = "/usr/bin/python3";

/** Bash's fixed environment: exactly these, never anything of the Worker's. */
export function commandEnvironment(): { [name: string]: string } {
	return { PATH: COMMAND_PATH, HOME, TMPDIR: TMP, LANG: "C.UTF-8", MPLCONFIGDIR };
}

export const PAGE_BYTES = 4096;
/** The base of the agent cgroup's memory limit; both tmpfs sizes are added. */
export const BASE_MEMORY_BYTES = 1024 * 1024 * 1024;
/** `/tmp`'s size. */
export const TMP_BYTES = 256 * 1024 * 1024;
/** The agent cgroup's `pids.max`. */
export const PIDS_MAX = 256;

/** The instance every sandbox runs on: `lite` takes about 100 ms per exec (ARCHITECTURE.md: The sandbox lifecycle). */
export const INSTANCE = "standard-1" as const;

/**
 * The largest file `readTextFile` reads whole (the edit tool's read):
 * the text crosses an RPC and lives in the Conversation Durable Object's 128 MB isolate.
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** The largest whole binary read, and the most one positional read returns. */
export const MAX_BINARY_BYTES = 16 * 1024 * 1024;
/** A file operation's own limit, after which its processes are killed. */
export const FILE_OPERATION_SECONDS = 120;
/** A command's processes get this long after `timeout`'s TERM before its KILL (`timeout -k 5`). */
export const KILL_AFTER_SECONDS = 5;

/** How long a running container may go unused before the Sandbox destroys it, when its run has no deadline. */
export const IDLE_MS = 60 * 60 * 1000;
/** How long a parked container waits for the conversation's next run before the Sandbox destroys it. */
export const PARKED_MS = 5 * 60_000;
/** How long past its run's deadline a container is kept, for the run's last checkpoint. */
export const DEADLINE_GRACE_MS = 2 * 60 * 1000;
/** How long past its lease a container may stay for work that is still running; container time is charged to no later. */
export const HARD_GRACE_MS = 10 * 60_000;
/** The platform refuses an inactivity timeout above 6 hours. */
export const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;
/** How soon a failed destroy is tried again. */
export const CLEANUP_RETRY_MS = 30 * 1000;

/** The container's tmpfs size for a folder limit: tmpfs rounds a file up to pages, so the limit is rounded down. */
export function workspaceBytes(folderBytes: number): number {
	return Math.floor(folderBytes / PAGE_BYTES) * PAGE_BYTES;
}

/**
 * The sandbox of a conversation's run with the folder limits of the settings: `/workspace` of the
 * folder's size and entries, `/tmp` of 256 MiB, 256 processes, and memory of 1 GiB plus both tmpfs sizes.
 */
export function sandboxSpec(
	workspace: WorkspaceRef,
	conversationId: ConversationId,
	limits: { folderBytes: number; folderEntries: number },
	deadline: EpochMs | null,
): SandboxSpec {
	return {
		workspace,
		conversationId,
		folderBytes: limits.folderBytes,
		folderEntries: limits.folderEntries,
		tmpBytes: TMP_BYTES,
		pidsMax: PIDS_MAX,
		memoryBytes: BASE_MEMORY_BYTES + workspaceBytes(limits.folderBytes) + TMP_BYTES,
		deadline,
	};
}
