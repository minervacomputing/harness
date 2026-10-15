// The Conversation Durable Object (`ConversationApi`; ARCHITECTURE.md: Data placement, Protocols): one per chat.
// It extends the Agents SDK's Agent and runs pi-durable through PiHarness, one pi session per run, with the
// `minerva` extension's tools and the model wrapper of src/model/. It owns its messages, runs, attempts and
// run events, and the start protocol's side of the Workspace's registry. Nothing routes to it but our own
// typed RPC and the stream's WebSocket (no `routeAgentRequest`).
//
// Every event that opens pi (an RPC, a request, an alarm) goes through PiHarness's harness factory, where
// the attempt gate runs first, before `Harness.open` (ARCHITECTURE.md: Attempts and recovery). The constructor holds
// nothing of PiHarness: the platform sometimes builds an instance it never delivers an event to.

import { createModels } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type CommitPublication,
	type ConversationId as PiConversationId,
	createRegistry,
	type EntryRecord,
	type Extension,
	Harness,
	type HarnessSettings,
	ProviderDoc,
	type Registry,
	type SubmissionRecord,
	type ToolRegistration,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { scriptsObject } from "../addressing.ts";
import { settings } from "../config.ts";
import { connectorRegistry } from "../connectors/index.ts";
import { type FolderLimit, folderLimitMessage, type FolderLimits } from "../files/limits.ts";
import type { DownloadTarget } from "../files/store.ts";
import type { CredentialPayload } from "../gateway/connector.ts";
import type { CredentialPort, Executor, ToolCallOutcome, ToolDeclaration } from "../gateway/executor.ts";
import type { Registry as ConnectorRegistry } from "../gateway/registry.ts";
import type { RunStatePort } from "../gateway/run-state.ts";
import { modelTools } from "../gateway/tools.ts";
import { type About, identity } from "../lib/about.ts";
import { EncryptionKeys, credentialBinding } from "../lib/encryption.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { isUuid, uuid7 } from "../lib/random.ts";
import { raiseFactSeq } from "../internal/recovery.ts";
import { appliedMigrations, migrate } from "../lib/sqlite.ts";
import { sliceText } from "../lib/text.ts";
import { callOf, MODEL_REF, MINERVA_API, MINERVA_PROVIDER, MODEL_ALIAS, minervaProvider, type ModelHost } from "../model/provider.ts";
import { routeOf } from "../model/route.ts";
import { sandboxSpec } from "../sandbox/constants.ts";
import { outputSink } from "../sandbox/sink.ts";
import { ScriptRuns, scriptToolHost } from "../scripts/host.ts";
import { isReset, type ScriptsClient } from "../scripts/run.ts";
import type { ScriptsApi } from "../scripts/scripts.ts";
import { scriptTool } from "../scripts/tool.ts";
import type { Folder, Message, NewMessage, Run } from "@minerva/contract";
import type { CancelRun, CancelRunResult, DeleteConversation, DeleteConversationResult, Fact, ReadFolder, ReplayFacts, ResolveDownload, StartRun, StartRunResult } from "@minerva/contract/internal";
import { type Preparation, type StartRefusal, UNAVAILABLE, messageRefusal, prepareStart, promptOf as internalPrompt, startRefusal } from "../internal/start.ts";
import { type AttemptFence, type Caller, type Outcome, type Refusal, type RunId, type VersionId, type WorkspaceRef, refuse } from "../shared/rpc.ts";
import {
	ACTING,
	ACTIVE,
	CANCELLED,
	type CancelReason,
	COMPLETED,
	endFor,
	localToolEvent,
	phaseEvent,
	phaseOf,
	type RunEnd,
	type RunEvent,
	START_EXPIRED,
	START_FAILED,
	statusEvent,
	TIMED_OUT,
	WORKER_EXITED,
	WORKER_FAILED,
} from "./events.ts";
import { decideGate, type PiWork, classifyWork } from "./gate.ts";
import { HISTORY_LIMIT, historyOf, promptOf, recentHistory, sessionInstructions } from "./history.ts";
import { cloudflareImages } from "./images.ts";
import { FolderOverLimit, LOCAL_TOOLS, type LocalTool, type LocalToolEvent, localToolSpecs, runGated, SandboxRefused } from "./local.ts";
import { FactDelivery } from "./delivery.ts";
import { BACKLOG_MESSAGE, FACT_DELIVERY } from "./facts.ts";
import { laravelCredentials, laravelRuns } from "./laravel-runs.ts";
import { destroyRunSandbox, LocalRun } from "./local-run.ts";
import { type ConversationPorts, type FolderPort, PORTS, type PortsContext, runStatePort, type WorkspaceClient, type WriteLedger } from "./ports.ts";
import { ToolQueue, untilAborted } from "./queue.ts";
import { MIGRATIONS } from "./schema.ts";
import { KEY_REUSED, START_KEY, START_KEY_TTL_MS, messageDigest } from "./start-keys.ts";
import {
	type ConversationHead,
	type ConversationInit,
	type ConversationRow,
	type EventPage,
	type RunHead,
	type RunRow,
	type RunSnapshot,
	RunStore,
	type StartRow,
} from "./store.ts";
import { RunStream } from "./stream.ts";
import { connectorTool, isWrite, REPLAY_REFUSED, REPLAYS_ALLOWED, RUN_ENDED_MESSAGE, type ToolHost } from "./tools.ts";

/** What a Conversation Durable Object answers to a cancel from outside: the acknowledgement the Workspace's outbox waits for. */
export interface CancelAck {
	runId: RunId;
	/**
	 * `stopping`: the run's local revoked flag is set and the run is being stopped. `tombstoned`: the run is
	 * not stored yet, so a start that is still in flight stores it as cancelled (ARCHITECTURE.md: Strict
	 * revocation). `ended`: it had already ended.
	 */
	state: "stopping" | "tombstoned" | "ended";
}

/**
 * The Conversation Durable Object's RPC surface. One object per chat, named by the conversation's id, in
 * its workspace's jurisdiction. Authoritative for its owner, workspace and agent (fixed at creation),
 * messages, runs and attempts, run events, the write ledger, page tokens, folder versions, the run's
 * checkpoint, the script store, and pi's `pi_*` tables. Every method that takes a `Caller` answers "not
 * found" (null, or a 404 refusal) for a caller who is not the conversation's owner, so another user's chat
 * looks like none.
 *
 * Workers RPC refuses an argument or result over 32 MiB, and a conversation's events grow without bound,
 * so no method returns more than one run's page of events: conversations and runs come back as heads, and
 * the Worker streams the API's body (each run with all its events by seq), paging each run's events with
 * `getRunEvents` up to its head's `eventSeq`.
 */
export interface ConversationApi {
	/** Fixes the owner, workspace and agent. Idempotent; refuses a different identity. */
	init(input: ConversationInit): Promise<void>;

	/** Messages by (created_at, id); runs by created_at, as heads. */
	getConversation(caller: Caller): Promise<ConversationHead | null>;
	/** One page of a run's events by seq; null for another user's run or an unknown one. */
	getRunEvents(caller: Caller, runId: RunId, page: EventPage): Promise<RunEvent[] | null>;

	/**
	 * Starts a turn (ARCHITECTURE.md: Starting a run): 404, 400 "Write a message or attach a file.", 409 "Wait
	 * for the current answer to finish, or stop it.", or the attachment refusals of `beginRun`. Every
	 * refusal leaves nothing behind (no message, no run, uploads untouched), which the composer relies on.
	 * Before its transaction it copies each reserved upload whose contents the conversation does not hold
	 * yet into a blob of its own (`blobs/<ws>/<conv>/<sha256>/<random>`, recorded as loose first, `get` then
	 * `put` with the upload's SHA-256, which R2 checks), so the folder never names an `uploads/` key: those
	 * expire a day after they were written. An upload gone by then is "An attached file is no longer
	 * available. Remove it and attach it again." Success stores the message, the run (`queued`, attempt 1,
	 * event seq 1 `status: queued`) and the base version together, and sets the title from the first message
	 * (`content[:80]`, else the attachment paths joined by ", "); then it calls `activate`.
	 *
	 * `key` is the client's Idempotency-Key, if it sent one (1 to 255 visible ASCII characters): the same
	 * message sent again with it within a day answers for the run the first one started (joining the start in
	 * flight, or the stored message and run with its first page of events), before the 409 check, so a
	 * retried request never starts a second run; another message with the key is 422 "This
	 * Idempotency-Key was used for a different message." A refused start forgets its key.
	 */
	postMessage(caller: Caller, input: Required<NewMessage>, key?: string | null): Promise<Outcome<PostedView>>;

	getRun(caller: Caller, runId: RunId): Promise<RunHead | null>;
	/** The user's stop: idempotent, a finished run stays as it was; the refreshed run. */
	cancelRun(caller: Caller, runId: RunId): Promise<RunHead | null>;
	/**
	 * A cancel from the Workspace's outbox (revocation, deletion, emergency stop): sets the run's local
	 * revoked flag synchronously and stops it with the reason's code and message (CancelReason, RunEnd), or
	 * leaves a tombstone for a run not stored yet. Idempotent by run id. Returning is the acknowledgement.
	 */
	cancel(runId: RunId, reason: CancelReason, entryId: number): Promise<CancelAck>;

	/**
	 * The current folder (no version), or a non-checkpoint version of this conversation; null is 404.
	 * `{versionId: null, files: [], dirs: []}` when there is no folder yet.
	 */
	listFiles(caller: Caller, versionId: VersionId | null): Promise<Folder | null>;
	/** A file of a non-checkpoint version (or of the current folder), for a signed link; null is 404. */
	resolveDownload(caller: Caller, versionId: VersionId | null, path: string): Promise<DownloadTarget | null>;

	/**
	 * Tombstone, cancel and wait, then delete storage and the R2 prefix (ARCHITECTURE.md: Files, Deletion). Driven by the
	 * Workspace, which calls it again until it resolves. It overrides the Agents SDK's own `destroy()`, which
	 * resets the object after it deletes the storage, so the caller may see the connection break once the
	 * deletion is done: a broken call after a resolved one, or a second call that finds nothing, is done.
	 */
	destroy(): Promise<void>;

