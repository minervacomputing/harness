// The folder in the container (ARCHITECTURE.md: Checkpoints). Hydration writes the version's files as one tar archive
// into `tar -x` in the empty /workspace, reading each blob from R2 with its SHA-256 checked as it streams.
// A checkpoint reads the files it is asked for as one archive from `tar -c` and streams each into R2 under
// the key the Conversation recorded, with its known length and the SHA-256 R2 checks. Both tars run through
// the wrapper as the agent's user, and file contents never cross an RPC. The scan is scan.ts's.

import { Files } from "@cloudflare/sandbox";
import { MAX_MTIME } from "../files/limits.ts";
import { type FileMode, isValidPath } from "../files/manifest.ts";
import type { EpochMs, Sha256, VersionId } from "../shared/rpc.ts";
import { AGENT_GID, AGENT_UID, FILE_OPERATION_SECONDS, WORKSPACE } from "./constants.ts";
import type { BucketPort } from "./ports.ts";
import { ContainerGone, helperEnvironment, type Machine, spawn, startWrapped } from "./process.ts";
import { FOLDER_SECONDS, type FolderIndex, list } from "./scan.ts";
import { END, entryHeader, FILE, padding, TarReader } from "./tar.ts";

/** What a run starts from: the hydrate version's files, each read from R2 once per distinct hash where it can be. */
export interface HydratePlan {
	versionId: VersionId | null;
	files: { path: string; sha256: Sha256; size: number; mode: FileMode; mtime: EpochMs; key: string }[];
	dirs: string[];
}

export type HydrateResult = { ok: true } | { ok: false; reason: "not_empty" | "invalid_path" | "blob_missing" | "mismatch" | "failed"; message: string };

/**
 * Files to save, each already recorded by the Conversation Durable Object under its R2 key before it is
 * written (ARCHITECTURE.md: Files), and each a regular file of the size the last scan reported. The Sandbox streams
 * each from the container into R2 with its claimed SHA-256, which R2 checks, and reports what it stored. A
 * file without a key has contents the conversation already stores: its bytes are only hashed, as the proof
 * that the run has them, and nothing is written.
 */
export interface CheckpointUploadPlan {
	files: { path: string; sha256: Sha256; size: number; key: string | null }[];
}

export type CheckpointUploadResult =
	| { ok: true; stored: { path: string; sha256: Sha256; size: number; key: string | null }[] }
	| { ok: false; reason: "changed" | "mismatch" | "failed"; path: string; message: string };

/**
 * Blobs up to this size are read whole, a few ahead of the one being written, so R2's latency overlaps the
 * writes; a larger one streams when its turn comes. An invocation keeps six connections open and cancels
 * the least recently used response beyond that, whose body then ends early (measured: 32 bodies opened ahead
 * lost bytes), and gains nothing past six (measured: about 18 ms a 100 KB get at 6, 8 or 16 at once, 146 ms
 * one at a time).
 */
const SMALL_BLOB_BYTES = 1024 * 1024;
const PREFETCH = 5;
/** A blob several paths hold is read once and kept for all of them up to this size; a larger one is read again for each. */
const SHARED_BLOB_BYTES = 8 * 1024 * 1024;
/** Bytes of blobs read whole and not yet written, together. */
const HELD_BYTES = 32 * 1024 * 1024;
/** A checkpoint's file up to this size is read whole and put while the next ones arrive. */
const SMALL_FILE_BYTES = 1024 * 1024;
/** Puts of small files in flight at once, under the six connections a Worker keeps open. */
const PUTS_AT_ONCE = 6;

const SHA256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** Whether an error is a refusal of contents for their hash, R2's or the bucket port's. */
function isMismatch(error: unknown): boolean {
	return /sha-?256|checksum|digest/i.test(error instanceof Error ? error.message : String(error));
}

class TarStopped extends Error {}

type Planned = { sha256: string; size: number; key: string; files: { path: string; mode: FileMode; mtime: number }[] };
type Failure = Extract<HydrateResult, { ok: false }>;

/**
 * Writes the plan's files into the empty folder: listed directories first, then each blob's files. Succeeds
 * only once every blob matched its hash and length, the archive was written whole and `tar` exited 0. The
 * index it returns, from a listing of what was written, holds the plan's hashes, so the next scan need not
 * hash those files again.
 */
