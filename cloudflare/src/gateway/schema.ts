// The write ledger's and page tokens' tables (gateway/ledger.ts, gateway/page-tokens.ts), one schema step
// of the Conversation Durable Object (conversation/schema.ts). Plain strings with no imports, so the
// account tests (Node) can read the object's step ids without the Worker's types.

/** Today's column sizes (RunPageToken.tool, .upstream_cursor): Postgres refuses longer values, and so does this. */
export const MAX_TOOL_NAME = 128;
export const MAX_UPSTREAM_CURSOR = 1000;

/**
 * The run_writes table. `attempt` is the attempt that dispatched the write: a later attempt still settles
 * it, and the restart gate makes the dead attempt's dispatched writes uncertain.
 */
export const LEDGER_SCHEMA: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS run_writes (
		run_id TEXT NOT NULL,
		key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
		status TEXT NOT NULL CHECK (status IN ('dispatched', 'succeeded', 'uncertain')),
		result TEXT,
		attempt INTEGER NOT NULL,
		dispatched_at INTEGER NOT NULL,
		deadline_at INTEGER NOT NULL,
		PRIMARY KEY (run_id, key)
	) STRICT`,
	// At most one write per run is in flight (run_write_one_in_flight).
	"CREATE UNIQUE INDEX IF NOT EXISTS run_writes_in_flight ON run_writes (run_id) WHERE status = 'dispatched'",
	"CREATE INDEX IF NOT EXISTS run_writes_deadline ON run_writes (deadline_at) WHERE status = 'dispatched'",
];

/** The page_tokens table. */
export const PAGE_TOKEN_SCHEMA: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS page_tokens (
		token TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		tool TEXT NOT NULL CHECK (length(tool) <= ${MAX_TOOL_NAME}),
		query_hash TEXT NOT NULL,
		upstream_cursor TEXT NOT NULL CHECK (length(upstream_cursor) <= ${MAX_UPSTREAM_CURSOR}),
		created_at INTEGER NOT NULL
	) STRICT`,
	"CREATE INDEX IF NOT EXISTS page_tokens_run ON page_tokens (run_id)",
];
