-- The last time step each authenticator accepted a TOTP code for (src/accounts/totp.ts). A code for that
-- step or an older one is refused, so a code works once, as allauth refuses a reused code today. The
-- step is claimed with a conditional upsert before Better Auth checks the code, so of two requests with
-- the same code only one gets through. `secret_hash` is a SHA-256 of the authenticator's stored
-- (encrypted) secret: setting up two-factor again replaces the secret in the same row, and the steps of
-- the old secret do not count against the new one.
CREATE TABLE totp_steps (
	two_factor_id TEXT NOT NULL PRIMARY KEY REFERENCES "twoFactor" (id) ON DELETE CASCADE,
	secret_hash TEXT NOT NULL,
	last_step INTEGER NOT NULL
) STRICT;
