// A stand-in for a conversation's Sandbox in local workerd, which has no containers (ConversationPorts.sandbox):
// a folder in memory with the Sandbox's fences, hydration from and checkpoints into the workspace's bucket
// (with the SHA-256 R2 checks), a scan that reports limits, each start's span for a run's seal, parking for the next
// run and acquiring a parked folder of the run's version, a parked folder retired into the conversation's snapshot
// and restored by a start for its version, and a tiny command language for the bash tool.
// It lives in the tests' isolate, so it survives the conversation's resets as a container would; a start
// for a new attempt replaces the folder, as a new container does. The real container is the unit tests'
// (Docker) and the account's.
//
// Commands, joined by " && ": `put <path> <text>`, `fill <path> <bytes>`, `cat <path>`, `rm <path>`,
// `sleep <ms>`, `exit <n>`, `hold` (until `release()` or a cancel).

import { type FileErrorCode, LineScanner } from "@earendil-works/pi-durable/env";
import type { SandboxPort } from "../../src/conversation/local-run.ts";
import type { FolderWarnings } from "../../src/files/manifest.ts";
import { hex } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { ExecOutputSink, ExecRequest, ExecResult } from "../../src/sandbox/commands.ts";
import type { SandboxSpec } from "../../src/sandbox/constants.ts";
import type { Acquired, NotAcquired, NotStarted, Refused, SandboxFence, SandboxStatus, Started } from "../../src/sandbox/core.ts";
import type { FsRequest, FsResponse } from "../../src/sandbox/files.ts";
import type { CheckpointUploadPlan, CheckpointUploadResult, HydratePlan, HydrateResult } from "../../src/sandbox/folder.ts";
import type { ScanResult } from "../../src/sandbox/scan.ts";
import type { HardeningReport, VerificationReport } from "../../src/sandbox/hardening.ts";
import type { ContainerSpan, SealedSpans } from "../../src/sandbox/store.ts";
import type { AttemptFence, RunId, VersionId } from "../../src/shared/rpc.ts";

const ROOT = "/workspace/";
const STALE: Refused = { refused: "stale", message: "This sandbox belongs to another incarnation, run or attempt." };
const NOT_VERIFIED: Refused = { refused: "not_verified", message: "The sandbox is not ready." };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface MemoryFile {
	data: Uint8Array;
	mode: 420 | 493;
	mtime: number;
}

export interface MemoryFaults {
	/** The start fails, as a container that does not come up. */
	start?: boolean;
	/** The hardening fails at this step. */
	harden?: HardeningReport["failed"];
	/** The scan reports this folder limit. */
	limit?: "folder_bytes" | "folder_entries";
	/** The scan's warnings. */
	warnings?: FolderWarnings;
	/** The checkpoint's upload fails. */
	upload?: boolean;
	/** Killing strays fails: processes that would not die. */
	strays?: boolean;
	/** A restored container's folder fails its check against the plan, or its hydration call throws, as a reset object's does. */
	seed?: "differs" | "throws";
}

/** The conversation's snapshot: the folder of the parked container that retired, and its version. */
interface MemorySnapshot {
	versionId: VersionId;
	files: Map<string, MemoryFile>;
	dirs: Set<string>;
}

async function sha256(data: Uint8Array): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)));
}

function relative(path: string): string | null {
	if (!path.startsWith(ROOT)) return null;
	const rest = path.slice(ROOT.length).replace(/\/+$/, "");
	return rest === "" || rest.split("/").some((part) => part === "" || part === "." || part === "..") ? null : rest;
}

function failure(code: FileErrorCode, message: string): FsResponse {
	return { ok: false, code, message };
}

