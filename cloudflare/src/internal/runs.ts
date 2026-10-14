// `startRun` and `cancelRun` in the Worker (docs/plans/start-and-cancel.md): the recovery index first, so no run executes
// without its row and every command names the scope and conversation its run was bound to; then the conversation's
// object, addressed by the index's jurisdiction, which binds itself and answers.

import type { CancelRun, CancelRunResult, StartRun, StartRunResult } from "@minerva/contract/internal";
import { conversationObject } from "../addressing.ts";
import type { InternalAnswer } from "../conversation/conversation.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { internalRefusal } from "./errors.ts";
import { bindRun } from "./recovery.ts";
import { inputDigest } from "./start.ts";

function answered<T>(answer: InternalAnswer<T>): T {
	if (!answer.ok) throw internalRefusal("SCOPE_MISMATCH", "This conversation belongs to another organization or workspace.");
	return answer.value;
}

/** The run bound in the index, or the index's refusal; the workspace as the index addresses it. */
async function bound(env: Env, command: StartRun | CancelRun, digest: string | null): Promise<WorkspaceRef> {
	const binding = await bindRun(env.DB, { scope: command.scope, conversation: command.conversation, run: command.run, digest, now: Date.now() });
	if (!binding.ok) throw internalRefusal(binding.code, binding.message);
	return binding.workspace;
}

export async function startRun(env: Env, command: StartRun): Promise<StartRunResult> {
	const workspace = await bound(env, command, await inputDigest(command));
	return answered(await conversationObject(env, workspace, command.conversation).startInternal(command, workspace));
}

export async function cancelRun(env: Env, command: CancelRun): Promise<CancelRunResult> {
	const workspace = await bound(env, command, null);
	return answered(await conversationObject(env, workspace, command.conversation).cancelInternal(command, workspace));
}
