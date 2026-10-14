-- The recovery index (docs/plans/start-and-cancel.md, The recovery index): the conversations and runs Laravel's commands
-- named, bound to the scope and conversation of the first command that named them, so a later command naming others is
-- refused before any object is reached, and the object is addressed by the jurisdiction recorded here, never the command's.
-- A run's row is written before its Conversation object admits it, so no run executes without one. The rows outlive the
-- restore window, deleted conversations' included.
CREATE TABLE recovery_conversations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction = 'eu'),
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE recovery_runs (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES recovery_conversations (id),
	-- SHA-256 of startRun's input as canonical JSON, set by the first start; null while only a cancel has named the run.
	input_digest TEXT,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX recovery_runs_conversation ON recovery_runs (conversation_id);