export class MemorySandbox implements SandboxPort {
	readonly log: string[] = [];
	readonly files = new Map<string, MemoryFile>();
	readonly dirs = new Set<string>();
	faults: MemoryFaults = {};
	#fence: SandboxFence | null = null;
	#spec: SandboxSpec | null = null;
	#state: SandboxStatus["state"] = "none";
	#startedAt: number | null = null;
	#parkedVersion: VersionId | null = null;
	#snapshot: MemorySnapshot | null = null;
	/** The started container was restored, and its folder is not checked yet. */
	#restoring = false;
	/** The version each start was asked to restore. */
	readonly restores: (VersionId | null)[] = [];
	/** Each start's span, by run: open while its folder is the one in use. */
	readonly #spans: { runId: string; span: ContainerSpan }[] = [];
	readonly #holds = new Map<string, (cancelled: boolean) => void>();
	readonly #bucket: () => R2Bucket;

	constructor(bucket: () => R2Bucket) {
		this.#bucket = bucket;
	}

	/** Lets every `hold` go on. */
	release(): void {
		for (const resume of this.#holds.values()) resume(false);
		this.#holds.clear();
	}

	get holding(): number {
		return this.#holds.size;
	}

	#owns(fence: SandboxFence): boolean {
		const own = this.#fence;
		return own !== null && own.incarnation === fence.incarnation && own.runId === fence.runId && own.attempt === fence.attempt && this.#state !== "none";
	}

	/**
	 * As the Sandbox refuses a call: another fence's is stale, a parked or retiring container admits nothing, and a restored
	 * one only its hardening, verification and hydration (`checking`) until its folder passed the check.
	 */
	#refusal(fence: SandboxFence, checking = false): Refused | null {
		if (!this.#owns(fence)) return STALE;
		return this.#state === "parked" || this.#state === "retiring" || (this.#restoring && !checking) ? NOT_VERIFIED : null;
	}

	async start(fence: AttemptFence, spec: SandboxSpec, restore: VersionId | null = null): Promise<Started | Refused | NotStarted> {
		const restored = restore !== null && this.#snapshot?.versionId === restore;
		this.log.push(restored ? `start ${fence.attempt} restored` : `start ${fence.attempt}`);
		this.restores.push(restore);
		if (this.faults.start) return { failed: "The container did not become ready.", restored };
		this.release();
		this.files.clear();
		this.dirs.clear();
		this.#end();
		const incarnation = uuid7();
		this.#fence = { ...fence, incarnation };
		this.#spec = spec;
		this.#state = "starting";
		this.#restoring = restored;
		this.#startedAt = Date.now();
		this.#spans.push({ runId: fence.runId, span: { startedAt: this.#startedAt, leaseUntil: this.#startedAt + 3_600_000, endedAt: null, ended: null } });
		return { incarnation, restored };
	}

	async harden(fence: SandboxFence): Promise<HardeningReport | Refused> {
		const refusal = this.#refusal(fence, true);
		if (refusal) return refusal;
		if (this.faults.harden) {
			this.#state = "none";
			return { ok: false, failed: this.faults.harden, output: "" };
		}
		this.#state = "hardening";
		return { ok: true, failed: null, output: "" };
	}

	async verify(fence: SandboxFence): Promise<VerificationReport | Refused> {
		const refusal = this.#refusal(fence, true);
		if (refusal) return refusal;
		this.#state = "verified";
		return { ok: true, checks: [] };
	}

