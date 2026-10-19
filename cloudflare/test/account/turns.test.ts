// End-to-end turns on the test instance (ARCHITECTURE.md: Testing, Account tests), through
// the real Conversation Durable Object, its container, the Scripts Durable Object and the Workers' R2 store:
// the agent writes a file with Python through bash, runs a script (`run_script`) that calls the fake Notes
// connector's tool, and the conversation's folder version, published with the run, contains the file; the fake
// Laravel the run leased from gets the run's facts, ending with `run.finished`. One turn is scripted with the fake
// model; one is the same task given to Workers AI (@cf/zai-org/glm-5.3-flash): it asserts the protocol (the version,
// the file, the events in order, the facts), never the model's words, and fails with what each attempt called when the
// model has not called the tools in two attempts.
//
// The two turns run at once, started by Laravel's commands through the driver of driver.ts. Run with
// `pnpm test:faults` after `pnpm run deploy:test`. Timings are written to MINERVA_TURN_TIMINGS when set.
//
// Then one pi conversation per conversation: twelve turns with the fake model, the twelfth recalling the first after
// Laravel's history dropped it, and a connection removed between two runs, whose second still has the first's call in
// its history, on Workers AI and, with MINERVA_LIVE_ROUTE=1, on the instance's own route (staging's `gpt-6.1-sol`, through
// the OpenAI key on the instance's AI Gateway).

import { writeFileSync } from "node:fs";
import { MAX_HISTORY } from "@minerva/contract/internal";
import { afterAll, describe, expect, test } from "vitest";
import {
	delivered,
	destroyed,
	file,
	finish,
	finished,
	folder,
	type Head,
	type HistoryMessage,
	LIST,
	type LocalCard,
	modelDeadline,
	NO_CONNECTIONS,
	outcome,
	post,
	type RunEvent,
	type RunView,
	settled,
	toolCalls,
	uuid7,
	type World,
	world,
} from "./driver.ts";

const timings: Record<string, unknown> = {};

function record(name: string, value: unknown): void {
	timings[name] = value;
	console.info(`${name}: ${JSON.stringify(value)}`);
	if (process.env.MINERVA_TURN_TIMINGS) writeFileSync(process.env.MINERVA_TURN_TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
}

afterAll(finish, 300_000);

/** The run's duration from its own timestamps, without the polling's. */
const runMs = (head: Head) => Date.parse(head.finishedAt) - Date.parse(head.createdAt);

/** What a turn must show, whoever produced it: the order of the run's events, the published folder and the facts Laravel got. */
async function expectPublished(w: World, view: RunView, path: string) {
	const head = view.head as Head;
	expect(head.status, outcome(view)).toBe("completed");
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
	expect(head.folderChanges?.added?.map((item) => item.path)).toContain(path);
	const published = await folder(w);
	expect(published.versionId).toBe(head.resultVersionId);
	expect(published.files.map((item) => item.path)).toContain(path);
	const read = await file(w, path);
	expect(read.text).toMatch(/\S/);
	// Laravel got the turn: the run's end, followed only by its accounting, names the version and the answer.
	const facts = await delivered(w, head.id);
	expect(await finished(w, head.id)).toMatchObject({ run: head.id, type: "run.finished", data: { status: "completed", error: "", message: { content: answer.at(-1)?.data.content }, folder: { result: head.resultVersionId } } });
	const calls = view.events.filter((event) => event.type === "tool_call");
	expect(facts.filter((fact) => fact.type === "run.tool_call").map((fact) => fact.data)).toEqual(calls.map((event) => expect.objectContaining({ tool: event.data.tool, decision: event.data.decision })));
	return { local, scripted, phase: phase as RunEvent, text: read.text as string };
}

/** The task takes three model calls; a model that checks its work makes a fourth. */
const DEADLINE = modelDeadline(4);

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

	test("with Workers AI (@cf/zai-org/glm-5.3-flash): the protocol, not the words", async () => {
		const attempts: { seconds: number; status: string | undefined; error: string | undefined; tools: string[] }[] = [];
		for (let attempt = 1; attempt <= 2; attempt++) {
			const w = await world({ model: "workers-ai" });
			const runId = await post(w, TASK);
			const view = await settled(w, runId, DEADLINE);
			// The model called the tools when a command that is Python writing report.txt succeeded, a script ran and the
			// connector's tool answered through it. Only that decides a retry or the failure; from then on everything is asserted.
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
		throw new Error(`@cf/zai-org/glm-5.3-flash did not call bash and run_script in two attempts, so the protocol was not exercised; each attempt called: ${JSON.stringify(attempts)}`);
	}, 2 * DEADLINE + 120_000);
});

