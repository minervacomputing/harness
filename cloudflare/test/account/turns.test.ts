// End-to-end turns on the test Worker minerva-cf-test (plan: Steps 3 and 4; Testing, Account tests), through
// the real Conversation Durable Object, its container, the Scripts Durable Object and the Workers' R2 store:
// the agent writes a file with Python through bash, runs a script (`run_script`) that calls the fake Notes
// connector's tool, and the conversation's folder version, published with the run, contains the file. One turn
// is scripted with the fake model; one is the same task given to Workers AI (@cf/zai-org/glm-5.3-flash),
// which may not call the tools: it asserts the protocol (the version, the file, the events in order), never
// the model's words, and is skipped with a message when the model does not call the tools after one retry.
//
// The two turns run at once, through the driver of driver.ts. Run with `pnpm test:faults` after
// `pnpm run deploy:test`. Timings are written to MINERVA_TURN_TIMINGS when set.

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { base, destroyed, driver, finish, type Head, LIST, type LocalCard, post, type RunEvent, type RunView, settled, type World, world } from "./driver.ts";

const timings: Record<string, unknown> = {};

function record(name: string, value: unknown): void {
	timings[name] = value;
	console.info(`${name}: ${JSON.stringify(value)}`);
	if (process.env.MINERVA_TURN_TIMINGS) writeFileSync(process.env.MINERVA_TURN_TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
}

afterAll(finish, 300_000);

/** The run's duration from its own timestamps, without the polling's. */
const runMs = (head: Head) => Date.parse(head.finishedAt) - Date.parse(head.createdAt);

/** What a turn must show, whoever produced it: the order of the run's events and the published folder. */
async function expectPublished(w: World, view: RunView, file: string) {
	const head = view.head as Head;
	expect(head.status).toBe("completed");
	const seqs = view.events.map((event) => event.seq);
	expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	expect(new Set(seqs).size).toBe(seqs.length);
	const local = view.events.filter((event) => event.type === "local_tool" && (event.data as unknown as LocalCard).tool === "bash");
	const scripted = view.events.filter((event) => event.type === "tool_call" && event.data.tool === LIST);
	const answer = view.events.filter((event) => event.type === "message");
	expect(local.length).toBeGreaterThan(0);
	expect(scripted).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ decision: "allowed", count: 2 }) }));
	// The answer comes after every card and every call, and a script ran before it.
	expect(answer.length).toBeGreaterThan(0);
	const last = Math.max(...[...local, ...scripted].map((event) => event.seq));
	expect(Math.max(...answer.map((event) => event.seq))).toBeGreaterThan(last);
	// The call was a script's: the phase of `run_script` comes before it.
	const phase = view.events.find((event) => event.type === "phase" && event.data.text === "Running a script");
	expect(phase).toBeDefined();
	expect(Math.max(...scripted.map((event) => event.seq))).toBeGreaterThan((phase as RunEvent).seq);
	expect(view.events.at(-1)).toMatchObject({ type: "status", data: { status: "completed" } });
	// The version was published with the run, and holds the file.
	expect(head.resultVersionId).toBeTruthy();
	expect(head.folderChanges?.added?.map((item) => item.path)).toContain(file);
	const folder = await driver<{ versionId: string; files: { path: string; size: number }[] }>("files", base(w));
	expect(folder.versionId).toBe(head.resultVersionId);
	expect(folder.files.map((item) => item.path)).toContain(file);
	const read = await driver<{ text: string | null }>("file", { ...base(w), path: file });
	expect(read.text).toMatch(/\S/);
	return { local, scripted, phase: phase as RunEvent, text: read.text as string };
}

const TASK = "Do these two steps with your tools, in this order. Step 1: with the bash tool, run python3 to write a file named report.txt in the current directory that contains the line 'written by python'. Step 2: with the run_script tool, run JavaScript that calls tools.notes_list_notes({ folder: 'inbox' }) and returns how many notes it listed. Then tell me the count and the file name.";

describe.concurrent("an end-to-end turn: Python through bash, a script calling a connector tool, the published folder", () => {
	test("with the fake model", async () => {
		const w = await world();
		const python = "python3 -c \"open('report.txt', 'w').write('written by python\\n')\" && cat report.txt";
		const code = "const r = await tools.notes_list_notes({ folder: 'inbox' }); console.log('listed', JSON.stringify(r)); return r";
		const posted = Date.now();
		const runId = await post(
			w,
			JSON.stringify({
				fake: {
					turns: [
						{ tools: [{ name: "bash", arguments: { command: python } }] },
						{ tools: [{ name: "run_script", arguments: { code } }] },
						{ text: "Wrote report.txt; the inbox has 2 notes." },
					],
				},
			}),
		);
		const postMs = Date.now() - posted;
		const view = await settled(w, runId);
		const out = await expectPublished(w, view, "report.txt");
		expect(out.text).toBe("written by python\n");
		expect(view.events.filter((event) => event.type === "local_tool").map((event) => event.data)).toEqual([
			{ tool: "bash", summary: expect.stringContaining("python3"), ok: true, excerpt: "written by python\n" },
		]);
		// The command's card comes before the script's phase and its call, as the model's turns do.
		expect((out.local[0] as RunEvent).seq).toBeLessThan(out.phase.seq);
		expect(out.phase.seq).toBeLessThan((out.scripted[0] as RunEvent).seq);
		const destroyMs = await destroyed(w);
		expect(view.internals.run).toMatchObject({ tool_calls: 1, model_calls: 3 });
		record("fake model turn", { postMs, runMs: runMs(view.head as Head), goneCheckMs: destroyMs, events: view.events.length });
	});

	test("with Workers AI (@cf/zai-org/glm-5.3-flash): the protocol, not the words", async (ctx) => {
		const attempts: { seconds: number; status: string | undefined; error: string | undefined; tools: string[] }[] = [];
		for (let attempt = 1; attempt <= 2; attempt++) {
			const w = await world({ model: "workers-ai" });
			const runId = await post(w, TASK);
			const view = await settled(w, runId, 150_000);
			// The model called the tools when a command that is Python writing report.txt succeeded, a script ran and the
			// connector's tool answered through it. Only that decides a retry or the skip; from then on everything is asserted.
			const bash = view.events.filter((event) => {
				const card = event.data as unknown as LocalCard;
				return event.type === "local_tool" && card.tool === "bash" && card.ok && /python/i.test(card.summary) && card.summary.includes("report.txt");
			});
			const listed = view.events.some((event) => event.type === "tool_call" && event.data.tool === LIST && event.data.decision === "allowed");
			const scripted = view.events.some((event) => event.type === "phase" && event.data.text === "Running a script");
			attempts.push({ seconds: view.seconds, status: view.head?.status, error: view.head?.errorMessage || undefined, tools: view.events.filter((event) => event.type === "local_tool" || event.type === "tool_call" || (event.type === "phase" && event.data.text === "Running a script")).map((event) => String(event.data.tool ?? event.data.text)) });
			// The model must have run a command, a script and the connector's tool through it; what it said does not matter.
			if (!bash.length || !listed || !scripted) continue;
			await expectPublished(w, view, "report.txt");
			const destroyMs = await destroyed(w);
			record("Workers AI turn", { attempt, runMs: runMs(view.head as Head), goneCheckMs: destroyMs, modelCalls: view.internals.run?.model_calls, tools: attempts.at(-1)?.tools });
			return;
		}
		record("Workers AI turn, tools not called", attempts);
		ctx.skip(`@cf/zai-org/glm-5.3-flash did not call bash and run_script in two attempts (${JSON.stringify(attempts)}); the protocol was not exercised.`);
	}, 480_000);
});
