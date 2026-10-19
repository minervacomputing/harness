// Snapshots on the test instance (ARCHITECTURE.md: The sandbox lifecycle), with the fake model and the real container. A
// parked container whose folder holds 300 files or 20 MB retires at its idle deadline, shortened here to 15 s by the
// Sandbox's `parkedMs` fault: its folder is archived onto its root disk and the container is snapshotted, and the next
// cold start for that version restores the snapshot and seeds the folder from the archive. `local:prepared` notes say
// which: their detail is the attempt's preparation, whose `restored` is set for a restore. A smaller folder retires with
// no snapshot. A restore whose seed leaves a stray file, a start during the retire and a deletion before or during it
// each leave no snapshot to restore, and the turn succeeds from R2.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`.

import { afterAll, describe, expect, test } from "vitest";
import { commands, driver, type Fault, finish, fired, outcome, post, purged, type RunView, script, settled, sh, sleep, type World, world } from "./driver.ts";

afterAll(finish, 300_000);

const NOTE: Fault[] = [
	{ point: "local:prepared", mode: "note", times: 10 },
	{ point: "local:acquired", mode: "note", times: 10 },
];
const PARKED_MS = 15_000;
/** Past the retire's 300 files, so the folder is snapshotted, though it holds little. */
const LARGE = `python3 -c "[open(f'f{i:03}.txt', 'w').write(f'file {i}\\n') for i in range(310)]" && ls | wc -l`;

type Status = { state: string; snapshot: { versionId: string; takenAt: number } | null };

async function sandbox(w: World): Promise<Status & { running: boolean }> {
	const answer = await driver<{ status: Status; running: boolean }>("conversation-sandbox", { scope: w.scope, conversationId: w.conversationId });
	return { state: answer.status.state, snapshot: answer.status.snapshot, running: answer.running };
}

function sandboxFaults(w: World, faults: { parkedMs?: number; straySeed?: boolean }): Promise<unknown> {
	return driver("conversation-sandbox-faults", { scope: w.scope, conversationId: w.conversationId, faults });
}

function root(w: World, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return driver("conversation-sandbox-root", { scope: w.scope, conversationId: w.conversationId, script });
}

async function until(w: World, done: (status: Status & { running: boolean }) => boolean, what: string, timeoutMs = 240_000, everyMs = 1000): Promise<Status & { running: boolean }> {
	const started = Date.now();
	for (;;) {
		const status = await sandbox(w);
		if (done(status)) return status;
		if (Date.now() - started > timeoutMs) throw new Error(`The sandbox is not ${what}: ${JSON.stringify(status)}`);
		await sleep(everyMs);
	}
}

/** Waits until the parked container retired with a snapshot of a version other than `before`; the version it holds. */
async function retired(w: World, before: string | null = null): Promise<string> {
	const status = await until(w, (s) => s.state === "none" && !s.running && s.snapshot !== null && s.snapshot.versionId !== before, "retired with a snapshot");
	return status.snapshot?.versionId as string;
}

async function turn(w: World, ...turns: Parameters<typeof script>[0]): Promise<RunView> {
	const view = await settled(w, await post(w, script(turns)));
	expect(view.head?.status, outcome(view)).toBe("completed");
	return view;
}

function excerpt(view: RunView): string {
	return String(view.events.find((event) => event.type === "local_tool")?.data.excerpt);
}

/** Each cold start's preparation, in order: whether it was restored from the snapshot. */
async function starts(w: World): Promise<boolean[]> {
	return (await fired(w)).filter((one) => one.point === "local:prepared").map((one) => (JSON.parse(one.detail) as { restored: unknown }).restored !== null);
}

async function deleted(w: World): Promise<void> {
	expect(await commands.deleteConversation({ scope: w.scope, conversation: w.conversationId })).toEqual({ outcome: "deleted" });
	purged(w);
}

