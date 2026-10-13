// The tools that work in the run's folder: pi-durable's own `read`, `write`, `edit` and `bash` (plan:
// Checkpoints, The local tools). They run in the
// conversation's container through the ExecutionEnv the call is given (src/sandbox/env.ts); this module
// holds what decides when their results reach pi.
//
// A local call's result is held until a checkpoint has saved the folder, so whatever pi records happened in
// a folder the store has. Checkpoints run at quiet moments: once no local
// call is running and some are waiting. Calls that arrive meanwhile wait for the checkpoint to end before
// they start, so nothing changes the folder while it is scanned. A round that only read needs none. A
// checkpoint that fails ends the attempt (`fail`, which resets the object before any held result is
// released, so pi never commits one), and a folder over its limits fails the turn.
//
// Plain TypeScript over its ports, so the unit tests run it with fakes, against pi's Node environment, and
// against the real container in Docker.

import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { FolderLimit } from "../files/limits.ts";
import { commandEnvironment } from "../sandbox/constants.ts";
import { EXCERPT_CHARS, head, type LocalToolEventData, storable, SUMMARY_CHARS, tail } from "./events.ts";
import { untilAborted } from "./queue.ts";

export const LOCAL_TOOLS = ["read", "write", "edit", "bash"] as const;
export type LocalToolName = (typeof LOCAL_TOOLS)[number];

/** A command stops after this long unless it asks for longer. */
export const COMMAND_TIMEOUT_S = 600;
/**
 * A command whose call has not settled this long after its timeout is stuck, for example on output that a
 * process it started keeps writing. Every other process is then killed.
 */
export const STUCK_AFTER_TIMEOUT_MS = 60_000;
/** How long a file tool may take before it counts as stuck. */
export const FILE_TOOL_STUCK_MS = 120_000;
/** How long a stuck call has to settle once every other process is gone, before the attempt ends. */
export const STUCK_GRACE_MS = 10_000;
/**
 * How long the Sandbox may take to kill every process for a stuck call before the attempt ends anyway: its
 * own bounds (the starts it waits for, then the kill) come to 20 s.
 */
export const STRAYS_KILL_MS = 30_000;
/** setTimeout fires at once for longer delays. */
const MAX_TIMER_MS = 2_147_483_647;
/** The bash tool's own timeout description, with its default. */
export const TIMEOUT_DESCRIPTION = `Timeout in seconds (optional, ${COMMAND_TIMEOUT_S} by default)`;
export const OUT_OF_TIME = "The turn has run out of time.";

/** A local call that would not stop, or processes that would not die. The next attempt reports the call as interrupted. */
export class LocalToolStuck extends Error {
	override readonly name = "LocalToolStuck";
}

/** The folder is over one of its limits: the turn fails with `folder_limit` and that limit's message. */
export class FolderOverLimit extends Error {
	override readonly name = "FolderOverLimit";
	readonly limit: FolderLimit;

	constructor(limit: FolderLimit, message = `The folder is over its ${limit} limit.`) {
		super(message);
		this.limit = limit;
	}
}

/** The folder could not be loaded or saved, or the container is gone or in doubt: the attempt ends. */
export class FolderUnavailable extends Error {
	override readonly name = "FolderUnavailable";
}

/** The container failed its hardening or its verification: the turn fails (plan: The sandbox lifecycle). */
export class SandboxRefused extends Error {
	override readonly name = "SandboxRefused";
}

/** What the chat shows of a local call: written from its arguments and output, so as untrusted as either. */
export type LocalToolEvent = LocalToolEventData;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T = void>(): Deferred<T> {
	const made = Promise.withResolvers<T>();
	// A batch nobody waits for any more (its calls were aborted) must not report an unhandled rejection.
	made.promise.catch(() => {});
	return made;
}

export interface LocalCallsOptions {
	/** Saves the folder. Runs only while no local call is running. */
	checkpoint: (options: { rehashAll?: boolean }) => Promise<void>;
	/** Kills every process of the agent: `cgroup.kill` (plan: Checkpoints, step 3). Rejects when they would not die. */
	killStrays: () => Promise<void>;
	/**
	 * Ends the attempt so that nothing later is recorded. Called once; no held result is released, and no call
	 * admitted, before what it returns has settled.
	 */
	fail: (error: Error) => void | Promise<void>;
	report: (event: LocalToolEvent) => void;
	/** Told when a checkpoint starts and ends. */
	saving?: (active: boolean) => void;
}

