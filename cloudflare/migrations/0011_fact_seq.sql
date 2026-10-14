-- The recovery index's highest fact sequence per Laravel conversation (docs/plans/credentials-and-facts.md): raised before
-- any of its facts is sent to Laravel, by a delivery or a replay, so every fact Laravel was ever sent is at or below it.
ALTER TABLE recovery_conversations ADD COLUMN fact_seq INTEGER NOT NULL DEFAULT 0;
