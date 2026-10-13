// What the Conversation Durable Object runs against besides its own tables: the Workspace Durable Object,
// the executor, the write ledger, the folder, the network and the model. Each is an interface here, so the
// object is tested with fakes; `defaultPorts` wires the real ones: the Workspace over typed RPC through
// addressing.ts (in the workspace's jurisdiction), gateway/'s executor and its ledger and page tokens in this
// object's SQLite through lib/sql.ts. Tests and the test build (src/faults/) set `PORTS.factory`; the tests
// run in the Worker's isolate.

import { sandboxObject, workspaceObject } from "../addressing.ts";

import { conversationFolder } from "../files/folder.ts";
import type { CheckpointOutcome, CheckpointScan, DownloadTarget, FolderUsage } from "../files/store.ts";
import type { ReservedUpload } from "../files/uploads.ts";
import { systemClock } from "../gateway/clock.ts";
import { type Executor, type ExecutorContext, createExecutor } from "../gateway/executor.ts";
import { type DispatchResult, RUN_ENDED_MESSAGE, type Settlement, WriteLedger as GatewayLedger } from "../gateway/ledger.ts";
import { PageTokens } from "../gateway/page-tokens.ts";
import type { Registry } from "../gateway/registry.ts";
import type { RunStatePort } from "../gateway/run-state.ts";
import { durableSql } from "../lib/sql.ts";
import { type ModelRoute, type Upstream, upstreamOf } from "../model/route.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult, HydratePlan } from "../sandbox/folder.ts";
import type { AttachmentOut, FolderOut } from "../shared/api.ts";
import type { AttemptFence, ConversationId, EpochMs, Outcome, RunId, RunStatus, VersionId, WorkspaceRef } from "../shared/rpc.ts";
import type { WorkspaceApi } from "../workspace/core.ts";
import type { GateDecision } from "./gate.ts";
import type { SandboxPort } from "./local-run.ts";
import type { RunStore } from "./store.ts";

/** The part of the Workspace Durable Object's RPC surface a conversation calls. */
export type WorkspaceClient = Pick<WorkspaceApi, "beginRun" | "activate" | "release" | "conversationTouched" | "lease" | "markUnauthorized">;

/**
 * The write ledger and page tokens (plan: Writes), in this object's SQLite, built with the executor (gateway/). The object composes the executor's `RunStatePort`
 * from its own run checks and these, and calls the two maintenance methods itself.
 */
export interface WriteLedger extends Pick<RunStatePort, "knownWrite" | "resolvePageToken" | "issuePageToken"> {
	/** Synchronous: the run check and the claim in one stretch (RunStatePort's waits before calling it). */
	dispatchWrite(fence: AttemptFence, key: string): DispatchResult;
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
}

/**
 * The run's folder (plan: Starting a run, Checkpoints, Files; src/files/). The start protocol
 * calls `prepareAttachments` before its transaction (the copies into the conversation's blobs, recorded as
 * loose first) and `commitAttachments` inside it; `publish` runs in `finish`'s transaction. The sandbox
 * hydrates from `hydratePlan` and saves with `checkpoint`; `sweep` is the `files` Lifecycle job.
 */
export interface FolderPort {
	/** The folder a new run would start from, for `beginRun`'s limit checks. */
	usage(): FolderUsage;
	prepareAttachments(runId: RunId, uploads: ReservedUpload[]): Promise<Outcome<PreparedAttachments>>;
	/** Synchronous, inside the start's transaction: the base version with the copies, claiming their loose keys. */
	commitAttachments(runId: RunId, prepared: PreparedAttachments): { baseVersionId: VersionId | null; attachments: AttachmentOut[] };
	/** Inside `finish`'s transaction: the last checkpoint, else the base, becomes the folder. */
	publish(runId: RunId, run: { baseVersionId: VersionId | null; checkpointVersionId: VersionId | null; status: RunStatus }): {
		resultVersionId: VersionId | null;
		changes: { [key: string]: unknown } | null;
	};
	list(versionId: VersionId | null): FolderOut | null;
	resolve(versionId: VersionId | null, path: string): DownloadTarget | null;
	/** Deletes the conversation's objects in R2 (plan: Files, Deletion). */
	deleteObjects(): Promise<void>;
	/** What a new attempt of the run hydrates: its last checkpoint, else its base version, with each file's R2 key. */
	hydratePlan(runId: RunId): HydratePlan;
	/**
	 * A checkpoint of the run's folder from the container's scan (plan: Checkpoints, steps 4 to 6): validated, the files whose contents the run may not read uploaded by `upload` (the Sandbox's
	 * `checkpoint`, under keys recorded here first), then recorded for the fence's attempt on top of its
	 * last checkpoint. Outside pi's transactions; the caller releases held results only after `ok`.
	 */
	checkpoint(fence: AttemptFence, scan: CheckpointScan, upload: (plan: CheckpointUploadPlan) => Promise<CheckpointUploadResult>): Promise<CheckpointOutcome>;
	/** The `files` job: deletes loose and unnamed objects (twice, a day apart) and reports the byte total; when to run next. */
	sweep(): Promise<{ rescheduleAt: EpochMs } | undefined>;
}

export interface PreparedAttachments {
	uploads: ReservedUpload[];
	/** Whatever the folder needs to commit them. */
	state: { [key: string]: unknown };
}

