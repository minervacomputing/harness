// The Conversation Durable Object's folder (conversation/ports.ts `FolderPort`): store.ts over the object's
// SQLite, its workspace's bucket and the Workspace's byte counter (none for a Laravel conversation), with the
// conversation's own store for its run checks, `outside` and its clock. `FOLDER_PORTS` is what the platform tests replace (a bucket that
// crashes the object mid-copy, say), as `PORTS` is for the Conversation.

import { filesBucket, workspaceObject } from "../addressing.ts";
import { settings } from "../config.ts";
import type { FolderPort, PortsContext } from "../conversation/ports.ts";
import { durableSql } from "../lib/sql.ts";
import type { Bucket } from "./objects.ts";
import { measureStaged } from "./staging.ts";
import { type AttachmentPlan, type ByteCounter, FolderStore } from "./store.ts";

/**
 * A Laravel conversation's byte counter: none yet, since storage is counted against allowances in chunk 14 of
 * product-and-engine.md, and no Workspace object stands behind it.
 */
const UNCOUNTED: ByteCounter = { setConversationBytes: async () => ({ ok: true }) };

export const FOLDER_PORTS: { bucket(context: PortsContext): Bucket; counter(context: PortsContext): ByteCounter } = {
	bucket: (context) => filesBucket(context.env, context.workspace),
	// Typed by the Workspace class; the folder calls only its byte counter.
	counter: (context) => workspaceObject(context.env, context.workspace) as unknown as ByteCounter,
};

/** The store for a Conversation's context: one per object instance. */
export function folderStore(context: PortsContext): FolderStore {
	const store = context.store;
	const limits = settings(context.env).files;
	return new FolderStore({
		sql: durableSql(context.ctx.storage),
		bucket: FOLDER_PORTS.bucket(context),
		counter: context.organization === null ? FOLDER_PORTS.counter(context) : UNCOUNTED,
		workspaceId: context.workspace.id,
		conversationId: context.conversationId,
		settings: { folderBytes: limits.folderBytes, folderEntries: limits.folderEntries, runUploadBytes: limits.runUploadBytes },
		now: () => store.now(),
		outside: (change) => store.outside(change),
		isCurrent: (fence) => store.isCurrent(fence),
		conversation: () => {
			const row = store.conversation();
			return row === null ? null : { folderVersionId: row.folder_version_id, deleted: row.deleted_at !== null };
		},
		schedule: (at) => context.schedule(at),
		log: (message, error) => {
			const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
			console.warn(`conversation ${context.conversationId}: ${message}${detail}`.slice(0, 2000));
		},
	});
}

/** The folder a Conversation runs against (conversation/ports.ts `defaultPorts`). */
export function conversationFolder(context: PortsContext): FolderPort {
	const folder = folderStore(context);
	return {
		usage: () => folder.usage(),
		measureStaged: (staged, uploadBytes) => measureStaged(FOLDER_PORTS.bucket(context), staged, uploadBytes),
		async deleteStaged(keys) {
			if (keys.length) await FOLDER_PORTS.bucket(context).delete([...keys]);
		},
		async prepareAttachments(runId, uploads) {
			const prepared = await folder.prepareAttachments(runId, uploads);
			return prepared.ok ? { ok: true, value: { uploads, state: { plan: prepared.value } } } : prepared;
		},
		commitAttachments: (runId, prepared) => folder.commitAttachments(runId, (prepared.state.plan ?? null) as AttachmentPlan | null),
		publish: (runId, run) => folder.publish(runId, run),
		list: (versionId) => folder.list(versionId),
		resolve: (versionId, path) => folder.resolve(versionId, path),
		async deleteObjects() {
			await folder.deleteObjects();
		},
		hydratePlan: (runId) => folder.hydratePlan(runId),
		checkpoint: (fence, scan, upload) => folder.checkpoint(fence, scan, upload),
		sweep: () => folder.sweep(),
	};
}
