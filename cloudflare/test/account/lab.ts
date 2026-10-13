// The sandbox lab of the test instance (src/faults/lab.ts: `POST /api/faults/sandbox/<op>`
// behind the driver's token), shared by sandbox.test.ts and sandbox-faults.test.ts. The lab keeps nothing: the
// client keeps each sandbox's fence from its prepare (or start) and sends it with each later operation on
// that sandbox. Every sandbox named here is remembered before its first request, so `destroyAll()` in a
// file's afterAll can destroy it with the fence its status gives, even when an answer was lost.

import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { fetchDeployed, testWorker } from "./client.ts";

export const MiB = 1024 * 1024;

/** The test Worker. Missing or misdirected settings fail the run (a skipped sandbox lab would look like a pass). */
const WORKER = testWorker();
const TOKEN = await faultsToken(WORKER.secretKey);
/** Each sandbox's fence, from its prepare or start. */
const fences = new Map<string, unknown>();
const named = new Set<string>();

// biome-ignore lint: free-form answers from the lab.
export type Answer = any;

export async function lab(op: string, body: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<Answer> {
	const name = typeof body.name === "string" ? body.name : undefined;
	if (name !== undefined) named.add(name);
	const sent = name !== undefined && body.fence === undefined && fences.has(name) ? { ...body, fence: fences.get(name) } : body;
	const reply = await fetchDeployed(`${WORKER.origin}/api/faults/sandbox/${op}`, {
		method: "POST",
		headers: { "content-type": "application/json", [FAULTS_HEADER]: TOKEN },
		body: JSON.stringify(sent),
		timeoutMs,
	});
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 500)}`);
	const answer = JSON.parse(reply.text) as Answer;
	if (name !== undefined && op === "prepare" && answer.prepared?.ok) fences.set(name, answer.prepared.fence);
	if (name !== undefined && op === "start" && answer.fence) fences.set(name, answer.fence);
	return answer;
}

export const sh = (name: string, command: string, extra: Record<string, unknown> = {}) => lab("exec", { name, request: { command, timeoutSeconds: 120, ...extra } });

/**
 * Cleanup, each file's afterAll: destroys every sandbox this file named that still has a container, with the
 * fence of its status, and waits until each is gone. Every one is tried; the failures are reported together.
 */
export async function destroyAll(): Promise<void> {
	const outcomes = await Promise.allSettled(
		[...named].map(async (name) => {
			const started = Date.now();
			for (;;) {
				const { status, running } = await lab("status", { name });
				if (status.state === "none" && !running && !status.cleanupPending) return;
				if (status.incarnation && status.state !== "destroying") {
					await lab("destroy", { name, fence: { runId: status.runId, attempt: status.attempt, incarnation: status.incarnation }, reason: "tests over" });
				}
				if (Date.now() - started > 120_000) throw new Error(`${name} was not destroyed: ${JSON.stringify({ status, running })}`);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		}),
	);
	const failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => String(outcome.reason));
	if (failures.length) throw new Error(`Cleanup left sandboxes behind:\n${failures.join("\n")}`);
}
