// lib/sql.ts over node:sqlite: statements with bindings, RETURNING, and transactions that roll back and
// nest, which test/platform/ledger-sql.test.ts runs on a Durable Object's storage too; and its schema steps.

import { describe, expect, test } from "vitest";
import { applySchema, migrate, sqliteSql } from "../../src/lib/sql.ts";
import { openDatabase } from "./sqlite.ts";

function table() {
	const sql = sqliteSql(openDatabase());
	applySchema(sql, ["CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT"]);
	return sql;
}

describe("sqliteSql", () => {
	test("binds values and returns rows, with RETURNING for what a write changed", () => {
		const sql = table();
		expect(sql.exec("INSERT INTO t (k, n) VALUES (?, ?)", "a", 1)).toEqual([]);
		expect(sql.exec("INSERT INTO t (k, n) VALUES (?, ?) RETURNING k", "b", 2)).toEqual([{ k: "b" }]);
		expect(sql.exec("UPDATE t SET n = n + 1 WHERE k = ? RETURNING k, n", "zz")).toEqual([]);
		expect(sql.exec<{ k: string; n: number }>("SELECT k, n FROM t ORDER BY k").map((row) => ({ ...row }))).toEqual([
			{ k: "a", n: 1 },
			{ k: "b", n: 2 },
		]);
		expect(sql.exec("SELECT ? AS v, ? AS w", null, "x").map((row) => ({ ...row }))).toEqual([{ v: null, w: "x" }]);
	});

	test("a transaction rolls back when its body throws, and transactions nest", () => {
		const sql = table();
		expect(() =>
			sql.transaction(() => {
				sql.exec("INSERT INTO t (k, n) VALUES ('a', 1)");
				throw new Error("no");
			}),
		).toThrow("no");
		expect(sql.exec("SELECT k FROM t")).toEqual([]);
		const value = sql.transaction(() => {
			sql.exec("INSERT INTO t (k, n) VALUES ('a', 1)");
			try {
				sql.transaction(() => {
					sql.exec("INSERT INTO t (k, n) VALUES ('b', 2)");
					throw new Error("inner");
				});
			} catch {
				// Only the inner one is undone.
			}
			return sql.exec<{ k: string }>("SELECT k FROM t ORDER BY k").map((row) => row.k);
		});
		expect(value).toEqual(["a"]);
		expect(sql.exec<{ k: string }>("SELECT k FROM t").map((row) => row.k)).toEqual(["a"]);
		expect(() => sql.exec("INSERT INTO t (k, n) VALUES ('a', 3)")).toThrow(/UNIQUE/);
	});
});

describe("migrate", () => {
	test("applies each step once, in order, in lib/sqlite.ts's table, and a failing step leaves nothing behind", () => {
		const sql = sqliteSql(openDatabase());
		const steps = [
			{ id: 2, sql: "ALTER TABLE t ADD COLUMN y TEXT" },
			{ id: 1, sql: "CREATE TABLE t (x INTEGER); CREATE INDEX t_x ON t (x)" },
		];
		expect(migrate(sql, steps, 1)).toEqual([1, 2]);
		expect(migrate(sql, steps, 2)).toEqual([]);
		expect(sql.exec("SELECT id, applied_at FROM _migrations ORDER BY id")).toEqual([
			{ id: 1, applied_at: 1 },
			{ id: 2, applied_at: 1 },
		]);
		expect(() => migrate(sql, [...steps, { id: 3, sql: "CREATE TABLE u (a); CREATE TABLE t (b)" }], 3)).toThrow();
		expect(sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u'")).toEqual([{ n: 0 }]);
		expect(sql.exec("SELECT id FROM _migrations ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
	});
});
