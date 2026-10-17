// A finished run's pi session, deleted by hand (docs/plans/chunk-15a-design.md, pi's tables): pi-durable 1.2.0 has no
// delete call, so these statements remove a session's rows from pi's own tables (`pi_` plus its schema version 1,
// node_modules/@earendil-works/pi-durable/dist/storage/sqlite/migrations.js) through the indexes pi made for them. Each
// call is one bounded step for the caller's `transactionSync`, made outside any transaction of pi's (store.ts `outside`):
// it deletes at most `limit` rows and selects what it deletes in the same statements, so a step a reset rolls back is
// simply done again. The conversation's own row goes last, so a session deleted in part is still found by its run, or as an
// orphan. Not called by production code yet: the `retain` job's pi stage calls it (the design's unit 3).

import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

/** The version of pi's schema these statements are written for; any other stops the pi stage. */
export const PI_SCHEMA_VERSION = 1;

export type PiStep =
	/** `rows` deleted, at most the step's limit; the session may have more. */
	| { kind: "deleted"; rows: number }
	/** Nothing of the session is left. */
	| { kind: "gone" }
	/** pi's schema is not the version these statements know (null: no schema); nothing was deleted. */
	| { kind: "schema"; version: number | null }
	/** A task of the session is not terminal, or a submission is queued or placed; nothing was deleted. */
	| { kind: "live" };

type Bindings = (string | number)[];

/** pi's schema version, or null when pi never made its tables. */
function schemaVersion(sql: SqlStorage): number | null {
	const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_durable_schema'").toArray().length > 0;
	if (!exists) return null;
	return sql.exec<{ version: number }>("SELECT version FROM pi_durable_schema WHERE singleton = 1").toArray()[0]?.version ?? null;
}

function ids(sql: SqlStorage, query: string, ...bindings: Bindings): number[] {
	return sql
		.exec<{ id: number }>(query, ...bindings)
		.toArray()
		.map((row) => row.id);
}

/**
 * The session and every conversation it owns, through its own row or one of its tasks, transitively: owned ones first,
 * the session last. Minerva makes only ownerless conversations, so this is the session alone; the statements cover the rest.
 */
function conversationsOf(sql: SqlStorage, session: number): number[] {
	const found = [session];
	for (let at = 0; at < found.length; at++) {
		const owner = found[at] as number;
		const owned = [
			...ids(sql, "SELECT id FROM pi_conversations WHERE owner_conversation_id = ? ORDER BY id", owner),
			...ids(sql, "SELECT id FROM pi_tasks WHERE conversation_id = ? ORDER BY id", owner).flatMap((task) =>
				ids(sql, "SELECT id FROM pi_conversations WHERE owner_task_id = ? ORDER BY id", task),
			),
		];
		for (const id of owned) if (!found.includes(id)) found.push(id);
	}
	return found.reverse();
}

function live(sql: SqlStorage, conversation: number): boolean {
	return (
		sql.exec("SELECT 1 FROM pi_tasks WHERE conversation_id = ? AND status != 'terminal' LIMIT 1", conversation).toArray().length > 0 ||
		sql.exec("SELECT 1 FROM pi_submissions WHERE conversation_id = ? AND status IN ('queued', 'placed') LIMIT 1", conversation).toArray().length > 0
	);
}

/**
 * Deletes up to `count` records of `table` that `where` selects, in id order, with their `pi_record_ids` rows, which
 * hold the same ids. The same subquery selects both sets in one synchronous stretch, so they are the same records.
 * Answers how many records it deleted.
 */
function deleteRecords(sql: SqlStorage, table: string, where: string, bindings: Bindings, count: number): number {
	if (count <= 0) return 0;
	const selected = `SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT ?`;
	const found = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM (${selected})`, ...bindings, count).one().n;
	if (found === 0) return 0;
	sql.exec(`DELETE FROM pi_record_ids WHERE id IN (${selected})`, ...bindings, count);
	sql.exec(`DELETE FROM ${table} WHERE id IN (${selected})`, ...bindings, count);
	return found;
}

/**
 * One step of the session's deletion, at most `limit` rows: the documents' revisions, then the documents, then the
 * entries, tasks and submissions, then the conversation's row, for each conversation the session owns before the session
 * itself. Each part starts only once the one before it is empty. `gone` once nothing is left; the caller records it.
 */
export function deletePiSession(sql: SqlStorage, session: number, limit: number): PiStep {
	if (session === ROOT_CONVERSATION_ID) throw new Error("pi's root conversation is never deleted.");
	const version = schemaVersion(sql);
	if (version !== PI_SCHEMA_VERSION) return { kind: "schema", version };
	const conversations = conversationsOf(sql, session);
	if (conversations.some((conversation) => live(sql, conversation))) return { kind: "live" };
	let left = limit;
	for (const conversation of conversations) {
		const scopes: [string, number][] = [
			["conversation", conversation],
			...ids(sql, "SELECT id FROM pi_tasks WHERE conversation_id = ? ORDER BY id", conversation).map((task): [string, number] => ["task", task]),
		];
		const documents = scopes.flatMap(([kind, owner]) => ids(sql, "SELECT id FROM pi_documents WHERE scope_kind = ? AND owner_id = ? ORDER BY id", kind, owner));
		for (const document of documents) {
			if (left <= 0) break;
			const revisions = "SELECT rowid FROM pi_document_revisions WHERE document_id = ? ORDER BY seq LIMIT ?";
			const found = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM (${revisions})`, document, left).one().n;
			if (found) sql.exec(`DELETE FROM pi_document_revisions WHERE rowid IN (${revisions})`, document, left);
			left -= found;
		}
		// A record and its `pi_record_ids` row are two rows.
		for (const [kind, owner] of scopes) left -= 2 * deleteRecords(sql, "pi_documents", "scope_kind = ? AND owner_id = ?", [kind, owner], Math.floor(left / 2));
		for (const table of ["pi_entries", "pi_tasks", "pi_submissions"]) left -= 2 * deleteRecords(sql, table, "conversation_id = ?", [conversation], Math.floor(left / 2));
		left -= 2 * deleteRecords(sql, "pi_conversations", "id = ?", [conversation], Math.floor(left / 2));
		if (left <= 1) break;
	}
	return left === limit ? { kind: "gone" } : { kind: "deleted", rows: limit - left };
}

/**
 * The first pi conversation no run names, other than pi's root, that nothing owns: a session a reset left between its
 * creation and its claim (conversation.ts `#startLoop`), or one a later run's prune left part-deleted. Only while no run
 * is active is such a session certain to be no one's: an acting run's loop is what creates and claims sessions.
 */
export function orphanPiSession(sql: SqlStorage): number | null {
	if (schemaVersion(sql) !== PI_SCHEMA_VERSION) return null;
	return (
		ids(
			sql,
			`SELECT id FROM pi_conversations AS pi
			WHERE id != ? AND owner_conversation_id IS NULL AND owner_task_id IS NULL
				AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.session = CAST(pi.id AS TEXT))
			ORDER BY id LIMIT 1`,
			ROOT_CONVERSATION_ID,
		)[0] ?? null
	);
}
