// The Scripts Durable Object (`ScriptsApi`; plan: Code mode), one per conversation.
// It loads each script as a Dynamic Worker with no network (`globalOutbound: null`), no `env` and a CPU
// limit, and runs it. A guest runs on the thread of the object that loaded it, so a CPU-bound script blocks
// this object, never the conversation, which keeps the wall clock and answers its other requests meanwhile.
//
// Teardown, as measured on the account (test/account/scripts.test.ts; the spikes disagreed): a guest
// lives on after the call that loaded it stopped waiting for it, whether it was loaded here or through an
// awaited loopback WorkerEntrypoint (one that kept calling its host went on calling for seconds after the
// entrypoint returned, and from this object ten such guests took every Dynamic Worker slot, so the next
// load failed). Resetting this object (`ctx.abort()`) ended every one of them and freed the slots. So the
// conversation resets this object after every script, and the object resets itself as soon as the
// conversation says the script was stopped, or the conversation's side breaks (the conversation is gone).
// Guests are therefore loaded here directly, without the loopback hop. A fence keeps a late reset of an
// older run, attempt or script from tearing down a newer script, and a run that arrives after its script
// was reset from loading: in storage, the newest run and attempt with its first script, or the script the
// conversation stopped waiting for (marked ended); within an instance, `#latest`. A later script that
// answered is not stored: its run was delivered and cannot come again (an RPC is delivered at most once),
// and the conversation's next script has a newer id.

import { DurableObject } from "cloudflare:workers";
import { type About, identity } from "../lib/about.ts";
import { isUuid } from "../lib/random.ts";
import { appliedMigrations, migrate } from "../lib/sqlite.ts";
import type { AttemptFence } from "../shared/rpc.ts";
import { GUEST_COMPATIBILITY_DATE, PRELUDE_MODULE, RESET_REASON } from "./limits.ts";
import { type GuestOutcome, guestOutcome, thrownOutcome } from "./outcome.ts";
import { guestModules } from "./prelude.ts";
import { MIGRATIONS } from "./schema.ts";
import type { ScriptControl, ScriptTools } from "./target.ts";

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

/** Fences in order: by run id (UUIDv7, so a later run sorts later), then attempt. */
export function compareFences(a: AttemptFence, b: AttemptFence): number {
	if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
	return a.attempt - b.attempt;
}

function isFence(fence: unknown): fence is AttemptFence {
	const value = fence as AttemptFence | null;
	return value !== null && typeof value === "object" && typeof value.runId === "string" && isUuid(value.runId) && Number.isSafeInteger(value.attempt) && value.attempt >= 1;
}

function isRequest(script: unknown): script is ScriptRequest {
	const value = script as ScriptRequest | null;
	return (
		value !== null &&
		typeof value === "object" &&
		typeof value.code === "string" &&
		Array.isArray(value.tools) &&
		value.tools.every((tool) => tool !== null && typeof tool === "object" && typeof tool.name === "string" && typeof tool.identifier === "string") &&
		Array.isArray(value.store) &&
		value.store.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string") &&
		Number.isSafeInteger(value.cpuMs) &&
		value.cpuMs >= 1
	);
}

/** The guest's Worker: the prelude and the script, no network, no bindings, a CPU limit. */
export function guestWorker(script: ScriptRequest): WorkerLoaderWorkerCode {
	return {
		compatibilityDate: GUEST_COMPATIBILITY_DATE,
		compatibilityFlags: [],
		mainModule: PRELUDE_MODULE,
		modules: guestModules(script.code),
		globalOutbound: null,
		env: {},
		limits: { cpuMs: script.cpuMs },
	};
}

interface GuestEntrypoint {
	run(host: ScriptTools, tools: ScriptRequest["tools"], store: ScriptRequest["store"]): Promise<unknown>;
}

/**
 * Loads one guest and runs it to its answer. Each script is a new Dynamic Worker (`load`, never a reused
 * `get` id: a warm one keeps the last script's globals), since the platform refuses code generation inside
 * one.
 */
export async function runGuest(loader: WorkerLoader, script: ScriptRequest, tools: ScriptTools): Promise<GuestOutcome> {
	try {
		const entry = loader.load(guestWorker(script)).getEntrypoint() as unknown as GuestEntrypoint;
		return guestOutcome(await entry.run(tools, script.tools, script.store));
	} catch (error) {
		return thrownOutcome(error, script.cpuMs);
	}
}

/** A stub that outlives the call it came with (Workers RPC disposes a parameter's stub when the call returns). */
function kept<T>(stub: T): T {
	const dup = (stub as { dup?: () => T }).dup;
	return typeof dup === "function" ? dup.call(stub) : stub;
}


/** The fence as stored: the newest run and attempt, its newest script, and whether that script was ended. */
interface Stored extends ScriptFence {
	ended: boolean;
}

/**
 * Whether `fence` may act given the stored one: by run and attempt, then, within the attempt, by script id
 * (UUIDv7s, made in order by the conversation). The same script may act again unless it was ended.
 */
