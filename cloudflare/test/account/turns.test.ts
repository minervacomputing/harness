// End-to-end turns on the test Worker minerva-cf-test (plan: Steps 3 and 4; Testing, Account tests), through
// the real Conversation Durable Object, its container, the Scripts Durable Object and the Workers' R2 store:
// the agent writes a file with Python through bash, runs a script (`run_script`) that calls the fake Notes
// connector's tool, and the conversation's folder version, published with the run, contains the file. One turn
// is scripted with the fake model; one is the same task given to Workers AI (@cf/zai-org/glm-5.3-flash),
// which may not call the tools: it asserts the protocol (the version, the file, the events in order), never
// the model's words, and is skipped with a message when the model does not call the tools after one retry.
//
// Run with `pnpm test:faults` after `pnpm run deploy:test`. Timings are written to MINERVA_TURN_TIMINGS when set.

import { writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);
const USER = "0199a000-0000-7000-8000-0000000fa018";
const LIST = "notes_list_notes";
const timings: Record<string, unknown> = {};

function record(name: string, value: unknown): void {
	timings[name] = value;
	console.info(`${name}: ${JSON.stringify(value)}`);
	if (process.env.MINERVA_TURN_TIMINGS) writeFileSync(process.env.MINERVA_TURN_TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
}

interface RunEvent {
	seq: number;
	type: string;
	data: { [key: string]: unknown };
}

interface Head {
	id: string;
	status: string;
	errorMessage: string;
	eventSeq: number;
	createdAt: string;
	finishedAt: string;
	resultVersionId: string | null;
	folderChanges: { added?: { path: string; size: number }[] } | null;
	folderWarnings: { total: number; items: { path: string; reason: string }[] } | null;
}

interface RunView {
	head: Head | null;
	events: RunEvent[];
	internals: { run: { [column: string]: unknown } | null };
}

/** A UUIDv7 for a workspace of its own. */
function uuid7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const now = BigInt(Date.now());
	for (let i = 0; i < 6; i++) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function driver<T>(op: string, body: { [key: string]: unknown }): Promise<T> {
	const reply = await fetchDeployed(`${worker.origin}/api/faults/${op}`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60_000,
	});
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as T;
}

interface World {
	workspace: { id: string; jurisdiction: null };
	conversationId: string;
}

async function world(model: string | null): Promise<World> {
	const workspace = { id: uuid7(), jurisdiction: null };
	const base = { workspace, userId: USER };
	const { agentId } = await driver<{ agentId: string }>("setup", { ...base, expired: false, delays: {} });
	const { conversationId } = await driver<{ conversationId: string }>("conversation", { ...base, agentId, faults: [], model });
	return { workspace, conversationId };
}

const base = (w: World) => ({ workspace: w.workspace, userId: USER, conversationId: w.conversationId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(w: World, content: string): Promise<string> {
	const outcome = await driver<{ ok: boolean; value?: { run: { id: string } }; refusal?: { detail: string } }>("post", { ...base(w), content });
	if (!outcome.ok || !outcome.value) throw new Error(`Refused: ${outcome.refusal?.detail}`);
	return outcome.value.run.id;
}

/** Polls until the run has ended. A few failed polls in a row (a DNS or network blip) are tolerated; the last one is reported. */
async function settled(w: World, runId: string, timeoutMs = 300_000): Promise<RunView & { seconds: number }> {
	const started = Date.now();
	let failures = 0;
	let last: RunView | null = null;
	for (;;) {
		try {
			last = await driver<RunView>("run", { ...base(w), runId });
			failures = 0;
			if (last.head && !["queued", "provisioning", "running"].includes(last.head.status)) return { ...last, seconds: (Date.now() - started) / 1000 };
		} catch (error) {
			if (++failures > 3) throw error;
		}
		if (Date.now() - started > timeoutMs) throw new Error(`The run did not end; last: ${JSON.stringify(last?.head)}`);
		await sleep(1000);
	}
}

/** Waits until the conversation's container is gone (the run's end destroys it). */
async function destroyed(w: World, timeoutMs = 120_000): Promise<number> {
	const started = Date.now();
	for (;;) {
		const answer = await driver<{ status: { state: string }; running: boolean }>("conversation-sandbox", base(w));
		if (answer.status.state === "none" && !answer.running) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`The container was not destroyed: ${JSON.stringify(answer)}`);
		await sleep(1000);
	}
}

/** The run's duration from its own timestamps, without the polling's. */
const runMs = (head: Head) => Date.parse(head.finishedAt) - Date.parse(head.createdAt);

type LocalCard = { tool: string; summary: string; ok: boolean; excerpt: string };

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

describe("an end-to-end turn: Python through bash, a script calling a connector tool, the published folder", () => {
	test("with the fake model", async () => {
		const w = await world(null);
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
			const w = await world("workers-ai");
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
