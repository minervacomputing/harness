// The part of an R2 bucket the folder uses (addressing.ts `filesBucket`), as an interface so the store is
// tested in Node with an in-memory one; an `R2Bucket` is one.

export interface StoredObject {
	body: ReadableStream<Uint8Array>;
	size: number;
}

export interface Bucket {
	get(key: string): Promise<StoredObject | null>;
	/** R2 checks `sha256` and refuses a body that does not match (error 10037). */
	put(key: string, value: ReadableStream<Uint8Array> | Uint8Array | string, options?: { sha256?: string }): Promise<{ size: number } | null>;
	/** At most 1,000 keys at once; missing ones are not an error. */
	delete(keys: string | string[]): Promise<void>;
	list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Where a conversation's blobs live: `blobs/<ws>/<conv>/` (plan: Data placement). */
export function conversationPrefix(workspaceId: string, conversationId: string): string {
	return `blobs/${workspaceId}/${conversationId}/`;
}

export function blobKey(workspaceId: string, conversationId: string, sha256: string, random: string): string {
	return `${conversationPrefix(workspaceId, conversationId)}${sha256}/${random}`;
}

/** Deletes every object under the prefix, a page of 1,000 at a time; returns how many it found. */
export async function deletePrefix(bucket: Pick<Bucket, "list" | "delete">, prefix: string): Promise<number> {
	let deleted = 0;
	// Listing again from the start after each page's deletion finds what a page missed and stops when empty.
	for (let round = 0; round < 10_000; round++) {
		const page = await bucket.list({ prefix, limit: 1000 });
		const keys = page.objects.map((object) => object.key);
		if (keys.length === 0) return deleted;
		await bucket.delete(keys);
		deleted += keys.length;
		if (!page.truncated && keys.length < 1000) return deleted;
	}
	throw new Error(`The objects under ${prefix} could not all be deleted.`);
}