function order(fence: ScriptFence, stored: Stored | null): "older" | "same" | "newer" {
	if (!stored) return "newer";
	const attempt = compareFences(fence, stored);
	if (attempt !== 0) return attempt < 0 ? "older" : "newer";
	if (fence.scriptId === stored.scriptId) return "same";
	return fence.scriptId < stored.scriptId ? "older" : "newer";
}

export class Scripts extends DurableObject<Env> implements ScriptsApi {
	/** The last script loaded in this instance: what it left running lives until this instance is reset. */
	#latest: string | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		migrate(ctx.storage, MIGRATIONS);
	}

	async about(): Promise<About<"scripts">> {
		return { kind: "scripts", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}

	#stored(): Stored | null {
		const row = this.ctx.storage.sql
			.exec<{ run_id: string; attempt: number; script_id: string; ended: number }>("SELECT run_id, attempt, script_id, ended FROM script_fence")
			.toArray()[0];
		return row ? { runId: row.run_id, attempt: row.attempt, scriptId: row.script_id, ended: row.ended === 1 } : null;
	}

	#store(fence: ScriptFence, ended: boolean): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO script_fence (singleton, run_id, attempt, script_id, ended) VALUES (1, ?, ?, ?, ?) ON CONFLICT (singleton) DO UPDATE SET run_id = excluded.run_id, attempt = excluded.attempt, script_id = excluded.script_id, ended = excluded.ended",
			fence.runId,
			fence.attempt,
			fence.scriptId,
			ended ? 1 : 0,
		);
	}

	#reset(): void {
		try {
			this.ctx.abort(RESET_REASON);
		} catch {
			// The reset is under way; it ends this instance.
		}
	}

	/** The reset when the conversation stopped the script or is gone; the account tests' Worker turns it off to measure without it. */
	protected selfReset(): void {
		this.#reset();
	}

	/** Whether a run of the script may load: not of an older run, attempt or script, and not after its reset. */
	#admissible(fence: ScriptFence): boolean {
		const stored = this.#stored();
		const place = order(fence, stored);
		return place === "newer" || (place === "same" && stored?.ended === false);
	}

	async run(fence: ScriptFence, script: ScriptRequest, tools: ScriptTools, control: ScriptControl): Promise<GuestOutcome | { refused: "stale" }> {
		if (!isFence(fence) || typeof fence.scriptId !== "string" || !isRequest(script)) throw new TypeError("The conversation sends a well-formed script.");
		const stored = this.#stored();
		// An older run or attempt, an earlier script of this attempt, or this script again (a run that came
		// after its reset, which remembered it): never loads.
		if (order(fence, stored) !== "newer") return { refused: "stale" };
		// A new run or attempt is written, durably before it runs, since a reset may follow and drops what is not.
		// Later scripts of the attempt write nothing (a write would hold the answer until it is durable).
		const advance = !stored || compareFences(fence, stored) !== 0;
		if (advance) this.#store(fence, false);
		const scriptId = fence.scriptId;
		// Before any await, so a reset of the script before it, arriving meanwhile, is refused.
		this.#latest = scriptId;
		// Stopped by the conversation, or the conversation is gone, also after the guest answered (its leftovers
		// live on): until a later script loads here, this instance and its guests end. The conversation's own
		// reset after the script usually comes first.
		void Promise.resolve(kept(control).stopped())
			.catch(() => {})
			.then(() => {
				if (this.#latest === scriptId) this.selfReset();
			});
		if (advance) {
			await this.ctx.storage.sync();
			// A newer run, a later script or this script's reset came meanwhile.
			if (!this.#admissible(fence) || this.#latest !== scriptId) return { refused: "stale" };
		}
		return await this.load(script, tools);
	}

	/** Runs the guest; the account tests' Worker overrides it to compare loaders. */
	protected load(script: ScriptRequest, tools: ScriptTools): Promise<GuestOutcome> {
		return runGuest(this.env.LOADER, script, tools);
	}

	async reset(fence: ScriptFence, answered = false): Promise<{ reset: true } | { refused: "stale" }> {
		if (!isFence(fence) || typeof fence.scriptId !== "string" || typeof answered !== "boolean") throw new TypeError("The conversation sends a well-formed fence.");
		// A reset is for the script it follows: once a later one was remembered, that one's reset comes after it.
		if (order(fence, this.#stored()) === "older") return { refused: "stale" };
		if (!answered) {
			// The conversation stopped waiting for the script, whose run may still be on its way: it is
			// remembered as ended, durably before the reset drops what is not, so that run never loads.
			this.#store(fence, true);
			await this.ctx.storage.sync();
		}
		// Decided after the awaits: once a later script loaded here, its reset comes after it. When nothing was
		// loaded in this instance, there is nothing to end.
		if (this.#latest !== null && this.#latest !== fence.scriptId) return { refused: "stale" };
		if (this.#latest === null) return { reset: true };
		// Ends every guest this object loaded, and this call with them.
		this.#reset();
		return { reset: true };
	}

	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.sync();
		this.#reset();
	}
}
