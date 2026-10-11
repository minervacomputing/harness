// lib/sql.ts over node:sqlite: statements with bindings, RETURNING, and transactions that roll back and
// nest. test/platform/ledger-sql.test.ts runs the same cases on a Durable Object's storage.

import { describe, expect, test } from "vitest";
import { applySchema, sqliteSql } from "../../src/lib/sql.ts";
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
