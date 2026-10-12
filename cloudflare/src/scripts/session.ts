// The host's side of one script (harness 7.5; plan: Code mode), in the Conversation Durable Object: what
// the guest's RpcTarget does with its calls and prints. Ported from worker/src/main.ts `scriptCalls` and
// pi-codemode 1.0.4's host, with the guest now hostile: every bound is applied here, whatever the prelude
// did.
//
// - Calls are admitted in today's order (100 open across the turn's scripts, then the arguments' JSON and
//   its 256 KB), after the tool lookup pi-codemode's host made first; a refusal is a rejected call inside
//   the script, and the 100th refusal of a script stops it from a microtask, so that call still counts as
//   refused (incoming calls are served before timers, so a timer would let more through).
// - An admitted call goes through the run's queue and the executor (the port), shared with direct calls.
//   It is never cut when the script ends: a call still waiting for its slot is dropped, one already sent runs
//   to its end and keeps its slot and its open count until then, and a write still settles and is recorded.
//   Calls that had not settled when the script ended are reported as cancelled.
// - Prints are kept as scripts/output.ts says, and counted against today's item limit.
// - Once the script ended or was stopped, calls and prints get a promise that never settles: a stopped
//   guest that awaits one stops, and one that loops on answers given at once cannot keep the host busy.
//   Past `LATE_PENDING` of them, more are answered at once, so they cannot fill the host's memory either.

import type { Json } from "../contracts/common.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../contracts/executor.ts";
import type { ScriptCallAnswer, ScriptError, TextSize } from "../contracts/scripts.ts";
import { parseJson } from "../lib/json.ts";
import {
	ARGS_TOO_LARGE,
	ARGS_UNCONVERTIBLE,
	BRIDGE_BROKEN,
	CALL_FAILED,
	HEAD_CHARS,
	IMAGE_OMITTED,
	LATE_PENDING,
	MAX_OUTPUT_ITEMS,
	OPEN_REFUSED,
	OUTPUT_BYTES_MAX,
	OUTPUT_LIMIT,
	REFUSALS_STOP,
	SCRIPT_ARGS_BYTES,
	SCRIPT_CALLS_OPEN,
	SCRIPT_REFUSALS,
	UNKNOWN_TOOL,
} from "./limits.ts";
import { OutputRecord, sizeOf } from "./output.ts";

/** One scripted call through the run's queue and the executor (the Conversation's `#invoke`). */
export interface ScriptCallPort {
	/**
	 * `drop` is checked just before the call is sent: a call still waiting for its slot when the script ends
	 * is not sent. It does not cut a call already sent. Settles with the executor's outcome.
	 */
	invoke(declaration: ToolDeclaration, args: Json | undefined, drop: AbortSignal): Promise<ToolCallOutcome>;
}

/** The turn's scripted calls that wait or run, across its scripts (today's `open`, per run and instance). */
export class ScriptCalls {
	open = 0;
}

/** Why the host stopped waiting for a script. */
export interface Stop {
	kind: ScriptError["kind"];
	message: string;
	stack?: string;
}

/** A promise that never settles: the answer to a stopped guest. */
export function never<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

/** The late answer once `LATE_PENDING` never-settling ones are out. */
const OVER: ScriptCallAnswer = Object.freeze({ ok: false, message: "The script has ended." });

type Status = "ok" | "error" | "cancelled";

function isSize(value: unknown): value is TextSize {
	const size = value as TextSize | null;
	return (
		size !== null &&
		typeof size === "object" &&
		Number.isSafeInteger(size.bytes) &&
		size.bytes >= 0 &&
		Number.isSafeInteger(size.newlines) &&
		size.newlines >= 0 &&
		size.newlines <= size.bytes &&
		typeof size.last === "boolean"
	);
}

/** One script's state on the host. */
export class ScriptSession {
	readonly #calls: ScriptCalls;
	readonly #tools: ReadonlyMap<string, ToolDeclaration>;
	readonly #port: ScriptCallPort;
	/** Aborted when the script ends or is stopped: a call still waiting for its slot is then dropped. */
	readonly #over = new AbortController();
	#stop: Stop | null = null;
	readonly #stopped: Promise<Stop>;
	#onStop: (stop: Stop) => void = () => {};
	#refused = 0;
	/** Today's records: each admitted call is `cancelled` until it settles before the end. */
	readonly #records: { status: Status }[] = [];
	readonly output = new OutputRecord();
	#items = 0;
	#crossed = 0;
	/** Calls and prints that came after the end, and those answered with a promise that never settles. */
	late = 0;
	#latePending = 0;