	async exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused> {
		const refusal = this.#refusal(fence);
		if (refusal) return refusal;
		this.#state = "in_use";
		const command = typeof request.command === "string" ? request.command : request.command.join(" ");
		this.log.push(`exec ${command}`);
		for (const step of command.split(" && ")) {
			const [verb = "", path = "", ...rest] = step.trim().split(" ");
			const target = relative(path.startsWith("/") ? path : `${ROOT}${path}`);
			if (verb === "put" && target) this.#write(target, encoder.encode(rest.join(" ")));
			else if (verb === "fill" && target) this.#write(target, new Uint8Array(Number(rest[0] ?? 0)));
			else if (verb === "cat" && target) {
				const file = this.files.get(target);
				if (!file) {
					sink?.output({ stream: "stderr", text: `cat: ${path}: No such file or directory\n` });
					return { ok: true, exitCode: 1 };
				}
				sink?.output({ stream: "stdout", text: decoder.decode(file.data) });
			} else if (verb === "rm" && target) this.files.delete(target);
			else if (verb === "sleep") await new Promise((resolve) => setTimeout(resolve, Number(path)));
			else if (verb === "exit") return { ok: true, exitCode: Number(path) };
			else if (verb === "hold") {
				const cancelled = await new Promise<boolean>((resolve) => this.#holds.set(request.execId, resolve));
				if (cancelled) return { ok: false, code: "aborted", message: "aborted" };
			} else {
				sink?.output({ stream: "stderr", text: `${verb}: command not found\n` });
				return { ok: true, exitCode: 127 };
			}
		}
		return { ok: true, exitCode: 0 };
	}

	async cancel(fence: SandboxFence, execId: string): Promise<void> {
		if (!this.#owns(fence)) return;
		this.#holds.get(execId)?.(true);
		this.#holds.delete(execId);
	}

	#write(path: string, data: Uint8Array, append = false): void {
		const before = append ? (this.files.get(path)?.data ?? new Uint8Array()) : new Uint8Array();
		const joined = new Uint8Array(before.length + data.length);
		joined.set(before);
		joined.set(data, before.length);
		this.files.set(path, { data: joined, mode: 420, mtime: Date.now() });
	}

	#info(path: string): { name: string; path: string; kind: "file" | "directory"; size: number; mtimeMs: number } | null {
		const name = path.split("/").pop() ?? "";
		const file = this.files.get(path);
		if (file) return { name, path: `${ROOT}${path}`, kind: "file", size: file.data.length, mtimeMs: file.mtime };
		const prefix = `${path}/`;
		if (this.dirs.has(path) || [...this.files.keys()].some((key) => key.startsWith(prefix))) return { name, path: `${ROOT}${path}`, kind: "directory", size: 0, mtimeMs: 0 };
		return null;
	}

	async fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused> {
		const refusal = this.#refusal(fence);
		if (refusal) return refusal;
		this.log.push(`fs ${request.op}`);
		const missing = () => failure("not_found", "No such file or directory");
		switch (request.op) {
			case "canonical":
				return { ok: true, value: request.path };
			case "lstat": {
				const path = relative(request.path);
				const info = path === null ? null : this.#info(path);
				return info ? { ok: true, value: info } : missing();
			}
			case "readFile": {
				const path = relative(request.path);
				const file = path === null ? undefined : this.files.get(path);
				return file ? { ok: true, value: file.data } : missing();
			}
			case "writeFile":
			case "appendFile": {
				const path = relative(request.path);
				if (path === null) return failure("permission_denied", "Permission denied");
				this.#write(path, request.content, request.op === "appendFile");
				return { ok: true, value: null };
			}
			case "mkdir": {
				const path = relative(request.path);
				if (path !== null) this.dirs.add(path);
				return { ok: true, value: null };
			}
			case "open":
			case "stat": {
				const path = relative(request.path);
				const info = path === null ? null : this.#info(path);
				if (!info) return missing();
				return info.kind === "file" ? { ok: true, value: info } : failure("is_directory", "Is a directory");
			}
			case "read": {
				const path = relative(request.path);
				const file = path === null ? undefined : this.files.get(path);
				return file ? { ok: true, value: file.data.slice(request.offset, request.offset + request.length) } : missing();
			}
			case "scanLines": {
				const path = relative(request.path);
				const file = path === null ? undefined : this.files.get(path);
				if (!file) return missing();
				const scanner = new LineScanner(request.startLine, request.endLine);
				scanner.push(file.data);
				return { ok: true, value: scanner.finish() };
			}
			default:
				return failure("unknown", `${request.op} is not part of the memory sandbox.`);
		}
	}

