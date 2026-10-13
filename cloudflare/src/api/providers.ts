// The provider calls of the connection settings: the account behind a new API key, and the
// access editor's discover, children and describe. They run here, in the Worker, as the Workspace's API has it
// (workspace/core.ts `WorkspaceApi`): the Workspace lends the caller's credential (`lease` for `settings`, refreshed
// first when it is about to expire), it is decrypted for the one call only, as the Conversation's executor
// does for a run, and it is never stored or returned. A token the provider rejects marks the connection
// Needs reconnecting, unless it got new credentials meanwhile.

import { type Account, type Connector, type CredentialPayload, OperationError, type ProviderClient } from "../gateway/connector.ts";
import { secretOf, unauthorized } from "../gateway/executor.ts";
import { CallIo } from "../gateway/http.ts";
import { HttpError, detail } from "../http/errors.ts";
import { EncryptionKeys, credentialBinding } from "../lib/encryption.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import type { Member } from "./members.ts";

/**
 * The network provider calls go out on: the Worker's `fetch`. The test build (src/faults/) replaces it with
 * its fake provider and nothing else, so a Worker its token-gated driver controls cannot reach a real one;
 * platform tests replace it with a fake of the provider they talk to.
 */
export const PROVIDER_NETWORK: { fetch: (env: Env, workspace: WorkspaceRef) => typeof fetch } = {
	fetch: () => (input, init) => fetch(input, init),
};

let ring: { source: string; keys: Promise<EncryptionKeys> } | null = null;

/** MINERVA_ENCRYPTION_KEYS, parsed once per isolate. */
export function encryptionKeys(env: Env): Promise<EncryptionKeys> {
	const source = env.MINERVA_ENCRYPTION_KEYS;
	if (ring === null || ring.source !== source) ring = { source, keys: EncryptionKeys.parse(source) };
	return ring.keys;
}

async function call<Client extends ProviderClient, T>(
	env: Env,
	workspace: WorkspaceRef,
	connector: Connector<Client>,
	secret: string,
	run: (client: Client) => Promise<T>,
): Promise<T> {
	const io = new CallIo({ fetch: PROVIDER_NETWORK.fetch(env, workspace), now: () => performance.now(), admits: () => true });
	const client = connector.client(secret, io);
	try {
		return await run(client);
	} finally {
		io.close();
		await client.close();
	}
}

/** The account behind a secret (a key, or an OAuth access token); a provider's refusal is its OperationError. */
export function providerAccount(env: Env, workspace: WorkspaceRef, connector: Connector, secret: string): Promise<Account> {
	return call(env, workspace, connector, secret, (client) => connector.account(client));
}

/** The account a key belongs to; a provider's refusal is 422 with its message. */
export async function keyAccount(env: Env, workspace: WorkspaceRef, connector: Connector, key: string): Promise<Account> {
	try {
		return await providerAccount(env, workspace, connector, key);
	} catch (error) {
		if (error instanceof OperationError) throw new HttpError(detail(422, error.message));
		throw error;
	}
}

/**
 * Runs `run` against the provider with the connection's credentials, for the member. A credential the
 * Workspace will not lend (the connection needs reconnecting, a refresh failed) and a provider's failure are
 * 502 with their message; an id refused before anything is sent is 422.
 */
export async function withConnection<T>(env: Env, member: Member, connector: Connector, connectionId: string, run: (client: ProviderClient) => Promise<T>): Promise<T> {
	const lease = await member.object.lease(connectionId, { settings: member.caller });
	if ("refused" in lease) throw new HttpError(detail(502, lease.message));
	const binding = credentialBinding(member.workspace.id, connectionId);
	const payload = (await (await encryptionKeys(env)).decrypt(binding, lease.sealed)) as unknown as CredentialPayload;
	try {
		return await call(env, member.workspace, connector, secretOf(payload), run);
	} catch (error) {
		if (unauthorized(error)) {
			try {
				await member.object.markUnauthorized(connectionId, lease.generation);
			} catch (marking) {
				console.error("Could not mark the connection as needing reconnecting", connectionId, marking);
			}
		}
		// An id the member gave that cannot name anything (segment refuses "..") is their mistake, not the provider's.
		if (error instanceof OperationError) throw new HttpError(detail(error.code === "INVALID_ARGUMENTS" ? 422 : 502, error.message));
		throw error;
	}
}
