// What a caller (the Conversation Durable Object, the account tests' lab) does to get a container it may
// use: start it for its attempt, harden it, verify it, and give up on any failure, which the Sandbox has
// already answered by destroying the container (plan: The sandbox lifecycle). The result's fence is what
// every later call names, and what the ExecutionEnv (env.ts) is made with.

import type { AttemptFence } from "../shared/rpc.ts";
import type { SandboxSpec } from "./constants.ts";
import type { Refused, SandboxApi, SandboxFence } from "./core.ts";
import type { HardeningReport, VerificationReport } from "./hardening.ts";

export type Prepared =
	| { ok: true; fence: SandboxFence; ms: { start: number; harden: number; verify: number } }
	| { ok: false; stage: "start" | "harden" | "verify"; message: string };

function refusal(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

export async function prepareSandbox(
	sandbox: Pick<SandboxApi, "start" | "harden" | "verify" | "destroy">,
	fence: AttemptFence,
	spec: SandboxSpec,
	now: () => number = Date.now,
): Promise<Prepared> {
	const t0 = now();
	const started = await sandbox.start(fence, spec);
	if (refusal(started)) return { ok: false, stage: "start", message: started.message };
	if ("failed" in started) return { ok: false, stage: "start", message: started.failed };
	const ready: SandboxFence = { ...fence, incarnation: started.incarnation };
	const t1 = now();
	const hardened: HardeningReport | Refused = await sandbox.harden(ready);
	if (refusal(hardened)) return { ok: false, stage: "harden", message: hardened.message };
	if (!hardened.ok) return { ok: false, stage: "harden", message: `The sandbox could not be hardened (${hardened.failed}).` };
	const t2 = now();
	const verified: VerificationReport | Refused = await sandbox.verify(ready);
	if (refusal(verified)) return { ok: false, stage: "verify", message: verified.message };
	if (!verified.ok) {
		const failed = verified.checks.filter((check) => !check.ok).map((check) => check.name);
		return { ok: false, stage: "verify", message: `The sandbox failed its checks (${failed.join(", ")}).` };
	}
	return { ok: true, fence: ready, ms: { start: t1 - t0, harden: t2 - t1, verify: now() - t2 } };
}
