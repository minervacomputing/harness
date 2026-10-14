// Code mode on the account (plan: Code mode, Testing; table row Scripts), against the test
// instance's lab Worker (test/account/scripts-worker/): production's Scripts object and conversation-side runner
// behind a stand-in conversation. It settles the teardown the spikes disagreed on (an awaited loopback
// entrypoint against resetting the Scripts object after each script) and runs the faults that need the real
// platform: a CPU-bound guest while the conversation answers, a timeout during a write, calls after return,
// more than ten scripts in a row, a late reset from a replaced attempt, and a conversation that dies during a
// script. `pnpm run deploy:cm` deploys the lab, `pnpm test:cm` runs this, and the lab is deleted after
// (cloudflare/README.md, Code mode's lab).

import { beforeAll, describe, expect, test } from "vitest";
import { readInstanceEnv } from "../../scripts/instance.ts";
import { fetchDeployed, ownLabOrigin, suiteInstance } from "./client.ts";

/**
 * The lab's token and origin, in the test instance's cm.env and cm.vars.env (MINERVA_INSTANCE, or the only test
 * instance). The origin must be the instance's own lab, `<name>-cm`, on its account's workers.dev subdomain, before
 * the token is sent anywhere.
 */
function lab(): { origin: string; token: string } {
	const instance = suiteInstance(true);
	const token = readInstanceEnv(instance, "cm")?.CM_TOKEN;
	if (!token || !readInstanceEnv(instance, "cmVars")) throw new Error(`The lab's token and origin are in ${instance.files.cm} and ${instance.files.cmVars} (cloudflare/README.md, Code mode's lab).`);
	return { origin: ownLabOrigin(instance), token };
}

const { origin, token } = lab();

/** Ops that only read, which a request lost on the way may send again. */
const READS = new Set(["ping", "instance", "events", "late", "probe"]);

async function op<T = unknown>(name: string, body: { [key: string]: unknown } = {}, timeoutMs = READS.has(name) ? 20_000 : 150_000): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			const reply = await fetchDeployed(`${origin}/lab/${name}`, {
				method: "POST",
				headers: { "X-Minerva-CM": token, "content-type": "application/json" },
				body: JSON.stringify(body),
				timeoutMs,
			});
			if (reply.status !== 200) throw new Error(`HTTP ${reply.status}: ${reply.text.slice(0, 300)}`);
			return JSON.parse(reply.text) as T;
		} catch (error) {
			if (!READS.has(name) || attempt >= 2) throw error;
			await sleep(500);
		}
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Kind = "Scripts" | "ScriptsKeep" | "ScriptsViaHost" | "ScriptsViaHostKeep";

interface Result {
	ok: boolean;
	value?: { text: string };
	error?: { kind: string; message: string; stack?: string };
	output: { text: string }[];
	cancelled: number;
}

interface Ran {
	result: Result;
	model: { content: { text: string }[]; isError: boolean };
	ms: number;
	session: string;
	maxInFlight: number;
}

const unique = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function script(labName: string, input: { [key: string]: unknown }): Promise<Ran> {
	return op<Ran>("script", { lab: labName, input });
}

const events = (labName: string) => op<{ kind: string; tag: string; at: number }[]>("events", { lab: labName });

const LOOP = "for (;;) await new Promise((resolve) => setTimeout(resolve, 100))";
const CALLING = "for (;;) { tools.lab_tick({ tag: 't' }).catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 100)) }";

/** Pings the lab every 400 ms while `work` runs; the longest answer, as the lab's Worker measured it (the test's own network aside). */
async function whilePinging<T>(labName: string, work: Promise<T>): Promise<{ value: T; slowest: number; pings: number }> {
	let done = false;
	const times: number[] = [];
	const pinger = (async () => {
		await sleep(300);
		while (!done) {
			times.push((await op<{ rpcMs: number }>("ping", { lab: labName })).rpcMs);
			await sleep(400);
		}
	})();
	const value = await work.finally(() => {
		done = true;
	});
	await pinger;
	return { value, slowest: Math.max(0, ...times), pings: times.length };
}

