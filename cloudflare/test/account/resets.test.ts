// Memory-limit resets on the account (plan: Testing): faults that allocate until the isolate passes its memory
// limit and is reset, which local workerd cannot do, through the test instance's driver
// (driver.ts). A reset takes every object of its isolate with it, so these run one at a time, and only after
// every other file of `pnpm test:faults` has finished (vitest.faults.config.ts):
//
// - in a tool: the run recovers in a new attempt;
// - during a checkpoint: the next attempt starts from the last checkpoint, in a new container;
// - right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited;
// - repeated in a tool until the cap, and nothing runs after it. Last, so no later reset could cut short
//   what would run after it in the 45 s it is watched.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`; never against production.

import { afterAll, describe, expect, test } from "vitest";
import { cards, finish, LIST, LIST_INBOX, later, post, provider, reads, restarts, script, settled, sh, world } from "./driver.ts";

afterAll(finish, 300_000);

describe("memory-limit resets", () => {
	test("in a tool: the isolate is reset, and the run recovers in a new attempt", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "oom", tool: LIST }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Recovered." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(reads(await provider(w))).toBe(2);
		console.info(`memory reset: ${view.seconds} s`);
	});

	test("during a checkpoint: the next attempt starts from the last checkpoint, in a new container", async () => {
		const w = await world({ faults: [{ point: "checkpoint:scanned", mode: "oom" }] });
		const view = await settled(w, await post(w, script([sh("echo a > a.txt"), sh("cat a.txt"), { text: "Done." }])));
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		// The reset came before the checkpoint was recorded: attempt 2's container starts without the file.
		expect(cards(view.events).find((card) => card.summary === "cat a.txt")?.ok).toBe(false);
		console.info(`memory reset during a checkpoint: ${view.seconds} s`);
	});

	test("right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited", async () => {
		// The isolate's memory goes with each reset, so this fault fires after every decision; only the gate's
		// sync makes the attempts advance (gate review, major).
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "oom", unsynced: true, times: 6 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(1);
		console.info(`gate memory reset: ${view.seconds} s`);
	});

	test("repeated in a tool: the third attempt's reset ends the run as worker_exited", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "oom", tool: LIST, times: 5 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(3);
		later("repeated memory resets", async () => expect(reads(await provider(w))).toBe(3));
		console.info(`repeated memory resets: ${view.seconds} s`);
	});

});
