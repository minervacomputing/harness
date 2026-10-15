// The test Worker's fault driver (src/faults/routes.ts: `POST /api/faults/<op>` behind its token), shared by
// the account suites that run turns on the test instance: faults.test.ts, resets.test.ts and turns.test.ts.
// Each world is a workspace of its own, with the fake Notes connection and an agent.
//
// Every world and run made here is remembered, so each file can `drain()` in its afterAll: stop the runs still
// going and wait until every conversation's container is gone. The memory-limit resets (resets.test.ts) take
// every object of their isolate with them, so they run only after every other file has finished
// (vitest.faults.config.ts): by then those files' results are in, and a reset can only cut short what a
// failed test left behind.

import { expect } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

const worker = testWorker();
const token = await faultsToken(worker.secretKey);
const USER = "0199a000-0000-7000-8000-0000000fa017";
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
	};
	fired: { point: string; mode: string; at: number }[];
}

export interface ProviderState {
	notes: { id: number; folder: string; title: string }[];
	requests: { seq: number; at: number; method: string; path: string; token: string; status: number }[];
	rotations: number;
}

export interface World {
	workspace: { id: string; jurisdiction: null };
	conversationId: string;
	connectionId: string;
}

export type Turn = { text?: string; tools?: { name: string; arguments: { [key: string]: unknown } }[] };
export type LocalCard = { tool: string; summary: string; ok: boolean; excerpt: string };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const worlds = new Set<World>();
const runs: { w: World; runId: string }[] = [];

/** A workspace with the fake Notes connection, an agent and a conversation, with the faults asked for. */
export async function world(options: { faults?: Fault[]; workspaceFaults?: Fault[]; expired?: boolean; delays?: { [prefix: string]: number }; model?: string } = {}): Promise<World> {
	const workspace = { id: uuid7(), jurisdiction: null };
	const owner = { workspace, userId: USER };
	const { connectionId, agentId } = await driver<{ connectionId: string; agentId: string }>("setup", { ...owner, expired: options.expired === true, delays: options.delays ?? {} });
	if (options.workspaceFaults) await driver("workspace-faults", { ...owner, faults: options.workspaceFaults });
	const { conversationId } = await driver<{ conversationId: string }>("conversation", { ...owner, agentId, faults: options.faults ?? [], model: options.model ?? null });
	const made = { workspace, conversationId, connectionId };
	worlds.add(made);
	return made;
}

export function base(w: World) {
	return { workspace: w.workspace, userId: USER, conversationId: w.conversationId };
}

/** Uploads a file to the world's workspace, for a message to attach. */
export async function upload(w: World, file: { name: string; text?: string; bytes?: number; fill?: number }): Promise<string> {
	const answer = await driver<{ ok: boolean; value?: { id: string } }>("upload", { workspace: w.workspace, userId: USER, ...file });
	if (!answer.ok || !answer.value) throw new Error(`Upload refused: ${JSON.stringify(answer)}`);
	return answer.value.id;
}

/** Posts a message and answers its run's id. */
export async function post(w: World, content: string, attachments?: string[]): Promise<string> {
	const outcome = await driver<{ ok: boolean; value?: { run: { id: string } }; refusal?: { detail: string } }>("post", { ...base(w), content, ...(attachments ? { attachments } : {}) });
	if (!outcome.ok || !outcome.value) throw new Error(`Refused: ${outcome.refusal?.detail ?? JSON.stringify(outcome)}`);
	runs.push({ w, runId: outcome.value.run.id });
	return outcome.value.run.id;
}

/** The fake model's script for a message. */
export function script(turns: Turn[], extra: { chunkChars?: number; delayMs?: number } = {}): string {
	return JSON.stringify({ fake: { turns, ...extra } });
}

export async function run(w: World, runId: string): Promise<RunView> {
	return driver<RunView>("run", { ...base(w), runId });
}

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
	return driver<ProviderState>("provider", { workspace: w.workspace, userId: USER });
}

export async function grants(w: World, changes: unknown[]) {
	return driver<{ ok: boolean; revocation: string; answered: number; started: number }>("grants", { workspace: w.workspace, userId: USER, connectionId: w.connectionId, changes });
}

export async function connection(w: World) {
	return driver<{ stored: { status: string; refresh_state: string } }>("connection", { workspace: w.workspace, userId: USER, connectionId: w.connectionId });
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
			if (!view?.head || ACTIVE.includes(view.head.status)) await driver("cancel", { ...base(w), runId }).catch(() => null);
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
