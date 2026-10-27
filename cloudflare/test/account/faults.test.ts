// Fault tests on the account, for what only the platform shows (ARCHITECTURE.md: Testing): the test
// instance, built from the same code with the fake Notes connector, its provider object, fault points and a
// token-gated driver (src/faults/, driver.ts), with the runs started and cancelled by Laravel's commands and
// leased from the fake Laravel, which must get the end of each run a crash interrupted. Each test makes its own
// workspace and conversation, in the EU as Laravel's are, and they all run at once. One row per mechanism the platform could change; the cases of the
// executor's and the ledger's logic around them run in local workerd (test/platform/protocols.test.ts):
//
// - ctx.abort() in a safe tool (the read runs again) and in an unsafe tool (the write is never replayed);
// - the cap at 3 attempts, and nothing runs after it;
// - a crash right after the attempt gate, every time and with nothing synced: the gate's own sync still
//   advances the attempts to the cap;
// - a long tool across PiHarness's heartbeats, which is no restart (a run the platform itself restarted is run once more);
// - a revocation during a run: Laravel's cancel, answered once the run has stopped;
// - a crash while a write is dispatched, after the provider applied it;
// - a crash mid-stream: every counted model call settles once, and run.settled sums them, their charges and the container's time;
// - a run's budget: the first model call after its spend reached its allowance ends it, failed with budget_reached;
// - one smoke run with Workers AI and the fake connector's tool;
// - a turn under a user layer that asks before creating notes: attended, its two saves are held, Laravel gets both
//   `run.held_call` facts whole and the provider no note; unattended, the save answers APPROVAL_UNAVAILABLE and holds
//   nothing, the read works and the turn completes; and Laravel's grant edit refusing an ask before reading;
// - the local tools in the conversation's real container (ARCHITECTURE.md: Checkpoints; the Checkpoints and Files
//   rows): write, edit, Python through bash and read, published with the run and hydrated into the next
//   turn's container; a detached writer, a FIFO and a symlink at the checkpoint; five attachments of 50 MiB
//   (the folder's limit) copied as the run's first step, hydrated and kept in the version; crashes between a checkpoint's upload,
//   record, release and pi's commit; the container parked at the end of a completed turn, and taken by the next;
// - a kill between a cancel and the next start, while the cancelled run's command is past its checkpoint: the
//   cancelled run's tasks end abort-marked, it enters one model call and one tool call in all and has no tool_call
//   event, its command ran once, the provider got only the next run's read, and the next run completes in its first
//   attempt.
//
// The memory-limit resets are resets.test.ts's, the sandbox itself sandbox.test.ts's and
// sandbox-faults.test.ts's. Run with `pnpm test:faults` after `pnpm run deploy:test`; never against production.

import { afterAll, describe, expect, test } from "vitest";
import { FOLDER } from "../../src/faults/world.ts";
import {
	askingToSave,
	cancel,
	cards,
	commands,
	delivered,
	file,
	finish,
	finished,
	fired,
	folder,
	LIST,
	LIST_INBOX,
	later,
	local,
	modelDeadline,
	outcome,
	parked,
	post,
	provider,
	reads,
	replacedByPlatform,
	restarts,
	run,
	SAVE,
	SEEDED,
	save,
	script,
	settled,
	sh,
	sleep,
	toolCalls,
	upload,
	world,
} from "./driver.ts";

afterAll(finish, 300_000);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 120_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value !== undefined && done(value)) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`${what}; last: ${JSON.stringify(value)}`);
		await sleep(500);
	}
}

