// pi's deletion by session (src/conversation/pi-tables.ts)
// over node:sqlite, with pi-durable's own Harness on PiHarness's session store, so its tables are the `pi_` ones the
// Conversation has. Each turn is a run's: a session seeded with history, claimed in `runs`, one input `run:<id>`, a tool
// call and an answer. A session is deleted while the same Harness stays open with its documents cached, then other sessions
// keep working on it and after it is reopened from the file, one of them resumed after a crash mid-turn; the row counts are
// exact, so a statement that took a wrong row would fail them.

import { type AssistantMessage, createModels, type FauxProviderHandle, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, createRegistry, defineTool, type EntryRecord, Harness, type HarnessSettings, UserEntry } from "@earendil-works/pi-durable";
import { openPiSessionStore } from "agents/harness/pi";
import { afterEach, describe, expect, test } from "vitest";
import { deletePiSession, orphanPiSession, type PiStep } from "../../src/conversation/pi-tables.ts";
import { MIGRATIONS } from "../../src/conversation/schema.ts";
import { RunStore } from "../../src/conversation/store.ts";
import { durableStorage, openDatabase, scratchDirectory } from "./sqlite.ts";

const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context pi-tables test]" }) as never;
const TABLES = ["pi_conversations", "pi_entries", "pi_tasks", "pi_submissions", "pi_documents", "pi_document_revisions", "pi_record_ids", "pi_durable_metadata", "pi_durable_schema"];
type Rows = { [table: string]: { [column: string]: unknown }[] };
type Database = ReturnType<typeof openDatabase>;

const echo = defineTool({
	name: "echo",
	description: "Answers its text.",
	parameters: Type.Object({ text: Type.String() }),
	async execute(args: { text: string }) {
		return { output: [{ type: "text", text: args.text }] };
	},
});

interface Pi {
	db: Database;
	storage: DurableObjectStorage;
	harness: Harness;
	faux: FauxProviderHandle;
}

const directories: { done(): void }[] = [];
const opened: Pi[] = [];
afterEach(async () => {
	for (const pi of opened.splice(0)) await pi.harness.close(BG).catch(() => {});
	for (const directory of directories.splice(0)) directory.done();
});

function databasePath(): string {
	const directory = scratchDirectory();
	directories.push(directory);
	return `${directory.path}/conversation.sqlite`;
}

/** The Conversation's storage on `path`, its own tables made on first open, and pi opened on it as PiHarness opens it. */
async function openPi(path: string, settings: HarnessSettings): Promise<Pi> {
	const db = openDatabase(path);
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs'").all().length) for (const migration of MIGRATIONS) db.exec(migration.sql);
	const storage = durableStorage(db);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "minerva", tools: [echo] });
	const harness = await Harness.open(await openPiSessionStore(storage), { models, registry, settings }, BG);
	await harness.root(BG);
	const pi = { db, storage, harness, faux };
	opened.push(pi);
	return pi;
}

/** A tool call, then the answer. */
function answers(pi: Pi, text: string): void {
	pi.faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", { text: `${text} (tool)` }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText(text))]);
}

/** A run's session as `#startLoop` makes it: ownerless, seeded with the history in its creating commit, then claimed. */
async function session(pi: Pi, run: string, history: string[]): Promise<ConversationId> {
	const model = pi.faux.getModel();
	const created = await pi.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: model.provider, modelId: model.id }, instructions: "You are a test agent." },
			init: async (tx, id) => {
				for (const [index, content] of history.entries()) {
					if (index % 2 === 0) await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content, timestamp: 1 }] });
					else await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage(fauxText(content), { timestamp: 1 }) as AssistantMessage] });
				}
			},
		},
		BG,
	);
	claim(pi.db, run, created.id);
	return created.id;
}

function claim(db: Database, run: string, id: ConversationId): void {
	db.prepare("INSERT INTO runs (id, status, attempt_started_at, snapshot, created_at, session) VALUES (?, 'completed', 0, '{}', 0, ?)").all(run, String(id));
}

/** Submits the run's prompt once, as `run:<id>`, and waits for the turn's answer. */
async function turn(pi: Pi, id: ConversationId, run: string, prompt: string): Promise<string> {
	const conversation = await pi.harness.conversation(id, BG);
	if (!conversation) throw new Error(`No pi conversation ${id}.`);
	const submission = await conversation.submit({ type: "input", content: prompt, requestId: `run:${run}` }, BG);
	const settled = await submission.wait(BG);
	await conversation.waitForIdle(BG);
	expect(settled.status).toBe("done");
	return answerOf(await entries(pi, id));
}