export async function hydrate(machine: Machine, bucket: BucketPort, plan: HydratePlan, maxEntries: number): Promise<{ result: HydrateResult; index: FolderIndex | null }> {
	const fail = (reason: Failure["reason"], message: string) => ({ result: { ok: false as const, reason, message }, index: null });
	if (plan.files.length + plan.dirs.length > maxEntries) return fail("invalid_path", "The folder plan holds more entries than the folder may.");
	const paths = new Set<string>();
	const blobs = new Map<string, Planned>();
	for (const file of plan.files) {
		if (!isValidPath(file.path) || paths.has(file.path)) return fail("invalid_path", "The folder plan holds an invalid or repeated path.");
		const valid =
			SHA256.test(file.sha256) &&
			Number.isSafeInteger(file.size) &&
			file.size >= 0 &&
			(file.mode === 0o644 || file.mode === 0o755) &&
			Number.isSafeInteger(file.mtime) &&
			file.mtime >= 0 &&
			file.mtime <= MAX_MTIME &&
			typeof file.key === "string" &&
			file.key !== "";
		const blob = blobs.get(file.sha256);
		if (!valid || (blob && blob.size !== file.size)) return fail("invalid_path", "The folder plan holds an invalid file.");
		paths.add(file.path);
		const holder = { path: file.path, mode: file.mode, mtime: file.mtime };
		if (blob) blob.files.push(holder);
		else blobs.set(file.sha256, { sha256: file.sha256, size: file.size, key: file.key, files: [holder] });
	}
	for (const dir of plan.dirs) {
		if (!isValidPath(dir) || paths.has(dir)) return fail("invalid_path", "The folder plan holds an invalid or repeated path.");
		paths.add(dir);
	}

	const files = new Files({ exec: (argv, options) => spawn(machine, argv, options ?? {}) });
	try {
		const entries = await files.readDirectory(WORKSPACE, { user: `${AGENT_UID}:${AGENT_GID}`, signal: AbortSignal.timeout(FILE_OPERATION_SECONDS * 1000) });
		if (entries.length > 0) return fail("not_empty", `${WORKSPACE} is not empty.`);
	} catch (error) {
		if (error instanceof ContainerGone) throw error;
		return fail("failed", "The folder could not be read.");
	}

	const command = ["tar", "-x", "-f", "-", "-C", WORKSPACE, "--no-same-owner", "--preserve-permissions"];
	const wrapped = await startWrapped(machine, { command, cwd: "/", env: helperEnvironment(), timeoutSeconds: FOLDER_SECONDS }, { stdin: "pipe", stderr: "ignore" });
	if (!wrapped.admission.started) return fail("failed", "The folder could not be prepared.");
	const writer = (wrapped.proc.stdin as WritableStream<Uint8Array>).getWriter();
	const send = async (bytes: Uint8Array) => {
		try {
			await writer.write(bytes);
		} catch {
			throw new TarStopped();
		}
	};
	const ordered = [...blobs.values()];
	const whole = (blob: Planned) => blob.size <= SMALL_BLOB_BYTES || (blob.files.length > 1 && blob.size <= SHARED_BLOB_BYTES);
	const unreadable = (blob: Planned): Failure => ({ ok: false, reason: "failed", message: `Blob ${blob.sha256} could not be read from the store.` });
	const refused = (blob: Planned, error: unknown): Failure =>
		isMismatch(error) ? { ok: false, reason: "mismatch", message: `Blob ${blob.sha256} did not match its hash.` } : unreadable(blob);

	/** The blob's body from R2, checked against its hash as it streams, or why it cannot be read. */
	const open = async (blob: Planned): Promise<ReadableStream<Uint8Array> | Failure> => {
		let object: Awaited<ReturnType<BucketPort["get"]>>;
		try {
			object = await bucket.get(blob.key, blob.sha256);
		} catch {
			return unreadable(blob);
		}
		if (!object) return { ok: false, reason: "blob_missing", message: `Blob ${blob.sha256} is missing from the store.` };
		if (object.size !== blob.size) {
			await object.body.cancel().catch(() => undefined);
			return { ok: false, reason: "mismatch", message: `Blob ${blob.sha256} has ${object.size} bytes, not ${blob.size}.` };
		}
		return object.body;
	};
	/** The blob's bytes, read into a buffer of its size; a body longer than that is refused as it arrives. */
	const readWhole = async (blob: Planned): Promise<Uint8Array | Failure> => {
		const body = await open(blob);
		if (!(body instanceof ReadableStream)) return body;
		const reader = body.getReader();
		const bytes = new Uint8Array(blob.size);
		let at = 0;
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch (error) {
					return refused(blob, error);
				}
				if (chunk.done) break;
				if (at + chunk.value.length > blob.size) return unreadable(blob);
				bytes.set(chunk.value, at);
				at += chunk.value.length;
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		return at === blob.size ? bytes : unreadable(blob);
	};
	/** Streams one copy of a blob into the archive; its bytes are checked against the hash and length as they pass. */
	const stream = async (blob: Planned): Promise<Failure | null> => {
		const body = await open(blob);
		if (!(body instanceof ReadableStream)) return body;
		const reader = body.getReader();
		let sent = 0;
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch (error) {
					return refused(blob, error);
				}
				if (chunk.done) break;
				sent += chunk.value.length;
				if (sent > blob.size) return unreadable(blob);
				await send(chunk.value);
			}
		} finally {
			// A body left unread holds one of the invocation's few connections.
			await reader.cancel().catch(() => undefined);
		}
		return sent === blob.size ? null : unreadable(blob);
	};

	let failure: Failure | null = null;
	const fetched: (Promise<Uint8Array | Failure> | undefined)[] = [];
	let held = 0;
	try {
		const now = Date.now();
		for (const dir of [...plan.dirs].sort()) await send(entryHeader({ path: dir, type: "directory", size: 0, mode: 0o755, mtime: now }));
		for (let index = 0; index < ordered.length && !failure; index++) {
			const blob = ordered[index] as Planned;
			// Blobs read whole, a few ahead, within what may be held at once.
			for (let ahead = index; ahead < Math.min(ordered.length, index + PREFETCH); ahead++) {
				const next = ordered[ahead] as Planned;
				if (fetched[ahead] !== undefined || !whole(next) || (ahead > index && held + next.size > HELD_BYTES)) continue;
				held += next.size;
				const pending = readWhole(next);
				pending.catch(() => undefined);
				fetched[ahead] = pending;
			}
			const bytes = fetched[index] ? await fetched[index] : null;
			if (fetched[index]) {
				held -= blob.size;
				fetched[index] = Promise.resolve(new Uint8Array(0));
			}
			if (bytes && !(bytes instanceof Uint8Array)) {
				failure = bytes;
				break;
			}
			for (const file of blob.files) {
				await send(entryHeader({ path: file.path, type: "file", size: blob.size, mode: file.mode, mtime: file.mtime }));
				if (bytes) await send(bytes);
				else {
					failure = await stream(blob);
					if (failure) break;
				}
				await send(padding(blob.size));
			}
		}
		if (!failure) {
			await send(END);
			await writer.close().catch(() => {
				throw new TarStopped();
			});
		}
	} catch (error) {
		if (!(error instanceof TarStopped)) throw error;
		failure ??= { ok: false, reason: "failed", message: "The folder could not be prepared." };
	}
	if (failure) {
		wrapped.stop();
		await wrapped.proc.exitCode.catch(() => undefined);
		return { result: failure, index: null };
	}
	if ((await wrapped.proc.exitCode.catch(() => -1)) !== 0) return fail("failed", "The folder could not be prepared.");

	// Every file of the plan must be there at its size. The index holds each with the plan's hash and manifest
	// mtime where its mtime is the plan's.
	const listed = await list(machine, maxEntries);
	if (!listed.ok) return fail("failed", "The folder could not be listed after it was prepared.");
	const planned = new Map(plan.files.map((file) => [file.path, file]));
	const index: FolderIndex = new Map();
	let found = 0;
	for (const file of listed.listing.files) {
		const wanted = planned.get(file.path);
		if (!wanted || wanted.size !== file.size) continue;
		found++;
		if (file.mtimeNs !== BigInt(wanted.mtime) * 1_000_000n) continue;
		index.set(file.path, {
			size: file.size,
			mtimeNs: file.mtimeNs,
			ctimeNs: file.ctimeNs,
			ino: file.ino,
			dev: file.dev,
			sha256: wanted.sha256,
			mtime: wanted.mtime,
			racy: file.ctimeNs + 1_000_000_000n >= listed.now,
		});
	}
	if (found !== plan.files.length) return fail("failed", "The folder does not hold the planned files.");
	return { result: { ok: true }, index };
}

