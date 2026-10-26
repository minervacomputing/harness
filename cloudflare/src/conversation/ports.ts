// What the Conversation Durable Object runs against besides its own tables: the executor, the write ledger,
// the folder, the network, the sandbox and the model. Each is an interface here, so the object is tested with
// fakes; `defaultPorts` wires the real ones: gateway/'s executor and its ledger and page tokens in this
// object's SQLite through lib/sql.ts. Tests and the test build (src/faults/) set `PORTS.factory`; the tests
// run in the Worker's isolate.

import { sandboxObject } from "../addressing.ts";
import { settings } from "../config.ts";

import { conversationFolder } from "../files/folder.ts";
import { COPY_BOUND_MS } from "../files/limits.ts";
import type { AttachmentCopies, AttachmentPlan, CheckpointOutcome, CheckpointScan, CommittedAttachments, DownloadTarget } from "../files/store.ts";
import type { InspectedUpload, ReservedUpload, StagedUpload } from "../files/staging.ts";
import { systemClock } from "../gateway/clock.ts";
import { type Executor, type ExecutorContext, createExecutor } from "../gateway/executor.ts";
import { RunBrowser } from "../gateway/http.ts";
import { type DispatchResult, RUN_ENDED_MESSAGE, type SettledWrite, type Settlement, type WriteNote, WriteLedger as GatewayLedger } from "../gateway/ledger.ts";
import { PageTokens } from "../gateway/page-tokens.ts";
import type { Registry } from "../gateway/registry.ts";
import type { RunStatePort } from "../gateway/run-state.ts";
import { durableSql } from "../lib/sql.ts";
import { type ModelRoute, type Upstream, upstreamOf } from "../model/route.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult, HydratePlan } from "../sandbox/folder.ts";
import type { Folder } from "@minerva/contract";
import { type AttemptFence, type ConversationId, type EpochMs, type Outcome, type RunId, type RunStatus, type Sha256, type VersionId, type WorkspaceRef, refuse } from "../shared/rpc.ts";
import type { GateDecision } from "./gate.ts";
import type { SandboxPort } from "./local-run.ts";
import { PI_SETTLE_MS } from "./pi-stops.ts";
import { RETENTION, type RetentionPeriods } from "./retention.ts";
import type { Published, RunStore } from "./store.ts";

/**
 * The write ledger and page tokens (ARCHITECTURE.md: Writes), in this object's SQLite, built with the executor (gateway/). The object composes the executor's `RunStatePort`
 * from its own run checks and these, and calls the two maintenance methods itself.
 */
export interface WriteLedger extends Pick<RunStatePort, "knownWrite" | "resolvePageToken" | "issuePageToken"> {
	/** Synchronous: the run check and the claim in one stretch (RunStatePort's waits before calling it). */
	dispatchWrite(fence: AttemptFence, key: string, note?: WriteNote): DispatchResult;
	settleWrite(runId: RunId, key: string, settlement: Settlement): void;
	/**
	 * In the attempt gate's transaction: every write of the run still `dispatched` becomes `uncertain` (the
	 * instance that dispatched it died and can never settle it), and the run's later writes pause. Returns
	 * how many were marked.
	 */
	markDispatchedUncertain(runId: RunId): number;
	/**
	 * The lost-write sweep, on an alarm: writes still dispatched 30 s past their deadline become uncertain.
	 * Returns the runs affected and when to sweep next, null when nothing is dispatched.
	 */
	sweepLostWrites(now: EpochMs): { uncertain: RunId[]; nextAt: EpochMs | null };
}

/** What the ledger reads and writes of the run itself (`writes_uncertain` is a run column). */
export interface LedgerRuns {
	isCurrent(fence: AttemptFence): boolean;
	deadline(runId: RunId): EpochMs | null;
	writesUncertain(runId: RunId): boolean;
	markWritesUncertain(runId: RunId): void;
	/** In the transaction that settled it: a write's outcome, for the run's `run.write` fact. */
	writeSettled(write: SettledWrite, outcome: WriteOutcome): void;
}

/** How a write settled, as a `run.write` fact says it. */
export type WriteOutcome = "done" | "failed" | "uncertain";

const OUTCOMES: Record<Settlement["effect"], WriteOutcome> = { applied: "done", not_applied: "failed", unknown: "uncertain" };

/**
 * The run's folder (ARCHITECTURE.md: Starting a run, Checkpoints, Files; src/files/). A start inspects its staged uploads
 * and plans them inside the transaction that stores its run; the run's copy measures them in full, copies them into the
 * conversation's blobs (recorded as loose first) and commits them in one write. `publish` runs in `finish`'s transaction.
 * The sandbox hydrates from `hydratePlan` and saves with `checkpoint`; `sweep` is the `files` Lifecycle job.
 */
