// The deployed D1 database's schema against what the code expects (scripts/schema-check.ts runs it before
// `cf deploy`). Better Auth's own check is off (`validateSchema: false`, src/accounts/auth-options.ts), and
// nothing else notices a table or column that migrations/ never made, or one that is missing, until a request
// fails on it. What the code expects is what migrations/ builds: the files are run, in order, on an empty
// SQLite database, and the same read-only queries are asked of it and of D1.
//
// Compared: tables, their columns (name, declared type, NOT NULL, default, primary-key position; not the order),
// their UNIQUE and PRIMARY KEY constraints (the columns they cover, whatever the automatic index is called) and
// FOREIGN KEYs (columns, target, ON UPDATE and ON DELETE), indexes, views and triggers (name, table, and the
// statement without its spacing, string literals kept as they are), and the list of applied migrations. Not
// compared: CHECK clauses and collations inside a `CREATE TABLE`, which SQLite does not list. D1's and SQLite's
// own tables (`sqlite_…`, `_cf_…`) and the migrations table are left out of both sides.

import { DatabaseSync } from "node:sqlite";

/** D1's migrations table (`cf d1 migrations apply`), which the migrations do not make. */
export const MIGRATIONS_TABLE = "d1_migrations";

const USER_OBJECTS = (column: string) => `${column} NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND ${column} NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND ${column} <> '${MIGRATIONS_TABLE}'`;

/** Every column of every table. Only SELECT statements are ever sent to D1 (`readOnly`). */
export const COLUMNS_SQL = `SELECT m.name AS tbl, p.name AS name, p.type AS type, p."notnull" AS "notnull", p.dflt_value AS dflt, p.pk AS pk FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' AND ${USER_OBJECTS("m.name")} ORDER BY m.name, p.cid`;
/** Every index, view and trigger, with its statement. */
export const OBJECTS_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL AND ${USER_OBJECTS("name")} ORDER BY type, name`;
/** The columns each UNIQUE and PRIMARY KEY constraint covers (their automatic indexes, `origin` u and pk). */
export const UNIQUES_SQL = `SELECT m.name AS tbl, il.name AS idx, il.origin AS origin, ii.seqno AS seqno, ii.name AS col FROM sqlite_schema AS m JOIN pragma_index_list(m.name) AS il JOIN pragma_index_info(il.name) AS ii WHERE m.type = 'table' AND ${USER_OBJECTS("m.name")} AND il.origin IN ('u', 'pk') ORDER BY m.name, il.name, ii.seqno`;
/** Every foreign key, a row per column. */
export const FOREIGN_KEYS_SQL = `SELECT m.name AS tbl, f.id AS id, f.seq AS seq, f."table" AS ref, f."from" AS col, f."to" AS refcol, f.on_update AS on_update, f.on_delete AS on_delete FROM sqlite_schema AS m JOIN pragma_foreign_key_list(m.name) AS f WHERE m.type = 'table' AND ${USER_OBJECTS("m.name")} ORDER BY m.name, f.id, f.seq`;
/** The tables, so that one without columns is not missed. */
export const TABLES_SQL = `SELECT name FROM sqlite_schema WHERE type = 'table' AND ${USER_OBJECTS("name")} ORDER BY name`;
/** The migrations D1 has applied. */
export const APPLIED_SQL = `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`;

/** A statement that may be sent to the deployed database: one SELECT and nothing else. */
export function readOnly(sql: string): string {
	if (!/^\s*select\b/i.test(sql) || sql.replace(/'(?:[^']|'')*'/g, "''").includes(";")) throw new Error(`Refusing to send anything but a single SELECT to the database: ${sql.slice(0, 40)}…`);
	return sql;
}

export interface Column {
	type: string;
	notNull: boolean;
	/** The default expression as SQLite prints it; null if none. */
	default: string | null;
	/** Position in the primary key, 0 if not part of it. */
	primaryKey: number;
}

export interface SchemaObject {
	type: string;
	table: string;
	/** The statement with its spacing collapsed and its case folded. */
	statement: string;
}

export interface Schema {
	tables: Map<string, Map<string, Column>>;
	/** Each table's UNIQUE, PRIMARY KEY and FOREIGN KEY constraints, one line each. */
	constraints: Map<string, Set<string>>;
	objects: Map<string, SchemaObject>;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`The database's answer has no text "${key}": ${JSON.stringify(row).slice(0, 120)}`);
	return value;
}

