// What a caller (the Conversation Durable Object, the account tests' lab) does to get a container it may
// use: start it for its attempt, harden it, verify it, and give up on any failure, which the Sandbox has
// already answered by destroying the container (ARCHITECTURE.md: The sandbox lifecycle). A container that did
// not start, or stopped answering before it was verified, is replaced once first: a new start is often
// prompt where the first one never came up (as in the minutes after a new image). A hardening or a check that
// answered and failed is never retried. Given the version the attempt hydrates, the first start may restore the
// conversation's snapshot instead of starting the image; a restored container that fails at any step says only
// that the snapshot could not be used, so both of those tries from the image still follow it. A stale or sealed
// refusal is never retried. The result's fence is what every later call names, and what the ExecutionEnv (env.ts)
// is made with.

import type { AttemptFence, VersionId } from "../shared/rpc.ts";
import type { SandboxSpec } from "./constants.ts";
import type { Lost, Refused, SandboxApi, SandboxFence } from "./core.ts";
import type { HardeningReport, VerificationReport } from "./hardening.ts";

export type Prepared =
	| { ok: true; fence: SandboxFence; restored: boolean; ms: { start: number; harden: number; verify: number } }
	| { ok: false; stage: "start" | "harden" | "verify"; message: string };

/** A try that gave no usable container but may be followed by another: `restored` when it was a restore. */
type Again = { again: string; restored: boolean };

function refusal(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

function lost(value: unknown): value is Lost {
	return typeof value === "object" && value !== null && "lost" in value;
}

export async function prepareSandbox(
	sandbox: Pick<SandboxApi, "start" | "harden" | "verify" | "destroy">,
	fence: AttemptFence,
	spec: SandboxSpec,
	restore: VersionId | null = null,
	now: () => number = Date.now,
): Promise<Prepared> {
	const t0 = now();
	let prepared = await prepareOnce(sandbox, fence, spec, restore, now, t0);
	// A failed restore leaves both of the image's tries; a start that restored nothing was the first of them.
	const tries = "again" in prepared && prepared.restored ? 2 : 1;
	for (let i = 0; i < tries && "again" in prepared; i++) prepared = await prepareOnce(sandbox, fence, spec, null, now, t0);
	return "again" in prepared ? { ok: false, stage: "start", message: prepared.again } : prepared;
}

/**
 * One container: started, hardened and verified; `again` when it did not start or stopped answering, or when it was
 * restored and failed at any step.
 */
async function prepareOnce(
	sandbox: Pick<SandboxApi, "start" | "harden" | "verify">,
	fence: AttemptFence,
	spec: SandboxSpec,
	restore: VersionId | null,
	now: () => number,
	t0: number,
): Promise<Prepared | Again> {
	const started = await sandbox.start(fence, spec, restore);
	if (refusal(started)) return { ok: false, stage: "start", message: started.message };
	if ("failed" in started) return { again: started.failed, restored: started.restored === true };
	// A Sandbox still on the previous version answers no `restored`, and never restores.
	const restored = started.restored === true;
	const ready: SandboxFence = { ...fence, incarnation: started.incarnation };
	const t1 = now();
	const hardened: HardeningReport | Refused | Lost = await sandbox.harden(ready);
	if (refusal(hardened)) return { ok: false, stage: "harden", message: hardened.message };
	if (lost(hardened)) return { again: hardened.lost, restored };
	if (!hardened.ok) {
		const message = `The sandbox could not be hardened (${hardened.failed}).`;
		return restored ? { again: message, restored } : { ok: false, stage: "harden", message };
	}
	const t2 = now();
	const verified: VerificationReport | Refused | Lost = await sandbox.verify(ready);
	if (refusal(verified)) return { ok: false, stage: "verify", message: verified.message };
	if (lost(verified)) return { again: verified.lost, restored };
	if (!verified.ok) {
		const failed = verified.checks.filter((check) => !check.ok).map((check) => check.name);
		const message = `The sandbox failed its checks (${failed.join(", ")}).`;
		return restored ? { again: message, restored } : { ok: false, stage: "verify", message };
	}
	return { ok: true, fence: ready, restored, ms: { start: t1 - t0, harden: t2 - t1, verify: now() - t2 } };
}
