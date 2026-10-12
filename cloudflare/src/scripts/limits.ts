// Code mode's bounds and the words scripts and the model see (harness 7; plan: Code mode), from
// worker/src/main.ts, worker/src/script-store.ts and pi-codemode 1.0.4's prelude and host, which today's
// `run_script` runs in. Numbers and words that changed on this platform are marked "New".

export const SCRIPT_TOOL = "run_script";

/** The wall clock, enforced by the Conversation Durable Object, cut to the run's deadline (harness 7.4). */
export const SCRIPT_TIMEOUT_MS = 120_000;
/** A call's time when the run has no deadline (harness 5.2 `remainingMs`). */
export const CALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * New: computation is cut by the guest's `limits.cpuMs`, which the platform enforces about 2 to 8 s late
 * (measured: 30 s of computation ended after 36 to 38 s). A CPU-bound guest blocks the Scripts object it
 * runs in, never the conversation.
 */
export const SCRIPT_CPU_MS = 30_000;
/** New: about what a guest may hold before the platform stops it; there is no lower setting (today 64 MiB). */
export const SCRIPT_MEMORY_LABEL = "about 256 MB";

/** The run's queue runs at most this many connector calls at once (conversation/queue.ts). */
export const CALLS_AT_ONCE = 4;
/** Scripted calls that may wait at once, across the turn's scripts (harness 7.5). */
export const SCRIPT_CALLS_OPEN = 100;
/** A scripted call's arguments, as UTF-8 JSON (harness 7.5). */
export const SCRIPT_ARGS_BYTES = 256 * 1024;
/** Refusals of one script before it is stopped (harness 7.5). */
export const SCRIPT_REFUSALS = 100;
/** `store()` values kept for the turn, as UTF-8 JSON (worker/src/script-store.ts). */
export const STORE_BYTES = 1024 * 1024;

/** pi-codemode's prelude: per stored value and in all, in characters of JSON (UTF-16 units, as JavaScript counts). */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
/** pi-codemode's prelude: what one script may print, in characters, and in `text()`, `image()` and `console` calls. */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100_000;

/**
 * New: what crosses from the guest of a long output or returned value. The tool's result keeps its first
 * 1 MiB (`TOOL_RESULT_LIMITS`), so the guest sends the head of its text up to this many UTF-16 units (each
 * at least one UTF-8 byte, so more than the 1 MiB the bound needs) and only the size of the rest, from which
 * the host writes pi's truncation note exactly (scripts/output.ts). This keeps a 16 Mi-character output out
 * of the conversation's memory and under Workers RPC's 32 MiB.
 */
export const HEAD_CHARS = 1024 * 1024 + 4;
/** New: the keys one script may delete from the store, in characters, so its answer stays far under Workers RPC's 32 MiB. */
export const STORE_DELETES_CHARS = 8 * 1024 * 1024;
/** New: what the host accepts as one script's printed output in UTF-8 bytes: today's 16 Mi characters at 3 bytes each. */
export const OUTPUT_BYTES_MAX = 3 * MAX_OUTPUT_CHARS;
/** New: how much of a failure's message and stack crosses; the rendering clips it to 30,000 characters. */
export const ERROR_CHARS = 64 * 1024;
/**
 * New: calls and prints from a stopped guest get a promise that never settles, so one that awaits them
 * stops; past this many such promises, further ones are refused at once, so a guest that fires them
 * without awaiting cannot fill the conversation's memory before its object is reset.
 */
export const LATE_PENDING = 100;

/** The guest's compatibility date: the Worker's own. */
export const GUEST_COMPATIBILITY_DATE = "2026-10-06";
/** The guest's modules; stack frames name the script's as today's QuickJS did (`codemode.js`). */
export const PRELUDE_MODULE = "codemode-prelude.js";
export const SCRIPT_MODULE = "codemode.js";

// Words.

export const OPEN_REFUSED = `At most ${SCRIPT_CALLS_OPEN} tool calls can wait at once. Await some before starting more.`;
export const ARGS_UNCONVERTIBLE = "Tool arguments could not be converted to JSON.";
export const ARGS_TOO_LARGE = `Tool arguments are limited to ${SCRIPT_ARGS_BYTES / 1024} KB of JSON.`;
export const REFUSALS_STOP = "The script kept making tool calls that could not run.";
/** pi-codemode's host, for a call to a tool it does not have (only a guest that bypassed the prelude's `tools`). */
export const UNKNOWN_TOOL = (name: string): string => `Unknown tool "${name}"`;
/** worker/src/main.ts `scriptTool`, for a failure without a message. */
export const CALL_FAILED = (name: string): string => `${name} failed.`;
export const CANCELLED_NOTE = (n: number): string =>
	`${n} tool call${n === 1 ? "" : "s"} had not finished when the script ended and ${n === 1 ? "was" : "were"} cancelled. A cancelled write may still have taken effect.`;
export const NOTHING = "The script printed and returned nothing.";
export const IMAGE_OMITTED = "[image omitted]";
export const STORE_UNCONVERTIBLE = "What the script passed to `store()` was not kept: a value could not be converted to JSON.";
export const STORE_TOO_LARGE = `What the script passed to \`store()\` was not kept: the stored values would take more than ${STORE_BYTES / 1024 / 1024} MiB.`;
export const OUTPUT_LIMIT =
	`script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. ` +
	"Print a summary instead, or write large data to a file with a tool.";
/** pi-codemode's host, for the wall clock and an abort without an Error. */
export const TIMED_OUT = (ms: number): string => `Execution timed out after ${ms} ms`;
export const ABORTED = "Execution aborted";
/**
 * pi-codemode's prelude fails a script that waits on nothing that could resume it; the platform cancels
 * such a guest itself. New: timers exist, so the end of today's sentence changed.
 */
export const STALLED = "The script is waiting on a promise that can never settle: no tool call or timer is pending.";
/** New: what the platform's own stops become. */
export const CPU_STOPPED = (ms: number): string => `The script was stopped after ${ms / 1000} seconds of computation.`;
export const MEMORY_STOPPED = `The script was stopped for using more than ${SCRIPT_MEMORY_LABEL} of memory.`;
/** pi-codemode's host, for a guest whose answer does not decode. */
export const BRIDGE_BROKEN = (detail: string): string =>
	`Sandbox bridge broken: ${detail}. The script may have modified built-ins such as a prototype's toJSON.`;
/** New: the Scripts object failed while the script ran (pi-codemode's host said "Sandbox host failed: …" of its own failures). */
export const SANDBOX_FAILED = (detail: string): string => `Sandbox host failed: ${detail}`;
/** New: a script refused because the one before it could not be ended (its object's reset kept failing). */
export const RESET_FAILED = SANDBOX_FAILED("the sandbox of the previous script could not be reset, so this script did not run");
/** The abort reason of a reset, by which the conversation recognises the broken call as the reset done. */
export const RESET_REASON = "The scripts of this conversation were reset.";
