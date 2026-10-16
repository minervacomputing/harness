// Laravel's staged uploads (docs/plans/start-and-cancel.md, The attachments): objects the browser put under
// `uploads/<workspace>/` in the conversation's bucket with a URL Laravel signed, which a start names. Nothing about one is
// trusted: its size is read before its bytes, then its bytes are counted and hashed, and its media type is sniffed from
// its head. The folder then copies it as a reserved upload, put with this SHA-256, which R2 checks, so an object replaced
// after it was measured fails the copy.

import { hex } from "../lib/bytes.ts";
import { uuid7 } from "../lib/random.ts";
import type { Sha256, UploadId } from "../shared/rpc.ts";
import { SNIFF_BYTES } from "./limits.ts";
import { cleanName, sniff } from "./names.ts";
import type { Bucket } from "./objects.ts";

/**
 * A measured upload a run start reserved. The Conversation Durable Object copies its object into a blob of its own before
 * the start's transaction (ARCHITECTURE.md: Starting a run) and adds that to the folder: `uploads/` objects are deleted
 * by the bucket's lifecycle rule a day after they were written, attached or not, so nothing may keep naming one.
 */
export interface ReservedUpload {
	id: UploadId;
	/** The cleaned name; numbered against the folder's root names when added. */
	name: string;
	size: number;
	mediaType: string;
	sha256: Sha256;
	/** Its staging key in R2. */
	key: string;
}

/** An attachment as a start names it: the staging key, the file's name and its declared size. */
export interface StagedUpload {
	upload: string;
	name: string;
	size: number;
}

/** Staged objects measured at once ("Transfers per run", as the folder's copies). */
const MEASURES = 4;

interface Measured {
	sha256: Sha256;
	head: Uint8Array;
}

/**
 * The object's SHA-256 and first bytes, or null when it is missing, its size is not the declared one or over `limit`
 * (refused before any byte is read), or the bytes counted are not its size.
 */
async function measure(bucket: Pick<Bucket, "get">, key: string, declared: number, limit: number): Promise<Measured | null> {
	const object = await bucket.get(key);
	if (object === null) return null;
	if (object.size !== declared || object.size > limit) {
		await object.body.cancel();
		return null;
	}
	const head = new Uint8Array(SNIFF_BYTES);
	let kept = 0;
	let counted = 0;
	const counting = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (kept < SNIFF_BYTES) {
				const part = chunk.subarray(0, SNIFF_BYTES - kept);
				head.set(part, kept);
				kept += part.byteLength;
			}
			counted += chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
	const digest = new crypto.DigestStream("SHA-256");
	await object.body.pipeThrough(counting).pipeTo(digest);
	if (counted !== declared) return null;
	return { sha256: hex(new Uint8Array(await digest.digest)), head: head.slice(0, kept) };
}

/**
 * The staged uploads as uploads the folder copies, their names cleaned, in the start's order; null when any is not
 * there as declared. Each gets an id of its own: it has no row in a Workspace.
 */
export async function measureStaged(bucket: Pick<Bucket, "get">, staged: readonly StagedUpload[], uploadBytes: number): Promise<ReservedUpload[] | null> {
	const measured: (Measured | null)[] = new Array(staged.length).fill(null);
	let next = 0;
	const worker = async () => {
		while (next < staged.length) {
			const index = next++;
			const item = staged[index] as StagedUpload;
			measured[index] = await measure(bucket, item.upload, item.size, uploadBytes);
		}
	};
	await Promise.all(Array.from({ length: Math.min(MEASURES, staged.length) }, worker));
	const uploads: ReservedUpload[] = [];
	for (const [index, item] of staged.entries()) {
		const found = measured[index];
		if (found === null || found === undefined) return null;
		const name = cleanName(item.name);
		uploads.push({ id: uuid7(), name, size: item.size, mediaType: sniff(found.head, name), sha256: found.sha256, key: item.upload });
	}
	return uploads;
}
