// A stand-in for a conversation's Sandbox in local workerd, which has no containers (ConversationPorts.sandbox):
// a folder in memory with the Sandbox's fences, hydration from and checkpoints into the workspace's bucket
// (with the SHA-256 R2 checks), a scan that reports limits, and a tiny command language for the bash tool.
// It lives in the tests' isolate, so it survives the conversation's resets as a container would; a start
// for a new attempt replaces the folder, as a new container does. The real container is the unit tests'
// (Docker) and the account's.
//
// Commands, joined by " && ": `put <path> <text>`, `fill <path> <bytes>`, `cat <path>`, `rm <path>`,
// `sleep <ms>`, `exit <n>`, `hold` (until `release()` or a cancel).

import { type FileErrorCode, LineScanner } from "@earendil-works/pi-durable/env";
import type { AttemptFence } from "../../src/contracts/common.ts";
import type {
	CheckpointUploadPlan,
	CheckpointUploadResult,
	ExecOutputSink,
	ExecRequest,
	ExecResult,
	FileHandle,
	FsRequest,
	FsResponse,
	HardeningReport,
	HydratePlan,
	HydrateResult,
	Refused,
	SandboxFence,
	SandboxSpec,
	SandboxStatus,
	ScanResult,
	VerificationReport,
} from "../../src/contracts/sandbox.ts";
import type { FolderWarnings } from "../../src/contracts/files.ts";
import type { SandboxPort } from "../../src/conversation/local-run.ts";
import { hex } from "../../src/lib/bytes.ts";
import { compareCodePoints } from "../../src/lib/order.ts";
import { uuid7 } from "../../src/lib/random.ts";

const ROOT = "/workspace/";
const STALE: Refused = { refused: "stale", message: "This sandbox belongs to another incarnation, run or attempt." };
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
	readonly #handles = new Map<string, Uint8Array>();
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

	async start(fence: AttemptFence, spec: SandboxSpec): Promise<{ incarnation: string } | Refused | { failed: string }> {
		this.log.push(`start ${fence.attempt}`);
		if (this.faults.start) return { failed: "The container did not become ready." };
		this.release();
		this.files.clear();
		this.dirs.clear();
		this.#handles.clear();
		const incarnation = uuid7();
		this.#fence = { ...fence, incarnation };
		this.#spec = spec;
		this.#state = "starting";
		this.#startedAt = Date.now();
		return { incarnation };
	}

	async harden(fence: SandboxFence): Promise<HardeningReport | Refused> {
		if (!this.#owns(fence)) return STALE;
		if (this.faults.harden) {
			this.#state = "none";
			return { ok: false, failed: this.faults.harden, output: "" };
		}
		this.#state = "hardening";
		return { ok: true, failed: null, output: "" };
	}

	async verify(fence: SandboxFence): Promise<VerificationReport | Refused> {
		if (!this.#owns(fence)) return STALE;
		this.#state = "verified";
		return { ok: true, checks: [] };
	}

	async exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused> {
		if (!this.#owns(fence)) return STALE;
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
		if (!this.#owns(fence)) return STALE;
		this.log.push(`fs ${request.op}`);
		switch (request.op) {
			case "canonical":
			case "absolute":
				return { ok: true, value: request.path };
			case "exists": {
				const path = relative(request.path);
				return { ok: true, value: path !== null && this.#info(path) !== null };
			}
			case "info": {
				const path = relative(request.path);
				const info = path === null ? null : this.#info(path);
				return info ? { ok: true, value: info } : failure("not_found", "No such file or directory");
			}
			case "readText": {
				const path = relative(request.path);
				const file = path === null ? undefined : this.files.get(path);
				return file ? { ok: true, value: decoder.decode(file.data) } : failure("not_found", "No such file or directory");
			}
			case "write": {
				const path = relative(request.path);
				if (path === null) return failure("permission_denied", "Permission denied");
				this.#write(path, request.content, request.append);
				return { ok: true, value: null };
			}
			case "mkdir": {
				const path = relative(request.path);
				if (path !== null) this.dirs.add(path);
				return { ok: true, value: null };
			}
			case "open": {
				const path = relative(request.path);
				const file = path === null ? undefined : this.files.get(path);
				if (!file) return failure("not_found", "No such file or directory");
				const id = uuid7();
				this.#handles.set(id, file.data);
				const handle: FileHandle = { id, path: request.path, dev: 1, ino: 1, size: file.data.length, mtimeMs: file.mtime };
				return { ok: true, value: handle };
			}
			case "stat": {
				const data = this.#handles.get(request.handle.id);
				if (!data) return failure("invalid", "The reader is gone.");
				return { ok: true, value: { name: request.handle.path.split("/").pop() ?? "", path: request.handle.path, kind: "file", size: data.length, mtimeMs: request.handle.mtimeMs } };
			}
			case "read": {
				const data = this.#handles.get(request.handle.id);
				if (!data) return failure("invalid", "The reader is gone.");
				return { ok: true, value: data.slice(request.offset, request.offset + request.length) };
			}
			case "scanLines": {
				const data = this.#handles.get(request.handle.id);
				if (!data) return failure("invalid", "The reader is gone.");
				const scanner = new LineScanner(request.startLine, request.endLine);
				scanner.push(data);
				return { ok: true, value: scanner.finish() };
			}
			case "close":
				this.#handles.delete(request.handle.id);
				return { ok: true, value: null };
			default:
				return failure("unknown", `${request.op} is not part of the memory sandbox.`);
		}
	}

	async hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused> {
		if (!this.#owns(fence)) return STALE;
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

	async scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused> {
		if (!this.#owns(fence)) return STALE;
		this.log.push(options.rehashAll ? "scan rehash" : "scan");
		if (this.faults.limit) return { ok: false, limit: this.faults.limit };
		const paths = [...this.files.keys()].sort(compareCodePoints);
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
		const dirs = [...this.dirs].filter((dir) => !parents.has(dir)).sort(compareCodePoints);
		return { ok: true, manifest: { files, dirs }, sizes, warnings: this.faults.warnings ?? { total: 0, items: [] } };
	}

	async checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused> {
		if (!this.#owns(fence)) return STALE;
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
		if (!this.#owns(fence)) return STALE;
		this.log.push("kill");
		if (this.faults.strays) return { ok: false, message: "Processes left by commands could not be stopped." };
		return { ok: true };
	}

	async destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused> {
		if (!this.#owns(fence)) return STALE;
		this.log.push(`destroy ${reason}`);
		this.release();
		this.#state = "none";
		return { destroyed: true };
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
		};
	}

	/** The spec the last start was given. */
	get spec(): SandboxSpec | null {
		return this.#spec;
	}
}
