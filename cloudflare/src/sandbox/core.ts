// The Sandbox's logic (`SandboxApi`; ARCHITECTURE.md: The sandbox lifecycle), over its ports so
// it runs the same in the Durable Object, in unit tests and against a local container.
//
// The container's lifecycle is `starting → hardening → verified → in_use → destroying`, each state written
// before the step it names. Nothing the agent can influence runs before `verified`. Every call names the
// incarnation, run and attempt it is for and is refused for any other; a start for an older attempt than
// the newest one seen is refused too, so a late call from a replaced attempt can never touch the next
// attempt's container. A destroy that fails stays owed (`cleanupPending`) and is retried by the alarm.
//
// After a run's last checkpoint the Conversation parks its container (`in_use → parked`): its processes are
// killed and the folder is left as that checkpoint's version, with nothing else the agent wrote. A parked
// container belongs to the conversation, not to a run, and admits nothing. The conversation's next run
// acquires it (`parked → verified`) under a new incarnation, so every fence of the run that parked it is stale,
// if it holds the version the run starts from and was started and hardened as the run asks; anything else
// destroys it.
//
// A container parked for PARKED_MS retires (`parked → retiring → destroying`): when its folder is large enough,
// an archive of it goes onto the root disk, the container is snapshotted, and the snapshot is recorded as the
// conversation's one. The archive and the snapshot run outside the serial queue, so a start is never held behind
// them, and their outcome counts only while the retiring generation is the current one. A later start for the
// version the record holds restores that snapshot instead of starting the image, and its hydration extracts the
// archive into the folder and checks it against the plan before anything else is admitted (`restoring`). A restore
// that fails drops the record; the Conversation then prepares from the image and R2. The folder in R2 stays the
// record of a version: a snapshot is a cache in front of hydration.
//
// When the object restarts (an eviction, a crash, a deploy) it has lost its exec handles. A running
// container it had verified is verified again before its next use, a parked one when it is acquired; any
// other is destroyed at once. Commands and file operations run side by side; hydration, scans and
// checkpoints need the folder to themselves and are refused (`busy`) while anything else runs, as the
// Conversation's barrier expects.
//
// Each incarnation keeps a span (store.ts), closed with how it ended. Sealing a run, once it is over, refuses
// its later starts, destroys its container unless it parked it, and answers its spans: the run's container time.

import type { FolderWarnings } from "../files/manifest.ts";
import type { AttemptFence, EpochMs, RunId, VersionId } from "../shared/rpc.ts";
import { type ExecOutputSink, type ExecRequest, type ExecResult, type RunningCommand, runCommand } from "./commands.ts";
import {
	AGENT_CGROUP,
	CLEANUP_RETRY_MS,
	DEADLINE_GRACE_MS,
	FILE_OPERATION_SECONDS,
	FOLDER_EXTRACT,
	HARD_GRACE_MS,
	IDLE_MS,
	INSTANCE,
	MAX_INACTIVITY_MS,
	PARKED_MS,
	RETIRE_MS,
	type SandboxSpec,
	SNAPSHOT_AGE_MS,
	workspaceBytes,
} from "./constants.ts";
import { fileOperation, type FsRequest, type FsResponse } from "./files.ts";
import { type CheckpointUploadPlan, type CheckpointUploadResult, hydrate, type HydratePlan, type HydrateResult, restoredDifference, upload } from "./folder.ts";
import {
	DROPPED_PROBE,
	type HardeningReport,
	type VerificationReport,
	hardeningArgv,
	hardeningDigest,
	hardeningReport,
	PARK_LINKED,
	parkArgv,
	RETIRE_SMALL,
	retireArgv,
	seedArgv,
	snapshotFormat,
	verificationArgv,
	verificationReport,
} from "./hardening.ts";
import type { SandboxPorts } from "./ports.ts";
import { ContainerGone, helperEnvironment, type Machine, runRoot, sleep, within } from "./process.ts";
import { FOLDER_SECONDS, type FolderIndex, scan, type ScanResult } from "./scan.ts";
import {
	dropSnapshot,
	isSealed,
	olderThan,
	readSnapshot,
	readSpans,
	readState,
	type SandboxState,
	type SealedSpans,
	sealRun,
	snapshotRestored,
	type SpanEnd,
	type StateRow,
	writeSnapshot,
	writeState,
} from "./store.ts";
import { wrapperArgv } from "./wrapper.ts";

/** A container incarnation, from `start`; every later call carries it. */
export interface SandboxFence extends AttemptFence {
	incarnation: string;
}

export interface SandboxStatus {
	state: SandboxState;
	incarnation: string | null;
	runId: string | null;
	attempt: number | null;
	cleanupPending: boolean;
	startedAt: EpochMs | null;
	/** The conversation's snapshot: the version it holds and when it was taken. */
	snapshot: { versionId: VersionId; takenAt: EpochMs } | null;
}

export type Refused = { refused: "stale" | "not_verified" | "busy"; message: string };

/**
 * A hardening or verification whose exec never answered (ContainerGone): it says nothing of the container
 * but that it stopped answering. The container is destroyed, and a caller treats it as one that did not
 * start, not as one that failed its hardening or checks.
 */
export type Lost = { lost: string };

/** A container started for an attempt; `restored` when it came from the conversation's snapshot rather than the image. */
export type Started = { incarnation: string; restored: boolean };

/** A parked container taken for a new attempt, under a new incarnation, and how long its verification took. */
export type Acquired = { incarnation: string; verifyMs: number };
/** Nothing was parked, or what was parked could not be used (and is destroyed): the attempt starts a container. */
export type NotAcquired = { acquired: false; reason: string };

/**
 * The Sandbox Durable Object's RPC surface. A refusal for a fence that is not current is `{refused:
 * "stale"}`; before verification, `{refused: "not_verified"}`.
 */
