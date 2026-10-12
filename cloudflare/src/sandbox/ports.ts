// What the Sandbox's logic (core.ts) needs from its object: the container, its storage, the bucket, a
// clock and ids. The object (sandbox.ts) passes `ctx.container`, `ctx.storage.sql` and the workspace's
// bucket; unit tests pass fakes, and the local container tests a Docker container (test/unit/).

import type { WorkspaceRef } from "../contracts/common.ts";
import { hex } from "../lib/bytes.ts";
import type { Sql } from "../lib/sql.ts";

/** The part of `ctx.container` the Sandbox uses. */
export interface ContainerPort {
	readonly running: boolean;
	/** Starts the image with no route out; the first exec waits for it. */
	start(options: { enableInternet: false; instance: "standard-1"; labels: { [name: string]: string } }): void;
	exec(argv: string[], options: ContainerExecOptions): Promise<ExecProcess>;
	destroy(reason?: string): Promise<void>;
	setInactivityTimeout(ms: number): Promise<void>;
}

/** The parts of an R2 bucket a hydration reads and a checkpoint writes. */
export interface BucketPort {
	get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
	/** Puts exactly `size` bytes; R2 refuses a body whose SHA-256 is not `sha256`. */
	put(key: string, body: ReadableStream<Uint8Array>, options: { size: number; sha256: string }): Promise<void>;
	/** Reads exactly `size` bytes and stores nothing; refuses them, as a put would, when their SHA-256 is not `sha256`. */
	check(body: ReadableStream<Uint8Array>, options: { size: number; sha256: string }): Promise<void>;
}

/** What a check refuses: its message names the hash, as R2's refusal does (folder.ts `isMismatch`). */
export const CHECK_MISMATCH = "The contents do not match their SHA-256.";

/**
 * Pipes `body` into `writable` while `other` consumes the far side. When either fails, the other is ended
 * too: a consumer that refused before it read would otherwise leave the pipe waiting on it, holding `body`.
 */
async function piped(body: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, other: (stop: AbortController) => Promise<void>): Promise<void> {
	const stop = new AbortController();
	const failed = (error: unknown): never => {
		stop.abort(error);
		throw error;
	};
	const [pipe, consumed] = await Promise.allSettled([body.pipeTo(writable, { signal: stop.signal }).catch(failed), other(stop).catch(failed)]);
	if (consumed.status === "rejected") throw consumed.reason;
	if (pipe.status === "rejected") throw pipe.reason;
}

export interface SandboxPorts {
	container: ContainerPort | null;
	sql: Sql;
	bucket(workspace: WorkspaceRef): BucketPort;
	now(): number;
	/** A new incarnation id. */
	id(): string;
	/** Asks for the object's alarm at `at` (ms), or clears it with null. */
	alarm(at: number | null): Promise<void>;
	/** Runs `work` after the current call has answered, keeping the object alive for it. */
	background(work: Promise<unknown>): void;
	log(message: string, fields?: { [name: string]: string | number | boolean | null }): void;
	/**
	 * Where the agent cgroup is. The platform's is `/sys/fs/cgroup/agent`; the local container tests use one
	 * of their own under the host's cgroup tree, which Docker's own cgroup cannot hold a child of.
	 */
	cgroup?: string;
}

/** R2 as a BucketPort: a put of a known length, its SHA-256 checked by R2. */
export function r2Bucket(bucket: R2Bucket): BucketPort {
	return {
		async get(key) {
			const object = await bucket.get(key);
			return object ? { size: object.size, body: object.body } : null;
		},
		async put(key, body, options) {
			const fixed = new FixedLengthStream(options.size);
			await piped(body, fixed.writable, async () => {
				await bucket.put(key, fixed.readable, { sha256: options.sha256 });
			});
		},
		async check(body, options) {
			const fixed = new FixedLengthStream(options.size);
			const digest = new crypto.DigestStream("SHA-256");
			// Rejected with the stream when the body fails; read only on success.
			digest.digest.catch(() => {});
			await piped(body, fixed.writable, (stop) => fixed.readable.pipeTo(digest, { signal: stop.signal }));
			if (hex(new Uint8Array(await digest.digest)) !== options.sha256) throw new Error(CHECK_MISMATCH);
		},
	};
}
