// The deploy-time schema check (scripts/schema.ts): the comparison of the schema the migrations build with the
// answers of the deployed database, and the reading of `cf d1 query`'s output. The queries are the real ones,
// run on real SQLite; D1 itself is never asked here (deploys run scripts/schema-check.ts against the account).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { namesOf } from "../../scripts/instance.ts";
import { APPLIED_SQL, COLUMNS_SQL, FOREIGN_KEYS_SQL, OBJECTS_SQL, TABLES_SQL, UNIQUES_SQL, compareMigrations, compareSchemas, expectedSchema, normalized, readOnly, rowsFrom, schemaOf } from "../../scripts/schema.ts";

const DIR = new URL("../../migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter((file) => file.endsWith(".sql")).sort();
const MIGRATIONS = FILES.map((name) => ({ name, sql: readFileSync(new URL(name, DIR), "utf8") }));

/** A database as D1 would be after the migrations, then changed by `change`, read through the same queries. */
function deployed(change: (db: DatabaseSync) => void = () => {}) {
	const db = new DatabaseSync(":memory:");
	for (const migration of MIGRATIONS) db.exec(migration.sql);
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

describe("what the migrations build", () => {
	test("is the accounts, the workspace directory and Better Auth's tables, with their indexes", () => {
		for (const table of ["user", "session", "account", "verification", "twoFactor", "organization", "member", "workspaces", "memberships", "oauth_flows", "oauth_clients", "instance_settings", "instance_setup", "invitation", "rateLimit"]) {
			expect([...expected.tables.keys()], table).toContain(table);
		}
		expect(expected.tables.get("session")?.get("ipAddress")).toEqual({ type: "TEXT", notNull: false, default: null, primaryKey: 0 });
		for (const gone of ["rate_limits", "totp_steps"]) expect(expected.tables.has(gone), gone).toBe(false);
		expect(expected.tables.get("session")?.has("credentialStamp")).toBe(false);
		expect(expected.tables.get("user")?.get("id")?.primaryKey).toBe(1);
		expect([...expected.objects.keys()].some((key) => key.startsWith("index "))).toBe(true);
		for (const hidden of ["d1_migrations", "_cf_KV", "sqlite_sequence"]) expect(expected.tables.has(hidden), hidden).toBe(false);
	});

	test("does not depend on the order the files are given in", () => {
		expect(compareSchemas(expectedSchema([...MIGRATIONS].reverse()), expected)).toEqual([]);
	});

	test("a migration that does not run is reported by its name", () => {
		expect(() => expectedSchema([...MIGRATIONS, { name: "9999_broken.sql", sql: "ALTER TABLE nothing ADD COLUMN x TEXT;" }])).toThrow(/9999_broken\.sql does not run/);
	});
});

describe("the comparison", () => {
	test("passes for a database the migrations built, whatever D1 adds of its own", () => {
		expect(compareSchemas(expected, deployed())).toEqual([]);
	});

	test("finds a missing table, and a table no migration made", () => {
		expect(compareSchemas(expected, deployed((db) => db.exec("DROP TABLE twoFactor")))).toContain("Table twoFactor is missing.");
		expect(compareSchemas(expected, deployed((db) => db.exec("CREATE TABLE scratch (id TEXT)")))).toEqual(["Table scratch is not made by any migration."]);
	});

	test("finds a missing column, an extra column, and a column of another shape", () => {
		expect(compareSchemas(expected, deployed((db) => db.exec('ALTER TABLE "session" DROP COLUMN "ipAddress"')))).toEqual(["Column session.ipAddress is missing."]);
		expect(compareSchemas(expected, deployed((db) => db.exec("ALTER TABLE workspaces ADD COLUMN scratch TEXT")))).toEqual(["Column workspaces.scratch is not made by any migration."]);
		const changed = compareSchemas(expected, deployed((db) => db.exec('ALTER TABLE "session" RENAME COLUMN "ipAddress" TO "stamp"')));
		expect(changed).toEqual(["Column session.ipAddress is missing.", "Column session.stamp is not made by any migration."]);
	});

	test("finds a column whose type, NOT NULL, default or primary key differs", () => {
		const table = [...expected.tables].find(([, columns]) => [...columns.values()].some((column) => column.notNull && column.default === null && column.primaryKey === 0));
		expect(table).toBeDefined();
		const [name, columns] = table as [string, Map<string, { type: string; notNull: boolean; default: string | null; primaryKey: number }>];
		const [column, shape] = [...columns].find(([, candidate]) => candidate.notNull && candidate.default === null && candidate.primaryKey === 0) as [string, { type: string; notNull: boolean; default: string | null; primaryKey: number }];
		const edit = (change: Partial<typeof shape>) => {
			const copy = structuredClone(expected);
			copy.tables.get(name)?.set(column, { ...shape, ...change });
			return compareSchemas(expected, copy);
		};
		for (const change of [{ type: shape.type === "TEXT" ? "INTEGER" : "TEXT" }, { notNull: false }, { default: "'x'" }, { primaryKey: 1 }]) {
			const differences = edit(change);
			expect(differences, JSON.stringify(change)).toHaveLength(1);
			expect(differences[0], JSON.stringify(change)).toMatch(new RegExp(`^Column ${name}\\.${column} differs: the migrations make it .*; the database has .*\\.$`));
		}
		// The order of the columns is not drift: a table rebuilt in another order has the same columns.
		const reordered = structuredClone(expected);
		const first = reordered.tables.get(name) as Map<string, typeof shape>;
		reordered.tables.set(name, new Map([...first].reverse()));
		expect(compareSchemas(expected, reordered)).toEqual([]);
	});

	test("finds a missing index, an extra one, and one that is not unique any more", () => {
		const unique = [...expected.objects].find(([key]) => key === "index member_organization_user");
		expect(unique, "the migrations make a unique index").toBeDefined();
		const [key, shape] = unique as [string, { type: string; table: string; statement: string }];
		const name = key.slice("index ".length);
		expect(compareSchemas(expected, deployed((db) => db.exec(`DROP INDEX "${name}"`)))).toEqual([`The ${key} is missing.`]);
		expect(compareSchemas(expected, deployed((db) => db.exec(`CREATE INDEX scratch_idx ON "${shape.table}" ("userId")`)))).toEqual(["The index scratch_idx is not made by any migration."]);
		expect(shape.statement).toBe('create unique index member_organization_user on "member" ("organizationid", "userid")');
		const weaker = compareSchemas(expected, deployed((db) => db.exec(`DROP INDEX "${name}"; CREATE INDEX "${name}" ON "${shape.table}" ("organizationId", "userId")`)));
		expect(weaker).toHaveLength(1);
		expect(weaker[0]).toMatch(new RegExp(`^The ${key} differs from the migrations'`));
	});

	test("the statement is compared without its spacing or case", () => {
		expect(normalized("CREATE  UNIQUE INDEX\n  a ON t (\n  x ,  y\n)")).toBe(normalized("create unique index a on t (x , y)"));
	});

	test("finds a UNIQUE constraint that was removed, whatever its automatic index is called", () => {
		const uniques = [...expected.constraints].flatMap(([table, found]) => [...found].filter((constraint) => constraint.startsWith("unique")).map((constraint) => [table, constraint] as const));
		expect(uniques.length, "the migrations make UNIQUE constraints").toBeGreaterThan(0);
		// user.email (Better Auth's table) must stay unique: a sign-up with a taken address depends on it.
		expect(expected.constraints.get("user")).toContain("unique (email)");
		// Rebuilt without the constraint, as a hand-made migration would do.
		const found = compareSchemas(
			expected,
			deployed((db) => {
				db.exec("PRAGMA foreign_keys = off");
				const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'user'").get() as { sql: string };
				expect(row.sql).toMatch(/UNIQUE/i);
				db.exec(`ALTER TABLE "user" RENAME TO user_old; ${row.sql.replace(/\bUNIQUE\b/gi, "")}; INSERT INTO "user" SELECT * FROM user_old; DROP TABLE user_old`);
			}),
		);
		expect(found).toContain('Table user lacks the unique (email).');
	});

	test("finds a changed foreign key, and one removed", () => {
		const references = [...expected.constraints].flatMap(([table, found]) => [...found].filter((constraint) => constraint.startsWith("foreign key")).map((constraint) => [table, constraint] as const));
		expect(references.length, "the migrations make foreign keys").toBeGreaterThan(0);
		const [table, constraint] = references.find(([, candidate]) => candidate.includes("on delete cascade")) ?? (references[0] as readonly [string, string]);
		const changed = structuredClone(expected);
		changed.constraints.get(table)?.delete(constraint);
		changed.constraints.get(table)?.add(constraint.replace(/on delete [a-z ]+$/, "on delete no action"));
		const found = compareSchemas(expected, changed);
		expect(found).toContain(`Table ${table} lacks the ${constraint}.`);
		expect(found).toHaveLength(2);
	});

	test("a string literal in an index is compared as written, the rest without its spacing or case", () => {
		const built = (where: string) => expectedSchema([{ name: "1.sql", sql: `CREATE TABLE t (x TEXT); CREATE INDEX i ON t (x) WHERE x = ${where};` }]);
		expect(compareSchemas(built("'Admin'"), built("'admin'"))).toHaveLength(1);
		expect(compareSchemas(built("'Admin'"), built("'Admin'"))).toEqual([]);
		expect(normalized("CREATE  INDEX I ON t (\n x ) WHERE x = 'It''s  A'")).toBe("create index i on t (x) where x = 'It''s  A'");
	});

	test("a view or trigger made by hand is found too", () => {
		expect(compareSchemas(expected, deployed((db) => db.exec("CREATE VIEW scratch_view AS SELECT 1 AS one")))).toEqual(["The view scratch_view is not made by any migration."]);
	});

	test("reports every difference, not the first", () => {
		const found = compareSchemas(expected, deployed((db) => db.exec('DROP TABLE twoFactor; CREATE TABLE scratch (id TEXT); ALTER TABLE "session" DROP COLUMN "ipAddress"')));
		expect(found.length).toBeGreaterThanOrEqual(3);
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

describe("scripts/schema-check.ts, with a stand-in for cf that answers from a local SQLite file", () => {
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
		expect(result.out).toMatch(new RegExp(`^The schema of ${PRODUCTION} matches the migrations \\(\\d+ tables, \\d+ columns, \\d+ indexes and other objects, 8 migrations\\)\\.\\n$`));
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
			db.exec('ALTER TABLE "session" DROP COLUMN "ipAddress"');
			db.exec(`DELETE FROM d1_migrations WHERE name = '${FILES.at(-1)}'`);
		});
		expect(result.status).toBe(1);
		expect(result.err).toContain(`The schema of ${PRODUCTION} is not what the migrations make:`);
		expect(result.err).toContain("- Column session.ipAddress is missing.");
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

	test("both deploys run it after the builds and the resources check, before uploading anything", () => {
		const scripts = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
		expect(scripts.deploy).toBe("pnpm assets && node scripts/deploy.ts");
		expect(scripts["deploy:test"]).toBe("pnpm assets && node scripts/deploy.ts --test");
		// scripts/deploy.ts: the locks (the checkout's, then the instance's) and the account, everything local, then
		// the first change on the account (the migrations).
		const deploy = readFileSync(new URL("../../scripts/deploy.ts", import.meta.url), "utf8");
		const order = [
			"lockOperation(INSTANCE);",
			"const account = pinAccount(",
			'"scripts/secrets.ts", "check"',
			'run("cf", ["build", "--mode", MODE], { print: false })',
			'"scripts/bundle.ts"',
			'run("cf", ["build", "--mode", MODE], { cwd: FILES_DIR',
			"filesBuildProblems(",
			'run(process.execPath, ["scripts/resources.ts"]',
			'"scripts/schema-check.ts"',
			'run("cf", ["deploy", "--prebuilt", "--secrets-file", SECRETS]',
			'run("cf", ["deploy", "--prebuilt", "--secrets-file", subset], { cwd: FILES_DIR',
		].map((call) => deploy.indexOf(call));
		expect(order.every((index) => index > 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});
