-- The instance's administration (src/accounts/instance.ts). An instance admin is a user whose Better Auth
-- role is 'admin' (the admin plugin's), apart from organization and workspace roles.
--
-- `instance_setup` holds the one claim of the first-run setup: whoever first presents MINERVA_SETUP_KEY
-- while signed in becomes the first admin. The claim and the role are written in one batch, the claim
-- with `ON CONFLICT DO NOTHING` and the role only if the row holds this request's claim token, so of
-- concurrent claims exactly one wins. The row stays after its user is deleted: setup happens once.
CREATE TABLE instance_setup (
	id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
	claim TEXT NOT NULL,
	user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
	claimed_at INTEGER NOT NULL
) STRICT;

-- Settings instance admins change at run time. `signup_open` overrides MINERVA_SIGNUP_OPEN; null follows it.
CREATE TABLE instance_settings (
	id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
	signup_open INTEGER CHECK (signup_open IN (0, 1)),
	updated_at INTEGER NOT NULL,
	updated_by TEXT REFERENCES "user" (id) ON DELETE SET NULL
) STRICT;