describe.concurrent("attempts on the platform", () => {
	test("ctx.abort() in a safe tool: the read runs again in attempt 2", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Two notes." }]));
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed" } });
		expect(restarts(view.events)).toEqual([2]);
		expect(reads(await provider(w))).toBe(2);
		expect(view.internals.executions.map((row) => row.executions)).toEqual([2]);
		console.info(`safe tool: ${view.seconds} s`);
	});

	test("ctx.abort() in an unsafe tool: never replayed; the model's retry is answered from the ledger", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: SAVE }] });
		const runId = await post(w, script([save("Once only"), save("Once only"), { text: "Saved once." }]));
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed" } });
		expect(restarts(view.events)).toEqual([2]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Once only"]);
		expect(toolCalls(view.events)).toEqual([expect.objectContaining({ tool: SAVE, decision: "allowed" }), expect.objectContaining({ tool: SAVE, decision: "allowed", repeat: true })]);
		console.info(`unsafe tool: ${view.seconds} s`);
	});

	test("the cap: a third death ends the run as worker_exited, and nothing runs after", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST, times: 5 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "failed", error: "The worker stopped unexpectedly." } });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(3);
		later("the cap", async () => expect(reads(await provider(w))).toBe(3));
		console.info(`cap: ${view.seconds} s`);
	});

	test("a revocation during a read in flight: stopped before the answer, nothing after it", async () => {
		const w = await world({ delays: { "GET /folders/inbox/notes": 4000 } });
		const runId = await post(w, script([LIST_INBOX, LIST_INBOX, { text: "Done." }]));
		const started = Date.now();
		while ((await provider(w)).requests.length === 0) {
			if (Date.now() - started > 60_000) throw new Error("The read never reached the provider.");
			await sleep(250);
		}
		const sent = Date.now();
		expect(await cancel(w, runId, "permissions_changed")).toEqual({ state: "cancelled" });
		const answeredMs = Date.now() - sent;
		const atAnswer = (await provider(w)).requests;
		expect(atAnswer).toHaveLength(1);
		const view = await run(w, runId);
		expect(view.head).toMatchObject({ status: "cancelled", errorMessage: "Stopped because permissions changed." });
		await sleep(8000);
		// The held read answers 4 s after it arrived; had the run gone on, its second read would be here by now.
		expect((await provider(w)).requests.map((request) => request.seq)).toEqual(atAnswer.map((request) => request.seq));
		expect(toolCalls((await run(w, runId)).events)).toEqual([]);
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "cancelled", error: "Stopped because permissions changed." } });
		console.info(`revocation answered in ${answeredMs} ms`);
	});

	test("a crash while a write is dispatched, after the provider applied it: uncertain at the gate", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
		const runId = await post(w, script([save("Applied once"), save("Applied once"), { text: "Done." }]));
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed" } });
		expect(restarts(view.events)).toEqual([2]);
		expect(toolCalls(view.events)).toEqual([expect.objectContaining({ code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Applied once"]);
	});

	test("ctx.abort() right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "abort", unsynced: true, times: 6 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "failed", error: "The worker stopped unexpectedly." } });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(1);
		console.info(`gate abort: ${view.seconds} s`);
	});

	test("ctx.abort() mid-stream: one settlement per counted call, and run.settled's totals are their sums", async () => {
		const w = await world({ faults: [{ point: "model:delta", mode: "abort", step: 1, delta: 3 }] });
		const runId = await post(w, script([sh("echo ran"), { text: "A sentence long enough for several deltas." }]));
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		const facts = (await delivered(w, runId)).filter((fact) => fact.run === runId);
		const usage = facts.flatMap((fact) => (fact.type === "run.usage" ? [fact.data] : []));
		const unmetered = facts.flatMap((fact) => (fact.type === "run.unmetered" ? [fact.data] : []));
		const calls = [...usage, ...unmetered].map((data) => data.call);
		expect(calls).toHaveLength(Number(view.internals.run?.model_calls));
		expect(new Set(calls).size).toBe(calls.length);
		// The call the crash cut is settled by the next instance; the fake reports usage for every other.
		expect(unmetered.map((data) => [data.cause, data.estimated])).toEqual([["lost", true]]);
		const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
		// The test build charges the fake model 1 µ$ a token counted, and container time 1 µ$ a millisecond (src/faults/prices.ts).
		const costs = [...usage, ...unmetered].map((data) => data.costMicros);
		expect(costs).toEqual([...usage, ...unmetered].map((data) => data.inputTokens + data.outputTokens));
		const totals = facts.find((fact) => fact.type === "run.settled")?.data;
		const modelMicros = sum(costs.map(Number));
		expect(totals).toEqual({
			modelCalls: calls.length,
			refusedCalls: 0,
			unmeteredCalls: 1,
			inputTokens: sum(usage.map((data) => data.inputTokens)),
			outputTokens: sum(usage.map((data) => data.outputTokens)),
			cachedTokens: sum(usage.map((data) => data.cachedTokens)),
			cacheWriteTokens: sum(usage.map((data) => data.cacheWriteTokens ?? 0)),
			reasoningTokens: sum(usage.map((data) => data.reasoningTokens)),
			estimatedInputTokens: sum(unmetered.map((data) => data.inputTokens)),
			estimatedOutputTokens: sum(unmetered.map((data) => data.outputTokens)),
			containers: expect.any(Number),
			containerMs: expect.any(Number),
			containerEstimated: false,
			scripts: 0,
			scriptMs: 0,
			scriptEstimated: false,
			prices: expect.stringMatching(/^[0-9a-f]{16}$/),
			modelMicros,
			containerMicros: totals?.containerMs,
			scriptMicros: 0,
			chargedMicros: modelMicros + Number(totals?.containerMs),
		});
		expect(totals?.containers).toBeGreaterThan(0);
		expect(totals?.containerMs).toBeGreaterThan(0);
		expect(facts.at(-1)?.type).toBe("run.settled");
		console.info(`a crash mid-stream: ${view.seconds} s, ${calls.length} calls; ${JSON.stringify(totals)}`);
	});

	test("a small allowance: the first call after spent reached it ends the run, failed with budget_reached, and records nothing", async () => {
		// 1 µ$ a token on the fake route and 1 µ$ a millisecond of container time (src/faults/prices.ts): the second call's
		// million tokens pass the allowance, which the container's time before it cannot reach.
		const allowance = 500_000;
		const w = await world();
		const step = (input: number) => ({ tools: [{ name: "no_such_tool", arguments: {} }], usage: { input, output: 0 } });
		const runId = await post(w, script([step(10), step(1_000_000), step(10), { text: "Done." }]), [], { allowance });
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("failed");
		expect(view.head?.errorMessage).toBe("This conversation reached its budget.");
		expect(view.internals.run).toMatchObject({ error_code: "budget_reached", model_calls: 2, allowance });
		expect(await finished(w, runId)).toMatchObject({ data: { status: "failed", code: "budget_reached", error: "This conversation reached its budget." } });
		const totals = (await delivered(w, runId)).flatMap((fact) => (fact.run === runId && fact.type === "run.settled" ? [fact.data] : []))[0];
		expect(totals).toMatchObject({ modelCalls: 2, modelMicros: 1_000_010 });
		expect(Number(totals?.chargedMicros)).toBeGreaterThan(allowance);
		console.info(`a small allowance: ${view.seconds} s; ${JSON.stringify(totals)}`);
	});

	test("a long tool across PiHarness's heartbeats is no restart", async () => {
		const longRead = async () => {
			// 75 s: past two 30 s heartbeats and their alarms, within the fake connector's 300 s timeout.
			const w = await world({ delays: { "GET /folders/inbox/notes": 75_000 } });
			return { w, view: await settled(w, await post(w, script([LIST_INBOX, { text: "Two notes." }]))) };
		};
		let { w, view } = await longRead();
		if (replacedByPlatform(view)) {
			// Seen once in about 15 runs on 2026-10-18: torn down mid-read with no reset asked for, and restarted as designed.
			expect(view.head?.status, outcome(view)).toBe("completed");
			expect(view.internals.attempts).toEqual([
				{ attempt: 1, ended: "restarted" },
				{ attempt: 2, ended: "completed" },
			]);
			console.warn(`long tool: the platform replaced the conversation's instance during the run (${JSON.stringify(view.internals.calls)}); once more in a new conversation`);
			({ w, view } = await longRead());
		}
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(restarts(view.events), JSON.stringify({ calls: view.internals.calls, aborts: view.aborts })).toEqual([]);
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		expect(reads(await provider(w))).toBe(1);
		console.info(`long tool: ${view.seconds} s`);
	});

	test("Workers AI: a smoke run with @cf/zai-org/glm-5.3-flash and the fake connector's read", async () => {
		const w = await world({ model: "workers-ai" });
		const runId = await post(w, "Use the notes_list_notes tool to list the notes in the folder inbox, then tell me how many there are.");
		// Two model calls, and one more for a model that checks its work.
		const view = await settled(w, runId, modelDeadline(3));
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(toolCalls(view.events)).toContainEqual(expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }));
		const answer = view.events.find((event) => event.type === "message");
		expect(String(answer?.data.content ?? "")).not.toBe("");
		console.info(`Workers AI: ${view.seconds} s, ${view.internals.run?.model_calls} model calls; answer: ${String(answer?.data.content).slice(0, 200)}`);
	});
});