export interface SandboxApi {
	/**
	 * Destroys any container left from an earlier incarnation first, then starts one for this attempt: restored from
	 * the conversation's snapshot when it holds `restore`, the version the attempt hydrates, and was taken from what
	 * `spec` and the image give now; else from the image.
	 */
	start(fence: AttemptFence, spec: SandboxSpec, restore?: VersionId | null): Promise<Started | Refused | { failed: string }>;
	harden(fence: SandboxFence): Promise<HardeningReport | Refused | Lost>;
	verify(fence: SandboxFence): Promise<VerificationReport | Refused | Lost>;
	exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused>;
	/** Kills one command's processes; idempotent. */
	cancel(fence: SandboxFence, execId: string): Promise<void>;
	fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused>;
	/**
	 * Makes the folder the plan's version: from R2, or on a restored container from the archive its snapshot holds,
	 * checked against the plan before anything else is admitted (`restore_failed` destroys it otherwise).
	 */
	hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused>;
	scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused>;
	checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused>;
	/** `echo 1 > /sys/fs/cgroup/agent/cgroup.kill`, then verify the cgroup is empty; catches setsid processes. */
	killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused>;
	/** Destroys this incarnation's container; refused for any other incarnation. */
	destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused>;
	/**
	 * For a run that is over: refuses its later starts, destroys its container if it still has one, and answers
	 * its spans. Ordered after any lifecycle step in flight. Idempotent; a span still open (a destroy that
	 * failed, owed to the alarm) closes once the alarm's destroy succeeds. A destroy already owed is left to the
	 * alarm, so a destroy that keeps hanging delays a seal at most once.
	 */
	seal(runId: RunId): Promise<SealedSpans>;
	/**
	 * Leaves this incarnation's container for the conversation's next run, its folder made the version `versionId`
	 * (the run's last checkpoint, else the version it started from). `{parked: false}` when it was destroyed instead:
	 * work of the run still in flight, a folder the last scan could not fully see, a hard link, or a failed clean-up.
	 * Idempotent for the same fence and version.
	 */
	park(fence: SandboxFence, versionId: VersionId | null): Promise<{ parked: boolean } | Refused>;
	/**
	 * Takes the parked container for this attempt if it holds `versionId` and was started and hardened as `spec` and the
	 * image ask, and passes its verification again; refused for a sealed run or an older attempt, as `start` is.
	 */
	acquire(fence: AttemptFence, spec: SandboxSpec, versionId: VersionId | null): Promise<Acquired | NotAcquired | Refused>;
	/** Drops the conversation's snapshot record and destroys a retiring container, so nothing restores the conversation's folder again. Idempotent. */
	forget(): Promise<void>;
	status(): Promise<SandboxStatus>;
}

const READY_MS = 90_000;
const ROOT_MS = 60_000;
const STRAYS_GONE_MS = 5000;
/** A destroy that has not answered after this is owed, for the alarm. */
const DESTROY_MS = 60_000;
const KEEP_ALIVE_MS = 10_000;

const STALE: Refused = { refused: "stale", message: "This sandbox belongs to another incarnation, run or attempt." };
const PARKED_REASON = `The parked sandbox was not used for ${PARKED_MS / 60_000} minutes.`;
/** The seed's own limit; the root exec around it gets a little longer, so a slow seed fails rather than losing the container. */
const SEED_GRACE_MS = 30_000;
const NOT_VERIFIED: Refused = { refused: "not_verified", message: "The sandbox is not ready." };
const STOPPED: Refused = { refused: "not_verified", message: "The sandbox stopped." };
const BUSY: Refused = { refused: "busy", message: "The sandbox is saving or loading the folder." };
const SEALED: Refused = { refused: "stale", message: "This run has ended." };

function positiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Whether a scan left out anything but symbolic links and special files, which parking removes, or more than it lists. */
function leavesOutMore(warnings: FolderWarnings): boolean {
	return warnings.total > warnings.items.length || warnings.items.some((item) => item.reason !== "symlink" && item.reason !== "special");
}

/** Whether a spec's numbers make sense: the hardening writes them into mount options and cgroup files. */
export function validSpec(spec: SandboxSpec): boolean {
	return (
		positiveInteger(spec.folderBytes) &&
		workspaceBytes(spec.folderBytes) > 0 &&
		positiveInteger(spec.folderEntries) &&
		positiveInteger(spec.tmpBytes) &&
		spec.tmpBytes % 4096 === 0 &&
		positiveInteger(spec.pidsMax) &&
		positiveInteger(spec.memoryBytes) &&
		spec.memoryBytes % 4096 === 0 &&
		(spec.deadline === undefined || spec.deadline === null || Number.isSafeInteger(spec.deadline))
	);
}

/** A parked container on its way to a snapshot: what its retire needs outside the serial queue, and what the record keeps. */
interface Retiring {
	generation: Generation;
	machine: Machine;
	versionId: VersionId;
	digest: string;
	format: string;
	deadline: number;
}

/** A command admitted by its exec id, before and after its process exists, so a cancel is never lost. */
interface PendingCommand {
	cancelled: boolean;
	running: RunningCommand | null;
}

/**
 * What belongs to one incarnation's container and dies with it: its commands, the scan's index and the files
 * of the last scan. Work admitted for an incarnation holds its generation, and nothing it does after the
 * generation ended reaches the next one.
 */
class Generation {
	live = true;
	reverify = false;
	/** Commands and file operations admitted and running. */
	inflight = 0;
	/** A hydration, scan or checkpoint is running. */
	exclusive = false;
	/** While strays are being killed, nothing is admitted and no helper starts: it would die with them, or keep the cgroup from emptying. */
	killing: Promise<unknown> | null = null;
	/**
	 * Wrapped processes past the gate whose admission is not known yet. A kill waits for them: one that
	 * joined the cgroup after the kill found it empty would run on.
	 */
	#starting = 0;
	#settled: (() => void)[] = [];
	readonly commands = new Map<string, PendingCommand>();
	/** The files the scan last hashed, so unchanged ones are not hashed again; it carries over to the run that acquires a parked container. */
	index: FolderIndex = new Map();
	/**
	 * The folder holds nothing a parked folder cannot keep but links and special files: true for a hydrated or
	 * acquired folder, then what the last scan found. A generation recovered after a restart does not know.
	 */
	scanClean = true;
	/**
	 * The regular files of the last scan and their sizes: what a checkpoint may read. Forgotten once anything
	 * else is admitted, which might change the folder.
	 */
	scanned: Map<string, number> | null = null;

