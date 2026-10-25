// Laravel's staged uploads: objects the browser put under
// `uploads/<workspace>/` in the conversation's bucket with a URL Laravel signed, which a start names. Nothing about one is
// trusted. Before its answer a start reads only each object's size and head, and sniffs its media type from the head. The
// run's copy then reads it in full, counted, hashed and sniffed again, and puts it with that SHA-256, which R2 checks, so
// an object replaced after it was measured fails the copy.

import { hex } from "../lib/bytes.ts";
import { uuid7 } from "../lib/random.ts";
import type { Sha256, UploadId } from "../shared/rpc.ts";
import { SNIFF_BYTES } from "./limits.ts";
import { cleanName, sniff } from "./names.ts";
import type { Bucket } from "./objects.ts";

/**
 * A measured upload a run's copy reserved. The Conversation Durable Object copies its object into a blob of its own as the
 * run's first step (ARCHITECTURE.md: Starting a run) and adds that to the folder: `uploads/` objects are deleted by the
 * bucket's lifecycle rule a day after they were written, attached or not, so nothing may keep naming one.
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

/** A staged upload as a start inspects it before its answer: its cleaned name, its declared size and the type of its head. */
export interface InspectedUpload {
	/** Its staging key in R2. */
	key: string;
	name: string;
	size: number;
	mediaType: string;
}

/** An attachment as a start names it: the staging key, the file's name and its declared size. */
export interface StagedUpload {
	upload: string;
	name: string;
	size: number;
}

const MEASURES = 4;

interface Measured {
	sha256: Sha256;
	head: Uint8Array;
}

async function sized(bucket: Pick<Bucket, "get">, key: string, declared: number, limit: number) {
	const object = await bucket.get(key);
	if (object === null) return null;
	if (object.size !== declared || object.size > limit) {
		await object.body.cancel();
		return null;
	}
	return object;
}

async function headOf(bucket: Pick<Bucket, "get">, key: string, declared: number, limit: number): Promise<Uint8Array | null> {
	const object = await sized(bucket, key, declared, limit);
	if (object === null) return null;
	// A BYOB read takes at most its view's bytes; a default read takes a whole chunk of the body, which may be larger.
	const reader = object.body.getReader({ mode: "byob" });
	let head = new Uint8Array(Math.min(SNIFF_BYTES, declared));
	let kept = 0;
	try {
		while (kept < head.byteLength) {
			const { done, value } = await reader.read(new Uint8Array(head.buffer, kept, head.byteLength - kept));
			if (value === undefined) break;
			head = new Uint8Array(value.buffer);
			kept += value.byteLength;
			if (done) break;
		}
	} finally {
		await reader.cancel();
	}
	return head.slice(0, kept);
}

async function measure(bucket: Pick<Bucket, "get">, key: string, declared: number, limit: number): Promise<Measured | null> {
	const object = await sized(bucket, key, declared, limit);
	if (object === null) return null;
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

async function eachStaged<T>(staged: readonly StagedUpload[], read: (item: StagedUpload) => Promise<T>): Promise<T[]> {
	const results: T[] = new Array(staged.length);
	let next = 0;
	const worker = async () => {
		while (next < staged.length) {
			const index = next++;
			results[index] = await read(staged[index] as StagedUpload);
		}
	};
	await Promise.all(Array.from({ length: Math.min(MEASURES, staged.length) }, worker));
	return results;
}

/** The staged uploads by their sizes and heads, their names cleaned, in the start's order; null when any is not there as declared. */
export async function inspectStaged(bucket: Pick<Bucket, "get">, staged: readonly StagedUpload[], uploadBytes: number): Promise<InspectedUpload[] | null> {
	const heads = await eachStaged(staged, (item) => headOf(bucket, item.upload, item.size, uploadBytes));
	const inspected: InspectedUpload[] = [];
	for (const [index, item] of staged.entries()) {
		const head = heads[index];
		if (head === null || head === undefined) return null;
		const name = cleanName(item.name);
		inspected.push({ key: item.upload, name, size: item.size, mediaType: sniff(head, name) });
	}
	return inspected;
}

/**
 * The staged uploads as uploads the folder copies, their names cleaned, in the start's order; null when any is not
 * there as declared. Each gets an id of its own.
 */
export async function measureStaged(bucket: Pick<Bucket, "get">, staged: readonly StagedUpload[], uploadBytes: number): Promise<ReservedUpload[] | null> {
	const measured = await eachStaged(staged, (item) => measure(bucket, item.upload, item.size, uploadBytes));
	const uploads: ReservedUpload[] = [];
	for (const [index, item] of staged.entries()) {
		const found = measured[index];
		if (found === null || found === undefined) return null;
		const name = cleanName(item.name);
		uploads.push({ id: uuid7(), name, size: item.size, mediaType: sniff(found.head, name), sha256: found.sha256, key: item.upload });
	}
	return uploads;
}
