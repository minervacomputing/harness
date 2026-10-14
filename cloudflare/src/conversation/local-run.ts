// One attempt's folder in its container (ARCHITECTURE.md: Checkpoints, The sandbox lifecycle): the
// Sandbox prepared for the attempt (started, hardened, verified) and hydrated from the run's last
// checkpoint, else its base version; the checkpoint barrier (local.ts `LocalCalls`) whose checkpoints run
// against it; and the ExecutionEnv each local call gets.
//
// A checkpoint: kill the agent's processes and check the cgroup is empty, scan the folder as the agent's
// user, validate the scan and record the keys of the contents the run may not read yet, let the Sandbox
// stream those files from the container into R2 (R2 checks each SHA-256; file contents never cross an RPC),
// and record the checkpoint for the attempt on top of its previous one. Only then are the held results
// released. Any failure ends the attempt through `fail` before a result is released; a folder over
// its limits fails the turn.
//
// Preparation starts when the attempt's loop starts, so the container is usually ready by the first local
// call; a failure surfaces only when a local call needs the container. A run that never changes its folder
// takes no checkpoint, and its container is destroyed when the run ends.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ExecOutputSink } from "../sandbox/commands.ts";
import type { SandboxSpec } from "../sandbox/constants.ts";
import type { Refused, SandboxApi, SandboxFence } from "../sandbox/core.ts";
import { SandboxExecutionEnv } from "../sandbox/env.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult } from "../sandbox/folder.ts";
import type { Delivered } from "../sandbox/output.ts";
import { prepareSandbox } from "../sandbox/session.ts";
import type { AttemptFence, EpochMs, VersionId } from "../shared/rpc.ts";
import { FolderOverLimit, FolderUnavailable, LocalCalls, type LocalToolEvent, LocalToolStuck, SandboxRefused } from "./local.ts";
import type { FolderPort } from "./ports.ts";

/** The Sandbox calls a conversation makes: an attempt's, and `status` for the clean-up at a run's end. */
export type SandboxPort = Pick<SandboxApi, "start" | "harden" | "verify" | "exec" | "cancel" | "fs" | "hydrate" | "scan" | "checkpoint" | "killStrays" | "destroy" | "status">;

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
	/** The test build's fault points (ConversationPorts.point); production has none. */
	point?(name: string, detail?: string): Promise<void>;
	log(message: string): void;
}

function refused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

/** How long each step of a preparation took, for the logs and the account tests' timings. */
export interface Preparation {
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
	 * Starts, hardens and verifies the attempt's container and hydrates the folder; once per attempt. A
	 * container that failed its hardening or its checks fails the turn at once (ARCHITECTURE.md: The sandbox lifecycle);
	 * any other failure surfaces when a local call needs the container.
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

	async #prepare(): Promise<SandboxFence> {
		if (this.#ended) throw new FolderUnavailable("The run ended.");
		const sandbox = this.#deps.sandbox();
		const prepared = await prepareSandbox(sandbox, this.fence, this.#deps.spec);
		if (!prepared.ok) {
			// A container that did not start may start next time; one that failed its hardening or checks fails the turn.
			if (prepared.stage === "start") throw new FolderUnavailable(`The sandbox did not start: ${prepared.message}`);
			throw new SandboxRefused(prepared.message);
		}
		if (this.#ended) {
			await this.#destroy(prepared.fence, "The run ended while its sandbox was prepared.");
			throw new FolderUnavailable("The run ended.");
		}
		let plan: ReturnType<LocalRunDeps["folder"]["hydratePlan"]>;
		try {
			plan = this.#deps.folder.hydratePlan(this.fence.runId);
		} catch (error) {
			throw new FolderUnavailable(`The folder could not be planned: ${error instanceof Error ? error.message : String(error)}`);
		}
		const started = Date.now();
		const hydrated = await this.#deps.sandbox().hydrate(prepared.fence, plan);
		if (refused(hydrated)) throw new FolderUnavailable(`The folder could not be prepared: ${hydrated.message}`);
		if (!hydrated.ok) throw new FolderUnavailable(`The folder could not be prepared (${hydrated.reason}): ${hydrated.message}`);
		this.preparation = { startMs: prepared.ms.start, hardenMs: prepared.ms.harden, verifyMs: prepared.ms.verify, hydrateMs: Date.now() - started, files: plan.files.length };
		this.#deps.log(
			`sandbox ready: start ${prepared.ms.start} ms, harden ${prepared.ms.harden} ms, verify ${prepared.ms.verify} ms, hydrate ${this.preparation.hydrateMs} ms (${plan.files.length} files)`,
		);
		this.#parent = plan.versionId;
		this.#prepared = prepared.fence;
		await this.#deps.point?.("local:prepared");
		return prepared.fence;
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
 * function: whichever run it accepts), whichever attempt or instance prepared it. The destroy names the
 * container's own incarnation, so it can never reach a later run's.
 */
export async function destroyRunSandbox(sandbox: Pick<SandboxApi, "status" | "destroy">, whose: string | null | ((runId: string) => boolean), reason: string): Promise<boolean> {
	const status = await sandbox.status();
	if (status.incarnation === null || status.runId === null || status.attempt === null || status.state === "none") return false;
	if (typeof whose === "string" && status.runId !== whose) return false;
	if (typeof whose === "function" && !whose(status.runId)) return false;
	const answer = await sandbox.destroy({ runId: status.runId, attempt: status.attempt, incarnation: status.incarnation }, reason);
	return !refused(answer) && answer.destroyed;
}
