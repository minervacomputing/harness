// Applies the D1 migrations to the local database before the tests, and lowers the cost of password hashes.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { useCheapHashing } from "./cheap-hashing.ts";

const { DB, TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(DB, TEST_MIGRATIONS);

await useCheapHashing();
