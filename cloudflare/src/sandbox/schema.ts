// The Sandbox Durable Object's SQLite (store.ts): its one row of durable state. Additive only; see
// lib/sqlite.ts. Step 3 rebuilds two tables, since SQLite cannot widen a CHECK in place, with the same
// columns and keys and two new nullable columns, so the previous version's code works on the result.

/** lib/sqlite.ts `Migration`, written out so the account tests (Node) can read the ids without the Worker's types. */
interface Migration {
	id: number;
	sql: string;
}

export const SANDBOX_MIGRATIONS: Migration[] = [
	{
		id: 1,
		sql: `CREATE TABLE sandbox_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			state TEXT NOT NULL CHECK (state IN ('none', 'starting', 'hardening', 'verified', 'in_use', 'destroying')),
			incarnation TEXT,
			run_id TEXT,
			attempt INTEGER,
			spec TEXT,
			hardened INTEGER NOT NULL DEFAULT 0,
			started_at INTEGER,
			verified_at INTEGER,
			cleanup_pending INTEGER NOT NULL DEFAULT 0,
			cleanup_reason TEXT,
			lease_until INTEGER,
			updated_at INTEGER NOT NULL
		) STRICT`,
	},
	{
		// One span per container incarnation, opened and closed with the state row (store.ts writeState); the
		// runs whose starts are refused; and when spans began to be kept: 0 for an object that never wrote its
		// state before, else the last time an older version did, since that version kept no spans.
		id: 2,
		sql: `CREATE TABLE container_spans (
			incarnation TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			attempt INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			lease_until INTEGER NOT NULL,
			ended_at INTEGER,
			ended TEXT CHECK (ended IN ('destroyed', 'gone')),
			CHECK ((ended_at IS NULL) = (ended IS NULL))
		) STRICT;
		CREATE INDEX container_spans_run ON container_spans (run_id);
		CREATE TABLE sealed_runs (
			run_id TEXT PRIMARY KEY,
			sealed_at INTEGER NOT NULL
		) STRICT;
		CREATE TABLE spans_since (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			at INTEGER NOT NULL
		) STRICT;
		INSERT INTO spans_since (id, at) SELECT 1, COALESCE(MAX(updated_at), 0) FROM sandbox_state`,
	},
	{
		// A container parked between two runs of the conversation: the state `parked`, the span's end `parked`, and what
		// the parked container was hardened with and holds. The previous version's writes name their columns, so they
		// leave the new ones alone, and it reads `parked` as a state it does not know, which destroys the container.
		id: 3,
		sql: `CREATE TABLE sandbox_state_3 (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			state TEXT NOT NULL CHECK (state IN ('none', 'starting', 'hardening', 'verified', 'in_use', 'parked', 'destroying')),
			incarnation TEXT,
			run_id TEXT,
			attempt INTEGER,
			spec TEXT,
			hardened INTEGER NOT NULL DEFAULT 0,
			started_at INTEGER,
			verified_at INTEGER,
			cleanup_pending INTEGER NOT NULL DEFAULT 0,
			cleanup_reason TEXT,
			lease_until INTEGER,
			updated_at INTEGER NOT NULL,
			hardening TEXT,
			parked_version TEXT
		) STRICT;
		INSERT INTO sandbox_state_3 (id, state, incarnation, run_id, attempt, spec, hardened, started_at, verified_at, cleanup_pending, cleanup_reason, lease_until, updated_at)
			SELECT id, state, incarnation, run_id, attempt, spec, hardened, started_at, verified_at, cleanup_pending, cleanup_reason, lease_until, updated_at FROM sandbox_state;
		DROP TABLE sandbox_state;
		ALTER TABLE sandbox_state_3 RENAME TO sandbox_state;
		CREATE TABLE container_spans_3 (
			incarnation TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			attempt INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			lease_until INTEGER NOT NULL,
			ended_at INTEGER,
			ended TEXT CHECK (ended IN ('destroyed', 'gone', 'parked')),
			CHECK ((ended_at IS NULL) = (ended IS NULL))
		) STRICT;
		INSERT INTO container_spans_3 (incarnation, run_id, attempt, started_at, lease_until, ended_at, ended)
			SELECT incarnation, run_id, attempt, started_at, lease_until, ended_at, ended FROM container_spans;
		DROP TABLE container_spans;
		ALTER TABLE container_spans_3 RENAME TO container_spans;
		CREATE INDEX container_spans_run ON container_spans (run_id)`,
	},
];
