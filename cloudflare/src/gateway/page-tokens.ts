// Run-bound page tokens (backend/connectors/executor.py `_issue_cursor`, `_resolve_cursor`; connectors
// 7.3, runs 5.5): the model never sees a provider's cursor, only an opaque token bound to the run, the
// tool name (alias included) and the hash of the other normalized arguments, so a token cannot be replayed
// against another query. At most 200 per run; tokens are never deleted while the run is active.

import type { EpochMs, RunId } from "../contracts/common.ts";
import { sha256Hex } from "../lib/hash.ts";
import { hashInput } from "../lib/canonical.ts";
import { tokenUrlsafe } from "../lib/random.ts";
import type { Sql } from "../lib/sql.ts";
import { codePointLength } from "../lib/text.ts";
import { MAX_TOOL_NAME, MAX_UPSTREAM_CURSOR } from "./schema.ts";

export const MAX_PAGE_TOKENS = 200;
/** `secrets.token_urlsafe(18)`: 24 URL-safe characters. */
export const PAGE_TOKEN_BYTES = 18;
export { MAX_TOOL_NAME, MAX_UPSTREAM_CURSOR } from "./schema.ts";

export const LIMIT_REACHED_MESSAGE = "This run has reached its pagination limit.";
export const INVALID_CURSOR_MESSAGE = "This page token is invalid or belongs to another request.";

/** The page_tokens table, in the same migration step as the ledger's. */
export { PAGE_TOKEN_SCHEMA } from "./schema.ts";

/**
 * SHA-256 over `minerva:query:` and the canonical JSON (lib/canonical.ts) of the validated, normalized
 * arguments with their defaults, without "cursor" (connectors 7.1 step 4, risk 2), so a token is valid only
 * for the same query. The tool name is bound beside it, in the token's row.
 */
export async function queryHash(fields: { [key: string]: unknown }): Promise<string> {
	// Object.fromEntries defines own properties, so every key stays a key.
	return sha256Hex(hashInput("query", Object.fromEntries(Object.entries(fields).filter(([name]) => name !== "cursor"))));
}

export class PageTokens {
	readonly #sql: Sql;
	readonly #now: () => EpochMs;

	constructor(sql: Sql, now: () => EpochMs = Date.now) {
		this.#sql = sql;
		this.#now = now;
	}

	/** The provider's cursor for a token this run was given for the same tool and query, else null (INVALID_CURSOR). */
	resolve(runId: RunId, token: string, tool: string, hash: string): string | null {
		const [row] = this.#sql.exec<{ tool: string; query_hash: string; upstream_cursor: string }>(
			"SELECT tool, query_hash, upstream_cursor FROM page_tokens WHERE run_id = ? AND token = ?",
			runId,
			token,
		);
		if (row === undefined || row.tool !== tool || row.query_hash !== hash) return null;
		return row.upstream_cursor;
	}

	/**
	 * A new token for the provider's cursor, or null when the run already holds 200 (LIMIT_REACHED, which the
	 * model sees instead of the page: the provider was already called). A cursor or tool name longer than
	 * today's columns throws, as Postgres does there.
	 */
	issue(runId: RunId, tool: string, hash: string, upstreamCursor: string): string | null {
		return this.#sql.transaction(() => {
			// The limit first, then the row, as executor.py `_issue_cursor` counts before it creates.
			if (this.count(runId) >= MAX_PAGE_TOKENS) return null;
			if (codePointLength(upstreamCursor) > MAX_UPSTREAM_CURSOR) throw new Error(`The provider's cursor is longer than the ${MAX_UPSTREAM_CURSOR} characters a page token holds.`);
			if (codePointLength(tool) > MAX_TOOL_NAME) throw new Error(`The tool name is longer than the ${MAX_TOOL_NAME} characters a page token holds.`);
			const token = tokenUrlsafe(PAGE_TOKEN_BYTES);
			this.#sql.exec(
				"INSERT INTO page_tokens (token, run_id, tool, query_hash, upstream_cursor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				token,
				runId,
				tool,
				hash,
				upstreamCursor,
				this.#now(),
			);
			return token;
		});
	}

	count(runId: RunId): number {
		const [row] = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM page_tokens WHERE run_id = ?", runId);
		return row?.n ?? 0;
	}

	/** Drops a run's tokens, once the run has ended (connectors 7.3: they may go then). */
	forget(runId: RunId): void {
		this.#sql.exec("DELETE FROM page_tokens WHERE run_id = ?", runId);
	}
}
