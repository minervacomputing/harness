// The folder in the container (plan: Checkpoints): hydration streams the version's blobs from R2
// into minerva-fs, each distinct blob once, a few gets ahead; the scan runs minerva-fs over /workspace with
// the index the Sandbox keeps, so unchanged files are not hashed again; a checkpoint streams each file it is
// asked for from the container into R2 under the key the Conversation recorded, with its known length and
// the SHA-256 R2 checks. File contents never cross an RPC. The container's claims (the scan's manifest,
// warnings and sizes) are only checked for their shape here; the Conversation validates them.

import type { FolderLimit } from "../files/limits.ts";
import type { FileMode, FolderWarnings, WarningReason, WireManifest } from "../files/manifest.ts";
import { type Json, parseJson } from "../lib/json.ts";
import type { EpochMs, Sha256, VersionId } from "../shared/rpc.ts";
import { WORKSPACE } from "./constants.ts";
import type { BucketPort } from "./ports.ts";
import { setOwn } from "./files.ts";
import { helper, type Machine, startWrapped } from "./process.ts";

/** What a run starts from: the hydrate version's files, each read from R2 once per distinct hash. */
export interface HydratePlan {
	versionId: VersionId | null;
	files: { path: string; sha256: Sha256; size: number; mode: FileMode; mtime: EpochMs; key: string }[];
	dirs: string[];
}

export type HydrateResult = { ok: true } | { ok: false; reason: "not_empty" | "invalid_path" | "blob_missing" | "mismatch" | "failed"; message: string };

/**
 * The scan, run in the container as the dropped user, walking `/workspace` one component at a time with
 * O_NOFOLLOW: every entry counts against the entry limit, sizes in pages are checked before
 * hashing, three tries if the folder changes, results sorted by code point. Its claims are untrusted: the
 * Conversation Durable Object validates the manifest and warnings again.
 */
export type ScanResult =
	| { ok: true; manifest: WireManifest; sizes: { [path: string]: number }; warnings: FolderWarnings }
	| { ok: false; limit: Extract<FolderLimit, "folder_bytes" | "folder_entries"> }
	| { ok: false; reason: "changed" | "failed"; message: string };

/**
 * Files to save, each already recorded by the Conversation Durable Object under its R2 key before it is
 * written (plan: Files). The Sandbox streams each from the container into R2 with its claimed SHA-256,
 * which R2 checks, and reports what it stored. A file without a key has contents the conversation already
 * stores: its bytes are only hashed, as the proof that the run has them, and nothing is written.
 */
export interface CheckpointUploadPlan {
	files: { path: string; sha256: Sha256; size: number; key: string | null }[];
}

export type CheckpointUploadResult =
	| { ok: true; stored: { path: string; sha256: Sha256; size: number; key: string | null }[] }
	| { ok: false; reason: "changed" | "mismatch" | "failed"; path: string; message: string };

/** One file of the scan's index, as minerva-fs writes it: path, size, mtime ns, ctime ns, ino, dev, sha256, mtime, racy. */
export type IndexEntry = [string, number, string, string, string, string, string, number, boolean];

/** Hydration and scans take this long at most; a checkpoint, this plus its bytes at 1 MB/s. */
const FOLDER_SECONDS = 600;
/** One line of a helper's answer: a header, or one entry, whose path is at most 1,024 bytes, escaped as ASCII. */
const LINE_BYTES = 64 * 1024;
const WARNINGS_KEPT = 100;
/**
 * Small blobs read from R2 at once during hydration, each body read whole at once; a large blob streams
 * alone besides them. An invocation keeps six connections open and cancels the least recently used
 * response beyond that, whose body then ends early (measured: 32 bodies opened ahead lost bytes), and gains
 * nothing past six (measured: about 18 ms a 100 KB get at 6, 8 or 16 at once, 146 ms one at a time).
 */
const PREFETCH = 5;
/** A checkpoint's file up to this size is read whole and put while the next ones arrive. */
const SMALL_FILE_BYTES = 1024 * 1024;
/** Puts of small files in flight at once, under the six connections a Worker keeps open. */
const PUTS_AT_ONCE = 6;

