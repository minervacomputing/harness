-- A deleted Laravel conversation's purge (docs/plans/chunk-15a-design.md, Physical deletion): set by its object's retention before
-- its blobs and its storage are deleted, and never cleared, so the Worker answers a later command from the index alone.
ALTER TABLE recovery_conversations ADD COLUMN purged_at INTEGER;
