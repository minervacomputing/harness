-- Organizations (ARCHITECTURE.md: Data placement), additive. An organization sits above
-- workspaces and owns its members, settings, entitlements and data region. For now every personal
-- sign-up gets one organization of its own, which owns the personal workspace; the UI does not show them
-- yet. Existing workspaces keep a null organization until a later step assigns one.

CREATE TABLE organizations (
	id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
	-- `personal`: made for one person's sign-up, with exactly one member.
	kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
	-- Where the organization's workspaces keep their data (src/addressing.ts); null is no constraint.
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction IN ('eu')),
	-- The person a personal organization was made for, so a retried sign-up cannot make a second one.
	personal_owner TEXT UNIQUE REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	CHECK ((kind = 'personal') = (personal_owner IS NOT NULL))
) STRICT;

CREATE TABLE organization_members (
	organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, user_id)
) STRICT;
CREATE INDEX organization_members_user ON organization_members (user_id);

ALTER TABLE workspaces ADD COLUMN organization_id TEXT REFERENCES organizations (id) ON DELETE CASCADE;
CREATE INDEX workspaces_organization ON workspaces (organization_id);
