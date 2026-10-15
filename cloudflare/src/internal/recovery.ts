// The recovery index in D1 (docs/plans/start-and-cancel.md, The recovery index): Laravel's conversations and runs, each
// bound to the scope and conversation of the first command that named it. The Worker writes and reads it back in one
// batch before it reaches a Conversation object, so no run executes without its row, and the object is addressed by the
// jurisdiction the row was created with.
//
// A refused command changes nothing a correct one depends on: every write is conditional in SQL. A conversation is not
// bound by a command whose run is bound to another conversation, and a run and its digest only through a conversation
// bound to the command's scope, so a command naming another organization, workspace or conversation binds nothing.

import type { Scope } from "@minerva/contract/internal";
import type { WorkspaceRef } from "../shared/rpc.ts";

/** Where Laravel's conversations are created (product-and-engine.md, Decisions 11); a row keeps the one it was created with. */
export const INTERNAL_JURISDICTION = "eu";

export interface RunBinding {
	scope: Scope;
	conversation: string;
	run: string;
	/** startRun's input digest; null for a cancel, which binds the run without one. */
	digest: string | null;
	now: number;
}

/** The binding held, with the conversation's workspace as its objects are addressed; or why the command is refused. */
/** `deleted`: the conversation was deleted (`deleteConversation`), which only its object's answer may still replay. */
export type Bound = { ok: true; workspace: WorkspaceRef; deleted: boolean } | { ok: false; code: "SCOPE_MISMATCH" | "IDEMPOTENCY_CONFLICT"; message: string };

interface ConversationRow {
	organization_id: string;
	workspace_id: string;
	jurisdiction: string | null;
	deleted_at: number | null;
}

interface RunRow {
	conversation_id: string;
	input_digest: string | null;
}

/**
 * Binds the conversation to the scope and the run to the conversation, unless they are bound to others already, and the
 * run's input digest unless it has one. The scope is checked before the digest.
 */
export async function bindRun(db: D1Database, binding: RunBinding): Promise<Bound> {
	const { scope, conversation, run, digest, now } = binding;
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO recovery_conversations (id, organization_id, workspace_id, jurisdiction, created_at)
				SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM recovery_runs WHERE id = ?6 AND conversation_id != ?1)
				ON CONFLICT (id) DO NOTHING`,
			)
			.bind(conversation, scope.organization, scope.workspace, INTERNAL_JURISDICTION, now, run),
		db
			.prepare(
				`INSERT INTO recovery_runs (id, conversation_id, input_digest, created_at)
				SELECT ?1, id, ?2, ?3 FROM recovery_conversations WHERE id = ?4 AND organization_id = ?5 AND workspace_id = ?6
				ON CONFLICT (id) DO NOTHING`,
			)
			.bind(run, digest, now, conversation, scope.organization, scope.workspace),
		db
			.prepare(
				`UPDATE recovery_runs SET input_digest = ?1
				WHERE id = ?2 AND input_digest IS NULL AND ?1 IS NOT NULL AND conversation_id = ?3
				AND EXISTS (SELECT 1 FROM recovery_conversations WHERE id = ?3 AND organization_id = ?4 AND workspace_id = ?5)`,
			)
			.bind(digest, run, conversation, scope.organization, scope.workspace),
		db.prepare("SELECT organization_id, workspace_id, jurisdiction, deleted_at FROM recovery_conversations WHERE id = ?1").bind(conversation),
		db.prepare("SELECT conversation_id, input_digest FROM recovery_runs WHERE id = ?1").bind(run),
	]);
	const bound = results[3]?.results[0] as ConversationRow | undefined;
	const named = results[4]?.results[0] as RunRow | undefined;
	if (named !== undefined && named.conversation_id !== conversation) return { ok: false, code: "SCOPE_MISMATCH", message: "This run belongs to another conversation." };
	if (bound === undefined) throw new Error("A conversation's row is read back in the batch that inserts it.");
	if (bound.organization_id !== scope.organization || bound.workspace_id !== scope.workspace) {
		return { ok: false, code: "SCOPE_MISMATCH", message: "This conversation belongs to another organization or workspace." };
	}
	if (named === undefined) throw new Error("A run's row is read back in the batch that inserts it.");
	if (digest !== null && named.input_digest !== digest) {
		return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This run was started with a different input." };
	}
	return { ok: true, workspace: { id: scope.workspace, jurisdiction: bound.jurisdiction === "eu" ? "eu" : null }, deleted: bound.deleted_at !== null };
}

/** A Laravel conversation as the index binds it, or null for one no command has named. */
export interface IndexedConversation {
	organization: string;
	workspace: WorkspaceRef;
	/** Whether `deleteConversation` has deleted it, which is never undone. */
	deleted: boolean;
}

function indexed(row: ConversationRow): IndexedConversation {
	return { organization: row.organization_id, workspace: { id: row.workspace_id, jurisdiction: row.jurisdiction === "eu" ? "eu" : null }, deleted: row.deleted_at !== null };
}

/** The conversation's binding, read without writing (`replayFacts`, `folder`, `resolveDownload`, the stream). */
export async function conversationOf(db: D1Database, conversation: string): Promise<IndexedConversation | null> {
	const row = await db
		.prepare("SELECT organization_id, workspace_id, jurisdiction, deleted_at FROM recovery_conversations WHERE id = ?1")
		.bind(conversation)
		.first<ConversationRow>();
	return row === null ? null : indexed(row);
}

/**
 * `deleteConversation`'s mark (the app's docs/plans/conversations.md, 12a): the conversation bound to the scope if no command
 * named it before, so a start that arrives later finds it deleted, then deleted unless it was, only through the row bound to
 * that scope; in one batch, read back. A conversation bound to another organization or workspace changes nothing.
 */
export async function deleteIndexed(db: D1Database, deletion: { scope: Scope; conversation: string; now: number }): Promise<{ ok: true; conversation: IndexedConversation } | { ok: false }> {
	const { scope, conversation, now } = deletion;
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO recovery_conversations (id, organization_id, workspace_id, jurisdiction, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
				ON CONFLICT (id) DO NOTHING`,
			)
			.bind(conversation, scope.organization, scope.workspace, INTERNAL_JURISDICTION, now),
		db
			.prepare("UPDATE recovery_conversations SET deleted_at = coalesce(deleted_at, ?1) WHERE id = ?2 AND organization_id = ?3 AND workspace_id = ?4")
			.bind(now, conversation, scope.organization, scope.workspace),
		db.prepare("SELECT organization_id, workspace_id, jurisdiction, deleted_at FROM recovery_conversations WHERE id = ?1").bind(conversation),
	]);
	const row = results[2]?.results[0] as ConversationRow | undefined;
	if (row === undefined) throw new Error("A conversation's row is read back in the batch that inserts it.");
	if (row.organization_id !== scope.organization || row.workspace_id !== scope.workspace) return { ok: false };
	return { ok: true, conversation: indexed(row) };
}

/**
 * Raises the conversation's highest fact sequence to at least `seq`, before facts up to it are sent to Laravel. Only through
 * the row bound to that organization and workspace; false when there is none.
 */
export async function raiseFactSeq(db: D1Database, raise: { conversation: string; organization: string; workspace: string; seq: number }): Promise<boolean> {
	const result = await db
		.prepare("UPDATE recovery_conversations SET fact_seq = max(fact_seq, ?1) WHERE id = ?2 AND organization_id = ?3 AND workspace_id = ?4 RETURNING id")
		.bind(raise.seq, raise.conversation, raise.organization, raise.workspace)
		.all();
	return result.results.length > 0;
}
