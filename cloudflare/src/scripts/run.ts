// One `run_script` execution from the conversation's side (ARCHITECTURE.md: Code mode): the syntax
// check, the session and its RpcTargets, the Scripts object's run, and the wall clock, which the
// conversation enforces itself (120 s cut to the deadline), never the loaded guest.
//
// When the host stops waiting (the wall clock, pi's abort, a script stopped for its refusals or its
// output), the session is stopped first: later calls and prints never settle, a call still waiting for its
// slot is dropped, calls already sent run to their end, and a write still settles and is recorded. The
// Scripts object hears of the stop and resets itself, which ends the guest. After every script, stopped or
// not, the conversation also resets the Scripts object with the script's fence, which ends whatever the
// guest left running (timers, unawaited work) and frees its Dynamic Worker slot; the conversation's next
// script waits for that reset (the lane), within its own wall clock, so a late reset cannot tear it down.
// The result does not wait for the reset.

import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ToolDeclaration } from "../gateway/executor.ts";
import { RUN_ENDED_MESSAGE } from "../gateway/ledger.ts";
import { ABORTED, CALL_TIMEOUT_MS, ERROR_CHARS, RESET_FAILED, RESET_REASON, SANDBOX_FAILED, SCRIPT_CALLS_OPEN, SCRIPT_CPU_MS, SCRIPT_TIMEOUT_MS, TIMED_OUT } from "./limits.ts";
import type { GuestOutcome, ScriptError, ScriptStoreWrites } from "./outcome.ts";
import { type ScriptText, headUnits } from "./output.ts";
import type { ScriptFence, ScriptRequest } from "./scripts.ts";
import { type ScriptCallPort, type ScriptCalls, ScriptSession, type Stop } from "./session.ts";
import { syntaxError } from "./syntax.ts";
import type { ScriptControl, ScriptTools } from "./target.ts";

/**
 * pi-codemode's result contract, which `run_script`'s rendering reads: notes first (a
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

/** The Scripts Durable Object as the conversation calls it: a new stub for each call, since a reset breaks the old one. */
export interface ScriptsClient {
	run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools, control: ScriptControl): Promise<GuestOutcome | { refused: "stale" }>;
	reset(fence: ScriptFence, answered?: boolean): Promise<{ reset: true } | { refused: "stale" }>;
}

export type ResetResult = "reset" | "stale" | "failed";

/**
 * The conversation's scripts, one after another: each waits for the reset that followed the one before,
 * and tries it again if it failed. While it keeps failing no script runs, so what the one before left
 * running cannot pile up beside new ones.
 */
export class ScriptLane {
	#reset: Promise<ResetResult> = Promise.resolve("reset");
	#again: () => Promise<ResetResult> = () => Promise.resolve("reset");

	/** The last script's reset, tried again first if it failed; "failed" means no script may run. */
	ready(): Promise<ResetResult> {
		const again = this.#again;
		this.#reset = this.#reset.then((result) => (result === "failed" ? again() : result));
		return this.#reset;
	}

	/** The reset the next script waits for, and how to try it again. */
	after(reset: Promise<ResetResult>, again: () => Promise<ResetResult>): void {
		this.#reset = reset.catch((): ResetResult => "failed");
		this.#again = () => again().catch((): ResetResult => "failed");
	}
}

export interface ExecuteOptions {
	fence: ScriptFence;
	code: string;
	/** Every connector tool of the run, by name, in the run's order. */
	tools: ReadonlyMap<string, ToolDeclaration>;
	store: [string, string][];
	timeoutMs: number;
	cpuMs: number;
	/** pi's abort for the call, and the run's end. */
	signal?: AbortSignal;
	calls: ScriptCalls;
	port: ScriptCallPort;
	scripts: () => ScriptsClient;
	lane: ScriptLane;
	/** The guest's capability and the Scripts object's control: RpcTargets in the Worker (scripts/target.ts), plain objects in unit tests. */
	targets: (session: ScriptSession) => { tools: ScriptTools; control: ScriptControl };
	/** Keeps the reset going after the result is returned. */
	waitUntil: (promise: Promise<unknown>) => void;
	/** For the tests: the session, once made. */
	onSession?: (session: ScriptSession) => void;
}

/** A call's time: no deadline gives the 10-minute call timeout; otherwise what is left, at least 1 s. */
export function remainingMs(deadline: number | null, now = Date.now()): number {
	if (deadline === null) return CALL_TIMEOUT_MS;
	if (!Number.isFinite(deadline)) return 60_000;
	return Math.max(1000, deadline - now);
}

/** The wall clock's length: 120 s. The platform tests shorten it; nothing else changes it. */
export const SCRIPT_CLOCK = { timeoutMs: SCRIPT_TIMEOUT_MS };

/** The wall clock of a script: 120 s, or less when the run's deadline is nearer. */
export function scriptTimeoutMs(deadline: number | null, now = Date.now()): number {
	return Math.min(SCRIPT_CLOCK.timeoutMs, remainingMs(deadline, now));
}

/** The guest's CPU limit: 30 s, or the wall clock when that is shorter, so a guest stopped for time is not left computing. */
export function scriptCpuMs(timeoutMs: number): number {
	return Math.max(1000, Math.min(SCRIPT_CPU_MS, timeoutMs));
}

