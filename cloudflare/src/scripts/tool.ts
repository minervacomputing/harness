// `run_script` in the `minerva` extension: offered when the run has a connector
// tool, after the direct ones (gateway/tools.ts `modelTools`); scripts can call every connector tool of the
// run, those past the direct cap included. Never replayed (a script may have written before it was
// interrupted) and `sequential`, so a round with a script runs one call at a time; its result up to 1 MiB
// with no line limit, as the direct tools'.
//
// What the model sees, in order: the failure (clipped to 30,000 characters), the cancelled
// calls, the store's refusal, the printed output (images as "[image omitted]"), then the returned value, or
// "The script printed and returned nothing."; `isError` when the script failed. A result past 1 MiB is cut
// as pi cuts it, with pi's note (scripts/output.ts).
//
// `store()` values live in a pi document of the run's own pi conversation (one per run, so one per turn),
// saved only when the script succeeded: committed with the turn's state, so a resumed attempt's scripts see
// them. Its entries are `[key, JSON text]` pairs: pairs so a key such as `__proto__` stays a key, and text
// so pi's own reading of its rows (JSON.parse, lib/json.ts) never meets a value's keys.

import type { TSchema } from "@earendil-works/pi-ai";
import { defineDoc, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AttemptFence, EpochMs, RunId } from "../contracts/common.ts";
import type { ToolDeclaration } from "../contracts/executor.ts";
import type { ScriptControl, ScriptResult, ScriptText, ScriptTools } from "../contracts/scripts.ts";
import { clip } from "../conversation/history.ts";
import { TOOL_RESULT_LIMITS } from "../gateway/results.ts";
import { RUN_ENDED_MESSAGE } from "../gateway/ledger.ts";
import { parseJson } from "../lib/json.ts";
import { uuid7 } from "../lib/random.ts";
import { scriptDescription } from "./description.ts";
import { CANCELLED_NOTE, NOTHING, SCRIPT_TOOL, STORE_BYTES, STORE_TOO_LARGE, STORE_UNCONVERTIBLE } from "./limits.ts";
import { bound, sizeOf } from "./output.ts";
import { executeScript, type ScriptLane, type ScriptsClient, scriptCpuMs, scriptTimeoutMs } from "./run.ts";
import type { ScriptCallPort, ScriptCalls, ScriptSession } from "./session.ts";

type Context = Parameters<ToolRegistration["execute"]>[2];


/** The turn's `store()` values (worker/src/script-store.ts), in the run's pi conversation. */
export const SCRIPT_STORE = defineDoc<{ entries: [string, string][] }>({
	kind: "minerva.script-store",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ entries: [] }),
});

/** What `run_script` needs from the conversation (scripts/host.ts builds it). */
export interface ScriptToolHost {
	/** The run a pi session belongs to and its current attempt, when that attempt can still act; `signal` is the run's end. */
	current(session: number): { fence: AttemptFence; deadline: EpochMs | null; signal: AbortSignal } | null;
	/** The run's scripted calls across its scripts, in this instance. */
	calls(runId: RunId): ScriptCalls;
	/** Scripted calls of the attempt through the run's queue and the executor. */
	port(fence: AttemptFence): ScriptCallPort;
	/** The conversation's Scripts object, a new stub each time. */
	scripts(): ScriptsClient;
	/** The conversation's scripts, one after another. */
	lane: ScriptLane;
	/** The RpcTargets of a session (scripts/target.ts). */
	targets(session: ScriptSession): { tools: ScriptTools; control: ScriptControl };
	waitUntil(promise: Promise<unknown>): void;
	/** Phases: "Running a script" while one runs. */
	started(runId: RunId, callId: string, name: string): void;
	ended(runId: RunId, callId: string): void;
	/** For the tests: each script's session. */
	onSession?(session: ScriptSession): void;
}

const PARAMETERS = {
	type: "object",
	properties: { code: { type: "string", description: "JavaScript source." } },
	required: ["code"],
} as const;

/** The values earlier scripts of this run stored, as the guest gets them: `[key, JSON text]`. */
export async function loadStore(api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, context: Context): Promise<[string, string][]> {
	const doc = await api.snapshot(SCRIPT_STORE, api.conversationId, context);
	return (doc?.entries ?? []).map(([key, json]) => [key, json]);
}

class TooLarge extends Error {}

/** UTF-8 bytes of the values' JSON as one object, `{"key":value,…}`, which the 1 MiB limit counts. */
function storeBytes(entries: ReadonlyMap<string, string>): number {
	let bytes = 2 + Math.max(0, entries.size - 1);
	for (const [key, json] of entries) bytes += sizeOf(JSON.stringify(key)).bytes + 1 + sizeOf(json).bytes;
	return bytes;
}