const REASONS: readonly WarningReason[] = ["symlink", "special", "invalid_name", "too_long", "too_deep", "unreadable"];
const SHA256 = /^[0-9a-f]{64}$/;

function isObject(value: Json): value is { [key: string]: Json } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One JSON line of a helper's answer, at most `max` bytes; null at the end or for anything unreadable. */
async function jsonLine(stdout: { line(max: number): Promise<Uint8Array | null> }, max = LINE_BYTES): Promise<Json | undefined> {
	try {
		const line = await stdout.line(max);
		if (line === null) return undefined;
		return parseJson(new TextDecoder().decode(line));
	} catch {
		return undefined;
	}
}

async function answerLine(stdout: { line(max: number): Promise<Uint8Array | null> }): Promise<{ [key: string]: Json } | null> {
	const value = await jsonLine(stdout);
	return value !== undefined && isObject(value) ? value : null;
}

function count(value: Json | undefined, max: number): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** A manifest path: at most 1,024 UTF-8 bytes, so at most 1,024 UTF-16 units. */
const PATH_UNITS = 1024;
const DIGITS = /^-?[0-9]{1,24}$/;

function boundedPath(value: Json | undefined): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= PATH_UNITS;
}

/** One index entry, every field within what a real one holds, so a folder's index is bounded by its entries. */
function indexEntry(value: Json | undefined): IndexEntry | null {
	if (!Array.isArray(value) || value.length !== 9) return null;
	const [path, size, mtimeNs, ctimeNs, ino, dev, sha256, mtime, racy] = value;
	if (!boundedPath(path) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
	if (typeof mtimeNs !== "string" || !DIGITS.test(mtimeNs) || typeof ctimeNs !== "string" || !DIGITS.test(ctimeNs)) return null;
	if (typeof ino !== "string" || !DIGITS.test(ino) || typeof dev !== "string" || !DIGITS.test(dev)) return null;
	if (typeof sha256 !== "string" || !SHA256.test(sha256) || typeof mtime !== "number" || !Number.isSafeInteger(mtime) || typeof racy !== "boolean") return null;
	return [path, size, mtimeNs, ctimeNs, ino, dev, sha256, mtime, racy];
}

type Fetched = { size: number; bytes: Uint8Array } | { size: number; body: ReadableStream<Uint8Array> } | null;

class HelperStopped extends Error {}

/** Writes the plan's files into the empty folder. The index of what it wrote comes back for the next scan. */
export async function hydrate(machine: Machine, bucket: BucketPort, plan: HydratePlan, maxEntries: number): Promise<{ result: HydrateResult; index: IndexEntry[] | null }> {
	if (plan.files.length + plan.dirs.length > maxEntries) return { result: { ok: false, reason: "invalid_path", message: "The folder plan holds more entries than the folder may." }, index: null };
	const blobs = new Map<string, { sha256: string; size: number; key: string; files: { path: string; mode: FileMode; mtime: number }[] }>();
	for (const file of plan.files) {
		if (!SHA256.test(file.sha256)) return { result: { ok: false, reason: "invalid_path", message: "The folder plan holds an invalid hash." }, index: null };
		const blob = blobs.get(file.sha256);
		if (blob) blob.files.push({ path: file.path, mode: file.mode, mtime: file.mtime });
		else blobs.set(file.sha256, { sha256: file.sha256, size: file.size, key: file.key, files: [{ path: file.path, mode: file.mode, mtime: file.mtime }] });
	}
	const ordered = [...blobs.values()];
	const header = JSON.stringify({ root: WORKSPACE, dirs: plan.dirs, blobs: ordered.map(({ sha256, size, files }) => ({ sha256, size, files })) });
	const wrapped = await startWrapped(machine, helper("hydrate", [], FOLDER_SECONDS), { stdin: "pipe", stderr: "ignore" });
	if (!wrapped.admission.started) return { result: { ok: false, reason: "failed", message: "The folder could not be prepared." }, index: null };
	const writer = (wrapped.proc.stdin as WritableStream<Uint8Array>).getWriter();
	const answer = answerLine(wrapped.stdout);
	const send = async (bytes: Uint8Array) => {
		try {
			await writer.write(bytes);
		} catch {
			throw new HelperStopped();
		}
	};
	// The store's failure, if it fails; the helper's own answer says why it stopped reading otherwise.
	let failure: HydrateResult | null = null;
	// Small blobs are read whole a few ahead of the one being written, so R2's latency overlaps the writes; a
	// large blob is opened only when its turn comes and streamed, so few bytes are ever held.
	const fetched: (Promise<Fetched> | undefined)[] = [];
	const fetchAt = (index: number) => {
		const blob = ordered[index];
		if (!blob || fetched[index] !== undefined) return;
		const pending = (async (): Promise<Fetched> => {
			const object = await bucket.get(blob.key);
			if (!object) return null;
			if (object.size > SMALL_FILE_BYTES) return { size: object.size, body: object.body };
			const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
			// A body that ended early is a failed read, never a short file.
			if (bytes.length !== object.size) throw new Error("The blob's body ended early.");
			return { size: object.size, bytes };
		})();
		pending.catch(() => undefined);
		fetched[index] = pending;
	};
	const unreadable = (sha256: string): HydrateResult => ({ ok: false, reason: "failed", message: `Blob ${sha256} could not be read from the store.` });
	try {
		await send(new TextEncoder().encode(`${header}\n`));
		for (let index = 0; index < ordered.length && !failure; index++) {
			const blob = ordered[index] as (typeof ordered)[number];
			for (let ahead = index; ahead < Math.min(ordered.length, index + PREFETCH); ahead++) {
				if (ahead === index || (ordered[ahead]?.size ?? 0) <= SMALL_FILE_BYTES) fetchAt(ahead);
			}
			let object: Fetched;
			try {
				object = await (fetched[index] as Promise<Fetched>);
			} catch {
				failure = unreadable(blob.sha256);
				break;
			}
			fetched[index] = Promise.resolve(null);
			if (!object) failure = { ok: false, reason: "blob_missing", message: `Blob ${blob.sha256} is missing from the store.` };
			else if (object.size !== blob.size) {
				if ("body" in object) await object.body.cancel().catch(() => undefined);
				failure = { ok: false, reason: "mismatch", message: `Blob ${blob.sha256} has ${object.size} bytes, not ${blob.size}.` };
			} else if ("bytes" in object) await send(object.bytes);
			else {
				const reader = object.body.getReader();
				let sent = 0;
				try {
					for (;;) {
						let chunk: ReadableStreamReadResult<Uint8Array>;
						try {
							chunk = await reader.read();
						} catch {
							failure = unreadable(blob.sha256);
							break;
						}
						if (chunk.done) break;
						await send(chunk.value);
						sent += chunk.value.length;
					}
				} finally {
					// A body left unread holds one of the invocation's few connections.
					if (failure || sent !== blob.size) await reader.cancel().catch(() => undefined);
				}
				if (!failure && sent !== blob.size) failure = unreadable(blob.sha256);
			}
		}
	} catch (error) {
		if (!(error instanceof HelperStopped)) throw error;
	} finally {
		for (const later of fetched) {
			void later
				?.then((object) => {
					if (object && "body" in object) return object.body.cancel();
				})
				.catch(() => undefined);
		}
	}
	if (failure) {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
		return { result: failure, index: null };
	}
	await writer.close().catch(() => undefined);
	try {
		const value = await answer;
		const unprepared = { result: { ok: false as const, reason: "failed" as const, message: "The folder could not be prepared." }, index: null };
		if (!value) return unprepared;
		if (value.ok === true) {
			// The index of what it wrote: one line per file of the plan, each bounded.
			if (count(value.files ?? null, plan.files.length) !== plan.files.length) return unprepared;
			const index: IndexEntry[] = [];
			for (let i = 0; i < plan.files.length; i++) {
				const entry = indexEntry(await jsonLine(wrapped.stdout));
				if (!entry) return unprepared;
				index.push(entry);
			}
			return { result: { ok: true }, index };
		}
		const reason = value.reason;
		const known = reason === "not_empty" || reason === "invalid_path" || reason === "mismatch" || reason === "failed";
		return {
			result: { ok: false, reason: known ? reason : "failed", message: typeof value.message === "string" ? value.message.slice(0, 500) : "The folder could not be prepared." },
			index: null,
		};
	} finally {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
	}
}

/** The scan, in the container, with the Sandbox's index of the files it last hashed. */
export async function scan(
	machine: Machine,
	index: IndexEntry[],
	limits: { bytes: number; entries: number },
	rehashAll: boolean,
): Promise<{ result: ScanResult; index: IndexEntry[] | null }> {
	const request = JSON.stringify({ root: WORKSPACE, bytes: limits.bytes, entries: limits.entries, rehashAll, index });
	const wrapped = await startWrapped(machine, helper("scan", [], FOLDER_SECONDS), { stdin: new Blob([request]).stream(), stderr: "ignore" });
	const failed = (message: string) => ({ result: { ok: false as const, reason: "failed" as const, message }, index: null });
	if (!wrapped.admission.started) return failed("The folder could not be scanned.");
	const value = await answerLine(wrapped.stdout);
	try {
		if (!value) return failed("The folder could not be scanned.");
		if (value.ok === false) {
			if (value.limit === "folder_bytes" || value.limit === "folder_entries") return { result: { ok: false, limit: value.limit }, index: null };
			if (value.reason === "changed") return { result: { ok: false, reason: "changed", message: "The folder kept changing while it was saved." }, index: null };
			return failed("The folder could not be scanned.");
		}
		// The counts first, each within the folder's limits, then one bounded line per entry: no answer the
		// container writes makes the Sandbox hold more than a folder at its limits.
		const warnings = value.warnings ?? null;
		const files = count(value.files ?? null, limits.entries);
		const dirs = count(value.dirs ?? null, limits.entries);
		if (files === null || dirs === null || files + dirs > limits.entries || !isObject(warnings)) return failed("The scan's report is unreadable.");
		const total = count(warnings.total ?? null, 2 ** 31 - 1);
		const items = count(warnings.items ?? null, WARNINGS_KEPT);
		if (total === null || items === null || items > total) return failed("The scan's report is unreadable.");
		const manifest: ScanResult & { ok: true } = { ok: true, manifest: { files: [], dirs: [] }, sizes: {}, warnings: { total, items: [] } };
		const next: IndexEntry[] = [];
		for (let i = 0; i < files; i++) {
			const line = await jsonLine(wrapped.stdout);
			if (!Array.isArray(line) || line.length !== 10) return failed("The scan's report is unreadable.");
			const [path, sha256, mode, mtime, size, mtimeNs, ctimeNs, ino, dev, racy] = line;
			const entry = indexEntry([path ?? null, size ?? null, mtimeNs ?? null, ctimeNs ?? null, ino ?? null, dev ?? null, sha256 ?? null, mtime ?? null, racy ?? null]);
			if (!entry || (mode !== 0o644 && mode !== 0o755)) return failed("The scan's report is unreadable.");
			manifest.manifest.files.push({ path: entry[0], sha256: entry[6], mode, mtime: entry[7] });
			setOwn(manifest.sizes, entry[0], entry[1]);
			next.push(entry);
		}
		for (let i = 0; i < dirs; i++) {
			const dir = await jsonLine(wrapped.stdout);
			if (!boundedPath(dir)) return failed("The scan's report is unreadable.");
			manifest.manifest.dirs.push(dir);
		}
		for (let i = 0; i < items; i++) {
			const item = await jsonLine(wrapped.stdout);
			// A warning's path is for display, at most 1,024 UTF-16 units and the ellipsis.
			if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || item[0].length > PATH_UNITS + 1 || !(REASONS as readonly Json[]).includes(item[1] ?? null)) {
				return failed("The scan's report is unreadable.");
			}
			manifest.warnings.items.push({ path: item[0], reason: item[1] as WarningReason });
		}
		return { result: manifest, index: next };
	} finally {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
	}
}