const RESET_TRIES = 3;
/**
 * How long one reset may take: the Scripts object may be computing for a CPU-bound guest until the platform
 * stops it, measured up to 8 s past its limit. A reset that answers later is harmless: it is refused once a
 * later script loaded there.
 */
const RESET_WAIT_MS = SCRIPT_CPU_MS + 15_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms.`)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** Whether an error is the platform's report that the called object was reset (the reset done). */
export function isReset(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (error as { durableObjectReset?: unknown }).durableObjectReset === true || error.message.includes(RESET_REASON);
}

/**
 * Resets the Scripts object after the fence's script, tried again when the call fails for another reason or
 * takes too long. `answered`: the script's run came back, so it cannot still be on its way.
 */
export async function resetScripts(scripts: () => ScriptsClient, fence: ScriptFence, answered = false, waitMs = RESET_WAIT_MS): Promise<ResetResult> {
	for (let attempt = 0; attempt < RESET_TRIES; attempt++) {
		try {
			const answer = await within(scripts().reset({ runId: fence.runId, attempt: fence.attempt, scriptId: fence.scriptId }, answered), waitMs);
			return "refused" in answer ? "stale" : "reset";
		} catch (error) {
			if (isReset(error)) return "reset";
		}
	}
	return "failed";
}

function reasonOf(signal: AbortSignal): string {
	const reason = signal.reason as unknown;
	return reason instanceof Error ? reason.message : ABORTED;
}

/** The tools as the guest offers them: each with its identifier (pi-codemode's host passed `jsName`). */
export function toolList(tools: ReadonlyMap<string, ToolDeclaration>): ScriptRequest["tools"] {
	return [...tools.keys()].map((name) => ({ name, identifier: toCodemodeIdentifier(name) }));
}

function failed(error: ScriptError, session: ScriptSession | null, cancelled = 0): ScriptResult {
	return { ok: false, error, output: session ? session.output.pieces() : [], cancelled, storeWrites: { set: [], delete: [] } };
}

/** Calls that had not settled: as the script saw them when it answered, at most as many as can be open. */
function cancelledOf(session: ScriptSession, unsettled: number): number {
	return Math.min(SCRIPT_CALLS_OPEN, Math.max(unsettled, session.pending()));
}

/** Runs one script and gives its result; never throws for what the script or the platform did. */
export async function executeScript(options: ExecuteOptions): Promise<ScriptResult> {
	const invalid = syntaxError(options.code);
	if (invalid) return failed({ kind: "script", message: invalid.message, stack: invalid.stack }, null);
	const signal = options.signal;
	if (signal?.aborted) return failed({ kind: "aborted", message: reasonOf(signal) }, null);
	const session = new ScriptSession(options.calls, options.tools, options.port);
	options.onSession?.(session);
	const timer = setTimeout(() => session.stop({ kind: "timeout", message: TIMED_OUT(options.timeoutMs) }), options.timeoutMs);
	const abort = () => session.stop({ kind: "aborted", message: reasonOf(signal as AbortSignal) });
	signal?.addEventListener("abort", abort, { once: true });
	const stopped = session.stopped().then((stop) => ({ stopped: stop }));
	try {
		// The previous script's reset first; waiting for it counts against this script's wall clock.
		const ready = await Promise.race([options.lane.ready(), stopped]);
		if (typeof ready === "object") return failed(ready.stopped, session);
		if (ready === "failed") return failed({ kind: "sandbox", message: RESET_FAILED }, session);
		const { tools, control } = options.targets(session);
		const request: ScriptRequest = { code: options.code, tools: toolList(options.tools), store: options.store, cpuMs: options.cpuMs };
		const answered: Promise<Answer> = Promise.resolve()
			.then(() => options.scripts().run(options.fence, request, tools, control))
			.then(
				(answer) => ({ answer }),
				(thrown: unknown) => ({ thrown }),
			);
		// Whatever happens, the object is reset once the script answered or was stopped, and the next one waits for it.
		const first = Promise.race([answered, stopped]);
		const reset = first.then((what) => resetScripts(options.scripts, options.fence, "answer" in what));
		options.lane.after(reset, () => first.then((what) => resetScripts(options.scripts, options.fence, "answer" in what)));
		options.waitUntil(reset);
		return settle(await first, session);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

type Answer = { answer: GuestOutcome | { refused: "stale" } } | { thrown: unknown } | { stopped: Stop };

/** The result of what came first: the guest's answer, the object's failure, or the host's stop. */
function settle(first: Answer, session: ScriptSession): ScriptResult {
	if ("stopped" in first) return failed(first.stopped, session, session.pending());
	if ("thrown" in first) {
		// The Scripts object failed while the script ran: what the guest did is unknown, so it is stopped.
		const message = first.thrown instanceof Error ? first.thrown.message : String(first.thrown);
		session.stop({ kind: "sandbox", message: SANDBOX_FAILED(headUnits(message, ERROR_CHARS)) });
		return failed(session.stopReason as Stop, session, session.pending());
	}
	session.end();
	const answer = first.answer;
	if ("refused" in answer) return failed({ kind: "aborted", message: RUN_ENDED_MESSAGE }, session);
	if (!answer.ok) return failed(answer.error, session, cancelledOf(session, answer.unsettled));
	return {
		ok: true,
		...(answer.value !== undefined ? { value: answer.value } : {}),
		output: session.output.pieces(),
		cancelled: cancelledOf(session, answer.unsettled),
		storeWrites: answer.writes,
	};
}
