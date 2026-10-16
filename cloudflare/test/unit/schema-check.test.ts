// The deploy-time schema check (scripts/schema.ts): the comparison of the schema the migrations build with the
// answers of the deployed database, and the reading of `cf d1 query`'s output. The queries are the real ones,
// run on real SQLite; D1 itself is never asked here (deploys run scripts/schema-check.ts against the account).
// Also the identity check (scripts/identity.ts), which every deploy and reset runs on the same database before
// they change anything, against a stand-in for cf.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { namesOf } from "../../scripts/instance.ts";
import { APPLIED_SQL, COLUMNS_SQL, FOREIGN_KEYS_SQL, OBJECTS_SQL, TABLES_SQL, UNIQUES_SQL, compareMigrations, compareSchemas, expectedSchema, normalized, readOnly, rowsFrom, schemaOf } from "../../scripts/schema.ts";

const DIR = new URL("../../migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter((file) => file.endsWith(".sql")).sort();
const MIGRATIONS = FILES.map((name) => ({ name, sql: readFileSync(new URL(name, DIR), "utf8") }));

/** A database as D1 would be after `migrations`, then changed by `change`, read through the same queries. */
function deployed(migrations: { sql: string }[], change: (db: DatabaseSync) => void = () => {}) {
	const db = new DatabaseSync(":memory:");
	for (const migration of migrations) db.exec(migration.sql);
	// What D1 adds that the migrations do not: its migrations table and its own tables.
	db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	db.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID");
	change(db);
	const ask = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
	const schema = schemaOf({ tables: ask(TABLES_SQL), columns: ask(COLUMNS_SQL), objects: ask(OBJECTS_SQL), uniques: ask(UNIQUES_SQL), foreignKeys: ask(FOREIGN_KEYS_SQL) });
	db.close();
	return schema;
}

const expected = expectedSchema(MIGRATIONS);

/** The tables of the engine's own accounts, which 0013 drops. */
const RETIRED = ["oauth_flows", "memberships", "invitation", "member", "instance_setup", "instance_settings", "account", "session", "twoFactor", "workspaces", "organization", "user", "verification", "rateLimit", "oauth_clients"];

describe("what the migrations build", () => {
	test("is the recovery index and the identity's table, with the runs' index", () => {
		expect([...expected.tables.keys()].sort()).toEqual(["instance_identity", "recovery_conversations", "recovery_runs"]);
		expect([...expected.objects.keys()]).toEqual(["index recovery_runs_conversation"]);
		expect(expected.constraints.get("recovery_runs")).toEqual(new Set(["primary key (id)", "foreign key (conversation_id) references recovery_conversations (id) on update no action on delete no action"]));
		expect(expected.tables.get("recovery_conversations")?.get("deleted_at")).toEqual({ type: "INTEGER", notNull: false, default: null, primaryKey: 0 });
	});

	test("0013 drops the accounts' tables, a row in each and foreign keys on, and keeps the recovery index's and the identity's rows", () => {
		// Statement by statement, each its own transaction, the order alone must satisfy the foreign keys. As D1 runs it, in
		// one transaction with its row in the migrations table, the checks wait for the commit.
		for (const transaction of [false, true]) {
			const db = new DatabaseSync(":memory:");
			const before = MIGRATIONS.filter((migration) => migration.name < "0013");
			for (const migration of before) db.exec(migration.sql);
			db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
			for (const migration of before) db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
			const workspace = "00000000-0000-4000-8000-000000000001";
			const time = "2026-10-01T00:00:00.000Z";
			db.exec(`
				INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.com', 1, '${time}', '${time}');
				INSERT INTO "organization" (id, name, slug, "createdAt", "personalOwner") VALUES ('o1', 'Ada', 'ada', '${time}', 'u1');
				INSERT INTO workspaces (id, organization_id, kind, name, personal_owner, created_at) VALUES ('${workspace}', 'o1', 'personal', 'Ada', 'u1', 1);
				INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ('s1', '${time}', 'token', '${time}', '${time}', 'u1');
				INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('a1', 'u1', 'credential', 'u1', '${time}', '${time}');
				INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId") VALUES ('f1', 'secret', 'codes', 'u1');
				INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES ('v1', 'email', 'code', '${time}', '${time}', '${time}');
				INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('m1', 'o1', 'u1', 'owner', '${time}');
				INSERT INTO invitation (id, "organizationId", email, status, "expiresAt", "createdAt", "inviterId") VALUES ('i1', 'o1', 'grace@example.com', 'pending', '${time}', '${time}', 'u1');
				INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('${workspace}', 'u1', 'owner', 1);
				INSERT INTO oauth_flows (session_id, state, verifier, provider, workspace_id, client_id, issued_at, expires_at) VALUES ('s1', 'state', 'verifier', 'google', '${workspace}', 'client', 1, 2);
				INSERT INTO oauth_clients (provider, redirect_uri, client_id, secret_ciphertext, secret_key_version, created_at) VALUES ('google', 'https://site.example/callback', 'client', 'ciphertext', 'k1', 1);
				INSERT INTO instance_setup (id, claim, user_id, claimed_at) VALUES (1, 'claim', 'u1', 1);
				INSERT INTO instance_settings (id, signup_open, updated_at, updated_by) VALUES (1, 0, 1, 'u1');
				INSERT INTO "rateLimit" (id, key, count, "lastRequest") VALUES ('r1', 'ip', 1, 1);
				INSERT INTO recovery_conversations (id, organization_id, workspace_id, jurisdiction, created_at, fact_seq, deleted_at) VALUES ('c1', 'o1', '${workspace}', 'eu', 1, 7, 5), ('c2', 'o1', '${workspace}', NULL, 2, 0, NULL);
				INSERT INTO recovery_runs (id, conversation_id, input_digest, created_at) VALUES ('run1', 'c1', 'digest', 3), ('run2', 'c2', NULL, 4);
				INSERT INTO instance_identity (id, name, test) VALUES (1, 'acme', 0);
			`);
			const all = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
			expect(Object.fromEntries(RETIRED.map((table) => [table, all(`SELECT count(*) AS n FROM "${table}"`)[0]?.n]))).toEqual(Object.fromEntries(RETIRED.map((table) => [table, 1])));
			// The rows bind: a parent dropped before its children is refused, which is why 0013 drops children first.
			expect(() => db.exec('DROP TABLE "user"')).toThrow(/FOREIGN KEY constraint failed/);

			const retire = MIGRATIONS.find((migration) => migration.name.startsWith("0013_"));
			const recorded = `INSERT INTO d1_migrations (name) VALUES ('${retire?.name}');`;
			db.exec(transaction ? `BEGIN; ${retire?.sql} ${recorded} COMMIT;` : `${retire?.sql} ${recorded}`);

			expect(all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
			expect(all("SELECT type, name FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT IN ('d1_migrations', 'sqlite_sequence') ORDER BY name")).toEqual([
				{ type: "table", name: "instance_identity" },
				{ type: "table", name: "recovery_conversations" },
				{ type: "table", name: "recovery_runs" },
				{ type: "index", name: "recovery_runs_conversation" },
			]);
			expect(all("SELECT * FROM recovery_conversations ORDER BY id")).toEqual([
				{ id: "c1", organization_id: "o1", workspace_id: workspace, jurisdiction: "eu", created_at: 1, fact_seq: 7, deleted_at: 5 },
				{ id: "c2", organization_id: "o1", workspace_id: workspace, jurisdiction: null, created_at: 2, fact_seq: 0, deleted_at: null },
			]);
			expect(all("SELECT * FROM recovery_runs ORDER BY id")).toEqual([
				{ id: "run1", conversation_id: "c1", input_digest: "digest", created_at: 3 },
				{ id: "run2", conversation_id: "c2", input_digest: null, created_at: 4 },
			]);
			expect(all("SELECT * FROM instance_identity")).toEqual([{ id: 1, name: "acme", test: 0 }]);
			expect(all("PRAGMA foreign_key_check")).toEqual([]);
			expect(all("SELECT name FROM d1_migrations ORDER BY id").map((row) => row.name)).toEqual(FILES);
			db.close();
		}
	});

	test("does not depend on the order the files are given in", () => {
		expect(compareSchemas(expectedSchema([...MIGRATIONS].reverse()), expected)).toEqual([]);
	});

	test("a migration that does not run is reported by its name", () => {
		expect(() => expectedSchema([...MIGRATIONS, { name: "9999_broken.sql", sql: "ALTER TABLE nothing ADD COLUMN x TEXT;" }])).toThrow(/9999_broken\.sql does not run/);
	});
});

// The migrations leave no UNIQUE constraint, unique index or cascading foreign key since 0013, so the comparison is
// checked on a schema of its own that has every kind of constraint it compares.
const FIXTURE = [
	{
		name: "0001_owners.sql",
		sql: `CREATE TABLE owners (id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL UNIQUE, note TEXT) STRICT;
CREATE TABLE pets (id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE, name TEXT NOT NULL, born INTEGER) STRICT;
CREATE UNIQUE INDEX pets_owner_name ON pets (owner_id, name);
CREATE TABLE tags (tag TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (tag, owner_id)) STRICT;`,
	},
];
const fixture = expectedSchema(FIXTURE);
/** What the comparison finds in a database built from the fixture, then changed by `change`. */
const drift = (change: (db: DatabaseSync) => void) => compareSchemas(fixture, deployed(FIXTURE, change));

describe("the comparison", () => {
	test("passes for a database the migrations built, whatever D1 adds of its own", () => {
		expect(compareSchemas(expected, deployed(MIGRATIONS))).toEqual([]);
		expect(compareSchemas(fixture, deployed(FIXTURE))).toEqual([]);
	});

	test("finds a missing table, and a table no migration made", () => {
		expect(drift((db) => db.exec("DROP TABLE pets"))).toEqual(["Table pets is missing.", "The index pets_owner_name is missing."]);
		expect(drift((db) => db.exec("CREATE TABLE scratch (id TEXT)"))).toEqual(["Table scratch is not made by any migration."]);
	});

	test("finds a missing column, an extra column, and a column of another shape", () => {
		expect(drift((db) => db.exec("ALTER TABLE owners DROP COLUMN note"))).toEqual(["Column owners.note is missing."]);
		expect(drift((db) => db.exec("ALTER TABLE pets ADD COLUMN scratch TEXT"))).toEqual(["Column pets.scratch is not made by any migration."]);
		expect(drift((db) => db.exec("ALTER TABLE owners RENAME COLUMN note TO stamp"))).toEqual(["Column owners.note is missing.", "Column owners.stamp is not made by any migration."]);
	});

	test("finds a column whose type, NOT NULL, default or primary key differs", () => {
		const shape = { type: "TEXT", notNull: true, default: null, primaryKey: 0 };
		expect(fixture.tables.get("pets")?.get("name")).toEqual(shape);
		const edit = (change: Partial<typeof shape> | { default: string }) => {
			const copy = structuredClone(fixture);
			copy.tables.get("pets")?.set("name", { ...shape, ...change });
			return compareSchemas(fixture, copy);
		};
		const made = "the migrations make it TEXT, NOT NULL, no default, not in the primary key";
		expect(edit({ type: "INTEGER" })).toEqual([`Column pets.name differs: ${made}; the database has INTEGER, NOT NULL, no default, not in the primary key.`]);
		expect(edit({ notNull: false })).toEqual([`Column pets.name differs: ${made}; the database has TEXT, nullable, no default, not in the primary key.`]);
		expect(edit({ default: "'x'" })).toEqual([`Column pets.name differs: ${made}; the database has TEXT, NOT NULL, default 'x', not in the primary key.`]);
		expect(edit({ primaryKey: 1 })).toEqual([`Column pets.name differs: ${made}; the database has TEXT, NOT NULL, no default, primary key 1.`]);
		// The order of the columns is not drift: a table rebuilt in another order has the same columns.
		const reordered = structuredClone(fixture);
		reordered.tables.set("pets", new Map([...(fixture.tables.get("pets") ?? [])].reverse()));
		expect(compareSchemas(fixture, reordered)).toEqual([]);
	});

	test("finds a missing index, an extra one, and one that is not unique any more", () => {
		expect(fixture.objects.get("index pets_owner_name")).toEqual({ type: "index", table: "pets", statement: "create unique index pets_owner_name on pets (owner_id, name)" });
		expect(drift((db) => db.exec("DROP INDEX pets_owner_name"))).toEqual(["The index pets_owner_name is missing."]);
		expect(drift((db) => db.exec("CREATE INDEX scratch_idx ON pets (born)"))).toEqual(["The index scratch_idx is not made by any migration."]);
		expect(drift((db) => db.exec("DROP INDEX pets_owner_name; CREATE INDEX pets_owner_name ON pets (owner_id, name)"))).toEqual([
			"The index pets_owner_name differs from the migrations' (on pets: create unique index pets_owner_name on pets (owner_id, name); the database has, on pets: create index pets_owner_name on pets (owner_id, name)).",
		]);
	});

	test("the statement is compared without its spacing or case", () => {
		expect(normalized("CREATE  UNIQUE INDEX\n  a ON t (\n  x ,  y\n)")).toBe(normalized("create unique index a on t (x , y)"));
	});

	test("finds a UNIQUE constraint that was removed, whatever its automatic index is called", () => {
		expect(fixture.constraints.get("owners")).toEqual(new Set(["primary key (id)", "unique (email)"]));
		// Rebuilt without the constraint, as a hand-made migration would do.
		const found = drift((db) => db.exec("PRAGMA foreign_keys = off; CREATE TABLE owners_new (id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL, note TEXT) STRICT; INSERT INTO owners_new SELECT * FROM owners; DROP TABLE owners; ALTER TABLE owners_new RENAME TO owners"));
		expect(found).toEqual(["Table owners lacks the unique (email)."]);
	});

	test("finds a composite key whose columns are in another order", () => {
		expect(fixture.constraints.get("tags")).toEqual(new Set(["primary key (tag, owner_id)"]));
		expect(drift((db) => db.exec("DROP TABLE tags; CREATE TABLE tags (tag TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (owner_id, tag)) STRICT"))).toEqual([
			"Column tags.tag differs: the migrations make it TEXT, NOT NULL, no default, primary key 1; the database has TEXT, NOT NULL, no default, primary key 2.",
			"Column tags.owner_id differs: the migrations make it TEXT, NOT NULL, no default, primary key 2; the database has TEXT, NOT NULL, no default, primary key 1.",
			"Table tags lacks the primary key (tag, owner_id).",
			"Table tags has a primary key (owner_id, tag) that no migration made.",
		]);
	});

	test("finds a changed foreign key, and one removed", () => {
		const cascade = "foreign key (owner_id) references owners (id) on update no action on delete cascade";
		expect(fixture.constraints.get("pets")).toEqual(new Set(["primary key (id)", cascade]));
		const changed = structuredClone(fixture);
		changed.constraints.get("pets")?.delete(cascade);
		changed.constraints.get("pets")?.add(cascade.replace("on delete cascade", "on delete no action"));
		expect(compareSchemas(fixture, changed)).toEqual([`Table pets lacks the ${cascade}.`, "Table pets has a foreign key (owner_id) references owners (id) on update no action on delete no action that no migration made."]);
	});

	test("a string literal in an index is compared as written, the rest without its spacing or case", () => {
		const built = (where: string) => expectedSchema([{ name: "1.sql", sql: `CREATE TABLE t (x TEXT); CREATE INDEX i ON t (x) WHERE x = ${where};` }]);
		expect(compareSchemas(built("'Admin'"), built("'admin'"))).toHaveLength(1);
		expect(compareSchemas(built("'Admin'"), built("'Admin'"))).toEqual([]);
		expect(normalized("CREATE  INDEX I ON t (\n x ) WHERE x = 'It''s  A'")).toBe("create index i on t (x) where x = 'It''s  A'");
	});

	test("a view or trigger made by hand is found too", () => {
		expect(drift((db) => db.exec("CREATE VIEW scratch_view AS SELECT 1 AS one"))).toEqual(["The view scratch_view is not made by any migration."]);
	});

	test("reports every difference, not the first", () => {
		expect(drift((db) => db.exec("DROP INDEX pets_owner_name; CREATE TABLE scratch (id TEXT); ALTER TABLE owners DROP COLUMN note"))).toEqual([
			"Column owners.note is missing.",
			"Table scratch is not made by any migration.",
			"The index pets_owner_name is missing.",
		]);
	});
});

describe("the applied migrations", () => {
	test("match the files, in both directions", () => {
		expect(compareMigrations(FILES, [...FILES])).toEqual([]);
		expect(compareMigrations(FILES, FILES.slice(0, -1))).toEqual([`Migration ${FILES.at(-1)} is not applied.`]);
		const found = compareMigrations(FILES, [...FILES, "0099_later.sql"]);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/^Migration 0099_later\.sql is applied but is not in migrations\//);
	});
});

describe("reading cf d1 query's output", () => {
	const rows = [{ name: "a" }, { name: "b" }];

	test("takes the API's list of statement results, wrapped or not", () => {
		const statement = { results: rows, success: true, meta: { duration: 1 } };
		expect(rowsFrom(JSON.stringify([statement]))).toEqual(rows);
		expect(rowsFrom(JSON.stringify({ result: [statement], success: true }))).toEqual(rows);
	});

	test("takes the rows themselves, and an empty answer", () => {
		expect(rowsFrom(JSON.stringify(rows))).toEqual(rows);
		expect(rowsFrom("[]")).toEqual([]);
		expect(rowsFrom(JSON.stringify([{ results: [], success: true }]))).toEqual([]);
	});

	test("refuses what it does not understand, so that an unreadable database never passes", () => {
		for (const output of ["", "Error: not signed in", "{}", '"text"', "[1, 2]", JSON.stringify([{ results: rows }, { results: rows }]), JSON.stringify([{ results: rows, success: false }]), JSON.stringify([{ results: "no" }])]) {
			expect(() => rowsFrom(output), output).toThrow();
		}
	});

	test("a row of the wrong shape is refused when the schema is read", () => {
		const none = { tables: [], columns: [], objects: [], uniques: [], foreignKeys: [] };
		expect(() => schemaOf({ ...none, tables: [{ name: "t" }], columns: [{ tbl: "t", name: "a", type: "TEXT", notnull: "0", dflt: null, pk: 0 }] })).toThrow(/no number "notnull"/);
		expect(() => schemaOf({ ...none, columns: [{ tbl: "t", name: "a", type: "TEXT", notnull: 0, dflt: null, pk: 0 }] })).toThrow(/table it did not list/);
		expect(() => schemaOf({ ...none, tables: [{ name: 7 }] })).toThrow(/no text "name"/);
		expect(() => schemaOf({ ...none, uniques: [{ tbl: "t", idx: "i", origin: "u", seqno: 0, col: "a" }] })).toThrow(/constraint of a table it did not list/);
	});
});

describe("what may be sent to the database", () => {
	test("the queries are single SELECT statements", () => {
		for (const sql of [TABLES_SQL, COLUMNS_SQL, OBJECTS_SQL, UNIQUES_SQL, FOREIGN_KEYS_SQL, APPLIED_SQL]) expect(readOnly(sql)).toBe(sql);
	});

	test("nothing else is", () => {
		for (const sql of ["DROP TABLE user", "DELETE FROM d1_migrations", "SELECT 1; DROP TABLE user", "  insert into t values (1)", "PRAGMA writable_schema = on", "WITH x AS (SELECT 1) DELETE FROM t"]) {
			expect(() => readOnly(sql), sql).toThrow(/Refusing/);
		}
		// A semicolon inside a string literal is not a second statement.
		expect(readOnly("SELECT ';' AS semicolon")).toBe("SELECT ';' AS semicolon");
	});
});

// These cases run the script in child Node processes, which on a loaded runner outlast vitest's 5 s default.
describe("scripts/schema-check.ts, with a stand-in for cf that answers from a local SQLite file", { timeout: 30_000 }, () => {
	const SCRIPT = new URL("../../scripts/schema-check.ts", import.meta.url).pathname;
	// Two instances, in a directory of their own (scripts/instance.ts): a production one, named, and the only test one.
	const PRODUCTION = namesOf("acme").d1;
	const TEST = namesOf("acme-test").d1;
	const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
	// The account both instances are recorded on, and another; neither is ever printed.
	const ACCOUNT = "0123456789abcdef0123456789abcdef";
	const OTHER = "fedcba9876543210fedcba9876543210";
	// `cf auth whoami`, `cf d1 list` and `cf d1 query` as a node script: the answers come from FAKE_ACCOUNTS and the
	// file in FAKE_D1, every call is logged.
	const FAKE_CF = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "auth" && args[1] === "whoami") {
	console.log(JSON.stringify({ authenticated: true, accounts: process.env.FAKE_ACCOUNTS.split(",").map((id) => ({ id })) }));
} else if (args[0] === "d1" && args[1] === "list") {
	if (process.env.FAKE_GARBAGE) { console.log("not JSON for ${DATABASE_ID}"); process.exit(0); }
	console.log(JSON.stringify(process.env.FAKE_NO_DATABASE ? [] : [{ uuid: "${DATABASE_ID}", name: args[3] }]));
} else if (args[0] === "d1" && args[1] === "query" && args[3] === "--sql") {
	if (process.env.FAKE_FAIL) { console.error("authentication failed for ${DATABASE_ID}"); process.exit(1); }
	const db = new DatabaseSync(process.env.FAKE_D1, { readOnly: true });
	console.log(JSON.stringify([{ results: db.prepare(args[4]).all(), success: true, meta: {} }]));
} else {
	console.error("unexpected: " + args.join(" "));
	process.exit(2);
}
`;

	function run(change: (db: DatabaseSync) => void, extra: Record<string, string> = {}, flags: string[] = ["--instance", "acme"]) {
		const dir = mkdtempSync(join(tmpdir(), "schema-check-"));
		try {
			const instances = join(dir, "instances");
			mkdirSync(instances, { mode: 0o700 });
			for (const [name, test] of [
				["acme", false],
				["acme-test", true],
			] as const) {
				mkdirSync(join(instances, name), { mode: 0o700 });
				writeFileSync(join(instances, name, "instance.json"), JSON.stringify({ name, test, account: ACCOUNT }), { mode: 0o600 });
			}
			const file = join(dir, "d1.sqlite");
			const db = new DatabaseSync(file);
			for (const migration of MIGRATIONS) db.exec(migration.sql);
			db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
			for (const name of FILES) db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
			change(db);
			db.close();
			writeFileSync(join(dir, "cf"), FAKE_CF);
			chmodSync(join(dir, "cf"), 0o755);
			const log = join(dir, "calls.log");
			writeFileSync(log, "");
			const env: Record<string, string | undefined> = { ...process.env, MINERVA_INSTANCE: undefined, MINERVA_INSTANCES_DIR: instances, CLOUDFLARE_ACCOUNT_ID: undefined, PATH: `${dir}:${process.env.PATH}`, FAKE_ACCOUNTS: ACCOUNT, FAKE_D1: file, FAKE_LOG: log, ...extra };
			const result = spawnSync(process.execPath, [SCRIPT, ...flags], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
			const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
			return { status: result.status, out: result.stdout, err: result.stderr, calls };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("passes for a database the migrations built, asking only SELECTs, and never prints the database's id", () => {
		const result = run(() => {});
		expect(result.err.replace(/\(node:\d+\)[^\n]*\n/g, "").replace(/\(Use `node --trace[^\n]*\n/g, "")).toBe("");
		expect(result.status).toBe(0);
		expect(result.out).toMatch(new RegExp(`^The schema of ${PRODUCTION} matches the migrations \\(\\d+ tables, \\d+ columns, \\d+ indexes and other objects, ${FILES.length} migrations\\)\\.\\n$`));
		expect(result.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["auth whoami", "d1 list", ...Array(6).fill("d1 query")]);
		for (const call of result.calls.slice(2)) expect(call[4], call[4]).toMatch(/^SELECT /);
		expect(result.out + result.err).not.toContain(DATABASE_ID);
		expect(result.out + result.err).not.toContain(ACCOUNT);
	});

	test("with --test it reads the only test instance's database; MINERVA_INSTANCE names one too", () => {
		for (const [extra, flags] of [
			[{}, ["--test"]],
			[{ MINERVA_INSTANCE: "acme-test" }, []],
			[{ MINERVA_INSTANCE: "acme-test" }, ["--instance", "acme-test"]],
		] as const) {
			const result = run(() => {}, extra, [...flags]);
			expect(result.status).toBe(0);
			expect(result.calls[1]).toEqual(["d1", "list", "--name", TEST]);
			expect(result.out).toContain(`The schema of ${TEST} matches`);
		}
	});

	test("it reads nothing without an instance it can tell: no name for production, or a flag MINERVA_INSTANCE contradicts", () => {
		const unnamed = run(() => {}, {}, []);
		expect(unnamed.status).toBe(2);
		expect(unnamed.err).toContain("a production instance is never chosen by default");
		expect(unnamed.calls).toEqual([]);
		const contradicted = run(() => {}, { MINERVA_INSTANCE: "acme" }, ["--instance", "acme-test"]);
		expect(contradicted.status).toBe(2);
		expect(contradicted.err).toContain("--instance acme-test and MINERVA_INSTANCE=acme name different instances.");
		expect(contradicted.calls).toEqual([]);
		const production = run(() => {}, { MINERVA_INSTANCE: "acme" }, ["--test"]);
		expect(production.status).toBe(2);
		expect(production.err).toContain("acme is a production instance, and this runs only against a test instance.");
	});

	test("it reads nothing on any account but the instance's", () => {
		const elsewhere = run(() => {}, { CLOUDFLARE_ACCOUNT_ID: OTHER, FAKE_ACCOUNTS: `${ACCOUNT},${OTHER}` });
		expect(elsewhere.status).toBe(2);
		expect(elsewhere.err).toContain("CLOUDFLARE_ACCOUNT_ID is not the account acme is on");
		const unreachable = run(() => {}, { FAKE_ACCOUNTS: OTHER });
		expect(unreachable.status).toBe(2);
		expect(unreachable.err).toContain("cf cannot reach the account acme is on");
		for (const result of [elsewhere, unreachable]) {
			expect(result.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["auth whoami"]);
			expect(result.out + result.err).not.toContain(ACCOUNT);
			expect(result.out + result.err).not.toContain(OTHER);
		}
	});

	test("fails on a missing column and an unapplied migration, naming both and nothing of the id", () => {
		const result = run((db) => {
			db.exec("ALTER TABLE recovery_conversations DROP COLUMN deleted_at");
			db.exec(`DELETE FROM d1_migrations WHERE name = '${FILES.at(-1)}'`);
		});
		expect(result.status).toBe(1);
		expect(result.err).toContain(`The schema of ${PRODUCTION} is not what the migrations make:`);
		expect(result.err).toContain("- Column recovery_conversations.deleted_at is missing.");
		expect(result.err).toContain(`- Migration ${FILES.at(-1)} is not applied.`);
		expect(result.out + result.err).not.toContain(DATABASE_ID);
	});

	test("fails on a table made by hand", () => {
		const result = run((db) => db.exec("CREATE TABLE scratch (id TEXT)"));
		expect(result.status).toBe(1);
		expect(result.err).toContain("- Table scratch is not made by any migration.");
	});

	test("fails, never passes, when the database cannot be read or does not exist, apart from drift (exit 2, not 1)", () => {
		const unreadable = run(() => {}, { FAKE_FAIL: "1" });
		expect(unreadable.status).toBe(2);
		expect(unreadable.err).toContain("failed");
		expect(unreadable.out + unreadable.err).not.toContain(DATABASE_ID);
		const missing = run(() => {}, { FAKE_NO_DATABASE: "1" });
		expect(missing.status).toBe(2);
		expect(missing.err).toContain(`No D1 database named ${PRODUCTION}.`);
		expect(missing.calls).toHaveLength(2);
		// An answer it cannot parse throws where nothing catches it: still 2, never drift's 1.
		const garbage = run(() => {}, { FAKE_GARBAGE: "1" });
		expect(garbage.status).toBe(2);
		expect(garbage.err).toContain("The schema check stopped:");
	});

	test("both deploys run it after the builds, the identity check and the resources check, before uploading anything", () => {
		const scripts = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
		expect(scripts.deploy).toBe("node scripts/deploy.ts");
		expect(scripts["deploy:test"]).toBe("node scripts/deploy.ts --test");
		// scripts/deploy.ts: the locks (the checkout's, then the instance's) and the account, everything local, the
		// account's subdomain, the stray namespaces and the identity (read-only), then the first change on the account (the
		// identity row, written by the identity check once it has passed), the migrations and the upload.
		const deploy = readFileSync(new URL("../../scripts/deploy.ts", import.meta.url), "utf8");
		expect(deploy).toContain('run(process.execPath, ["scripts/identity.ts", ...(record ? ["--record"] : [])], { print: true });');
		const order = [
			"lockOperation(INSTANCE);",
			"const account = pinAccount(",
			'"scripts/secrets.ts", "check"',
			'run("cf", ["build", "--mode", MODE], { print: false })',
			'"scripts/bundle.ts"',
			"appBuildProblems(",
			'"scripts/secrets.ts", "subset"',
			"accountSubdomain();",
			"strayClasses(ownNamespaces(APP), app)",
			"checkIdentity(true);",
			'run(process.execPath, ["scripts/resources.ts"]',
			'"scripts/schema-check.ts"',
			'run("cf", ["deploy", "--prebuilt", "--secrets-file", upload]',
		].map((call) => deploy.indexOf(call));
		expect(order.every((index) => index > 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

// These cases run the script in child Node processes, which on a loaded runner outlast vitest's 5 s default.
describe("scripts/identity.ts, with a stand-in for cf: D1 in a local SQLite file, and the app's Worker", { timeout: 30_000 }, () => {
	// The scripts run from a copy of the checkout, so that the locks --record takes are the copy's, never this
	// checkout's (where a deploy may be running).
	const SOURCES = { scripts: new URL("../../scripts/", import.meta.url).pathname, migrations: new URL("../../migrations/", import.meta.url).pathname };
	const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
	const ACCOUNT = "0123456789abcdef0123456789abcdef";
	// `cf auth whoami`, `cf d1 list`, `cf d1 query` (a write when it holds more than one statement), `cf workers
	// scripts search`, `cf workers deployments list` and `cf workers versions get`, answered from the FAKE_ variables
	// and the file in FAKE_D1. Every call is logged; a call starting with FAKE_FAIL fails.
	const FAKE_CF = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_FAIL && args.join(" ").startsWith(process.env.FAKE_FAIL)) { console.error("cf failed" + (args.includes("${DATABASE_ID}") ? " for ${DATABASE_ID}" : "")); process.exit(1); }
const command = args.slice(0, 2).join(" ");
if (command === "auth whoami") {
	console.log(JSON.stringify({ authenticated: true, accounts: [{ id: "${ACCOUNT}" }] }));
} else if (command === "d1 list") {
	console.log(JSON.stringify(process.env.FAKE_NO_DATABASE ? [] : [{ uuid: "${DATABASE_ID}", name: args[3] }]));
} else if (command === "d1 query" && args[2] === "${DATABASE_ID}" && args[3] === "--sql") {
	const db = new DatabaseSync(process.env.FAKE_D1);
	const sql = args[4];
	if (sql.replace(/'(?:[^']|'')*'/g, "").includes(";")) {
		if (!process.env.FAKE_WRITE_FAILS) db.exec(sql);
		console.log(JSON.stringify(sql.split(";").map(() => ({ results: [], success: !process.env.FAKE_WRITE_FAILS }))));
	} else console.log(JSON.stringify([{ results: db.prepare(sql).all(), success: true, meta: {} }]));
} else if (command === "workers scripts" && args[2] === "search" && args[3] === "--name") {
	const workers = process.env.FAKE_WORKERS.split(",").filter((name) => name && name.includes(args[4]));
	console.log(JSON.stringify(workers.map((name, index) => ({ id: "w" + index, script_name: name }))));
} else if (command === "workers deployments" && args[2] === "list") {
	console.log(process.env.FAKE_DEPLOYMENTS || JSON.stringify({ deployments: [{ versions: [{ version_id: "v1", percentage: 100 }] }] }));
} else if (command === "workers versions" && args[2] === "get") {
	console.log(JSON.stringify({ id: args[3], env: JSON.parse(process.env.FAKE_ENV) }));
} else {
	console.error("unexpected: " + args.join(" "));
	process.exit(2);
}
`;

	/** The live version's bindings, as `cf workers versions get` answers them, of each build. */
	const object = (className: string) => ({ type: "durable_object_namespace", class_name: className, namespace_id: "n" });
	const APP = { DB: { type: "d1" }, CONVERSATION: object("Conversation"), MINERVA_SITE_URL: { type: "plain_text", text: "https://site.example" } };
	const PRODUCTION_BUILD = APP;
	const TEST_BUILD = { ...APP, FAULT_PROVIDER: object("FaultProvider") };
	// What the account shows of the quiesced Worker: it binds nothing of its own, and keeps the app's secrets.
	const QUIESCED = { MINERVA_SECRET_KEY: { type: "secret_text" }, MINERVA_SETUP_KEY: { type: "secret_text" } };

	let dir: string;
	let checkout: string;
	let d1: string;
	let log: string;
	/** What the account holds besides D1: its Workers (by name) and the app's live version. */
	let account: { workers: string[]; env: object; deployments?: object; fail?: string; noDatabase?: boolean; writeFails?: boolean };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "identity-"));
		checkout = join(dir, "checkout", "cloudflare");
		for (const [name, from] of Object.entries(SOURCES)) {
			mkdirSync(join(checkout, name), { recursive: true });
			for (const file of readdirSync(from)) if (/\.(ts|sql)$/.test(file)) copyFileSync(join(from, file), join(checkout, name, file));
		}
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ type: "module" }));
		const instances = join(dir, "instances");
		mkdirSync(instances, { mode: 0o700 });
		for (const [name, test] of [
			["acme", false],
			["acme-test", true],
		] as const) {
			mkdirSync(join(instances, name), { mode: 0o700 });
			writeFileSync(join(instances, name, "instance.json"), JSON.stringify({ name, test, account: ACCOUNT }), { mode: 0o600 });
		}
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin", "cf"), FAKE_CF);
		chmodSync(join(dir, "bin", "cf"), 0o755);
		d1 = join(dir, "d1.sqlite");
		new DatabaseSync(d1).close();
		log = join(dir, "calls.log");
		account = { workers: [], env: QUIESCED };
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function identity(flags: string[]) {
		writeFileSync(log, "");
		const env: Record<string, string | undefined> = {
			...process.env,
			MINERVA_INSTANCE: undefined,
			CLOUDFLARE_ACCOUNT_ID: undefined,
			MINERVA_INSTANCES_DIR: join(dir, "instances"),
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			FAKE_LOG: log,
			FAKE_D1: d1,
			FAKE_WORKERS: account.workers.join(","),
			FAKE_ENV: JSON.stringify(account.env),
			FAKE_DEPLOYMENTS: account.deployments ? JSON.stringify(account.deployments) : "",
			FAKE_FAIL: account.fail ?? "",
			FAKE_NO_DATABASE: account.noDatabase ? "1" : "",
			FAKE_WRITE_FAILS: account.writeFails ? "1" : "",
		};
		const result = spawnSync(process.execPath, [join(checkout, "scripts", "identity.ts"), ...flags], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
		const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
		const text = result.stdout + result.stderr;
		expect(text).not.toContain(DATABASE_ID);
		expect(text).not.toContain(ACCOUNT);
		return { status: result.status, out: result.stdout, err: result.stderr, calls };
	}

	/** The statements of `calls` that are not a single SELECT: the writes. */
	const writes = (calls: string[][]) => calls.filter((call) => call[1] === "query" && !/^SELECT [^;]*$/.test(call[4] ?? ""));

	function exec(sql: string): void {
		const db = new DatabaseSync(d1);
		db.exec(sql);
		db.close();
	}

	/** D1 as the migrations leave it: all of them, or (as before this check existed) all but the identity table's. */
	function migrate(withIdentity = true): void {
		const files = MIGRATIONS.filter((migration) => withIdentity || !migration.name.endsWith("_instance_identity.sql"));
		exec(`${files.map((migration) => migration.sql).join("\n")}\nCREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
	}

	function identityRows(): unknown[] {
		const db = new DatabaseSync(d1, { readOnly: true });
		try {
			const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'instance_identity'").all();
			return table.length ? db.prepare("SELECT id, name, test FROM instance_identity").all().map((row) => ({ ...row })) : [];
		} finally {
			db.close();
		}
	}

	function record(name: string, test: 0 | 1): void {
		exec(`CREATE TABLE IF NOT EXISTS instance_identity (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, test INTEGER NOT NULL CHECK (test IN (0, 1))) STRICT; INSERT INTO instance_identity VALUES (1, '${name}', ${test});`);
	}

	test("a row that agrees passes, reading D1 alone with SELECTs", () => {
		migrate();
		record("acme", 0);
		account = { workers: ["acme"], env: TEST_BUILD };
		const result = identity(["--instance", "acme"]);
		expect(result.err).toBe("");
		expect(result.status).toBe(0);
		expect(result.out).toBe("acme is a production instance, as its identity row in D1 says.\n");
		expect(result.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["auth whoami", "d1 list", "d1 query", "d1 query"]);
		expect(writes(result.calls)).toEqual([]);
		exec("DELETE FROM instance_identity; INSERT INTO instance_identity VALUES (1, 'acme-test', 1);");
		expect(identity(["--test"]).out).toBe("acme-test is a test instance, as its identity row in D1 says.\n");
	});

	test("a row that disagrees in name or kind stops, whatever the live app is, and --record writes nothing", () => {
		migrate();
		account = { workers: ["acme"], env: PRODUCTION_BUILD };
		for (const [name, test, message] of [
			["acme", 1, "D1 acme records the instance acme, a test instance, but"],
			["acme-other", 0, "D1 acme records the instance acme-other, a production instance, but"],
		] as const) {
			exec(`DELETE FROM instance_identity; INSERT INTO instance_identity VALUES (1, '${name}', ${test});`);
			const result = identity(["--instance", "acme", "--record"]);
			expect(result.status).toBe(1);
			expect(result.err).toContain(message);
			expect(result.err).toContain("they are not the same instance. Nothing was changed.");
			expect(writes(result.calls)).toEqual([]);
		}
	});

	test("without a table, the live app's bindings tell the kind, which must be the instance's", () => {
		migrate(false);
		for (const [flags, env, status, text] of [
			[["--instance", "acme"], PRODUCTION_BUILD, 0, "acme is a production instance, as its live app's bindings say (the production build); D1 has no identity row yet."],
			[["--test"], TEST_BUILD, 0, "acme-test is a test instance, as its live app's bindings say (the test build); D1 has no identity row yet."],
			[["--instance", "acme"], TEST_BUILD, 1, "acme serves the test build, but"],
			[["--instance", "acme-test"], PRODUCTION_BUILD, 1, "acme-test serves the production build, but"],
		] as const) {
			account = { workers: ["acme", "acme-test"], env };
			const result = identity([...flags]);
			expect(result.status, text).toBe(status);
			expect(result.out + result.err, text).toContain(text);
			expect(result.calls.map((call) => call.slice(0, 3).join(" ")).slice(-3), text).toEqual(["workers scripts search", "workers deployments list", "workers versions get"]);
			expect(writes(result.calls)).toEqual([]);
		}
	});

	test("an empty identity table is no row", () => {
		migrate();
		account = { workers: ["acme"], env: PRODUCTION_BUILD };
		expect(identity(["--instance", "acme"]).out).toContain("as its live app's bindings say");
	});

	test("bindings of neither build, or an app not served by one version, stop", () => {
		migrate(false);
		const { CONVERSATION: _conversation, ...noConversation } = APP;
		for (const env of [{ ...noConversation, FAULT_PROVIDER: object("FaultProvider") }, noConversation, { ...TEST_BUILD, FAULT_PROVIDER: { type: "d1" } }, { ...APP, CONVERSATION: { type: "d1" } }]) {
			account = { workers: ["acme"], env };
			const result = identity(["--instance", "acme"]);
			expect(result.status).toBe(1);
			expect(result.err).toContain("acme's live version has the bindings of neither the test build nor the production build");
		}
		account = { workers: ["acme"], env: PRODUCTION_BUILD, deployments: { deployments: [{ versions: [{ version_id: "v1", percentage: 50 }, { version_id: "v2", percentage: 50 }] }] } };
		const split = identity(["--instance", "acme"]);
		expect(split.status).toBe(2);
		expect(split.err).toContain("acme is not deployed as one version serving all traffic.");
	});

	test("with no row and no app (no Worker, or only the quiesced Worker of a reset), it passes only when D1 has no tables", () => {
		// Workers whose names contain the app's are not the app.
		for (const [workers, env, what] of [
			[["acme-test", "acme-test-cm"], PRODUCTION_BUILD, "no Worker"],
			[["acme", "acme-test"], QUIESCED, "only the quiesced Worker of a reset"],
		] as const) {
			account = { workers: [...workers], env };
			const fresh = identity(["--instance", "acme"]);
			expect(fresh.status).toBe(0);
			expect(fresh.out).toBe(`acme has no identity row, ${what}, and D1 has no tables: a fresh instance, or one whose reset has finished.\n`);
		}
		migrate(false);
		for (const [workers, what] of [
			[[], "no Worker"],
			[["acme"], "only the quiesced Worker of a reset"],
		] as const) {
			account = { workers: [...workers], env: QUIESCED };
			const held = identity(["--instance", "acme", "--record"]);
			expect(held.status).toBe(1);
			expect(held.err).toMatch(new RegExp(`^D1 acme has \\d+ tables, but no identity row, and acme is ${what}: which instance they belong to cannot be told\\. Nothing was changed\\.`));
			expect(writes(held.calls)).toEqual([]);
		}
	});

	test("every failed cf call stops the check (exit 2), and none reads as absent", () => {
		migrate(false);
		account = { workers: ["acme"], env: PRODUCTION_BUILD };
		for (const fail of ["auth whoami", "d1 list", "d1 query", "workers scripts search", "workers deployments list", "workers versions get"]) {
			account.fail = fail;
			const result = identity(["--instance", "acme", "--record"]);
			expect(result.status, fail).toBe(2);
			expect(result.out, fail).toBe("");
			expect(writes(result.calls), fail).toEqual([]);
			expect(identityRows(), fail).toEqual([]);
		}
		account = { workers: ["acme"], env: PRODUCTION_BUILD, noDatabase: true };
		const missing = identity(["--instance", "acme"]);
		expect(missing.status).toBe(1);
		expect(missing.err).toContain("No D1 database named acme: create it with cloudflare/README.md's First deploy commands");
	});

	test("a first deploy that stops after writing the row finds the row on its next run", () => {
		// A fresh instance: no Worker, no tables. The check passes, then --record writes the row, after every read
		// of the check and before nothing else, and reads it back.
		const first = identity(["--instance", "acme", "--record"]);
		expect(first.status).toBe(0);
		expect(first.out).toBe("acme has no identity row, no Worker, and D1 has no tables: a fresh instance, or one whose reset has finished.\nRecorded acme's identity in D1: a production instance.\n");
		const queries = first.calls.filter((call) => call[1] === "query");
		expect(writes(queries)).toHaveLength(1);
		expect(queries.findIndex((call) => writes([call]).length > 0)).toBe(queries.length - 3);
		expect(writes(queries)[0]?.[4]).toMatch(/^CREATE TABLE IF NOT EXISTS instance_identity \(.*\) STRICT; INSERT INTO instance_identity \(id, name, test\) VALUES \(1, 'acme', 0\) ON CONFLICT \(id\) DO NOTHING$/s);
		expect(identityRows()).toEqual([{ id: 1, name: "acme", test: 0 }]);
		// Its migrations then stopped halfway, before any Worker was uploaded: tables, and still no Worker.
		exec(MIGRATIONS[0]?.sql ?? "");
		const again = identity(["--instance", "acme", "--record"]);
		expect(again.status).toBe(0);
		expect(again.out).toBe("acme is a production instance, as its identity row in D1 says.\n");
		expect(writes(again.calls)).toEqual([]);
		// The migrations the next run applies do not touch the row (the table is the migration's own).
		exec(MIGRATIONS.slice(1).map((migration) => migration.sql).join("\n"));
		expect(identityRows()).toEqual([{ id: 1, name: "acme", test: 0 }]);
		// Without the row, the same account could not be told from another instance's.
		exec("DELETE FROM instance_identity");
		expect(identity(["--instance", "acme"]).status).toBe(1);
	});

	test("a reset that stops after quiescing finds the row on its next run, and a finished one passes as fresh", () => {
		// An instance deployed before the row existed: tables, and the production build serving.
		migrate(false);
		account = { workers: ["acme"], env: PRODUCTION_BUILD };
		const reset = identity(["--instance", "acme", "--production", "--record"]);
		expect(reset.status).toBe(0);
		expect(reset.out).toContain("as its live app's bindings say");
		expect(reset.out).toContain("Recorded acme's identity in D1: a production instance.");
		// Quiesced: the bindings are gone, the tables are still there.
		account.env = QUIESCED;
		const rerun = identity(["--instance", "acme", "--production", "--record"]);
		expect(rerun.status).toBe(0);
		expect(rerun.out).toBe("acme is a production instance, as its identity row in D1 says.\n");
		expect(writes(rerun.calls)).toEqual([]);
		exec("DELETE FROM instance_identity");
		expect(identity(["--instance", "acme", "--production"]).status).toBe(1);
		// The reset deleted D1 last and recreated it empty: nothing is left to tell, and nothing to lose.
		rmSync(d1);
		new DatabaseSync(d1).close();
		const finished = identity(["--instance", "acme", "--production"]);
		expect(finished.status).toBe(0);
		expect(finished.out).toContain("only the quiesced Worker of a reset, and D1 has no tables");
	});

	test("a write that fails leaves no row, and the next run writes it; a table left empty is no row and no table", () => {
		account.fail = `d1 query ${DATABASE_ID} --sql CREATE`;
		const failed = identity(["--instance", "acme", "--record"]);
		expect(failed.status).toBe(2);
		expect(failed.err).toMatch(/^The identity check could not run: /);
		expect(identityRows()).toEqual([]);
		// cf exits 0, but D1 reports the statements as failed.
		account.fail = undefined;
		account.writeFails = true;
		const reported = identity(["--instance", "acme", "--record"]);
		expect(reported.status).toBe(2);
		expect(reported.err).toBe("The identity check could not run: D1 acme did not report the identity write's 2 statements as done.\n");
		expect(identityRows()).toEqual([]);
		account.writeFails = false;
		exec("CREATE TABLE instance_identity (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, test INTEGER NOT NULL CHECK (test IN (0, 1))) STRICT");
		account.fail = undefined;
		const next = identity(["--instance", "acme", "--record"]);
		expect(next.status).toBe(0);
		expect(identityRows()).toEqual([{ id: 1, name: "acme", test: 0 }]);
	});

	test("the kind a reset's flag names must be the instance's; --record takes the locks, a read takes none", () => {
		const production = identity(["--instance", "acme-test", "--production"]);
		expect(production.status).toBe(2);
		expect(production.err).toBe("acme-test is a test instance, not a production one.\n");
		const test = identity(["--instance", "acme", "--test"]);
		expect(test.status).toBe(2);
		expect(test.err).toBe("acme is a production instance, and this runs only against a test instance.\n");
		expect(identity(["--instance", "acme", "--test", "--production"]).status).toBe(2);
		for (const result of [production, test]) expect(result.calls).toEqual([]);
		// A lock left by a run that died: a read goes ahead, a write stops before it reaches cf.
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(join(dir, "instances", "acme", "lock"), String(dead), { mode: 0o600 });
		expect(identity(["--instance", "acme"]).status).toBe(0);
		const locked = identity(["--instance", "acme", "--record"]);
		expect(locked.status).toBe(2);
		expect(locked.err).toContain("stopped without removing its lock");
		expect(locked.calls).toEqual([]);
		expect(identityRows()).toEqual([]);
	});
});