type PlannedFile = CheckpointUploadPlan["files"][number];

/**
 * Streams the plan's files from the container into R2 (ARCHITECTURE.md: Checkpoints): one `tar -c` reads them in order,
 * as the agent's user, without recursing and with hard links stored as files. Each entry must be a regular
 * file with the planned name and size, in the planned order, and the archive must end right after the last;
 * anything else is a mismatch. A small file is read whole and put while the next ones arrive, a large one is
 * streamed straight into its put. Each put has the file's length and the SHA-256 R2 checks; a file without a
 * key (contents the conversation stores already) is hashed the same way and not written. Every path must be a
 * regular file of the planned size in the last scan (`scanned`), which saw only real directories.
 */
export async function upload(machine: Machine, bucket: BucketPort, plan: CheckpointUploadPlan, scanned: ReadonlyMap<string, number> | null): Promise<CheckpointUploadResult> {
	const seen = new Set<string>();
	for (const file of plan.files) {
		if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || (file.key !== null && (typeof file.key !== "string" || file.key === "")) || seen.has(file.path)) {
			return { ok: false, reason: "failed", path: file.path, message: "The checkpoint plan holds an invalid file." };
		}
		seen.add(file.path);
		if (scanned?.get(file.path) !== file.size) return { ok: false, reason: "changed", path: file.path, message: "A file is not one the last scan reported." };
	}
	if (plan.files.length === 0) return { ok: true, stored: [] };
	const total = plan.files.reduce((sum, file) => sum + file.size, 0);
	const names = plan.files.map((file) => encoder.encode(`${file.path}\0`));
	const command = ["tar", "-c", "-f", "-", "--format=pax", "-C", WORKSPACE, "--no-recursion", "--hard-dereference", "--null", "--verbatim-files-from", "-T", "-"];
	const wrapped = await startWrapped(machine, { command, cwd: "/", env: helperEnvironment(), timeoutSeconds: FOLDER_SECONDS + Math.ceil(total / 1_000_000) }, {
		stdin: new Blob(names as Uint8Array<ArrayBuffer>[]).stream(),
		stderr: "ignore",
	});
	if (!wrapped.admission.started) return { ok: false, reason: "failed", path: plan.files[0]?.path ?? "", message: "The files could not be read." };
	let failure: CheckpointUploadResult | null = null;
	const mismatch = (file: PlannedFile | undefined): CheckpointUploadResult => ({ ok: false, reason: "mismatch", path: file?.path ?? "", message: "The archive of the folder does not hold the planned files." });
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
	const tar = new TarReader(wrapped.stdout);
	try {
		for (const [index, file] of plan.files.entries()) {
			if (failure) break;
			const entry = await tar.next();
			const name = names[index] as Uint8Array;
			if (!entry || entry.type !== FILE || entry.size !== file.size || entry.name.length !== name.length - 1 || entry.name.some((byte, at) => byte !== name[at])) {
				failure = mismatch(file);
				break;
			}
			if (file.size <= SMALL_FILE_BYTES) {
				const bytes = await wrapped.stdout.exactly(file.size);
				await tar.padding(file.size);
				const done: Promise<void> = put(file, new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()).finally(() => pending.delete(done));
				pending.add(done);
				while (pending.size >= PUTS_AT_ONCE) await Promise.race(pending);
				continue;
			}
			// A large file streams from the process into its put; the next entry comes after it.
			let left = file.size;
			let short = false;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (left === 0) return controller.close();
					const chunk = await wrapped.stdout.some();
					if (chunk === null) {
						short = true;
						return controller.error(new Error("The archive ended inside a file."));
					}
					const take = chunk.subarray(0, Math.min(left, chunk.length));
					if (take.length < chunk.length) wrapped.stdout.unshift(chunk.subarray(take.length));
					left -= take.length;
					controller.enqueue(take);
				},
			});
			await put(file, body);
			if (short) failure = mismatch(file);
			if (failure) break;
			if (left !== 0) {
				failure = mismatch(file);
				break;
			}
			await tar.padding(file.size);
		}
		if (!failure) {
			if ((await tar.next()) !== null) failure = mismatch(undefined);
			else await tar.end();
		}
		await Promise.all(pending);
	} catch {
		// A malformed or short archive: every other failure was recorded where it happened.
		failure ??= mismatch(undefined);
	} finally {
		if (failure) wrapped.stop();
		await Promise.allSettled(pending);
	}
	const exitCode = await wrapped.proc.exitCode.catch(() => -1);
	if (failure) return failure;
	if (exitCode !== 0) return { ok: false, reason: "failed", path: "", message: "The folder's files could not be read." };
	return { ok: true, stored: plan.files.map(({ path, sha256, size, key }) => ({ path, sha256, size, key })) };
}
