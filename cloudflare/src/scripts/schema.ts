// The Scripts Durable Object's SQLite (scripts/scripts.ts): its fence, so the order survives its own
// resets. The newest run and attempt it ran a script or a reset under, the newest script of that attempt
// (script ids are UUIDv7s, made in order), and whether that script was reset as ended. Additive only; see
// lib/sqlite.ts.

/** lib/sqlite.ts `Migration`, written out so the account tests (Node) can read the ids without the Worker's types. */
interface Migration {
	id: number;
	sql: string;
}

export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		sql: `
CREATE TABLE script_fence (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	run_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	script_id TEXT NOT NULL,
	ended INTEGER NOT NULL CHECK (ended IN (0, 1))
) STRICT;`,
	},
];
