// One attempt's folder in its container (ARCHITECTURE.md: Checkpoints, The sandbox lifecycle): the
// Sandbox prepared for the attempt, either the container the conversation's previous run parked, acquired
// when it holds the version the attempt starts from, or one started, hardened, verified and hydrated from
// the run's last checkpoint, else its base version; the checkpoint barrier (local.ts `LocalCalls`) whose
// checkpoints run against it; and the ExecutionEnv each local call gets. A started container may be restored
// from the conversation's snapshot of that version, its folder seeded from the snapshot instead of R2; when
// that hydration fails in any way, the attempt prepares a container from the image and hydrates it from R2.
//
// A checkpoint: kill the agent's processes and check the cgroup is empty, scan the folder as the agent's
// user, validate the scan and record the keys of the contents the run may not read yet, let the Sandbox
// stream those files from the container into R2 (R2 checks each SHA-256; file contents never cross an RPC),
// and record the checkpoint for the attempt on top of its previous one. Only then are the held results
// released. Any failure ends the attempt through `fail` before a result is released; a folder over
// its limits fails the turn.
//
// Preparation starts when the attempt's loop starts if there is a folder to hydrate or a parked container,
// so the container is usually ready by the first local call; otherwise the first local call starts it, and
// a turn that makes none starts no container. A failure surfaces only when a local call needs the
// container. A run that never changes its folder takes no checkpoint. Once the turn's last checkpoint is
// saved the container is parked for the conversation's next run; a run that ends any other way has it
// destroyed.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ExecOutputSink } from "../sandbox/commands.ts";
import type { SandboxSpec } from "../sandbox/constants.ts";
import type { Refused, SandboxApi, SandboxFence } from "../sandbox/core.ts";
import { SandboxExecutionEnv } from "../sandbox/env.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult, HydratePlan, HydrateResult } from "../sandbox/folder.ts";
import type { Delivered } from "../sandbox/output.ts";
import { type Prepared, prepareSandbox } from "../sandbox/session.ts";
import type { AttemptFence, EpochMs, VersionId } from "../shared/rpc.ts";
import { FolderOverLimit, FolderUnavailable, LocalCalls, type LocalToolEvent, LocalToolStuck, SandboxRefused } from "./local.ts";
import type { FolderPort } from "./ports.ts";

/**
 * The Sandbox calls a conversation makes: an attempt's, `status` for the clean-up at a run's end, `seal` for its
 * settlement, and `forget` for its deletion.
 */
export type SandboxPort = Pick<
	SandboxApi,
	"start" | "harden" | "verify" | "acquire" | "exec" | "cancel" | "fs" | "hydrate" | "scan" | "checkpoint" | "killStrays" | "park" | "destroy" | "status" | "seal" | "forget"
>;

export interface LocalRunDeps {
	fence: AttemptFence;
	spec: SandboxSpec;
	/** The run's deadline: a command without its own timeout stops there. */
	deadline: EpochMs | null;
	/** The conversation's Sandbox; a new stub for each use, so a broken one is never kept. */
	sandbox(): SandboxPort;
	folder: Pick<FolderPort, "hydratePlan" | "checkpoint">;
	/** Makes the RpcTarget a command's output comes back through (src/sandbox/sink.ts). */
	sink(output: (chunk: Delivered) => void): ExecOutputSink;
	report(event: LocalToolEvent): void;
	saving(active: boolean): void;
	/** The attempt cannot go on (local.ts's errors say how): called once; held results wait for what it returns. */
	fail(error: Error): void | Promise<void>;
	/** Before the Sandbox is asked for a container: the run's container time is counted from the first (store.ts `containerStarting`). */
	containerStarting(): Promise<void>;
	/** The test build's fault points (ConversationPorts.point); production has none. */
	point?(name: string, detail?: string): Promise<void>;
	log(message: string): void;
}

/** A container prepared for the attempt, not yet hydrated. */
type Ready = Extract<Prepared, { ok: true }>;

function refused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

/** How long each step of a preparation took, for the logs and the account tests' timings. */
export interface Preparation {
	/** A parked container was acquired: no start, hardening or hydration. */
	acquired: boolean;
	/** The container was restored from the conversation's snapshot: how long the hydration's seed and check took. */
	restored: { seedMs: number; checkMs: number } | null;
	startMs: number;
	hardenMs: number;
	verifyMs: number;
	hydrateMs: number;
	files: number;
}

