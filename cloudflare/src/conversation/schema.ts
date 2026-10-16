// The Conversation Durable Object's own tables (ARCHITECTURE.md: Data placement). pi keeps its tables under `pi_` and
// the Agents SDK under `cf_agents_`; the folder's versions and the script store add their own steps here as
// they land (additive only, lib/sqlite.ts).

import { FOLDER_REPORT_SCHEMA, FOLDER_SCHEMA } from "../files/schema.ts";
import { LEDGER_NOTES_SCHEMA, LEDGER_SCHEMA, PAGE_TOKEN_SCHEMA } from "../gateway/schema.ts";

/** lib/sqlite.ts `Migration`, written out so the account tests (Node) can read the ids without the Worker's types. */
interface Migration {
	id: number;
	sql: string;
}

export const MIGRATIONS: Migration[] = [
	// Unused since chunk 13b: `messages`, `starts`, `releases`, and `runs.released`; `runs.activated` is only still written
	// (store.ts `activate`). They stay while the previous version may run beside this one or after a rollback, and its code
	// writes them (chunk-13b-design.md, The Conversation keeps its tables and columns).
	{
		id: 1,
		sql: `
CREATE TABLE conversation (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction = 'eu'),
	user_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	folder_version_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	deleted_at INTEGER
) STRICT;

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
	content TEXT NOT NULL,
	attachments TEXT NOT NULL DEFAULT '[]',
	run_id TEXT,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_order ON messages (created_at, id);
CREATE INDEX messages_run ON messages (run_id, role);

CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('queued', 'provisioning', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
	attempt INTEGER NOT NULL DEFAULT 1,
	attempt_started_at INTEGER NOT NULL,
	error_code TEXT NOT NULL DEFAULT '',
	error_message TEXT NOT NULL DEFAULT '',
	snapshot TEXT NOT NULL,
	deadline INTEGER,
	revoked INTEGER NOT NULL DEFAULT 0,
	activated INTEGER NOT NULL DEFAULT 0,
	released INTEGER NOT NULL DEFAULT 0,
	writes_uncertain INTEGER NOT NULL DEFAULT 0,
	session TEXT,
	provider_session TEXT,
	base_version_id TEXT,
	checkpoint_version_id TEXT,
	result_version_id TEXT,
	folder_changes TEXT,
	folder_warnings TEXT,
	uploaded_bytes INTEGER NOT NULL DEFAULT 0,
	model_calls INTEGER NOT NULL DEFAULT 0,
	tool_calls INTEGER NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	unmetered_model_calls INTEGER NOT NULL DEFAULT 0,
	event_seq INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER
) STRICT;
CREATE INDEX runs_order ON runs (created_at, id);
CREATE INDEX runs_status ON runs (status);
CREATE UNIQUE INDEX runs_session ON runs (session) WHERE session IS NOT NULL;

CREATE TABLE attempts (
	run_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	ended TEXT CHECK (ended IS NULL OR ended IN ('completed', 'restarted', 'failed', 'cancelled')),
	PRIMARY KEY (run_id, attempt)
) STRICT;

CREATE TABLE run_events (
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	data TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE starts (
	run_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	content TEXT NOT NULL,
	upload_ids TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE releases (
	run_id TEXT PRIMARY KEY,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tombstones (
	run_id TEXT PRIMARY KEY,
	reason TEXT NOT NULL,
	entry_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tool_executions (
	run_id TEXT NOT NULL,
	call_id TEXT NOT NULL,
	executions INTEGER NOT NULL,
	PRIMARY KEY (run_id, call_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE tool_arguments (
	run_id TEXT NOT NULL,
	call_id TEXT NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (run_id, call_id)
) STRICT, WITHOUT ROWID;
`,
	},
	// The write ledger and page tokens (gateway/ledger.ts, gateway/page-tokens.ts; ARCHITECTURE.md: Writes).
	{ id: 2, sql: [...LEDGER_SCHEMA, ...PAGE_TOKEN_SCHEMA].join(";\n") },
	// A run's snapshot too long for one value (every grant of the user is in it): in parts under the 2 MB a
	// string or a row may have, with runs.snapshot left empty. One that fits stays in runs.snapshot.
	{
		id: 3,
		sql: `
CREATE TABLE run_snapshots (
	run_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (run_id, part)
) STRICT;
`,
	},
	// The folder: versions, blobs, grants and the byte total (files/schema.ts).
	{ id: 4, sql: FOLDER_SCHEMA },
	// The revision of the folder's last byte report (files/store.ts `#report`).
	{ id: 5, sql: FOLDER_REPORT_SCHEMA },
	// A client's key for a message it may send again (the previous version's `postMessage`, Idempotency-Key): the run it
	// started, and a digest of the message, kept a day. Unused since chunk 13b, and kept as migration 1's tables are.
	{
		id: 6,
		sql: `
CREATE TABLE start_keys (
	key TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	digest TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX start_keys_age ON start_keys (created_at);
`,
	},
	// Laravel's conversations (docs/plans/start-and-cancel.md): the organization a conversation is bound to (null for
	// the Workspace's); each start's preparation, its compiled snapshot kept from the first try until the start is
	// answered (in parts, like run_snapshots); and each start's answer, kept so a repeat gets it again.
	{
		id: 7,
		sql: `
ALTER TABLE conversation ADD COLUMN organization_id TEXT;

CREATE TABLE internal_starts (
	run_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (run_id, part)
) STRICT;

CREATE TABLE internal_answers (
	run_id TEXT PRIMARY KEY,
	answer TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;
`,
	},
	// A Laravel conversation's facts and their delivery (docs/plans/credentials-and-facts.md): each fact's JSON as it is
	// delivered, by its sequence; the delivery's state (`written` is never lowered, so a sequence is never used twice); and
	// what a write's settlement reports, fixed at dispatch.
	{
		id: 8,
		sql: [
			`CREATE TABLE facts (
	seq INTEGER PRIMARY KEY,
	run_id TEXT NOT NULL,
	fact TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT`,
			`CREATE TABLE fact_delivery (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	written INTEGER NOT NULL DEFAULT 0,
	acknowledged INTEGER NOT NULL DEFAULT 0,
	indexed INTEGER NOT NULL DEFAULT 0,
	failures INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL DEFAULT 0,
	stopped TEXT
) STRICT`,
			...LEDGER_NOTES_SCHEMA,
		].join(";\n"),
	},
	// Each counted model call (docs/plans/chunk-14a-design.md, Decisions): recorded before its request by the instance that
	// sends it, settled once (`outcome` set) before pi hears its answer. Tokens are the report's, or the reservation for an
	// unmetered call; `request_bytes` is null for a call that built no request.
	{
		id: 9,
		sql: `
CREATE TABLE call_records (
	run_id TEXT NOT NULL,
	call TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	instance TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	reserved_input INTEGER NOT NULL,
	reserved_output INTEGER NOT NULL,
	request_bytes INTEGER,
	created_at INTEGER NOT NULL,
	outcome TEXT CHECK (outcome IN ('reported', 'refused', 'unmetered')),
	cause TEXT CHECK (cause IN ('no_usage', 'stopped', 'failed', 'lost')),
	input_tokens INTEGER,
	output_tokens INTEGER,
	cached_tokens INTEGER,
	cache_write_tokens INTEGER,
	reasoning_tokens INTEGER,
	settled_at INTEGER,
	PRIMARY KEY (run_id, call),
	CHECK ((outcome = 'unmetered') = (cause IS NOT NULL))
) STRICT;
CREATE INDEX call_records_open ON call_records (instance) WHERE outcome IS NULL;
`,
	},
];
