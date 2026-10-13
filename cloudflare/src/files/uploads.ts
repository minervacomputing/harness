// Uploads from the browser (plan: Files, Uploads): the checks of the raw request in order, and the body streamed into R2 while it is hashed, recorded in the Workspace as pending before the
// object is written and as complete after. The HTTP route around them (session, CSRF, membership, the demo
// rule, between the name and the stream) is the web API's (step 5).
//
// The body is not read in JavaScript: it is teed natively into R2's `put` and a `crypto.DigestStream`
// (about 550 ms of CPU per 50 MiB), through a FixedLengthStream of the declared size, which gives R2 the
// known length it requires and refuses a body longer or shorter than declared. A third branch is read only
// for its first 8 KiB, the head the media type is sniffed from, and then cancelled. The edge buffers a
// request body before the Worker runs, so there is no idle limit between chunks; the whole upload has 15
// minutes.
//
// Records come before writes: the Workspace's refusals (3 arriving, 30 waiting, the workspace's quota) come
// before the body is received. The edge enforces a body's length. Nothing here holds a temporary file, so
// there is no cap on uploads in progress beyond the Workspace's. The runtime's URL parser has already
// escaped a query that was not ASCII, so it is read as UTF-8.

import type { UploadOut } from "../contracts/api.ts";
import type { Caller, Outcome, Refusal, Sha256, UploadId } from "../contracts/common.ts";
import { hex } from "../lib/bytes.ts";
import { BODY_LONGER, BODY_SHORTER, INVALID_LENGTH, NAME_THE_FILE, SEND_LENGTH, SNIFF_BYTES, TOO_SLOW, UPLOAD_DEADLINE_MS, UPLOAD_SETTLE_MS, USE_POST, uploadTooLarge } from "./limits.ts";
import { cleanName, sniff, uploadName } from "./names.ts";

/** The Workspace's side of an upload (contracts/workspace.ts). */
export interface UploadRecorder {
	reserveUpload(caller: Caller, upload: { name: string; size: number }): Promise<Outcome<{ id: UploadId; key: string }>>;
	completeUpload(caller: Caller, id: UploadId, stored: { sha256: Sha256; size: number; mediaType: string }): Promise<Outcome<UploadOut>>;
	abandonUpload(caller: Caller, id: UploadId): Promise<void>;
}

/** The part of the bucket an upload writes. */
export interface UploadBucket {
	put(key: string, value: ReadableStream<Uint8Array>): Promise<{ size: number } | null>;
	delete(key: string): Promise<void>;
}

function refused(status: Refusal["status"], detail: string): { ok: false; refusal: Refusal } {
	return { ok: false, refusal: { status, detail } };
}

/**
 * The checks made before anything else is read (checks 2 to 7): POST, one Content-Length of
 * digits, at most the upload limit, and exactly one non-blank `?name=`, cleaned.
 */
export function checkUploadRequest(
	request: { method: string; headers: Headers; url: string },
	uploadBytes: number,
): Outcome<{ size: number; name: string }> {
	if (request.method !== "POST") return refused(405, USE_POST);
	// Several Content-Length headers arrive joined with ", ", which is not digits either.
	const length = request.headers.get("content-length");
	if (length === null) return refused(411, SEND_LENGTH);
	if (!/^[0-9]+$/.test(length)) return refused(400, INVALID_LENGTH);
	const size = Number(length);
	if (size > uploadBytes) return refused(413, uploadTooLarge(uploadBytes));
	const raw = uploadName(new URL(request.url).search.replace(/^\?/, ""));
	if (raw === null) return refused(400, NAME_THE_FILE);
	return { ok: true, value: { size, name: cleanName(raw) } };
}

interface Timer {
	promise: Promise<"late">;
	cancel(): void;
}

function timer(ms: number): Timer {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<"late">((resolve) => {
		handle = setTimeout(() => resolve("late"), ms);
	});
	return { promise, cancel: () => clearTimeout(handle) };
}

