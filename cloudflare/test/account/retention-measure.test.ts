// Chunk 15a's measurement (docs/plans/chunk-15a-design.md, pi's tables, The measurement) on the test instance: 20 turns, one
// after another in one conversation, of the fake model, each a tool call and an answer of 2,000 characters, and each start
// with the conversation's history as Laravel sends it (its latest MAX_HISTORY messages). After each turn's run.settled has
// reached the fake Laravel, the driver reads the object's storage: `databaseSize`, and per table its rows and the bytes of its
// TEXT and BLOB columns. Then, in a conversation of its own, a scratch table of 20 MB loses nine rows in ten, and
// `databaseSize` must fall with it, without VACUUM, which Durable Objects refuse.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts), after `pnpm run deploy:test`:
// `MINERVA_PERF=1 pnpm test:faults test/account/retention-measure.test.ts`. MINERVA_RETENTION_OUT names a file for every
// turn's reading and the summary.

import { writeFileSync } from "node:fs";
import { MAX_HISTORY } from "@minerva/contract/internal";
import { afterAll, describe, expect, test } from "vitest";
import { delivered, finish, type HistoryMessage, LIST_INBOX, outcome, post, scratch, script, settled, storage, uuid7, world } from "./driver.ts";

const TURNS = 20;
const ANSWER_CHARS = 2_000;

type Reading = Awaited<ReturnType<typeof storage>>;

/** Each table's growth from `before` to `after`, rows and bytes, for the tables that changed. */
function growth(before: Reading, after: Reading): { [table: string]: { rows: number; bytes: number } } {
	const changed: { [table: string]: { rows: number; bytes: number } } = {};
	for (const [table, now] of Object.entries(after.tables)) {
		const then = before.tables[table] ?? { rows: 0, bytes: 0 };
		if (now.rows !== then.rows || now.bytes !== then.bytes) changed[table] = { rows: now.rows - then.rows, bytes: now.bytes - then.bytes };
	}
	return changed;
}

afterAll(finish, 300_000);

describe("retention measurement", () => {
	test(
		`each table's growth over ${TURNS} turns with their history`,
		async () => {
			const w = await world();
			const history: HistoryMessage[] = [];
			const readings: Reading[] = [await storage(w)];
			for (let turn = 1; turn <= TURNS; turn++) {
				const answer = `Answer ${turn}. ${"The notes in the inbox are listed above. ".repeat(60)}`.slice(0, ANSWER_CHARS);
				const prompt = script([LIST_INBOX, { text: answer }]);
				const message = uuid7();
				const runId = await post(w, prompt, [], { history: history.slice(-MAX_HISTORY), message });
				const view = await settled(w, runId, 120_000);
				expect(view.head?.status, outcome(view)).toBe("completed");
				expect(view.internals.attempts, outcome(view)).toHaveLength(1);
				await delivered(w, runId);
				const at = new Date().toISOString();
				history.push(
					{ id: message, role: "user", content: prompt, attachments: [], run: runId, createdAt: at, changes: null },
					{ id: uuid7(), role: "assistant", content: answer, attachments: [], run: runId, createdAt: at, changes: null },
				);
				readings.push(await storage(w));
			}
			const turns = readings.slice(1).map((reading, index) => ({
				turn: index + 1,
				historySent: Math.min(2 * index, MAX_HISTORY),
				databaseSize: reading.databaseSize,
				growth: growth(readings[index] as Reading, reading),
			}));
			const total = growth(readings[0] as Reading, readings.at(-1) as Reading);
			for (const { turn, historySent, databaseSize, growth: grew } of turns) {
				console.info(`turn ${turn} (history ${historySent}): databaseSize ${databaseSize}; ${JSON.stringify(grew)}`);
			}
			console.info(`over ${TURNS} turns: databaseSize ${readings[0]?.databaseSize} to ${readings.at(-1)?.databaseSize}; ${JSON.stringify(total)}`);

			const scratchWorld = await world();
			const empty = (await storage(scratchWorld)).databaseSize;
			const filled = (await scratch(scratchWorld, "fill")).databaseSize;
			const trimmed = (await scratch(scratchWorld, "trim")).databaseSize;
			const dropped = (await scratch(scratchWorld, "drop")).databaseSize;
			const pages = { empty, filled, trimmed, dropped };
			console.info(`scratch table of 20 MB: ${JSON.stringify(pages)}`);
			if (process.env.MINERVA_RETENTION_OUT) writeFileSync(process.env.MINERVA_RETENTION_OUT, `${JSON.stringify({ turns, total, readings, pages }, null, 2)}\n`);

			expect(filled - empty).toBeGreaterThan(20_000_000);
			expect(trimmed - empty, "nine rows in ten deleted give their pages back").toBeLessThan((filled - empty) / 5);
		},
		1_800_000,
	);
});