export class LocalRun {
	readonly fence: AttemptFence;
	readonly calls: LocalCalls;
	readonly #deps: LocalRunDeps;
	#preparing: Promise<SandboxFence> | null = null;
	#prepared: SandboxFence | null = null;
	#plan: HydratePlan | null = null;
	/** The version the working copy was built on: the hydrated one, then each accepted checkpoint's. */
	#parent: VersionId | null = null;
	#ended = false;
	preparation: Preparation | null = null;

	constructor(deps: LocalRunDeps) {
		this.#deps = deps;
		this.fence = deps.fence;
		this.calls = new LocalCalls({
			checkpoint: (options) => this.#checkpoint(options),
			killStrays: () => this.#killStrays(),
			fail: (error) => deps.fail(error),
			report: (event) => deps.report(event),
			saving: (active) => deps.saving(active),
		});
	}

	/** Whether the container is still being prepared. */
	get preparing(): boolean {
		return this.#preparing !== null && this.#prepared === null && !this.#ended;
	}

	/**
	 * Prepares at once when the attempt has files or directories to hydrate, or a container is parked, which is
	 * acquired whatever the folder holds; otherwise the first local call prepares, so a turn that makes none
	 * starts no container. Never throws: what fails here is left to that first call.
	 */
	async warm(): Promise<void> {
		try {
			const plan = this.#planned();
			if (plan.files.length > 0 || plan.dirs.length > 0 || (await this.#deps.sandbox().status()).state === "parked") void this.prepare();
		} catch (error) {
			this.#deps.log(`the sandbox was not prepared early: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Acquires the container the conversation's previous run parked, else starts, hardens and verifies one and
	 * hydrates the folder; once per attempt. A container from the image that failed its hardening or its checks fails
	 * the turn at once (ARCHITECTURE.md: The sandbox lifecycle); any other failure surfaces when a local call needs the
	 * container.
	 */
	prepare(): Promise<SandboxFence> {
		if (!this.#preparing) {
			this.#preparing = this.#prepare();
			this.#preparing.catch((error: unknown) => {
				if (error instanceof SandboxRefused) this.calls.stuck(error);
			});
		}
		return this.#preparing;
	}

	/** The version the attempt starts from, read once. */
	#planned(): HydratePlan {
		if (this.#plan) return this.#plan;
		try {
			this.#plan = this.#deps.folder.hydratePlan(this.fence.runId);
		} catch (error) {
			throw new FolderUnavailable(`The folder could not be planned: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.#plan;
	}

	async #prepare(): Promise<SandboxFence> {
		if (this.#ended) throw new FolderUnavailable("The run ended.");
		const plan = this.#planned();
		await this.#deps.containerStarting();
		const acquired = await this.#acquire(plan);
		if (acquired) return acquired;
		const began = Date.now();
		let prepared = await this.#started(plan.versionId);
		let hydrated = await this.#hydrated(prepared, plan);
		if (!hydrated.ok && prepared.restored) {
			this.#deps.log(`the sandbox's snapshot was not used after ${Date.now() - began} ms: ${hydrated.message}`);
			if (this.#ended) throw new FolderUnavailable("The run ended.");
			prepared = await this.#started(null);
			hydrated = await this.#hydrated(prepared, plan);
		}
		if (!hydrated.ok) throw new FolderUnavailable(hydrated.message);
		const { ms } = prepared;
		this.preparation = { acquired: false, restored: hydrated.restored, startMs: ms.start, hardenMs: ms.harden, verifyMs: ms.verify, hydrateMs: hydrated.ms, files: plan.files.length };
		const folder = hydrated.restored ? `seed ${hydrated.restored.seedMs} ms, check ${hydrated.restored.checkMs} ms` : `hydrate ${hydrated.ms} ms`;
		this.#deps.log(`sandbox ready${hydrated.restored ? " from its snapshot" : ""}: start ${ms.start} ms, harden ${ms.harden} ms, verify ${ms.verify} ms, ${folder} (${plan.files.length} files)`);
		this.#parent = plan.versionId;
		this.#prepared = prepared.fence;
		await this.#deps.point?.("local:prepared", JSON.stringify(this.preparation));
		return prepared.fence;
	}

	/** A container started, hardened and verified for the attempt, restored from the conversation's snapshot when it holds `restore`. */
	async #started(restore: VersionId | null): Promise<Ready> {
		const prepared = await prepareSandbox(this.#deps.sandbox(), this.fence, this.#deps.spec, restore);
		if (!prepared.ok) {
			// A container that did not start may start next time; one that failed its hardening or checks fails the turn.
			if (prepared.stage === "start") throw new FolderUnavailable(`The sandbox did not start: ${prepared.message}`);
			throw new SandboxRefused(prepared.message);
		}
		if (this.#ended) {
			await this.#destroy(prepared.fence, "The run ended while its sandbox was prepared.");
			throw new FolderUnavailable("The run ended.");
		}
		return prepared;
	}

	/**
	 * The plan's folder in the prepared container, and how long that took. A restored container's hydration that throws
	 * answers a failure too, so that the attempt can prepare from the image instead.
	 */
	async #hydrated(prepared: Ready, plan: HydratePlan): Promise<{ ok: true; ms: number; restored: Preparation["restored"] } | { ok: false; message: string }> {
		const started = Date.now();
		let hydrated: HydrateResult | Refused;
		try {
			hydrated = await this.#deps.sandbox().hydrate(prepared.fence, plan);
		} catch (error) {
			if (!prepared.restored) throw error;
			return { ok: false, message: `The folder could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (refused(hydrated)) return { ok: false, message: `The folder could not be prepared: ${hydrated.message}` };
		if (!hydrated.ok) return { ok: false, message: `The folder could not be prepared (${hydrated.reason}): ${hydrated.message}` };
		return { ok: true, ms: Date.now() - started, restored: hydrated.restored ?? null };
	}

	/**
	 * The parked container, when the Sandbox gives it to this attempt: its folder is the plan's version already. A
	 * Sandbox still on the previous version has no `acquire`, so a call that fails counts as nothing parked.
	 */
	async #acquire(plan: HydratePlan): Promise<SandboxFence | null> {
		let answer: Awaited<ReturnType<SandboxPort["acquire"]>>;
		try {
			answer = await this.#deps.sandbox().acquire(this.fence, this.#deps.spec, plan.versionId);
		} catch (error) {
			this.#deps.log(`no parked sandbox could be acquired: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
		// A refusal (a sealed run, a newer attempt) is left to the start, which the Sandbox refuses alike.
		if (refused(answer)) return null;
		if (!("incarnation" in answer)) {
			this.#deps.log(`sandbox not acquired: ${answer.reason}`);
			return null;
		}
		const fence: SandboxFence = { ...this.fence, incarnation: answer.incarnation };
		if (this.#ended) {
			await this.#destroy(fence, "The run ended while its sandbox was prepared.");
			throw new FolderUnavailable("The run ended.");
		}
		this.preparation = { acquired: true, restored: null, startMs: 0, hardenMs: 0, verifyMs: answer.verifyMs, hydrateMs: 0, files: plan.files.length };
		this.#deps.log(`sandbox acquired: verify ${answer.verifyMs} ms`);
		this.#parent = plan.versionId;
		this.#prepared = fence;
		await this.#deps.point?.("local:acquired");
		return fence;
	}

	/** The container's fence once it is ready; a failed preparation ends the attempt (or fails the turn) and rejects. */
	async #ready(): Promise<SandboxFence> {
		try {
			return await this.prepare();
		} catch (error) {
			this.calls.stuck(error instanceof Error ? error : new Error(String(error)));
			throw this.calls.failure ?? error;
		}
	}

	/** The ExecutionEnv for one local call: pi's `FileSystem & Shell` over the attempt's container. */
	async env(): Promise<ExecutionEnv> {
		const fence = await this.#ready();
		return new SandboxExecutionEnv({
			sandbox: this.#deps.sandbox(),
			fence,
			deadline: this.#deps.deadline,
			sink: (output) => this.#deps.sink(output),
			// The container is gone or in doubt: the attempt ends, and the next one starts from the last checkpoint.
			lost: (reason) => this.calls.stuck(new FolderUnavailable(`The sandbox was lost: ${reason}`)),
		});
	}

	/** The final checkpoint, rehashing every file, once the turn has its answer. */
	finish(): Promise<void> {
		return this.calls.finish();
	}

	/**
	 * After the turn's last checkpoint: the container is left for the conversation's next run, with the version the
	 * run's folder is now, its last checkpoint's, else the one it was prepared from. Nothing to park when it never
	 * prepared. Never throws: a container not parked is destroyed at the run's end.
	 */
	async park(): Promise<void> {
		const fence = this.#prepared;
		if (!fence || this.#ended) return;
		try {
			const answer = await this.#deps.sandbox().park(fence, this.#parent);
			if (refused(answer)) this.#deps.log(`the sandbox was not parked: ${answer.message}`);
			else this.#deps.log(answer.parked ? "sandbox parked" : "the sandbox was destroyed instead of parked");
		} catch (error) {
			this.#deps.log(`the sandbox could not be parked: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** The run ended: a preparation still running destroys its container once it has one. */
	end(): void {
		this.#ended = true;
	}

	async #killStrays(): Promise<void> {
		const fence = await this.#ready();
		const killed = await this.#deps.sandbox().killStrays(fence);
		if (refused(killed)) throw new FolderUnavailable(`The sandbox was lost: ${killed.message}`);
		if (!killed.ok) throw new LocalToolStuck(killed.message);
	}

	/** Scans, uploads and records a checkpoint; the agent's processes were killed just before (local.ts `#save`). */
	async #checkpoint(options: { rehashAll?: boolean }): Promise<void> {
		const fence = await this.#ready();
		const scanned = await this.#deps.sandbox().scan(fence, { rehashAll: options.rehashAll === true });
		if (refused(scanned)) throw new FolderUnavailable(`The sandbox was lost: ${scanned.message}`);
		if (!scanned.ok) {
			if ("limit" in scanned) throw new FolderOverLimit(scanned.limit);
			throw new FolderUnavailable(`The folder could not be scanned: ${scanned.message}`);
		}
		await this.#deps.point?.("checkpoint:scanned");
		const upload = async (plan: CheckpointUploadPlan): Promise<CheckpointUploadResult> => {
			const stored = await this.#deps.sandbox().checkpoint(fence, plan);
			if (refused(stored)) return { ok: false, reason: "failed", path: "", message: stored.message };
			if (stored.ok) await this.#deps.point?.("checkpoint:uploaded", String(plan.files.length));
			return stored;
		};
		const outcome = await this.#deps.folder.checkpoint(
			this.fence,
			{ parent: this.#parent, manifest: scanned.manifest, sizes: scanned.sizes, warnings: scanned.warnings },
			upload,
		);
		if (!outcome.ok) {
			if (outcome.code === "quota") throw new FolderOverLimit(outcome.limit ?? "workspace", outcome.message);
			throw new FolderUnavailable(`The checkpoint was refused (${outcome.code}): ${outcome.message}`);
		}
		this.#parent = outcome.versionId;
		await this.#deps.point?.("checkpoint:recorded", String(outcome.uploaded));
	}

	async #destroy(fence: SandboxFence, reason: string): Promise<void> {
		try {
			await this.#deps.sandbox().destroy(fence, reason);
		} catch (error) {
			// The Sandbox's lease destroys it a little after the run's deadline, or after an idle hour.
			this.#deps.log(`the sandbox could not be destroyed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/**
 * Destroys the conversation's container when `whose` says its run's is to go (a run id: that run's; a
 * function: whichever run it accepts; null: whatever runs, for the conversation's deletion), whichever attempt
 * or instance prepared it. A parked container, and one retiring from parked, is the conversation's, not its
 * run's, so only the deletion destroys it. The destroy names the container's own incarnation, so it can never
 * reach a later run's.
 */
export async function destroyRunSandbox(sandbox: Pick<SandboxApi, "status" | "destroy">, whose: string | null | ((runId: string) => boolean), reason: string): Promise<boolean> {
	const status = await sandbox.status();
	if (status.incarnation === null || status.runId === null || status.attempt === null || status.state === "none") return false;
	if ((status.state === "parked" || status.state === "retiring") && whose !== null) return false;
	if (typeof whose === "string" && status.runId !== whose) return false;
	if (typeof whose === "function" && !whose(status.runId)) return false;
	const answer = await sandbox.destroy({ runId: status.runId, attempt: status.attempt, incarnation: status.incarnation }, reason);
	return !refused(answer) && answer.destroyed;
}
