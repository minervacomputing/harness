// The test Worker's fault driver (src/faults/routes.ts), shared by the account suites that run turns on the test instance:
// faults.test.ts, resets.test.ts, turns.test.ts and perf.test.ts. Each world is a Laravel workspace of its own (`scope`), with the fake
// Notes provider and the fake Laravel its FaultProvider hosts, and a conversation in the EU, as Laravel's are. The driver
// sets the world up and reads it (`POST /api/faults/<op>`); the runs go through Laravel's own commands, oRPC's client of the
// contract's `engine` at /api/faults/internal/, which the test Worker serves behind its token as /internal/ is served
// behind Access. A run is held by the fake Laravel before its start, as Laravel holds a run before it sends one.
//
// Every world and run made here is remembered, so each file can `drain()` in its afterAll: stop the runs still
// going and wait until every conversation's container is gone or parked. The memory-limit resets (resets.test.ts) take
// every object of their isolate with them, so they run only after every other file has finished
// (vitest.faults.config.ts): by then those files' results are in, and a reset can only cut short what a
// failed test left behind.

import { type CancelReason, type CancelRunResult, type Fact, type Scope, type StartRun, engine } from "@minerva/contract/internal";
import { ORPCError, createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { FAULTS_SETTINGS } from "../../src/faults/settings.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { FOLDER, heldRun, notesConnection, notesLayers } from "../../src/faults/world.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);
/** The run's user, as Laravel names one: its integer key. */
const USER = "1017";
const AGENT = "0199a000-0000-7000-8000-00000000a6e7";
const ACTIVE = ["queued", "provisioning", "running"];

export const LIST = "notes_list_notes";
export const SAVE = "notes_save_note";
export const SEEDED = ["Buy milk", "Call Ada", "Old note"];

export interface Fault {
	point: string;
	mode: "abort" | "oom" | "throw" | "lose" | "hold" | "note";
	times?: number;
	tool?: string;
	step?: number;
	delta?: number;
	unsynced?: boolean;
}

export interface RunEvent {
	seq: number;
	type: string;
	data: { [key: string]: unknown };
}

export interface Head {
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

export interface RunView {
	head: Head | null;
	events: RunEvent[];
	internals: {
		run: { [column: string]: unknown } | null;
		attempts: { attempt: number; ended: string | null }[];
		/** Each model call's attempt, the object instance that made it, its tokens (output includes reasoning), whether it made a summary, and when it was recorded and settled. */
		calls: {
			attempt: number;
			instance: string;
			input_tokens: number | null;
			cached_tokens: number | null;
			cache_write_tokens: number | null;
			output_tokens: number | null;
			reasoning_tokens: number | null;
			summary: boolean;
			created_at: number;
			settled_at: number | null;
		}[];
		writes: { key: string; status: string; attempt: number; approved_run: string; approved_position: number }[];
		/** The calls the run holds for approval, in position order, with how a later run decided each (src/faults/index.ts, `RunInternals`). */
		holds: {
			position: number;
			key: string;
			write_id: string;
			tool: string;
			label: string;
			state: string;
			arguments: string;
			requirements: string;
			decided_by: string | null;
			approve: number | null;
			outcome: string | null;
		}[];
		executions: { call_id: string; executions: number }[];
		/** The connector tools the run's snapshot offers. */
		tools: string[];
		entered: { model: number; tool: number };
		/** Each model call's marks, in the object's Date.now() milliseconds (src/faults/ports.ts, `CallMarks`). */
		marks: { begin: number; answered: number | null; last: number | null }[];
		/** The tasks pi ran for the run's submission in id order (src/faults/index.ts, `RunInternals`). */
		piTasks: { id: number; kind: string; status: string; abortRequested: boolean; startedAt: number | null; endedAt: number | null }[];
		/** The compactions pi placed for the run's submission: the summary as the model reads it. */
		compactions: { id: number; reason: string; firstKept: number; summary: string }[];
	};
	fired: { point: string; mode: string; at: number }[];
	/** The resets (`ctx.abort()`) the conversation's object asked for, as the isolate that answered saw them (src/faults/index.ts). */
	aborts: { at: number; reason: string }[];
}

export interface ProviderState {
	notes: { id: number; folder: string; title: string }[];
	requests: { seq: number; at: number; method: string; path: string; token: string; status: number }[];
}

/** What the world's fake Laravel holds of its conversation (src/faults/laravel.ts, `LaravelView`). */
export interface LaravelState {
	facts: Fact[];
	calls: { operation: string; run?: string; connection?: string }[];
	/** Without their secrets. */
	connections: { [id: string]: { kind: string; status: string; generation: number } };
}

export interface World {
	scope: Scope;
	conversationId: string;
	connectionId: string;
}

export type Attachment = StartRun["message"]["attachments"][number];
/** One of the fake model's turns (src/model/fake.ts): its text, its tool calls, or `note`, the run's note as its answer. */
export type Turn = { text?: string; tools?: { name: string; arguments: { [key: string]: unknown } }[]; note?: true };
export type LocalCard = { tool: string; summary: string; ok: boolean; excerpt: string };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A UUIDv7, for the ids Laravel makes. */
export function uuid7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const now = BigInt(Date.now());
	for (let i = 0; i < 6; i++) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function driver<T>(op: string, body: { [key: string]: unknown }): Promise<T> {
	const reply = await fetchDeployed(`${worker.origin}/api/faults/${op}`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60_000,
	});
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as T;
}

