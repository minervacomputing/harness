// The RpcTargets the conversation makes for one script (contracts/scripts.ts): `ScriptTarget`, the guest's
// only capability, and `ScriptControlTarget`, which only the Scripts object gets. Their public methods are
// all the other side can reach; the session is a private field, which RPC does not expose. Calls on them
// run in the conversation's isolate, through the run's queue and executor.

import { RpcTarget } from "cloudflare:workers";
import type { ScriptCallAnswer, ScriptControl, ScriptOutputItem, ScriptTools } from "../contracts/scripts.ts";
import type { ScriptSession } from "./session.ts";

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