/** The text of the last entry, the turn's answer. */
function answerOf(list: readonly EntryRecord[]): string {
	const content = list.at(-1)?.model?.[0]?.content;
	return typeof content === "string" ? content : (content?.find((part) => part.type === "text") as { text: string } | undefined)?.text ?? "";
}

async function entries(pi: Pi, id: ConversationId): Promise<readonly EntryRecord[]> {
	const conversation = await pi.harness.conversation(id, BG);
	if (!conversation) throw new Error(`No pi conversation ${id}.`);
	return (await conversation.entries({ order: "ascending" }, 1000, undefined, BG)).items;
}

function dump(db: Database): Rows {
	return Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as { [column: string]: unknown }[]]));
}

function counts(db: Database): { [table: string]: number } {
	return Object.fromEntries(TABLES.slice(0, 7).map((table) => [table.slice(3), (db.prepare(`SELECT count(*) AS n FROM ${table}`).all()[0] as { n: number }).n]));
}

/**
 * What is left of `rows` without the session: the oracle, written plainly from pi's columns. Its documents are those
 * scoped to it or to one of its tasks, and every id of its records goes from `pi_record_ids`.
 */
function without(rows: Rows, id: number): Rows {
	const tasks = new Set(rows.pi_tasks?.filter((row) => row.conversation_id === id).map((row) => row.id));
	const ofSession = (row: { [column: string]: unknown }) => (row.scope_kind === "conversation" && row.owner_id === id) || (row.scope_kind === "task" && tasks.has(row.owner_id));
	const documents = new Set(rows.pi_documents?.filter(ofSession).map((row) => row.id));
	const records = new Set([
		id,
		...documents,
		...["pi_entries", "pi_tasks", "pi_submissions"].flatMap((table) => (rows[table] ?? []).filter((row) => row.conversation_id === id).map((row) => row.id)),
	]);
	return {
		...rows,
		pi_conversations: rows.pi_conversations?.filter((row) => row.id !== id) ?? [],
		pi_entries: rows.pi_entries?.filter((row) => row.conversation_id !== id) ?? [],
		pi_tasks: rows.pi_tasks?.filter((row) => row.conversation_id !== id) ?? [],
		pi_submissions: rows.pi_submissions?.filter((row) => row.conversation_id !== id) ?? [],
		pi_documents: rows.pi_documents?.filter((row) => !documents.has(row.id)) ?? [],
		pi_document_revisions: rows.pi_document_revisions?.filter((row) => !documents.has(row.document_id)) ?? [],
		pi_record_ids: rows.pi_record_ids?.filter((row) => !records.has(row.id)) ?? [],
	};
}

/** Every step of the session's deletion, each its own `transactionSync` as the `retain` job makes them, until `gone`. */
function drain(pi: Pi, id: number, limit: number): PiStep[] {
	const steps: PiStep[] = [];
	for (;;) {
		const step = pi.storage.transactionSync(() => deletePiSession(pi.storage.sql, id, limit));
		steps.push(step);
		if (step.kind !== "deleted") return steps;
		if (steps.length > 100) throw new Error("The deletion does not end.");
	}
}

/** The rows that name the session: its own, its entries, tasks, submissions and documents, and its record id. */
function rowsOf(db: Database, id: number): number {
	const query = `SELECT (SELECT count(*) FROM pi_conversations WHERE id = ?1) + (SELECT count(*) FROM pi_entries WHERE conversation_id = ?1)
		+ (SELECT count(*) FROM pi_tasks WHERE conversation_id = ?1) + (SELECT count(*) FROM pi_submissions WHERE conversation_id = ?1)
		+ (SELECT count(*) FROM pi_documents WHERE scope_kind = 'conversation' AND owner_id = ?1) + (SELECT count(*) FROM pi_record_ids WHERE id = ?1) AS n`;
	return (db.prepare(query).all(id)[0] as { n: number }).n;
}