/** Laravel's commands, as oRPC's client of the contract sends them, to the test Worker's driver with its token. */
export const commands: JsonifiedClient<ContractRouterClient<typeof engine>> = createORPCClient(
	new OpenAPILink(engine, {
		url: `${worker.origin}/api/faults`,
		fetch: async (request) => {
			const headers = Object.fromEntries(request.headers);
			const reply = await fetchDeployed(request.url, { method: request.method, headers: { ...headers, [FAULTS_HEADER]: token }, body: await request.text(), timeoutMs: 120_000 });
			return new Response(reply.text === "" ? null : reply.text, { status: reply.status, headers: reply.headers });
		},
	}),
);

const worlds = new Set<World>();
const runs: { w: World; runId: string }[] = [];

/**
 * A workspace with the fake Notes connection Laravel holds, its provider's folders (`folders`, or inbox and archive with three
 * notes), and a conversation with the faults asked for, its model (`workers-ai`, `fake-remote`, `route`, or the fake by
 * default) and the perf probe's calibration (src/faults/ports.ts).
 */
export async function world(
	options: {
		faults?: Fault[];
		delays?: { [prefix: string]: number };
		model?: string;
		calibrate?: { bytes: number; write: boolean };
		retention?: Retention;
		folders?: { id: string; name: string; notes: string[] }[];
	} = {},
): Promise<World> {
	const scope: Scope = { environment: FAULTS_SETTINGS.MINERVA_ENVIRONMENT, organization: uuid7(), workspace: uuid7() };
	const { connectionId } = await driver<{ connectionId: string }>("setup", { scope, delays: options.delays ?? {}, ...(options.folders ? { folders: options.folders } : {}) });
	const conversationId = uuid7();
	await driver("conversation", {
		scope,
		conversationId,
		faults: options.faults ?? [],
		model: options.model ?? null,
		calibrate: options.calibrate ?? null,
		retention: options.retention ?? null,
	});
	const made = { scope, conversationId, connectionId };
	worlds.add(made);
	return made;
}

function base(w: World) {
	return { scope: w.scope, conversationId: w.conversationId };
}

/** Stages a file as Laravel's signed upload does, and answers it as a start attaches it. */
export async function upload(w: World, file: { name: string; text?: string; bytes?: number; fill?: number }): Promise<Attachment> {
	const { upload: key, size } = await driver<{ upload: string; size: number }>("stage", { scope: w.scope, text: file.text, bytes: file.bytes, fill: file.fill });
	return { upload: key, name: file.name, size, mediaType: file.bytes ? "application/octet-stream" : "text/plain" };
}

/** µ$ no test run spends: what every other start allows, so the suites run their turns both with and without admission. */
export const LARGE_ALLOWANCE = 1_000_000_000_000;
let starts = 0;

export type HistoryMessage = StartRun["history"][number];

/** A start's authority once the user's connection was removed: no connection, and no grant. */
export const NO_CONNECTIONS: StartRun["authority"] = { connections: [], layers: { ceiling: null, user: { restricted: true, revision: 1, grants: [] }, agent: null } };