	readonly incarnation: string;

	constructor(incarnation: string) {
		this.incarnation = incarnation;
	}

	/** Counts a wrapped process that passed the gate; the answer is called once it joined the cgroup or never will. */
	enter(): () => void {
		this.#starting++;
		let left = false;
		return () => {
			if (left) return;
			left = true;
			this.#starting--;
			if (this.#starting === 0) for (const settled of this.#settled.splice(0)) settled();
		};
	}

	/** True once no wrapped process is starting; false if one still is after `ms`. */
	startsSettled(ms: number): Promise<boolean> {
		if (this.#starting === 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			this.#settled.push(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	end(): void {
		this.live = false;
		for (const pending of this.commands.values()) {
			pending.cancelled = true;
			pending.running?.cancel();
		}
		this.commands.clear();
	}
}

export class SandboxCore {
	readonly #ports: SandboxPorts;
	readonly #cgroup: string;
	#state: StateRow;
	#serialized: Promise<unknown> = Promise.resolve();
	#generation: Generation | null = null;
	#reverifying: Promise<boolean> | null = null;

	constructor(ports: SandboxPorts) {
		this.#ports = ports;
		this.#cgroup = ports.cgroup ?? AGENT_CGROUP;
		this.#state = readState(ports.sql);
	}

	#machine(generation: Generation | null = this.#generation): Machine | null {
		const container = this.#ports.container;
		if (!container || !generation) return null;
		return {
			container,
			cgroup: this.#cgroup,
			live: () => generation.live && this.#generation === generation,
			admissionFailed: () => this.#doubt(generation, "A process could not be admitted to the agent cgroup."),
			lost: async () => {
				await this.#lost(generation);
			},
			gate: async () => {
				while (generation.killing) await generation.killing.catch(() => undefined);
				// Counted in the same step that found no kill running, so a kill that starts later waits for it.
				return generation.enter();
			},
		};
	}

	/** `ended` says how the incarnation went away, when this write clears it. */
	#write(state: StateRow, ended: SpanEnd | null = null): void {
		writeState(this.#ports.sql, state, this.#ports.now(), ended);
		this.#state = state;
	}

	#gone(): StateRow {
		return {
			...this.#state,
			state: "none",
			incarnation: null,
			hardened: false,
			cleanupPending: false,
			cleanupReason: null,
			leaseUntil: null,
			hardening: null,
			parkedVersion: null,
			restoring: null,
		};
	}

