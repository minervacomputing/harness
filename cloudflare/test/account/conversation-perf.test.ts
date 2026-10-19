// Chunk 19b's probe on the test instance, with its route set to staging's (`gpt-6.1-sol` on the Responses API, through the
// OpenAI key on the instance's AI Gateway): a 10-turn conversation in chunk 14a's rotation (a chat question, a Notes read, a
// script calling a connector tool, a file written in the folder), one turn after another with no pause, each start carrying
// the history Laravel would send (each earlier turn's message and answer, the newest MAX_HISTORY). Per turn: its first
// call's cached tokens, and the run's uncached input (input less cached, cache writes included), cache writes, output
// (reasoning included), summary calls and cost, computed from the tokens at models.dev's prices for `gpt-6.1-sol`, since
// routes record none, each input token at one rate.
//
// One round on `main` (a worktree at the last commit before runs shared a pi conversation, with this file copied in) and
// one on the head, each after a fresh `pnpm run deploy:test`; MINERVA_PERF_ROUND says which (`head` by default). Every
// turn checks the build from the run's pi session: on the head every run names the first run's, on `main` each its own. A
// mismatch fails the round, since another session deployed the instance. It uses only what the driver had on `main`.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts): `MINERVA_PERF=1 MINERVA_PERF_ROUND=head pnpm test:faults
// test/account/conversation-perf.test.ts`. MINERVA_PERF_OUT names a file for the samples and their summary.

import { writeFileSync } from "node:fs";
import { MAX_HISTORY } from "@minerva/contract/internal";
import { afterAll, describe, expect, test } from "vitest";
import { finish, type HistoryMessage, modelDeadline, outcome, post, type RunView, settled, uuid7, world } from "./driver.ts";

const TURNS = 10;
const ROUND = process.env.MINERVA_PERF_ROUND ?? "head";
if (ROUND !== "head" && ROUND !== "main") throw new Error("MINERVA_PERF_ROUND is head or main.");
/** $ per million tokens for `gpt-6.1-sol` at models.dev: uncached input, cached input, cache write, output. */
const PRICE = { uncached: 2, cached: 0.1, write: 2.5, output: 10 };
/** Turn `turn`'s message, in chunk 14a's rotation. */
function messageOf(turn: number): string {
	const rotation = [
		"In two sentences, how should I plan a busy week?",
		"Use the notes_list_notes tool to list the notes in the folder inbox, and tell me their titles.",
		"With the run_script tool, run JavaScript that calls tools.notes_list_notes({ folder: 'archive' }) and returns how many notes it listed. Tell me the count.",
		`With the write tool, write a file named plan-${turn}.txt in your folder with a three-line plan for tomorrow, then tell me it is done.`,
	];
	return rotation[(turn - 1) % rotation.length] as string;
}

type Call = RunView["internals"]["calls"][number];

const sum = (calls: Call[], read: (call: Call) => number | null) => calls.reduce((total, call) => total + (read(call) ?? 0), 0);
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

afterAll(finish, 300_000);

describe("conversation probe", () => {
	test(
		`${TURNS} turns on the instance's route, round ${ROUND}`,
		async () => {
			const w = await world({ model: "route" });
			const history: HistoryMessage[] = [];
			const sessions: unknown[] = [];
			const turns: { turn: number; firstCached: number; uncached: number; cacheWrite: number; output: number; summaries: number; calls: number; costUsd: number }[] = [];
			for (let turn = 1; turn <= TURNS; turn++) {
				const content = messageOf(turn);
				const message = uuid7();
				const view = await settled(w, await post(w, content, [], { history: history.slice(-MAX_HISTORY), message }), modelDeadline(6));
				expect(view.head?.status, outcome(view)).toBe("completed");
				const session = view.internals.run?.session;
				expect(session, `turn ${turn}'s pi session`).toEqual(expect.any(String));
				if (ROUND === "head") expect(sessions.every((earlier) => earlier === session), `turn ${turn} on the head names the first run's pi session`).toBe(true);
				else expect(sessions.includes(session), `turn ${turn} on main has a pi session of its own`).toBe(false);
				sessions.push(session);
				const calls = view.internals.calls;
				const input = sum(calls, (call) => call.input_tokens);
				const cached = sum(calls, (call) => call.cached_tokens);
				const cacheWrite = sum(calls, (call) => call.cache_write_tokens);
				const output = sum(calls, (call) => call.output_tokens);
				const costUsd = ((input - cached - cacheWrite) * PRICE.uncached + cached * PRICE.cached + cacheWrite * PRICE.write + output * PRICE.output) / 1e6;
				const sample = { turn, firstCached: calls[0]?.cached_tokens ?? 0, uncached: input - cached, cacheWrite, output, summaries: calls.filter((call) => call.summary).length, calls: calls.length, costUsd };
				turns.push(sample);
				console.info(`turn ${turn}: ${JSON.stringify(sample)}`);
				const answer = String(view.events.findLast((event) => event.type === "message")?.data.content ?? "");
				const at = Date.now();
				history.push(
					{ id: message, role: "user", content, attachments: [], run: view.head?.id ?? "", createdAt: new Date(at).toISOString(), changes: null },
					{ id: uuid7(), role: "assistant", content: answer, attachments: [], run: view.head?.id ?? "", createdAt: new Date(at + 1).toISOString(), changes: null },
				);
			}
			const fromThird = turns.slice(2);
			const result = {
				round: ROUND,
				turns,
				firstCallsCachedFromTurn3: fromThird.every((sample) => sample.firstCached > 0),
				meanUncached: mean(turns.map((sample) => sample.uncached)),
				meanUncachedFromTurn3: mean(fromThird.map((sample) => sample.uncached)),
				costUsd: turns.reduce((total, sample) => total + sample.costUsd, 0),
			};
			console.info(`conversation probe, round ${ROUND}: ${JSON.stringify({ ...result, turns: undefined })}`);
			if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(result, null, 2)}\n`);
		},
		1_800_000,
	);
});
