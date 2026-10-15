// The Sandbox's logic (`SandboxApi`; ARCHITECTURE.md: The sandbox lifecycle), over its ports so
// it runs the same in the Durable Object, in unit tests and against a local container.
//
// The container's lifecycle is `starting → hardening → verified → in_use → destroying`, each state written
// before the step it names. Nothing the agent can influence runs before `verified`. Every call names the
// incarnation, run and attempt it is for and is refused for any other; a start for an older attempt than
// the newest one seen is refused too, so a late call from a replaced attempt can never touch the next
// attempt's container. A destroy that fails stays owed (`cleanupPending`) and is retried by the alarm.
//
// When the object restarts (an eviction, a crash, a deploy) it has lost its exec handles. A running
// container it had verified is verified again before its next use; one it had not is destroyed at once.
// Commands and file operations run side by side; hydration, scans and checkpoints need the folder to
// themselves and are refused (`busy`) while anything else runs, as the Conversation's barrier expects.

import type { AttemptFence, EpochMs } from "../shared/rpc.ts";
import { type ExecOutputSink, type ExecRequest, type ExecResult, type RunningCommand, runCommand } from "./commands.ts";
import {
	AGENT_CGROUP,
	CLEANUP_RETRY_MS,
	DEADLINE_GRACE_MS,
	FILE_OPERATION_SECONDS,
	IDLE_MS,
	INSTANCE,
	MAX_INACTIVITY_MS,
	type SandboxSpec,
	workspaceBytes,
} from "./constants.ts";
import { fileOperation, type FsRequest, type FsResponse } from "./files.ts";
import { type CheckpointUploadPlan, type CheckpointUploadResult, hydrate, type HydratePlan, type HydrateResult, upload } from "./folder.ts";
import {
	DROPPED_PROBE,
	type HardeningReport,
	type VerificationReport,
	hardeningArgv,
	hardeningReport,
	verificationArgv,
	verificationReport,
} from "./hardening.ts";
import type { SandboxPorts } from "./ports.ts";
import { ContainerGone, helperEnvironment, type Machine, runRoot, sleep, within } from "./process.ts";
import { type FolderIndex, scan, type ScanResult } from "./scan.ts";
import { olderThan, readState, type SandboxState, type StateRow, writeState } from "./store.ts";
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
}

export type Refused = { refused: "stale" | "not_verified" | "busy"; message: string };

/**
 * The Sandbox Durable Object's RPC surface. A refusal for a fence that is not current is `{refused:
 * "stale"}`; before verification, `{refused: "not_verified"}`.
 */
export interface SandboxApi {
	/** Destroys any container left from an earlier incarnation first, then starts one for this attempt. */
	start(fence: AttemptFence, spec: SandboxSpec): Promise<{ incarnation: string } | Refused | { failed: string }>;
	harden(fence: SandboxFence): Promise<HardeningReport | Refused>;
	verify(fence: SandboxFence): Promise<VerificationReport | Refused>;
	exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused>;
	/** Kills one command's processes; idempotent. */
	cancel(fence: SandboxFence, execId: string): Promise<void>;
	fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused>;
	hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused>;
	scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused>;
	checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused>;
	/** `echo 1 > /sys/fs/cgroup/agent/cgroup.kill`, then verify the cgroup is empty; catches setsid processes. */
	killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused>;
	/** Destroys this incarnation's container; refused for any other incarnation. */
	destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused>;
	status(): Promise<SandboxStatus>;
}

const READY_MS = 90_000;
const ROOT_MS = 60_000;
const STRAYS_GONE_MS = 5000;
/** A destroy that has not answered after this is owed, for the alarm. */
const DESTROY_MS = 60_000;
const KEEP_ALIVE_MS = 10_000;
/** How long past its lease a container may stay for work that is still running. */
const HARD_GRACE_MS = 10 * 60_000;

