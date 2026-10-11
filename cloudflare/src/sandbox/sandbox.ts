// The Sandbox Durable Object. Step 3 gives it its container (cloudflare/container/) and builds it to
// `SandboxApi` (contracts/sandbox.ts): the incarnation-fenced lifecycle and hardening, commands and file
// operations as the dropped user, scans, hydration and checkpoints to R2. It is reached as
// `ctx.exports.Sandbox`, since a container class cannot be bound by its own Worker's name.

import { DurableObject } from "cloudflare:workers";
import { type About, identity } from "../lib/about.ts";
import { appliedMigrations, type Migration, migrate } from "../lib/sqlite.ts";

/** Additive only; see lib/sqlite.ts. */
const MIGRATIONS: Migration[] = [];

export class Sandbox extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, MIGRATIONS);
		});
	}

	async about(): Promise<About<"sandbox">> {
		return { kind: "sandbox", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}
}
