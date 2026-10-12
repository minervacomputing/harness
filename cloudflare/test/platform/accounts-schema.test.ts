// The D1 schema for accounts (migrations/0003_better_auth.sql): Better Auth's tables match what our
// configuration expects, ours reference them, and an instance made with 0001 and 0002 upgrades with its
// people and workspaces (an empty install is the database every other platform test runs on).

import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getSchema } from "better-auth/db";
import { describe, expect, test } from "vitest";
import { type AuthPolicy, authOptions } from "../../src/accounts/auth-options.ts";
import { getAuth, handleAuth } from "../../src/accounts/auth.ts";
import { hashPassword } from "../../src/accounts/passwords.ts";
import { uuid7 } from "../../src/lib/random.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[]; UPGRADE_DB: D1Database; UPGRADE_TWO_FACTOR_DB: D1Database };

const BETTER_AUTH_TABLES = ["account", "invitation", "member", "organization", "rateLimit", "session", "twoFactor", "user", "verification"];
const OLD_TABLES = ["users", "emails", "passwords", "authenticators", "recovery_codes", "totp_periods", "sessions", "auth_flows", "organizations", "organization_members"];

async function columns(db: D1Database, table: string): Promise<string[]> {
	const { results } = await db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{ name: string }>();
	return results.map((row) => row.name).sort();
}

async function foreignKeys(db: D1Database, table: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT "from", "table" AS target, "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY "from"`)
		.bind(table)
		.all<{ from: string; target: string; to: string; on_delete: string }>();
	return results.map((row) => `${row.from} -> ${row.target}.${row.to} ${row.on_delete}`);
}

async function tables(db: D1Database): Promise<string[]> {
	const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
	return results.map((row) => row.name).sort();
}

const never = async (): Promise<never> => {
	throw new Error("unused");
};

describe("the D1 schema", () => {
	test("Better Auth's tables have exactly the columns our configuration expects", async () => {
		const schema = getSchema(
			authOptions({ siteUrl: "http://localhost", secret: "s".repeat(32), debug: true, hashCode: never, sendCode: never, userCreated: never, sessionCreated: never, rehashed: never, policy: new Proxy({}, { get: () => never }) as AuthPolicy }),
		);
		expect(Object.keys(schema).sort()).toEqual(BETTER_AUTH_TABLES);
		for (const [table, { fields }] of Object.entries(schema)) {
			const expected = ["id", ...Object.entries(fields).map(([key, field]) => field.fieldName ?? key)].sort();
			expect(await columns(env.DB, table), table).toEqual(expected);
		}
	});

	test("requests share no schema check, and Better Auth's own check finds the schema it expects", async () => {
		// A check run at the first request and awaited by the rest hung the isolate when that request was
		// cancelled mid-query (auth-options.ts).
		const context = await getAuth(env).$context;
		expect(context.checkSchema).toBeUndefined();
		expect(context.explicitSchemaCheck).toBeTypeOf("function");
		await expect(context.explicitSchemaCheck?.()).resolves.toBeUndefined();
	});

	test("the old account tables are gone and ours reference Better Auth's", async () => {
		const present = await tables(env.DB);
		for (const table of OLD_TABLES) expect(present).not.toContain(table);
		expect(present).toEqual(expect.arrayContaining([...BETTER_AUTH_TABLES, "workspaces", "memberships", "oauth_flows", "oauth_clients", "rate_limits"]));
		expect(await foreignKeys(env.DB, "workspaces")).toEqual(["organization_id -> organization.id RESTRICT", "personal_owner -> user.id RESTRICT"]);
		expect(await foreignKeys(env.DB, "memberships")).toEqual(["user_id -> user.id CASCADE", "workspace_id -> workspaces.id CASCADE"]);
		expect(await foreignKeys(env.DB, "oauth_flows")).toEqual(["session_id -> session.id CASCADE", "workspace_id -> workspaces.id CASCADE"]);
		expect(await foreignKeys(env.DB, "organization")).toEqual(["personalOwner -> user.id RESTRICT"]);
		expect(await foreignKeys(env.DB, "totp_steps")).toEqual(["two_factor_id -> twoFactor.id CASCADE"]);
	});
});