export interface FolderPort {
	/** Laravel's staged uploads by their sizes and heads (files/staging.ts); null when any is missing or not as declared. */
	inspectStaged(staged: readonly StagedUpload[], uploadBytes: number): Promise<InspectedUpload[] | null>;
	/** Laravel's staged uploads read in full, counted and hashed, into uploads `copyAttachments` copies; null as for `inspectStaged`. */
	measureStaged(staged: readonly StagedUpload[], uploadBytes: number): Promise<ReservedUpload[] | null>;
	/** Deletes staged uploads a run copied; R2's lifecycle rule deletes any left after a day. */
	deleteStaged(keys: readonly string[]): Promise<void>;
	/** Synchronous, inside the start's transaction: the uploads at the folder's root, checked against its limits. */
	planAttachments(uploads: readonly InspectedUpload[]): Outcome<AttachmentPlan>;
	copyAttachments(runId: RunId, uploads: readonly ReservedUpload[]): Promise<Outcome<AttachmentCopies>>;
	/** Synchronous, inside the copy's write: the base version with the copies, claiming their loose keys, while the fence is current. */
	commitAttachments(fence: AttemptFence, plan: AttachmentPlan, hashes: readonly Sha256[], copies: AttachmentCopies): CommittedAttachments;
	/**
	 * Inside `finish`'s transaction: the last checkpoint, else the base, becomes the folder; with the bytes the
	 * conversation then keeps (`run.finished`'s `storedBytes`), absent when they cannot be summed.
	 */
	publish(runId: RunId, run: { baseVersionId: VersionId | null; checkpointVersionId: VersionId | null; status: RunStatus }): Published;
	list(versionId: VersionId | null): Folder | null;
	resolve(versionId: VersionId | null, path: string): DownloadTarget | null;
	/**
	 * Deletes a page of the conversation's objects in R2, at most 1,000, recorded or not (ARCHITECTURE.md: Files, Deletion);
	 * returns how many, 0 once none is left.
	 */
	deleteObjectsPage(): Promise<number>;
	/** What a new attempt of the run hydrates: its last checkpoint, else its base version, with each file's R2 key. */
	hydratePlan(runId: RunId): HydratePlan;
	/**
	 * A checkpoint of the run's folder from the container's scan (ARCHITECTURE.md: Checkpoints): validated, the files whose contents the run may not read uploaded by `upload` (the Sandbox's
	 * `checkpoint`, under keys recorded here first), then recorded for the fence's attempt on top of its
	 * last checkpoint. Outside pi's transactions; the caller releases held results only after `ok`.
	 */
	checkpoint(fence: AttemptFence, scan: CheckpointScan, upload: (plan: CheckpointUploadPlan) => Promise<CheckpointUploadResult>): Promise<CheckpointOutcome>;
	/** The `files` job: deletes loose and unnamed objects (twice, a day apart) and reports the byte total; when to run next. */
	sweep(): Promise<{ rescheduleAt: EpochMs } | undefined>;
}

export interface PortsContext {
	env: Env;
	ctx: DurableObjectState;
	workspace: WorkspaceRef;
	conversationId: ConversationId;
	/** The organization of a conversation Laravel's commands made; null for the Workspace's. */
	organization: string | null;
	/** The folder version the conversation holds now. */
	folderVersionId: () => VersionId | null;
	/** The connector registry, loaded in the harness factory before any run's tools are built. */
	connectors: () => Registry;
	/** The object's records: its run checks, `outside` and its clock (the folder fences and commits through them). */
	store: RunStore;
	/** Runs the folder's sweep (`FolderPort.sweep`) at `at`, unless it is due earlier already. */
	schedule(at: EpochMs): void;
}