	/**
	 * Laravel's `startRun` (docs/plans/start-and-cancel.md), once the Worker has bound the conversation and the run in the
	 * recovery index; `workspace` is where the index addresses it. Binds the conversation on first use, and answers a
	 * stored answer again; otherwise prepares the start once (its snapshot compiled), copies the attachments from
	 * staging and stores the run with its acceptance, or stores a refusal. An error stores no answer.
	 */
	startInternal(command: StartRun, workspace: WorkspaceRef): Promise<InternalAnswer<StartRunResult>>;
	/**
	 * Laravel's `cancelRun`: an active run revoked and ended, or a tombstone for a run not stored, which refuses its start.
	 * Answers once the change is committed, outside pi's transactions.
	 */
	cancelInternal(command: CancelRun, workspace: WorkspaceRef): Promise<InternalAnswer<CancelRunResult>>;
	/**
	 * Laravel's `replayFacts` (docs/plans/credentials-and-facts.md): the facts after `after`, in order, read outside pi's
	 * transactions; the recovery index is raised to the page's last before it answers. Never binds the conversation.
	 */
	replayInternal(command: ReplayFacts, workspace: WorkspaceRef): Promise<InternalAnswer<{ facts: Fact[]; more: boolean }>>;
	/**
	 * Laravel's `folder` (the app's docs/plans/conversations.md, 12a): the folder at a version, the current one for null; null
	 * when the conversation is deleted or has no such version. Never binds the conversation.
	 */
	folderInternal(command: ReadFolder, workspace: WorkspaceRef): Promise<InternalAnswer<Folder | null>>;
	/** Laravel's `resolveDownload`: a file of a version, with the object it is stored in; null as for `folderInternal`, or no such file. */
	downloadInternal(command: ResolveDownload, workspace: WorkspaceRef): Promise<InternalAnswer<DownloadTarget | null>>;
	/**
	 * Laravel's `deleteConversation`, once the Worker has marked it in the recovery index: the conversation marked deleted, so
	 * its starts and reads are refused, and its active run cancelled, in one write outside pi's transactions; then its streams
	 * closed, pi stopped and its sandbox and scripts destroyed. Its folder and facts stay: the facts are still delivered, and
	 * chunk 15's retention removes the rest. Binds a conversation that no command named before, already deleted.
	 */
	deleteInternal(command: DeleteConversation, workspace: WorkspaceRef): Promise<InternalAnswer<DeleteConversationResult>>;
}

/** What a Laravel command answers: its outcome, or that the conversation is bound to another scope. */
export type InternalAnswer<T> = { ok: true; value: T } | { ok: false; code: "SCOPE_MISMATCH" };

export interface PostedView {
	message: Message;
	run: Run;
}

/** chord's background context: never cancelled, no values. */
const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context minerva-conversation]" });

/** Longer than a turn runs in practice: partial answers and tool output are not committed while they stream. */
const NEVER_MS = 2_000_000_000;

/**
 * pi's settings: a failed model call ends the turn (any retry delay pi might use
 * stays at or under 60 s, so a long wait is never mistaken for a restart); no background compaction; no
 * partial commits, so an interrupted answer is asked again; and no context kept in memory after a turn,
 * which would keep every object active, and billed, for 10 minutes (spike: PiHarness, fact 17).
 */
const PI_SETTINGS: HarnessSettings = {
	retry: { enabled: false, maxAgentDelayMs: 60_000 },
	compaction: { backgroundTokens: 0 },
	progress: { partialIntervalMs: NEVER_MS, outputIntervalMs: NEVER_MS },
	stream: { maxRetryDelayMs: 60_000 },
	contextRetentionMs: 0,
};

/** The answer to a second message while a run is active. */
export const BUSY_MESSAGE = "Wait for the current answer to finish, or stop it.";
export const EMPTY_MESSAGE = "Write a message or attach a file.";

/** A watch job wakes the object this long after a run is stored, until pi has its input (ARCHITECTURE.md: Attempts and recovery). */
export const WATCH_MS = 20_000;
/** An answer is a WorkerEvent text of at most this many characters; a longer one fails its run. */
export const ANSWER_CHARS = 100_000;
/** The lost-write sweep runs this long after a dispatch at the latest: the write window and its grace. */
const SWEEP_AFTER_MS = 60_000 + 30_000;
const LOST_WRITE_GRACE_MS = 30_000;
/**
 * A job waits this long for another object's answer: Lifecycle drives due jobs one after another, so a hung
 * call must not hold the deadline behind it. The call itself goes on; the job tries again later.
 */
const RPC_WAIT_MS = 10_000;
const RELEASE_RETRY_MS = 30_000;
const LIVE_TASKS = ["pending", "running", "waiting", "completing"] as const;
/** The reason an attempt's object is reset when its local calls cannot go on (ARCHITECTURE.md: Checkpoints). */
export const ATTEMPT_ENDED = "The attempt ended: ";

/** The Lifecycle job that delivers a Laravel conversation's facts. */
const FACTS_JOB = "facts";

/** A conversation, or a 404: another user's conversation looks like none. */
const NOT_FOUND = refuse("NOT_FOUND", "Not found.");
const SCOPE_MISMATCH = { ok: false, code: "SCOPE_MISMATCH" } as const;

type Job = { fn: string; payload?: unknown; job: { id: string; payload: unknown } };

export class Conversation extends Agent<Env> implements ConversationApi {
	/** Set once the gate's decision is committed, so a factory that throws runs the gate again. */
	#gated = false;
	/** Runs the gate gave a new attempt in this instance. */
	readonly #restarted = new Set<RunId>();
	#piStorage: SqliteStorage | null = null;
	#registry: Registry | null = null;
	/** The connector registry the run's executor reads (connectors/index.ts), loaded in the factory. */
	#connectors: ConnectorRegistry | null = null;
	readonly #store: RunStore;
	readonly #stream: RunStream;
	readonly #ports: ConversationPorts;
	#ledgerInstance: WriteLedger | null = null;
	#keyRing: Promise<EncryptionKeys> | null = null;
	readonly #queues = new Map<RunId, ToolQueue>();
	readonly #executors = new Map<RunId, Executor>();
	readonly #controllers = new Map<RunId, AbortController>();
	readonly #running = new Map<RunId, Map<string, string>>();
	readonly #phases = new Map<RunId, string>();
	readonly #loops = new Map<RunId, Promise<void>>();
	readonly #activations = new Map<RunId, Promise<void>>();
	readonly #begins = new Map<RunId, Promise<Outcome<PostedView>>>();
	/** A Laravel conversation's facts on their way to Laravel (delivery.ts). */
	readonly #delivery: FactDelivery;
	/** Laravel's starts in flight in this instance, by run: a repeat joins the one running. */
	readonly #internalStarts = new Map<RunId, Promise<StartRunResult>>();
	/** Code mode: each run's scripted calls, and the lane that runs scripts after the reset of the one before. */
	readonly #scriptRuns = new ScriptRuns();
	/** Each run's folder in its container for the attempt this instance runs (local-run.ts). */
	readonly #locals = new Map<RunId, LocalRun>();
	/** Runs whose checkpoint is running ("Saving files"). */
	readonly #saving = new Set<RunId>();
	/** Local calls waiting for their run's container to be ready ("Preparing files"), by run. */
	readonly #waiting = new Map<RunId, number>();

