// The instance's identity on its account (cloudflare/README.md, Identity on the account): whether what the account
// holds under the instance's names is the instance its directory describes (scripts/instance.ts: its name, and
// whether it is a test instance). Every deploy runs it before the migrations (scripts/deploy.ts) and every reset
// before its listing (scripts/reset.ts), dry runs included, before anything on the account changes; by hand it
// only reads.
//
//   node scripts/identity.ts [--instance <name> | --test] [--production] [--record]
//
// What it reads, in order:
// 1. The row of `instance_identity` in D1 (migrations/0009_instance_identity.sql), with SELECT statements only. A
//    missing table, or an empty one, is no row. A row that disagrees with the directory stops.
// 2. Without a row, the live app: the bindings of the one version serving all of its traffic (scripts/account.ts,
//    `bindingsKind`). The other kind's build, a shape of neither, or an app not served by one version stops.
// 3. Without a row or a recognisable app (no Worker yet, or a reset's quiesced Worker), it passes only if D1 has no
//    tables: a fresh instance, or one whose reset has finished.
// Every cf call that fails stops it; none reads as "absent". --test and --production name the kind the caller
// expects (scripts/reset.ts passes its own flag). With --record (a deploy, or a reset with --yes, which hold the
// locks), once the check has passed and the row is missing, it creates the table with the migration's own
// statement and writes the row, the first change the command makes, and reads the row back: so a first deploy
// whose migrations then fail, or a reset that stops after quiescing, finds the row on its next run, where the
// live bindings no longer tell. A write that D1 does not report as done stops it too. Exit 0 when the identity is the instance's; 1 when it is not, or cannot be told;
// 2 when the check could not run. The database's id is never printed.

import { readFileSync } from "node:fs";
import { bindingsKind, liveBindings, workerExists } from "./account.ts";
import { type Instance, chooseInstance, parseInstanceArgs } from "./instance.ts";
import { ROOT, cfJson, hide, lockOperationUnlessParentHolds, pinAccount, redact, run } from "./run.ts";
import { readOnly, rowsFrom } from "./schema.ts";

const USAGE = "Usage: identity.ts [--instance <name> | --test] [--production] [--record]";
const TABLE = "instance_identity";
const MIGRATION = new URL("../migrations/0009_instance_identity.sql", import.meta.url);

/** Exit codes: not the instance's identity, or none it can tell; a check that could not run. */
const MISMATCH = 1;
const FAILED = 2;

/** The identity is not the instance's, or cannot be told. */
class Mismatch extends Error {}

function stop(message: string): never {
	throw new Mismatch(message);
}

let INSTANCE: Instance;
let RECORD: boolean;
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const unknown = rest.filter((arg) => !["--test", "--production", "--record"].includes(arg));
	if (unknown.length || (rest.includes("--test") && rest.includes("--production"))) throw new Error(`${unknown.length ? `Unknown arguments: ${unknown.join(" ")}. ` : ""}${USAGE}`);
	INSTANCE = chooseInstance({ flag, test: rest.includes("--test") });
	if (rest.includes("--production") && INSTANCE.test) throw new Error(`${INSTANCE.name} is a test instance, not a production one.`);
	RECORD = rest.includes("--record");
	if (RECORD) lockOperationUnlessParentHolds(INSTANCE);
	pinAccount([ROOT], [], INSTANCE, { record: false });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(FAILED);
}
const NAME = INSTANCE.name;
const { app: APP, d1: D1 } = INSTANCE.names;
const kind = (test: boolean) => (test ? "a test instance" : "a production instance");
const build = (test: boolean) => (test ? "the test build" : "the production build");

/** The rows of a read-only query of the database `id`. */
function query(id: string, sql: string): Record<string, unknown>[] {
	return rowsFrom(run("cf", ["d1", "query", id, "--sql", readOnly(sql)]).stdout);
}