// pi's settings as the Conversation sets them where they bear on what pi keeps in memory (conversation.ts PI_SETTINGS):
// no context kept after a turn, documents kept the default ten minutes, so the deleted session's stay cached; and the
// same with documents evicted at once.
describe.each([
	["documents cached", { contextRetentionMs: 0 }],
	["documents evicted at once", { contextRetentionMs: 0, documentRetentionMs: 0 }],
] satisfies [string, HarnessSettings][])("a session deleted with the Harness open (%s)", (_name, settings) => {
	test("takes only its own rows, and the others keep working, then and after a reopen and a resume", async () => {
		const path = databasePath();
		const pi = await openPi(path, settings);
		const first = await session(pi, "run-1", ["Earlier question", "Earlier answer"]);
		answers(pi, "First answer");
		expect(await turn(pi, first, "run-1", "First question")).toBe("First answer");
		const second = await session(pi, "run-2", ["Earlier question", "Earlier answer", "First question", "First answer"]);
		answers(pi, "Second answer");
		expect(await turn(pi, second, "run-2", "Second question")).toBe("Second answer");
		const ofSecond = await entries(pi, second);
		expect(counts(pi.db)).toEqual({ conversations: 3, entries: 16, tasks: 6, submissions: 2, documents: 15, document_revisions: 15, record_ids: 42 });

		const before = dump(pi.db);
		const steps = drain(pi, first, 5);
		expect(steps.at(-1)).toEqual({ kind: "gone" });
		expect(steps.slice(0, -1).every((step) => step.kind === "deleted" && step.rows <= 5)).toBe(true);
		const deleted = steps.reduce((sum, step) => sum + (step.kind === "deleted" ? step.rows : 0), 0);
		expect(dump(pi.db)).toEqual(without(before, first));
		expect(deleted).toBe(39);
		expect(counts(pi.db)).toEqual({ conversations: 2, entries: 9, tasks: 3, submissions: 1, documents: 10, document_revisions: 10, record_ids: 25 });

		// The same Harness, its cache holding the deleted session's documents: the second session goes on, a third starts.
		answers(pi, "Second answer, again");
		expect(await turn(pi, second, "run-3", "Second question, again")).toBe("Second answer, again");
		const third = await session(pi, "run-4", ["Earlier question", "Earlier answer"]);
		answers(pi, "Third answer");
		expect(await turn(pi, third, "run-4", "Third question")).toBe("Third answer");
		expect((await entries(pi, second)).slice(0, ofSecond.length)).toEqual(ofSecond);
		expect(rowsOf(pi.db, first)).toBe(0);
		expect(await pi.harness.conversation(first, BG)).toBeUndefined();
		expect(counts(pi.db)).toEqual({ conversations: 3, entries: 20, tasks: 9, submissions: 3, documents: 15, document_revisions: 15, record_ids: 50 });
		await pi.harness.close(BG);

		// Reopened from the file: the third session deleted, a fourth turn answered, and the second's history unchanged.
		const reopened = await openPi(path, settings);
		expect((await entries(reopened, second)).slice(0, ofSecond.length)).toEqual(ofSecond);
		const kept = dump(reopened.db);
		expect(drain(reopened, third, 500).map((step) => step.kind)).toEqual(["deleted", "gone"]);
		expect(dump(reopened.db)).toEqual(without(kept, third));
		const fourth = await session(reopened, "run-5", ["Earlier question", "Earlier answer"]);
		answers(reopened, "Fourth answer");
		expect(await turn(reopened, fourth, "run-5", "Fourth question")).toBe("Fourth answer");

		// A turn cut short by a crash: its model call never answers in this instance, which is dropped without a close.
		const fifth = await session(reopened, "run-6", []);
		const asked = Promise.withResolvers<void>();
		reopened.faux.setResponses([
			() => {
				asked.resolve();
				return new Promise<never>(() => {});
			},
		]);
		const conversation = await reopened.harness.conversation(fifth, BG);
		await conversation?.submit({ type: "input", content: "Fifth question", requestId: "run:run-6" }, BG);
		await asked.promise;
		opened.splice(opened.indexOf(reopened), 1);

		const resumed = await openPi(path, settings);
		answers(resumed, "Fifth answer");
		resumed.harness.resume();
		await resumed.harness.waitForIdle(BG);
		expect(answerOf(await entries(resumed, fifth))).toBe("Fifth answer");
		expect((await entries(resumed, second)).slice(0, ofSecond.length)).toEqual(ofSecond);
		expect([rowsOf(resumed.db, first), rowsOf(resumed.db, third)]).toEqual([0, 0]);
		expect(counts(resumed.db)).toEqual({ conversations: 4, entries: 25, tasks: 12, submissions: 4, documents: 20, document_revisions: 20, record_ids: 65 });
	});
});