export type StartOptions = {
	allowance?: number | null;
	history?: HistoryMessage[];
	message?: string;
	authority?: StartRun["authority"];
	attended?: true;
	approval?: StartRun["approval"];
};

/**
 * Sends a message as Laravel does: the fake Laravel holds the run, then `startRun` names the agent's Notes connection, which the
 * user may use in every folder, to read and create (unless `authority` says otherwise), and gives it `allowance` (µ$; none when
 * null; by default, LARGE_ALLOWANCE with every other start), and the conversation's earlier messages as Laravel sends them
 * (`history`, none by default); `attended` when a person made the start, so a call a layer asks before is held, and
 * `approval` for a continuation. Answers the run's id; a refusal throws.
 */
export async function post(w: World, content: string, attachments: Attachment[] = [], options: StartOptions = {}): Promise<string> {
	const start = startOf(w, content, attachments, options);
	const answer = await send(w, start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	return start.run;
}

/** The start `post` sends, not sent, so a test can send the same one again. */
export function startOf(w: World, content: string, attachments: Attachment[] = [], options: StartOptions = {}): StartRun {
	const allowance = options.allowance !== undefined ? options.allowance : starts++ % 2 === 0 ? LARGE_ALLOWANCE : null;
	return {
		scope: w.scope,
		conversation: w.conversationId,
		run: uuid7(),
		user: USER,
		agent: { id: AGENT, instructions: "You are a test agent. Use the tools when asked.", model: "default" },
		message: { id: options.message ?? uuid7(), content, attachments },
		history: options.history ?? [],
		authority: options.authority ?? { connections: [notesConnection(w.connectionId)], layers: notesLayers(w.connectionId) },
		...(allowance === null ? {} : { allowance }),
		...(options.attended ? { attended: true as const } : {}),
		...(options.approval ? { approval: options.approval } : {}),
	};
}

/** Holds the start's run in the fake Laravel and sends it; the engine's answer, refusals included. */
export async function send(w: World, start: StartRun): Promise<Awaited<ReturnType<typeof commands.startRun>>> {
	await driver("hold", { ...base(w), runId: start.run, run: heldRun(start) });
	const answer = await sendStart(start);
	if (answer.outcome === "accepted" && !runs.some((sent) => sent.runId === start.run)) runs.push({ w, runId: start.run });
	return answer;
}

/**
 * Laravel's SendStart: a start the engine answered 5xx is sent again after a backoff (a start is answered once, whatever the
 * tries), as when the platform drops a connection mid-start. A third 5xx throws.
 */
async function sendStart(start: StartRun): Promise<Awaited<ReturnType<typeof commands.startRun>>> {
	for (let tries = 1; ; tries++) {
		try {
			return await commands.startRun(start);
		} catch (error) {
			if (!(error instanceof ORPCError) || error.status < 500 || tries === 3) throw error;
			console.warn(`startRun ${start.run}: ${error.status} ${error.message}; sent again`);
			await sleep(1_000 * tries);
		}
	}
}

/** Laravel's cancel of the run: the user's stop (`cancelled`) or a revocation (`permissions_changed`, among others). */
export function cancel(w: World, runId: string, reason: CancelReason): Promise<CancelRunResult> {
	return commands.cancelRun({ scope: w.scope, conversation: w.conversationId, run: runId, reason });
}

/** The fake model's script for a message. */
export function script(turns: Turn[], extra: { chunkChars?: number; delayMs?: number } = {}): string {
	return JSON.stringify({ fake: { turns, ...extra } });
}

/** The run with every event up to its head's `eventSeq` when first read, a page at a time. */
export async function run(w: World, runId: string): Promise<RunView> {
	const first = await driver<RunView>("run", { ...base(w), runId });
	if (first.head === null) return first;
	const upTo = first.head.eventSeq;
	const events = [...first.events];
	while ((events.at(-1)?.seq ?? 0) < upTo) {
		const page = await driver<RunView>("run", { ...base(w), runId, after: events.at(-1)?.seq ?? 0, upTo });
		if (!page.events.length) break;
		events.push(...page.events);
	}
	return { ...first, events };
}

/**
 * How long to wait for a turn of a real model that makes up to `calls` model calls: 120 s a call, the longest the engine
 * waits for a call's answer to start (model/route.ts `QUIET_MS`, which its Workers types keep out of this typecheck).
 * A budget, not a bound: streaming and tools come on top, and Workers AI's first token alone takes most of it at times.
 * Measured on 2026-10-16 in 20 turns of turns.test.ts: 16 took 13 to 27 s; in 4, every call waited 34 to 82 s for its
 * first token and then streamed as fast as in the others, so those turns took 141 to 228 s.
 */
export const modelDeadline = (calls: number) => calls * 120_000;

/**
 * Polls until the run has ended. A poll is an event that may wake an object a fault reset, and polls fail
 * while one restarts, so failures are tolerated until the deadline, which reports the last of them.
 */
export async function settled(w: World, runId: string, timeoutMs = 300_000): Promise<RunView & { seconds: number }> {
	const started = Date.now();
	let last: RunView | null = null;
	let failure: unknown = null;
	for (;;) {
		try {
			last = await run(w, runId);
			failure = null;
			if (last.head && !ACTIVE.includes(last.head.status)) return { ...last, seconds: (Date.now() - started) / 1000 };
		} catch (error) {
			failure = error;
		}
		if (Date.now() - started > timeoutMs) throw new Error(`The run did not end; last: ${JSON.stringify(last?.head)}${failure ? `; last poll: ${String(failure)}` : ""}`);
		await sleep(1000);
	}
}

export async function provider(w: World): Promise<ProviderState> {
	return driver<ProviderState>("provider", { scope: w.scope });
}

/** What the world's fake Laravel holds of its conversation: the facts it applied, its calls, its connections. */
export async function laravel(w: World): Promise<LaravelState> {
	return driver<LaravelState>("laravel", base(w));
}

/**
 * The conversation's facts once the run's `run.settled` has reached the fake Laravel: the engine writes it after the run's
 * `run.finished` and every settlement of its calls, so it is the run's last fact. It waits for the run's seal, which the
 * Sandbox serves after any lifecycle step in flight: a container's start (READY_MS, 90 s) and destroy (DESTROY_MS, 60 s),
 * with the settlement job asking again 40 s after a seal it gave up on (src/sandbox/core.ts, src/conversation/conversation.ts).
 * Seen on the test instance after memory resets: the Sandbox's calls in flight took 60 s, and run.settled came 80 s after
 * run.finished.
 */
export async function delivered(w: World, runId: string, timeoutMs = 240_000): Promise<Fact[]> {
	const started = Date.now();
	for (;;) {
		const { facts } = await laravel(w);
		if (facts.some((fact) => fact.run === runId && fact.type === "run.settled")) return facts;
		if (Date.now() - started > timeoutMs) throw new Error(`The run's run.settled never reached Laravel; its facts: ${JSON.stringify(facts.map((fact) => [fact.seq, fact.type]))}`);
		await sleep(1000);
	}
}

const ACCOUNTING: readonly string[] = ["run.usage", "run.unmetered", "run.settled"];

/** The run's `run.finished`, once delivered; only the accounting of the run's calls may follow it. */
export async function finished(w: World, runId: string): Promise<Fact | undefined> {
	const facts = (await delivered(w, runId)).filter((fact) => fact.run === runId);
	const at = facts.findIndex((fact) => fact.type === "run.finished");
	const after = facts.slice(at + 1).filter((fact) => !ACCOUNTING.includes(fact.type));
	if (after.length) throw new Error(`Facts after the run's run.finished: ${JSON.stringify(after.map((fact) => [fact.seq, fact.type]))}`);
	return facts[at];
}

/** The conversation object's storage: `databaseSize`, per table its rows and the bytes of its TEXT and BLOB columns, and its alarm. */
export function storage(w: World): Promise<{ databaseSize: number; tables: { [table: string]: { rows: number; bytes: number } }; alarm: number | null }> {
	return driver("storage", base(w));
}

/** Periods of retention for one conversation, in ms, instead of the engine's (src/conversation/retention.ts, RETENTION). */
export type Retention = Partial<{ runMs: number; factsMs: number; deletedMs: number; busyMs: number; blockedMs: number; passMs: number; rowsPerStep: number }>;

/** The facts the conversation's object holds, and its delivery's watermarks (null before its first fact). */
export function heldFacts(w: World): Promise<{ count: number; lowest: number | null; highest: number | null; delivery: { written: number; acknowledged: number; floor: number } | null }> {
	return driver("facts", base(w));
}

/** The conversation object's scheduled host jobs, by id. */
export function jobs(w: World): Promise<{ id: string; fn: string }[]> {
	return driver("jobs", base(w));
}

/** The conversation's fault points that fired, in order, with the object's clock (`at`) and their detail. */
export function fired(w: World): Promise<{ point: string; mode: string; at: number; detail: string }[]> {
	return driver("fired", base(w));
}

/** The conversation's faults and periods replaced, and its `retain` job made due now. */
export async function retainNow(w: World, faults: Fault[], retention: Retention): Promise<void> {
	await driver("retain", { ...base(w), faults, retention });
}

/** The fake Laravel answers the next `deliveries` deliveries of facts 503; 0 lets them through again. */
export async function failDeliveries(w: World, deliveries: number): Promise<void> {
	await driver("laravel-fail", { scope: w.scope, deliveries });
}

/** How many objects the conversation has in R2, up to 1,000. */
export async function objects(w: World): Promise<number> {
	return (await driver<{ count: number }>("objects", base(w))).count;
}

/** A step of the scratch table beside the conversation's (src/faults/index.ts `faultScratch`); `databaseSize` after it. */
export function scratch(w: World, step: "fill" | "trim" | "drop"): Promise<{ databaseSize: number }> {
	return driver("scratch", { ...base(w), step });
}

/** The conversation's current folder, as Laravel reads it. */
export function folder(w: World) {
	return commands.folder({ scope: w.scope, conversation: w.conversationId, version: null });
}

/** A file of the current folder as a download reads it: the object `resolveDownload` names, the first 4,000 characters of it. */
export async function file(w: World, path: string): Promise<{ size: number | null; text: string | null }> {
	const resolved = await commands.resolveDownload({ scope: w.scope, conversation: w.conversationId, version: null, path });
	if (resolved.outcome !== "found") throw new Error(`${path} is not in the folder.`);
	return driver("object", { ...base(w), key: resolved.key });
}

/** Waits until the conversation's container is gone (the end of a run that did not complete destroys it); how long that took. */
export function destroyed(w: World, timeoutMs = 120_000): Promise<number> {
	return containerIs(w, ["none"], timeoutMs);
}

/** Waits until the conversation's container is parked for its next run (a completed turn parks it); how long that took. */
export function parked(w: World, timeoutMs = 120_000): Promise<number> {
	return containerIs(w, ["parked"], timeoutMs);
}

async function containerIs(w: World, states: string[], timeoutMs: number): Promise<number> {
	const started = Date.now();
	for (;;) {
		const answer = await driver<{ status: { state: string }; running: boolean }>("conversation-sandbox", base(w));
		if (states.includes(answer.status.state) && answer.running === (answer.status.state !== "none")) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`The container is not ${states.join(" or ")}: ${JSON.stringify(answer)}`);
		await sleep(1000);
	}
}