	constructor(calls: ScriptCalls, tools: ReadonlyMap<string, ToolDeclaration>, port: ScriptCallPort) {
		this.#calls = calls;
		this.#tools = tools;
		this.#port = port;
		this.#stopped = new Promise<Stop>((resolve) => {
			this.#onStop = resolve;
		});
	}

	/** Whether the script ended or was stopped. */
	get over(): boolean {
		return this.#over.signal.aborted;
	}

	/** Why the host stopped the script, or null if it did not. */
	get stopReason(): Stop | null {
		return this.#stop;
	}

	/** Resolves when the host stops the script, never when it ends by itself. */
	stopped(): Promise<Stop> {
		return this.#stopped;
	}

	/** Stops the script: its waiting calls are dropped and every later call and print never settles. */
	stop(stop: Stop): void {
		if (this.over) return;
		this.#stop = stop;
		this.#over.abort(new Error(stop.message));
		this.#onStop(stop);
	}

	/** The script answered by itself. */
	end(): void {
		if (!this.over) this.#over.abort(new Error("The script ended."));
	}

	/** Admitted calls that had not settled when the script ended or was stopped. */
	pending(): number {
		return this.#records.filter((record) => record.status === "cancelled").length;
	}

	#late<T>(answer: T): Promise<T> {
		this.late++;
		if (this.#latePending >= LATE_PENDING) return Promise.resolve(answer);
		this.#latePending++;
		return never();
	}

	#refuse(message: string): Promise<ScriptCallAnswer> {
		this.#records.push({ status: "error" });
		if (++this.#refused >= SCRIPT_REFUSALS) queueMicrotask(() => this.stop({ kind: "aborted", message: REFUSALS_STOP }));
		return Promise.resolve({ ok: false, message });
	}

	call(name: unknown, argsJson: unknown): Promise<ScriptCallAnswer> {
		if (this.over) return this.#late(OVER);
		const declaration = typeof name === "string" ? this.#tools.get(name) : undefined;
		if (!declaration) return this.#refuse(UNKNOWN_TOOL(typeof name === "string" ? name : String(name)));
		if (this.#calls.open >= SCRIPT_CALLS_OPEN) return this.#refuse(OPEN_REFUSED);
		let args: Json | undefined;
		if (argsJson !== undefined) {
			if (typeof argsJson !== "string") return this.#refuse(ARGS_UNCONVERTIBLE);
			if (sizeOf(argsJson).bytes > SCRIPT_ARGS_BYTES) return this.#refuse(ARGS_TOO_LARGE);
			try {
				args = parseJson(argsJson);
			} catch {
				return this.#refuse(ARGS_UNCONVERTIBLE);
			}
		}
		const record: { status: Status } = { status: "cancelled" };
		this.#records.push(record);
		this.#calls.open++;
		const over = this.#over.signal;
		const settled = this.#port.invoke(declaration, args, over).finally(() => {
			this.#calls.open--;
		});
		return settled.then(
			(outcome): Promise<ScriptCallAnswer> | ScriptCallAnswer => {
				if (over.aborted) return this.#late(OVER);
				record.status = outcome.ok ? "ok" : "error";
				if (outcome.ok) return { ok: true, value: outcome.result as unknown as Json };
				return { ok: false, message: outcome.error.message || CALL_FAILED(declaration.name) };
			},
			(error: unknown): Promise<ScriptCallAnswer> | ScriptCallAnswer => {
				// Dropped while it waited for its slot (the script ended), or the run ended.
				if (over.aborted) return this.#late(OVER);
				record.status = "error";
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message: message || CALL_FAILED(declaration.name) };
			},
		);
	}

	print(items: unknown): Promise<void> {
		if (this.over) return this.#late(undefined);
		if (!Array.isArray(items)) return this.#broken("printed output is not an array");
		for (const item of items as unknown[]) {
			if (item === null || typeof item !== "object") return this.#broken("a printed item is malformed");
			const { type, text, rest } = item as { type?: unknown; text?: unknown; rest?: unknown };
			if (type === "image") {
				this.output.add(IMAGE_OMITTED);
			} else if (type === "text" && typeof text === "string" && (rest === undefined || isSize(rest))) {
				// An honest guest sends at most HEAD_CHARS of text in all, then only sizes.
				this.#crossed += text.length;
				if (this.#crossed > HEAD_CHARS) return this.#broken("the output crossed past its head");
				this.output.add(text, rest);
				// Sizes the guest claims for what did not cross only count; past what today's limits allow, they are not honest.
				if (this.output.total.bytes > OUTPUT_BYTES_MAX) return this.#broken("the output is larger than its limits allow");
			} else return this.#broken("a printed item is malformed");
			if (++this.#items > MAX_OUTPUT_ITEMS) {
				// The prelude fails the script itself before this; a guest that did not is stopped as it would have failed.
				this.stop({ kind: "script", message: OUTPUT_LIMIT, stack: `RangeError: ${OUTPUT_LIMIT}` });
				return this.#late(undefined);
			}
		}
		return Promise.resolve();
	}

	#broken(detail: string): Promise<void> {
		this.stop({ kind: "sandbox", message: BRIDGE_BROKEN(detail) });
		return this.#late(undefined);
	}
}