describe.concurrent("asks", () => {
	test("an attended turn saving two notes under ask: both are held, the answer names both as waiting, Laravel holds both whole, and no note is saved", async () => {
		const w = await world();
		const answer = "First and Second wait for your approval.";
		const runId = await post(w, script([save("First"), save("Second"), { text: answer }]), [], { authority: askingToSave(w), attended: true });
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(view.events.findLast((event) => event.type === "message")?.data.content).toBe(answer);
		expect(view.internals.run).toMatchObject({ attended: 1, writes_closed: 0 });
		expect(view.internals.writes).toEqual([]);
		const [first, second] = view.internals.holds.map((hold) => hold.write_id);
		expect(view.internals.holds.map(({ position, tool, state, arguments: text }) => ({ position, tool, state, arguments: text }))).toEqual([
			{ position: 1, tool: SAVE, state: "open", arguments: '{"folder":"inbox","title":"First"}' },
			{ position: 2, tool: SAVE, state: "open", arguments: '{"folder":"inbox","title":"Second"}' },
		]);
		const required =
			"Minerva asked the user to approve this. It has not run. Do not call it again or try another way. Finish your turn by saying what waits for approval. The user approves or declines it with the buttons Minerva shows in the chat, so do not ask them to reply yes or no. The outcome comes in the next turn.";
		expect(toolCalls(view.events)).toEqual([
			expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_REQUIRED", message: required, write: first }),
			expect.objectContaining({ tool: SAVE, decision: "denied", code: "APPROVAL_REQUIRED", message: required, write: second }),
		]);
		const state = await provider(w);
		expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
		expect(state.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /folders", "GET /folders"]);
		const requirement = { kind: FOLDER, kindLabel: "Folder", resource: "inbox", name: "Inbox", action: "create", actionLabel: "Create notes", effect: "ask", asked: ["user"] };
		const held = { tool: SAVE, label: "Notes: Save a note", connection: w.connectionId, provider: "notes", operation: "save_note", requirements: [requirement] };
		const facts = (await delivered(w, runId)).filter((fact) => fact.run === runId);
		expect(facts.filter((fact) => fact.type === "run.held_call").map((fact) => fact.data)).toEqual([
			{ position: 1, ...held, arguments: '{"folder":"inbox","title":"First"}', write: first },
			{ position: 2, ...held, arguments: '{"folder":"inbox","title":"Second"}', write: second },
		]);
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed", message: { content: answer } } });
	});

	test("the same layer unattended: the save answers APPROVAL_UNAVAILABLE and holds nothing, the read works, and the turn completes", async () => {
		const w = await world();
		const runId = await post(w, script([save("Asked first"), LIST_INBOX, { text: "Done." }]), [], { authority: askingToSave(w) });
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(view.internals.run).toMatchObject({ attended: 0, writes_closed: 0 });
		expect(view.internals.holds).toEqual([]);
		expect(toolCalls(view.events)).toEqual([
			expect.objectContaining({
				tool: SAVE,
				decision: "denied",
				code: "APPROVAL_UNAVAILABLE",
				message: "This needs the user's approval, which nobody can give in this run. Do not retry. Say what you would do.",
			}),
			expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }),
		]);
		const state = await provider(w);
		expect(state.notes.map((note) => note.title)).toEqual(SEEDED);
		expect(state.requests.filter((request) => request.method === "POST")).toEqual([]);
		expect(reads(state)).toBe(1);
		expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed" } });
		expect((await delivered(w, runId)).filter((fact) => fact.type === "run.held_call")).toEqual([]);
	});

	test("Laravel's grant edit: an ask before creating notes is its own row; one before reading them is refused", async () => {
		const w = await world();
		const edit = (ask: string[]) =>
			commands.checkGrantEdit({
				scope: w.scope,
				connection: { id: w.connectionId, provider: "notes" },
				credential: { kind: "oauth2", secret: "notes-access-0", generation: 1 },
				layer: { level: "user", subject: "1017", restricted: true, revision: 1, grants: [] },
				changes: [{ kind: FOLDER, id: "*", actions: ["read", "create"], ask }],
			});
		const every = { connection: w.connectionId, kind: FOLDER, resource: "*", name: "" };
		expect(await edit(["create"])).toEqual({
			outcome: "valid",
			grants: [
				{ ...every, actions: ["read"], effect: "allow" },
				{ ...every, actions: ["create"], effect: "ask" },
			],
		});
		expect(await edit(["read"])).toEqual({ outcome: "invalid", message: "Notes cannot ask before Read notes; it is needed to read." });
		expect((await provider(w)).requests).toEqual([]);
	});
});

