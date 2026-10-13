-- One stored value for each identifier. Better Auth's index on
-- `verification.identifier` is not unique, so a resent email code was added next to the one it replaced,
-- and a check of the newest code could leave the older one usable by a request in between. With the index
-- unique, sending a code takes Better Auth's own fallback: the insert fails, the old row is deleted and the
-- new one inserted. Two-factor challenges and trusted devices have random identifiers already.
--
-- Of the rows already sharing an identifier, the newest stays: the latest "createdAt", and on a tie the
-- greater id. That tie-break is only deterministic: ids made in one millisecond by different isolates are
-- not ordered, so the code kept may be the older one, and its owner asks for another.
DELETE FROM verification WHERE EXISTS (
	SELECT 1 FROM verification AS newer
	WHERE newer.identifier = verification.identifier
		AND (newer."createdAt" > verification."createdAt" OR (newer."createdAt" = verification."createdAt" AND newer.id > verification.id))
);
DROP INDEX verification_identifier_idx;
CREATE UNIQUE INDEX verification_identifier_idx ON verification (identifier);
