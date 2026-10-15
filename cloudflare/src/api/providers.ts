// The provider calls of the connection settings: the account behind a new API key, and the
// access editor's discover, children and describe. They run here, in the Worker, as the Workspace's API has it
// (workspace/core.ts `WorkspaceApi`): the Workspace lends the caller's credential (`lease` for `settings`, refreshed
// first when it is about to expire), it is decrypted for the one call only, as the Conversation's executor
// does for a run, and it is never stored or returned. A token the provider rejects marks the connection
// Needs reconnecting, unless it got new credentials meanwhile.

import { type Account, type Connector, type CredentialPayload, OperationError, type ProviderClient } from "../gateway/connector.ts";
import { secretOf, unauthorized } from "../gateway/executor.ts";
import { providerAccount, withProvider } from "../internal/providers.ts";
import { EncryptionKeys, credentialBinding } from "../lib/encryption.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import type { Member } from "./members.ts";
import { refusal } from "./procedures.ts";

let ring: { source: string; keys: Promise<EncryptionKeys> } | null = null;

/** MINERVA_ENCRYPTION_KEYS, parsed once per isolate. */
export function encryptionKeys(env: Env): Promise<EncryptionKeys> {
	const source = env.MINERVA_ENCRYPTION_KEYS;
	if (ring === null || ring.source !== source) ring = { source, keys: EncryptionKeys.parse(source) };
	return ring.keys;
}

/** Failures of what the member sent (an id that cannot name anything, a page token that is not ours), not of the provider. */
const CALLER_MISTAKES: Partial<Record<string, "INVALID_RESOURCE_ID" | "INVALID_CURSOR">> = { INVALID_ARGUMENTS: "INVALID_RESOURCE_ID", INVALID_CURSOR: "INVALID_CURSOR" };

/** A provider that could not answer, rather than one that answered no. */
const PROVIDER_DOWN: ReadonlySet<string> = new Set(["PROVIDER_UNAVAILABLE", "PROVIDER_FAILED", "PROVIDER_RATE_LIMITED", "TIMED_OUT"]);

/** The account a key belongs to; a provider's refusal of the key is 422, its failure 502, with its message. */
export async function keyAccount(env: Env, workspace: WorkspaceRef, connector: Connector, key: string): Promise<Account> {
	try {
		return await providerAccount(env, workspace, connector, key);
	} catch (error) {
		if (error instanceof OperationError) throw refusal(PROVIDER_DOWN.has(error.code) ? "PROVIDER_FAILED" : "KEY_REFUSED", error.message);
		throw error;
	}
}

/**
 * Runs `run` against the provider with the connection's credentials, for the member. A credential the
 * Workspace will not lend (the connection needs reconnecting, a refresh failed) and a provider's failure are
 * 502 with their message, a refused credential 502 `RECONNECT_NEEDED`; an id or page token refused before anything is
 * sent is 422.
 */
export async function withConnection<T>(env: Env, member: Member, connector: Connector, connectionId: string, run: (client: ProviderClient) => Promise<T>): Promise<T> {
	const lease = await member.object.lease(connectionId, { settings: member.caller });
	if ("refused" in lease) throw refusal(lease.refused === "CONNECTION_UNAUTHORIZED" ? "RECONNECT_NEEDED" : "PROVIDER_FAILED", lease.message);
	const binding = credentialBinding(member.workspace.id, connectionId);
	const payload = (await (await encryptionKeys(env)).decrypt(binding, lease.sealed)) as unknown as CredentialPayload;
	try {
		return await withProvider(env, member.workspace, connector, secretOf(payload), run);
	} catch (error) {
		if (unauthorized(error)) {
			try {
				await member.object.markUnauthorized(connectionId, lease.generation);
			} catch (marking) {
				console.error("Could not mark the connection as needing reconnecting", connectionId, marking);
			}
		}
		if (error instanceof OperationError) {
			const code = unauthorized(error) ? "RECONNECT_NEEDED" : (CALLER_MISTAKES[error.code] ?? "PROVIDER_FAILED");
			throw refusal(code, error.message);
		}
		throw error;
	}
}
