// What a caller (the Conversation Durable Object, the account tests' lab) does to get a container it may
// use: start it for its attempt, harden it, verify it, and give up on any failure, which the Sandbox has
// already answered by destroying the container (ARCHITECTURE.md: The sandbox lifecycle). A container that did
// not start, or stopped answering before it was verified, is replaced once first: a new start is often
// prompt where the first one never came up (as in the minutes after a new image). A hardening or a check that
// answered and failed is never retried. The result's fence is what every later call names, and what the
// ExecutionEnv (env.ts) is made with.

import type { AttemptFence } from "../shared/rpc.ts";
import type { SandboxSpec } from "./constants.ts";
import type { Lost, Refused, SandboxApi, SandboxFence } from "./core.ts";
import type { HardeningReport, VerificationReport } from "./hardening.ts";

export type Prepared =
	| { ok: true; fence: SandboxFence; ms: { start: number; harden: number; verify: number } }
	| { ok: false; stage: "start" | "harden" | "verify"; message: string };

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
	now: () => number = Date.now,
): Promise<Prepared> {
	const t0 = now();
	const first = await prepareOnce(sandbox, fence, spec, now, t0);
	if (!("again" in first)) return first;
	const second = await prepareOnce(sandbox, fence, spec, now, t0);
	return "again" in second ? { ok: false, stage: "start", message: second.again } : second;
}

/** One container: started, hardened and verified; `again` when it did not start or stopped answering. */
async function prepareOnce(
	sandbox: Pick<SandboxApi, "start" | "harden" | "verify">,
	fence: AttemptFence,
	spec: SandboxSpec,
	now: () => number,
	t0: number,
): Promise<Prepared | { again: string }> {
	const started = await sandbox.start(fence, spec);
	if (refusal(started)) return { ok: false, stage: "start", message: started.message };
	if ("failed" in started) return { again: started.failed };
	const ready: SandboxFence = { ...fence, incarnation: started.incarnation };
	const t1 = now();
	const hardened: HardeningReport | Refused | Lost = await sandbox.harden(ready);
	if (refusal(hardened)) return { ok: false, stage: "harden", message: hardened.message };
	if (lost(hardened)) return { again: hardened.lost };
	if (!hardened.ok) return { ok: false, stage: "harden", message: `The sandbox could not be hardened (${hardened.failed}).` };
	const t2 = now();
	const verified: VerificationReport | Refused | Lost = await sandbox.verify(ready);
	if (refusal(verified)) return { ok: false, stage: "verify", message: verified.message };
	if (lost(verified)) return { again: verified.lost };
	if (!verified.ok) {
		const failed = verified.checks.filter((check) => !check.ok).map((check) => check.name);
		return { ok: false, stage: "verify", message: `The sandbox failed its checks (${failed.join(", ")}).` };
	}
	return { ok: true, fence: ready, ms: { start: t1 - t0, harden: t2 - t1, verify: now() - t2 } };
}
