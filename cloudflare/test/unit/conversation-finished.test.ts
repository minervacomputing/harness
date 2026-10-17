// A Laravel conversation's `run.finished` carries what the folder's publishing returned (docs/plans/chunk-14d-design.md,
// The number): the conversation's stored bytes, or no such field when the sum threw, and the run ends either way. The
// store runs over node:sqlite with every schema step applied.

import type { Fact } from "@minerva/contract/internal";
import { beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { type Published, RunStore } from "../../src/conversation/store.ts";
import { durableStorage, openDatabase } from "./sqlite.ts";

const RUN = "0190a000-0000-7000-8000-000000000001";
const COMPLETED = { status: "completed", code: "", message: "" } as const;
const IGNORED = { appended: () => {}, ended: () => {}, factWritten: () => {}, settling: () => {} };

let db: ReturnType<typeof openDatabase>;
let store: RunStore;

beforeEach(() => {
	db = openDatabase();
	for (const migration of MIGRATIONS) db.exec(migration.sql);
	db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
	db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at) VALUES (?, 'running', 0, '{}', 0)").all(RUN);
	store = new RunStore(durableStorage(db), () => 1_000_000);
});

const finished = () =>
	(db.prepare("SELECT fact FROM facts ORDER BY seq").all() as { fact: string }[]).map((row) => JSON.parse(row.fact) as Fact).filter((fact) => fact.type === "run.finished");

test.each([
	["the sum", { resultVersionId: null, changes: null, storedBytes: 12_288 }, { storedBytes: 12_288 }],
	["no field when the sum threw", { resultVersionId: null, changes: null }, {}],
] satisfies [string, Published, object][])("run.finished carries %s, and the run ends", (_case, published, field) => {
	store.listen(IGNORED, () => published);
	expect(store.finish(RUN, COMPLETED)).toBe(true);
	expect(db.prepare("SELECT status FROM runs WHERE id = ?").all(RUN)).toEqual([{ status: "completed" }]);
	expect(finished().map((fact) => fact.data)).toEqual([{ status: "completed", code: "", error: "", message: null, folder: null, ...field }]);
});