describe("the guards", () => {
	test("a session with live work, or pi's schema at another version, is left whole", async () => {
		const pi = await openPi(databasePath(), { contextRetentionMs: 0 });
		const id = await session(pi, "run-1", ["Earlier question", "Earlier answer"]);
		const asked = Promise.withResolvers<void>();
		pi.faux.setResponses([
			() => {
				asked.resolve();
				return new Promise<never>(() => {});
			},
		]);
		await (await pi.harness.conversation(id, BG))?.submit({ type: "input", content: "Question", requestId: "run:run-1" }, BG);
		await asked.promise;
		const before = dump(pi.db);
		expect(pi.storage.transactionSync(() => deletePiSession(pi.storage.sql, id, 500))).toEqual({ kind: "live" });
		pi.db.exec("UPDATE pi_durable_schema SET version = 2");
		expect(pi.storage.transactionSync(() => deletePiSession(pi.storage.sql, id, 500))).toEqual({ kind: "schema", version: 2 });
		pi.db.exec("UPDATE pi_durable_schema SET version = 1");
		expect(dump(pi.db)).toEqual(before);
		opened.splice(0);
	});

	test("pi's root conversation is never deleted", async () => {
		const pi = await openPi(databasePath(), {});
		expect(() => deletePiSession(pi.storage.sql, 1, 500)).toThrow("pi's root conversation is never deleted.");
	});
});

describe("orphans", () => {
	test("a session no run names is found and drained; the root and claimed sessions never are", async () => {
		const pi = await openPi(databasePath(), { contextRetentionMs: 0 });
		const claimed = await session(pi, "run-1", ["Earlier question", "Earlier answer"]);
		answers(pi, "Answer");
		await turn(pi, claimed, "run-1", "Question");
		expect(orphanPiSession(pi.storage.sql)).toBeNull();
		// A reset between `createConversation` and `claimSession`: the session holds its history, and no run names it.
		const model = pi.faux.getModel();
		const orphan = await pi.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: model.provider, modelId: model.id }, instructions: "You are a test agent." },
				init: async (tx, id) => {
					await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "Earlier question", timestamp: 1 }] });
				},
			},
			BG,
		);
		expect(orphanPiSession(pi.storage.sql)).toBe(orphan.id);
		const before = dump(pi.db);
		expect(drain(pi, orphan.id, 500).map((step) => step.kind)).toEqual(["deleted", "gone"]);
		expect(dump(pi.db)).toEqual(without(before, orphan.id));
		expect(orphanPiSession(pi.storage.sql)).toBeNull();
	});
});

describe("the conversation's pi conversation", () => {
	test("is deleted by no run's prune and is never an orphan, while a run's own session still goes", async () => {
		const pi = await openPi(databasePath(), { contextRetentionMs: 0 });
		pi.db.prepare("INSERT INTO conversation (singleton, id, workspace_id, user_id, agent_id, created_at, updated_at, organization_id) VALUES (1, 'c', 'w', '', '', 0, 0, 'o')").all();
		// Two runs on the conversation's pi conversation, and a run with its own session, as before chunk 19b.
		const shared = await session(pi, "run-1", ["Earlier question", "Earlier answer"]);
		pi.db.prepare("UPDATE conversation SET pi_session = ?").all(String(shared));
		answers(pi, "First answer");
		await turn(pi, shared, "run-1", "First question");
		claim(pi.db, "run-2", shared);
		answers(pi, "Second answer");
		await turn(pi, shared, "run-2", "Second question");
		const own = await session(pi, "run-3", []);
		answers(pi, "Third answer");
		await turn(pi, own, "run-3", "Third question");
		pi.db.exec("UPDATE runs SET finished_at = 0");
		const before = dump(pi.db);
		const store = new RunStore(pi.storage);
		const prune = () => pi.db.prepare("SELECT id, prune FROM runs ORDER BY id").all();

		for (const run of ["run-1", "run-2", "run-3"]) store.pruneRecords(run, 500);
		expect(prune()).toEqual([
			{ id: "run-1", prune: "done" },
			{ id: "run-2", prune: "done" },
			{ id: "run-3", prune: "pi" },
		]);
		for (let step = store.prunePi("run-3", own, 5); step.kind !== "gone"; step = store.prunePi("run-3", own, 5)) expect(step.kind).toBe("deleted");
		// A run naming the conversation's pi conversation that an older version left in its pi stage is done at once.
		pi.db.exec("UPDATE runs SET prune = 'pi' WHERE id = 'run-2'");
		expect(store.prunePi("run-2", shared, 5)).toEqual({ kind: "gone" });
		expect(prune()).toEqual([
			{ id: "run-1", prune: "done" },
			{ id: "run-2", prune: "done" },
			{ id: "run-3", prune: "done" },
		]);
		expect(dump(pi.db)).toEqual(without(before, own));

		// Named by no run, it is still the conversation's, so never an orphan.
		pi.db.exec("DELETE FROM runs");
		expect(orphanPiSession(pi.storage.sql)).toBeNull();
		pi.db.exec("UPDATE conversation SET pi_session = NULL");
		expect(orphanPiSession(pi.storage.sql)).toBe(shared);
	});
});
