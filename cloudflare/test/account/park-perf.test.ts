// Chunk 20's probe on the test instance: how long the second of two turns waits for its sandbox. The first turn writes a
// folder of 500 files and 50 MiB with Python, then a note; the second, a few seconds later, reads the note with the fake
// model. The wait is from the start of the second turn's first model call (the fake's, which answers with the read at
// once) to the start of its second (the read's result), on the object's clock: the container's preparation and one read. On `main` that is a start, the
// hardening, the verification and a hydration of 50 MiB; with parking, an acquire and its verification.
//
// One round on `main` (a worktree at the last commit before parking, with this file copied in) and one on the head, each
// after a fresh `pnpm run deploy:test`. It uses only what the driver had on `main`.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts): `MINERVA_PERF=1 pnpm test:faults test/account/park-perf.test.ts`.
// MINERVA_PERF_OUT names a file for the numbers.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { cards, finish, local, outcome, post, script, settled, sh, sleep, world } from "./driver.ts";

const FILES = 500;
const FILE_BYTES = Math.floor((50 * 1024 * 1024) / FILES);

afterAll(finish, 300_000);

describe("park probe", () => {
	test("the second turn's wait for its sandbox, with a folder of 500 files and 50 MiB", async () => {
		const w = await world();
		const write = `python3 -c "import os; [open(f'f{i:03}.bin', 'wb').write(os.urandom(${FILE_BYTES})) for i in range(${FILES})]; open('note.txt', 'w').write('parked\\n')" && ls | wc -l`;
		const first = await settled(w, await post(w, script([sh(write), { text: "Wrote the files." }])));
		expect(first.head?.status, outcome(first)).toBe("completed");
		expect(cards(first.events), "the files were written").toEqual([expect.objectContaining({ tool: "bash", ok: true, excerpt: `${FILES + 1}\n` })]);
		await sleep(5_000);
		const second = await settled(w, await post(w, script([local("read", { path: "note.txt" }), { text: "Read the note." }])));
		expect(second.head?.status, outcome(second)).toBe("completed");
		expect(cards(second.events), "the note was read").toEqual([expect.objectContaining({ tool: "read", ok: true })]);
		const [read, after] = second.internals.marks;
		expect(read && after, JSON.stringify(second.internals.marks)).toBeTruthy();
		const waitMs = (after?.begin ?? 0) - (read?.begin ?? 0);
		const result = { waitMs, firstRunMs: Date.parse(first.head?.finishedAt ?? "") - Date.parse(first.head?.createdAt ?? ""), secondRunMs: Date.parse(second.head?.finishedAt ?? "") - Date.parse(second.head?.createdAt ?? ""), marks: second.internals.marks };
		console.info(`park probe: ${JSON.stringify(result)}`);
		if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(result, null, 2)}\n`);
	});
});
