// The write ledger's, its holds' and page tokens' tables (gateway/ledger.ts, gateway/page-tokens.ts), schema steps
// of the Conversation Durable Object (conversation/schema.ts). Plain strings with no imports, so the
// account tests (Node) can read the object's step ids without the Worker's types.

/** The longest tool name and upstream cursor a page token keeps; longer values are refused. */
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

/**
 * What a write's settlement reports, fixed at dispatch (ledger.ts `WriteNote`): its tool, connection and keyed hash. A
 * step after LEDGER_SCHEMA, so a row written before it has them empty.
 */
export const LEDGER_NOTES_SCHEMA: readonly string[] = [
	"ALTER TABLE run_writes ADD COLUMN tool TEXT NOT NULL DEFAULT ''",
	"ALTER TABLE run_writes ADD COLUMN connection_id TEXT NOT NULL DEFAULT ''",
	"ALTER TABLE run_writes ADD COLUMN write_id TEXT NOT NULL DEFAULT ''",
];

/**
 * The run_holds table (holds.ts): a run's calls held for the user's approval, at most 10 (MAX_HOLDS), one per write key.
 * `contract` is the operation's fingerprint, `requirements` the fact's requirements as JSON.
 */
export const HOLD_SCHEMA: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS run_holds (
		run_id TEXT NOT NULL,
		position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
		key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
		write_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		tool TEXT NOT NULL,
		label TEXT NOT NULL,
		connection_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		operation TEXT NOT NULL,
		contract TEXT NOT NULL,
		arguments TEXT NOT NULL,
		requirements TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'used', 'closed')),
		created_at INTEGER NOT NULL,
		PRIMARY KEY (run_id, position),
		UNIQUE (run_id, key)
	) STRICT`,
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
