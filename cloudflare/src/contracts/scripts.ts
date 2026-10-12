// Code mode (plan: Code mode; runs 4.5, harness 7). `run_script` keeps its description and rules. Each
// script is a Dynamic Worker loaded with `globalOutbound: null`, no `env` and `limits.cpuMs` by the
// per-conversation Scripts Durable Object, so a CPU-bound script never blocks the conversation. The
// conversation resets the Scripts object after every script, which is what ends a guest that ignores its
// stop (measured on the account, scripts/scripts.ts). The Scripts object holds nothing durable but the
// newest fence it ran a script or a reset under, and the scripts it reset.

import type { AttemptFence, Json } from "./common.ts";

export interface ScriptFence extends AttemptFence {
	/** Unique per script within the run. */
	scriptId: string;
}

export interface ScriptRequest {
	/** The body of an async function: top-level await and return work. */
	code: string;
	/**
	 * The run's connector tools, in the order the run lists them, with the identifier scripts call each by
	 * (pi-codemode's `toCodemodeIdentifier`; the first tool wins an identifier). Each is also `tools["<name>"]`.
	 */
	tools: { name: string; identifier: string }[];
	/**
	 * `store()` values kept between the turn's scripts, as `[key, JSON text]`, up to 1 MiB of UTF-8 JSON in
	 * all. Pairs, not an object, so a key such as `__proto__` stays a key.
	 */
	store: [string, string][];
	/** The guest's CPU limit; the platform stops it a few seconds late. */
	cpuMs: number;
}

/** The size of the part of a text that did not cross, as UTF-8 (scripts/output.ts). */
export interface TextSize {
	bytes: number;
	newlines: number;
	/** Whether the text ends with a newline. */
	last: boolean;
}

/** A text as it crossed: whole, or its head and the size of the rest (long outputs and values). */
export interface ScriptText {
	text: string;
	rest?: TextSize;
}

/** What a scripted call answers the guest: the result's structured content, or the failure's message. */
export type ScriptCallAnswer = { ok: true; value: Json } | { ok: false; message: string };

/** One printed item; an image is shown to the model as "[image omitted]", so its data never crosses. */
export type ScriptOutputItem = ({ type: "text" } & ScriptText) | { type: "image" };

/**
 * The guest's only capability: an RpcTarget the Conversation Durable Object makes per script. It applies
 * the caps (100 open calls across the turn's scripts, 256 KB of argument JSON, stop after 100 refusals,
 * today's output limits) and queues calls with the direct ones (4 at once, writes one at a time). Once the
 * script ended or was stopped, later calls and prints get a promise that never settles, so a stopped
 * guest that awaits them stops.
 */
export interface ScriptTools {
	/**
	 * `argsJson` is the arguments' JSON (absent for none). Answers the result's structured content, or the
	 * message of a failure or a refusal ("At most 100 tool calls can wait at once. Await some before
	 * starting more.", "Tool arguments could not be converted to JSON.", "Tool arguments are limited to 256 KB
	 * of JSON.").
	 */
	call(name: string, argsJson: string | undefined): Promise<ScriptCallAnswer>;
	/** Printed output, in the order the script printed it. */
	print(items: ScriptOutputItem[]): Promise<void>;
}

/** What the Scripts object hears from the conversation while a script runs; the guest never gets it. */
export interface ScriptControl {
	/**
	 * Resolves once the conversation stopped the script (its wall clock, pi's abort, its refusals or its
	 * output); a call that breaks means the conversation is gone. Either way the Scripts object resets.
	 */
	stopped(): Promise<void>;
}

/**
 * What a guest answered, as the Scripts object checked it (the guest is hostile). `value` is the returned
 * value's text (a string as is, else its JSON). `writes` are the keys `store()` set (with their JSON) and
 * deleted, reported only when `ok`. `unsettled` counts the calls the script started that had not settled
 * when it ended, as the script saw them, including ones that never reached the host.
 */
export type GuestOutcome =
	| { ok: true; value?: ScriptText; writes: ScriptStoreWrites; unsettled: number }
	| { ok: false; error: ScriptError; unsettled: number };

export interface ScriptStoreWrites {
	set: [string, string][];
	delete: string[];
}

export interface ScriptError {
	kind: "script" | "timeout" | "aborted" | "sandbox";
	message: string;
	stack?: string;
}

/**
 * pi-codemode's result contract (harness 7.3), which `run_script`'s rendering reads: notes first (a
 * failure clipped to 30,000 characters, then cancelled calls), the printed output, then the returned value,
 * or "The script printed and returned nothing." A script stopped for CPU or memory loses what it printed
 * since it last yielded.
 */
export interface ScriptResult {
	ok: boolean;
	value?: ScriptText;
	error?: ScriptError;
	/** The printed items, images as "[image omitted]"; a long output's head, then the size of the rest. */
	output: ScriptText[];
	/** How many calls had not settled when the script ended: they are reported as cancelled. */
	cancelled: number;
	/** Saved only when `ok`. */
	storeWrites: ScriptStoreWrites;
}

/**
 * The Scripts Durable Object (one per conversation, named by its id, in its workspace's jurisdiction).
 * The Conversation Durable Object enforces the wall clock (120 s, cut to the deadline) and resets this
 * object after every script, the next script waiting for the reset.
 *
 * Fences order by run id (UUIDv7, so a later run sorts later), then attempt. The object keeps the newest it
 * has seen in storage, so the order survives its own resets.
 */
export interface ScriptsApi {
	/**
	 * Loads and runs one guest and answers what it answered, checked. Refused as stale for a fence older than
	 * the newest. When `control` says the script was stopped, or breaks, the object resets itself, which
	 * breaks this call.
	 */
	run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools, control: ScriptControl): Promise<GuestOutcome | { refused: "stale" }>;
	/**
	 * After the script of `fence`: tears down every guest this object loaded (`ctx.abort()`); the next script
	 * starts in a new instance. Refused as stale when a later run or attempt has used the object since, or a
	 * later script has loaded in this instance, so a late reset cannot stop a newer script. Answers at once
	 * when this instance loaded nothing. Unless `answered` (its run came back), the script is remembered as
	 * ended first, so a run of it still on its way is refused. The reset breaks the call itself: a call that
	 * fails because the object was reset is the reset done.
	 */
	reset(fence: ScriptFence, answered?: boolean): Promise<{ reset: true } | { refused: "stale" }>;
	/**
	 * For the conversation's deletion (plan: Files, Deletion), once it refuses new runs: deletes the fence and
	 * resets the object, which breaks the call once done.
	 */
	destroy(): Promise<void>;
}
