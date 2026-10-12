-- Sessions carry a credential stamp (src/accounts/policy.ts, step 5a3): an HMAC of their user's id, email
-- and password hash as they were when the session was made. A session whose stamp no longer matches is
-- deleted when it is next used, so a password or email change ends every older session at once. The
-- column is what `pnpm run auth:schema` prints for the session's additional field.
--
-- Sessions made before this migration have no stamp and end on their next use: their users sign in again.
ALTER TABLE "session" ADD COLUMN "credentialStamp" text;