/** A conversation purged by its retention: no run or container of it is left to stop, so the cleanup leaves it out. */
export function purged(w: World): void {
	worlds.delete(w);
	for (let index = runs.length - 1; index >= 0; index--) if (runs[index]?.w === w) runs.splice(index, 1);
}

/** How many runs the cleanup checks at once: a perf probe's thousand runs of one conversation, all at once, overload its object. */
const DRAIN_AT_ONCE = 50;

/**
 * Cleanup, each file's afterAll (`finish`): stops every run this file started that has not ended (a failed or
 * timed-out test leaves them going), waits for each to end, then until every conversation's container is
 * gone or parked. Every one is tried; the failures are reported together.
 */
async function drain(): Promise<string[]> {
	const stop = async ({ w, runId }: { w: World; runId: string }) => {
		const view = await run(w, runId).catch(() => null);
		if (!view?.head || ACTIVE.includes(view.head.status)) await cancel(w, runId, "cancelled").catch(() => null);
		await settled(w, runId, 120_000);
	};
	const stopped: PromiseSettledResult<void>[] = [];
	for (let at = 0; at < runs.length; at += DRAIN_AT_ONCE) stopped.push(...(await Promise.allSettled(runs.slice(at, at + DRAIN_AT_ONCE).map(stop))));
	// A parked container is destroyed by its Sandbox a few minutes later, when no run takes it.
	const gone = await Promise.allSettled([...worlds].map((w) => containerIs(w, ["none", "parked"], 120_000)));
	return [...stopped, ...gone].filter((outcome) => outcome.status === "rejected").map((outcome) => String(outcome.reason));
}

