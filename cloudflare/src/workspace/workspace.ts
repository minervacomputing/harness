// The Workspace Durable Object. Step 2 builds it to `WorkspaceApi` (contracts/workspace.ts): connections
// and credentials, layers and grants, agents, the run registry and revocation outbox, uploads and the
// conversation index. Until then it holds only its schema record.

import { DurableObject } from "cloudflare:workers";
import { type About, identity } from "../lib/about.ts";
import { appliedMigrations, type Migration, migrate } from "../lib/sqlite.ts";

/** Additive only; see lib/sqlite.ts. */
const MIGRATIONS: Migration[] = [];

export class Workspace extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, MIGRATIONS);
		});
	}

	/** What this object is and which schema steps it has; for checks and tests. */
	async about(): Promise<About<"workspace">> {
		return { kind: "workspace", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}
}
