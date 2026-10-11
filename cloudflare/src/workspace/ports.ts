// What the Workspace's logic reaches outside its own storage, as interfaces, so it is tested in Node with
// fakes over node:sqlite and the Durable Object wires the real ones (workspace.ts, env.ts).

import type { ConversationId, EpochMs, RunId } from "../contracts/common.ts";
import type { CancelAck, ConversationInit } from "../contracts/conversation.ts";
import type { CancelReason } from "../contracts/runs.ts";

/**
 * The Conversation Durable Objects of this workspace, as the Workspace calls them (contracts/conversation.ts,
 * ConversationApi). `cancel` returning is the acknowledgement the revocation outbox waits for.
 */
export interface ConversationClient {
	init(input: ConversationInit): Promise<void>;
	cancel(conversationId: ConversationId, runId: RunId, reason: CancelReason, entryId: number): Promise<CancelAck>;
	destroy(conversationId: ConversationId): Promise<{ done: boolean }>;
}

/** The workspace's bucket, for deleting upload objects (addressing.ts `filesBucket`). */
export interface ObjectStore {
	/** Deletes the keys (at most 1,000 at once); missing ones are not an error. */
	delete(keys: string[]): Promise<void>;
}

/** A timer that can be cancelled, so a request that finished early leaves none running. */
export interface Delay {
	promise: Promise<void>;
	cancel(): void;
}

export interface Timers {
	now(): EpochMs;
	delay(ms: number): Delay;
}

/** Timers on the platform's clock. */
export const realTimers: Timers = {
	now: () => Date.now(),
	delay(ms) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		});
		return { promise, cancel: () => timer !== undefined && clearTimeout(timer) };
	},
};

/** An OAuth client: the operator's, or one registered dynamically (connectors 11.1). */
export interface ClientCredentials {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

/** Where OAuth clients come from: MINERVA_<APP>_CLIENT_ID and _SECRET, and D1's `oauth_clients`. */
export interface OAuthClients {
	/** The operator's client for an app; both values must be set, and an empty id counts as unset. */
	configured(app: string): { clientId: string; clientSecret: string } | null;
	/** The dynamically registered client for (app, redirect URI), or null. */
	stored(app: string, redirectUri: string): Promise<ClientCredentials | null>;
}

/** The settings the Workspace applies (config.ts, Settings). */
export interface WorkspaceSettings {
	siteUrl: string;
	runTimeoutMs: number | null;
	folderBytes: number;
	folderEntries: number;
	/** Null: no limit. */
	workspaceBytes: number | null;
	messageAttachments: number;
}

/** Why a delivery or a refresh is logged; never a credential or a provider's body. */
export type Log = (message: string, fields?: { [name: string]: string | number | boolean | null }) => void;
