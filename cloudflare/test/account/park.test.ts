// Parking on the test instance (ARCHITECTURE.md: The sandbox lifecycle), with the fake model and the real container. A
// turn's container is parked after its last checkpoint, and the conversation's next turn takes it with no start: a
// `note` fault on `local:prepared` (a start) and one on `local:acquired` count each. Parking removes what a checkpoint never
// keeps, so a symbolic link and a FIFO the first turn made are gone in the second. A turn that only answers, in a
// conversation with an empty folder, starts no container (its `run.settled` counts none), and the next turn that asks for
// a file still gets it. Deleting the conversation destroys its parked container. An object restarted before the final
// checkpoint, or between it and the park, leaves the container `in_use` for its run, whose end destroys it.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`.

import { afterAll, describe, expect, test } from "vitest";
import { commands, delivered, destroyed, driver, type Fault, file, finish, fired, folder, outcome, post, purged, type RunView, script, settled, sh, sleep, type World, world } from "./driver.ts";

afterAll(finish, 300_000);

async function sandbox(w: World): Promise<{ state: string; running: boolean }> {
	const answer = await driver<{ status: { state: string }; running: boolean }>("conversation-sandbox", { scope: w.scope, conversationId: w.conversationId });
	return { state: answer.status.state, running: answer.running };
}

async function turn(w: World, ...turns: Parameters<typeof script>[0]): Promise<RunView> {
	const view = await settled(w, await post(w, script(turns)));
	expect(view.head?.status, outcome(view)).toBe("completed");
	return view;
}

async function containers(w: World, view: RunView): Promise<number> {
	const runId = view.head?.id as string;
	const facts = await delivered(w, runId);
	return (facts.find((fact) => fact.run === runId && fact.type === "run.settled")?.data as { containers: number }).containers;
}

const COUNT: Fault[] = [
	{ point: "local:prepared", mode: "note", times: 10 },
	{ point: "local:acquired", mode: "note", times: 10 },
];

describe.concurrent("parking a conversation's container between turns", () => {
	test("the second of two turns a minute apart takes the parked container, without the link and FIFO the first made", async () => {
		const w = await world({ faults: COUNT });
		await turn(w, sh("echo kept > kept.txt && ln -s kept.txt link.txt && mkfifo pipe && echo left > /tmp/left.txt && ls"), { text: "Made them." });
		expect(await sandbox(w)).toEqual({ state: "parked", running: true });
		await sleep(60_000);
		const second = await turn(w, sh("ls -A /workspace; ls -A /tmp"), { text: "Listed it." });
		const listing = String(second.events.find((event) => event.type === "local_tool")?.data.excerpt);
		expect(listing.split("\n").filter(Boolean).sort()).toEqual(["home", "kept.txt", "matplotlib"]);
		const points = (await fired(w)).map((one) => one.point);
		expect(points.filter((point) => point === "local:prepared")).toHaveLength(1);
		expect(points.filter((point) => point === "local:acquired")).toHaveLength(1);
		expect(await sandbox(w)).toEqual({ state: "parked", running: true });
		expect(await containers(w, second)).toBe(1);
	});

	test("a turn that only answers, on an empty folder, starts no container; the next one that asks for a file gets it", async () => {
		const w = await world({ faults: COUNT });
		const chat = await turn(w, { text: "Hello." });
		expect(await containers(w, chat)).toBe(0);
		expect(await sandbox(w)).toEqual({ state: "none", running: false });
		const made = await turn(w, sh("echo made > made.txt"), { text: "Made it." });
		expect(await containers(w, made)).toBe(1);
		expect((await folder(w)).files.map((item) => item.path)).toEqual(["made.txt"]);
		expect((await file(w, "made.txt")).text).toBe("made\n");
		expect((await fired(w)).map((one) => one.point).filter((point) => point === "local:prepared")).toHaveLength(1);
	});

	test("deleting the conversation destroys its parked container", async () => {
		const w = await world();
		await turn(w, sh("echo x > x.txt"), { text: "Done." });
		expect(await sandbox(w)).toEqual({ state: "parked", running: true });
		expect(await commands.deleteConversation({ scope: w.scope, conversation: w.conversationId })).toEqual({ outcome: "deleted" });
		purged(w);
		expect(await sandbox(w)).toEqual({ state: "none", running: false });
	});

	for (const point of ["local:finishing", "local:parking"]) {
		test(`an object restarted at ${point} destroys the container, and the turn completes with its file`, async () => {
			const w = await world({ faults: [{ point, mode: "abort" }] });
			await turn(w, sh("echo saved > saved.txt"), { text: "Saved." });
			expect((await fired(w)).map((one) => one.point)).toContain(point);
			await destroyed(w);
			expect((await file(w, "saved.txt")).text).toBe("saved\n");
		});
	}
});
