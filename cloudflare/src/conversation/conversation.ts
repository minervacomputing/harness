// The Conversation Durable Object. Step 2 builds it to `ConversationApi` (contracts/conversation.ts) as an
// Agents SDK `Agent` running pi-durable through PiHarness: messages, runs and attempts, events, the write
// ledger, page tokens, folder versions and the executor. Until then it holds only its schema record.

import { DurableObject } from "cloudflare:workers";
import { type About, identity } from "../lib/about.ts";
import { appliedMigrations, type Migration, migrate } from "../lib/sqlite.ts";

/** Additive only; see lib/sqlite.ts. */
const MIGRATIONS: Migration[] = [];

export class Conversation extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, MIGRATIONS);
		});
	}

	async about(): Promise<About<"conversation">> {
		return { kind: "conversation", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}
}
