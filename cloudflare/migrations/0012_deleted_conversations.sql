-- A Laravel conversation's deletion: set by `deleteConversation` before its object
-- is reached, and never cleared, so the conversation stays deleted once chunk 15's retention has removed its object.
ALTER TABLE recovery_conversations ADD COLUMN deleted_at INTEGER;
