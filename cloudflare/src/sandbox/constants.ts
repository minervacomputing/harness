// What the sandbox is made of, in one place (plan: The sandbox lifecycle; files 2, 8.5): the agent's user,
// the folder and temporary mounts, the agent cgroup, the commands' environment and the limits the Sandbox
// Durable Object applies. The image (cloudflare/container/Dockerfile) must agree with the paths and with
// COMMAND_PATH; a unit test reads the Dockerfile to check it.

import type { ConversationId, EpochMs, WorkspaceRef } from "../contracts/common.ts";
import type { SandboxSpec } from "../contracts/sandbox.ts";

/** The agent's user and group: every command and file operation runs as them, with no capabilities. */
export const AGENT_UID = 1000;
export const AGENT_GID = 1000;

/** The conversation's folder: a tmpfs of the folder's limits, executable, owned by the agent. */
export const WORKSPACE = "/workspace";
/** A tmpfs, noexec: the commands' TMPDIR, with their HOME and matplotlib's cache in it. */
export const TMP = "/tmp";
export const HOME = "/tmp/home";
export const MPLCONFIGDIR = "/tmp/matplotlib";

/** The cgroup every agent process runs in, with the limits of the spec; `cgroup.kill` ends them all. */
export const AGENT_CGROUP = "/sys/fs/cgroup/agent";

/** The image's PATH for commands (the Dockerfile's ENV PATH): today's worker PATH, Python's environment first. */
export const COMMAND_PATH = "/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The file helper on the read-only root, run in Python's isolated mode without site packages. */
export const PYTHON = "/usr/bin/python3";
export const MINERVA_FS = "/opt/minerva/minerva-fs";

/** Bash's fixed environment (files 8.5): exactly these, never anything of the Worker's. */
export function commandEnvironment(): { [name: string]: string } {
	return { PATH: COMMAND_PATH, HOME, TMPDIR: TMP, LANG: "C.UTF-8", MPLCONFIGDIR };
}

export const PAGE_BYTES = 4096;
/** The base of the agent cgroup's memory limit; both tmpfs sizes are added (files 2). */
export const BASE_MEMORY_BYTES = 1024 * 1024 * 1024;
/** `/tmp`'s size, as today's container provider gives it. */
export const TMP_BYTES = 256 * 1024 * 1024;
/** The agent cgroup's `pids.max`, as today's container provider gives it. */
export const PIDS_MAX = 256;

/** The instance every sandbox runs on: `lite` takes about 100 ms per exec (plan: The sandbox lifecycle). */
export const INSTANCE = "standard-1" as const;

/** A positional read answers at most this much; a caller asking for more reads again (contracts/sandbox.ts). */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/**
 * The largest file `readTextFile` reads whole (the edit tool's read). Today only Node's 2 GiB bounded it;
 * here the text crosses an RPC and lives in the Conversation Durable Object's 128 MB isolate.
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** A whole binary read, in pieces of MAX_READ_BYTES. */
export const MAX_BINARY_BYTES = 16 * 1024 * 1024;
/** A file operation's own limit, after which its processes are killed (files 2, "file tools: 120 s"). */
export const FILE_OPERATION_SECONDS = 120;
/** A command's processes get this long after `timeout`'s TERM before its KILL (`timeout -k 5`). */
export const KILL_AFTER_SECONDS = 5;

/** How long a running container may go unused before the Sandbox destroys it, when its run has no deadline. */
export const IDLE_MS = 60 * 60 * 1000;
/** How long past its run's deadline a container is kept, for the run's last checkpoint. */
export const DEADLINE_GRACE_MS = 2 * 60 * 1000;
/** The platform refuses an inactivity timeout above 6 hours. */
export const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;
/** How soon a failed destroy is tried again. */
export const CLEANUP_RETRY_MS = 30 * 1000;

/** The container's tmpfs size for a folder limit: tmpfs rounds a file up to pages, so the limit is rounded down. */
export function workspaceBytes(folderBytes: number): number {
	return Math.floor(folderBytes / PAGE_BYTES) * PAGE_BYTES;
}

/**
 * The sandbox of a conversation's run with the folder limits of the settings (files 2): `/workspace` of the
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
