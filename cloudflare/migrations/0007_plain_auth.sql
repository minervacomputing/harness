-- Plain Better Auth (docs/plans/plain-better-auth.md): the policy of our own around Better Auth is gone,
-- and so is what it stored. Sessions lose their credential stamp (0004), the TOTP replay guard (0005) and
-- the per-address and per-user limits (`rate_limits`, 0001) go; Better Auth's per-IP limiter keeps
-- `rateLimit`.
--
-- Passwords in our own format (`scrypt$…`) do not verify with Better Auth's hasher, so those credentials
-- are deleted: their users sign in with an email code or reset their password. Every session is deleted
-- (and with it every OAuth flow in progress), since sessions the stamps had made stale would otherwise be
-- valid again, and every verification row: pending email codes are stored under the old keyed hash, and
-- two-factor challenges carry the old stamps. Everyone signs in again.
DROP TABLE totp_steps;
DROP TABLE rate_limits;
DELETE FROM "session";
ALTER TABLE "session" DROP COLUMN "credentialStamp";
DELETE FROM account WHERE "providerId" = 'credential' AND password GLOB 'scrypt$*';
DELETE FROM verification;

-- One password for each user. Better Auth's `setPassword` checks for a password and then inserts one, as
-- separate statements, so two first passwords sent at once would both be stored; this refuses the second
-- (routes.ts `/api/me/password`). Our own policy had kept a user to one, so no rows are expected to clash.
CREATE UNIQUE INDEX account_one_credential ON account ("userId") WHERE "providerId" = 'credential';