/** The identity row, or null when the table is missing or empty; a malformed row stops. */
function identityRow(id: string): { name: string; test: boolean } | null {
	if (query(id, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${TABLE}'`).length === 0) return null;
	const rows = query(id, `SELECT id, name, test FROM ${TABLE}`);
	const [row] = rows;
	if (!row) return null;
	if (rows.length !== 1 || row.id !== 1 || typeof row.name !== "string" || (row.test !== 0 && row.test !== 1)) stop(`D1 ${D1}'s ${TABLE} is not one identity row: it cannot tell which instance this is.`);
	return { name: row.name, test: row.test === 1 };
}

/** D1's tables, apart from SQLite's, D1's own and an empty identity table (a write that stopped halfway). */
function tableCount(id: string): number {
	const [row] = query(id, `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> '${TABLE}'`);
	const count = row?.n;
	if (typeof count !== "number" || !Number.isInteger(count)) throw new Error(`D1 ${D1} did not answer a count of its tables.`);
	return count;
}

/** Stops unless D1 answered a write of `count` statements with each one's success, as `cf d1 query` prints it. */
function checkWritten(output: string, count: number): void {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`D1 ${D1}'s answer to the identity write is not JSON.`);
	}
	if (value && typeof value === "object" && !Array.isArray(value) && "result" in value) value = (value as { result: unknown }).result;
	const statements = Array.isArray(value) ? (value as { success?: unknown }[]) : [];
	if (statements.length !== count || !statements.every((statement) => statement?.success === true)) throw new Error(`D1 ${D1} did not report the identity write's ${count} statements as done.`);
}

/** The migration's statement, which creates the table (IF NOT EXISTS), without its comments or its semicolon. */
function createStatement(): string {
	const sql = readFileSync(MIGRATION, "utf8")
		.split("\n")
		.filter((line) => !/^\s*--/.test(line))
		.join("\n")
		.trim();
	if (!sql.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLE} (`) || sql.indexOf(";") !== sql.length - 1) throw new Error(`${MIGRATION.pathname} is not one CREATE TABLE IF NOT EXISTS ${TABLE} statement.`);
	return sql.slice(0, -1);
}

try {
	const database = cfJson<{ uuid: string; name: string }[]>(["d1", "list", "--name", D1]).find((candidate) => candidate.name === D1);
	if (!database) stop(`No D1 database named ${D1}: create it with cloudflare/README.md's First deploy commands, then run this again.`);
	hide(database.uuid);

	const row = identityRow(database.uuid);
	if (row) {
		if (row.name !== NAME || row.test !== INSTANCE.test) {
			stop(`D1 ${D1} records the instance ${row.name}, ${kind(row.test)}, but ${INSTANCE.files.instance} describes ${NAME}, ${kind(INSTANCE.test)}: they are not the same instance. Nothing was changed.`);
		}
		console.log(`${NAME} is ${kind(INSTANCE.test)}, as its identity row in D1 says.`);
	} else {
		const app = workerExists(APP) ? bindingsKind(liveBindings(APP)) : "none";
		if (app === "unknown") stop(`${APP}'s live version has the bindings of neither the test build nor the production build, and D1 has no identity row: which instance this is cannot be told. Nothing was changed.`);
		if (app === "test" || app === "production") {
			if ((app === "test") !== INSTANCE.test) stop(`${APP} serves ${build(app === "test")}, but ${INSTANCE.files.instance} describes ${kind(INSTANCE.test)}, and D1 has no identity row to say otherwise. Nothing was changed.`);
			console.log(`${NAME} is ${kind(INSTANCE.test)}, as its live app's bindings say (${build(INSTANCE.test)}); D1 has no identity row yet.`);
		} else {
			const what = app === "none" ? "no Worker" : "only the quiesced Worker of a reset";
			const tables = tableCount(database.uuid);
			if (tables > 0) stop(`D1 ${D1} has ${tables} tables, but no identity row, and ${APP} is ${what}: which instance they belong to cannot be told. Nothing was changed.`);
			console.log(`${NAME} has no identity row, ${what}, and D1 has no tables: a fresh instance, or one whose reset has finished.`);
		}
		if (RECORD) {
			if (!/^[a-z][a-z0-9-]*$/.test(NAME)) throw new Error(`${NAME} is not a name to write into SQL.`);
			checkWritten(run("cf", ["d1", "query", database.uuid, "--sql", `${createStatement()}; INSERT INTO ${TABLE} (id, name, test) VALUES (1, '${NAME}', ${INSTANCE.test ? 1 : 0}) ON CONFLICT (id) DO NOTHING`]).stdout, 2);
			const written = identityRow(database.uuid);
			if (!written || written.name !== NAME || written.test !== INSTANCE.test) stop(`D1 ${D1}'s identity row is not ${NAME}'s after it was written: another command wrote it. Nothing else was changed.`);
			console.log(`Recorded ${NAME}'s identity in D1: ${kind(INSTANCE.test)}.`);
		}
	}
} catch (error) {
	const message = redact(error instanceof Error ? error.message : String(error));
	if (error instanceof Mismatch) {
		console.error(message);
		process.exit(MISMATCH);
	}
	console.error(`The identity check could not run: ${message}`);
	process.exit(FAILED);
}
