-- Accounts move to Better Auth (plan: The web API, decided 2026-10-12). This replaces 5a's account tables
-- (users, emails, passwords, two-factor, sessions, auth_flows, organizations) with Better Auth's, and
-- rebuilds ours that referenced them (workspaces, memberships, oauth_flows) against the new ones.
--
-- Better Auth's tables are what its CLI prints for our configuration (`pnpm run auth:schema`: the pinned
-- `auth` 1.7.7 with scripts/auth-schema.ts, which runs src/accounts/auth-options.ts), copied unchanged;
-- test/platform/accounts-schema.test.ts checks that D1 matches what that configuration expects. They follow Better
-- Auth's conventions, not 0001's: camelCase columns, not STRICT, times as ISO 8601 text in UTC
-- (`2026-10-12T07:06:06.569Z`), booleans 0 or 1. Ids are UUIDv7 (`advanced.database.generateId`), so our
-- tables keep their 36-character ids and millisecond times.
--
-- An instance made before this migration keeps its people and their data: users, verified addresses,
-- password hashes (the same `scrypt$…` format, verified by the same function), organizations and their
-- members, workspaces and memberships are carried over. Sessions, pending flows, rate-limit counters of
-- 0001 (rate_limits stays for step 5a3's account limits) and OAuth flows in progress are not: everyone
-- signs in again. Two-factor authenticators cannot be carried over (Better Auth encrypts its own way), nor
-- secondary addresses (Better Auth has one per user); 5b, which added both, never shipped, so none exist,
-- and if one does the migration stops (below) rather than drop it.
--
-- D1 has no interactive transactions, so Better Auth's multi-row operations are separate statements;
-- provisioning (src/accounts/provision.ts) is idempotent and recorded in `user.provisionedAt`.

PRAGMA defer_foreign_keys = on;

-- Better Auth's tables, as generated.
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "twoFactorEnabled" integer, "role" text, "banned" integer, "banReason" text, "banExpires" date, "provisionedAt" date);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text, "impersonatedBy" text);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create table "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);
create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text, "personalOwner" text unique references "user" ("id") on delete restrict, "jurisdiction" text);
create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);
create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);
create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "twoFactor_secret_idx" on "twoFactor" ("secret");
create index "twoFactor_userId_idx" on "twoFactor" ("userId");
create index "member_organizationId_idx" on "member" ("organizationId");
create index "member_userId_idx" on "member" ("userId");
create index "invitation_organizationId_idx" on "invitation" ("organizationId");
create index "invitation_email_idx" on "invitation" ("email");

-- Ours on Better Auth's tables. A user is a member of an organization once, so provisioning can insert
-- its membership with ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX member_organization_user ON "member" ("organizationId", "userId");

-- Stops the migration while any two-factor authenticator or secondary address exists (see the top): an id
-- that is not 36 characters fails workspaces_v2's CHECK.
CREATE TABLE workspaces_v2 (
	id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
	-- The organization that owns the workspace. Deleting it, or the personal owner, is refused while the
	-- workspace exists: its Durable Object and files need deleting first (plan: Files, Deletion).
	organization_id TEXT NOT NULL REFERENCES "organization" (id) ON DELETE RESTRICT,
	kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
	personal_owner TEXT UNIQUE REFERENCES "user" (id) ON DELETE RESTRICT,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction IN ('eu')),
	created_at INTEGER NOT NULL,
	-- Set once the Workspace object is initialized; until then the workspace is not listed (web-api 6.3).
	initialized_at INTEGER,
	CHECK ((kind = 'personal') = (personal_owner IS NOT NULL))
) STRICT;
INSERT INTO workspaces_v2 (id, organization_id, kind, name, created_at)
	SELECT 'two-factor authenticators exist: carry them over by hand', '', 'team', 'x', 0 FROM authenticators LIMIT 1;
INSERT INTO workspaces_v2 (id, organization_id, kind, name, created_at)
	SELECT 'secondary addresses exist: carry them over by hand', '', 'team', 'x', 0 FROM emails WHERE is_primary = 0 LIMIT 1;

-- Carried over: users with their primary address, an instance admin for `is_staff`, banned for inactive.
INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", "role", "banned")
	SELECT u.id, u.name, e.email, e.verified,
		strftime('%Y-%m-%dT%H:%M:%fZ', u.date_joined / 1000.0, 'unixepoch'),
		strftime('%Y-%m-%dT%H:%M:%fZ', u.date_joined / 1000.0, 'unixepoch'),
		0, CASE WHEN u.is_staff = 1 THEN 'admin' ELSE 'user' END, 1 - u.is_active
	FROM users u JOIN emails e ON e.user_id = u.id AND e.is_primary = 1;