function whole(row: Row, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`The database's answer has no number "${key}": ${JSON.stringify(row).slice(0, 120)}`);
	return value;
}

/**
 * A statement without its spacing or case: the same statement written with other line breaks, indentation or
 * capitals is equal. String literals ('Admin' and 'admin' in a partial index) are kept as they are.
 */
export function normalized(statement: string): string {
	return statement
		.split(/('(?:[^']|'')*')/)
		.map((part, index) => (index % 2 === 1 ? part : part.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase()))
		.join("")
		.trim();
}

export interface Answers {
	tables: Row[];
	columns: Row[];
	objects: Row[];
	uniques: Row[];
	foreignKeys: Row[];
}

/** The rows of `group` that share `key`, in order. */
function grouped(rows: Row[], key: (row: Row) => string): Row[][] {
	const groups = new Map<string, Row[]>();
	for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
	return [...groups.values()];
}

/** The schema from the answers to TABLES_SQL, COLUMNS_SQL, OBJECTS_SQL, UNIQUES_SQL and FOREIGN_KEYS_SQL. */
export function schemaOf(answers: Answers): Schema {
	const schema: Schema = { tables: new Map(), constraints: new Map(), objects: new Map() };
	for (const row of answers.tables) {
		schema.tables.set(text(row, "name"), new Map());
		schema.constraints.set(text(row, "name"), new Set());
	}
	for (const row of answers.columns) {
		const table = schema.tables.get(text(row, "tbl"));
		if (!table) throw new Error(`The database's answer has columns of a table it did not list: ${text(row, "tbl")}`);
		const dflt = row.dflt;
		if (dflt !== null && typeof dflt !== "string") throw new Error(`The database's answer has a default that is not text: ${JSON.stringify(row).slice(0, 120)}`);
		table.set(text(row, "name"), { type: text(row, "type").toUpperCase(), notNull: whole(row, "notnull") === 1, default: dflt, primaryKey: whole(row, "pk") });
	}
	const constraintsOf = (row: Row) => {
		const found = schema.constraints.get(text(row, "tbl"));
		if (!found) throw new Error(`The database's answer has a constraint of a table it did not list: ${text(row, "tbl")}`);
		return found;
	};
	// An automatic index, a row per column: the columns in order, whatever the index is called.
	for (const index of grouped(answers.uniques, (row) => `${text(row, "tbl")} ${text(row, "idx")}`)) {
		const [first] = index as [Row];
		const columns = [...index].sort((a, b) => whole(a, "seqno") - whole(b, "seqno")).map((row) => text(row, "col"));
		constraintsOf(first).add(`${text(first, "origin") === "pk" ? "primary key" : "unique"} (${columns.join(", ")})`);
	}
	for (const key of grouped(answers.foreignKeys, (row) => `${text(row, "tbl")} ${whole(row, "id")}`)) {
		const [first] = key as [Row];
		const ordered = [...key].sort((a, b) => whole(a, "seq") - whole(b, "seq"));
		const target = ordered.map((row) => (row.refcol === null ? "(its primary key)" : text(row, "refcol")));
		constraintsOf(first).add(
			`foreign key (${ordered.map((row) => text(row, "col")).join(", ")}) references ${text(first, "ref")} (${target.join(", ")}) on update ${text(first, "on_update")} on delete ${text(first, "on_delete")}`.toLowerCase(),
		);
	}
	for (const row of answers.objects) schema.objects.set(`${text(row, "type")} ${text(row, "name")}`, { type: text(row, "type"), table: text(row, "tbl_name"), statement: normalized(text(row, "sql")) });
	return schema;
}

function describeColumn(column: Column): string {
	return [column.type || "(no type)", column.notNull ? "NOT NULL" : "nullable", column.default === null ? "no default" : `default ${column.default}`, column.primaryKey ? `primary key ${column.primaryKey}` : "not in the primary key"].join(", ");
}

