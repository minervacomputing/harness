// What a Laravel start becomes before anything is stored (docs/plans/start-and-cancel.md, startRun): the checks of the
// message alone, and the preparation, which compiles the run's snapshot from the command's raw authority
// (gateway/tools.ts `startSnapshot`) and selects its history with history.ts. Pure, but for hashing: the Conversation
// object stores the preparation once and every later try of the start uses it, so a run compiles once.

import type { StartRun, StartRunResult } from "@minerva/contract/internal";
import type { Attachment } from "@minerva/contract";
import { type Replayed, type StoredMessage, historyOf, recentHistory, withFiles } from "../conversation/history.ts";
import type { GrantRow, LayerRows, Level, RunLayers } from "../gateway/grants.ts";
import type { Registry } from "../gateway/registry.ts";
import { COMPILER_VERSION, type ConnectionInfo, type StartSnapshot, startSnapshot } from "../gateway/tools.ts";
import { hashInput } from "../lib/canonical.ts";
import { sha256Hex } from "../lib/hash.ts";
import { catalogVersion } from "./catalog.ts";

/** A start's compiled parts, kept from its first try until it is answered. */
export interface Preparation {
	snapshot: StartSnapshot;
	/** The versions the acceptance names, and the snapshot's digest. */
	catalog: string;
	compiler: string;
	digest: string;
	/** The earlier messages the run's pi session is seeded with, selected and clipped. */
	history: Replayed[];
}

export type StartRefusal = Extract<StartRunResult, { outcome: "refused" }>;

export function startRefusal(code: string, message: string): StartRefusal {
	return { outcome: "refused", code, message };
}

export function deletedRefusal(): StartRefusal {
	return startRefusal("CONVERSATION_DELETED", "This conversation was deleted.");
}

/** Where Laravel stages a workspace's uploads in the conversation's bucket: `uploads/`, which R2 expires after a day. */
export function stagingPrefix(workspace: string): string {
	return `uploads/${workspace}/`;
}

/**
 * The refusals the message alone decides, in order: nothing to send, too many attachments, one attached twice, and an
 * upload outside the workspace's staging prefix (a bug in Laravel, which only signs keys under it).
 */
export function messageRefusal(command: StartRun, limits: { messageAttachments: number }): StartRefusal | null {
	const { content, attachments } = command.message;
	if (content.trim() === "" && attachments.length === 0) return startRefusal("EMPTY_MESSAGE", "Write a message or attach a file.");
	if (attachments.length > limits.messageAttachments) {
		return startRefusal("TOO_MANY_ATTACHMENTS", `Attach at most ${limits.messageAttachments} files to a message.`);
	}
	const keys = attachments.map((attachment) => attachment.upload);
	if (new Set(keys).size !== keys.length) return startRefusal("ATTACHED_TWICE", "A file is attached twice.");
	const prefix = stagingPrefix(command.scope.workspace);
	if (keys.some((key) => !key.startsWith(prefix) || key.length === prefix.length)) {
		console.warn("startRun named an upload outside its workspace's staging prefix");
		return startRefusal("ATTACHMENT_UNAVAILABLE", UNAVAILABLE);
	}
	return null;
}

export const UNAVAILABLE = "An attached file is no longer available. Remove it and attach it again.";

/** One layer as the compiler reads it: the stored grants of that level, for its subject. */
function layerOf(level: Level, subject: string | null, layer: StartRun["authority"]["layers"]["ceiling"]): LayerRows | null {
	if (layer === null) return null;
	const grants: GrantRow[] = layer.grants.map((grant) => ({
		layer: level,
		subject,
		connectionId: grant.connection,
		kind: grant.kind,
		resourceId: grant.resource,
		resourceName: grant.name,
		actions: [...new Set(grant.actions)].sort(),
		effect: grant.effect,
	}));
	return { restricted: layer.restricted, grants };
}

/** The run's earlier messages as history.ts reads stored ones. */
function storedMessages(history: StartRun["history"]): StoredMessage[] {
	return history.map((message) => ({
		id: message.id,
		role: message.role,
		content: message.content,
		attachments: message.attachments,
		runId: message.run,
		createdAt: Date.parse(message.createdAt),
		changes: message.changes,
	}));
}

/**
 * The start's snapshot, versions, digest and history at `now`. `providerOf` knows the agent's connections only: an
 * allow on any other could never be used by this run, so dropping it changes nothing.
 */
export async function prepareStart(registry: Registry, command: StartRun, options: { now: number; runTimeoutMs: number | null }): Promise<Preparation> {
	const connections: ConnectionInfo[] = command.authority.connections.map((connection) => ({
		id: connection.id,
		provider: connection.provider,
		ownerId: connection.owner,
		status: connection.status,
		createdAt: Date.parse(connection.createdAt),
		scopes: connection.scopes,
	}));
	const providers = new Map(connections.map((connection) => [connection.id, connection.provider]));
	const { ceiling, user, agent } = command.authority.layers;
	const layers: RunLayers = {
		ceiling: layerOf("ceiling", null, ceiling),
		user: layerOf("user", command.user, user),
		agent: layerOf("agent", command.agent.id, agent),
	};
	const snapshot = startSnapshot(registry, {
		workspaceId: command.scope.workspace,
		conversationId: command.conversation,
		userId: command.user,
		agent: { id: command.agent.id, instructions: command.agent.instructions, modelAlias: command.agent.model },
		connections,
		layers,
		providerOf: (id) => providers.get(id) ?? null,
		createdAt: options.now,
		runTimeoutMs: options.runTimeoutMs,
	});
	return {
		snapshot,
		catalog: await catalogVersion(registry),
		compiler: COMPILER_VERSION,
		digest: await sha256Hex(hashInput("run-snapshot", snapshot)),
		history: recentHistory(historyOf(storedMessages(command.history), command.run)),
	};
}

/** The run's prompt: the message with its note naming the attachments as the folder holds them. */
export function promptOf(content: string, attachments: readonly Attachment[]): string {
	return withFiles({ role: "user", content, attachments: [...attachments], changes: null });
}

/** startRun's input as the recovery index records it: 64 hex of SHA-256 over its canonical JSON. */
export function inputDigest(command: StartRun): Promise<string> {
	return sha256Hex(hashInput("start-input", command));
}
