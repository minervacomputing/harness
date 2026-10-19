// `startRun`, `cancelRun` and `replayFacts` in the Worker: the recovery index first, so no run executes
// without its row and every command names the scope and conversation its run was bound to; then the conversation's
// object, addressed by the index's jurisdiction, which binds itself and answers. A purged conversation's object is
// destroyed, so the index answers for it.

import type { CancelRun, CancelRunResult, Fact, ReplayFacts, StartRun, StartRunResult } from "@minerva/contract/internal";
import { conversationObject } from "../addressing.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { MISMATCH, answered, factsPruned, internalRefusal } from "./errors.ts";
import { bindRun, conversationOf } from "./recovery.ts";
import { deletedRefusal, inputDigest } from "./start.ts";

/** The run bound in the index, or the index's refusal; the workspace as the index addresses it. */
async function bound(env: Env, command: StartRun | CancelRun, digest: string | null): Promise<{ workspace: WorkspaceRef; deleted: boolean; purged: boolean }> {
	const binding = await bindRun(env.DB, { scope: command.scope, conversation: command.conversation, run: command.run, digest, now: Date.now() });
	if (!binding.ok) throw internalRefusal(binding.code, binding.message);
	return binding;
}

/**
 * A conversation the index has deleted is deleted in its object first, which finishes a deletion that stopped between the
 * two: the start is then refused there, or its stored answer replayed. The start says so too, since the object can be purged
 * between the two calls, and one made again must bind deleted. A purged one is refused here, an accepted start sent again
 * included: its answer went with the object.
 */
export async function startRun(env: Env, command: StartRun): Promise<StartRunResult> {
	const { workspace, deleted, purged } = await bound(env, command, await inputDigest(command));
	if (purged) return deletedRefusal();
	const conversation = conversationObject(env, workspace, command.conversation);
	if (deleted) answered(await conversation.deleteInternal({ scope: command.scope, conversation: command.conversation }, workspace));
	return answered(await conversation.startInternal(command, workspace, deleted));
}

/**
 * As a start: deleted in the object first, so a cancel that read the index before a purge's mark makes the object again only
 * as a deleted conversation, which purges itself after its window. A purged one's runs have all ended.
 */
export async function cancelRun(env: Env, command: CancelRun): Promise<CancelRunResult> {
	const { workspace, deleted, purged } = await bound(env, command, null);
	if (purged) return { state: "ended" };
	const conversation = conversationObject(env, workspace, command.conversation);
	if (deleted) answered(await conversation.deleteInternal({ scope: command.scope, conversation: command.conversation }, workspace));
	return answered(await conversation.cancelInternal(command, workspace, deleted));
}

/**
 * `replayFacts`: read through the index without binding anything, so an unknown
 * conversation is `NOT_FOUND` and one bound to another organization or workspace `SCOPE_MISMATCH`, as its object checks again;
 * a page from below its floor less one is `FACTS_PRUNED`, with the floor. A purged conversation held no fact Laravel had not
 * acknowledged, so its floor is the index's last sequence plus one, and nothing is left above it.
 */
export async function replayFacts(env: Env, command: ReplayFacts): Promise<{ conversation: string; facts: Fact[]; more: boolean }> {
	const indexed = await conversationOf(env.DB, command.conversation);
	if (indexed === null) throw internalRefusal("NOT_FOUND", "No such conversation.");
	if (indexed.organization !== command.scope.organization || indexed.workspace.id !== command.scope.workspace) {
		throw internalRefusal("SCOPE_MISMATCH", MISMATCH);
	}
	if (indexed.purged) {
		if (command.after < indexed.factSeq) throw factsPruned(indexed.factSeq + 1);
		return { conversation: command.conversation, facts: [], more: false };
	}
	const page = answered(await conversationObject(env, indexed.workspace, command.conversation).replayInternal(command, indexed.workspace));
	return { conversation: command.conversation, ...page };
}