	async hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused> {
		const refusal = this.#refusal(fence, true);
		if (refusal) return refusal;
		if (this.#restoring) return this.#seed(plan);
		this.log.push(`hydrate ${plan.files.length}`);
		if (this.files.size || this.dirs.size) return { ok: false, reason: "not_empty", message: "/workspace is not empty." };
		for (const file of plan.files) {
			const object = await this.#bucket().get(file.key);
			if (!object) return { ok: false, reason: "blob_missing", message: `Blob ${file.sha256} is missing.` };
			const data = new Uint8Array(await object.arrayBuffer());
			if ((await sha256(data)) !== file.sha256) return { ok: false, reason: "mismatch", message: "A blob did not match its hash." };
			this.files.set(file.path, { data, mode: file.mode, mtime: file.mtime });
		}
		for (const dir of plan.dirs) this.dirs.add(dir);
		return { ok: true };
	}

	/** A restored container's folder from the snapshot; one that fails its check is destroyed, and the snapshot dropped. */
	#seed(plan: HydratePlan): HydrateResult {
		this.log.push(`seed ${plan.files.length}`);
		if (this.faults.seed === "throws") throw new Error("The Sandbox was reset.");
		const snapshot = this.#snapshot;
		if (this.faults.seed === "differs" || snapshot?.versionId !== plan.versionId) {
			const message = 'The restored folder differs from the plan at "stray.txt" (extra file).';
			this.#snapshot = null;
			this.#restoring = false;
			this.#end();
			this.#state = "none";
			this.log.push(`destroy ${message}`);
			return { ok: false, reason: "restore_failed", message };
		}
		for (const [path, file] of snapshot.files) this.files.set(path, file);
		for (const dir of snapshot.dirs) this.dirs.add(dir);
		this.#restoring = false;
		return { ok: true, restored: { seedMs: 0, checkMs: 0 } };
	}

