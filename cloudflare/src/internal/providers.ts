// Calls to a provider made in the Worker with a credential held for the one call: the settings calls Laravel sends
// (connections.ts).

import type { Account, Connector, ProviderClient } from "../gateway/connector.ts";
import { CallIo } from "../gateway/http.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";

/**
 * The network provider calls go out on: the Worker's `fetch`. The test build (src/faults/) replaces it with
 * its fake provider and nothing else, so a Worker its token-gated driver controls cannot reach a real one;
 * platform tests replace it with a fake of the provider they talk to.
 */
export const PROVIDER_NETWORK: { fetch: (env: Env, workspace: WorkspaceRef) => typeof fetch } = {
	fetch: () => (input, init) => fetch(input, init),
};

/** Runs `run` with a client of the connector holding `secret`, closed after it. */
export async function withProvider<Client extends ProviderClient, T>(
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
	return withProvider(env, workspace, connector, secret, (client) => connector.account(client));
}