const STALE: Refused = { refused: "stale", message: "This sandbox belongs to another incarnation, run or attempt." };
const NOT_VERIFIED: Refused = { refused: "not_verified", message: "The sandbox is not ready." };
const STOPPED: Refused = { refused: "not_verified", message: "The sandbox stopped." };
const BUSY: Refused = { refused: "busy", message: "The sandbox is saving or loading the folder." };

function positiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
	/** The files the scan last hashed, so unchanged ones are not hashed again. */
	index: FolderIndex = new Map();
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

	#write(state: StateRow): void {
		writeState(this.#ports.sql, state, this.#ports.now());
		this.#state = state;
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
		let gone = true;
		if (container) {
			try {
				await within(container.destroy(reason), DESTROY_MS, "The container did not answer its destroy.");
			} catch (error) {
				gone = !container.running;
				this.#ports.log("sandbox destroy failed", { error: String(error), running: container.running });
			}
		}
		if (gone) {
			this.#write({ ...this.#state, state: "none", incarnation: null, hardened: false, cleanupPending: false, cleanupReason: null, leaseUntil: null });
		}
		await this.#schedule();
		this.#ports.log("sandbox destroyed", { reason: reason.slice(0, 200), gone });
		return gone;
	}

	/** Destroys the container when `generation` is still the current one: a late doubt never reaches the next. */
	async #doubt(generation: Generation, reason: string): Promise<void> {
		await this.#serial(async () => {
			if (this.#generation === generation) await this.#destroyNow(reason);
		});
	}

	/** After a restart: a container verified before is verified again before it is used; any other is destroyed. */
	async recover(): Promise<void> {
		await this.#serial(async () => {
			const container = this.#ports.container;
			const state = this.#state;
			if (!container) return;
			if (container.running) {
				if ((state.state === "verified" || state.state === "in_use") && state.incarnation !== null) {
					const generation = new Generation(state.incarnation);
					generation.reverify = true;
					this.#generation = generation;
					await this.#keepAlive();
				} else {
					await this.#destroyNow(`A container in state ${state.state} was running when the object started.`);
					return;
				}
			} else if (state.state !== "none") {
				this.#write({ ...state, state: "none", incarnation: null, hardened: false, cleanupPending: false, cleanupReason: null, leaseUntil: null });
			}
			await this.#schedule();
		});
	}

	status(): SandboxStatus {
		const state = this.#state;
		return {
			state: state.state,
			incarnation: state.incarnation,
			runId: state.runId,
			attempt: state.attempt,
			cleanupPending: state.cleanupPending,
			startedAt: state.startedAt,
		};
	}

	start(fence: AttemptFence, spec: SandboxSpec): Promise<{ incarnation: string } | Refused | { failed: string }> {
		return this.#serial(async () => {
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
			});
			this.#forget();
			this.#generation = new Generation(incarnation);
			try {
				container.start({ enableInternet: false, instance: INSTANCE, labels: { incarnation } });
			} catch (error) {
				await this.#destroyNow(`The container did not start: ${String(error)}`);
				return { failed: "The container did not start." };
			}
			if (!(await this.#ready())) {
				await this.#destroyNow("The container did not become ready.");
				return { failed: "The container did not become ready." };
			}
			await this.#keepAlive();
			await this.#schedule();
			return { incarnation };
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

	harden(fence: SandboxFence): Promise<HardeningReport | Refused> {
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
				report = { ok: false, failed: "workspace", output: error instanceof ContainerGone ? "The container stopped." : String(error) };
			}
			if (!report.ok) {
				await this.#destroyNow(`The hardening failed at ${report.failed}.`);
				return report;
			}
			this.#write({ ...this.#state, hardened: true });
			return report;
		});
	}

	async #verification(): Promise<VerificationReport> {
		const machine = this.#machine();
		const spec = this.#state.spec;
		if (!machine || !spec) return { ok: false, checks: [{ name: "workspace_mount", ok: false, detail: "No container." }] };
		const probe = wrapperArgv(this.#cgroup, { command: DROPPED_PROBE, cwd: "/", env: helperEnvironment(), timeoutSeconds: 10 });
		try {
			const result = await runRoot(machine, verificationArgv(this.#cgroup, probe), { timeoutMs: ROOT_MS });
			return verificationReport(spec, this.#cgroup, result.timedOut ? -1 : result.exitCode, result.stdout);
		} catch (error) {
			return { ok: false, checks: [{ name: "workspace_mount", ok: false, detail: error instanceof ContainerGone ? "The container stopped." : String(error) }] };
		}
	}

	verify(fence: SandboxFence): Promise<VerificationReport | Refused> {
		return this.#serial(async () => {
			if (!this.#owns(fence)) return STALE;
			const state = this.#state;
			if (state.state !== "hardening" || !state.hardened) return NOT_VERIFIED;
			const report = await this.#verification();
			if (!report.ok) {
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
			if (!report.ok) {
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

	/** Admits a command or file operation (or, `exclusive`, a folder step) for `fence`; its generation when admitted. */
	async #admit(fence: SandboxFence, exclusive: boolean): Promise<Refused | Generation> {
		for (;;) {
			if (!this.#owns(fence)) return STALE;
			if (this.#state.state !== "verified" && this.#state.state !== "in_use") return NOT_VERIFIED;
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
			const container = this.#ports.container;
			if (container?.running) await this.#destroyNow("A call found the container unusable.");
			else {
				this.#forget();
				this.#write({ ...this.#state, state: "none", incarnation: null, hardened: false, cleanupPending: false, cleanupReason: null, leaseUntil: null });
				await this.#schedule();
			}
		});
		return STOPPED;
	}

	async #admitted<T>(fence: SandboxFence, exclusive: boolean, work: (machine: Machine, generation: Generation) => Promise<T>): Promise<T | Refused> {
		const admitted = await this.#admit(fence, exclusive);
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
		return this.#admitted(fence, true, async (machine, generation) => {
			const spec = this.#state.spec as SandboxSpec;
			generation.scanned = null;
			const { result, index } = await hydrate(machine, this.#ports.bucket(spec.workspace), plan, spec.folderEntries);
			if (index && generation.live) generation.index = index;
			return result;
		});
	}

	scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused> {
		return this.#admitted(fence, true, async (machine, generation) => {
			const spec = this.#state.spec as SandboxSpec;
			const limits = { bytes: spec.folderBytes, entries: spec.folderEntries };
			generation.scanned = null;
			const { result, index } = await scan(machine, generation.index, limits, options.rehashAll === true);
			if (index && generation.live) generation.index = index;
			if (result.ok && generation.live) generation.scanned = new Map(Object.entries(result.sizes));
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

	/**
	 * Retries an owed destroy, and destroys a container nobody used for too long or past its run's deadline.
	 * Work still running then gets a little longer, never more than HARD_GRACE_MS past the lease, after which
	 * the container is destroyed whatever runs: a hung call cannot keep it.
	 */
	alarm(): Promise<void> {
		return this.#serial(async () => {
			const state = this.#state;
			const now = this.#ports.now();
			if (state.cleanupPending) {
				await this.#destroyNow(state.cleanupReason ?? "An owed destroy.");
				return;
			}
			if (state.state !== "none" && state.leaseUntil !== null && state.leaseUntil <= now) {
				const generation = this.#generation;
				if (generation && (generation.inflight > 0 || generation.exclusive) && now < state.leaseUntil + HARD_GRACE_MS) {
					await this.#ports.alarm(Math.min(now + 60_000, state.leaseUntil + HARD_GRACE_MS));
					return;
				}
				await this.#destroyNow(state.spec?.deadline ? "The run's deadline passed." : "The sandbox was not used for an hour.");
				return;
			}
			await this.#schedule();
		});
	}
}
