// Chunk 21's probe on the test instance: how long a cold start after the parking window waits for its sandbox when it
// restores the conversation's snapshot. The first turn writes the folder with Python, one file of 200 MB or 500 files of
// 50 MiB in all, and a note; its container parks for 15 s (the Sandbox's `parkedMs` fault) and retires with a snapshot.
// The second turn reads the note with the fake model. The wait is from the start of its first model call to the start
// of its second, on the object's clock, as chunk 20's probe (park-perf.test.ts) measures it: the restore, the hardening,
// the verification, the seed, the check and one read. The `local:prepared` note's detail splits it into those steps.
// Each retire's time is polled once a second, from parked to retiring to gone, and its snapshot's size and call time
// come from the test build's Sandbox.
//
// Three samples of each folder, one after another. The baselines are `main`'s cold starts: chunk 20's probe on `main`
// (21.4 s for 500 files of 50 MiB) and the spike's (32.7 to 34.9 s for 200 MB, docs/plans/sandbox-snapshots.md).
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts): `MINERVA_PERF=1 pnpm test:faults test/account/snapshot-perf.test.ts`.
// MINERVA_PERF_OUT names a file for the numbers.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { cards, commands, driver, finish, fired, local, outcome, post, purged, script, settled, sh, sleep, type World, world } from "./driver.ts";

const SAMPLES = 3;
const FOLDERS = [
	{ name: "one file of 200 MB", files: 1, bytes: 200 * 1024 * 1024 },
	{ name: "500 files of 50 MiB", files: 500, bytes: 50 * 1024 * 1024 },
];
const results: { [folder: string]: unknown[] } = {};

afterAll(async () => {
	if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(results, null, 2)}\n`);
	await finish();
}, 300_000);

type Status = { state: string; snapshot: { versionId: string } | null };

async function sandbox(w: World): Promise<Status & { running: boolean }> {
	const answer = await driver<{ status: Status; running: boolean }>("conversation-sandbox", { scope: w.scope, conversationId: w.conversationId });
	return { ...answer.status, running: answer.running };
}

/** When the container left `parked` and when it was gone with its snapshot recorded, polled once a second. */
async function retire(w: World): Promise<{ retiringAt: number; goneAt: number }> {
	let retiringAt = 0;
	const started = Date.now();
	for (;;) {
		const status = await sandbox(w);
		if (status.state === "retiring" && retiringAt === 0) retiringAt = Date.now();
		if (status.state === "none" && !status.running) {
			expect(status.snapshot, "the retire took a snapshot").not.toBeNull();
			return { retiringAt, goneAt: Date.now() };
		}
		if (Date.now() - started > 300_000) throw new Error(`The container did not retire: ${JSON.stringify(status)}`);
		await sleep(1000);
	}
}

describe("snapshot probe", () => {
	for (const folder of FOLDERS) {
		for (let sample = 1; sample <= SAMPLES; sample++) {
			test(`a restore's wait for its sandbox, ${folder.name}, sample ${sample}`, { timeout: 900_000 }, async () => {
				const w = await world({ faults: [{ point: "local:prepared", mode: "note", times: 10 }] });
				await driver("conversation-sandbox-faults", { scope: w.scope, conversationId: w.conversationId, faults: { parkedMs: 15_000 } });
				const each = Math.floor(folder.bytes / folder.files);
				const write = `python3 -c "import os; [open(f'f{i:03}.bin', 'wb').write(os.urandom(${each})) for i in range(${folder.files})]; open('note.txt', 'w').write('restored\\n')" && ls | wc -l`;
				const first = await settled(w, await post(w, script([sh(write), { text: "Wrote the files." }])));
				expect(first.head?.status, outcome(first)).toBe("completed");
				const parkedAt = Date.now();
				const { retiringAt, goneAt } = await retire(w);
				const second = await settled(w, await post(w, script([local("read", { path: "note.txt" }), { text: "Read the note." }])));
				expect(second.head?.status, outcome(second)).toBe("completed");
				expect(cards(second.events), "the note was read").toEqual([expect.objectContaining({ tool: "read", ok: true })]);
				const [read, after] = second.internals.marks;
				const preparations = (await fired(w)).filter((one) => one.point === "local:prepared").map((one) => JSON.parse(one.detail) as { restored: unknown });
				expect(preparations[1]?.restored, "the second turn restored the snapshot").not.toBeNull();
				const { taken } = await driver<{ taken: { size: number; ms: number }[] }>("conversation-sandbox-snapshots", { scope: w.scope, conversationId: w.conversationId });
				const result = {
					waitMs: (after?.begin ?? 0) - (read?.begin ?? 0),
					preparation: preparations[1],
					retire: { parkedToRetiringMs: retiringAt - parkedAt, retiringToGoneMs: goneAt - retiringAt },
					snapshot: taken[0],
				};
				console.info(`snapshot probe, ${folder.name}: ${JSON.stringify(result)}`);
				(results[folder.name] ??= []).push(result);
				expect(await commands.deleteConversation({ scope: w.scope, conversation: w.conversationId })).toEqual({ outcome: "deleted" });
				purged(w);
			});
		}
	}
});
