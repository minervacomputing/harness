// Applies the D1 migrations to the local database before the tests.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

const { DB, TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(DB, TEST_MIGRATIONS);
