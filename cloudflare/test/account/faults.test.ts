// Fault tests on the account, for what only the platform shows (plan: Testing): the test
// instance, built from the same code with the fake Notes connector, its provider object, fault points and a
// token-gated driver (src/faults/, driver.ts). Each test makes its own workspace and
// conversation, and they all run at once. One row per mechanism the platform could change; the cases of the
// executor's and the ledger's logic around them run in local workerd (test/platform/protocols.test.ts):
//
// - ctx.abort() in a safe tool (the read runs again) and in an unsafe tool (the write is never replayed);
// - the cap at 3 attempts, and nothing runs after it;
// - a crash right after the attempt gate, every time and with nothing synced: the gate's own sync still
//   advances the attempts to the cap;
// - a long tool across PiHarness's heartbeats, which is no restart;
// - a revocation during a run, across the Workspace and the Conversation;
// - a crash while a write is dispatched, after the provider applied it;
// - a crash of the Workspace during a rotating refresh;
// - one smoke run with Workers AI and the fake connector's tool;
// - the local tools in the conversation's real container (plan: Checkpoints; the Checkpoints and Files
//   rows): write, edit, Python through bash and read, published with the run and hydrated into the next
//   turn's container; a detached writer, a FIFO and a symlink at the checkpoint; five attachments of 50 MiB
//   (the folder's limit) copied, hydrated and kept in the version; crashes between a checkpoint's upload,
//   record, release and pi's commit; the container destroyed at the run's end.
//
// The memory-limit resets are resets.test.ts's, the sandbox itself sandbox.test.ts's and
// sandbox-faults.test.ts's. Run with `pnpm test:faults` after `pnpm run deploy:test`; never against production.

