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

/** Where a conversation's blobs live: `blobs/<ws>/<conv>/` (ARCHITECTURE.md: Data placement). */
export function conversationPrefix(workspaceId: string, conversationId: string): string {
	return `blobs/${workspaceId}/${conversationId}/`;
}

export function blobKey(workspaceId: string, conversationId: string, sha256: string, random: string): string {
	return `${conversationPrefix(workspaceId, conversationId)}${sha256}/${random}`;
}

/**
 * Deletes a page of at most 1,000 objects under the prefix, listed from its start, so a page a call missed is found by the
 * next; returns how many it deleted, 0 once none is left.
 */
export async function deletePage(bucket: Pick<Bucket, "list" | "delete">, prefix: string): Promise<number> {
	const keys = (await bucket.list({ prefix, limit: 1000 })).objects.map((object) => object.key);
	if (keys.length > 0) await bucket.delete(keys);
	return keys.length;
}