/** What is wrong with `actual` (D1) against `expected` (the migrations), one line each; none if it matches. */
export function compareSchemas(expected: Schema, actual: Schema): string[] {
	const differences: string[] = [];
	for (const [name, columns] of expected.tables) {
		const found = actual.tables.get(name);
		if (!found) {
			differences.push(`Table ${name} is missing.`);
			continue;
		}
		for (const [column, shape] of columns) {
			const have = found.get(column);
			if (!have) differences.push(`Column ${name}.${column} is missing.`);
			else if (describeColumn(have) !== describeColumn(shape)) differences.push(`Column ${name}.${column} differs: the migrations make it ${describeColumn(shape)}; the database has ${describeColumn(have)}.`);
		}
		for (const column of found.keys()) if (!columns.has(column)) differences.push(`Column ${name}.${column} is not made by any migration.`);
		const wanted = expected.constraints.get(name) ?? new Set<string>();
		const have = actual.constraints.get(name) ?? new Set<string>();
		for (const constraint of wanted) if (!have.has(constraint)) differences.push(`Table ${name} lacks the ${constraint}.`);
		for (const constraint of have) if (!wanted.has(constraint)) differences.push(`Table ${name} has a ${constraint} that no migration made.`);
	}
	for (const name of actual.tables.keys()) if (!expected.tables.has(name)) differences.push(`Table ${name} is not made by any migration.`);
	for (const [key, shape] of expected.objects) {
		const have = actual.objects.get(key);
		if (!have) differences.push(`The ${key} is missing.`);
		else if (have.table !== shape.table || have.statement !== shape.statement) differences.push(`The ${key} differs from the migrations' (on ${shape.table}: ${shape.statement}; the database has, on ${have.table}: ${have.statement}).`);
	}
	for (const key of actual.objects.keys()) if (!expected.objects.has(key)) differences.push(`The ${key} is not made by any migration.`);
	return differences;
}

/** The migrations the database lists as applied against the files: both directions are drift. */
export function compareMigrations(files: string[], applied: string[]): string[] {
	const differences: string[] = [];
	for (const name of files) if (!applied.includes(name)) differences.push(`Migration ${name} is not applied.`);
	for (const name of applied) if (!files.includes(name)) differences.push(`Migration ${name} is applied but is not in migrations/ (this checkout is older than the database, or a file was renamed).`);
	return differences;
}

/** The schema migrations/ builds: its files, in name order, run on an empty database. */
export function expectedSchema(migrations: { name: string; sql: string }[]): Schema {
	const db = new DatabaseSync(":memory:");
	try {
		for (const migration of [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			try {
				db.exec(migration.sql);
			} catch (error) {
				throw new Error(`Migration ${migration.name} does not run on an empty database: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const ask = (sql: string) => db.prepare(sql).all() as Row[];
		return schemaOf({ tables: ask(TABLES_SQL), columns: ask(COLUMNS_SQL), objects: ask(OBJECTS_SQL), uniques: ask(UNIQUES_SQL), foreignKeys: ask(FOREIGN_KEYS_SQL) });
	} finally {
		db.close();
	}
}

/**
 * The rows `cf d1 query` printed. It prints the API's result, a list with one entry per statement, each with
 * its `results`; the answer is also taken wrapped in `result`, or as the rows themselves. Anything else, and
 * a statement that did not succeed, is an error: a check that cannot read the database does not pass.
 */
export function rowsFrom(output: string): Row[] {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`The database's answer is not JSON: ${output.slice(0, 120)}`);
	}
	if (value && typeof value === "object" && !Array.isArray(value) && "result" in value) value = (value as { result: unknown }).result;
	if (!Array.isArray(value)) throw new Error(`The database's answer is not a list: ${output.slice(0, 120)}`);
	if (value.length === 0) return [];
	const statements = value.every((entry) => entry && typeof entry === "object" && "results" in entry);
	if (statements) {
		if (value.length !== 1) throw new Error(`The database answered ${value.length} statements to one.`);
		const [statement] = value as { results: unknown; success?: unknown }[];
		if (statement?.success === false) throw new Error("The database reports that the statement did not succeed.");
		if (!Array.isArray(statement?.results)) throw new Error("The database's answer has no list of results.");
		return statement.results as Row[];
	}
	if (value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) return value as Row[];
	throw new Error(`The database's answer is not rows: ${output.slice(0, 120)}`);
}