export interface ConversationPorts {
	/** One per run and instance, with the run's snapshot (gateway/executor.ts). */
	executor(run: ExecutorContext, context: PortsContext): Executor;
	ledger(storage: DurableObjectStorage, runs: LedgerRuns, context: PortsContext): WriteLedger;
	folder(context: PortsContext): FolderPort;
	/** The model behind the wrapper, for a route read at each call. */
	upstream(route: ModelRoute, context: PortsContext): Upstream;
	/** The network the executor's provider requests go out on. */
	fetch(context: PortsContext): typeof fetch;
	browser(context: PortsContext): RunBrowser | null;
	/** The conversation's Sandbox Durable Object (src/sandbox/), a new stub each time; the platform tests give a fake. */
	sandbox(context: PortsContext): SandboxPort;
	/** The deadline a Laravel run starts with, in ms from its start; null for none. The setting, unless the test build's plan sets one. */
	runTimeoutMs(context: PortsContext): number | null;
	/** How long a start waits for pi's earlier work before the object resets (pi-stops.ts): PI_SETTLE_MS, unless the test build's plan sets one. */
	piSettleMs(context: PortsContext): number;
	/** How long after its run was stored a copy of its attachments that fails is tried again: COPY_BOUND_MS. */
	copyBoundMs(context: PortsContext): number;
	/** What the conversation keeps and how long (retention.ts): RETENTION, unless the test build's plan shortens it. */
	retention(ctx: DurableObjectState): RetentionPeriods;
	/**
	 * The test build's fault points in the attempt gate (src/faults/); production has none. `decided`: a
	 * decision is made, before its transaction. `committed`: after its transaction and the sync.
	 */
	gate?(context: PortsContext, point: "decided" | "committed", decision: GateDecision["kind"]): Promise<void>;
	/**
	 * The test build's count of what pi starts: a model call or a tool's execution, before any check, by the session the call
	 * names (its provider session for a model call, its pi session for a tool), which the test build attributes to a run.
	 */
	entered?(context: PortsContext, kind: "model" | "tool", session: string): void;
	/**
	 * The test build's fault points in the local tools, their checkpoints, the model calls and a run's settlement
	 * (src/faults/); production has none. `local:prepared` (the container ready and hydrated), `checkpoint:scanned`, `checkpoint:uploaded`
	 * (the files stored, the checkpoint not yet recorded), `checkpoint:recorded` (recorded, the results not
	 * yet released), `local:released` (a call's result released, before pi has it); `model:recorded`, `model:settle` and
	 * `model:settled` around a model call's record and settlement; `settle:sealed` and `settle:written` around the write of
	 * a run's `run.settled`; `retain:step` after each step of a retention pass, a purge's included, and `retain:pass` at a
	 * pass's start and end; `loop:created` between the
	 * creation of the conversation's pi conversation and the run's claim; `pi:stop` at a run's end, before it marks pi's orphaned work;
	 * `start:planned` between a start's inspection of its attachments and the transaction that stores its run; `copy:copied`
	 * between a run's copy of its attachments and the write that commits them.
	 */
	point?(context: PortsContext, name: string, detail?: string): Promise<void>;
	/**
	 * The test build's fault point for a step after the object's storage is deleted, which deletes the plan with it (a
	 * purge's `retain:step` `storage`): the fault is taken before the deletion and fired by the function returned.
	 */
	arm?(context: PortsContext, name: string, detail: string): () => Promise<void>;
}

/** No files: the folder stays as it is, and a message with attachments is refused (for tests of the rest). */
export const emptyFolder = (context: PortsContext): FolderPort => ({
	inspectStaged: async (staged) => (staged.length ? null : []),
	measureStaged: async (staged) => (staged.length ? null : []),
	deleteStaged: async () => {},
	planAttachments: (uploads) =>
		uploads.length
			? refuse("ATTACHMENT_UNAVAILABLE", "An attached file is no longer available. Remove it and attach it again.")
			: { ok: true, value: { parentId: context.folderVersionId(), attachments: [] } },
	copyAttachments: async () => ({ ok: true, value: { copies: [], reused: [], fresh: [] } }),
	commitAttachments: () => ({ ok: false, reason: "stale" }),
	publish: (_runId, run) => ({ resultVersionId: run.checkpointVersionId ?? run.baseVersionId, changes: null }),
	list: (versionId) => (versionId === null || versionId === context.folderVersionId() ? { versionId: context.folderVersionId(), files: [], dirs: [] } : null),
	resolve: () => null,
	deleteObjectsPage: async () => 0,
	hydratePlan: () => ({ versionId: context.folderVersionId(), files: [], dirs: [] }),
	checkpoint: async () => ({ ok: false, code: "stale", message: "This attempt is no longer the run's current one." }),
	sweep: async () => undefined,
});

/**
 * gateway/'s executor for one run: the shared registry, MINERVA_SECRET_KEY for the write ids events carry,
 * and `ctx.waitUntil`, which keeps a dispatched write's settle alive after its call was cancelled.
 */
export function gatewayExecutor(run: ExecutorContext, context: PortsContext): Executor {
	return createExecutor(run, {
		registry: context.connectors(),
		secretKey: context.env.MINERVA_SECRET_KEY,
		waitUntil: (promise) => context.ctx.waitUntil(promise),
	});
}