/** Saves what a script stored: deletes, then sets, each value's JSON written again as JavaScript writes it. Returns why it was not kept, if it was not. */
export async function saveStore(
	api: Pick<ToolExecutionApi, "commit" | "conversationId">,
	writes: ScriptResult["storeWrites"],
	context: Context,
): Promise<string | undefined> {
	if (!writes.delete.length && !writes.set.length) return undefined;
	let set: [string, string][];
	try {
		set = writes.set.map(([key, json]) => {
			const written = JSON.stringify(parseJson(json));
			if (written === undefined) throw new TypeError("not JSON");
			return [key, written];
		});
	} catch {
		return STORE_UNCONVERTIBLE;
	}
	try {
		await api.commit(async (tx) => {
			const doc = await tx.doc(SCRIPT_STORE, api.conversationId);
			const values = new Map<string, string>(doc.entries.map(([key, json]) => [key, json]));
			for (const key of writes.delete) values.delete(key);
			for (const [key, json] of set) values.set(key, json);
			if (storeBytes(values) > STORE_BYTES) throw new TooLarge();
			doc.entries = [...values];
		}, context);
	} catch (error) {
		if (!(error instanceof TooLarge)) throw error;
		return STORE_TOO_LARGE;
	}
	return undefined;
}

/** What the model sees of a result, with the store saved first when the script succeeded. */
export async function render(result: ScriptResult, save: (writes: ScriptResult["storeWrites"]) => Promise<string | undefined>): Promise<ToolExecutionResult> {
	// Notes come first, where cutting a long result cannot drop them.
	const notes: string[] = [];
	if (!result.ok && result.error) notes.push(clip(`Script failed: ${result.error.stack ?? result.error.message}`));
	if (result.cancelled) notes.push(CANCELLED_NOTE(result.cancelled));
	if (result.ok) {
		const unkept = await save(result.storeWrites);
		if (unkept) notes.push(unkept);
	}
	const pieces: ScriptText[] = [...notes.map((text) => ({ text })), ...result.output];
	if (result.ok && result.value !== undefined) pieces.push(result.value);
	const bounded = bound(pieces, TOOL_RESULT_LIMITS.maxBytes);
	const texts = bounded.texts.length ? bounded.texts : [NOTHING];
	return {
		content: texts.map((text) => ({ type: "text" as const, text })),
		isError: !result.ok,
		...(bounded.diagnostic ? { diagnostics: [bounded.diagnostic] } : {}),
	};
}

/** The registration of `run_script` for a run's connector tools, all of them, in the run's order. */
export function scriptTool(listed: readonly ToolDeclaration[], host: ScriptToolHost): ToolRegistration {
	const tools = new Map<string, ToolDeclaration>();
	for (const declaration of listed) if (!tools.has(declaration.name)) tools.set(declaration.name, declaration);
	return {
		name: SCRIPT_TOOL,
		description: scriptDescription([...tools.values()]),
		parameters: PARAMETERS as unknown as TSchema,
		executionMode: "sequential",
		// A script may have made writes before it was interrupted.
		replay: "unsafe",
		outputLimits: TOOL_RESULT_LIMITS,
		async execute(args: unknown, api: ToolExecutionApi, context): Promise<ToolExecutionResult> {
			const run = host.current(api.conversationId);
			if (run === null) return { content: [{ type: "text", text: RUN_ENDED_MESSAGE }], isError: true };
			const { fence } = run;
			const code = String((args as { code?: unknown } | null)?.code ?? "");
			const store = await loadStore(api, context);
			host.started(fence.runId, api.callId, SCRIPT_TOOL);
			try {
				const timeoutMs = scriptTimeoutMs(run.deadline);
				const result = await executeScript({
					fence: { ...fence, scriptId: uuid7() },
					code,
					tools,
					store,
					timeoutMs,
					cpuMs: scriptCpuMs(timeoutMs),
					signal: context.abortSignal ? AbortSignal.any([context.abortSignal, run.signal]) : run.signal,
					calls: host.calls(fence.runId),
					port: host.port(fence),
					scripts: () => host.scripts(),
					lane: host.lane,
					targets: (session) => host.targets(session),
					waitUntil: (promise) => host.waitUntil(promise),
					onSession: host.onSession ? (session) => host.onSession?.(session) : undefined,
				});
				return await render(result, (writes) => saveStore(api, writes, context));
			} finally {
				host.ended(fence.runId, api.callId);
			}
		},
	};
}
