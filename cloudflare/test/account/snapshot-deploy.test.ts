// Chunk 21's check across a deploy, by hand, in two steps around a `pnpm run deploy:test` with `container/` unchanged.
// `MINERVA_SNAPSHOT_ACROSS=take` leaves a conversation whose folder holds 200 MB retired with its snapshot (the Sandbox's
// `parkedMs` fault shortens the parked window to 15 s) and writes it to MINERVA_SNAPSHOT_WORLD. After the deploy,
// `MINERVA_SNAPSHOT_ACROSS=restore` runs its next turn, which must restore that snapshot with the file's hash unchanged
// and adds a small file, then waits for the container to retire again and prints both snapshots' sizes: a second one of
// twice the first would mean a restored container's snapshot keeps the archive it was restored from under the new one.
// MINERVA_PERF_OUT names a file for the sizes.
//
// Run only with MINERVA_PERF=1 (vitest.faults.config.ts):
// `MINERVA_PERF=1 MINERVA_SNAPSHOT_ACROSS=take MINERVA_SNAPSHOT_WORLD=<file> pnpm test:faults test/account/snapshot-deploy.test.ts`.

import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { commands, driver, finish, fired, outcome, post, purged, type RunView, script, settled, sh, sleep, type World, world } from "./driver.ts";

afterAll(finish, 300_000);

const STEP = process.env.MINERVA_SNAPSHOT_ACROSS;
const KEPT = process.env.MINERVA_SNAPSHOT_WORLD;

type Status = { state: string; snapshot: { versionId: string } | null };

async function sandbox(w: World): Promise<Status & { running: boolean }> {
	const answer = await driver<{ status: Status; running: boolean }>("conversation-sandbox", { scope: w.scope, conversationId: w.conversationId });
	return { ...answer.status, running: answer.running };
}

function parkedFor(w: World, parkedMs: number | null): Promise<unknown> {
	return driver("conversation-sandbox-faults", { scope: w.scope, conversationId: w.conversationId, faults: parkedMs === null ? {} : { parkedMs } });
}

/** Waits until the container retired with a snapshot of a version other than `before`; the version it holds. */
async function retired(w: World, before: string | null): Promise<string> {
	const started = Date.now();
	for (;;) {
		const status = await sandbox(w);
		if (status.state === "none" && !status.running && status.snapshot !== null && status.snapshot.versionId !== before) return status.snapshot.versionId;
		if (Date.now() - started > 300_000) throw new Error(`The container did not retire with a snapshot: ${JSON.stringify(status)}`);
		await sleep(1000);
	}
}

async function turn(w: World, command: string): Promise<string> {
	const view: RunView = await settled(w, await post(w, script([sh(command), { text: "Done." }])));
	expect(view.head?.status, outcome(view)).toBe("completed");
	return String(view.events.find((event) => event.type === "local_tool")?.data.excerpt);
}

test("a snapshot taken before a deploy that keeps the image is restored after it", { timeout: 900_000 }, async () => {
	expect(STEP === "take" || STEP === "restore", "MINERVA_SNAPSHOT_ACROSS names the step, take or restore").toBe(true);
	expect(KEPT, "MINERVA_SNAPSHOT_WORLD names the file that keeps the conversation between the steps").toBeTruthy();
	if (STEP === "take") {
		const w = await world({ faults: [{ point: "local:prepared", mode: "note", times: 10 }] });
		await parkedFor(w, 15_000);
		const sha = await turn(w, "head -c 209715200 /dev/urandom > big.bin && echo kept > note.txt && sha256sum big.bin");
		const versionId = await retired(w, null);
		writeFileSync(KEPT as string, `${JSON.stringify({ w, sha, versionId })}\n`);
		purged(w);
		return;
	}
	const { w, sha, versionId } = JSON.parse(readFileSync(KEPT as string, "utf8")) as { w: World; sha: string; versionId: string };
	expect((await sandbox(w)).snapshot?.versionId, "the snapshot's record survived the deploy").toBe(versionId);
	await parkedFor(w, 15_000);
	expect(await turn(w, "sha256sum big.bin && echo after > after.txt")).toBe(sha);
	const restored = (await fired(w)).filter((one) => one.point === "local:prepared").map((one) => (JSON.parse(one.detail) as { restored: unknown }).restored !== null);
	expect(restored, "the second cold start restored the snapshot").toEqual([false, true]);
	await retired(w, versionId);
	const { taken } = await driver<{ taken: { size: number; ms: number }[] }>("conversation-sandbox-snapshots", { scope: w.scope, conversationId: w.conversationId });
	console.info(`snapshots across a deploy: ${JSON.stringify(taken)}`);
	if (process.env.MINERVA_PERF_OUT) writeFileSync(process.env.MINERVA_PERF_OUT, `${JSON.stringify(taken, null, 2)}\n`);
	expect(taken).toHaveLength(2);
	expect(await commands.deleteConversation({ scope: w.scope, conversation: w.conversationId })).toEqual({ outcome: "deleted" });
});
