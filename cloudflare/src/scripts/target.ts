// The RpcTargets the conversation makes for one script: `ScriptTarget`, the guest's
// only capability, and `ScriptControlTarget`, which only the Scripts object gets. Their public methods are
// all the other side can reach; the session is a private field, which RPC does not expose. Calls on them
// run in the conversation's isolate, through the run's queue and executor.

import { RpcTarget } from "cloudflare:workers";
import type { Json } from "../lib/json.ts";
import type { ScriptOutputItem } from "./output.ts";
import type { ScriptSession } from "./session.ts";

/** What a scripted call answers the guest: the result's structured content, or the failure's message. */
export type ScriptCallAnswer = { ok: true; value: Json } | { ok: false; message: string };

/**
 * The guest's only capability: an RpcTarget the Conversation Durable Object makes per script. It applies
 * the caps (100 open calls across the turn's scripts, 256 KB of argument JSON, stop after 100 refusals,
 * the output limits) and queues calls with the direct ones (4 at once, writes one at a time). Once the
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

export class ScriptTarget extends RpcTarget implements ScriptTools {
	readonly #session: ScriptSession;

	constructor(session: ScriptSession) {
		super();
		this.#session = session;
	}

	call(name: string, argsJson: string | undefined): Promise<ScriptCallAnswer> {
		return this.#session.call(name, argsJson);
	}

	print(items: ScriptOutputItem[]): Promise<void> {
		return this.#session.print(items);
	}
}

export class ScriptControlTarget extends RpcTarget implements ScriptControl {
	readonly #session: ScriptSession;

	constructor(session: ScriptSession) {
		super();
		this.#session = session;
	}

	async stopped(): Promise<void> {
		await this.#session.stopped();
	}
}

/** The two targets of a session. */
export function targetsOf(session: ScriptSession): { tools: ScriptTools; control: ScriptControl } {
	return { tools: new ScriptTarget(session), control: new ScriptControlTarget(session) };
}