	/** Lifecycle steps run one at a time; commands and file operations do not wait for each other. */
	#serial<T>(step: () => Promise<T>): Promise<T> {
		const run = this.#serialized.then(step, step);
		this.#serialized = run.catch(() => undefined);
		return run;
	}

	#owns(fence: SandboxFence): boolean {
		const state = this.#state;
		return state.incarnation !== null && state.incarnation === fence.incarnation && state.runId === fence.runId && state.attempt === fence.attempt;
	}

	#lease(spec: SandboxSpec, now: number): number {
		return spec.deadline ? spec.deadline + DEADLINE_GRACE_MS : now + IDLE_MS;
	}

	async #keepAlive(): Promise<void> {
		const container = this.#ports.container;
		const until = this.#state.leaseUntil;
		if (!container || until === null || !container.running) return;
		const ms = Math.min(MAX_INACTIVITY_MS, Math.max(60_000, until - this.#ports.now() + 5 * 60_000));
		await within(container.setInactivityTimeout(ms), KEEP_ALIVE_MS, "The container did not answer.").catch((error: unknown) => this.#ports.log("sandbox inactivity timeout refused", { error: String(error) }));
	}

	async #schedule(): Promise<void> {
		const state = this.#state;
		const now = this.#ports.now();
		if (state.cleanupPending) await this.#ports.alarm(now + CLEANUP_RETRY_MS);
		else if (state.state !== "none" && state.leaseUntil !== null) await this.#ports.alarm(Math.max(state.leaseUntil, now + 1000));
		else await this.#ports.alarm(null);
	}

	/** Ends the incarnation's generation: its commands are cancelled. */
	#forget(): void {
		this.#generation?.end();
		this.#generation = null;
	}

	/** Destroys whatever container runs. True once it is gone; false leaves the destroy owed, for the alarm. */
	async #destroyNow(reason: string): Promise<boolean> {
		const container = this.#ports.container;
		this.#write({ ...this.#state, state: "destroying", cleanupPending: true, cleanupReason: reason.slice(0, 500) });
		this.#forget();
		let ended: SpanEnd | null = "destroyed";
		if (container) {
			try {
				await within(container.destroy(reason), DESTROY_MS, "The container did not answer its destroy.");
			} catch (error) {
				ended = container.running ? null : "gone";
				this.#ports.log("sandbox destroy failed", { error: String(error), running: container.running });
			}
		}
		const gone = ended !== null;
		if (gone) this.#write(this.#gone(), ended);
		await this.#schedule();
		this.#ports.log("sandbox destroyed", { reason: reason.slice(0, 200), gone });
		return gone;
	}

	/**
	 * Drops the record of the snapshot the container was restored from, if it still names it: one failed restore is
	 * enough to stop trusting a snapshot. A destroy someone asked for leaves it.
	 */
	#restoreFailed(): void {
		const snapshot = this.#state.restoring;
		if (snapshot === null) return;
		dropSnapshot(this.#ports.sql, snapshot);
		this.#ports.log("sandbox snapshot dropped", { snapshot });
	}

	/** Destroys the container when `generation` is still the current one: a late doubt never reaches the next. */
	async #doubt(generation: Generation, reason: string): Promise<void> {
		await this.#serial(async () => {
			if (this.#generation === generation) await this.#destroyNow(reason);
		});
	}

	/**
	 * After a restart: a container verified before is verified again before it is used, a parked one when it is
	 * acquired; any other is destroyed, a restored one whose folder was not checked yet and a retiring one too, whose
	 * snapshot is then never recorded.
	 */
	async recover(): Promise<void> {
		await this.#serial(async () => {
			const container = this.#ports.container;
			const state = this.#state;
			if (!container) return;
			if (container.running) {
				if ((state.state === "verified" || state.state === "in_use") && state.incarnation !== null && state.restoring === null) {
					const generation = new Generation(state.incarnation);
					generation.reverify = true;
					// The last scan's warnings went with the previous instance: parking cannot trust the folder.
					generation.scanClean = false;
					this.#generation = generation;
					await this.#keepAlive();
				} else if (state.state === "parked" && state.incarnation !== null) {
					this.#generation = new Generation(state.incarnation);
					await this.#keepAlive();
				} else {
					await this.#destroyNow(`A container in state ${state.state} was running when the object started.`);
					return;
				}
			} else if (state.state !== "none") {
				this.#write(this.#gone(), "gone");
			}
			await this.#schedule();
		});
	}

	status(): SandboxStatus {
		const state = this.#state;
		const record = readSnapshot(this.#ports.sql);
		return {
			state: state.state,
			incarnation: state.incarnation,
			runId: state.runId,
			attempt: state.attempt,
			cleanupPending: state.cleanupPending,
			startedAt: state.startedAt,
			snapshot: record && { versionId: record.versionId, takenAt: record.takenAt },
		};
	}

	/**
	 * The snapshot a start for `versionId` restores: the record's, when it holds that version, was taken from what
	 * `spec` and the image give now, in the current format, and was taken or last restored less than
	 * SNAPSHOT_AGE_MS ago. An older record is dropped.
	 */
	async #restorable(spec: SandboxSpec, versionId: VersionId, image: string, now: number): Promise<string | null> {
		const record = readSnapshot(this.#ports.sql);
		if (!record) return null;
		if (now - Math.max(record.takenAt, record.restoredAt ?? 0) >= SNAPSHOT_AGE_MS) {
			dropSnapshot(this.#ports.sql, record.snapshotId);
			return null;
		}
		const matches = record.versionId === versionId && record.format === (await snapshotFormat()) && record.digest === (await hardeningDigest(spec, this.#cgroup, image));
		return matches ? record.snapshotId : null;
	}

	start(fence: AttemptFence, spec: SandboxSpec, restore?: VersionId | null): Promise<Started | Refused | { failed: string }> {
		return this.#serial(async () => {
			if (isSealed(this.#ports.sql, fence.runId)) return SEALED;
			const container = this.#ports.container;
			if (!container) return { failed: "This Worker has no container." };
			if (olderThan(fence, this.#state)) return STALE;
			if (!validSpec(spec)) return { failed: "The sandbox's limits are invalid." };
			// The newest attempt seen, written before the replaced container's destroy, which may fail: a late
			// start of the attempt it replaces is refused even then.
			if (this.#state.runId !== fence.runId || this.#state.attempt !== fence.attempt) this.#write({ ...this.#state, runId: fence.runId, attempt: fence.attempt });
			if (container.running || this.#state.state !== "none" || this.#state.cleanupPending) {
				if (!(await this.#destroyNow("Replaced by a new start."))) return { failed: "The previous container could not be destroyed." };
			}
			const now = this.#ports.now();
			const snapshot = restore ? await this.#restorable(spec, restore, container.image, now) : null;
			const incarnation = this.#ports.id();
			this.#write({
				state: "starting",
				incarnation,
				runId: fence.runId,
				attempt: fence.attempt,
				spec,
				hardened: false,
				startedAt: now,
				verifiedAt: null,
				cleanupPending: false,
				cleanupReason: null,
				leaseUntil: this.#lease(spec, now),
				hardening: null,
				parkedVersion: null,
				restoring: snapshot,
			});
			this.#forget();
			this.#generation = new Generation(incarnation);
			try {
				container.start({ enableInternet: false, instance: INSTANCE, labels: { incarnation }, ...(snapshot === null ? {} : { restore: snapshot }) });
			} catch (error) {
				this.#restoreFailed();
				await this.#destroyNow(`The container did not start: ${String(error)}`);
				return { failed: "The container did not start." };
			}
			if (!(await this.#ready())) {
				this.#restoreFailed();
				await this.#destroyNow("The container did not become ready.");
				return { failed: "The container did not become ready." };
			}
			await this.#keepAlive();
			await this.#schedule();
			if (snapshot !== null) this.#ports.log("sandbox restored from a snapshot", { snapshot, version: restore ?? null });
			return { incarnation, restored: snapshot !== null };
		});
	}

	/** The first exec waits for a container that is still starting. */
	async #ready(): Promise<boolean> {
		const machine = this.#machine();
		if (!machine) return false;
		const until = this.#ports.now() + READY_MS;
		for (;;) {
			try {
				const result = await runRoot(machine, ["/bin/true"], { timeoutMs: 30_000 });
				if (result.exitCode === 0) return true;
			} catch {
				// Not running yet.
			}
			if (this.#ports.now() > until) return false;
			await sleep(200);
		}
	}

	harden(fence: SandboxFence): Promise<HardeningReport | Refused | Lost> {
		return this.#serial(async () => {
			if (!this.#owns(fence)) return STALE;
			const state = this.#state;
			const machine = this.#machine();
			if (state.state !== "starting" || !state.spec || !machine) return NOT_VERIFIED;
			this.#write({ ...state, state: "hardening" });
			let report: HardeningReport;
			try {
				const result = await runRoot(machine, hardeningArgv(state.spec, this.#cgroup), { timeoutMs: ROOT_MS });
				report = result.timedOut ? { ok: false, failed: hardeningReport(1, result.stdout, result.stderr).failed, output: "The hardening timed out." } : hardeningReport(result.exitCode, result.stdout, result.stderr);
			} catch (error) {
				if (error instanceof ContainerGone) {
					this.#restoreFailed();
					await this.#destroyNow(`The container stopped answering its hardening: ${error.message}`);
					return { lost: "The container did not answer its hardening." };
				}
				report = { ok: false, failed: "workspace", output: String(error) };
			}
			if (!report.ok) {
				this.#restoreFailed();
				await this.#destroyNow(`The hardening failed at ${report.failed}.`);
				return report;
			}
			// Right after the start, so the row says what the container was started from.
			this.#write({ ...this.#state, hardened: true, hardening: await hardeningDigest(state.spec, this.#cgroup, machine.container.image) });
			return report;
		});
	}

	async #verification(spec: SandboxSpec | null = this.#state.spec): Promise<VerificationReport | Lost> {
		const machine = this.#machine();
		if (!machine || !spec) return { ok: false, checks: [{ name: "workspace_mount", ok: false, detail: "No container." }] };
		const probe = wrapperArgv(this.#cgroup, { command: DROPPED_PROBE, cwd: "/", env: helperEnvironment(), timeoutSeconds: 10 });
		try {
			const result = await runRoot(machine, verificationArgv(this.#cgroup, probe), { timeoutMs: ROOT_MS });
			return verificationReport(spec, this.#cgroup, result.timedOut ? -1 : result.exitCode, result.stdout);
		} catch (error) {
			if (error instanceof ContainerGone) return { lost: "The container did not answer its verification." };
			return { ok: false, checks: [{ name: "workspace_mount", ok: false, detail: String(error) }] };
		}
	}

	verify(fence: SandboxFence): Promise<VerificationReport | Refused | Lost> {
		return this.#serial(async () => {
			if (!this.#owns(fence)) return STALE;
			const state = this.#state;
			if (state.state !== "hardening" || !state.hardened) return NOT_VERIFIED;
			const report = await this.#verification();
			if ("lost" in report) {
				this.#restoreFailed();
				await this.#destroyNow("The container stopped answering its verification.");
				return report;
			}
			if (!report.ok) {
				this.#restoreFailed();
				await this.#destroyNow(`The verification failed: ${report.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}.`);
				return report;
			}
			this.#write({ ...this.#state, state: "verified", verifiedAt: this.#ports.now() });
			return report;
		});
	}

	/** After a restart, the container is verified again before anything else runs in it. */
	#reverified(generation: Generation): Promise<boolean> {
		this.#reverifying ??= this.#serial(async () => {
			if (this.#generation !== generation) return false;
			if (!generation.reverify) return true;
			const report = await this.#verification();
			if ("lost" in report || !report.ok) {
				await this.#destroyNow("The container failed its verification after the object restarted.");
				return false;
			}
			generation.reverify = false;
			return true;
		}).finally(() => {
			this.#reverifying = null;
		});
		return this.#reverifying;
	}

	/**
	 * Admits a command or file operation (or, `exclusive`, a folder step) for `fence`; its generation when admitted. A
	 * restored container admits only its hydration (`seeding`) until its folder passed the check.
	 */
	async #admit(fence: SandboxFence, exclusive: boolean, seeding: boolean): Promise<Refused | Generation> {
		for (;;) {
			if (!this.#owns(fence)) return STALE;
			if (this.#state.state !== "verified" && this.#state.state !== "in_use") return NOT_VERIFIED;
			if (this.#state.restoring !== null && !seeding) return NOT_VERIFIED;
			const generation = this.#generation;
			if (!generation || generation.incarnation !== fence.incarnation) return STOPPED;
			if (generation.reverify) {
				if (!(await this.#reverified(generation))) return NOT_VERIFIED;
				continue;
			}
			if (generation.killing) {
				await generation.killing.catch(() => undefined);
				continue;
			}
			const state = this.#state;
			if (generation.exclusive || (exclusive && generation.inflight > 0)) return BUSY;
			// Counted before any await, so a folder step and a command can never both be admitted.
			if (exclusive) generation.exclusive = true;
			else {
				generation.inflight++;
				generation.scanned = null;
			}
			const now = this.#ports.now();
			let next = state;
			if (state.state === "verified") next = { ...next, state: "in_use" };
			if (state.spec && !state.spec.deadline && (state.leaseUntil ?? 0) < now + IDLE_MS - 5 * 60_000) next = { ...next, leaseUntil: now + IDLE_MS };
			if (next !== state) {
				this.#write(next);
				if (next.leaseUntil !== state.leaseUntil) {
					await this.#keepAlive();
					await this.#schedule().catch(() => undefined);
				}
			}
			return generation;
		}
	}

	#release(generation: Generation, exclusive: boolean): void {
		if (exclusive) generation.exclusive = false;
		else generation.inflight--;
	}

	/** The container went away under a call of `generation`: that incarnation is over, and no later one is touched. */
	async #lost(generation: Generation): Promise<Refused> {
		await this.#serial(async () => {
			if (this.#generation !== generation || this.#state.state === "none") return;
			this.#restoreFailed();
			const container = this.#ports.container;
			if (container?.running) await this.#destroyNow("A call found the container unusable.");
			else {
				this.#forget();
				this.#write(this.#gone(), "gone");
				await this.#schedule();
			}
		});
		return STOPPED;
	}

	async #admitted<T>(fence: SandboxFence, exclusive: boolean, work: (machine: Machine, generation: Generation) => Promise<T>, seeding = false): Promise<T | Refused> {
		const admitted = await this.#admit(fence, exclusive, seeding);
		if (!(admitted instanceof Generation)) return admitted;
		try {
			const machine = this.#machine(admitted);
			if (!machine) return STOPPED;
			return await work(machine, admitted);
		} catch (error) {
			if (error instanceof ContainerGone) return await this.#lost(admitted);
			throw error;
		} finally {
			this.#release(admitted, exclusive);
		}
	}

	async exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused> {
		const id = request.execId;
		// Reserved before admission, which may wait (a verification, killed strays), and before the process
		// exists, so a cancel that arrives meanwhile still reaches the command.
		const reserved = this.#generation;
		let pending: PendingCommand | null = null;
		if (reserved && reserved.incarnation === fence.incarnation && this.#owns(fence) && typeof id === "string" && id !== "" && !reserved.commands.has(id)) {
			pending = { cancelled: false, running: null };
			reserved.commands.set(id, pending);
		}
		try {
			return await this.#admitted(fence, false, async (machine, generation) => {
				if (!pending || generation !== reserved) return { ok: false, code: "spawn_error", message: "An exec needs an id of its own." } satisfies ExecResult;
				if (pending.cancelled) return { ok: false, code: "aborted", message: "aborted" } satisfies ExecResult;
				const own = pending;
				return await runCommand(machine, request, sink, {
					started: (command) => {
						own.running = command;
						if (own.cancelled) command.cancel();
					},
					now: this.#ports.now,
				});
			});
		} finally {
			if (pending && reserved?.commands.get(id) === pending) reserved.commands.delete(id);
		}
	}

	async cancel(fence: SandboxFence, execId: string): Promise<void> {
		if (!this.#owns(fence)) return;
		const pending = this.#generation?.commands.get(execId);
		if (!pending) return;
		pending.cancelled = true;
		pending.running?.cancel();
	}

	fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused> {
		return this.#admitted(fence, false, (machine) => fileOperation(machine, request, this.#ports.fileSeconds ?? FILE_OPERATION_SECONDS));
	}

	hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused> {
		return this.#admitted(
			fence,
			true,
			async (machine, generation) => {
				const spec = this.#state.spec as SandboxSpec;
				generation.scanned = null;
				const restoring = this.#state.restoring;
				if (restoring !== null) return await this.#seed(machine, generation, spec, plan, restoring);
				const { result, index } = await hydrate(machine, this.#ports.bucket(spec.workspace), plan, spec.folderEntries);
				if (index && generation.live) generation.index = index;
				return result;
			},
			true,
		);
	}

	/**
	 * A restored container's hydration: the archive its snapshot holds goes into the folder, and the folder must then be
	 * exactly the plan. The run may use it from then on, and the check's index vouches for its files. Anything else
	 * destroys the container and drops the record, through the serial queue and only while the generation is the
	 * current one; a cached folder is never patched.
	 */
	async #seed(machine: Machine, generation: Generation, spec: SandboxSpec, plan: HydratePlan, snapshot: string): Promise<HydrateResult | Refused> {
		const seeded = await this.#seeded(machine, spec, plan, snapshot);
		if (typeof seeded === "string") {
			await this.#serial(async () => {
				if (this.#generation !== generation) return;
				this.#restoreFailed();
				await this.#destroyNow(seeded);
			});
			return { ok: false, reason: "restore_failed", message: seeded };
		}
		if (!generation.live) return STOPPED;
		this.#write({ ...this.#state, restoring: null });
		generation.index = seeded.index;
		snapshotRestored(this.#ports.sql, snapshot, this.#ports.now());
		this.#ports.log("sandbox folder seeded", { snapshot, ...seeded.ms });
		return { ok: true, restored: seeded.ms };
	}

	/**
	 * The seed and the check: the agent's tar extracts the archive, then a scan hashes every file again and
	 * must find the plan's files and directories and nothing else. The scan's index and each step's time, or why the
	 * folder is not the plan.
	 */
	async #seeded(machine: Machine, spec: SandboxSpec, plan: HydratePlan, snapshot: string): Promise<{ index: FolderIndex; ms: { seedMs: number; checkMs: number } } | string> {
		const record = readSnapshot(this.#ports.sql);
		if (record?.snapshotId !== snapshot || record.versionId !== plan.versionId) return "The snapshot does not hold the plan's version.";
		const started = this.#ports.now();
		const extract = wrapperArgv(this.#cgroup, { command: FOLDER_EXTRACT, cwd: "/", env: helperEnvironment(), timeoutSeconds: FOLDER_SECONDS });
		const seeded = await runRoot(machine, seedArgv(extract), { timeoutMs: FOLDER_SECONDS * 1000 + SEED_GRACE_MS });
		if (seeded.exitCode !== 0 || seeded.timedOut) return `The archive could not be seeded (exit ${seeded.exitCode}): ${seeded.stderr.slice(-200)}`;
		const seedMs = this.#ports.now() - started;
		const { result, index } = await scan(machine, new Map(), { bytes: spec.folderBytes, entries: spec.folderEntries }, true);
		if (!result.ok || !index) return "The restored folder could not be scanned.";
		const difference = restoredDifference(plan, result);
		if (difference) return `The restored folder differs from the plan at ${JSON.stringify(difference.path)} (${difference.field}).`;
		return { index, ms: { seedMs, checkMs: this.#ports.now() - started - seedMs } };
	}

	scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused> {
		return this.#admitted(fence, true, async (machine, generation) => {
			const spec = this.#state.spec as SandboxSpec;
			const limits = { bytes: spec.folderBytes, entries: spec.folderEntries };
			generation.scanned = null;
			const { result, index } = await scan(machine, generation.index, limits, options.rehashAll === true);
			if (index && generation.live) generation.index = index;
			if (result.ok && generation.live) generation.scanned = new Map(Object.entries(result.sizes));
			generation.scanClean = result.ok && !leavesOutMore(result.warnings);
			return result;
		});
	}

	checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused> {
		return this.#admitted(fence, true, async (machine, generation) => {
			const spec = this.#state.spec as SandboxSpec;
			return await upload(machine, this.#ports.bucket(spec.workspace), plan, generation.scanned);
		});
	}

	/**
	 * `cgroup.kill` the agent cgroup, then wait until it is empty: commands that other calls run die too.
	 * No call is admitted meanwhile. File operations already running through Files are outside the cgroup and go on.
	 */
	killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused> {
		return this.#admitted(fence, false, async (machine, generation) => {
			// Killed again on every round: a process that joined the cgroup
			// after a round (a helper that was starting) dies in the next.
			const script = [
				`for i in $(seq ${STRAYS_GONE_MS / 50}); do echo 1 > "$0/cgroup.kill"; grep -qx 'populated 0' "$0/cgroup.events" && exit 0; sleep 0.05; done`,
				"exit 1",
			].join("\n");
			// One kill at a time: another admitted alongside this one (both passed the admission's wait) runs
			// first, and the gate stays closed until the last is done.
			while (generation.killing) await generation.killing.catch(() => undefined);
			// Set in the same step: no wrapped process starts from now on, and the ones already starting are
			// waited for, since one that joined after the cgroup was found empty would run on.
			const killing = (async () => {
				if (!(await generation.startsSettled(STRAYS_GONE_MS))) return null;
				return await runRoot(machine, ["/bin/bash", "-c", script, this.#cgroup], { timeoutMs: STRAYS_GONE_MS + 10_000 });
			})();
			generation.killing = killing;
			try {
				const result = await killing;
				if (result?.exitCode === 0) return { ok: true as const };
				return { ok: false as const, message: "Processes left by commands could not be stopped." };
			} finally {
				if (generation.killing === killing) generation.killing = null;
			}
		});
	}

	destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused> {
		return this.#serial(async () => {
			if (!this.#owns(fence)) return STALE;
			return { destroyed: await this.#destroyNow(reason) };
		});
	}

	seal(runId: RunId): Promise<SealedSpans> {
		return this.#serial(async () => {
			sealRun(this.#ports.sql, runId, this.#ports.now());
			const state = this.#state;
			// A parked or retiring container is the conversation's, not the run's; the run's span closed when it parked.
			if (state.runId === runId && state.state !== "none" && state.state !== "parked" && state.state !== "retiring" && !state.cleanupPending) await this.#destroyNow("The run has ended.");
			return readSpans(this.#ports.sql, runId);
		});
	}

	park(fence: SandboxFence, versionId: VersionId | null): Promise<{ parked: boolean } | Refused> {
		return this.#serial(async () => {
			if (!this.#owns(fence)) return STALE;
			const state = this.#state;
			if (state.state === "parked" && state.parkedVersion === versionId) return { parked: true };
			if (state.state === "parked") {
				await this.#destroyNow("The run parked its sandbox again with another version.");
				return { parked: false };
			}
			if (state.state !== "verified" && state.state !== "in_use") return NOT_VERIFIED;
			const generation = this.#generation;
			const machine = this.#machine(generation);
			if (!generation || !machine || generation.incarnation !== fence.incarnation) return STOPPED;
			// Something of the run still runs, or the folder may hold what the checkpoint did not save.
			if (generation.inflight > 0 || generation.exclusive || generation.killing) {
				await this.#destroyNow("Work of the run was still running when it parked its sandbox.");
				return { parked: false };
			}
			if (!generation.scanClean) {
				await this.#destroyNow("The folder's last scan left out entries a parked folder cannot keep.");
				return { parked: false };
			}
			// Held for the clean-up, so nothing is admitted meanwhile.
			generation.exclusive = true;
			generation.scanned = null;
			let failed: string | null;
			try {
				const result = await runRoot(machine, parkArgv(this.#cgroup), { timeoutMs: ROOT_MS });
				if (result.exitCode === 0 && !result.timedOut) failed = null;
				else if (result.exitCode === PARK_LINKED) failed = "A file in the folder has more than one link.";
				else failed = `The sandbox could not be cleaned for parking (exit ${result.exitCode}): ${result.stderr.slice(-200)}`;
			} catch (error) {
				if (!(error instanceof ContainerGone)) throw error;
				failed = "The container did not answer its parking.";
			} finally {
				generation.exclusive = false;
			}
			if (failed !== null) {
				await this.#destroyNow(failed);
				return { parked: false };
			}
			this.#write({ ...this.#state, state: "parked", parkedVersion: versionId, leaseUntil: this.#ports.now() + (this.#ports.parkedMs ?? PARKED_MS) });
			await this.#keepAlive();
			await this.#schedule();
			this.#ports.log("sandbox parked", { version: versionId });
			return { parked: true };
		});
	}

	acquire(fence: AttemptFence, spec: SandboxSpec, versionId: VersionId | null): Promise<Acquired | NotAcquired | Refused> {
		return this.#serial(async () => {
			if (isSealed(this.#ports.sql, fence.runId)) return SEALED;
			if (olderThan(fence, this.#state)) return STALE;
			// The newest attempt seen, as a start writes it: a late call of an attempt it replaces is refused.
			if (this.#state.runId !== fence.runId || this.#state.attempt !== fence.attempt) this.#write({ ...this.#state, runId: fence.runId, attempt: fence.attempt });
			const state = this.#state;
			const container = this.#ports.container;
			if (state.state !== "parked" || !container) return { acquired: false, reason: "Nothing is parked." };
			if (!container.running) {
				this.#forget();
				this.#write(this.#gone(), "gone");
				await this.#schedule();
				return { acquired: false, reason: "The parked container stopped." };
			}
			let refusal: string | null = null;
			if (state.parkedVersion !== versionId) refusal = "The parked folder is not the version the run starts from.";
			else if (!validSpec(spec) || state.hardening !== (await hardeningDigest(spec, this.#cgroup, container.image))) refusal = "The parked container was started or hardened differently from what the run asks.";
			if (refusal !== null) {
				await this.#destroyNow(refusal);
				return { acquired: false, reason: refusal };
			}
			const started = this.#ports.now();
			const report = await this.#verification(spec);
			if ("lost" in report || !report.ok) {
				const reason = "lost" in report ? report.lost : "The parked container failed its verification.";
				await this.#destroyNow(reason);
				return { acquired: false, reason };
			}
			const now = this.#ports.now();
			const incarnation = this.#ports.id();
			// Nothing changed the folder while it was parked, so the scan's index still vouches for its files.
			const index = this.#generation?.index ?? new Map();
			this.#write({ ...state, state: "verified", incarnation, spec, startedAt: now, verifiedAt: now, leaseUntil: this.#lease(spec, now), parkedVersion: null });
			this.#forget();
			const generation = new Generation(incarnation);
			generation.index = index;
			this.#generation = generation;
			await this.#keepAlive();
			await this.#schedule();
			const verifyMs = now - started;
			this.#ports.log("sandbox acquired", { verifyMs });
			return { incarnation, verifyMs };
		});
	}

	forget(): Promise<void> {
		return this.#serial(async () => {
			dropSnapshot(this.#ports.sql);
			if (this.#state.state === "retiring") await this.#destroyNow("The conversation's snapshot was forgotten.");
		});
	}

	/**
	 * Retries an owed destroy, and destroys a container nobody used for too long or past its run's deadline; a parked
	 * one retires, with a snapshot when one would be used. Work still running then gets a little longer, never more
	 * than HARD_GRACE_MS past the lease, after which the container is destroyed whatever runs: a hung call cannot keep
	 * it. Alarms do not overlap, so the retire, which runs after the queued step, holds its own deadline.
	 */
	async alarm(): Promise<void> {
		const retiring = await this.#serial(async (): Promise<Retiring | null> => {
			const state = this.#state;
			const now = this.#ports.now();
			if (state.cleanupPending) {
				await this.#destroyNow(state.cleanupReason ?? "An owed destroy.");
				return null;
			}
			if (state.state !== "none" && state.leaseUntil !== null && state.leaseUntil <= now) {
				const generation = this.#generation;
				if (generation && (generation.inflight > 0 || generation.exclusive) && now < state.leaseUntil + HARD_GRACE_MS) {
					await this.#ports.alarm(Math.min(now + 60_000, state.leaseUntil + HARD_GRACE_MS));
					return null;
				}
				const retiring = state.state === "parked" ? await this.#retiring(now) : null;
				if (retiring) return retiring;
				const reason = state.state === "parked" || state.state === "retiring" ? PARKED_REASON : state.spec?.deadline ? "The run's deadline passed." : "The sandbox was not used for an hour.";
				await this.#destroyNow(reason);
				return null;
			}
			await this.#schedule();
			return null;
		});
		if (retiring) await this.#retire(retiring);
	}

	/**
	 * At the parked lease, in the serial queue: the parked container is written `retiring` when a snapshot of it would
	 * be used, and null leaves it to be destroyed. None would be when the class starts no named image, the folder has
	 * no version (it is empty), the container was started or hardened otherwise than the current code gives its spec
	 * (a start would never restore it), or the record holds this version already, taken as it would be now.
	 */
	async #retiring(now: number): Promise<Retiring | null> {
		const state = this.#state;
		const generation = this.#generation;
		const machine = this.#machine(generation);
		if (!generation || !machine || !machine.container.image || state.parkedVersion === null || !state.spec) return null;
		const digest = await hardeningDigest(state.spec, this.#cgroup, machine.container.image);
		const format = await snapshotFormat();
		const record = readSnapshot(this.#ports.sql);
		if (state.hardening !== digest || (record?.versionId === state.parkedVersion && record.digest === digest && record.format === format)) return null;
		const deadline = now + RETIRE_MS;
		this.#write({ ...state, state: "retiring", leaseUntil: deadline });
		await this.#schedule();
		return { generation, machine, versionId: state.parkedVersion, digest, format, deadline };
	}

	/**
	 * The retire's archive and snapshot, outside the serial queue so a start is never held behind them. The outcome comes
	 * back through the queue and counts only while the retiring generation is the current one: a start, `forget` or a
	 * deletion ends it first, so a retire that finishes after them neither records a snapshot nor destroys the next
	 * container. A snapshot that completes after its container was destroyed is recorded nowhere and expires.
	 */
	async #retire({ generation, machine, versionId, digest, format, deadline }: Retiring): Promise<void> {
		const started = this.#ports.now();
		let snapshot: { id: string; size: number } | null = null;
		let failed: string | null = null;
		try {
			const result = await runRoot(machine, retireArgv(this.#cgroup), { timeoutMs: Math.max(0, deadline - this.#ports.now()) });
			if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== RETIRE_SMALL)) {
				failed = `The folder could not be archived (exit ${result.exitCode}): ${result.stderr.slice(-200)}`;
			} else if (result.exitCode === 0) {
				// The container port is the object's, not the incarnation's: once a start replaced this generation, the call
				// would snapshot the new container. Nothing awaits between this check and the call.
				if (!generation.live || this.#generation !== generation) failed = "The retiring container was replaced.";
				else snapshot = await within(machine.container.snapshot(versionId), Math.max(0, deadline - this.#ports.now()), "The snapshot did not answer in time.");
			}
		} catch (error) {
			failed = error instanceof Error ? error.message : String(error);
		}
		const ms = this.#ports.now() - started;
		await this.#serial(async () => {
			if (this.#generation !== generation) return;
			if (snapshot) writeSnapshot(this.#ports.sql, { snapshotId: snapshot.id, versionId, digest, format, takenAt: this.#ports.now(), restoredAt: null });
			await this.#destroyNow(failed === null ? PARKED_REASON : `${PARKED_REASON} Its snapshot failed: ${failed}`);
		});
		this.#ports.log("sandbox retired", { version: versionId, snapshot: snapshot?.id ?? null, bytes: snapshot?.size ?? null, ms, failed });
	}
}
