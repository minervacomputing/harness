-- Accounts and the workspace directory (ARCHITECTURE.md: Data placement; web-api spec 3, 5, 6, 9). Tenant data lives
-- in each workspace's Durable Object; D1 holds what spans workspaces. Times are milliseconds since the
-- epoch, booleans 0 or 1, ids lowercase UUIDv7. Tables are STRICT, so a counter or a time stored as text
-- is refused instead of comparing as text. D1 has no interactive transactions, so every single-use
-- and attempt rule is a conditional statement (UPDATE … WHERE attempts < 3 RETURNING, DELETE … RETURNING)
-- or an atomic batch, and the constraints below make the rules hold even if code forgets one.

CREATE TABLE users (
	id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
	name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	-- The platform operator; independent of workspace roles.
	is_staff INTEGER NOT NULL DEFAULT 0 CHECK (is_staff IN (0, 1)),
	last_login INTEGER,
	date_joined INTEGER NOT NULL
) STRICT;

-- One address per user for now (the API cannot change it). Stored stripped and lowercased; unique across
-- users, so a sign-up with a taken address creates nothing (web-api 5.5).
CREATE TABLE emails (
	email TEXT NOT NULL PRIMARY KEY CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
	is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX emails_user ON emails (user_id);
CREATE UNIQUE INDEX emails_one_primary ON emails (user_id) WHERE is_primary = 1;

-- No row means no usable password (`has_usable_password: false`). `hash` is versioned (`scrypt$…`, the
-- removed docs/plans/cloudflare.md, The web API; 0007 drops this format). `fingerprint` is an HMAC of the hash that sessions copy: a password change or reset
-- changes it, which ends every other session on its next request (web-api 3.1).
CREATE TABLE passwords (
	user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	hash TEXT NOT NULL CHECK (length(hash) > 0),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
	updated_at INTEGER NOT NULL
) STRICT;

-- Two-factor (web-api 5.8): at most one TOTP and one set of recovery codes per user. `data` is JSON with
-- the TOTP secret or the recovery seed encrypted (Fernet with MINERVA_ENCRYPTION_KEYS).
CREATE TABLE authenticators (
	id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	type TEXT NOT NULL CHECK (type IN ('totp', 'recovery_codes', 'webauthn')),
	data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
) STRICT;
CREATE INDEX authenticators_user ON authenticators (user_id);
CREATE UNIQUE INDEX authenticators_one_of_each ON authenticators (user_id, type) WHERE type IN ('totp', 'recovery_codes');

-- Recovery codes, one row each, found by an HMAC of the code. Using one is
-- `UPDATE … SET used_at = ? WHERE authenticator_id = ? AND code_hash = ? AND used_at IS NULL RETURNING`.
CREATE TABLE recovery_codes (
	authenticator_id TEXT NOT NULL REFERENCES authenticators (id) ON DELETE CASCADE,
	position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
	code_hash TEXT NOT NULL,
	used_at INTEGER,
	PRIMARY KEY (authenticator_id, position),
	UNIQUE (authenticator_id, code_hash)
) STRICT;

-- A TOTP code works once per 30-second period per user (web-api 5.5): inserting the period is the claim,
-- and a conflict is a replay. Rows older than a few periods are swept.
CREATE TABLE totp_periods (
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	period INTEGER NOT NULL,
	PRIMARY KEY (user_id, period)
) STRICT;

-- Server-side sessions keyed by a hash of the `sessionid` cookie, which is random and never stored
-- (web-api 3.1). Anonymous sessions exist too: they hold a pending login. `auth_records` is allauth's
-- `[{method, at, ...}]`, newest last, which reauthentication reads. A login rotates the session (a new row).
CREATE TABLE sessions (
	id_hash TEXT NOT NULL PRIMARY KEY CHECK (length(id_hash) = 64),
	user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
	password_fingerprint TEXT,
	auth_records TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(auth_records)),
	-- A TOTP secret being set up, encrypted; replaced on every GET of the setup page.
	totp_setup TEXT,
	created_at INTEGER NOT NULL,
	-- Two weeks after the session was last saved.
	expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Pending authentication, bound to a session, one row per kind (web-api 5.5):
--   login               the pending stage of a login (verify_email, login_by_code, mfa_authenticate), 900 s
--   email_verification  the emailed verification code, 900 s
--   login_code          the emailed sign-in code, 180 s
--   password_reset      the emailed reset code, 180 s
-- A code is stored as an HMAC of its normalized form (digits only); an unknown address gets no code, so
-- nothing can succeed there. A wrong code is `UPDATE … SET attempts = attempts + 1 WHERE … AND attempts < 3
-- RETURNING attempts`, and the third ends the process; the right one is `DELETE … WHERE code_hash = ? AND
-- attempts < 3 AND expires_at > ? RETURNING`, so it is used once.
CREATE TABLE auth_flows (
	session_hash TEXT NOT NULL REFERENCES sessions (id_hash) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('login', 'email_verification', 'login_code', 'password_reset')),
	user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
	email TEXT,
	stage TEXT CHECK (stage IS NULL OR stage IN ('verify_email', 'login_by_code', 'mfa_authenticate')),
	-- The stage's state, such as the method that started the login.
	state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state)),
	code_hash TEXT,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
	-- Codes sent again; the quota is small (web-api 5.14).
	resends INTEGER NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 2),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (session_hash, kind),
	CHECK ((kind = 'login') = (stage IS NOT NULL))
) STRICT;
CREATE INDEX auth_flows_expiry ON auth_flows (expires_at);

-- Rate limits as fixed-window counters per action and key (an IP, an address, a user) (web-api 5.7):
-- `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`. Per account, not per process.
CREATE TABLE rate_limits (
	key TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (key, window_start)
) STRICT;
CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);

-- The directory. A workspace's data lives in its Durable Object, addressed by id and jurisdiction; the
-- Worker lists a workspace only once that object is initialized (web-api 6.3).
CREATE TABLE workspaces (
	id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
	kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
	personal_owner TEXT UNIQUE REFERENCES users (id) ON DELETE CASCADE,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction IN ('eu')),
	created_at INTEGER NOT NULL,
	initialized_at INTEGER,
	CHECK ((kind = 'personal') = (personal_owner IS NOT NULL))
) STRICT;

CREATE TABLE memberships (
	workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
) STRICT;
CREATE INDEX memberships_user ON memberships (user_id);

-- Dynamically registered OAuth clients, platform-wide, one per (app, redirect URI); a registration race
-- reads the row that won (connectors 11.1). The secret is encrypted.
CREATE TABLE oauth_clients (
	provider TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	client_id TEXT NOT NULL,
	secret_ciphertext TEXT NOT NULL,
	secret_key_version TEXT NOT NULL CHECK (length(secret_key_version) <= 32),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider, redirect_uri)
) STRICT;

-- The OAuth connection flow, one per session (a newer authorize replaces it), valid 600 s, and popped
-- with `DELETE … RETURNING` on the callback even when a later step fails (web-api 9).
CREATE TABLE oauth_flows (
	session_hash TEXT NOT NULL PRIMARY KEY REFERENCES sessions (id_hash) ON DELETE CASCADE,
	state TEXT NOT NULL,
	verifier TEXT NOT NULL,
	provider TEXT NOT NULL,
	workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	connection_id TEXT,
	client_id TEXT NOT NULL,
	issued_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	CHECK (expires_at > issued_at)
) STRICT;
