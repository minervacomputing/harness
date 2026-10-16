// The test Worker's fault driver (src/faults/routes.ts), shared by the account suites that run turns on the test instance:
// faults.test.ts, resets.test.ts, turns.test.ts and perf.test.ts. Each world is a Laravel workspace of its own (`scope`), with the fake
// Notes provider and the fake Laravel its FaultProvider hosts, and a conversation in the EU, as Laravel's are. The driver
// sets the world up and reads it (`POST /api/faults/<op>`); the runs go through Laravel's own commands, oRPC's client of the
// contract's `engine` at /api/faults/internal/, which the test Worker serves behind its token as /internal/ is served
// behind Access. A run is held by the fake Laravel before its start, as Laravel holds a run before it sends one.
//
// Every world and run made here is remembered, so each file can `drain()` in its afterAll: stop the runs still
// going and wait until every conversation's container is gone. The memory-limit resets (resets.test.ts) take
// every object of their isolate with them, so they run only after every other file has finished
// (vitest.faults.config.ts): by then those files' results are in, and a reset can only cut short what a
// failed test left behind.

import { type CancelReason, type CancelRunResult, type Fact, type Scope, type StartRun, engine } from "@minerva/contract/internal";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { FAULTS_SETTINGS } from "../../src/faults/settings.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { heldRun, notesConnection, notesLayers } from "../../src/faults/world.ts";
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
		writes: { key: string; status: string; attempt: number }[];
		executions: { call_id: string; executions: number }[];
		entered: { model: number; tool: number };
		/** Each model call's marks, in the object's Date.now() milliseconds (src/faults/ports.ts, `CallMarks`). */
		marks: { begin: number; answered: number | null; last: number | null }[];
	};
	fired: { point: string; mode: string; at: number }[];
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
export type Turn = { text?: string; tools?: { name: string; arguments: { [key: string]: unknown } }[] };
export type LocalCard = { tool: string; summary: string; ok: boolean; excerpt: string };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A UUIDv7, for the ids Laravel makes. */
function uuid7(): string {
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
 * A workspace with the fake Notes connection Laravel holds, and a conversation with the faults asked for, its model
 * (`workers-ai`, `fake-remote`, or the fake by default) and the perf probe's calibration (src/faults/ports.ts).
 */
export async function world(
	options: { faults?: Fault[]; delays?: { [prefix: string]: number }; model?: string; calibrate?: { bytes: number; write: boolean } } = {},
): Promise<World> {
	const scope: Scope = { environment: FAULTS_SETTINGS.MINERVA_ENVIRONMENT, organization: uuid7(), workspace: uuid7() };
	const { connectionId } = await driver<{ connectionId: string }>("setup", { scope, delays: options.delays ?? {} });
	const conversationId = uuid7();
	await driver("conversation", { scope, conversationId, faults: options.faults ?? [], model: options.model ?? null, calibrate: options.calibrate ?? null });
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

/**
 * Sends a message as Laravel does: the fake Laravel holds the run, then `startRun` names the agent's Notes connection, which the
 * user may use in every folder, to read and create. Answers the run's id; a refusal throws.
 */
export async function post(w: World, content: string, attachments: Attachment[] = []): Promise<string> {
	const start: StartRun = {
		scope: w.scope,
		conversation: w.conversationId,
		run: uuid7(),
		user: USER,
		agent: { id: AGENT, instructions: "You are a test agent. Use the tools when asked.", model: "default" },
		message: { id: uuid7(), content, attachments },
		history: [],
		authority: { connections: [notesConnection(w.connectionId)], layers: notesLayers(w.connectionId) },
	};
	await driver("hold", { ...base(w), runId: start.run, run: heldRun(start) });
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	runs.push({ w, runId: start.run });
	return start.run;
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

/** Waits until the conversation's container is gone (the run's end destroys it); how long that took. */
export async function destroyed(w: World, timeoutMs = 120_000): Promise<number> {
	const started = Date.now();
	for (;;) {
		const answer = await driver<{ status: { state: string }; running: boolean }>("conversation-sandbox", base(w));
		if (answer.status.state === "none" && !answer.running) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`The container was not destroyed: ${JSON.stringify(answer)}`);
		await sleep(1000);
	}
}

/**
 * Cleanup, each file's afterAll (`finish`): stops every run this file started that has not ended (a failed or
 * timed-out test leaves them going), waits for each to end, then until every conversation's container is
 * gone. Every one is tried; the failures are reported together.
 */
async function drain(): Promise<string[]> {
	const stopped = await Promise.allSettled(
		runs.map(async ({ w, runId }) => {
			const view = await run(w, runId).catch(() => null);
			if (!view?.head || ACTIVE.includes(view.head.status)) await cancel(w, runId, "cancelled").catch(() => null);
			await settled(w, runId, 120_000);
		}),
	);
	const gone = await Promise.allSettled([...worlds].map((w) => destroyed(w)));
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
export const local = (name: string, args: { [key: string]: unknown }): Turn => ({ tools: [{ name, arguments: args }] });
export const sh = (command: string): Turn => local("bash", { command });
