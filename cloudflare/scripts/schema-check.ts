// Before a deploy: checks that the deployed D1 database has the tables, columns and indexes the migrations
// make (scripts/schema.ts), with their UNIQUE and FOREIGN KEY constraints, and the same list of applied migrations. `pnpm run deploy` runs it right after
// scripts/resources.ts, which has applied any new migration, and before `cf deploy`; `deploy:test` runs it with
// `--test` for minerva-cf-test. It only reads: `cf d1 query` with SELECT statements (`readOnly`). Drift stops
// the deploy; the database's id is never printed.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPLIED_SQL, COLUMNS_SQL, FOREIGN_KEYS_SQL, OBJECTS_SQL, TABLES_SQL, UNIQUES_SQL, compareMigrations, compareSchemas, expectedSchema, readOnly, rowsFrom, schemaOf } from "./schema.ts";

const NAME = process.argv.includes("--test") ? "minerva-cf-test" : "minerva-cf";
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** The database's id, once known: it is replaced in everything printed. */
let hidden = "";

function fail(message: string): never {
	console.error(`${hidden ? message.replaceAll(hidden, "<database>") : message}\nSee cloudflare/README.md, Deploy.`);
	process.exit(1);
}

function cf(args: string[]): string {
	try {
		return execFileSync("cf", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const { stdout, stderr } = error as { stdout?: string; stderr?: string };
		return fail(`\`cf ${args.slice(0, 2).join(" ")}\` failed:\n${`${stdout ?? ""}${stderr ?? ""}`.trim() || "(no output)"}`);
	}
}

const databases = JSON.parse(cf(["d1", "list", "--name", NAME])) as { uuid: string; name: string }[];
const database = databases.find((candidate) => candidate.name === NAME);
if (!database) fail(`No D1 database named ${NAME}.`);
hidden = database.uuid;

function ask(sql: string) {
	try {
		return rowsFrom(cf(["d1", "query", database?.uuid as string, "--sql", readOnly(sql)]));
	} catch (error) {
		return fail(`Reading the schema of ${NAME} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
let expected: ReturnType<typeof expectedSchema>;
try {
	expected = expectedSchema(files.map((name) => ({ name, sql: readFileSync(`${MIGRATIONS}${name}`, "utf8") })));
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
const actual = schemaOf({ tables: ask(TABLES_SQL), columns: ask(COLUMNS_SQL), objects: ask(OBJECTS_SQL), uniques: ask(UNIQUES_SQL), foreignKeys: ask(FOREIGN_KEYS_SQL) });
const applied = ask(APPLIED_SQL).map((row) => row.name);
if (!applied.every((name): name is string => typeof name === "string")) fail("The list of applied migrations has a name that is not text.");

const differences = [...compareSchemas(expected, actual), ...compareMigrations(files, applied)];
if (differences.length) {
	fail(`The schema of ${NAME} is not what the migrations make:\n${differences.map((line) => `- ${line}`).join("\n")}`);
}
const columns = [...actual.tables.values()].reduce((sum, table) => sum + table.size, 0);
console.log(`The schema of ${NAME} matches the migrations (${actual.tables.size} tables, ${columns} columns, ${actual.objects.size} indexes and other objects, ${applied.length} migrations).`);