describe.concurrent("restoring a cold sandbox from its conversation's snapshot", () => {
	test("files deleted, overwritten and truncated over three turns and two restores are gone from the restored folder and its archive", { timeout: 900_000 }, async () => {
		const w = await world({ faults: NOTE });
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		const image = await driver<{ image: string }>("conversation-sandbox-snapshots", { scope: w.scope, conversationId: w.conversationId });
		expect(image.image, "the start's image is the deploy's, pinned to its digest").toMatch(/minerva-sandbox:[0-9a-f]{24}@sha256:[0-9a-f]{64}$/);
		const write = `echo GONE-MARKER > gone.txt && echo OLD-MARKER > over.txt && python3 -c "open('trunc.txt', 'w').write('TRUNC-MARKER' * 1000)" && ${LARGE}`;
		expect(excerpt(await turn(w, sh(write), { text: "Wrote them." }))).toBe("313\n");
		const first = await retired(w);
		const second = await turn(w, sh("cat over.txt && rm gone.txt && echo NEW > over.txt && : > trunc.txt && ls | wc -l"), { text: "Changed them." });
		expect(excerpt(second)).toBe("OLD-MARKER\n312\n");
		await retired(w, first);
		await sandboxFaults(w, {});
		const third = await turn(w, sh("ls gone.txt 2>&1; cat over.txt; wc -c < trunc.txt; cat f309.txt; ls | wc -l; ls /var/lib/minerva 2>&1; true"), { text: "Read them." });
		expect(excerpt(third)).toBe("ls: cannot access 'gone.txt': No such file or directory\nNEW\n0\nfile 309\n312\nls: cannot open directory '/var/lib/minerva': Permission denied\n");
		expect(await starts(w)).toEqual([false, true, true]);
		const archive = await root(w, "tar -tvf /var/lib/minerva/folder.tar | wc -l; grep -c -a -e GONE-MARKER -e OLD-MARKER -e TRUNC-MARKER /var/lib/minerva/folder.tar || true; stat -c '%a %U' /var/lib/minerva /var/lib/minerva/folder.tar");
		expect(archive.stdout, "the archive holds the second turn's folder and the directory, as root's only").toBe("313\n0\n700 root\n600 root\n");
		await deleted(w);
		expect(await sandbox(w)).toEqual({ state: "none", snapshot: null, running: false });
	});

	test("a folder under both thresholds retires with no snapshot, and the next turn hydrates it from R2", async () => {
		const w = await world({ faults: NOTE });
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		await turn(w, sh("echo small > small.txt"), { text: "Wrote it." });
		await until(w, (s) => s.state === "parked", "parked", 60_000);
		await until(w, (s) => s.state === "none" && !s.running, "retired", 120_000);
		expect((await sandbox(w)).snapshot).toBeNull();
		expect(excerpt(await turn(w, sh("cat small.txt"), { text: "Read it." }))).toBe("small\n");
		expect(await starts(w)).toEqual([false, false]);
		await deleted(w);
	});

	test("a restore whose seed leaves a stray file falls back to the image and R2 within the turn, and the snapshot is dropped", async () => {
		const w = await world({ faults: NOTE });
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		await turn(w, sh(LARGE), { text: "Wrote them." });
		await retired(w);
		await sandboxFaults(w, { straySeed: true });
		expect(excerpt(await turn(w, sh("ls | wc -l; ls stray.txt 2>&1; true"), { text: "Listed them." }))).toBe("310\nls: cannot access 'stray.txt': No such file or directory\n");
		expect(await starts(w)).toEqual([false, false]);
		expect((await sandbox(w)).snapshot).toBeNull();
		await deleted(w);
	});

	test("a start during the retire destroys the retiring container, the turn succeeds from R2, and the retire records nothing", async () => {
		const w = await world({ faults: NOTE });
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		await turn(w, sh(LARGE), { text: "Wrote them." });
		await sandboxFaults(w, {});
		await until(w, (s) => s.state === "retiring", "retiring", 120_000, 250);
		expect(excerpt(await turn(w, sh("cat f000.txt; ls | wc -l"), { text: "Read them." }))).toBe("file 0\n310\n");
		expect(await starts(w)).toEqual([false, false]);
		expect((await fired(w)).filter((one) => one.point === "local:acquired")).toEqual([]);
		await sleep(60_000);
		expect((await sandbox(w)).snapshot, "the interrupted retire's snapshot was not recorded").toBeNull();
		await deleted(w);
	});

	test("deleting the conversation after its snapshot leaves no record", async () => {
		const w = await world();
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		await turn(w, sh(LARGE), { text: "Wrote them." });
		await retired(w);
		await deleted(w);
		expect(await sandbox(w)).toEqual({ state: "none", snapshot: null, running: false });
	});

	test("deleting the conversation during its retire destroys the container and records nothing", async () => {
		const w = await world();
		await sandboxFaults(w, { parkedMs: PARKED_MS });
		await turn(w, sh(LARGE), { text: "Wrote them." });
		await until(w, (s) => s.state === "retiring", "retiring", 120_000, 250);
		await deleted(w);
		await until(w, (s) => s.state === "none" && !s.running, "destroyed", 120_000);
		await sleep(60_000);
		expect(await sandbox(w)).toEqual({ state: "none", snapshot: null, running: false });
	});
});