export interface PortsContext {
	env: Env;
	ctx: DurableObjectState;
	workspace: WorkspaceRef;
	conversationId: ConversationId;
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
	workspace(context: PortsContext): WorkspaceClient;
	/** One per run and instance, with the run's snapshot (gateway/executor.ts). */
	executor(run: ExecutorContext, context: PortsContext): Executor;
	ledger(storage: DurableObjectStorage, runs: LedgerRuns, context: PortsContext): WriteLedger;
	folder(context: PortsContext): FolderPort;
	/** The model behind the wrapper, for a route read at each call. */
	upstream(route: ModelRoute, context: PortsContext): Upstream;
	/** The network the executor's provider requests go out on. */
	fetch(context: PortsContext): typeof fetch;
	/** The conversation's Sandbox Durable Object (src/sandbox/), a new stub each time; the platform tests give a fake. */
	sandbox(context: PortsContext): SandboxPort;
	/**
	 * The test build's fault points in the attempt gate (src/faults/); production has none. `decided`: a
	 * decision is made, before its transaction. `committed`: after its transaction and the sync.
	 */
	gate?(context: PortsContext, point: "decided" | "committed", decision: GateDecision["kind"]): Promise<void>;
	/** The test build's count of what pi starts for a run: a model call or a tool's execution, before any check. */
	entered?(context: PortsContext, kind: "model" | "tool", runId: RunId): void;
	/**
	 * The test build's fault points in the local tools and their checkpoints (src/faults/); production has
	 * none. `local:prepared` (the container ready and hydrated), `checkpoint:scanned`, `checkpoint:uploaded`
	 * (the files stored, the checkpoint not yet recorded), `checkpoint:recorded` (recorded, the results not
	 * yet released), `local:released` (a call's result released, before pi has it).
	 */
	point?(context: PortsContext, name: string, detail?: string): Promise<void>;
}

/** No files: the folder stays as it is, and a message with attachments is refused (for tests of the rest). */
export const emptyFolder = (context: PortsContext): FolderPort => ({
	usage: () => ({ versionId: context.folderVersionId(), bytes: 0, entries: 0, rootNames: [] }),
	prepareAttachments: async (_runId, uploads) =>
		uploads.length
			? { ok: false, refusal: { status: 400, detail: "An attached file is no longer available. Remove it and attach it again." } }
			: { ok: true, value: { uploads: [], state: {} } },
	commitAttachments: () => ({ baseVersionId: context.folderVersionId(), attachments: [] }),
	publish: (_runId, run) => ({ resultVersionId: run.checkpointVersionId ?? run.baseVersionId, changes: null }),
	list: (versionId) => (versionId === null || versionId === context.folderVersionId() ? { version_id: context.folderVersionId(), files: [], dirs: [] } : null),
	resolve: () => null,
	deleteObjects: async () => {},
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
 * gateway/'s write ledger and page tokens over this object's SQLite (plan: Writes). The run checks are the
 * object's own, made in the same synchronous stretch as the claim; `writes_uncertain` mirrors the ledger's
 * uncertain rows, set in the same transaction whenever one appears.
 */
export function gatewayLedger(storage: DurableObjectStorage, runs: LedgerRuns): WriteLedger {
	const sql = durableSql(storage);
	const ledger = new GatewayLedger(sql, systemClock);
	const tokens = new PageTokens(sql);
	return {
		knownWrite: (runId, key) => ledger.known(runId, key),
		dispatchWrite: (fence, key) =>
			runs.isCurrent(fence) ? ledger.dispatch(fence, key, runs.deadline(fence.runId)) : { kind: "refused", code: "RUN_ENDED", message: RUN_ENDED_MESSAGE },
		settleWrite: (runId, key, settlement) =>
			sql.transaction(() => {
				if (ledger.settle(runId, key, settlement) && settlement.effect === "unknown") runs.markWritesUncertain(runId);
			}),
		resolvePageToken: (runId, token, tool, queryHash) => tokens.resolve(runId, token, tool, queryHash),
		issuePageToken: (runId, tool, queryHash, cursor) => tokens.issue(runId, tool, queryHash, cursor),
		markDispatchedUncertain: (runId) =>
			sql.transaction(() => {
				const lost = ledger.markDispatchedUncertain(runId);
				if (lost.length) runs.markWritesUncertain(runId);
				return lost.length;
			}),
		sweepLostWrites: (now) =>
			sql.transaction(() => {
				const uncertain = [...new Set(ledger.sweep(now).map((write) => write.runId))];
				for (const runId of uncertain) runs.markWritesUncertain(runId);
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
		dispatchWrite: (fence, key) =>
			store.outside(() => {
				const result = ledger().dispatchWrite(fence, key);
				if (result.kind === "dispatched") dispatched(fence.runId);
				return result;
			}),
		settleWrite: (runId, key, settlement) => store.outside(() => ledger().settleWrite(runId, key, settlement)),
		resolvePageToken: (runId, token, tool, queryHash) => ledger().resolvePageToken(runId, token, tool, queryHash),
		issuePageToken: (runId, tool, queryHash, cursor) => ledger().issuePageToken(runId, tool, queryHash, cursor),
	};
}

export const defaultPorts: ConversationPorts = {
	// Typed by the Workspace class; the conversation calls only the part it needs.
	workspace: ({ env, workspace }) => workspaceObject(env, workspace) as unknown as WorkspaceClient,
	executor: gatewayExecutor,
	ledger: (storage, runs) => gatewayLedger(storage, runs),
	folder: conversationFolder,
	upstream: (route, { env }) => upstreamOf(route, (env as { AI?: Ai }).AI),
	fetch: () => (input, init) => fetch(input, init),
	sandbox: ({ env, ctx, workspace, conversationId }) => sandboxObject(env, ctx.exports, workspace, conversationId) as unknown as SandboxPort,
};

/** The ports every Conversation object uses; tests replace `factory`. */
export const PORTS: { factory: (env: Env) => ConversationPorts } = { factory: () => defaultPorts };
