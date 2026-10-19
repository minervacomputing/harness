// The Conversation's tables against the queries that name their columns (conversation/store.ts), over
// node:sqlite with every schema step applied, and a step that changes rows already there, applied to them.

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

test("step 16 keeps the rows, adds the conversation's pi conversation and the summary flag, and lets runs share a session", () => {
	const db = openDatabase();
	for (const migration of MIGRATIONS.filter((step) => step.id <= 15)) db.exec(migration.sql);
	db.exec(`INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o');
		INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, session) VALUES ('a', 'completed', 0, '{}', 0, '7');
		INSERT INTO call_records (run_id, call, attempt, instance, provider, model, reserved_input, reserved_output, created_at) VALUES ('a', '00000001', 1, 'i', 'fake', 'fake-1', 1, 1, 0);`);
	const insert = (id: string) => db.exec(`INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, session) VALUES ('${id}', 'completed', 0, '{}', 0, '7')`);
	expect(() => insert("b")).toThrow(/UNIQUE/);

	db.exec((MIGRATIONS.find((step) => step.id === 16) as { sql: string }).sql);
	expect(db.prepare("SELECT id, pi_session, pi_provider_session FROM conversation").all()).toEqual([{ id: "c", pi_session: null, pi_provider_session: null }]);
	expect(db.prepare("SELECT run_id, summary FROM call_records").all()).toEqual([{ run_id: "a", summary: 0 }]);
	const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'").all() as { name: string }[]).map((row) => row.name);
	expect(indexes).toContain("runs_by_session");
	expect(indexes).not.toContain("runs_session");
	insert("b");
	expect(db.prepare("SELECT id FROM runs WHERE session = '7' ORDER BY id").all()).toEqual([{ id: "a" }, { id: "b" }]);
	db.close();
});