import { afterAll, describe, expect, test } from "vitest";
import {
	base,
	cards,
	connection,
	destroyed,
	driver,
	finish,
	grants,
	LIST,
	LIST_INBOX,
	later,
	local,
	post,
	provider,
	reads,
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

describe.concurrent("attempts on the platform", () => {
	test("ctx.abort() in a safe tool: the read runs again in attempt 2", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Two notes." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(reads(await provider(w))).toBe(2);
		expect(view.internals.executions.map((row) => row.executions)).toEqual([2]);
		console.info(`safe tool: ${view.seconds} s`);
	});

	test("ctx.abort() in an unsafe tool: never replayed; the model's retry is answered from the ledger", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: SAVE }] });
		const runId = await post(w, script([save("Once only"), save("Once only"), { text: "Saved once." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
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
		const changed = await grants(w, [{ kind: "folder", id: "*", actions: ["read"] }]);
		expect(changed).toMatchObject({ ok: true, revocation: "acknowledged" });
		const view = await run(w, runId);
		expect(view.head).toMatchObject({ status: "cancelled", errorMessage: "Stopped because permissions changed." });
		await sleep(8000);
		const requests = (await provider(w)).requests;
		expect(requests).toHaveLength(1);
		expect(requests.every((request) => request.at < changed.answered)).toBe(true);
		expect(toolCalls((await run(w, runId)).events)).toEqual([]);
		console.info(`revocation answered in ${changed.answered - changed.started} ms`);
	});

	test("a crash while a write is dispatched, after the provider applied it: uncertain at the gate", async () => {
		const w = await world({ faults: [{ point: "provider:write:applied", mode: "abort" }] });
		const runId = await post(w, script([save("Applied once"), save("Applied once"), { text: "Done." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([2]);
		expect(toolCalls(view.events)).toEqual([expect.objectContaining({ code: "WRITE_UNCERTAIN", message: "This write has an unknown outcome. Check the provider before retrying." })]);
		expect((await provider(w)).notes.map((note) => note.title)).toEqual([...SEEDED, "Applied once"]);
	});

	test("ctx.abort() right after the gate, every time and with nothing synced: still a1, a2, a3, then worker_exited", async () => {
		const w = await world({ faults: [{ point: "tool:after", mode: "abort", tool: LIST }, { point: "gate:committed", mode: "abort", unsynced: true, times: 6 }] });
		const runId = await post(w, script([LIST_INBOX, { text: "Never." }]));
		const view = await settled(w, runId);
		expect(view.head).toMatchObject({ status: "failed", errorMessage: "The worker stopped unexpectedly." });
		expect(restarts(view.events)).toEqual([2, 3]);
		expect(view.internals.run).toMatchObject({ attempt: 3, error_code: "worker_exited" });
		expect(reads(await provider(w))).toBe(1);
		console.info(`gate abort: ${view.seconds} s`);
	});

	test("a long tool across PiHarness's heartbeats is no restart", async () => {
		// 75 s: past two 30 s heartbeats and their alarms, within the fake connector's 300 s timeout.
		const w = await world({ delays: { "GET /folders/inbox/notes": 75_000 } });
		const runId = await post(w, script([LIST_INBOX, { text: "Two notes." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(restarts(view.events)).toEqual([]);
		expect(view.internals.attempts).toEqual([{ attempt: 1, ended: "completed" }]);
		expect(reads(await provider(w))).toBe(1);
		console.info(`long tool: ${view.seconds} s`);
	});

	test("a crash during a rotating refresh: one refresh with the stored token after, refused, so Needs reconnecting", async () => {
		const w = await world({ expired: true, workspaceFaults: [{ point: "refresh:answered", mode: "abort" }] });
		const runId = await post(w, script([LIST_INBOX, LIST_INBOX, { text: "Done." }]));
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(toolCalls(view.events)).toEqual([
			expect.objectContaining({ decision: "error", code: "FAILED" }),
			expect.objectContaining({ decision: "error", code: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." }),
		]);
		const state = await provider(w);
		expect(state.requests.filter((request) => request.path === "/token").map((request) => request.status)).toEqual([200, 400]);
		expect(reads(state)).toBe(0);
		expect((await connection(w)).stored).toMatchObject({ status: "error", refresh_state: "fresh" });
	});

	test("Workers AI: a smoke run with @cf/zai-org/glm-5.3-flash and the fake connector's read", async () => {
		const w = await world({ model: "workers-ai" });
		const runId = await post(w, "Use the notes_list_notes tool to list the notes in the folder inbox, then tell me how many there are.");
		const view = await settled(w, runId, 180_000);
		expect(view.head?.status).toBe("completed");
		expect(toolCalls(view.events)).toContainEqual(expect.objectContaining({ tool: LIST, decision: "allowed", count: 2 }));
		const answer = view.events.find((event) => event.type === "message");
		expect(String(answer?.data.content ?? "")).not.toBe("");
		console.info(`Workers AI: ${view.seconds} s, ${view.internals.run?.model_calls} model calls; answer: ${String(answer?.data.content).slice(0, 200)}`);
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
		expect(head?.status).toBe("completed");
		expect(cards(view.events)).toEqual([
			{ tool: "write", summary: "notes.txt", ok: true, excerpt: "Successfully wrote to notes.txt" },
			{ tool: "edit", summary: "notes.txt", ok: true, excerpt: "Successfully replaced 1 block(s) in notes.txt." },
			{ tool: "bash", summary: expect.stringContaining("python3"), ok: true, excerpt: "apples 4\nfrom python\n" },
			{ tool: "read", summary: "py.txt", ok: true, excerpt: "from python\n" },
		]);
		expect(head?.folderChanges?.added?.map((file) => file.path).sort()).toEqual(["notes.txt", "py.txt"]);
		const folder = await driver<{ versionId: string; files: { path: string }[] }>("files", base(w));
		expect(folder.versionId).toBe(head?.resultVersionId);
		const file = await driver<{ text: string | null }>("file", { ...base(w), path: "py.txt" });
		expect(file.text).toBe("from python\n");
		const destroyMs = await destroyed(w);
		console.info(`local tools: ${view.seconds} s for the turn, container gone ${destroyMs} ms after`);

		// The next turn's container starts from the published folder.
		const next = await settled(w, await post(w, script([sh("cat notes.txt"), { text: "Read." }])));
		expect(cards(next.events)).toEqual([{ tool: "bash", summary: "cat notes.txt", ok: true, excerpt: "apples 4\n" }]);
		console.info(`second turn with hydration: ${next.seconds} s`);
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
		expect(head?.status).toBe("completed");
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
		// At most UPLOADS_IN_FLIGHT at once, as the workspace allows a user.
		const ids: string[] = [];
		for (const batch of [[0, 1, 2], [3, 4]]) {
			ids.push(...(await Promise.all(batch.map((i) => upload(w, { name: `big${i}.bin`, bytes: 50 * MiB, fill: 97 + i })))));
		}
		const uploadedMs = Date.now() - started;
		const posting = Date.now();
		const runId = await post(w, script([sh("wc -c big*.bin | tail -n 1; head -c 1 big3.bin; echo"), { text: "Counted." }]), ids);
		const postedMs = Date.now() - posting;
		const view = await settled(w, runId);
		expect(view.head?.status).toBe("completed");
		expect(cards(view.events)).toEqual([{ tool: "bash", summary: expect.stringContaining("wc -c"), ok: true, excerpt: "262144000 total\nd\n" }]);
		const folder = await driver<{ versionId: string; files: { path: string }[] }>("files", base(w));
		expect(folder.files.map((file) => file.path).sort()).toEqual(["big0.bin", "big1.bin", "big2.bin", "big3.bin", "big4.bin"]);
		console.info(`five attachments of 50 MiB: uploads ${uploadedMs} ms, post (the copies) ${postedMs} ms, the run ${view.seconds} s`);
	});

	for (const point of ["checkpoint:uploaded", "checkpoint:recorded", "local:released"]) {
		test(`a crash at ${point}: the next attempt starts from the last checkpoint`, async () => {
			const w = await world({ faults: [{ point, mode: "abort" }] });
			const view = await settled(w, await post(w, script([sh("echo a > a.txt"), sh("cat a.txt"), { text: "Done." }])));
			expect(view.head?.status).toBe("completed");
			expect(restarts(view.events)).toEqual([2]);
			// Uploaded but not recorded: the file is not in the checkpoint attempt 2 starts from.
			expect(cards(view.events).find((card) => card.summary === "cat a.txt")?.ok).toBe(point !== "checkpoint:uploaded");
			console.info(`a crash at ${point}: ${view.seconds} s`);
		});
	}
});
