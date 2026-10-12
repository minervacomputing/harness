// What the Conversation Durable Object keeps for code mode, and the `ScriptToolHost` it gives `run_script`
// (scripts/tool.ts): per run, its scripted calls across its scripts (today's `open`, per worker, so per
// instance here); per instance, the lane that puts each script after the reset of the one before.

import type { AttemptFence, EpochMs, Json, RunId } from "../contracts/common.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../contracts/executor.ts";
import { ScriptLane, type ScriptsClient } from "./run.ts";
import { ScriptCalls } from "./session.ts";
import { targetsOf } from "./target.ts";
import type { ScriptToolHost } from "./tool.ts";

export class ScriptRuns {
	readonly lane = new ScriptLane();
	readonly #calls = new Map<RunId, ScriptCalls>();

	calls(runId: RunId): ScriptCalls {
		let calls = this.#calls.get(runId);
		if (!calls) this.#calls.set(runId, (calls = new ScriptCalls()));
		return calls;
	}

	/** The run ended; calls still running keep counting on the object they hold. */
	forget(runId: RunId): void {
		this.#calls.delete(runId);
	}
}

/** What the conversation lends: its connector tools' host and a few of its own parts. */
export interface ScriptHostDeps {
	runs: ScriptRuns;
	current(session: number): { fence: AttemptFence; deadline: EpochMs | null } | null;
	/** Aborted when the run ends or its deadline passes. */
	runSignal(runId: RunId): AbortSignal;
	/** A call through the run's queue and the executor; `drop` is checked only before it is sent. */
	invoke(fence: AttemptFence, declaration: ToolDeclaration, args: Json | undefined, drop: AbortSignal): Promise<ToolCallOutcome>;
	scripts(): ScriptsClient;
	waitUntil(promise: Promise<unknown>): void;
	started(runId: RunId, callId: string, name: string): void;
	ended(runId: RunId, callId: string): void;
}

export function scriptToolHost(deps: ScriptHostDeps): ScriptToolHost {
	return {
		current: (session) => {
			const run = deps.current(session);
			return run && { ...run, signal: deps.runSignal(run.fence.runId) };
		},
		calls: (runId) => deps.runs.calls(runId),
		port: (fence) => ({ invoke: (declaration, args, drop) => deps.invoke(fence, declaration, args, drop) }),
		scripts: () => deps.scripts(),
		lane: deps.runs.lane,
		targets: (session) => targetsOf(session),
		waitUntil: (promise) => deps.waitUntil(promise),
		started: (runId, callId, name) => deps.started(runId, callId, name),
		ended: (runId, callId) => deps.ended(runId, callId),
	};
}