	readonly harness = new PiHarness({
		harness: ({ storage, context }) => this.#openPi(storage, context),
		defaults: { model: { provider: MODEL_REF.provider, id: MODEL_REF.modelId } },
	});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		migrate(ctx.storage, MIGRATIONS);
		this.#store = new RunStore(ctx.storage);
		this.#store.watchTransactions();
		this.#stream = new RunStream(ctx, () => this.#store);
		this.#ports = PORTS.factory(env);
		this.#store.listen(
			{
				appended: (runId, event) => this.#stream.broadcast(runId, event),
				ended: (runId) => this.#afterFinish(runId),
				// In the fact's transaction: the delivery's job commits with it (Lifecycle's queue is SQL).
				factWritten: (at) => this.#push({ id: FACTS_JOB, fn: FACTS_JOB, time: at }),
			},
			(run) => this.#folder()?.publish(run.id, { baseVersionId: run.base_version_id, checkpointVersionId: run.checkpoint_version_id, status: run.status }) ?? {
				resultVersionId: run.checkpoint_version_id ?? run.base_version_id,
				changes: null,
			},
		);
		this.lifecycle.use(this.#stream as never).use(this.harness);
		this.#delivery = new FactDelivery(this.#store, {
			env,
			schedule: (time) => {
				if (time === null) this.lifecycle.jobs.cancel(FACTS_JOB).catch((error: unknown) => this.#log("the facts job was not removed", error));
				else this.#push({ id: FACTS_JOB, fn: FACTS_JOB, time });
			},
			log: (message, error) => this.#log(message, error, error !== undefined),
		});
	}

	/** Not async, so it answers without opening pi (the probe and the platform tests call it). */
	about(): Promise<About<"conversation">> {
		return Promise.resolve({ kind: "conversation", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) });
	}

	// The RPC surface (ConversationApi). Async methods start the Agent's lifecycle first, which opens pi
	// through the factory, so the gate runs before any of them.

	async init(input: ConversationInit): Promise<void> {
		if (!this.#store.init(input)) throw new Error("This conversation already has another owner, workspace or agent.");
	}

	async getConversation(caller: Caller): Promise<ConversationHead | null> {
		const conversation = this.#owned(caller);
		return conversation ? this.#store.conversationHead(conversation) : null;
	}

	async getRun(caller: Caller, runId: RunId): Promise<RunHead | null> {
		const run = this.#ownedRun(caller, runId);
		return run ? this.#store.runHead(run) : null;
	}

	async getRunEvents(caller: Caller, runId: RunId, page: EventPage): Promise<RunEvent[] | null> {
		const run = this.#ownedRun(caller, runId);
		if (!run) return null;
		// The Worker sends whole numbers; anything else reads as an empty page rather than a failed call.
		if (![page.after, page.upTo, page.limit].every((value) => Number.isSafeInteger(value) && value >= 0)) return [];
		return this.#store.events(runId, page);
	}

	/**
	 * `key` is the client's Idempotency-Key, when it sent one: the same message sent again with it, within a
	 * day, answers for the run the first one started (the start in flight joined, or the run stored), so a
	 * retried request never starts a second run; another message with it is 422. A refused start forgets its
	 * key, so the message may be sent again with it.
	 */
	async postMessage(caller: Caller, input: Required<NewMessage>, key: string | null = null): Promise<Outcome<PostedView>> {
		const conversation = this.#owned(caller);
		if (!conversation) return NOT_FOUND;
		// NewMessage is validated by the Worker (20,000 characters, at most 100 UUIDs, no lone
		// surrogate); anything else here is a bug, not a user's input.
		if (
			typeof input.content !== "string" ||
			!input.content.isWellFormed() ||
			!Array.isArray(input.attachments) ||
			!input.attachments.every((id) => typeof id === "string" && isUuid(id)) ||
			(key !== null && (typeof key !== "string" || !START_KEY.test(key)))
		) {
			throw new TypeError("The Worker validates a message before it reaches the conversation.");
		}
		if (input.content.trim() === "" && input.attachments.length === 0) return refuse("EMPTY_MESSAGE", EMPTY_MESSAGE);
		const digest = key === null ? null : await messageDigest(input);
		const runId = uuid7();
		const decision = await this.#store.outside(() =>
			this.#store.write((): "start" | "busy" | "reused" | { replay: RunId } => {
				if (key !== null) {
					const known = this.#store.startKey(key, this.#store.now() - START_KEY_TTL_MS);
					if (known) return known.digest === digest ? { replay: known.run_id } : "reused";
				}
				// A start in flight counts as an active run: its message may still be stored.
				if (this.#store.activeRun() || this.#store.starts().length) return "busy";
				this.#store.addStart({ runId, userId: caller.userId, content: input.content, uploadIds: input.attachments, createdAt: this.#store.now() });
				if (key !== null) this.#store.addStartKey(key, runId, digest as string);
				return "start";
			}),
		);
		if (decision === "busy") return refuse("CONVERSATION_BUSY", BUSY_MESSAGE);
		if (decision === "reused") return refuse("IDEMPOTENCY_KEY_REUSED", KEY_REUSED);
		if (decision !== "start") return this.#replay(decision.replay);
		return this.#begin(runId);
	}

	/** A message sent again with its key: the start still in flight (its own answer), or the run it stored. */
	async #replay(runId: RunId): Promise<Outcome<PostedView>> {
		if (this.#store.start(runId)) return this.#begin(runId);
		const run = this.#store.run(runId);
		const message = run ? this.#store.runMessage(runId) : null;
		if (!run || !message) return NOT_FOUND;
		return { ok: true, value: this.#posted(message, run) };
	}

	/** The answer to a posted message: the message and its run, with the run's first page of events. */
	#posted(message: Message, run: RunRow): PostedView {
		const { eventSeq, ...view } = this.#store.runHead(run);
		return { message, run: { ...view, events: this.#store.events(run.id, { after: 0, upTo: eventSeq, limit: 1000 }) } };
	}

	async cancelRun(caller: Caller, runId: RunId): Promise<RunHead | null> {
		// Outside pi's transactions (store.ts `outside`): the answer says the run was stopped.
		return this.#store.outside(() => {
			const run = this.#ownedRun(caller, runId);
			if (!run) return null;
			if (ACTIVE.has(run.status)) this.#store.finish(runId, CANCELLED);
			return this.#store.runHead(this.#store.run(runId) as RunRow);
		});
	}

	/** The revocation's cancel (ARCHITECTURE.md: Strict revocation): acknowledged only once the flag is committed on its own. */
	async cancel(runId: RunId, reason: CancelReason, entryId: number): Promise<CancelAck> {
		return this.#store.outside((): CancelAck => {
			const run = this.#store.run(runId);
			if (run) {
				if (!ACTIVE.has(run.status)) return { runId, state: "ended" };
				this.#store.write(() => {
					this.#store.revoke(runId);
					this.#store.finish(runId, endFor(reason));
				});
				return { runId, state: "stopping" };
			}
			this.#store.write(() => this.#store.addTombstone(runId, reason, entryId));
			return { runId, state: "tombstoned" };
		});
	}

	async listFiles(caller: Caller, versionId: VersionId | null): Promise<Folder | null> {
		if (!this.#owned(caller)) return null;
		return this.#folder()?.list(versionId) ?? null;
	}

	async resolveDownload(caller: Caller, versionId: VersionId | null, path: string): Promise<DownloadTarget | null> {
		if (!this.#owned(caller)) return null;
		return this.#folder()?.resolve(versionId, path) ?? null;
	}

	/**
	 * Deletes the conversation (ARCHITECTURE.md: Files, Deletion): tombstoned first, so it refuses new runs; its active
	 * run cancelled ("Stopped.") and pi stopped; its objects in R2 deleted; then the Agent's own teardown
	 * deletes all storage and resets the object, so the caller may see the connection break after this
	 * resolves. The Workspace drives it, and calls it again until it returns.
	 */
	override async destroy(): Promise<void> {
		await this.lifecycle.start();
		const run = await this.#store.outside(() => {
			const active = this.#store.activeRun();
			this.#store.write(() => {
				this.#store.markDeleted();
				for (const start of this.#store.starts()) this.#store.addTombstone(start.run_id, "cancelled", 0);
				if (active) {
					this.#store.revoke(active.id);
					this.#store.finish(active.id, CANCELLED);
				}
			});
			return active;
		});
		this.#stream.closeAll();
		if (run) await this.#stopPi(run.id).catch((error: unknown) => this.#log("pi did not stop", error));
		await this.#destroyScripts();
		if (this.#store.conversation()) await destroyRunSandbox(this.#sandbox(), null, "The conversation was deleted.");
		await this.#folder()?.deleteObjects();
		await super.destroy();
	}

	/** The conversation's Scripts object, emptied and reset; a call the reset broke is the reset done, any other failure is tried again. */
	async #destroyScripts(): Promise<void> {
		const conversation = this.#store.conversation();
		if (!conversation) return;
		try {
			await (scriptsObject(this.env, this.#store.workspaceRef(conversation), conversation.id) as unknown as ScriptsApi).destroy();
		} catch (error) {
			if (!isReset(error)) throw error;
		}
	}

	// Laravel's commands (docs/plans/start-and-cancel.md).

	async startInternal(command: StartRun, workspace: WorkspaceRef): Promise<InternalAnswer<StartRunResult>> {
		if (!(await this.#bindInternal(command, workspace))) return SCOPE_MISMATCH;
		const stored = this.#store.answer(command.run);
		if (stored) return { ok: true, value: stored };
		let start = this.#internalStarts.get(command.run);
		if (!start) {
			start = this.#startOnce(command).finally(() => this.#internalStarts.delete(command.run));
			this.#internalStarts.set(command.run, start);
		}
		return { ok: true, value: await start };
	}

	async cancelInternal(command: CancelRun, workspace: WorkspaceRef): Promise<InternalAnswer<CancelRunResult>> {
		if (!(await this.#bindInternal(command, workspace))) return SCOPE_MISMATCH;
		const state = await this.#store.outside(() =>
			this.#store.write((): CancelRunResult["state"] => {
				const run = this.#store.run(command.run);
				if (run) {
					// Ended: by a cancel if its revoked flag is set, so a repeat answers as the first did.
					if (!ACTIVE.has(run.status)) return run.revoked ? "cancelled" : "ended";
					this.#store.revoke(run.id);
					this.#store.finish(run.id, endFor(command.reason));
					return "cancelled";
				}
				this.#store.addTombstone(command.run, command.reason, 0);
				this.#store.deletePreparation(command.run);
				return "tombstoned";
			}),
		);
		return { ok: true, value: { state } };
	}

	async replayInternal(command: ReplayFacts, workspace: WorkspaceRef): Promise<InternalAnswer<{ facts: Fact[]; more: boolean }>> {
		const page = await this.#store.outside(() => {
			const conversation = this.#store.conversation();
			if (
				conversation === null ||
				conversation.id !== command.conversation ||
				conversation.organization_id !== command.scope.organization ||
				conversation.workspace_id !== workspace.id
			) {
				return null;
			}
			return this.#store.factPage(command.after, command.limit);
		});
		if (page === null) return SCOPE_MISMATCH;
		const last = page.facts.at(-1)?.seq;
		// Every fact sent to Laravel is at or below the index's, a replay's as a delivery's.
		if (last !== undefined) await raiseFactSeq(this.env.DB, { conversation: command.conversation, organization: command.scope.organization, workspace: workspace.id, seq: last });
		return { ok: true, value: { facts: page.facts.map((fact) => parseJson(fact.json) as unknown as Fact), more: page.more } };
	}

	folderInternal(command: ReadFolder, workspace: WorkspaceRef): Promise<InternalAnswer<Folder | null>> {
		return this.#readInternal(command, workspace, (folder) => folder.list(command.version));
	}

	downloadInternal(command: ResolveDownload, workspace: WorkspaceRef): Promise<InternalAnswer<DownloadTarget | null>> {
		return this.#readInternal(command, workspace, (folder) => folder.resolve(command.version, command.path));
	}

	/**
	 * A read of a Laravel conversation's folder: the binding, the deletion and the read in one synchronous step outside pi's
	 * transactions, so an answer never describes a change that could still roll back. Null for an unbound or deleted
	 * conversation.
	 */
	#readInternal<T>(command: ReadFolder | ResolveDownload, workspace: WorkspaceRef, read: (folder: FolderPort) => T | null): Promise<InternalAnswer<T | null>> {
		return this.#store.outside(() => {
			const conversation = this.#scoped(command, workspace);
			if (conversation === false) return SCOPE_MISMATCH;
			if (conversation === null || conversation.deleted_at !== null) return { ok: true as const, value: null };
			const folder = this.#folder();
			return { ok: true as const, value: folder === null ? null : read(folder) };
		});
	}

	async deleteInternal(command: DeleteConversation, workspace: WorkspaceRef): Promise<InternalAnswer<DeleteConversationResult>> {
		if (!(await this.#bindInternal(command, workspace))) return SCOPE_MISMATCH;
		await this.lifecycle.start();
		const latest = await this.#store.outside(() => {
			const active = this.#store.activeRun();
			this.#store.write(() => {
				this.#store.markDeleted();
				// A start in flight finds the conversation deleted in its final transaction; one whose try was lost is answered
				// here, so its preparation goes too.
				for (const runId of this.#store.preparedRuns()) if (!this.#store.answer(runId)) this.#answerRefused(runId, deletedRefusal());
				if (active) {
					this.#store.revoke(active.id);
					this.#store.finish(active.id, endFor("conversation_deleted"));
				}
			});
			return this.#store.runs().at(-1) ?? null;
		});
		this.#stream.closeAll();
		// Every step again on each try, and a failure fails the deletion, which Laravel sends again until it is answered. Only the
		// latest run can still have pi's work: each earlier one ended before the next started.
		if (latest) await this.#stopPi(latest.id);
		await this.#destroyScripts();
		const sandbox = this.#sandbox();
		await destroyRunSandbox(sandbox, null, "The conversation was deleted.");
		if ((await sandbox.status()).cleanupPending) throw new Error("The conversation's sandbox is still being destroyed.");
		return { ok: true, value: { outcome: "deleted" } };
	}

	/** The conversation if it is bound to the command's organization and the index's workspace; null if unbound, false if bound to others. */
	#scoped(command: { conversation: string; scope: { organization: string } }, workspace: WorkspaceRef): ConversationRow | null | false {
		const conversation = this.#store.conversation();
		if (conversation === null) return null;
		const ours =
			conversation.id === command.conversation &&
			conversation.organization_id === command.scope.organization &&
			conversation.workspace_id === workspace.id;
		return ours ? conversation : false;
	}

	/** The conversation bound to the command's organization and the index's workspace, on first use; false for others. */
	#bindInternal(command: StartRun | CancelRun | DeleteConversation, workspace: WorkspaceRef): Promise<boolean> {
		const binding = { conversationId: command.conversation, organization: command.scope.organization, workspace, createdAt: this.#store.now() };
		return this.#store.outside(() => this.#store.bind(binding));
	}

	/**
	 * A start: refused, or prepared once (the preparation of an earlier try is used as it is); then its attachments
	 * measured and copied; then stored, unless a cancel, a deletion or another run came first. Each step that decides
	 * commits outside pi's transactions.
	 */
	async #startOnce(command: StartRun): Promise<StartRunResult> {
		const runId = command.run;
		const config = settings(this.env);
		const refusal = messageRefusal(command, config.files);
		this.#connectors ??= await connectorRegistry();
		const compiled =
			refusal === null && this.#store.preparation(runId) === null
				? await prepareStart(this.#connectors, command, { now: this.#store.now(), runTimeoutMs: config.runTimeoutMs })
				: null;
		const first = await this.#store.outside(() =>
			this.#store.write((): StartRunResult | Preparation => {
				const answered = this.#store.answer(runId);
				if (answered) return answered;
				const refused = this.#startState(runId) ?? refusal;
				if (refused) return this.#answerRefused(runId, refused);
				const prepared = this.#store.preparation(runId);
				if (prepared) return prepared;
				if (compiled === null) throw new Error("A start's preparation went away while it was read.");
				this.#store.addPreparation(runId, compiled);
				return compiled;
			}),
		);
		if ("outcome" in first) return first;
		const preparation = first;
		const folder = this.#folder() as FolderPort;
		const uploads = await folder.measureStaged(command.message.attachments, config.files.uploadBytes);
		if (uploads === null) return this.#refuseInternal(runId, startRefusal("ATTACHMENT_UNAVAILABLE", UNAVAILABLE));
		const copied = await folder.prepareAttachments(runId, uploads);
		if (!copied.ok) {
			const { code, detail } = copied.refusal;
			return this.#refuseInternal(runId, code === "NOT_FOUND" ? deletedRefusal() : startRefusal(code, detail));
		}
		const answer = await this.#store.outside(() =>
			this.#store.write((): StartRunResult => {
				const answered = this.#store.answer(runId);
				if (answered) return answered;
				const refused = this.#startState(runId);
				if (refused) return this.#answerRefused(runId, refused);
				const now = this.#store.now();
				const { baseVersionId, attachments } = folder.commitAttachments(runId, copied.value);
				const snapshot: RunSnapshot = {
					...preparation.snapshot,
					runId,
					baseVersionId,
					attachments,
					limits: { folderBytes: config.files.folderBytes, folderEntries: config.files.folderEntries, runUploadBytes: config.files.runUploadBytes },
					turn: { history: preparation.history, prompt: internalPrompt(command.message.content, attachments) },
				};
				this.#store.insertRun({ id: runId, snapshot, deadline: snapshot.deadline, baseVersionId, createdAt: now });
				this.#store.append(runId, statusEvent({ status: "queued" }));
				// Pushed in this transaction (Lifecycle's queue is SQL), so a stored run always has its wake-up.
				this.#push({ id: `watch:${runId}`, fn: "watch", time: now + WATCH_MS, payload: { runId } });
				if (snapshot.deadline !== null) this.#push({ id: `deadline:${runId}`, fn: "deadline", time: snapshot.deadline, payload: { runId } });
				const accepted: StartRunResult = {
					outcome: "accepted",
					catalog: preparation.catalog,
					compiler: preparation.compiler,
					digest: preparation.digest,
					authorized: snapshot.connectionIds,
					attachments,
				};
				this.#store.addAnswer(runId, accepted);
				return accepted;
			}),
		);
		if (answer.outcome === "accepted") {
			this.#defer(() => this.#activate(runId));
			this.#defer(() => folder.deleteStaged(command.message.attachments.map((attachment) => attachment.upload)));
		}
		return answer;
	}

	/** What the conversation's state refuses a start for, in order: a tombstone, a deletion, another run. */
	#startState(runId: RunId): StartRefusal | null {
		if (this.#store.tombstone(runId)) return startRefusal("CANCELLED", "This run was cancelled before it started.");
		if (this.#store.conversation()?.deleted_at != null) return deletedRefusal();
		if (this.#store.activeRun() || this.#store.preparedOther(runId) || this.#store.starts().length) return startRefusal("CONVERSATION_BUSY", BUSY_MESSAGE);
		// Facts are never dropped: past the bound, a conversation Laravel has not caught up with starts nothing new.
		if (this.#store.backlog() > FACT_DELIVERY.backlog) return startRefusal("FACTS_BACKLOG", BACKLOG_MESSAGE);
		return null;
	}

	/** Inside a write: the refusal stored as the start's answer, its preparation deleted. */
	#answerRefused(runId: RunId, refusal: StartRefusal): StartRunResult {
		this.#store.addAnswer(runId, refusal);
		return refusal;
	}

	/**
	 * A refusal found after the preparation: stored, unless an answer already was. A cancel or a deletion that committed
	 * meanwhile comes first, as it does for a start that would have been stored.
	 */
	#refuseInternal(runId: RunId, refusal: StartRefusal): Promise<StartRunResult> {
		return this.#store.outside(() => this.#store.write(() => this.#store.answer(runId) ?? this.#answerRefused(runId, this.#startState(runId) ?? refusal)));
	}

	// The start protocol (ARCHITECTURE.md: Starting a run).

	/** One start at a time per run: a resumed start and the message's own share the same `beginRun`. */
	#begin(runId: RunId): Promise<Outcome<PostedView>> {
		const running = this.#begins.get(runId);
		if (running) return running;
		const work = this.#beginOnce(runId).finally(() => this.#begins.delete(runId));
		this.#begins.set(runId, work);
		return work;
	}

	/** `beginRun`, the copies, then one transaction; a refusal leaves nothing behind. */
	async #beginOnce(runId: RunId): Promise<Outcome<PostedView>> {
		const start = this.#store.start(runId);
		const conversation = this.#store.conversation();
		if (!start || !conversation) return NOT_FOUND;
		const folder = this.#folder() as FolderPort;
		const usage = folder.usage();
		const uploadIds = idsOf(start);
		const workspace = this.#workspace();
		// If anything below fails, the watch sends the start again (`beginRun` is idempotent by run id) until it
		// is stored or refused, so a marker never holds the conversation busy.
		await this.lifecycle.jobs.push({ id: `watch:${runId}`, fn: "watch", time: Date.now() + WATCH_MS, payload: { runId } });
		const answer = await workspace.beginRun({
			runId,
			conversationId: conversation.id,
			userId: start.user_id,
			agentId: conversation.agent_id,
			uploadIds,
			folder: { bytes: usage.bytes, entries: usage.entries },
		});
		if (!answer.ok) {
			// Released too: a resumed start the Workspace registered, then refused as revoked, would keep its
			// uploads reserved until it expired. A run the Workspace never registered is not affected.
			return this.#refuseStart(runId, answer);
		}
		const prepared = await folder.prepareAttachments(runId, answer.value.uploads);
		if (!prepared.ok) return this.#refuseStart(runId, prepared);
		const limits = settings(this.env).files;
		let stored: string | null;
		try {
			// Outside pi's transactions (store.ts `outside`): the answer says the run was stored.
			stored = await this.#store.outside(() =>
				this.#store.write(() => {
					const current = this.#store.conversation();
					if (!this.#store.start(runId) || !current) return null;
					if (current.deleted_at !== null) {
						this.#store.deleteStart(runId);
						this.#store.addRelease(runId);
						return null;
					}
					const now = this.#store.now();
					const { baseVersionId, attachments } = folder.commitAttachments(runId, prepared.value);
					const snapshot: RunSnapshot = {
						...answer.value.snapshot,
						runId,
						baseVersionId,
						attachments,
						limits: { folderBytes: limits.folderBytes, folderEntries: limits.folderEntries, runUploadBytes: limits.runUploadBytes },
					};
					const messageId = uuid7(now);
					this.#store.insertMessage({ id: messageId, role: "user", content: start.content, attachments, runId, createdAt: now });
					this.#store.insertRun({ id: runId, snapshot, deadline: snapshot.deadline, baseVersionId, createdAt: now });
					this.#store.append(runId, statusEvent({ status: "queued" }));
					const title = current.title ? undefined : sliceText(start.content || attachments.map((item) => item.path).join(", "), 0, 80);
					this.#store.touch({ title });
					this.#store.deleteStart(runId);
					// Pushed in this transaction (Lifecycle's queue is SQL), so a stored run always has its wake-up.
					this.#push({ id: `watch:${runId}`, fn: "watch", time: now + WATCH_MS, payload: { runId } });
					if (snapshot.deadline !== null) this.#push({ id: `deadline:${runId}`, fn: "deadline", time: snapshot.deadline, payload: { runId } });
					// A cancel that arrived during the awaits: stored as cancelled, as when a grant change races a start.
					const tombstone = this.#store.tombstone(runId);
					if (tombstone) {
						this.#store.revoke(runId);
						this.#store.finish(runId, endFor(tombstone.reason));
					}
					return messageId;
				}),
			);
		} catch (error) {
			// The store refused the start (a value or a row past the platform's limits, say). That would happen
			// again every time the watch sent it, holding the conversation busy: it is refused now instead, and
			// its registration released (ARCHITECTURE.md: Starting a run: a refusal leaves nothing behind).
			this.#log("a start could not be stored", error);
			return this.#refuseStart(runId, refuse("START_FAILED", START_FAILED));
		}
		if (stored === null) {
			// Deleted meanwhile: the registration is released. A run another flow stored is left alone.
			if (this.#store.releases().includes(runId)) this.#defer(() => this.#releaseRefused(runId));
			return NOT_FOUND;
		}
		this.#touchIndex();
		const run = this.#store.run(runId) as RunRow;
		if (ACTIVE.has(run.status)) this.#defer(() => this.#activate(runId));
		return { ok: true, value: this.#posted(this.#store.message(stored) as Message, run) };
	}

	/** A refused start: its marker deleted and its registration released in one write, the release retried until heard. */
	async #refuseStart(runId: RunId, refusal: { ok: false; refusal: Refusal }): Promise<Outcome<PostedView>> {
		await this.#store.outside(() =>
			this.#store.write(() => {
				this.#store.deleteStart(runId);
				this.#store.deleteStartKeys(runId);
				this.#store.addRelease(runId);
			}),
		);
		this.#defer(() => this.#releaseRefused(runId));
		return refusal;
	}

	/**
	 * `activate` (ARCHITECTURE.md: Starting a run): until the Workspace answers, sent again by the watch job and whenever the object
	 * starts. Active: the run is provisioned and its loop starts. Revoked: it stops with that reason. Expired:
	 * it fails (`start_expired`). Ended: the Workspace no longer tracks it, so no revocation could reach it;
	 * it stops ("Stopped.").
	 */
	#activate(runId: RunId): Promise<void> {
		const running = this.#activations.get(runId);
		if (running) return running;
		const work = (async () => {
			const run = this.#store.run(runId);
			if (!run || run.activated || !ACTIVE.has(run.status)) return;
			const answer = await this.#workspace().activate(runId);
			if (answer.state === "active") {
				if (await this.#store.outside(() => this.#store.activate(runId))) await this.#startLoop(runId);
				return;
			}
			const end: RunEnd = answer.state === "revoked" ? endFor(answer.reason) : answer.state === "expired" ? START_EXPIRED : CANCELLED;
			await this.#store.outside(() =>
				this.#store.write(() => {
					this.#store.update(runId, { activated: 1 });
					if (answer.state === "revoked") this.#store.revoke(runId);
					this.#store.finish(runId, end);
				}),
			);
		})().finally(() => this.#activations.delete(runId));
		this.#activations.set(runId, work);
		return work;
	}

	/**
	 * The loop starts: `running` (once per attempt), the run's tools installed, its pi session created with
	 * the history replay (only here, never on resume), and its prompt submitted once, as `run:<id>`.
	 */
	#startLoop(runId: RunId): Promise<void> {
		const running = this.#loops.get(runId);
		if (running) return running;
		const work = (async () => {
			const run = this.#store.run(runId);
			if (!run || !ACTING.has(run.status) || !run.activated) return;
			const fence = { runId, attempt: run.attempt };
			if (!this.#store.isCurrent(fence)) return;
			// Outside pi's transactions (store.ts `outside`): its `run.status` fact must not roll back.
			await this.#store.outside(() => this.#store.startAttempt(fence));
			this.#phase(fence, this.#restarted.has(runId) ? "Resuming the agent" : "Starting the agent");
			this.#installTools(run);
			let session = run.session;
			// A Laravel run's turn came with its start; a Workspace run's is read from the object's messages.
			const snapshot = this.#store.snapshot(run);
			if (session === null) {
				const pi = await this.harness.pi();
				const history = snapshot.turn?.history ?? recentHistory(historyOf(this.#store.storedMessages(runId, HISTORY_LIMIT), runId));
				let providerSession: string | null = null;
				const created = await pi.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: { model: { ...MODEL_REF }, instructions: sessionInstructions(snapshot.instructions, LOCAL_TOOLS) },
						init: async (tx: Tx, id: PiConversationId) => {
							providerSession = (await tx.doc(ProviderDoc, id)).sessionId;
							await replay(tx, id, history);
						},
					},
					BG,
				);
				session = await this.#store.outside(() => this.#store.claimSession(runId, String(created.id), providerSession));
			}
			if (session === null || !this.#store.isCurrent(fence)) return;
			this.#prepareLocal(run);
			this.#showPhase(fence);
			const prompt = snapshot.turn?.prompt ?? promptOf(this.#store.storedMessages(runId, HISTORY_LIMIT), runId);
			await this.harness.submit(prompt, { session, operationId: `run:${runId}` });
		})().finally(() => this.#loops.delete(runId));
		this.#loops.set(runId, work);
		return work;
	}

	/** After a restart of the object: the starts in flight, activations not answered, releases not heard, containers left. */
	async #recover(): Promise<void> {
		const again = await this.#cleanSandbox();
		if (again) this.#push({ id: "sandbox", fn: "sandbox", time: again.rescheduleAt });
		for (const start of this.#store.starts()) await this.#begin(start.run_id).catch((error: unknown) => this.#log("a start could not resume", error));
		const run = this.#store.activeRun();
		if (run && !run.activated) await this.#activate(run.id).catch((error: unknown) => this.#log("activation failed", error));
		for (const ended of this.#store.unreleased()) await this.#release(ended);
		for (const runId of this.#store.releases()) await this.#releaseRefused(runId);
		await this.#delivery.deliver();
	}

	// The harness factory and the attempt gate (ARCHITECTURE.md: Attempts and recovery).

	async #openPi(storage: SqliteStorage, context: Parameters<typeof Harness.open>[2]): Promise<Harness> {
		this.#piStorage = storage;
		if (!this.#gated) {
			await this.#gate(storage);
			// Only after the decision is committed: a factory that throws before this runs the gate again.
			this.#gated = true;
		}
		// After the gate, before any run's tools are built from it.
		this.#connectors ??= await connectorRegistry();
		const models = createModels();
		models.setProvider(
			minervaProvider({
				route: () => routeOf(settings(this.env)),
				upstream: (route) => this.#ports.upstream(route, this.#portsContext() as PortsContext),
				host: this.#modelHost(),
			}),
		);
		const registry = createRegistry();
		this.#registry = registry;
		const active = this.#store.activeRun();
		registry.install(this.#extension(active && ACTING.has(active.status) ? active : null));
		const pi = await Harness.open(storage, { models, registry, settings: PI_SETTINGS, onReport: (error) => this.#log("pi reported", error) }, context);
		pi.subscribeCommits((publication) => this.#onPiCommit(publication));
		// A storage error fails pi's Session for good, and the Agents SDK keeps the harness it opened: the object is
		// reset, so the next instance opens pi again and recovers its work as after any restart.
		void pi.closed.then((end) => {
			if (end.reason !== "failed") return;
			this.#log("pi's session failed", end.error);
			this.#reset("pi's session failed after a storage error.", true);
		});
		await this.#stopEnded(pi, context);
		return pi;
	}

	/**
	 * First in the factory, once per instance: a restart is pi opening in a new instance while an activated
	 * `provisioning` or `running` run has unsettled pi work. The decision is one transaction, with the dead
	 * instance's dispatched writes marked uncertain in it, then synced before pi opens, so a crash right
	 * after cannot lose the count. Nothing here waits on anything outside this object.
	 */
	async #gate(storage: SqliteStorage): Promise<void> {
		const run = this.#store.activeRun();
		const acting = run !== null && run.activated === 1 && ACTING.has(run.status);
		const work = acting ? await piWork(storage, run) : null;
		const decision = decideGate(run ? { status: run.status, attempt: run.attempt, activated: run.activated === 1, deadline: run.deadline } : null, work, Date.now());
		if (decision.kind === "none" || run === null) return;
		// The test build's fault points (ConversationPorts.gate); production has none, and awaits nothing here.
		const point = this.#ports.gate;
		if (point) await point(this.#portsContext() as PortsContext, "decided", decision.kind);
		// Outside any transaction of pi's (store.ts `outside`), so the count cannot roll back; none is open
		// before pi opens, so this does not wait.
		await this.#store.outside(() =>
			this.#store.write(() => {
				if (acting) this.#ledger().markDispatchedUncertain(run.id);
				if (decision.kind === "timed_out") this.#store.finish(run.id, TIMED_OUT);
				else if (decision.kind === "worker_exited") this.#store.finish(run.id, WORKER_EXITED);
				else this.#store.restart(run.id, decision.attempt);
			}),
		);
		if (decision.kind === "restart") this.#restarted.add(run.id);
		await this.ctx.storage.sync();
		if (point) await point(this.#portsContext() as PortsContext, "committed", decision.kind);
	}

	/**
	 * Before PiHarness resumes pi: every live task of a session whose run is not active (the gate's ends,
	 * cancels and revocations while the object was away, orphaned sessions), background compactions
	 * included, is marked with `abortTask`, and queued inputs are withdrawn with `abortSubmission`, all
	 * started in one synchronous stretch, so the paused scheduler reserves nothing meanwhile. The abort
	 * handlers run once pi resumes.
	 */
	async #stopEnded(pi: Harness, context: Parameters<typeof Harness.open>[2]): Promise<void> {
		const inspection = await pi.inspect(context);
		const sessions = this.#store.sessions();
		const ended = new Set<number>();
		for (const task of inspection.tasks) if (sessions.get(String(task.record.conversationId)) !== true) ended.add(task.record.conversationId);
		for (const submission of inspection.submissions) if (sessions.get(String(submission.conversationId)) !== true) ended.add(submission.conversationId);
		if (!ended.size) return;
		const marks: Promise<unknown>[] = [];
		for (const task of inspection.tasks) if (ended.has(task.record.conversationId)) marks.push(pi.abortTask(task.record.id, context));
		for (const submission of inspection.submissions) {
			if (ended.has(submission.conversationId) && submission.status === "queued") marks.push(pi.abortSubmission(submission.id, context, submission.conversationId));
		}
		await Promise.all(marks);
	}

	/** After the factory and pi's resume: the attempt runs, a lost submit is sent again, a settled run is reconciled. */
	override async onStart(): Promise<void> {
		const run = this.#store.activeRun();
		if (run && run.activated === 1 && ACTING.has(run.status) && this.#piStorage) {
			const work = await piWork(this.#piStorage, run);
			if (work === "settled") this.#defer(() => this.#reconcile(run.id).catch((error: unknown) => this.#settleLater(run.id, error)));
			else if (work === "not_submitted") this.#defer(() => this.#startLoop(run.id));
			else if (this.#restarted.has(run.id)) {
				// The gate's new attempt: running again (`{status: "running"}`, no attempt key), then its phases.
				const fence = { runId: run.id, attempt: run.attempt };
				await this.#store.outside(() => this.#store.startAttempt(fence));
				this.#phase(fence, "Resuming the agent");
				this.#prepareLocal(run);
				this.#showPhase(fence);
			}
		}
		// Streams this instance did not accept may have missed events: their clients reconnect from where they are.
		this.#stream.resetInherited();
		this.#defer(() => this.#recover());
	}

	/** Lifecycle jobs of the host: the start watch, the deadline, the lost-write sweep, pending releases. */
	override _onHostJob(fn: string, context: Parameters<Agent<Env>["_onHostJob"]>[1]) {
		const runId = runOfPayload((context as unknown as Job).job.payload);
		if (fn === "watch" && runId) return this.#watch(runId);
		if (fn === "deadline" && runId) return this.#deadline(runId);
		if (fn === "sweep") return this.#sweep();
		if (fn === "release") return this.#retryReleases();
		if (fn === "files") return this.#folder()?.sweep() ?? Promise.resolve(undefined);
		if (fn === "sandbox") return this.#cleanSandbox();
		if (fn === FACTS_JOB) return this.#factsJob();
		return super._onHostJob(fn, context);
	}

	/**
	 * The start's wake-up, until pi has the run's input: a start whose `beginRun` failed is sent again, an
	 * activation not answered is sent again, and an activated run pi has no submission for is submitted.
	 */
	async #watch(runId: RunId): Promise<{ rescheduleAt: number } | undefined> {
		const again = { rescheduleAt: Date.now() + WATCH_MS };
		if (this.#store.start(runId)) {
			await within(this.#begin(runId), RPC_WAIT_MS).catch((error: unknown) => this.#log("a start could not resume", error));
			if (this.#store.start(runId)) return again;
		}
		const run = this.#store.run(runId);
		if (!run || !ACTIVE.has(run.status)) return undefined;
		if (!run.activated) {
			await within(this.#activate(runId), RPC_WAIT_MS).catch((error: unknown) => this.#log("activation failed", error));
			if (!this.#store.run(runId)?.activated) return again;
		}
		const work = async (): Promise<PiWork | null> => {
			const now = this.#store.run(runId);
			return now !== null && ACTING.has(now.status) && this.#piStorage !== null ? piWork(this.#piStorage, now) : null;
		};
		const before = await work();
		// In progress: pi's own wake job drives it from here.
		if (before === null || before === "in_progress") return undefined;
		if (before === "settled") await this.#reconcile(runId).catch((error: unknown) => this.#log("a settled run could not be reconciled", error));
		else await this.#startLoop(runId).catch((error: unknown) => this.#log("the loop could not start", error));
		const after = await work();
		return after === "settled" || after === "not_submitted" ? again : undefined;
	}

	/**
	 * The facts' delivery, waited for at most RPC_WAIT_MS as any job waits on another side; it goes on, and once it ends it
	 * makes the job due for what is left, or removes it, which wins over this outcome. The outcome is only the net under it:
	 * a delivery cut by a reset is tried again.
	 */
	async #factsJob(): Promise<{ rescheduleAt: number }> {
		await within(this.#delivery.deliver(), RPC_WAIT_MS).catch((error: unknown) => this.#log("the facts' delivery is still running", error));
		return { rescheduleAt: Date.now() + WATCH_MS };
	}

	#deadline(runId: RunId): Promise<{ rescheduleAt: number } | undefined> {
		return this.#store.outside(() => {
			const run = this.#store.run(runId);
			if (!run || !ACTIVE.has(run.status) || run.deadline === null) return undefined;
			if (run.deadline > Date.now()) return { rescheduleAt: run.deadline };
			this.#store.finish(runId, TIMED_OUT);
			return undefined;
		});
	}

	#sweep(): Promise<{ rescheduleAt: number } | undefined> {
		return this.#store.outside(() => {
			const { nextAt } = this.#store.write(() => this.#ledger().sweepLostWrites(Date.now()));
			return nextAt === null ? undefined : { rescheduleAt: nextAt };
		});
	}

	async #retryReleases(): Promise<{ rescheduleAt: number } | undefined> {
		for (const run of this.#store.unreleased()) await this.#release(run);
		for (const runId of this.#store.releases()) await this.#releaseRefused(runId);
		return this.#store.unreleased().length || this.#store.releases().length ? { rescheduleAt: Date.now() + RELEASE_RETRY_MS } : undefined;
	}

	// pi's side of a run.

	/** pi's commits as they are adopted: a settled `run:<id>` submission ends the run. Never throws. */
	#onPiCommit(publication: CommitPublication): void {
		try {
			const entries = new Map<number, EntryRecord>();
			for (const change of publication.changes) if (change.type === "entry") entries.set(change.value.id, change.value);
			for (const change of publication.changes) {
				if (change.type !== "submission") continue;
				const submission = change.value;
				if (!submission.requestId?.startsWith("run:")) continue;
				if (submission.status !== "done" && submission.status !== "unanswered") continue;
				const runId = submission.requestId.slice(4);
				this.#settle(runId, submission, entries).catch((error: unknown) => this.#settleLater(runId, error));
			}
		} catch (error) {
			this.#log("a pi commit could not be read", error);
		}
	}

	/** pi will not publish a settlement again: a failed one is retried by the watch, which reconciles it. */
	#settleLater(runId: RunId, error: unknown): void {
		this.#log("a settled run could not be ended", error);
		if (this.#store.run(runId)) this.#push({ id: `watch:${runId}`, fn: "watch", time: Date.now() + WATCH_MS, payload: { runId } });
	}

	async #settle(runId: RunId, submission: SubmissionRecord, entries: Map<number, EntryRecord>): Promise<void> {
		const run = this.#store.run(runId);
		if (!run || !ACTIVE.has(run.status)) return;
		const fence = { runId, attempt: run.attempt };
		if (submission.status === "unanswered") {
			this.#log(`the model turn ended without an answer (${submission.reason})`);
			await this.#fail(fence, WORKER_FAILED);
			return;
		}
		if (submission.status !== "done" || submission.type !== "input") return;
		const entry = entries.get(submission.answer) ?? (await this.#entry(run, submission.answer));
		// The folder as the turn left it, before the turn counts as complete.
		if (!(await this.#finishLocal(fence))) return;
		await this.#complete(fence, answerOf(entry));
	}

	/** pi settled the run's submission while the object was away: reconcile from pi's record, stop what is left. */
	async #reconcile(runId: RunId): Promise<void> {
		const run = this.#store.run(runId);
		if (!run || run.session === null || !this.#piStorage) return;
		const submission = await this.#piStorage.submissionByRequest(Number(run.session) as PiConversationId, `run:${runId}`, BG);
		if (submission) await this.#settle(runId, submission, new Map());
		await this.#stopPi(runId);
	}

	async #entry(run: RunRow, id: number): Promise<EntryRecord | undefined> {
		const pi = await this.harness.pi();
		const conversation = await pi.conversation(Number(run.session) as PiConversationId, BG);
		return (await conversation?.entries({ minEntryId: id as never, maxEntryId: id as never }, 1, undefined, BG))?.items[0];
	}

	/**
	 * `complete`: the assistant message, the `message` event and `completed`, in one transaction and
	 * in that order, only while the attempt is current. An empty answer, or one past what a WorkerEvent could
	 * carry, fails the run instead. Outside pi's transactions (store.ts `outside`), as every end.
	 */
	async #complete(fence: AttemptFence, { text, call }: Answer): Promise<void> {
		if (!text || text.length > ANSWER_CHARS) {
			this.#log(text ? "the answer is too long" : "the model turn ended without a response");
			await this.#fail(fence, WORKER_FAILED);
			return;
		}
		await this.#store.outside(() =>
			this.#store.write(() => {
				if (!this.#store.isCurrent(fence)) return;
				const now = this.#store.now();
				const id = uuid7(now);
				this.#store.insertMessage({ id, role: "assistant", content: text, attachments: [], runId: fence.runId, createdAt: now });
				this.#store.append(fence.runId, { type: "message", data: { id, content: text, ...(call === undefined ? {} : { call }) } });
				this.#store.finish(fence.runId, COMPLETED, { attempt: fence.attempt });
			}),
		);
	}

	/**
	 * The loop's failure ends the run only while its attempt is current: a replaced or expired attempt's
	 * `failed` event is dropped, and an expired run is marked `timed_out` by its deadline instead.
	 */
	async #fail(fence: AttemptFence, end: RunEnd): Promise<void> {
		await this.#store.outside(() =>
			this.#store.write(() => {
				if (this.#store.isCurrent(fence)) this.#store.finish(fence.runId, end, { attempt: fence.attempt });
			}),
		);
	}

	/** After a run ended, outside its transaction: its calls cut, its stream ended, pi stopped, the Workspace told. */
	#afterFinish(runId: RunId): void {
		this.#controllers.get(runId)?.abort(new Error(RUN_ENDED_MESSAGE));
		this.#controllers.delete(runId);
		this.#running.delete(runId);
		this.#phases.delete(runId);
		this.#executors.delete(runId);
		this.#queues.delete(runId);
		this.#scriptRuns.forget(runId);
		this.#locals.get(runId)?.end();
		this.#locals.delete(runId);
		this.#saving.delete(runId);
		this.#waiting.delete(runId);
		this.#stream.end(runId);
		this.#defer(async () => {
			await this.lifecycle.jobs.cancel(`watch:${runId}`);
			await this.lifecycle.jobs.cancel(`deadline:${runId}`);
			const run = this.#store.run(runId);
			if (run) await this.#release(run);
			this.#touchIndex();
			await this.#stopPi(runId);
		});
		// Its container, whichever attempt or instance started it (a later run's is never touched); a destroy
		// that fails, or that a reset of this object lost, is done by the `sandbox` job or the next start.
		this.#defer(async () => {
			try {
				await destroyRunSandbox(this.#sandbox(), runId, "The run ended.");
			} catch (error) {
				this.#log("the run's sandbox could not be destroyed", error);
				this.#push({ id: "sandbox", fn: "sandbox", time: Date.now() + RELEASE_RETRY_MS });
			}
		});
	}

	/** Aborts everything pi still runs for the run's session, background work included. */
	async #stopPi(runId: RunId): Promise<void> {
		const run = this.#store.run(runId);
		if (!run || run.session === null) return;
		const pi = await this.harness.pi();
		const conversation = await pi.conversation(Number(run.session) as PiConversationId, BG);
		await conversation?.abort(BG, { background: true });
	}

	async #release(run: RunRow): Promise<void> {
		if (run.released || ACTIVE.has(run.status)) return;
		try {
			await within(this.#workspace().release(run.id, run.status), RPC_WAIT_MS);
			this.#store.update(run.id, { released: 1 });
		} catch (error) {
			this.#log("the Workspace did not hear that a run ended", error);
			this.#push({ id: "release", fn: "release", time: Date.now() + RELEASE_RETRY_MS });
		}
	}

	/** A start refused after `beginRun`: its registration and reservations are released, retried until heard. */
	async #releaseRefused(runId: RunId): Promise<void> {
		try {
			await within(this.#workspace().release(runId, "refused"), RPC_WAIT_MS);
			this.#store.deleteRelease(runId);
		} catch (error) {
			this.#log("the Workspace did not hear that a start was refused", error);
			this.#push({ id: "release", fn: "release", time: Date.now() + RELEASE_RETRY_MS });
		}
	}

	// Tools, the executor and the model.

	#installTools(run: RunRow): void {
		this.#registry?.install(this.#extension(run));
	}

	/** The `minerva` extension for a run: its connector tools, in the model's order (gateway/tools.ts). */
	#extension(run: RunRow | null): Extension {
		if (run === null) return { name: "minerva", tools: [] };
		const host = this.#toolHost();
		let listed: ToolDeclaration[];
		try {
			listed = this.#executor(run.id).declarations();
		} catch (error) {
			// A snapshot the executor cannot read is a bug; the factory must still open pi, or no event of this
			// object could run. The run goes on without connector tools.
			this.#log("the run's tools could not be built", error);
			listed = [];
		}
		// read, write, edit and bash in the run's container, after the connector tools and `run_script`.
		const images = (this.env as { IMAGES?: ImagesBinding }).IMAGES;
		const locals = localToolSpecs({ deadline: run.deadline, images: images && cloudflareImages(images) }).map((local) => this.#localTool(local, host));
		const tools = modelTools<ToolDeclaration, ToolRegistration>(
			listed,
			locals,
			(declaration) => connectorTool(declaration, host),
			(all) => scriptTool(all, this.#scriptHost(host)),
		);
		return { name: "minerva", tools };
	}

	/**
	 * A local tool (local.ts): the run's current attempt, the replay cap for `read`, the phases, the attempt's
	 * container as the call's ExecutionEnv, and the checkpoint barrier (`runGated`), whose result reaches pi
	 * only once a checkpoint saved what the call did. Its `local_tool` event is appended when it is released.
	 */
	#localTool(local: LocalTool, host: ToolHost): ToolRegistration {
		const conversation = this;
		const safe = local.tool.replay === "safe";
		return {
			...local.tool,
			async execute(args, api, context) {
				const run = host.current(api.conversationId);
				if (run === null) return { content: [{ type: "text", text: RUN_ENDED_MESSAGE }], isError: true };
				const { fence } = run;
				if (safe && (await host.executions(fence.runId, api.callId)) > 1 + REPLAYS_ALLOWED) return { content: [{ type: "text", text: REPLAY_REFUSED }], isError: true };
				const attempt = conversation.#localOf(fence);
				if (attempt === null) return { content: [{ type: "text", text: RUN_ENDED_MESSAGE }], isError: true };
				host.started(fence.runId, api.callId, local.name);
				try {
					const env = await conversation.#waitFor(fence, attempt, context.abortSignal);
					const result = await runGated(attempt.calls, local, args, { ...api, env }, context);
					await conversation.#point("local:released", local.name);
					return result;
				} finally {
					host.ended(fence.runId, api.callId);
				}
			},
		};
	}

	// The run's folder in its container (local-run.ts).

	/** The attempt's LocalRun in this instance, made when first needed; null for an attempt that is not current. */
	#localOf(fence: AttemptFence): LocalRun | null {
		const existing = this.#locals.get(fence.runId);
		if (existing && existing.fence.attempt === fence.attempt) return existing;
		const run = this.#store.run(fence.runId);
		const context = this.#portsContext();
		if (!run || run.attempt !== fence.attempt || !this.#store.isCurrent(fence) || !context) return null;
		existing?.end();
		const limits = this.#store.snapshot(run).limits as FolderLimits;
		const made = new LocalRun({
			fence,
			spec: sandboxSpec(context.workspace, context.conversationId, limits, run.deadline),
			deadline: run.deadline,
			sandbox: () => this.#sandbox(),
			folder: this.#folder() as FolderPort,
			sink: outputSink,
			report: (event) => this.#reportLocal(fence, event),
			saving: (active) => {
				if (active) this.#saving.add(fence.runId);
				else this.#saving.delete(fence.runId);
				this.#showPhase(fence);
			},
			fail: (error) => this.#localFailed(fence, error, limits),
			point: (name, detail) => this.#point(name, detail),
			log: (message) => this.#log(message),
		});
		this.#locals.set(fence.runId, made);
		return made;
	}

	/**
	 * At the start of an attempt its container is prepared (started, hardened, verified, hydrated from the
	 * run's last checkpoint, else its base version) while the model starts, so it is usually ready before the
	 * first local call; a failure surfaces only when a call needs it.
	 */
	#prepareLocal(run: RunRow): void {
		this.#localOf({ runId: run.id, attempt: run.attempt })?.prepare();
	}

	/** A local call's environment; "Preparing files" shows while a call waits for the container. */
	async #waitFor(fence: AttemptFence, local: LocalRun, signal: AbortSignal | undefined) {
		const waits = local.preparing;
		if (waits) {
			this.#waiting.set(fence.runId, (this.#waiting.get(fence.runId) ?? 0) + 1);
			this.#showPhase(fence);
		}
		try {
			return await untilAborted(local.env(), signal);
		} finally {
			if (waits) {
				const left = (this.#waiting.get(fence.runId) ?? 1) - 1;
				if (left > 0) this.#waiting.set(fence.runId, left);
				else this.#waiting.delete(fence.runId);
				this.#showPhase(fence);
			}
		}
	}

	/**
	 * The turn's last checkpoint, rehashing every file; false when the attempt cannot complete (its failure was
	 * handled). An instance without the attempt's LocalRun (the object restarted after pi settled the turn,
	 * for example while the final checkpoint ran or after it failed) has nothing to save: its container is
	 * replaced, and every result pi recorded was released only after a checkpoint saved it, so the run's last
	 * checkpoint is the folder as the turn left it, but for a change the rehash would have found.
	 */
	async #finishLocal(fence: AttemptFence): Promise<boolean> {
		const local = this.#locals.get(fence.runId);
		if (!local || local.fence.attempt !== fence.attempt) return true;
		try {
			await local.finish();
			return true;
		} catch {
			return false;
		}
	}

	/** A local call's card, after its result was released; outside pi's transactions, for the attempt only. */
	#reportLocal(fence: AttemptFence, event: LocalToolEvent): void {
		this.#store
			.outside(() => void this.#store.append(fence.runId, localToolEvent(event.tool, event.summary, event.ok, event.excerpt), fence))
			.catch((error: unknown) => this.#log("a local tool call could not be recorded", error));
	}

	/**
	 * The attempt's local calls cannot go on (local.ts), and no held result is released before this settles:
	 * a folder over its limits fails the turn with `folder_limit` and that limit's own message,
	 * then the object is reset, so pi never commits a held result; a container that
	 * failed its hardening or checks fails the turn as `worker_failed` (no local call ran in it); anything
	 * else ends the attempt by resetting the object, and the next attempt starts from the last checkpoint.
	 */
	async #localFailed(fence: AttemptFence, error: Error, limits: FolderLimits): Promise<void> {
		this.#log(`the attempt's local calls stop: ${error.name}: ${error.message}`);
		if (error instanceof SandboxRefused) {
			await this.#fail(fence, WORKER_FAILED).catch((failure: unknown) => this.#log("a run whose sandbox failed could not be ended", failure));
			return;
		}
		if (error instanceof FolderOverLimit) {
			const end: RunEnd = { status: "failed", code: "folder_limit", message: folderLimitMessage(error.limit as FolderLimit, limits) };
			const ended = await this.#store
				.outside(() =>
					this.#store.write(() => {
						if (!this.#store.isCurrent(fence) || !this.#store.finish(fence.runId, end, { attempt: fence.attempt })) return false;
						// The end's clean-up (#afterFinish: its container destroyed, the Workspace told) is deferred, and
						// the reset below cuts it: its retries are stored with the end, so the next start finishes it.
						const at = Date.now() + RELEASE_RETRY_MS;
						for (const fn of ["sandbox", "release"]) {
							this.lifecycle.jobs.push({ id: fn, fn, time: at }).catch((failure: unknown) => this.#log(`the job ${fn} was not scheduled`, failure));
						}
						return true;
					}),
				)
				.catch((failure: unknown) => {
					this.#log("a run over its folder's limits could not be ended", failure);
					return false;
				});
			// Durable before the reset, which may drop what is not.
			if (ended) await this.ctx.storage.sync().catch((failure: unknown) => this.#log("storage did not sync", failure));
			// Whether ended here or already over, nothing of the attempt may reach pi now.
			this.#reset(`${ATTEMPT_ENDED}${error.message}`, ended || this.#store.isCurrent(fence));
			return;
		}
		this.#reset(`${ATTEMPT_ENDED}${error.message}`, this.#store.isCurrent(fence));
	}

	/** Resets the object (`ctx.abort()`), when `needed`: what this instance holds in memory dies with it. */
	#reset(reason: string, needed: boolean): void {
		if (!needed) return;
		try {
			this.ctx.abort(reason.slice(0, 500));
		} catch {
			// The reset is under way.
		}
	}

	#sandbox() {
		return this.#ports.sandbox(this.#portsContext() as PortsContext);
	}

	/** Destroys a container a run that ended left running (its end's destroy failed, or a reset lost it); retried until done. */
	async #cleanSandbox(): Promise<{ rescheduleAt: number } | undefined> {
		if (!this.#store.conversation()) return undefined;
		try {
			const ended = (runId: string) => {
				const run = this.#store.run(runId);
				return run !== null && !ACTIVE.has(run.status);
			};
			await destroyRunSandbox(this.#sandbox(), ended, "The run ended.");
			return undefined;
		} catch (error) {
			this.#log("a sandbox left by an ended run could not be destroyed", error);
			return { rescheduleAt: Date.now() + RELEASE_RETRY_MS };
		}
	}

	async #point(name: string, detail?: string): Promise<void> {
		const point = this.#ports.point;
		if (point) await point(this.#portsContext() as PortsContext, name, detail);
	}

	/** `run_script`'s host (scripts/host.ts): the connector tools' run and phases, scripted calls through `#invoke`. */
	#scriptHost(host: ToolHost) {
		return scriptToolHost({
			runs: this.#scriptRuns,
			current: (session) => host.current(session),
			runSignal: (runId) => (this.#store.isActive(runId) ? this.#controller(runId).signal : AbortSignal.abort(new Error(RUN_ENDED_MESSAGE))),
			invoke: (fence, declaration, args, drop) => this.#invoke(fence, declaration, args, undefined, drop),
			scripts: () => {
				const conversation = this.#store.conversation();
				if (!conversation) throw new Error("A run's conversation is stored.");
				return scriptsObject(this.env, this.#store.workspaceRef(conversation), conversation.id) as unknown as ScriptsClient;
			},
			waitUntil: (promise) => this.ctx.waitUntil(promise.catch((error: unknown) => this.#log("a script's reset failed", error))),
			started: (runId, callId, name) => host.started(runId, callId, name),
			ended: (runId, callId) => host.ended(runId, callId),
		});
	}

	#executor(runId: RunId): Executor {
		let executor = this.#executors.get(runId);
		if (!executor) {
			const run = this.#store.run(runId) as RunRow;
			const snapshot = this.#store.snapshot(run);
			executor = this.#ports.executor(
				{
					runId,
					userId: snapshot.userId,
					permissions: snapshot.permissions,
					tools: snapshot.tools,
					run: this.#runState(),
					credentials: this.#credentials(snapshot),
					fetch: this.#ports.fetch(this.#portsContext() as PortsContext),
					deadline: snapshot.deadline,
				},
				this.#portsContext() as PortsContext,
			);
			this.#executors.set(runId, executor);
		}
		return executor;
	}

	/** The executor's view of the run (gateway/run-state.ts `RunStatePort`): our checks and the ledger's records (ports.ts `runStatePort`). */
	#runState(): RunStatePort {
		return runStatePort(this.#store, () => this.#ledger(), (runId) => this.#scheduleSweep(runId));
	}

	/**
	 * A lease is for the call's attempt: checked before the Workspace, or Laravel, is asked and again after. A Laravel run's
	 * credentials come from `leaseToken` and are held in memory for the one call (laravel-runs.ts).
	 */
	#credentials(snapshot: RunSnapshot): CredentialPort {
		const context = this.#portsContext() as PortsContext;
		if (context.organization !== null) {
			return laravelCredentials({
				env: this.env,
				scope: { organization: context.organization, workspace: context.workspace.id },
				conversation: context.conversationId,
				snapshot,
				isCurrent: (fence) => this.#store.isCurrent(fence),
				log: (message, error) => this.#log(message, error, true),
			});
		}
		const ended = { refused: "RUN_ENDED" as const, message: RUN_ENDED_MESSAGE };
		return {
			lease: async (fence, connectionId) => {
				if (!this.#store.isCurrent(fence)) return ended;
				const lease = await this.#workspace().lease(connectionId, { run: fence.runId, userId: snapshot.userId });
				if (!this.#store.isCurrent(fence)) return ended;
				return lease;
			},
			markUnauthorized: (connectionId, generation) => this.#workspace().markUnauthorized(connectionId, generation),
			// Bound to the run's workspace and the leased connection: a lease of another row does not decrypt.
			open: async (lease) =>
				"payload" in lease ? lease.payload : ((await (await this.#keys()).decrypt(credentialBinding(snapshot.workspaceId, lease.connectionId), lease.sealed)) as unknown as CredentialPayload),
		};
	}

	#toolHost(): ToolHost {
		const store = this.#store;
		return {
			current: (session) => {
				const run = store.runBySession(String(session));
				if (!run) return null;
				this.#entered("tool", run.id);
				const fence = { runId: run.id, attempt: run.attempt };
				return store.isCurrent(fence) ? { fence, deadline: run.deadline } : null;
			},
			// Outside pi's transactions (store.ts `outside`): the replay cap counts what ran, so its count must not roll back.
			executions: (runId, callId) => store.outside(() => store.countExecution(runId, callId)),
			argumentText: (runId, callId) => store.argumentText(runId, callId),
			invoke: (fence, declaration, args, signal) => this.#invoke(fence, declaration, args, signal),
			started: (runId, callId, name) => {
				let running = this.#running.get(runId);
				if (!running) this.#running.set(runId, (running = new Map()));
				running.set(callId, name);
				this.#showPhase({ runId, attempt: store.run(runId)?.attempt ?? 0 });
			},
			ended: (runId, callId) => {
				this.#running.get(runId)?.delete(callId);
				this.#showPhase({ runId, attempt: store.run(runId)?.attempt ?? 0 });
			},
		};
	}

	/**
	 * One call through the run's queue and the executor. The `tool_call` event is appended when the call
	 * settles, whether or not its caller still waits (the executor's `settled`, so a write sent before pi
	 * aborted the call is recorded with its real outcome), while the run is active (any attempt), never for
	 * RUN_ENDED (the executor returns no event then). A scripted call passes `drop` instead of `signal`: the
	 * script's end drops it while it waits for its slot, but never cuts it once sent.
	 */
	#invoke(
		fence: AttemptFence,
		declaration: ToolDeclaration,
		args: Json | undefined,
		signal: AbortSignal | undefined,
		drop?: AbortSignal,
	): Promise<ToolCallOutcome> {
		let queue = this.#queues.get(fence.runId);
		if (!queue) this.#queues.set(fence.runId, (queue = new ToolQueue()));
		const executor = this.#executor(fence.runId);
		// Cut when the run ends or its deadline passes, while the call still waits for its slot.
		const stopped = this.#store.isActive(fence.runId) ? this.#controller(fence.runId).signal : AbortSignal.abort(new Error(RUN_ENDED_MESSAGE));
		// The executor stops at pi's abort or the run's end, whichever comes first: no new provider request,
		// reads in flight cut, a write already sent still settled (gateway/executor.ts).
		const cut = signal ? AbortSignal.any([signal, stopped]) : stopped;
		// Once, outside pi's transactions (store.ts `outside`), so the record of a write that was sent cannot roll
		// back with one of pi's. A failed append is forgotten, so it is tried again when the caller hears the outcome.
		let recording: Promise<void> | null = null;
		const record = (outcome: ToolCallOutcome): Promise<void> => {
			const event = outcome.event;
			recording ??= (event ? this.#store.outside(() => void this.#store.appendToolCall(fence.runId, event, args)) : Promise.resolve()).catch(
				(error: unknown) => {
					recording = null;
					throw error;
				},
			);
			return recording;
		};
		const settled = (outcome: ToolCallOutcome) => {
			this.ctx.waitUntil(record(outcome).catch((error: unknown) => this.#log("a tool call could not be recorded", error)));
		};
		const call = queue
			.send(
				isWrite(declaration),
				() => executor.invoke({ fence, name: declaration.name, arguments: args, signal: cut, settled }),
				() => {
					signal?.throwIfAborted();
					drop?.throwIfAborted();
					stopped.throwIfAborted();
				},
			)
			.then(
				async (outcome) => {
					// Recorded before the caller hears it; an executor that does not call `settled` is recorded here.
					await record(outcome).catch(() => record(outcome));
					return outcome;
				},
				(error: unknown): ToolCallOutcome => {
					if (signal?.aborted || drop?.aborted || stopped.aborted) throw error;
					this.#log("a tool call failed", error);
					return { ok: false, error: { code: "FAILED", message: "The operation could not be completed. Check the connection and try again." }, event: null };
				},
			);
		this.ctx.waitUntil(call.catch(() => {}));
		return call;
	}

	/**
	 * The lost-write sweep for a write just dispatched: its window closes at most 60 s from now, or at the
	 * run's deadline, and it is lost 30 s after that. An earlier sweep already scheduled stays.
	 */
	#scheduleSweep(runId: RunId): void {
		const deadline = this.#store.run(runId)?.deadline ?? null;
		const now = Date.now();
		const time = Math.min(now + SWEEP_AFTER_MS, deadline === null ? Number.POSITIVE_INFINITY : deadline + LOST_WRITE_GRACE_MS);
		const scheduled = this.lifecycle.jobs.get("sweep");
		if (scheduled && scheduled.time <= time) return;
		this.#push({ id: "sweep", fn: "sweep", time });
	}

	/**
	 * What cuts a run's model streams and waiting tool calls: aborted when the run ends, and at its deadline,
	 * whichever comes first, so a deadline job that runs late cannot let a stream go on.
	 */
	#controller(runId: RunId): AbortController {
		let controller = this.#controllers.get(runId);
		if (!controller) {
			const created = new AbortController();
			controller = created;
			this.#controllers.set(runId, created);
			const deadline = this.#store.run(runId)?.deadline ?? null;
			if (deadline !== null) {
				const timer = setTimeout(() => created.abort(new Error("The run took too long.")), Math.max(0, deadline - Date.now()));
				created.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
			}
		}
		return controller;
	}

	#modelHost(): ModelHost {
		const store = this.#store;
		return {
			begin: (sessionId) => {
				const run = sessionId ? store.runByProviderSession(sessionId) : null;
				if (!run) return null;
				this.#entered("model", run.id);
				const fence = { runId: run.id, attempt: run.attempt };
				if (!store.isCurrent(fence)) return null;
				return { fence, signal: this.#controller(run.id).signal };
			},
			counted: (fence) => store.countModelCall(fence.runId),
			current: (fence) => store.isCurrent(fence),
			deltas: (fence, call, segments) => {
				store.write(() => {
					for (const [kind, text] of segments) store.append(fence.runId, { type: kind === "text" ? "text_delta" : "reasoning_delta", data: { text, call } }, fence);
				});
			},
			toolCallText: (fence, callId, text) => {
				// A key without an escape parses right with JSON.parse; only text with a backslash is kept.
				if (text.includes("\\")) store.saveArgumentText(fence.runId, callId, text);
			},
			// Outside pi's transactions (store.ts `outside`): a call's cost does not roll back, so neither may its record.
			settled: (fence, usage) => {
				this.ctx.waitUntil(store.outside(() => store.settleModelCall(fence.runId, usage)).catch((error: unknown) => this.#log("a model call's usage could not be recorded", error)));
			},
			log: (message) => this.#log(message),
		};
	}

	// Phases: emitted only when they change, fenced by the attempt.

	#phase(fence: AttemptFence, text: string): void {
		if (this.#phases.get(fence.runId) === text) return;
		if (this.#store.append(fence.runId, phaseEvent(text), fence)) this.#phases.set(fence.runId, text);
	}

	#showPhase(fence: AttemptFence): void {
		// Saving files first, then a call waiting for its container, then the order of events.ts `phaseOf`.
		const saving = this.#saving.has(fence.runId);
		this.#phase(fence, !saving && this.#waiting.has(fence.runId) ? "Preparing files" : phaseOf(saving, this.#running.get(fence.runId)?.values() ?? []));
	}

	// Ports.

	#entered(kind: "model" | "tool", runId: RunId): void {
		if (this.#ports.entered) this.#ports.entered(this.#portsContext() as PortsContext, kind, runId);
	}

	/** The registry the conversation's runs answer to: its Workspace object, or for a Laravel conversation, none (laravel-runs.ts). */
	#workspace(): WorkspaceClient {
		const context = this.#portsContext() as PortsContext;
		return context.organization === null ? this.#ports.workspace(context) : laravelRuns;
	}

	#folderInstance: FolderPort | null = null;

	#folder(): FolderPort | null {
		if (!this.#folderInstance) {
			const context = this.#portsContext();
			if (context) this.#folderInstance = this.#ports.folder(context);
		}
		return this.#folderInstance;
	}

	#ledger(): WriteLedger {
		this.#ledgerInstance ??= this.#ports.ledger(
			this.ctx.storage,
			{
				isCurrent: (fence) => this.#store.isCurrent(fence),
				deadline: (runId) => this.#store.run(runId)?.deadline ?? null,
				writesUncertain: (runId) => this.#store.run(runId)?.writes_uncertain === 1,
				markWritesUncertain: (runId) => this.#store.setWritesUncertain(runId),
				writeSettled: (write, outcome) => this.#store.writeSettled(write, outcome),
			},
			this.#portsContext() as PortsContext,
		);
		return this.#ledgerInstance;
	}

	#portsContext(): PortsContext | null {
		const conversation = this.#store.conversation();
		if (!conversation) return null;
		return {
			env: this.env,
			ctx: this.ctx,
			workspace: this.#store.workspaceRef(conversation),
			conversationId: conversation.id,
			organization: conversation.organization_id,
			folderVersionId: () => this.#store.conversation()?.folder_version_id ?? null,
			connectors: () => {
				if (this.#connectors === null) throw new Error("The connector registry is loaded when pi opens.");
				return this.#connectors;
			},
			store: this.#store,
			schedule: (time) => {
				// The folder's sweep (src/files/): one job, moved only earlier.
				const scheduled = this.lifecycle.jobs.get("files");
				if (scheduled && scheduled.time <= time) return;
				this.#push({ id: "files", fn: "files", time });
			},
		};
	}

	#keys(): Promise<EncryptionKeys> {
		this.#keyRing ??= EncryptionKeys.parse(this.env.MINERVA_ENCRYPTION_KEYS);
		return this.#keyRing;
	}

	#touchIndex(): void {
		const conversation = this.#store.conversation();
		if (!conversation) return;
		this.#defer(() => this.#workspace().conversationTouched(conversation.id, { title: conversation.title, updatedAt: conversation.updated_at }));
	}

	#owned(caller: Caller) {
		const conversation = this.#store.conversation();
		return conversation && conversation.deleted_at === null && conversation.user_id === caller.userId ? conversation : null;
	}

	#ownedRun(caller: Caller, runId: RunId): RunRow | null {
		if (!this.#owned(caller) || !isUuid(runId)) return null;
		return this.#store.run(runId);
	}

	/**
	 * A Lifecycle job of the host. Its row is written synchronously (Lifecycle's queue is SQL), so inside a
	 * `write` it commits with the change; the alarm is rearmed afterwards.
	 */
	#push(job: { id: string; fn: string; time: number; payload?: { runId: RunId } }): void {
		this.lifecycle.jobs.push(job).catch((error: unknown) => this.#log(`the job ${job.id} was not scheduled`, error));
	}

	/** Work that outlives the event that started it; failures are logged. */
	#defer(work: () => Promise<unknown>): void {
		this.ctx.waitUntil(
			Promise.resolve()
				.then(work)
				.catch((error: unknown) => this.#log("deferred work failed", error)),
		);
	}

	/** `severe` for what an operator must look at (a bug, a misconfiguration, a delivery stopped), logged as an error. */
	#log(message: string, error?: unknown, severe = false): void {
		const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
		(severe ? console.error : console.warn)(`conversation ${this.ctx.id.name ?? ""}: ${message}${detail}`.slice(0, 2000));
	}
}

