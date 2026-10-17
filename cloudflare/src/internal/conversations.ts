// `folder`, `resolveDownload` and `deleteConversation` in the Worker (the app's docs/plans/conversations.md, 12a). The reads go
// through the recovery index without binding anything, as `replayFacts` does: an unknown conversation is `NOT_FOUND`, one
// bound to another organization or workspace `SCOPE_MISMATCH`, and a deleted one answers as missing. A deletion is marked in
// the index first, binding the conversation if no command named it, so a start that arrives later is refused; then its object
// marks itself deleted and stops its run.

import type { Folder } from "@minerva/contract";
import type { DeleteConversation, DeleteConversationResult, ReadFolder, ResolveDownload, ResolveDownloadResult, Scope } from "@minerva/contract/internal";
import { conversationObject, filesBucket } from "../addressing.ts";
import { SNIFF_BYTES } from "../files/limits.ts";
import { sniff } from "../files/names.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { MISMATCH, answered, internalRefusal } from "./errors.ts";
import { conversationOf, deleteIndexed } from "./recovery.ts";

/** The conversation's workspace as the index addresses it, for a conversation bound to the scope and not deleted. */
async function readable(env: Env, scope: Scope, conversation: string): Promise<WorkspaceRef> {
	const indexed = await conversationOf(env.DB, conversation);
	if (indexed === null) throw internalRefusal("NOT_FOUND", "No such conversation.");
	if (indexed.organization !== scope.organization || indexed.workspace.id !== scope.workspace) throw internalRefusal("SCOPE_MISMATCH", MISMATCH);
	if (indexed.deleted) throw internalRefusal("NOT_FOUND", "No such conversation.");
	return indexed.workspace;
}

export async function readFolder(env: Env, command: ReadFolder): Promise<Folder> {
	const workspace = await readable(env, command.scope, command.conversation);
	const folder = answered(await conversationObject(env, workspace, command.conversation).folderInternal(command, workspace));
	if (folder === null) throw internalRefusal("NOT_FOUND", "No such version.");
	return folder;
}

/**
 * The file's object, with the type sniffed from its name and first bytes as an upload's is: the folder keeps none. The key is
 * the engine's answer alone; Laravel never derives one from a path.
 */
export async function resolveDownload(env: Env, command: ResolveDownload): Promise<ResolveDownloadResult> {
	const workspace = await readable(env, command.scope, command.conversation);
	const target = answered(await conversationObject(env, workspace, command.conversation).downloadInternal(command, workspace));
	if (target === null) return { outcome: "missing" };
	const bucket = filesBucket(env, workspace);
	// A blob the folder names but R2 no longer holds is missing, as the public download answers it. An empty one has no range.
	if (target.size === 0) {
		if ((await bucket.head(target.key)) === null) return { outcome: "missing" };
		return { outcome: "found", key: target.key, size: 0, sha256: target.sha256, mediaType: sniff(new Uint8Array(), target.path) };
	}
	const head = await bucket.get(target.key, { range: { offset: 0, length: SNIFF_BYTES } });
	if (head === null) return { outcome: "missing" };
	const bytes = new Uint8Array(await head.arrayBuffer());
	return { outcome: "found", key: target.key, size: target.size, sha256: target.sha256, mediaType: sniff(bytes, target.path) };
}

export async function deleteConversation(env: Env, command: DeleteConversation): Promise<DeleteConversationResult> {
	const marked = await deleteIndexed(env.DB, { scope: command.scope, conversation: command.conversation, now: Date.now() });
	if (!marked.ok) throw internalRefusal("SCOPE_MISMATCH", MISMATCH);
	const { workspace } = marked.conversation;
	return answered(await conversationObject(env, workspace, command.conversation).deleteInternal(command, workspace));
}