function isMismatch(error: unknown): boolean {
	return /sha-?256|checksum|digest/i.test(error instanceof Error ? error.message : String(error));
}

type PlannedFile = CheckpointUploadPlan["files"][number];

/**
 * Streams the plan's files from the container into R2 (plan: Checkpoints, step 5): one minerva-fs process
 * sends them in order, each re-opened without following links and refused if it is no longer a regular file
 * of its scanned size; a small file is read whole and put while the next ones arrive, a large one is
 * streamed straight into its put. Each put has the file's length and the SHA-256 R2 checks; a file without a
 * key (contents the conversation stores already) is hashed the same way and not written.
 */
export async function upload(machine: Machine, bucket: BucketPort, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult> {
	for (const file of plan.files) {
		if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (file.key !== null && (typeof file.key !== "string" || file.key === ""))) {
			return { ok: false, reason: "failed", path: file.path, message: "The checkpoint plan holds an invalid file." };
		}
	}
	if (plan.files.length === 0) return { ok: true, stored: [] };
	const total = plan.files.reduce((sum, file) => sum + file.size, 0);
	const request = `${JSON.stringify({ files: plan.files.map((file) => [file.path, file.size]) })}\n`;
	const wrapped = await startWrapped(machine, helper("pull-many", [WORKSPACE], FOLDER_SECONDS + Math.ceil(total / 1_000_000)), {
		stdin: new Blob([request]).stream(),
		stderr: "ignore",
	});
	if (!wrapped.admission.started) return { ok: false, reason: "failed", path: plan.files[0]?.path ?? "", message: "The files could not be read." };
	let failure: CheckpointUploadResult | null = null;
	const fail = (file: PlannedFile, error: unknown) => {
		failure ??= isMismatch(error)
			? { ok: false, reason: "mismatch", path: file.path, message: "A file did not match its hash." }
			: { ok: false, reason: "failed", path: file.path, message: "A file could not be saved." };
	};
	const pending = new Set<Promise<void>>();
	// A file without a key has contents the conversation stores already: hashed, not written.
	const put = (file: PlannedFile, body: ReadableStream<Uint8Array>) =>
		(file.key === null ? bucket.check(body, { size: file.size, sha256: file.sha256 }) : bucket.put(file.key, body, { size: file.size, sha256: file.sha256 })).catch((error: unknown) =>
			fail(file, error),
		);
	try {
		for (const file of plan.files) {
			if (failure) break;
			const header = await answerLine(wrapped.stdout);
			if (!header || header.ok !== true) {
				failure = { ok: false, reason: "changed", path: file.path, message: "A file changed while the folder was saved." };
				break;
			}
			if (file.size <= SMALL_FILE_BYTES) {
				let bytes: Uint8Array;
				try {
					bytes = await wrapped.stdout.exactly(file.size);
				} catch {
					failure = { ok: false, reason: "changed", path: file.path, message: "A file changed while the folder was saved." };
					break;
				}
				const done: Promise<void> = put(file, new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()).finally(() => pending.delete(done));
				pending.add(done);
				while (pending.size >= PUTS_AT_ONCE) await Promise.race(pending);
				continue;
			}
			// A large file streams from the process into its put; the next file's bytes come after it.
			let left = file.size;
			let short = false;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (left === 0) return controller.close();
					const chunk = await wrapped.stdout.some();
					if (chunk === null) {
						short = true;
						return controller.error(new Error("The file ended early."));
					}
					const take = chunk.subarray(0, Math.min(left, chunk.length));
					if (take.length < chunk.length) wrapped.stdout.unshift(chunk.subarray(take.length));
					left -= take.length;
					controller.enqueue(take);
				},
			});
			await put(file, body);
			if (short) {
				failure = { ok: false, reason: "changed", path: file.path, message: "A file changed while the folder was saved." };
				break;
			}
		}
		await Promise.all(pending);
	} finally {
		if (failure) wrapped.stop();
	}
	const exitCode = await wrapped.proc.exitCode.catch(() => -1);
	if (failure) return failure;
	if (exitCode !== 0) return { ok: false, reason: "changed", path: plan.files.at(-1)?.path ?? "", message: "A file changed while the folder was saved." };
	return { ok: true, stored: plan.files.map(({ path, sha256, size, key }) => ({ path, sha256, size, key })) };
}