beforeAll(async () => {
	// Right after a deploy a request may still meet the previous version: wait until every class answers.
	const started = Date.now();
	for (const kind of ["Scripts", "ScriptsKeep", "ScriptsViaHost", "ScriptsViaHostKeep"]) {
		for (;;) {
			try {
				await op("instance", { lab: "warm", scripts: kind, name: "warm" }, 10_000);
				break;
			} catch (error) {
				if (Date.now() - started > 90_000) throw error;
				await sleep(2000);
			}
		}
	}
}, 120_000);

describe("teardown: what ends a guest that ignores its stop", () => {
	test("an awaited loopback entrypoint does not: the stopped guest keeps calling after it returned", async () => {
		const labName = `lab-${unique()}`;
		const ran = await script(labName, { code: CALLING, scripts: "ScriptsViaHostKeep", name: `s-${unique()}`, reset: false, timeoutMs: 1500 });
		expect(ran.result.error?.kind).toBe("timeout");
		const first = await op<{ late: number }>("late", { lab: labName, session: ran.session });
		await sleep(3000);
		const later = await op<{ late: number }>("late", { lab: labName, session: ran.session });
		expect(later.late).toBeGreaterThan(first.late + 5);
	}, 60_000);

	test("nor does the object that loaded the guests, unless it is reset: ten stopped guests take every slot", async () => {
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const errors: (string | undefined)[] = [];
		for (let i = 0; i < 11; i++) errors.push((await script(labName, { code: LOOP, scripts: "ScriptsKeep", name, reset: false, timeoutMs: 1000 })).result.error?.message);
		expect(errors.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => "Execution timed out after 1000 ms"));
		expect(errors[10]).toMatch(/Dynamic worker concurrency limit exceeded/);
		expect(await op<{ ok: boolean; error?: string }>("probe", { lab: labName, scripts: "ScriptsKeep", name })).toMatchObject({ ok: false });
	}, 120_000);

	test.each(["Scripts", "ScriptsViaHost"] as Kind[])("resetting the object does (%s): the guest stops calling, and twelve stopped scripts in a row leave every slot free", async (kind) => {
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const ran = await script(labName, { code: CALLING, scripts: kind, name, timeoutMs: 1500 });
		expect(ran.result.error?.kind).toBe("timeout");
		await sleep(500);
		const first = await op<{ late: number }>("late", { lab: labName, session: ran.session });
		const ticks = (await events(labName)).filter((event) => event.kind === "tick").length;
		await sleep(2500);
		expect((await op<{ late: number }>("late", { lab: labName, session: ran.session })).late).toBe(first.late);
		expect((await events(labName)).filter((event) => event.kind === "tick").length).toBe(ticks);
		for (let i = 0; i < 12; i++) {
			const stopped = await script(labName, { code: LOOP, scripts: kind, name, timeoutMs: 1000 });
			expect(stopped.result.error?.message).toBe("Execution timed out after 1000 ms");
		}
		expect((await script(labName, { code: "return 'thirteenth'", scripts: kind, name })).result.value).toEqual({ text: "thirteenth" });
		expect(await op("probe", { lab: labName, scripts: kind, name })).toEqual({ ok: true });
	}, 180_000);

	test("a conversation that dies during a script takes its guest with it: the Scripts object resets itself", async () => {
		for (const [kind, resets] of [
			["Scripts", true],
			["ScriptsKeep", false],
		] as const) {
			const labName = `lab-${unique()}`;
			const name = `s-${unique()}`;
			const before = await op<{ instance: string }>("instance", { lab: labName, scripts: kind, name });
			await op("start", { lab: labName, input: { code: CALLING, scripts: kind, name }, dieAfterMs: 1000 });
			await sleep(3000);
			const after = await op<{ instance: string }>("instance", { lab: labName, scripts: kind, name });
			expect(after.instance !== before.instance, kind).toBe(resets);
		}
	}, 60_000);

	test("so does one that dies after its script answered, before it could reset the object: what the guest left is ended", async () => {
		for (const [kind, resets] of [
			["Scripts", true],
			["ScriptsKeep", false],
		] as const) {
			const labName = `lab-${unique()}`;
			const name = `s-${unique()}`;
			const before = await op<{ instance: string }>("instance", { lab: labName, scripts: kind, name });
			// It answers at once and leaves a timer running; the lab skips its reset and dies a second later.
			await op("start", { lab: labName, input: { code: "setInterval(() => {}, 100); return 'left'", scripts: kind, name, reset: false }, dieAfterMs: 1000 });
			await sleep(3000);
			const after = await op<{ instance: string }>("instance", { lab: labName, scripts: kind, name });
			expect(after.instance !== before.instance, kind).toBe(resets);
		}
		// While the conversation lives, its answered script does not reset the object by itself: the kept stub
		// does not break when the call that brought it returned.
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const before = await op<{ instance: string }>("instance", { lab: labName, name });
		expect((await script(labName, { code: "return 'answered'", name, reset: false })).result.value).toEqual({ text: "answered" });
		await sleep(3000);
		expect((await op<{ instance: string }>("instance", { lab: labName, name })).instance).toBe(before.instance);
	}, 60_000);
});