/**
 * "Nothing runs after": after a run that ended by the attempts' cap, the provider must see no request for
 * 45 s, past a 30 s heartbeat of PiHarness and its alarm, which would resume a run the cap had not stopped.
 * A test records the check with `later` when its run has ended, and the file's afterAll (`finish`) waits only
 * for what is left of each 45 s, so no test sleeps through it, and a test picked alone with `-t` is still
 * checked.
 */
const QUIET_MS = 45_000;
const quietChecks: { name: string; endedAt: number; check: () => Promise<void> }[] = [];

export function later(name: string, check: () => Promise<void>): void {
	quietChecks.push({ name, endedAt: Date.now(), check });
}

async function quiet(): Promise<string[]> {
	const failures = await Promise.all(
		quietChecks.map(async ({ name, endedAt, check }) => {
			await sleep(Math.max(0, endedAt + QUIET_MS - Date.now()));
			return check().then(
				() => null,
				(error: unknown) => `nothing runs after ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}),
	);
	return failures.filter((failure) => failure !== null);
}

/** Each file's afterAll: the checks `later` recorded, then the cleanup; their failures fail the file together. */
export async function finish(): Promise<void> {
	const failures = [...(await quiet()), ...(await drain())];
	if (failures.length) throw new Error(failures.join("\n"));
}

/** What a failed status check reports of the run: why it ended, its attempts, and the faults that fired. */
export function outcome(view: RunView): string {
	const { head, internals, fired } = view;
	return JSON.stringify({ status: head?.status, errorMessage: head?.errorMessage, run: internals.run, attempts: internals.attempts, fired });
}

export function restarts(events: RunEvent[]): number[] {
	return events.filter((event) => event.type === "status" && typeof event.data.attempt === "number").map((event) => event.data.attempt as number);
}

/**
 * Whether the platform itself replaced the conversation's instance during the run, as it rarely does: the run restarted once,
 * attempt 2's model calls came from an instance that made none of attempt 1's, and no instance asked for a reset, as the
 * engine's resets and the faults' all do.
 */
export function replacedByPlatform(view: RunView): boolean {
	const madeIn = (attempt: number) => view.internals.calls.filter((call) => call.attempt === attempt).map((call) => call.instance);
	const first = madeIn(1);
	const second = madeIn(2);
	const restarted = restarts(view.events);
	return restarted.length === 1 && restarted[0] === 2 && view.aborts.length === 0 && first.length > 0 && second.length > 0 && second.every((instance) => !first.includes(instance));
}

export function toolCalls(events: RunEvent[]) {
	return events.filter((event) => event.type === "tool_call").map((event) => event.data);
}

export function reads(state: ProviderState): number {
	return state.requests.filter((request) => request.method === "GET" && request.path === "/folders/inbox/notes").length;
}

export function cards(events: RunEvent[]): LocalCard[] {
	return events.filter((event) => event.type === "local_tool").map((event) => event.data as unknown as LocalCard);
}

export const LIST_INBOX: Turn = { tools: [{ name: LIST, arguments: { folder: "inbox" } }] };
export const save = (title: string): Turn => ({ tools: [{ name: SAVE, arguments: { folder: "inbox", title } }] });

/** The Notes layers of a user who may read every folder and must approve each note saved. */
export function askingToSave(w: World): StartRun["authority"] {
	const layers = notesLayers(w.connectionId, [
		{ kind: FOLDER, resource: "*", name: "", actions: ["read"], effect: "allow" },
		{ kind: FOLDER, resource: "*", name: "", actions: ["create"], effect: "ask" },
	]);
	return { connections: [notesConnection(w.connectionId)], layers };
}
export const local = (name: string, args: { [key: string]: unknown }): Turn => ({ tools: [{ name, arguments: args }] });
export const sh = (command: string): Turn => local("bash", { command });