describe("upgrading an instance made with 0001 and 0002", () => {
	const [initial, organizations, betterAuth, ...later] = bindings.TEST_MIGRATIONS;

	test("people, passwords, organizations and workspaces are carried over; sessions and flows are not", async () => {
		const db = bindings.UPGRADE_DB;
		await applyD1Migrations(db, [initial!, organizations!]);
		const ada = uuid7();
		const grace = uuid7();
		const [adaOrg, team, adaWs, graceWs, teamWs, oldTeamWs] = [uuid7(), uuid7(), uuid7(), uuid7(), uuid7(), uuid7()];
		const joined = Date.UTC(2026, 9, 1, 12, 0, 0, 250);
		const hash = await hashPassword("an old passphrase");
		const session = "a".repeat(64);
		await db.batch([
			db.prepare("INSERT INTO users (id, name, is_active, is_staff, date_joined) VALUES (?, 'Ada', 1, 1, ?), (?, '', 0, 0, ?)").bind(ada, joined, grace, joined),
			db.prepare("INSERT INTO emails (email, user_id, verified, created_at) VALUES ('ada@example.com', ?, 1, ?), ('grace@example.com', ?, 0, ?)").bind(ada, joined, grace, joined),
			db.prepare("INSERT INTO passwords (user_id, hash, fingerprint, updated_at) VALUES (?, ?, 'f', ?)").bind(ada, hash, joined),
			db
				.prepare("INSERT INTO organizations (id, name, kind, personal_owner, created_at) VALUES (?, 'Personal', 'personal', ?, ?), (?, 'Fernhill Labs', 'team', NULL, ?)")
				.bind(adaOrg, ada, joined, team, joined),
			db.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?), (?, ?, 'admin', ?)").bind(adaOrg, ada, joined, team, ada, joined),
			// Grace's workspace and the Old Mill team predate 0002, so they have no organization.
			db
				.prepare(
					"INSERT INTO workspaces (id, kind, name, personal_owner, created_at, initialized_at, organization_id) VALUES " +
						"(?, 'personal', 'Personal', ?, ?, ?, ?), (?, 'personal', 'Personal', ?, ?, NULL, NULL), (?, 'team', 'Fernhill Labs', NULL, ?, ?, ?), " +
						"(?, 'team', 'Old Mill', NULL, ?, ?, NULL)",
				)
				.bind(adaWs, ada, joined, joined + 1000, adaOrg, graceWs, grace, joined, teamWs, joined, joined, team, oldTeamWs, joined, joined),
			db
				.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?), (?, ?, 'owner', ?), (?, ?, 'admin', ?), (?, ?, 'owner', ?), (?, ?, 'member', ?)")
				.bind(adaWs, ada, joined, graceWs, grace, joined, teamWs, ada, joined, oldTeamWs, grace, joined, oldTeamWs, ada, joined),
			db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, 1, ?)").bind(session, ada, 9e12),
			db.prepare("INSERT INTO auth_flows (session_hash, kind, code_hash, created_at, expires_at) VALUES (?, 'password_reset', 'c', 1, ?)").bind(session, 9e12),
			db
				.prepare("INSERT INTO oauth_flows (session_hash, state, verifier, provider, workspace_id, client_id, issued_at, expires_at) VALUES (?, 's', 'v', 'todoist', ?, 'c', 1, 600001)")
				.bind(session, adaWs),
			db.prepare("INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES ('k', 1, 1, 2)"),
		]);

		await applyD1Migrations(db, [betterAuth!]);

		const users = await db.prepare(`SELECT id, name, email, "emailVerified", role, banned, "createdAt", "provisionedAt" FROM "user" ORDER BY email`).all();
		expect(users.results).toEqual([
			{ id: ada, name: "Ada", email: "ada@example.com", emailVerified: 1, role: "admin", banned: 0, createdAt: "2026-10-01T12:00:00.250Z", provisionedAt: "2026-10-01T12:00:01.250Z" },
			{ id: grace, name: "", email: "grace@example.com", emailVerified: 0, role: "user", banned: 1, createdAt: "2026-10-01T12:00:00.250Z", provisionedAt: null },
		]);
		expect((await db.prepare(`SELECT "providerId", "accountId", "userId", password FROM account`).all()).results).toEqual([
			{ providerId: "credential", accountId: ada, userId: ada, password: hash },
		]);
		const orgs = await db.prepare(`SELECT id, name, slug, "personalOwner" FROM organization ORDER BY name, id`).all();
		expect(orgs.results).toEqual(
			expect.arrayContaining([
				{ id: team, name: "Fernhill Labs", slug: team, personalOwner: null },
				{ id: adaOrg, name: "Personal", slug: adaOrg, personalOwner: ada },
				{ id: graceWs, name: "Personal", slug: graceWs, personalOwner: grace },
				{ id: oldTeamWs, name: "Old Mill", slug: oldTeamWs, personalOwner: null },
			]),
		);
		const members = await db.prepare(`SELECT "organizationId" AS org, "userId" AS user, role, length(id) AS id_length FROM member ORDER BY org, user`).all();
		expect(members.results).toHaveLength(5);
		expect(members.results).toEqual(
			expect.arrayContaining([
				{ org: adaOrg, user: ada, role: "owner", id_length: 36 },
				{ org: team, user: ada, role: "admin", id_length: 36 },
				{ org: graceWs, user: grace, role: "owner", id_length: 36 },
				{ org: oldTeamWs, user: grace, role: "owner", id_length: 36 },
				{ org: oldTeamWs, user: ada, role: "member", id_length: 36 },
			]),
		);
		const workspaces = await db.prepare("SELECT id, organization_id, initialized_at FROM workspaces ORDER BY id").all();
		expect(workspaces.results).toEqual(
			expect.arrayContaining([
				{ id: adaWs, organization_id: adaOrg, initialized_at: joined + 1000 },
				{ id: graceWs, organization_id: graceWs, initialized_at: null },
				{ id: teamWs, organization_id: team, initialized_at: joined },
				{ id: oldTeamWs, organization_id: oldTeamWs, initialized_at: joined },
			]),
		);
		expect((await db.prepare("SELECT count(*) AS n FROM memberships").first())?.n).toBe(5);
		expect((await db.prepare("SELECT count(*) AS n FROM oauth_flows").first())?.n).toBe(0);
		expect((await db.prepare("SELECT count(*) AS n FROM session").first())?.n).toBe(0);
		expect((await db.prepare("SELECT count(*) AS n FROM rate_limits").first())?.n).toBe(1);
		for (const table of OLD_TABLES) expect(await tables(db)).not.toContain(table);
		// With the later migrations, the same database as a fresh install: the same tables and references.
		await applyD1Migrations(db, later);
		expect(await tables(db)).toEqual(await tables(env.DB));
		for (const table of ["workspaces", "memberships", "oauth_flows", "organization", "member", "totp_steps"]) {
			expect(await foreignKeys(db, table), table).toEqual(await foreignKeys(env.DB, table));
		}
		expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

		// Ada's old password signs in through Better Auth.
		const signIn = (password: string) =>
			handleAuth(
				{ ...env, DB: db },
				new Request("http://localhost/api/auth/sign-in/email", {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: "http://localhost", "CF-Connecting-IP": "10.250.0.1" },
					body: JSON.stringify({ email: "ada@example.com", password }),
				}),
			);
		const signedIn = await signIn("an old passphrase");
		expect(signedIn.status).toBe(200);
		expect(((await signedIn.json()) as { user: { id: string } }).user.id).toBe(ada);
		expect((await signIn("wrong passphrase")).status).toBe(401);
	});

	test("two-factor authenticators and secondary addresses stop the migration instead of being dropped", async () => {
		const db = bindings.UPGRADE_TWO_FACTOR_DB;
		await applyD1Migrations(db, [initial!, organizations!]);
		const ada = uuid7();
		await db.batch([
			db.prepare("INSERT INTO users (id, date_joined) VALUES (?, 1)").bind(ada),
			db.prepare("INSERT INTO emails (email, user_id, created_at) VALUES ('ada@example.com', ?, 1)").bind(ada),
			db.prepare("INSERT INTO authenticators (id, user_id, type, created_at) VALUES (?, ?, 'totp', 1)").bind(uuid7(), ada),
		]);
		await expect(applyD1Migrations(db, [betterAuth!])).rejects.toThrow(/CHECK constraint failed/);
		// Nothing of it was applied.
		expect(await tables(db)).toContain("authenticators");
		expect(await tables(db)).not.toContain("user");

		await db.batch([
			db.prepare("DELETE FROM authenticators"),
			db.prepare("INSERT INTO emails (email, user_id, is_primary, created_at) VALUES ('ada@example.net', ?, 0, 1)").bind(ada),
		]);
		await expect(applyD1Migrations(db, [betterAuth!])).rejects.toThrow(/CHECK constraint failed/);
		await db.prepare("DELETE FROM emails WHERE is_primary = 0").run();
		await applyD1Migrations(db, [betterAuth!]);
		expect((await db.prepare(`SELECT email FROM "user"`).all()).results).toEqual([{ email: "ada@example.com" }]);
	});
});
