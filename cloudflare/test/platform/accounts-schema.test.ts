// The D1 schema for accounts (migrations/0003_better_auth.sql, 0007_plain_auth.sql,
// 0008_verification_identifier.sql): Better Auth's tables match what our configuration expects, ours
// reference them, an instance made with 0001 and 0002 upgrades with its people and workspaces, 0007 clears
// what our old policy stored, and 0008 keeps one verification value per identifier (an empty install is the
// database every other platform test runs on).

import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getSchema } from "better-auth/db";
import { describe, expect, test } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { authOptions } from "../../src/accounts/auth-options.ts";
import { getAuth, handleAuth } from "../../src/accounts/auth.ts";
import { uuid7 } from "../../src/lib/random.ts";

const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[]; UPGRADE_DB: D1Database; UPGRADE_TWO_FACTOR_DB: D1Database; UPGRADE_PLAIN_DB: D1Database; UPGRADE_VERIFICATION_DB: D1Database };

/** A password hash in the format of our own hasher before 0007, which Better Auth's does not read. */
const OLD_HASH = `scrypt$15$8$3$${"c2FsdHNhbHRzYWx0c2FsdA"}$${"A".repeat(43)}`;

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

/** A password sign-in through Better Auth's route, against another database. */
function signIn(db: D1Database, email: string, password: string): Promise<Response> {
	return handleAuth(
		{ ...env, DB: db },
		new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost", "CF-Connecting-IP": "10.250.0.1" },
			body: JSON.stringify({ email, password }),
		}),
	);
}

const never = async (): Promise<never> => {
	throw new Error("unused");
};

