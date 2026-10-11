// Code mode (plan: Code mode; runs 4.5, harness 7). `run_script` keeps its description and rules. Each
// script is a Dynamic Worker loaded with `globalOutbound: null`, no `env` and `limits.cpuMs`, from the
// per-conversation Scripts Durable Object through an awaited loopback entrypoint (ScriptHost), so a
// CPU-bound script never blocks the conversation. The Scripts Durable Object holds nothing durable.

import type { AttemptFence, Json } from "./common.ts";

export interface ScriptFence extends AttemptFence {
	/** Unique per script within the run. */
	scriptId: string;
}

export interface ScriptRequest {
	/** The body of an async function: top-level await and return work. */
	code: string;
	/** Tool names as the script calls them (`tools.<identifier>`) mapped to the run's tool names. */
	tools: { [identifier: string]: string };
	/** `store()` values kept between the turn's scripts, up to 1 MiB of UTF-8 JSON in all. */
	store: { [key: string]: Json };
	/** The guest's CPU limit; it kills about 2 s late. */
	cpuMs: number;
}

/**
 * The guest's only capability: an RpcTarget the Conversation Durable Object creates per script. It applies
 * the caps (100 open calls across the turn's scripts, 256 KB of argument JSON, stop after 100 refusals)
 * and queues calls with the direct ones (4 at once, writes one at a time). Once the script ends or is
 * stopped, later calls get a promise that never settles, so a stopped guest cannot spin the host.
 */
export interface ScriptTools {
	/**
	 * Resolves to the result's structured content, or its text, as JSON; rejects with Error(message) when the
	 * call fails or is refused ("At most 100 tool calls can wait at once. Await some before starting more.",
	 * "Tool arguments could not be converted to JSON.", "Tool arguments are limited to 256 KB of JSON.").
	 */
	call(name: string, argsJson: string): Promise<string>;
}

/**
 * pi-codemode's result contract (harness 7.3), which `run_script`'s rendering reads: notes first (a
 * failure clipped to 30,000 characters, then cancelled calls), the printed output, then the returned value,
 * or "The script printed and returned nothing." Output is capped at 1 MiB. A script stopped for CPU or
 * memory loses what it printed.
 */
export interface ScriptResult {
	ok: boolean;
	value?: Json;
	error?: { kind: "script" | "timeout" | "aborted" | "sandbox"; message: string; stack?: string };
	output: { type: "text"; text: string }[];
	calls: { status: "ok" | "error" | "cancelled" }[];
	/** Saved only when `ok`. */
	storeWrites: { set: { [key: string]: Json }; delete: string[] };
}

/**
 * The Scripts Durable Object (one per conversation, named by its id). The Conversation Durable Object
 * enforces the wall clock (120 s, cut to the deadline); on timeout it stops the ScriptTools target, lets
 * dispatched writes settle, and calls `reset` with the script's run and attempt.
 *
 * Fences order by run id (UUIDv7, so a later run sorts later), then attempt. The object keeps the newest
 * it has run a script under, in storage, so the order survives its own reset.
 */
export interface ScriptsApi {
	/** Refused as stale for a fence older than the newest this object has seen. */
	run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools): Promise<ScriptResult | { refused: "stale" }>;
	/**
	 * Tears down every guest this object loaded (`ctx.abort()`), the attempt's other scripts included (they
	 * end `aborted`); the next script starts clean. Refused as stale when a script has run under a later run
	 * or attempt since, so a late reset from a replaced attempt cannot stop the next attempt's script.
	 */
	reset(fence: AttemptFence): Promise<{ reset: true } | { refused: "stale" }>;
}

/** The loopback WorkerEntrypoint the Scripts Durable Object awaits, which loads and runs one guest. */
export interface ScriptHostApi {
	run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools): Promise<ScriptResult>;
}
