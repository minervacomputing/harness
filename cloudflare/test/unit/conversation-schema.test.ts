// The Conversation's tables against the queries that name their columns (conversation/store.ts), over
// node:sqlite with every schema step applied.

import { expect, test } from "vitest";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RUN_COLUMNS } from "../../src/conversation/store.ts";
import { openDatabase } from "./sqlite.ts";

test("a run is read with every column of its table but the snapshot, which only snapshot() reads", () => {
	// A column added to `runs` by a later step must join RUN_COLUMNS, or every read of a run would miss it.
	const db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	const columns = (db.prepare("SELECT name FROM pragma_table_info('runs')").all() as { name: string }[]).map((row) => row.name);
	expect(columns).toContain("snapshot");
	expect(RUN_COLUMNS.split(", ")).toEqual(columns.filter((name) => name !== "snapshot"));
	db.close();
});