describe("the D1 schema", () => {
	test("Better Auth's tables have exactly the columns our configuration expects", async () => {
		const schema = getSchema(
			authOptions({ siteUrl: "http://localhost", secret: "s".repeat(32), debug: true, allowSignUp: false, sendCode: never, userCreated: never, sessionCreated: never, passwordReplaced: never }),
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
		expect(present).toEqual(expect.arrayContaining([...BETTER_AUTH_TABLES, "workspaces", "memberships", "oauth_flows", "oauth_clients"]));
		for (const table of ["rate_limits", "totp_steps"]) expect(present).not.toContain(table);
		expect(await foreignKeys(env.DB, "workspaces")).toEqual(["organization_id -> organization.id RESTRICT", "personal_owner -> user.id RESTRICT"]);
		expect(await foreignKeys(env.DB, "memberships")).toEqual(["user_id -> user.id CASCADE", "workspace_id -> workspaces.id CASCADE"]);
		expect(await foreignKeys(env.DB, "oauth_flows")).toEqual(["session_id -> session.id CASCADE", "workspace_id -> workspaces.id CASCADE"]);
		expect(await foreignKeys(env.DB, "organization")).toEqual(["personalOwner -> user.id RESTRICT"]);
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
		const hash = OLD_HASH;
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
		for (const table of ["workspaces", "memberships", "oauth_flows", "organization", "member"]) {
			expect(await foreignKeys(db, table), table).toEqual(await foreignKeys(env.DB, table));
		}
		expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

		// Ada's password was in the old format (0007): she signs in with an email code or resets it.
		expect((await db.prepare(`SELECT count(*) AS n FROM account`).first())?.n).toBe(0);
		expect((await signIn(db, "ada@example.com", "an old passphrase")).status).toBe(401);
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

describe("0007: plain Better Auth", () => {
	test("drops the old policy's tables and stamps, and its sessions, codes and passwords in the old format", async () => {
		const db = bindings.UPGRADE_PLAIN_DB;
		const migrations = bindings.TEST_MIGRATIONS;
		const plain = migrations.findIndex((migration) => migration.name.startsWith("0007_"));
		await applyD1Migrations(db, migrations.slice(0, plain));
		const [ada, grace, twoFactor] = [uuid7(), uuid7(), uuid7()];
		const now = new Date().toISOString();
		const later = new Date(Date.now() + 3_600_000).toISOString();
		const newHash = await hashPassword("a long enough passphrase");
		await db.batch([
			db.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, '', 'ada@example.com', 1, ?, ?), (?, '', 'grace@example.com', 1, ?, ?)`).bind(ada, now, now, grace, now, now),
			db
				.prepare(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, ?, ?, ?), (?, ?, 'credential', ?, ?, ?, ?)`)
				.bind(uuid7(), ada, ada, OLD_HASH, now, now, uuid7(), grace, grace, newHash, now, now),
			db.prepare(`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "credentialStamp") VALUES (?, ?, 't1', ?, ?, ?, 'stamp')`).bind(uuid7(), later, now, now, ada),
			db
				.prepare(`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, 'sign-in-otp-ada@example.com', 'hmac:0', ?, ?, ?), (?, 'minerva-stamp-2fa-x', 'stamp', ?, ?, ?)`)
				.bind(uuid7(), later, now, now, uuid7(), later, now, now),
			db.prepare(`INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId") VALUES (?, 's', 'b', ?)`).bind(twoFactor, grace),
			db.prepare("INSERT INTO totp_steps (two_factor_id, secret_hash, last_step) VALUES (?, 'h', 1)").bind(twoFactor),
			db.prepare("INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES ('k', 1, 1, 2)"),
		]);

		await applyD1Migrations(db, migrations.slice(plain));

		expect(await tables(db)).toEqual(await tables(env.DB));
		expect(await columns(db, "session")).toEqual(await columns(env.DB, "session"));
		expect(await columns(db, "session")).not.toContain("credentialStamp");
		for (const table of ["session", "verification"]) expect((await db.prepare(`SELECT count(*) AS n FROM "${table}"`).first())?.n, table).toBe(0);
		expect((await db.prepare(`SELECT "userId" AS user FROM account`).all()).results).toEqual([{ user: grace }]);
		// The users and their two-factor stay.
		expect((await db.prepare(`SELECT count(*) AS n FROM "user"`).first())?.n).toBe(2);
		expect((await db.prepare(`SELECT count(*) AS n FROM "twoFactor"`).first())?.n).toBe(1);
		expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

		// A password in Better Auth's format still signs in; one in the old format is gone.
		expect((await signIn(db, "grace@example.com", "a long enough passphrase")).status).toBe(200);
		expect((await signIn(db, "ada@example.com", "a long enough passphrase")).status).toBe(401);
	});
});

describe("0008: one verification value per identifier", () => {
	const insert = (db: D1Database, id: string, identifier: string, value: string, createdAt: string) =>
		db.prepare(`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`).bind(id, identifier, value, createdAt, createdAt, createdAt);

	test("a second value for an identifier is refused", async () => {
		const now = new Date().toISOString();
		const identifier = `sign-in-otp-${uuid7()}@example.com`;
		await insert(env.DB, uuid7(), identifier, "first:0", now).run();
		await expect(insert(env.DB, uuid7(), identifier, "second:0", now).run()).rejects.toThrow(/UNIQUE constraint failed/);
	});

	test("keeps the newest of each identifier, the greater id on a tie, and leaves the others alone", async () => {
		const db = bindings.UPGRADE_VERIFICATION_DB;
		const migrations = bindings.TEST_MIGRATIONS;
		const unique = migrations.findIndex((migration) => migration.name.startsWith("0008_"));
		await applyD1Migrations(db, migrations.slice(0, unique));
		const [earlier, later] = [new Date(Date.now() - 60_000).toISOString(), new Date().toISOString()];
		const [tieFirst, tieSecond] = [uuid7(), uuid7()];
		await db.batch([
			insert(db, uuid7(), "sign-in-otp-ada@example.com", "older:0", earlier),
			insert(db, uuid7(), "sign-in-otp-ada@example.com", "newer:0", later),
			insert(db, tieSecond, "forget-password-otp-ada@example.com", "tie-second:0", later),
			insert(db, tieFirst, "forget-password-otp-ada@example.com", "tie-first:0", later),
			insert(db, uuid7(), "sign-in-otp-grace@example.com", "alone:0", earlier),
		]);

		await applyD1Migrations(db, migrations.slice(unique));

		const { results } = await db.prepare("SELECT identifier, value FROM verification ORDER BY identifier").all();
		expect(results).toEqual([
			{ identifier: "forget-password-otp-ada@example.com", value: "tie-second:0" },
			{ identifier: "sign-in-otp-ada@example.com", value: "newer:0" },
			{ identifier: "sign-in-otp-grace@example.com", value: "alone:0" },
		]);
		const index = await db.prepare(`SELECT "unique" FROM pragma_index_list('verification') WHERE name = 'verification_identifier_idx'`).first();
		expect(index).toEqual({ unique: 1 });
	});
});
