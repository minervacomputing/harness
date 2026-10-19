-- The engine's own accounts retire: Laravel holds the people, organizations, workspaces and
-- connections, and the engine reads only the recovery index, its identity row and D1's migrations table. Every other table
-- goes, with its rows and indexes; instance_identity, recovery_conversations and recovery_runs stay as they are.
--
-- D1 enforces foreign keys, and dropping a table deletes its rows first, which a child still holding rows refuses
-- (ON DELETE RESTRICT: organization and workspaces against user). So children go before their parents, and the checks
-- are deferred to the end of the migration as 0003 does.
PRAGMA defer_foreign_keys = on;

DROP TABLE oauth_flows;
DROP TABLE memberships;
DROP TABLE invitation;
DROP TABLE "member";
DROP TABLE instance_setup;
DROP TABLE instance_settings;
DROP TABLE account;
DROP TABLE "session";
DROP TABLE "twoFactor";
DROP TABLE workspaces;
DROP TABLE "organization";
DROP TABLE "user";
DROP TABLE verification;
DROP TABLE "rateLimit";
DROP TABLE oauth_clients;