/** The run's answer: its last `message` event's text. */
const answerOf = (view: RunView) => String(view.events.findLast((event) => event.type === "message")?.data.content ?? "");

/** The model calls one turn of a real model may make, and the turns a revocation's test needs. */
const LIVE = modelDeadline(4);

/**
 * Run A of a conversation on `model` lists the inbox with the Notes tool; then the connection is removed, so Laravel's next
 * start names none, and run B, a question about it, completes in the same pi conversation with A's call in its history.
 * A model that did not call the tool in two tries fails with what each try called.
 */
async function revokedBetweenRuns(model: string): Promise<void> {
	const tries: { status: string | undefined; tools: unknown[] }[] = [];
	for (let attempt = 1; attempt <= 2; attempt++) {
		const w = await world({ model });
		const a = await settled(w, await post(w, "Use the notes_list_notes tool to list the notes in the folder inbox, then tell me how many there are."), LIVE);
		tries.push({ status: a.head?.status, tools: toolCalls(a.events).map((call) => call.tool) });
		if (a.head?.status !== "completed" || !toolCalls(a.events).some((call) => call.tool === LIST && call.decision === "allowed")) continue;
		const b = await settled(w, await post(w, "Thanks. In one sentence, what did you just look up?", [], { authority: NO_CONNECTIONS }), LIVE);
		expect(b.head?.status, outcome(b)).toBe("completed");
		expect(answerOf(b)).toMatch(/\S/);
		expect(b.internals.tools).toEqual([]);
		expect(b.internals.run?.session).toBe(a.internals.run?.session);
		return;
	}
	throw new Error(`The model (${model}) did not list the inbox with the Notes tool in two tries, so the revocation was not exercised; each try: ${JSON.stringify(tries)}`);
}

describe.concurrent("one pi conversation per conversation", () => {
	test("twelve turns with the fake model: the twelfth recalls what the first said after Laravel's history dropped it", async () => {
		const w = await world();
		const history: HistoryMessage[] = [];
		const sessions: unknown[] = [];
		let last = "";
		for (let turn = 1; turn <= 12; turn++) {
			const content = turn === 1 ? "Remember the code word HERON-42." : turn === 12 ? JSON.stringify({ fake: { turns: [{ recall: "code word" }] } }) : `Turn ${turn}.`;
			const message = uuid7();
			const runId = await post(w, content, [], { history: history.slice(-MAX_HISTORY), message });
			const view = await settled(w, runId, 120_000);
			expect(view.head?.status, outcome(view)).toBe("completed");
			last = answerOf(view);
			const at = Date.now();
			history.push(
				{ id: message, role: "user", content, attachments: [], run: runId, createdAt: new Date(at).toISOString(), changes: null },
				{ id: uuid7(), role: "assistant", content: last, attachments: [], run: runId, createdAt: new Date(at + 1).toISOString(), changes: null },
			);
			sessions.push(view.internals.run?.session);
		}
		expect(JSON.stringify(history.slice(-MAX_HISTORY - 2, -2))).not.toContain("HERON-42");
		expect(last).toBe("Remember the code word HERON-42.");
		expect(new Set(sessions).size).toBe(1);
	});

	test("a connection removed between two runs on Workers AI: the second completes with the first's call in its history", () => revokedBetweenRuns("workers-ai"), 4 * LIVE + 120_000);

	test(
		"the same on the instance's route",
		async ({ skip }) => {
			skip(process.env.MINERVA_LIVE_ROUTE !== "1", "the route's row needs MINERVA_LIVE_ROUTE=1 and the instance's route set to staging's model");
			await revokedBetweenRuns("route");
		},
		4 * LIVE + 120_000,
	);
});
