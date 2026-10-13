// The Workspace Durable Object's tables (plan: Data placement). Steps are additive only and never edited
// once deployed (lib/sqlite.ts). There are no foreign keys: deletes that cascade (a connection's
// grants, an agent's layer) are done by the code in the same transaction, the same way in workerd and in
// node:sqlite. Times are epoch milliseconds, except `connections.expires_at` (epoch seconds, as the
// credential payload has it).

/** lib/sqlite.ts `Migration`, written out so the account tests (Node) can read the ids without the Worker's types. */
interface Migration {
	id: number;
	sql: string;
}

export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		sql: `
CREATE TABLE workspace (
	one INTEGER PRIMARY KEY CHECK (one = 1),
	id TEXT NOT NULL,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction = 'eu'),
	kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
	owner_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

-- Credentials are an AES-GCM envelope of the JSON payload (lib/encryption.ts) and
-- key_version its key id. The scopes and expiry are kept beside it in the clear (neither is secret), so a
-- lease decides about consent and refresh without decrypting. refresh_state: plan, Credentials and refresh.
CREATE TABLE connections (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL CHECK (length(provider) <= 64),
	owner_id TEXT,
	label TEXT NOT NULL,
	external_account_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'error', 'revoked')),
	ciphertext TEXT NOT NULL,
	key_version TEXT NOT NULL CHECK (length(key_version) <= 32),
	generation INTEGER NOT NULL CHECK (generation >= 1),
	scopes TEXT,
	expires_at REAL,
	refresh_state TEXT NOT NULL DEFAULT 'fresh' CHECK (refresh_state IN ('fresh', 'refreshing', 'refresh_uncertain')),
	refresh_generation INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (provider, external_account_id)
) STRICT;

-- One ceiling, one layer per user, one per agent; the id says which.
CREATE TABLE layers (
	id TEXT PRIMARY KEY,
	level TEXT NOT NULL CHECK (level IN ('ceiling', 'user', 'agent')),
	subject TEXT,
	restricted INTEGER NOT NULL CHECK (restricted IN (0, 1)),
	version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL,
	CHECK ((level = 'ceiling') = (subject IS NULL))
) STRICT;

CREATE TABLE grants (
	layer_id TEXT NOT NULL,
	connection_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (length(kind) <= 64),
	resource_id TEXT NOT NULL CHECK (length(resource_id) <= 200),
	resource_name TEXT NOT NULL DEFAULT '' CHECK (length(resource_name) <= 300),
	actions TEXT NOT NULL,
	effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
	PRIMARY KEY (layer_id, connection_id, kind, resource_id, effect)
) STRICT;
CREATE INDEX grants_connection ON grants (connection_id);

CREATE TABLE agents (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	name TEXT NOT NULL,
	instructions TEXT NOT NULL,
	model_alias TEXT NOT NULL DEFAULT 'default',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE agent_connections (
	agent_id TEXT NOT NULL,
	connection_id TEXT NOT NULL,
	PRIMARY KEY (agent_id, connection_id)
) STRICT;
CREATE INDEX agent_connections_connection ON agent_connections (connection_id);

-- An index of conversations; each Conversation object is authoritative for itself. ready: its object was
-- initialized. bytes: its absolute byte total. deleted_at: the tombstone of a deletion.
CREATE TABLE conversations (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
	ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
	deleted_at INTEGER
) STRICT;
CREATE INDEX conversations_user ON conversations (user_id, updated_at);
CREATE INDEX conversations_agent ON conversations (agent_id);

-- The run registry and index (plan: Starting a run, Strict revocation). starting: registered by beginRun,
-- not yet activated; active: activated; ended: released; expired: not activated within ten minutes.
CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	connection_ids TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'ended', 'expired')),
	revoked TEXT CHECK (revoked IS NULL OR revoked IN ('permissions_changed', 'connection_removed', 'agent_connections_changed', 'cancelled', 'emergency_stop')),
	registered_at INTEGER NOT NULL,
	activated_at INTEGER,
	ended_at INTEGER,
	end_status TEXT
) STRICT;
CREATE INDEX runs_live ON runs (state, registered_at);
CREATE INDEX runs_conversation ON runs (conversation_id);

-- beginRun's answer, kept while the run starts so a repeated call returns it, in parts under the 2 MB a
-- value may have.
CREATE TABLE run_answers (
	run_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (run_id, part)
) STRICT;

-- Unattached uploads, recorded before their object is written (plan: Files). size is the bytes reserved
-- against the workspace's quota while pending, the stored size once complete. run_id: reserved by that run.
CREATE TABLE uploads (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	size INTEGER NOT NULL CHECK (size >= 0),
	state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
	sha256 TEXT,
	media_type TEXT,
	key TEXT NOT NULL UNIQUE,
	run_id TEXT,
	created_at INTEGER NOT NULL,
	completed_at INTEGER
) STRICT;
CREATE INDEX uploads_user ON uploads (user_id);
CREATE INDEX uploads_run ON uploads (run_id);

-- R2 objects to delete: consumed and abandoned uploads.
CREATE TABLE doomed_objects (
	key TEXT PRIMARY KEY,
	due_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The revocation outbox: one cancel per run, written with the change that causes it (plan: Strict revocation).
CREATE TABLE outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	acknowledged_at INTEGER,
	ack_state TEXT
) STRICT;
CREATE INDEX outbox_pending ON outbox (acknowledged_at, next_attempt_at);
CREATE INDEX outbox_run ON outbox (run_id);

-- Conversations to destroy (plan: Files, Deletion): once their runs acknowledged the cancel, then again an
-- hour after the first deletion finished, for a write that was already in flight.
CREATE TABLE purges (
	conversation_id TEXT PRIMARY KEY,
	requested_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	first_done_at INTEGER,
	done_at INTEGER
) STRICT;
`,
	},
	// The newest byte report a conversation sent that the Workspace has seen (files/store.ts `#report`): an
	// older one, sent by an instance of the conversation that has since reset, changes nothing.
	{ id: 2, sql: "ALTER TABLE conversations ADD COLUMN bytes_revision INTEGER NOT NULL DEFAULT 0" },
];