	async scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused> {
		const refusal = this.#refusal(fence);
		if (refusal) return refusal;
		this.log.push(options.rehashAll ? "scan rehash" : "scan");
		if (this.faults.limit) return { ok: false, limit: this.faults.limit };
		const paths = [...this.files.keys()].sort();
		const files = [];
		const sizes: { [path: string]: number } = {};
		for (const path of paths) {
			const file = this.files.get(path) as MemoryFile;
			files.push({ path, sha256: await sha256(file.data), mode: file.mode, mtime: file.mtime });
			sizes[path] = file.data.length;
		}
		const parents = new Set<string>();
		for (const path of [...paths, ...this.dirs]) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
		}
		const dirs = [...this.dirs].filter((dir) => !parents.has(dir)).sort();
		return { ok: true, manifest: { files, dirs }, sizes, warnings: this.faults.warnings ?? { total: 0, items: [] } };
	}

	async checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused> {
		const refusal = this.#refusal(fence);
		if (refusal) return refusal;
		this.log.push(`checkpoint ${plan.files.length}`);
		if (this.faults.upload) return { ok: false, reason: "failed", path: plan.files[0]?.path ?? "", message: "A file could not be saved." };
		const stored = [];
		for (const planned of plan.files) {
			const file = this.files.get(planned.path);
			if (!file || file.data.length !== planned.size) return { ok: false, reason: "changed", path: planned.path, message: "A file changed while the folder was saved." };
			if (planned.key === null) {
				// Contents the conversation stores already: hashed, not written.
				const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", file.data as Uint8Array<ArrayBuffer>));
				if ([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") !== planned.sha256) return { ok: false, reason: "mismatch", path: planned.path, message: "A file did not match its hash." };
			} else await this.#bucket().put(planned.key, file.data, { sha256: planned.sha256 });
			stored.push({ path: planned.path, sha256: planned.sha256, size: planned.size, key: planned.key });
		}
		return { ok: true, stored };
	}

	async killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused> {
		const refusal = this.#refusal(fence);
		if (refusal) return refusal;
		this.log.push("kill");
		if (this.faults.strays) return { ok: false, message: "Processes left by commands could not be stopped." };
		return { ok: true };
	}

	async destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused> {
		if (!this.#owns(fence)) return STALE;
		this.log.push(`destroy ${reason}`);
		this.release();
		this.#end();
		this.#state = "none";
		return { destroyed: true };
	}

	/** The run's spans, its folder destroyed first if it is the one in use and not parked or retiring. Later starts are not refused. */
	async seal(runId: RunId): Promise<SealedSpans> {
		this.log.push("seal");
		if (this.#fence?.runId === runId && this.#state !== "none" && this.#state !== "parked" && this.#state !== "retiring") {
			this.release();
			this.#end();
			this.#state = "none";
		}
		return { since: 0, spans: this.#spans.filter((entry) => entry.runId === runId).map((entry) => entry.span) };
	}

	/** Parks the folder for the conversation's next run, or destroys it while a command is held. */
	async park(fence: SandboxFence, versionId: VersionId | null): Promise<{ parked: boolean } | Refused> {
		if (!this.#owns(fence)) return STALE;
		this.log.push(`park ${versionId === null ? "none" : "version"}`);
		if (this.#state === "parked") return { parked: this.#parkedVersion === versionId };
		if (this.#holds.size > 0) {
			await this.destroy(fence, "Work of the run was still running when it parked its sandbox.");
			return { parked: false };
		}
		this.#end("parked");
		this.#state = "parked";
		this.#parkedVersion = versionId;
		return { parked: true };
	}

	/** The parked folder for a new attempt when it is the version the attempt starts from; else it is destroyed. */
	async acquire(fence: AttemptFence, spec: SandboxSpec, versionId: VersionId | null): Promise<Acquired | NotAcquired | Refused> {
		this.log.push(`acquire ${fence.attempt}`);
		if (this.#state !== "parked") return { acquired: false, reason: "Nothing is parked." };
		if (this.#parkedVersion !== versionId) {
			this.files.clear();
			this.dirs.clear();
			this.#state = "none";
			this.log.push("destroy The parked folder is not the version the run starts from.");
			return { acquired: false, reason: "The parked folder is not the version the run starts from." };
		}
		const incarnation = uuid7();
		this.#fence = { ...fence, incarnation };
		this.#spec = spec;
		this.#state = "verified";
		this.#startedAt = Date.now();
		this.#spans.push({ runId: fence.runId, span: { startedAt: this.#startedAt, leaseUntil: this.#startedAt + 3_600_000, endedAt: null, ended: null } });
		return { incarnation, verifyMs: 0 };
	}

	/** The parked folder becomes the conversation's snapshot and the container goes, as a retire that took one. */
	retire(): void {
		if ((this.#state !== "parked" && this.#state !== "retiring") || this.#parkedVersion === null) throw new Error("Nothing parked holds a version.");
		this.#snapshot = { versionId: this.#parkedVersion, files: new Map(this.files), dirs: new Set(this.dirs) };
		this.log.push("retire");
		this.files.clear();
		this.dirs.clear();
		this.#state = "none";
	}

	/** The parked container is on its way to a snapshot: the conversation's still, as a parked one is. */
	retiring(): void {
		if (this.#state !== "parked") throw new Error("Nothing is parked.");
		this.#state = "retiring";
	}

	/** Drops the snapshot, and destroys a retiring container. */
	async forget(): Promise<void> {
		this.log.push("forget");
		this.#snapshot = null;
		if (this.#state === "retiring") {
			this.#state = "none";
			this.log.push("destroy The conversation's snapshot was forgotten.");
		}
	}

	/** The open span, if any, ends now. */
	#end(ended: "destroyed" | "parked" = "destroyed"): void {
		const open = this.#spans.at(-1);
		if (open && open.span.endedAt === null) open.span = { ...open.span, endedAt: Date.now(), ended };
	}

	async status(): Promise<SandboxStatus> {
		const own = this.#fence;
		const live = this.#state !== "none";
		return {
			state: this.#state,
			incarnation: live ? (own?.incarnation ?? null) : null,
			runId: live ? (own?.runId ?? null) : null,
			attempt: live ? (own?.attempt ?? null) : null,
			cleanupPending: false,
			startedAt: this.#startedAt,
			snapshot: this.#snapshot && { versionId: this.#snapshot.versionId, takenAt: 0 },
		};
	}

	/** The spec the last start was given. */
	get spec(): SandboxSpec | null {
		return this.#spec;
	}
}