describe("the faults of the plan's Scripts row", () => {
	test("a CPU-bound guest is stopped by its CPU limit while the conversation goes on answering, and the next script runs", async () => {
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const { value, slowest, pings } = await whilePinging(labName, script(labName, { code: "text('before'); while (true) {}", name, cpuMs: 5000 }));
		expect(value.result.error).toEqual({ kind: "sandbox", message: "The script was stopped after 5 seconds of computation." });
		// What it printed while it computed without yielding was lost with it.
		expect(value.result.output).toEqual([]);
		expect(value.ms).toBeGreaterThan(5000);
		expect(pings).toBeGreaterThan(5);
		expect(slowest).toBeLessThan(1500);
		expect((await script(labName, { code: "return 'next'", name })).result.value).toEqual({ text: "next" });
	}, 120_000);

	test("a CPU-bound guest past its wall clock: the conversation answers at its time, and the next script waits for the reset", async () => {
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const stopped = await script(labName, { code: "while (true) {}", name, cpuMs: 5000, timeoutMs: 1000 });
		expect(stopped.result.error).toEqual({ kind: "timeout", message: "Execution timed out after 1000 ms" });
		expect(stopped.ms).toBeLessThan(2500);
		const next = await script(labName, { code: "return 'next'", name });
		expect(next.result.value).toEqual({ text: "next" });
	}, 120_000);

	test("a timeout during a write: the result comes at once, and the write settles and is recorded", async () => {
		const labName = `lab-${unique()}`;
		const ran = await script(labName, { code: "text('start'); await tools.lab_write({ key: 'w1', ms: 3000 }); text('never')", timeoutMs: 1000 });
		expect(ran.result).toMatchObject({ ok: false, error: { kind: "timeout", message: "Execution timed out after 1000 ms" }, output: [{ text: "start" }], cancelled: 1 });
		expect(ran.ms).toBeLessThan(2000);
		expect(ran.model.content.map((item) => item.text)).toEqual([
			"Script failed: Execution timed out after 1000 ms",
			"1 tool call had not finished when the script ended and was cancelled. A cancelled write may still have taken effect.",
			"start",
		]);
		await sleep(3500);
		expect((await events(labName)).map((event) => `${event.kind}:${event.tag}`)).toEqual(["write:start:w1", "write:applied:w1", "recorded:lab_write:ok"]);
	}, 60_000);

	test("calls after return: one left unawaited is cancelled, and one a timer starts later never runs", async () => {
		const labName = `lab-${unique()}`;
		const ran = await script(labName, { code: "tools.lab_sleep({ ms: 500, tag: 'unawaited' }); setTimeout(() => tools.lab_tick({ tag: 'timer' }), 300); return 'returned'" });
		expect(ran.result).toMatchObject({ ok: true, value: { text: "returned" }, cancelled: 1 });
		await sleep(1500);
		expect((await events(labName)).filter((event) => event.tag === "timer")).toEqual([]);
	}, 60_000);

	test("the run's queue: four at once and writes one at a time, across a script's calls", async () => {
		const labName = `lab-${unique()}`;
		const ran = await script(labName, {
			code: "await Promise.all(Array.from({ length: 12 }, (_, i) => tools.lab_sleep({ ms: 300, tag: String(i) }))); await Promise.all([0, 1, 2].map((i) => tools.lab_write({ key: 'k' + i, ms: 200 }))); return 'done'",
		});
		expect(ran.result.value).toEqual({ text: "done" });
		expect(ran.maxInFlight).toBe(4);
		const writes = (await events(labName)).filter((event) => event.kind.startsWith("write"));
		expect(writes.map((event) => `${event.kind}:${event.tag}`)).toEqual(["write:start:k0", "write:applied:k0", "write:start:k1", "write:applied:k1", "write:start:k2", "write:applied:k2"]);
	}, 60_000);

	test("a late reset from a replaced attempt is refused, and the newer attempt's script finishes", async () => {
		const labName = `lab-${unique()}`;
		const name = `s-${unique()}`;
		const runId = "0199f000-0000-7000-8000-00000000c0de";
		const running = op<unknown>("raw", { lab: labName, name, fence: { runId, attempt: 2, scriptId: "s" }, code: "await new Promise((resolve) => setTimeout(resolve, 1500)); return 'kept'" });
		await sleep(500);
		expect(await op("reset", { lab: labName, name, runId, attempt: 1, scriptId: "s" })).toEqual({ refused: "stale" });
		expect(await op("reset", { lab: labName, name, runId: "0199f000-0000-7000-8000-00000000c0dc", attempt: 9, scriptId: "s" })).toEqual({ refused: "stale" });
		// Nor a reset of an earlier script of the same attempt, once a later one loaded.
		expect(await op("reset", { lab: labName, name, runId, attempt: 2, scriptId: "earlier" })).toEqual({ refused: "stale" });
		expect(await running).toMatchObject({ ok: true, value: { text: "kept" } });
		expect(await op("reset", { lab: labName, name, runId, attempt: 2, scriptId: "s" })).toEqual({ thrown: "The scripts of this conversation were reset.", durableObjectReset: true });
		// The next instance has loaded nothing: its reset answers without one.
		expect(await op("reset", { lab: labName, name, runId, attempt: 2, scriptId: "s" })).toEqual({ reset: true });
	}, 60_000);

	test("the platform's other stops: memory, a script waiting on nothing, and no network or eval", async () => {
		const labName = `lab-${unique()}`;
		const memory = await script(labName, { code: "const kept = []; for (;;) kept.push(new Float64Array(1 << 17).fill(1))" });
		expect(memory.result.error).toEqual({ kind: "sandbox", message: "The script was stopped for using more than about 256 MB of memory." });
		const stalled = await script(labName, { code: "text('waiting'); await new Promise(() => {})" });
		expect(stalled.result).toMatchObject({ ok: false, error: { kind: "script", message: "The script is waiting on a promise that can never settle: no tool call or timer is pending." }, output: [{ text: "waiting" }] });
		const world = await script(labName, {
			code: "const out = []; try { await fetch('https://example.com') } catch (error) { out.push(error.message) } try { eval('1') } catch (error) { out.push(error.message) } return out",
		});
		expect(JSON.parse(world.result.value?.text ?? "[]")).toEqual([expect.stringMatching(/not permitted to access the internet/), "Code generation from strings disallowed for this context"]);
	}, 120_000);
});
