// The Workspace's ports on the platform: its Conversation objects, its bucket, the OAuth clients from the
// Worker's secrets and D1, and its settings (ports.ts).

import { conversationObject, filesBucket } from "../addressing.ts";
import { clientSecretNames, settings } from "../config.ts";
import type { ConversationApi } from "../conversation/conversation.ts";
import { type EncryptionKeys, oauthClientBinding } from "../lib/encryption.ts";
import { conversationPrefix, deletePrefix } from "../files/objects.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { asPayload } from "./credentials.ts";
import type { ClientCredentials, ConversationClient, OAuthClients, ObjectStore, WorkspaceSettings } from "./ports.ts";

type ConversationCalls = Pick<ConversationApi, "init" | "cancel" | "destroy">;

/** The Conversation objects of the workspace, reached by typed RPC (addressing.ts). */
export function conversationClient(env: Env, workspace: () => WorkspaceRef): ConversationClient {
	// The Conversation class implements these methods (`ConversationApi`); its stub is typed by
	// the class, so the contract is named here.
	const object = (id: string) => conversationObject(env, workspace(), id) as unknown as ConversationCalls;
	return {
		init: (input) => object(input.conversationId).init(input),
		cancel: (conversationId, runId, reason, entryId) => object(conversationId).cancel(runId, reason, entryId),
		// The Conversation deletes its storage and then resets itself, so a call may break after it resolved;
		// one that throws is tried again, and a second call on the emptied object resolves too. Its objects in
		// R2 are deleted here too, after it: the second deletion an hour later finds an emptied object, which
		// no longer knows its prefix, and a write still in flight may have landed since (plan: Files, Deletion).
		destroy: async (conversationId) => {
			await object(conversationId).destroy();
			const ref = workspace();
			await deletePrefix(filesBucket(env, ref), conversationPrefix(ref.id, conversationId));
			return { done: true };
		},
	};
}

export function objectStore(env: Env, workspace: () => WorkspaceRef): ObjectStore {
	return {
		async delete(keys) {
			await filesBucket(env, workspace()).delete(keys);
		},
	};
}

/** The operator's client for an OAuth app: MINERVA_<APP>_CLIENT_ID and _SECRET, both set (an empty id counts as unset). */
export function configuredClient(env: Env, app: string): { clientId: string; clientSecret: string } | null {
	const secrets = env as unknown as { [name: string]: unknown };
	const [idName, secretName] = clientSecretNames(app);
	const clientId = secrets[idName];
	const clientSecret = secrets[secretName];
	if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string") return null;
	return { clientId, clientSecret };
}

/**
 * MINERVA_<APP>_CLIENT_ID and _SECRET (both required; an empty id counts as unset), then the clients
 * registered dynamically, in D1's `oauth_clients`, whose secrets are encrypted as `{"secret": …}`
 *, bound to the row's provider, redirect URI and client id (lib/encryption.ts).
 */
export function oauthClients(env: Env, keys: EncryptionKeys): OAuthClients {
	return {
		configured: (app) => configuredClient(env, app),
		async stored(app, redirectUri): Promise<ClientCredentials | null> {
			const row = await env.DB.prepare(
				"SELECT client_id, secret_ciphertext, secret_key_version, redirect_uri FROM oauth_clients WHERE provider = ? AND redirect_uri = ?",
			)
				.bind(app, redirectUri)
				.first<{ client_id: string; secret_ciphertext: string; secret_key_version: string; redirect_uri: string }>();
			if (row === null) return null;
			const binding = oauthClientBinding(app, row.redirect_uri, row.client_id);
			const secret = asPayload(await keys.decrypt(binding, { ciphertext: row.secret_ciphertext, version: row.secret_key_version })).secret;
			return typeof secret === "string" ? { clientId: row.client_id, clientSecret: secret, redirectUri: row.redirect_uri } : null;
		},
	};
}

export function workspaceSettings(env: Env): WorkspaceSettings {
	const parsed = settings(env);
	return {
		siteUrl: parsed.siteUrl,
		runTimeoutMs: parsed.runTimeoutMs,
		folderBytes: parsed.files.folderBytes,
		folderEntries: parsed.files.folderEntries,
		workspaceBytes: parsed.files.workspaceBytes,
		messageAttachments: parsed.files.messageAttachments,
	};
}