-- Passwords become credential accounts (one per user, so the user's id serves as the account's).
INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
	SELECT p.user_id, p.user_id, 'credential', p.user_id, p.hash,
		strftime('%Y-%m-%dT%H:%M:%fZ', p.updated_at / 1000.0, 'unixepoch'),
		strftime('%Y-%m-%dT%H:%M:%fZ', p.updated_at / 1000.0, 'unixepoch')
	FROM passwords p;

-- An organization's slug is its id (src/accounts/provision.ts).
INSERT INTO "organization" ("id", "name", "slug", "createdAt", "personalOwner", "jurisdiction")
	SELECT o.id, o.name, o.id,
		strftime('%Y-%m-%dT%H:%M:%fZ', o.created_at / 1000.0, 'unixepoch'), o.personal_owner, o.jurisdiction
	FROM organizations o;
-- A workspace from before 0002 has no organization: it gets one under the workspace's id, personal for a
-- personal workspace whose owner has none yet, a team organization (named as the workspace, its members
-- the workspace's) for a team workspace.
INSERT INTO "organization" ("id", "name", "slug", "createdAt", "personalOwner", "jurisdiction")
	SELECT w.id, w.name, w.id, strftime('%Y-%m-%dT%H:%M:%fZ', w.created_at / 1000.0, 'unixepoch'), w.personal_owner, w.jurisdiction
	FROM workspaces w
	WHERE w.organization_id IS NULL
		AND (w.personal_owner IS NULL OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.personal_owner = w.personal_owner));

-- Random UUIDs for the members (version 4, which Better Auth's ids do not need to share).
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
	SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
			substr('89AB', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
		m.organization_id, m.user_id, m.role, strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at / 1000.0, 'unixepoch')
	FROM organization_members m;
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
	SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
			substr('89AB', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
		o.id, o."personalOwner", 'owner', o."createdAt"
	FROM "organization" o WHERE o."personalOwner" IS NOT NULL
	ON CONFLICT ("organizationId", "userId") DO NOTHING;
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
	SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
			substr('89AB', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
		w.id, m.user_id, m.role, strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at / 1000.0, 'unixepoch')
	FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
	WHERE w.organization_id IS NULL AND w.personal_owner IS NULL
	ON CONFLICT ("organizationId", "userId") DO NOTHING;

INSERT INTO workspaces_v2 (id, organization_id, kind, name, personal_owner, jurisdiction, created_at, initialized_at)
	SELECT w.id, COALESCE(w.organization_id, (SELECT o.id FROM "organization" o WHERE o."personalOwner" = w.personal_owner), w.id),
		w.kind, w.name, w.personal_owner, w.jurisdiction, w.created_at, w.initialized_at
	FROM workspaces w;

-- A carried-over user is provisioned once their personal workspace is initialized; otherwise their next
-- sign-in or /api/me finishes it.
UPDATE "user" SET "provisionedAt" = (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', w.initialized_at / 1000.0, 'unixepoch') FROM workspaces_v2 w WHERE w.personal_owner = "user".id AND w.initialized_at IS NOT NULL
);

CREATE TABLE memberships_v2 (
	workspace_id TEXT NOT NULL REFERENCES workspaces_v2 (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
) STRICT;
INSERT INTO memberships_v2 (workspace_id, user_id, role, created_at) SELECT workspace_id, user_id, role, created_at FROM memberships;

-- The OAuth connection flow, one per Better Auth session, valid 600 s; flows in progress are not kept.
CREATE TABLE oauth_flows_v2 (
	session_id TEXT NOT NULL PRIMARY KEY REFERENCES "session" (id) ON DELETE CASCADE,
	state TEXT NOT NULL,
	verifier TEXT NOT NULL,
	provider TEXT NOT NULL,
	workspace_id TEXT NOT NULL REFERENCES workspaces_v2 (id) ON DELETE CASCADE,
	connection_id TEXT,
	client_id TEXT NOT NULL,
	issued_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	CHECK (expires_at > issued_at)
) STRICT;

-- The old tables, children first (dropping a table deletes its rows, which would cascade).
DROP TABLE oauth_flows;
DROP TABLE memberships;
DROP TABLE workspaces;
DROP TABLE auth_flows;
DROP TABLE recovery_codes;
DROP TABLE totp_periods;
DROP TABLE authenticators;
DROP TABLE sessions;
DROP TABLE passwords;
DROP TABLE emails;
DROP TABLE organization_members;
DROP TABLE organizations;
DROP TABLE users;

-- Renaming rewrites the references to them in the other new tables.
ALTER TABLE workspaces_v2 RENAME TO workspaces;
ALTER TABLE memberships_v2 RENAME TO memberships;
ALTER TABLE oauth_flows_v2 RENAME TO oauth_flows;
CREATE INDEX workspaces_organization ON workspaces (organization_id);
CREATE INDEX memberships_user ON memberships (user_id);
