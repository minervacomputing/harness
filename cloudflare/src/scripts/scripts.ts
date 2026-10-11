// Code mode. Step 4 builds the Scripts Durable Object to `ScriptsApi` and the loopback ScriptHost to
// `ScriptHostApi` (contracts/scripts.ts): each script a Dynamic Worker with no network and a CPU limit,
// run through an awaited entrypoint so a busy guest never blocks the conversation.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type About, identity } from "../lib/about.ts";

export class Scripts extends DurableObject<Env> {
	async about(): Promise<About<"scripts">> {
		return { kind: "scripts", ...identity(this.ctx), migrations: [] };
	}
}

export class ScriptHost extends WorkerEntrypoint<Env> {}