/**
 * gateway/'s write ledger and page tokens over this object's SQLite (ARCHITECTURE.md: Writes). The run checks are the
 * object's own, made in the same synchronous stretch as the claim; `writes_uncertain` mirrors the ledger's
 * uncertain rows, set in the same transaction whenever one appears.
 */
export function gatewayLedger(storage: DurableObjectStorage, runs: LedgerRuns): WriteLedger {
	const sql = durableSql(storage);
	const ledger = new GatewayLedger(sql, systemClock);
	const tokens = new PageTokens(sql);
	return {
		knownWrite: (runId, key) => ledger.known(runId, key),
		dispatchWrite: (fence, key, note) =>
			runs.isCurrent(fence) ? ledger.dispatch(fence, key, runs.deadline(fence.runId), note) : { kind: "refused", code: "RUN_ENDED", message: RUN_ENDED_MESSAGE },
		settleWrite: (runId, key, settlement) =>
			sql.transaction(() => {
				const settled = ledger.settle(runId, key, settlement);
				if (settled === null) return;
				if (settlement.effect === "unknown") runs.markWritesUncertain(runId);
				runs.writeSettled(settled, OUTCOMES[settlement.effect]);
			}),
		resolvePageToken: (runId, token, tool, queryHash) => tokens.resolve(runId, token, tool, queryHash),
		issuePageToken: (runId, tool, queryHash, cursor) => tokens.issue(runId, tool, queryHash, cursor),
		markDispatchedUncertain: (runId) =>
			sql.transaction(() => {
				const lost = ledger.markDispatchedUncertain(runId);
				if (lost.length) runs.markWritesUncertain(runId);
				for (const write of lost) runs.writeSettled(write, "uncertain");
				return lost.length;
			}),
		sweepLostWrites: (now) =>
			sql.transaction(() => {
				const lost = ledger.sweep(now);
				const uncertain = [...new Set(lost.map((write) => write.runId))];
				for (const runId of uncertain) runs.markWritesUncertain(runId);
				for (const write of lost) runs.writeSettled(write, "uncertain");
				return { uncertain, nextAt: ledger.nextSweepAt() };
			}),
	};
}

/**
 * The executor's RunStatePort for a Conversation: the store's checks, synchronous,
 * and the ledger's records. A claim and a settlement wait until no asynchronous transaction of pi's is open
 * (store.ts `outside`): made inside one, they would roll back with it, and a claim the executor was told
 * was dispatched would leave nothing for the restart gate to mark uncertain, so the same write could be sent
 * again. The run check and the claim still run in one synchronous stretch, after the wait.
 */
export function runStatePort(store: RunStore, ledger: () => WriteLedger, dispatched: (runId: RunId) => void): RunStatePort {
	return {
		isCurrent: (fence) => store.isCurrent(fence),
		isActive: (runId) => store.isActive(runId),
		countToolCall: (fence) => store.countToolCall(fence),
		knownWrite: (runId, key) => ledger().knownWrite(runId, key),
		dispatchWrite: (fence, key, note) =>
			store.outside(() => {
				const result = ledger().dispatchWrite(fence, key, note);
				if (result.kind === "dispatched") dispatched(fence.runId);
				return result;
			}),
		settleWrite: (runId, key, settlement) => store.outside(() => ledger().settleWrite(runId, key, settlement)),
		resolvePageToken: (runId, token, tool, queryHash) => ledger().resolvePageToken(runId, token, tool, queryHash),
		issuePageToken: (runId, tool, queryHash, cursor) => ledger().issuePageToken(runId, tool, queryHash, cursor),
	};
}

export const defaultPorts: ConversationPorts = {
	executor: gatewayExecutor,
	ledger: (storage, runs) => gatewayLedger(storage, runs),
	folder: conversationFolder,
	upstream: (route, { env }) => upstreamOf(route, (env as { AI?: Ai }).AI),
	fetch: () => (input, init) => fetch(input, init),
	browser: ({ env }) => {
		const binding = (env as { BROWSER?: BrowserRun }).BROWSER;
		return binding ? new RunBrowser(binding) : null;
	},
	sandbox: ({ env, ctx, workspace, conversationId }) => sandboxObject(env, ctx.exports, workspace, conversationId) as unknown as SandboxPort,
	runTimeoutMs: ({ env }) => settings(env).runTimeoutMs,
	piSettleMs: () => PI_SETTLE_MS,
	copyBoundMs: () => COPY_BOUND_MS,
	retention: () => RETENTION,
};

/** The ports every Conversation object uses; tests replace `factory`. */
export const PORTS: { factory: (env: Env) => ConversationPorts } = { factory: () => defaultPorts };
