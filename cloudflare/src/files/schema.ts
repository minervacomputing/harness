// The folder's tables in the Conversation Durable Object's SQLite (ARCHITECTURE.md: Data placement): a
// schema step of conversation/schema.ts, additive only (lib/sqlite.ts). Times are epoch milliseconds.

/**
 * - `folder_versions`: one row per version; its contents (size, counts, digest, run, attempt) never change,
 *   while `kind` and `parent_id` may when a run publishes its checkpoint.
 * - `folder_version_parts`: a version's stored entries as canonical JSON, in parts under the 2 MB a value or
 *   a row may have (a manifest at the limits is about 11 MB).
 * - `folder_blobs`: the conversation's objects in R2, `blobs/<ws>/<conv>/<sha256>/<random>`, each recorded
 *   before it is written (ARCHITECTURE.md: Files). `loose`: written ahead, not yet claimed, deleted once due an
 *   hour later; `stored`: named by a version or uploaded by a run, one per contents; `doomed`: to delete,
 *   then deleted once more a day after the first deletion (`deletions`), for a write still in flight.
 * - `folder_grants`: contents a run uploaded, which it may read and name until it ends (RunBlob).
 * - `folder_counter`: the byte total last reported to the Workspace.
 */
export const FOLDER_SCHEMA = `
CREATE TABLE folder_versions (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('base', 'checkpoint', 'turn')),
	run_id TEXT,
	attempt INTEGER,
	size INTEGER NOT NULL CHECK (size >= 0),
	file_count INTEGER NOT NULL CHECK (file_count >= 0),
	entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
	digest TEXT NOT NULL,
	parts INTEGER NOT NULL CHECK (parts >= 1),
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX folder_versions_run ON folder_versions (run_id, kind);

CREATE TABLE folder_version_parts (
	version_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (version_id, part)
) STRICT, WITHOUT ROWID;

CREATE TABLE folder_blobs (
	key TEXT PRIMARY KEY,
	sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
	size INTEGER NOT NULL CHECK (size >= 0),
	state TEXT NOT NULL CHECK (state IN ('loose', 'stored', 'doomed')),
	run_id TEXT,
	created_at INTEGER NOT NULL,
	due_at INTEGER,
	deletions INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	CHECK ((state = 'stored') = (due_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX folder_blobs_stored ON folder_blobs (sha256) WHERE state = 'stored';
CREATE INDEX folder_blobs_due ON folder_blobs (due_at) WHERE state <> 'stored';
CREATE INDEX folder_blobs_run ON folder_blobs (run_id, state);

CREATE TABLE folder_grants (
	run_id TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	PRIMARY KEY (run_id, sha256)
) STRICT, WITHOUT ROWID;

CREATE TABLE folder_counter (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	reported INTEGER NOT NULL CHECK (reported >= 0)
) STRICT;

-- What a version holds and what a blob is never change; a version's kind and parent may.
CREATE TRIGGER folder_versions_immutable BEFORE UPDATE OF id, run_id, attempt, size, file_count, entry_count, digest, parts, created_at ON folder_versions
BEGIN SELECT RAISE(ABORT, 'A folder version''s contents cannot change.'); END;
CREATE TRIGGER folder_version_parts_immutable BEFORE UPDATE ON folder_version_parts
BEGIN SELECT RAISE(ABORT, 'A folder version''s contents cannot change.'); END;
CREATE TRIGGER folder_blobs_identity BEFORE UPDATE OF key, sha256, size ON folder_blobs
BEGIN SELECT RAISE(ABORT, 'A blob''s identity cannot change.'); END;
`;

/**
 * `folder_report`: the revision of the last byte report sent to the Workspace, one above the one before,
 * written before the report leaves, so a report a reset instance sent is always older than the next one's.
 */
export const FOLDER_REPORT_SCHEMA = `
CREATE TABLE folder_report (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
`;
