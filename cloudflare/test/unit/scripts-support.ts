// Code mode's guest in Node, for the unit tests: the prelude (src/scripts/prelude.ts) evaluated in a realm
// of its own (`node:vm`), so its lockdown freezes that realm's built-ins and never the test runner's. The
// realm gets timers and queueMicrotask through wrappers made inside it, so nothing of this realm is reachable
// from its globals. The script module is the one the guest gets, wrapped the same way.

import { constants, createContext, runInContext } from "node:vm";
import type { ToolCallOutcome, ToolDeclaration } from "../../src/gateway/executor.ts";
import type { Json } from "../../src/lib/json.ts";
import type { ScriptsClient } from "../../src/scripts/run.ts";
import { type GuestOutcome, guestOutcome } from "../../src/scripts/outcome.ts";
import { GUEST_CORE, SCRIPT_PREFIX, SCRIPT_SUFFIX } from "../../src/scripts/prelude.ts";
import { RESET_REASON } from "../../src/scripts/limits.ts";
import type { ScriptFence, ScriptRequest } from "../../src/scripts/scripts.ts";
import type { ScriptControl, ScriptTools } from "../../src/scripts/target.ts";

export interface Guest {
	/** What `run()` answered, as the guest sent it (not yet checked). */
	answer: Promise<unknown>;
	/** The realm's globals, to look at what the script left. */
	global: { [key: string]: unknown };
}

/** Runs the guest's `run()` in a new realm, as the Dynamic Worker would. */
export function runInRealm(code: string, host: ScriptTools, tools: ScriptRequest["tools"], store: ScriptRequest["store"] = []): Guest {
	// An ordinary global object: a contextified one copies a redefined global as undefined.
	const context = createContext(constants.DONT_CONTEXTIFY);
	const install = runInContext(
		`(function (timeout, clear, microtask) {
			globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms, ...args);
			globalThis.clearTimeout = (id) => clear(id);
			globalThis.queueMicrotask = (fn) => microtask(fn);
		})`,
		context,
	) as (timeout: typeof setTimeout, clear: typeof clearTimeout, microtask: typeof queueMicrotask) => void;
	install(setTimeout, clearTimeout, queueMicrotask);
	// The CommonJS module's text, as the guest's loader would run it (scripts/prelude.ts SCRIPT_PREFIX).
	const moduleText = `${SCRIPT_PREFIX}${code}${SCRIPT_SUFFIX}`.replace(/^module\.exports = /, "(").replace(/;\n$/, ")");
	const factory = runInContext(moduleText, context, { filename: "codemode.js" }) as () => unknown;
	const core = runInContext(GUEST_CORE, context, { filename: "codemode-prelude.js" }) as (
		host: ScriptTools,
		script: () => unknown,
		tools: ScriptRequest["tools"],
		store: ScriptRequest["store"],
	) => Promise<unknown>;
	return { answer: core(host, factory, tools, store), global: runInContext("globalThis", context) as { [key: string]: unknown } };
}

/** The tools of the tests: `name` and its identifier. */
export function toolList(names: string[]): ScriptRequest["tools"] {
	return names.map((name) => ({ name, identifier: name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[0-9]/, "_") }));
}

export function declaration(name: string, write = false): ToolDeclaration {
	return {
		name,
		title: name,
		description: `${name}.`,
		inputSchema: { type: "object", properties: { n: { type: "integer" }, cursor: { type: "string" } }, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: { items: { type: "array", items: { type: "object" } }, count: { type: "integer" } },
			required: ["items", "count"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: !write },
	};
}

export function ok(items: { [key: string]: Json }[]): ToolCallOutcome {
	return { ok: true, result: { items, count: items.length }, images: [], title: "t", repeat: false, writeKey: null, event: null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Scripts object in Node: runs the guest in a realm and checks its answer as the object does; a stop or a
 * reset ends the call with the reset's error, as the object's reset does (the realm's guest is only cut off,
 * not ended: its later calls are late).
 */
export class FakeScripts implements ScriptsClient {
	readonly runs: { fence: ScriptFence; request: ScriptRequest }[] = [];
	readonly resets: { runId: string; attempt: number; at: number }[] = [];
	/** Runs and resets, in the order they came. */
	readonly order: ("run" | "reset")[] = [];
	/** Delay before a reset answers, to hold the lane. */
	resetDelayMs = 0;
	newest: { runId: string; attempt: number } | null = null;
	#abort: (() => void) | null = null;
	guests: Guest[] = [];

	#stale(fence: { runId: string; attempt: number }): boolean {
		const newest = this.newest;
		if (newest && (fence.runId < newest.runId || (fence.runId === newest.runId && fence.attempt < newest.attempt))) return true;
		this.newest = { runId: fence.runId, attempt: fence.attempt };
		return false;
	}

	async run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools, control: ScriptControl): Promise<GuestOutcome | { refused: "stale" }> {
		this.runs.push({ fence, request: script });
		this.order.push("run");
		if (this.#stale(fence)) return { refused: "stale" };
		const guest = runInRealm(script.code, tools, script.tools, script.store);
		this.guests.push(guest);
		const aborted = new Promise<never>((_resolve, reject) => {
			this.#abort = () => reject(Object.assign(new Error(RESET_REASON), { durableObjectReset: true }));
		});
		void Promise.resolve(control.stopped()).then(() => this.#abort?.());
		return await Promise.race([guest.answer.then(guestOutcome), aborted]);
	}

	/** Resets that fail as an unreachable object's would, before one succeeds. */
	failResets = 0;

	async reset(fence: { runId: string; attempt: number }): Promise<{ reset: true } | { refused: "stale" }> {
		if (this.#stale(fence)) return { refused: "stale" };
		this.resets.push({ ...fence, at: Date.now() });
		this.order.push("reset");
		if (this.failResets > 0) {
			this.failResets--;
			throw new Error("Network connection lost.");
		}
		if (this.resetDelayMs) await sleep(this.resetDelayMs);
		this.#abort?.();
		throw Object.assign(new Error(RESET_REASON), { durableObjectReset: true });
	}
}
