-- The instance's identity (cloudflare/README.md, Identity on the account): its name, and whether it is a test
-- instance (the test build) or not. One row, which scripts/identity.ts writes as the first change a deploy or a
-- reset makes on the account, once its identity check has passed. The deploy creates this table before it applies
-- the migrations, so this statement is the one it runs, and here it changes nothing. Nothing in the Worker reads it.
CREATE TABLE IF NOT EXISTS instance_identity (
	id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
	name TEXT NOT NULL,
	test INTEGER NOT NULL CHECK (test IN (0, 1))
) STRICT;