/** Admits local calls and runs the checkpoints between them. */
export class LocalCalls {
	readonly #options: LocalCallsOptions;
	#running = 0;
	#active = false;
	/** Whether a call that may change the folder was admitted in this attempt, and since the last checkpoint. */
	#changedEver = false;
	#changed = false;
	/** The calls waiting for the next checkpoint. */
	#next: Deferred<void> | null = null;
	/** Resolved when no checkpoint runs. */
	#open: Deferred<void> = deferred();
	/** The kill a watchdog started, while it runs. */
	#killing: Promise<void> | null = null;
	#failure: Error | undefined;
	/** Settles once `fail` has done its work; every rejection waits for it. */
	#failing: Promise<void> = Promise.resolve();
	/** The final checkpoint, once asked for: one per attempt, however often the turn's end is reconciled. */
	#finishing: Promise<void> | null = null;
	/** Resolved once no call runs; made while the final checkpoint waits for one. */
	#idle: Deferred<void> | null = null;

	constructor(options: LocalCallsOptions) {
		this.#options = options;
		this.#open.resolve();
	}

	/** The attempt's failure, once there is one. */
	get failure(): Error | undefined {
		return this.#failure;
	}

	/** Whether a call that may change the folder was admitted in this attempt. */
	get changedEver(): boolean {
		return this.#changedEver;
	}