describe.concurrent("the local tools in the container", () => {
	test("write, edit, Python through bash and read: held until saved, carded, and the folder published with the run", async () => {
		const w = await world();
		const runId = await post(
			w,
			script([
				local("write", { path: "notes.txt", content: "apples 3\n" }),
				local("edit", { path: "notes.txt", edits: [{ oldText: "3", newText: "4" }] }),
				sh("python3 -c \"open('py.txt', 'w').write('from python\\n')\" && cat notes.txt py.txt"),
				local("read", { path: "py.txt" }),
				{ text: "Done." },
			]),
		);
		const view = await settled(w, runId);
		const head = view.head;
		expect(head?.status, outcome(view)).toBe("completed");
		expect(cards(view.events)).toEqual([
			{ tool: "write", summary: "notes.txt", ok: true, excerpt: "Successfully wrote to notes.txt" },
			{ tool: "edit", summary: "notes.txt", ok: true, excerpt: "Successfully replaced 1 block(s) in notes.txt." },
			{ tool: "bash", summary: expect.stringContaining("python3"), ok: true, excerpt: "apples 4\nfrom python\n" },
			{ tool: "read", summary: "py.txt", ok: true, excerpt: "from python\n" },
		]);
		expect(head?.folderChanges?.added?.map((file) => file.path).sort()).toEqual(["notes.txt", "py.txt"]);
		expect((await folder(w)).versionId).toBe(head?.resultVersionId);
		expect((await file(w, "py.txt")).text).toBe("from python\n");
		const parkMs = await parked(w);
		console.info(`local tools: ${view.seconds} s for the turn, container parked ${parkMs} ms after`);

		// The next turn takes the parked container, which holds the published folder.
		const next = await settled(w, await post(w, script([sh("cat notes.txt"), { text: "Read." }])));
		expect(cards(next.events)).toEqual([{ tool: "bash", summary: "cat notes.txt", ok: true, excerpt: "apples 4\n" }]);
		console.info(`second turn on the parked container: ${next.seconds} s`);
	});

	test("a detached writer dies at the checkpoint; a FIFO and a symlink are reported with the run", async () => {
		const w = await world();
		const runId = await post(
			w,
			script([
				sh("setsid sh -c 'while :; do echo x >> log.txt; sleep 0.05; done' > /dev/null 2>&1 & mkfifo pipe; ln -s /etc etc; sleep 1; echo started"),
				sh("a=$(wc -c < log.txt); sleep 2; b=$(wc -c < log.txt); [ \"$a\" = \"$b\" ] && echo still"),
				{ text: "Done." },
			]),
		);
		const view = await settled(w, runId);
		const head = view.head;
		expect(head?.status, outcome(view)).toBe("completed");
		expect(cards(view.events).map((card) => [card.ok, card.excerpt])).toEqual([
			[true, "started\n"],
			[true, "still\n"],
		]);
		expect(head?.folderWarnings).toEqual({ total: 2, items: [{ path: "etc", reason: "symlink" }, { path: "pipe", reason: "special" }] });
		expect(head?.folderChanges?.added?.map((file) => file.path)).toEqual(["log.txt"]);
	});

	test("five attachments of 50 MiB, the folder's limit: copied, hydrated into the container and kept in the version", async () => {
		const MiB = 1024 * 1024;
		const w = await world();
		const started = Date.now();
		// One byte value each ('a' to 'e'), so the five contents differ.
		// Three at once, then two, as a browser's uploads go.
		const attachments = [];
		for (const batch of [[0, 1, 2], [3, 4]]) {
			attachments.push(...(await Promise.all(batch.map((i) => upload(w, { name: `big${i}.bin`, bytes: 50 * MiB, fill: 97 + i })))));
		}
		const uploadedMs = Date.now() - started;
		const posting = Date.now();
		const runId = await post(w, script([sh("wc -c big*.bin | tail -n 1; head -c 1 big3.bin; echo"), { text: "Counted." }]), attachments);
		const postedMs = Date.now() - posting;
		const view = await settled(w, runId);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(cards(view.events)).toEqual([{ tool: "bash", summary: expect.stringContaining("wc -c"), ok: true, excerpt: "262144000 total\nd\n" }]);
		expect((await folder(w)).files.map((item) => [item.path, item.size]).sort()).toEqual(["big0.bin", "big1.bin", "big2.bin", "big3.bin", "big4.bin"].map((path) => [path, 50 * MiB]));
		const phases = view.events.flatMap((event) => (event.type === "phase" ? [event.data.text] : []));
		expect(phases.slice(0, 2)).toEqual(["Copying the attached files", "Starting the agent"]);
		console.info(`five attachments of 50 MiB: staging ${uploadedMs} ms, the start ${postedMs} ms, the run with its copy ${view.seconds} s`);
	});

	for (const point of ["checkpoint:uploaded", "checkpoint:recorded", "local:released"]) {
		test(`a crash at ${point}: the next attempt starts from the last checkpoint`, async () => {
			const w = await world({ faults: [{ point, mode: "abort" }] });
			const runId = await post(w, script([sh("echo a > a.txt"), sh("cat a.txt"), { text: "Done." }]));
			const view = await settled(w, runId);
			expect(view.head?.status, outcome(view)).toBe("completed");
			expect(await finished(w, runId)).toMatchObject({ run: runId, type: "run.finished", data: { status: "completed" } });
			expect(restarts(view.events)).toEqual([2]);
			// Uploaded but not recorded: the file is not in the checkpoint attempt 2 starts from.
			expect(cards(view.events).find((card) => card.summary === "cat a.txt")?.ok).toBe(point !== "checkpoint:uploaded");
			console.info(`a crash at ${point}: ${view.seconds} s`);
		});
	}

	test("a kill between a cancel and the next start: the cancelled run's work is marked before pi resumes, never resumed, and acts on nothing", async () => {
		const w = await world({
			faults: [
				{ point: "local:released", mode: "hold", tool: "bash" },
				{ point: "pi:stop", mode: "abort" },
			],
		});
		const a = await post(w, script([sh("echo ran >> ran.txt"), { text: "Done." }]));
		await until(async () => (await fired(w)).map((entry) => entry.point), (points) => points.includes("local:released"), "A's command was never released");
		// As Laravel does: sent again until it is answered, and a repeat answers from the stored end.
		await until(() => cancel(w, a, "cancelled"), (answer) => answer.state === "cancelled", "A's cancel was never answered");
		const b = await post(w, script([LIST_INBOX, { text: "Done." }]));
		const view = await settled(w, b);
		expect(view.head?.status, outcome(view)).toBe("completed");
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		expect((await fired(w)).map((entry) => [entry.point, entry.mode, entry.detail])).toEqual([
			["local:released", "hold", "bash"],
			["pi:stop", "abort", a],
		]);
		const left = await run(w, a);
		expect(left.internals.piTasks.map(({ kind, status, abortRequested }) => [kind, status, abortRequested])).toEqual([
			["pi.generation", "terminal", true],
			["pi.tool", "terminal", true],
		]);
		expect(left.internals.entered).toEqual({ model: 1, tool: 1 });
		expect(toolCalls(left.events)).toEqual([]);
		// A's checkpoint is the folder B started from and left as it was.
		expect((await file(w, "ran.txt")).text).toBe("ran\n");
		expect((await provider(w)).requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /folders/inbox/notes"]);
		console.info(`a kill between a cancel and the next start: ${view.seconds} s`);
	});
});
