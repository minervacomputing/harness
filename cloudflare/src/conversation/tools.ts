// The run's connector tools in the `minerva` extension, from the executor's declarations (names,
// descriptions and input schemas from the registry, by the run's snapshot):
//
// - a tool whose `readOnlyHint` is true is a read: replayed after a crash (`replay: "safe"`) and run in
//   parallel; any other is a write: never replayed (`unsafe`) and `sequential`, which makes its whole round
//   run one call at a time;
// - results up to 1 MiB with no line limit, so the paging fields the executor adds are never cut;
// - a safe call pi replays more than twice is answered with an error instead of running again (the replay
//   cap; the counter is in SQLite, so it survives the restarts it counts);
// - every call goes through the run's queue (4 at once, writes one at a time) and then the executor;
// - what the model sees is the result's JSON, or the error's message with `isError`; the `tool_call` event
//   comes from the executor's outcome, appended when the call completes while the run is active, never
//   for RUN_ENDED.
//
// pi-ai parsed the arguments with `JSON.parse`; the model wrapper already put `parseJson`'s reading of the
// model's text into the call before pi validated and stored it (model/provider.ts). pi reads its stored
// calls back with `JSON.parse`, though, so a read replayed after a restart reads the text again here, from
// SQLite, with `parseJson` and pi-ai's own validation (which coerces). The text
// is kept only when it holds a backslash, since a key without an escape parses right either way. Without it
// (a provider that sent no deltas), pi's parse is used.
//
// `modelTools` in gateway/tools.ts orders the local tools (read, write, edit, bash, `run_script`) with
// these, and `run_script` shares the run's queue.

import { type TSchema, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolCallOutcome, ToolDeclaration } from "../gateway/executor.ts";
import { TOOL_RESULT_LIMITS as GATEWAY_RESULT_LIMITS } from "../gateway/results.ts";
import { type Json, parseJson } from "../lib/json.ts";
import type { AttemptFence, EpochMs, RunId } from "../shared/rpc.ts";
import { untilAborted } from "./queue.ts";

export const TOOL_RESULT_BYTES = 1024 * 1024;
/** Results up to 1 MiB with no line limit, the head kept (gateway/results.ts). */
export const TOOL_RESULT_LIMITS = GATEWAY_RESULT_LIMITS;
/** A safe call may run again after a crash this many times; the next execution is refused. */
export const REPLAYS_ALLOWED = 2;
export const REPLAY_REFUSED = "This call was interrupted too often to run again. Ask again if it is still needed.";
/** RUN_ENDED's message. */
export const RUN_ENDED_MESSAGE = "This run is no longer active.";

/** What a tool needs from the run that makes the call. */
export interface ToolHost {
	/** The run a pi session belongs to and its current attempt, when that attempt can still act. */
	current(session: number): { fence: AttemptFence; deadline: EpochMs | null } | null;
	/** Counts this execution of a call, this one included; the count is committed before the call runs. */
	executions(runId: RunId, callId: string): number | Promise<number>;
	/** The model's own argument text for a call, when the wrapper kept it. */
	argumentText(runId: RunId, callId: string): string | null;
	/** The call, through the run's queue and the executor; settles even after its caller stopped waiting. */
	invoke(fence: AttemptFence, declaration: ToolDeclaration, args: Json | undefined, signal: AbortSignal | undefined): Promise<ToolCallOutcome>;
	/** Phases: a call started and ended. */
	started(runId: RunId, callId: string, name: string): void;
	ended(runId: RunId, callId: string): void;
}

/** What the model sees of an outcome. */
export function render(outcome: ToolCallOutcome): ToolExecutionResult {
	if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.result) }], isError: false };
	return { content: [{ type: "text", text: outcome.error.message }], isError: true };
}

function refused(text: string): ToolExecutionResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** The tool's JSON Schema as pi validates it: an object, with `properties`. */
export function parametersOf(declaration: ToolDeclaration): TSchema {
	const schema = declaration.inputSchema;
	return { ...schema, type: "object", properties: schema.properties ?? {} } as unknown as TSchema;
}

export function isWrite(declaration: ToolDeclaration): boolean {
	return declaration.annotations.readOnlyHint !== true;
}

/**
 * The arguments the executor gets: the model's text parsed with `parseJson` and validated as pi validates
 * (coercing as pi-ai does), or pi's own parse when there is no text or it does not parse. A text that parses
 * but fails validation throws pi-ai's validation error, which pi reports to the model.
 */
export function argumentsOf(registration: ToolRegistration, callId: string, parsed: unknown, text: string | null): Json | undefined {
	if (text === null) return parsed as Json | undefined;
	let reparsed: Json;
	try {
		reparsed = parseJson(text);
	} catch {
		return parsed as Json | undefined;
	}
	const call: ToolCall = { type: "toolCall", id: callId, name: registration.name, arguments: reparsed as never };
	return validateToolArguments(registration, call) as Json;
}

/** The registration of one connector tool. */
export function connectorTool(declaration: ToolDeclaration, host: ToolHost): ToolRegistration {
	const write = isWrite(declaration);
	const registration: ToolRegistration = {
		name: declaration.name,
		description: declaration.description || declaration.title || declaration.name,
		parameters: parametersOf(declaration),
		executionMode: write ? "sequential" : "parallel",
		replay: write ? "unsafe" : "safe",
		outputLimits: TOOL_RESULT_LIMITS,
		async execute(args: unknown, api: ToolExecutionApi, context): Promise<ToolExecutionResult> {
			const run = host.current(api.conversationId);
			if (run === null) return refused(RUN_ENDED_MESSAGE);
			const { fence } = run;
			if (!write && (await host.executions(fence.runId, api.callId)) > 1 + REPLAYS_ALLOWED) return refused(REPLAY_REFUSED);
			const input = argumentsOf(registration, api.callId, args, host.argumentText(fence.runId, api.callId));
			host.started(fence.runId, api.callId, declaration.name);
			try {
				const outcome = await untilAborted(withinDeadline(host.invoke(fence, declaration, input, context.abortSignal), run.deadline), context.abortSignal);
				return render(outcome);
			} finally {
				host.ended(fence.runId, api.callId);
			}
		},
	};
	return registration;
}

const ENDED: ToolCallOutcome = { ok: false, error: { code: "RUN_ENDED", message: RUN_ENDED_MESSAGE }, event: null };

/** A call still waiting when the run's deadline passes gives up with RUN_ENDED; it never starts. */
function withinDeadline(call: Promise<ToolCallOutcome>, deadline: EpochMs | null): Promise<ToolCallOutcome> {
	if (deadline === null) return call;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(ENDED), Math.max(0, deadline - Date.now()));
		call.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}