	/** Waits for any checkpoint to end, then counts the call as running. `changes`: the call may change the folder. */
	async admit(signal: AbortSignal | undefined, changes: boolean): Promise<void> {
		for (;;) {
			if (this.#failure) return this.#rejected();
			signal?.throwIfAborted();
			if (this.#killing) {
				// A command started now would die with the strays.
				await untilAborted(this.#killing, signal);
				continue;
			}
			if (!this.#active) {
				this.#running++;
				if (changes) this.#changed = this.#changedEver = true;
				return;
			}
			await untilAborted(this.#open.promise, signal);
		}
	}

	/** Stops counting a call. The promise settles once a checkpoint has saved what the call did. */
	release(): Promise<void> {
		this.#running--;
		if (this.#running === 0) this.#wake();
		if (this.#failure) return this.#rejected();
		this.#next ??= deferred();
		const batch = this.#next.promise;
		if (this.#running === 0 && !this.#active) {
			if (this.#changed) this.#start();
			else {
				// Only reads ran since the last checkpoint, and nothing else runs: the folder is as it was saved.
				this.#next.resolve();
				this.#next = null;
			}
		}
		return batch;
	}

	/** Saves the folder once more, rehashing every file, after the turn has its answer; once, however often it is asked. */
	finish(): Promise<void> {
		this.#finishing ??= this.#finish();
		return this.#finishing;
	}

	async #finish(): Promise<void> {
		// Calls still running (an aborted one's command may outlive pi's wait) end first, and so does any
		// checkpoint they ask for, so the final scan never meets a command (plan: Checkpoints, steps 1 and 2).
		for (;;) {
			if (this.#failure) return this.#rejected();
			if (this.#active) await this.#open.promise;
			else if (this.#running > 0) await (this.#idle ??= deferred()).promise;
			else break;
		}
		// Nothing else changes the folder.
		if (!this.#changedEver) return;
		this.#active = true;
		this.#open = deferred();
		try {
			await this.#save({ rehashAll: true });
		} catch (error) {
			this.#failed(error);
			return this.#rejected();
		} finally {
			this.#active = false;
			this.#open.resolve();
		}
	}

	/** Ends the attempt because a call is stuck, or the sandbox could not be had. */
	stuck(error: Error): void {
		this.#failed(error);
		this.#open.resolve();
		this.#wake();
	}

	#wake(): void {
		this.#idle?.resolve();
		this.#idle = null;
	}

	/**
	 * Kills every command, for a call that ran too long. No call is admitted until they are gone. Processes
	 * that cannot be stopped, or a kill that does not answer within STRAYS_KILL_MS, end the attempt. Never
	 * rejects.
	 */
	killStuck(): Promise<void> {
		if (this.#killing) return this.#killing;
		const { promise, resolve } = Promise.withResolvers<void>();
		let over = false;
		const end = (error: Error | null) => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			if (this.#killing === promise) this.#killing = null;
			if (error) this.stuck(error);
			resolve();
		};
		const timer = setTimeout(() => end(new LocalToolStuck("Processes left by commands could not be stopped.")), STRAYS_KILL_MS);
		this.#killing = promise;
		this.#options.killStrays().then(
			() => end(null),
			(error: unknown) => end(error instanceof Error ? error : new Error(String(error))),
		);
		return promise;
	}

	report(event: LocalToolEvent): void {
		this.#options.report(event);
	}

	#start(): void {
		const batch = this.#next as Deferred<void>;
		this.#next = null;
		this.#changed = false;
		this.#active = true;
		this.#open = deferred();
		void this.#save({}).then(
			() => {
				this.#active = false;
				this.#open.resolve();
				batch.resolve();
			},
			(error: unknown) => {
				this.#failed(error);
				this.#rejected().catch((failure: unknown) => batch.reject(failure));
				this.#active = false;
				this.#open.resolve();
			},
		);
	}

	async #save(options: { rehashAll?: boolean }): Promise<void> {
		this.#options.saving?.(true);
		try {
			await this.#options.killStrays();
			await this.#options.checkpoint(options);
		} finally {
			this.#options.saving?.(false);
		}
	}

	/** Records the attempt's failure. `fail` runs first, so no result released after it is recorded. */
	#failed(error: unknown): Error {
		if (!this.#failure) {
			this.#failure = error instanceof Error ? error : new Error(String(error));
			try {
				this.#failing = Promise.resolve(this.#options.fail(this.#failure)).catch(() => {});
			} catch {
				// `fail` ended the attempt by throwing (a reset under way); nothing waits for it.
			}
		}
		return this.#failure;
	}

	/** The attempt's failure, once `fail` has settled. */
	async #rejected(): Promise<never> {
		await this.#failing;
		throw this.#failure;
	}
}

export interface LocalTool {
	name: LocalToolName;
	tool: ToolRegistration;
	/** Whether the tool may change the folder. */
	changes: boolean;
	/** The command or path, for the chat. */
	summary: (args: { [key: string]: unknown }) => string;
	/** The arguments to run with, and how long the call may take before it counts as stuck. */
	plan: (args: { [key: string]: unknown }) => { args: { [key: string]: unknown }; stuckMs: number };
}

type Outcome = { ok: true; result: ToolExecutionResult } | { ok: false; error: unknown };

function resultText(outcome: Outcome, output: string): string {
	const content = outcome.ok ? outcome.result.content : undefined;
	const text = content ? content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n") : output;
	if (outcome.ok) return text;
	const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
	return text ? `${text}\n\n${message}` : message;
}

/** The output kept for the chat's excerpt: a bit more than it shows, never starting inside a surrogate pair. */
const KEPT_UNITS = 4 * EXCERPT_CHARS;

function keepTail(text: string): string {
	if (text.length <= KEPT_UNITS) return text;
	let start = text.length - KEPT_UNITS;
	const unit = text.charCodeAt(start);
	if (unit >= 0xdc00 && unit <= 0xdfff) start++;
	return text.slice(start);
}

/**
 * Runs one local call under the barrier: admitted, planned once admitted (so time spent
 * waiting for a checkpoint is not given to a command), watched for being stuck, its result held until the
 * next checkpoint saved what it did, and reported to the chat only once released. An aborted call stops
 * waiting for its release and is not reported; its effect is still saved.
 */
export async function runGated(calls: LocalCalls, local: LocalTool, args: unknown, api: ToolExecutionApi, context: Parameters<ToolRegistration["execute"]>[2]): Promise<ToolExecutionResult> {
	const signal = context.abortSignal;
	await calls.admit(signal, local.changes);
	const decoder = new TextDecoder();
	let output = "";
	const observed: ToolExecutionApi = {
		...api,
		output(chunk, skipped) {
			// Only the tail is shown, so only a bit more than it is kept.
			output = keepTail(output + (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })));
			api.output(chunk, skipped);
		},
	};
	let settled = false;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let outcome: Outcome;
	try {
		const planned = local.plan(args as { [key: string]: unknown });
		watchdog = setTimeout(
			() => {
				void calls.killStuck().then(() => {
					if (settled) return;
					watchdog = setTimeout(() => calls.stuck(new LocalToolStuck(`A ${local.name} call did not stop.`)), STUCK_GRACE_MS);
				});
			},
			Math.min(planned.stuckMs, MAX_TIMER_MS),
		);
		outcome = { ok: true, result: await local.tool.execute(planned.args as never, observed, context) };
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		settled = true;
		clearTimeout(watchdog);
	}
	await untilAborted(calls.release(), signal);
	const given = args as { [key: string]: unknown };
	calls.report({
		tool: local.name,
		summary: head(storable(local.summary(given)), SUMMARY_CHARS),
		ok: outcome.ok && outcome.result.isError !== true,
		excerpt: tail(storable(resultText(outcome, output)), EXCERPT_CHARS),
	});
	if (!outcome.ok) throw outcome.error;
	return outcome.result;
}

/** `local.tool` with its result held for the next checkpoint, and a watchdog for a call that does not settle. */
export function gated(calls: LocalCalls, local: LocalTool): ToolRegistration {
	return { ...local.tool, execute: (args, api, context) => runGated(calls, local, args, api, context) };
}

export interface LocalToolOptions {
	/** When the turn must end, in milliseconds since the epoch; null for none. */
	deadline: number | null;
	now?: () => number;
}

/** The four local tools in their fixed order, as pi makes them with our changes. */
export function localToolSpecs(options: LocalToolOptions): LocalTool[] {
	const now = options.now ?? Date.now;
	const path = (args: { [key: string]: unknown }) => String(args.path ?? "");
	const files = (args: { [key: string]: unknown }) => ({ args, stuckMs: FILE_TOOL_STUCK_MS });
	const bash = createBashTool({
		prepare(execution) {
			// Commands get a fixed environment, never anything of the Worker's.
			execution.inheritEnv = false;
			execution.env = commandEnvironment();
		},
	});
	const parameters = bash.parameters as unknown as { properties: { [name: string]: object } };
	return [
		{ name: "read", tool: { ...createReadTool(), replay: "safe" } as unknown as ToolRegistration, changes: false, summary: path, plan: files },
		{ name: "write", tool: createWriteTool() as unknown as ToolRegistration, changes: true, summary: path, plan: files },
		{ name: "edit", tool: createEditTool() as unknown as ToolRegistration, changes: true, summary: path, plan: files },
		{
			name: "bash",
			changes: true,
			tool: {
				...bash,
				parameters: {
					...parameters,
					properties: { ...parameters.properties, timeout: { ...parameters.properties.timeout, description: TIMEOUT_DESCRIPTION } },
				} as unknown as typeof bash.parameters,
			} as unknown as ToolRegistration,
			summary: (args) => String(args.command ?? ""),
			plan(args) {
				// An invalid timeout is passed on for the tool to refuse.
				let timeout = args.timeout === undefined ? COMMAND_TIMEOUT_S : (args.timeout as number);
				if (options.deadline !== null) {
					const left = Math.floor((options.deadline - now()) / 1000);
					if (left < 1) throw new Error(OUT_OF_TIME);
					timeout = Math.min(timeout, left);
				}
				const valid = Number.isFinite(timeout) && timeout > 0;
				return { args: { ...args, timeout }, stuckMs: valid ? timeout * 1000 + STUCK_AFTER_TIMEOUT_MS : FILE_TOOL_STUCK_MS };
			},
		},
	];
}

export interface LocalToolsOptions extends LocalToolOptions {
	/** The run's local tools. */
	names: readonly string[];
	calls: LocalCalls;
}

/** The run's local tools, in a fixed order, each gated. */
export function localTools(options: LocalToolsOptions): ToolRegistration[] {
	return localToolSpecs(options)
		.filter((local) => options.names.includes(local.name))
		.map((local) => gated(options.calls, local));
}
