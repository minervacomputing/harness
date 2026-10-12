// The configuration Better Auth's CLI reads to generate the D1 schema (`pnpm run auth:schema`): the
// Worker's own options (src/accounts/auth-options.ts) with stand-ins for what needs the runtime, which
// does not change the schema. The output is reviewed and copied into a migration by hand (plan: The web
// API); test/platform/accounts-schema.test.ts checks that D1's tables match what this configuration expects.

import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { type AuthPolicy, authOptions } from "../src/accounts/auth-options.ts";

const unused = async (): Promise<never> => {
	throw new Error("Not available while generating the schema.");
};

export const auth = betterAuth(
	authOptions({
		siteUrl: "http://localhost:5173",
		secret: "schema-generation-only-not-a-secret-0000000000",
		debug: true,
		// An empty SQLite database: the CLI compares against it, so it prints every table.
		database: new DatabaseSync(":memory:"),
		hashCode: unused,
		sendCode: unused,
		userCreated: unused,
		sessionCreated: unused,
		rehashed: unused,
		policy: new Proxy({}, { get: () => unused }) as AuthPolicy,
	}),
);