/** What pi holds for a run, read through the factory's storage (the gate) or after open. */
async function piWork(storage: SqliteStorage, run: RunRow): Promise<PiWork> {
	if (run.session === null) return "not_submitted";
	const id = Number(run.session) as PiConversationId;
	const submission = await storage.submissionByRequest(id, `run:${run.id}`, BG);
	let live = 0;
	for (const status of LIVE_TASKS) live += (await storage.scanTasks({ conversationId: id, status }, 1, undefined, BG)).items.length;
	return classifyWork(submission?.status, live);
}

/** The history replay, in the commit that creates the run's session: one timestamp for every entry. */
async function replay(tx: Tx, id: PiConversationId, history: { role: "user" | "assistant"; content: string }[]): Promise<void> {
	const timestamp = Date.now();
	for (const message of history) {
		if (message.role === "user") {
			await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: message.content, timestamp }] });
		} else {
			await tx.appendEntry(AssistantEntry, id, {
				model: [
					{
						role: "assistant",
						content: [{ type: "text", text: message.content }],
						api: MINERVA_API,
						provider: MINERVA_PROVIDER,
						model: MODEL_ALIAS,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop",
						timestamp,
					},
				],
			});
		}
	}
}

type Answer = { text: string; call: string | undefined };

/** The answer: the text blocks of the assistant message joined and trimmed, and the model call that wrote it. */
function answerOf(entry: EntryRecord | undefined): Answer {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return { text: "", call: undefined };
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
	return { text, call: callOf(message) };
}

/** Settles like `promise`, or rejects after `ms`, leaving it to run on. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms.`)), ms);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** The uploads a start marker names. */
function idsOf(start: StartRow): string[] {
	const parsed = parseJson(start.upload_ids);
	return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

function deletedRefusal(): StartRefusal {
	return startRefusal("CONVERSATION_DELETED", "This conversation was deleted.");
}

function runOfPayload(payload: unknown): RunId | null {
	const runId = payload !== null && typeof payload === "object" ? (payload as { runId?: unknown }).runId : undefined;
	return typeof runId === "string" && isUuid(runId) ? runId : null;
}