/** The first `limit` bytes of a stream, which is then cancelled (a tee's other branches go on). */
async function headOf(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const head = new Uint8Array(limit);
	let filled = 0;
	try {
		while (filled < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = value.subarray(0, limit - filled);
			head.set(take, filled);
			filled += take.length;
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	return head.slice(0, filled);
}

/** Which way a body missed its declared length, from the FixedLengthStream's refusal; null for any other failure. */
function lengthError(error: unknown): "longer" | "shorter" | null {
	const message = String(error);
	if (message.includes("too many bytes")) return "longer";
	if (message.includes("did not see all expected bytes")) return "shorter";
	return null;
}

export interface ReceiveOptions {
	/** 15 minutes; shorter in tests. */
	deadlineMs?: number;
	/** How long past the deadline to wait for the write to R2 to settle (UPLOAD_SETTLE_MS); shorter in tests. */
	settleMs?: number;
	/** Keeps the request's work alive after its response (`ctx.waitUntil`): the object of a write that settles even later is deleted. */
	waitUntil?: (work: Promise<unknown>) => void;
}

/**
 * Receives an upload whose request passed `checkUploadRequest` and the route's checks: reserved in the Workspace (3 arriving and 30 waiting per user, the workspace's quota), streamed
 * into R2 while hashed, then completed with its hash, size and sniffed type. Anything that fails after the
 * reservation abandons it, so the Workspace deletes the object, written or not; an R2 failure is thrown
 * (a 500) once it is abandoned. Past the deadline the write is stopped and given `settleMs` to end
 * before the abandonment, so the delete follows the write and not the other way round; a write that ends
 * later still has its object deleted (`waitUntil`).
 */
export async function receiveUpload(
	recorder: UploadRecorder,
	bucket: UploadBucket,
	caller: Caller,
	upload: { name: string; size: number; body: ReadableStream<Uint8Array> | null },
	options: ReceiveOptions = {},
): Promise<Outcome<UploadOut>> {
	const reserved = await recorder.reserveUpload(caller, { name: upload.name, size: upload.size });
	if (!reserved.ok) return reserved;
	const { id, key } = reserved.value;
	const abandon = () => recorder.abandonUpload(caller, id);
	const late = timer(options.deadlineMs ?? UPLOAD_DEADLINE_MS);
	try {
		const sized = new FixedLengthStream(upload.size);
		const body = upload.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
		const stop = new AbortController();
		const piping = body.pipeTo(sized.writable, { signal: stop.signal });
		// Whether the whole body is in: only then can the put still end with an object after the deadline.
		let arrived = false;
		piping.then(
			() => (arrived = true),
			() => {},
		);
		const [toStore, rest] = sized.readable.tee();
		const [toHash, toSniff] = rest.tee();
		const digest = new crypto.DigestStream("SHA-256");
		// Rejected with the stream when the body fails; read only on success.
		digest.digest.catch(() => {});
		const hashing = toHash.pipeTo(digest);
		const storing = bucket.put(key, toStore);
		const sniffing = headOf(toSniff, SNIFF_BYTES);
		const settled = Promise.allSettled([piping, hashing, storing, sniffing]);
		const outcome = await Promise.race([settled, late.promise]);
		if (outcome === "late") {
			// Best effort: workerd's pipe does not notice the abort while it waits for a chunk that never
			// comes. A put of a stream that never ends stores nothing, and the request's end cancels it.
			stop.abort(new Error("The file took too long to arrive."));
			// A body that has all arrived leaves the put finishing, and an object written after the Workspace deleted
			// it would stay under uploads/ until the bucket's lifecycle rule removes it, a day later. So the
			// abandonment follows the put when it ends soon, and when it does not, the object is deleted when it
			// does. A body still arriving cannot be stored: the abort ends its stream, and that is all.
			let ended: "ended" | "late" = "ended";
			if (arrived) {
				const second = timer(options.settleMs ?? UPLOAD_SETTLE_MS);
				ended = await Promise.race([storing.then(() => "ended" as const, () => "ended" as const), second.promise]);
				second.cancel();
			}
			await abandon();
			if (ended === "late") {
				const cleanup = storing
					.then(
						() => bucket.delete(key),
						() => {},
					)
					.catch(() => {});
				options.waitUntil?.(cleanup);
			}
			return refused(408, TOO_SLOW);
		}
		const [piped, hashed, stored, head] = outcome;
		const failure = [piped, stored, hashed].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
		if (failure) {
			await abandon();
			const missed = lengthError(failure.reason);
			if (missed === "longer") return refused(400, BODY_LONGER);
			if (missed === "shorter") return refused(400, BODY_SHORTER);
			throw failure.reason;
		}
		const object = (stored as PromiseFulfilledResult<{ size: number } | null>).value;
		if (object === null || object.size !== upload.size) {
			await abandon();
			throw new Error("The file was not stored as it was sent.");
		}
		const sha256 = hex(new Uint8Array(await digest.digest));
		const media = sniff(head.status === "fulfilled" ? head.value : new Uint8Array(), upload.name);
		const completed = await recorder.completeUpload(caller, id, { sha256, size: upload.size, mediaType: media });
		if (!completed.ok) await abandon();
		return completed;
	} catch (error) {
		await abandon().catch(() => {});
		throw error;
	} finally {
		late.cancel();
	}
}
