// The OAuth clients connection flows use (web-api 9.1, connectors 11.1), from backend/connections/oauth.py:
// the operator's MINERVA_<APP>_CLIENT_ID and _SECRET, else a client registered dynamically (RFC 7591) at
// the connector's registration URL (Todoist), kept in D1's `oauth_clients` with its secret encrypted, one
// per (app, redirect URI). The Workspace object reads the same two sources to refresh tokens
// (workspace/env.ts `oauthClients`), so the client that issued a connection's tokens is found again there.

import { customFetch, dynamicClientRegistrationRequest } from "oauth4webapi";
import { settings } from "../config.ts";
import type { Connector } from "../contracts/connectors.ts";
import type { WorkspaceRef } from "../contracts/common.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { TOKEN_TIMEOUT_MS, boundedText, type OAuth2, redirectUri } from "../workspace/credentials.ts";
import { configuredClient, oauthClients } from "../workspace/env.ts";
import type { ClientCredentials, OAuthClients } from "../workspace/ports.ts";
import { ConnectionFlowError } from "./flows.ts";
import { oauthClientBinding } from "../lib/encryption.ts";
import { PROVIDER_NETWORK, encryptionKeys } from "./providers.ts";

/** Where the flows' clients come from: the Worker's secrets and D1. The test build adds its fake provider's client (src/faults/). */
export const FLOW_CLIENTS: { of: (env: Env) => OAuthClients } = {
	of: (env) => ({
		configured: (app) => configuredClient(env, app),
		stored: async (app, uri) => oauthClients(env, await encryptionKeys(env)).stored(app, uri),
	}),
};

/** `_oauth`: the connector's OAuth declaration. */
export function oauthOf(connector: Connector): OAuth2 {
	if (connector.auth.type !== "oauth2") throw new ConnectionFlowError(`${connector.name} does not connect through OAuth.`);
	return connector.auth;
}

/** `oauth.available`: whether this instance can connect accounts of the provider. */
export function available(env: Env, connector: Connector): boolean {
	if (connector.auth.type !== "oauth2") return true;
	return Boolean(connector.auth.registrationUrl) || FLOW_CLIENTS.of(env).configured(connector.auth.app) !== null;
}

/** `client_credentials`: the client new authorizations use: the operator's, else a registered one, registering it first if needed. */
export async function clientCredentials(env: Env, workspace: WorkspaceRef, connector: Connector): Promise<ClientCredentials> {
	const oauth = oauthOf(connector);
	const uri = redirectUri(settings(env).siteUrl, connector.slug);
	const clients = FLOW_CLIENTS.of(env);
	const configured = clients.configured(oauth.app);
	if (configured !== null) return { ...configured, redirectUri: uri };
	return (await clients.stored(oauth.app, uri)) ?? (await registerClient(env, workspace, connector, oauth, uri));
}

/** A string field of a JSON object. */
function field(body: Json, name: string): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body) || !Object.hasOwn(body, name)) return null;
	const value = body[name];
	return typeof value === "string" && value ? value : null;
}

/**
 * `_register_client`: registers Minerva at the connector's registration URL, as a confidential client of
 * the authorization-code and refresh-token grants for this redirect URI, and stores it. Of two concurrent
 * registrations the first stored wins and the other is answered with it, as Python's IntegrityError branch.
 * The request is oauth4webapi's; the answer is read as Python reads it (any status below 400, a JSON
 * object with string `client_id` and `client_secret`), and anything else, an unreachable server included,
 * is "Could not register" (Python lets a malformed answer fail the request).
 */
async function registerClient(env: Env, workspace: WorkspaceRef, connector: Connector, oauth: OAuth2, uri: string): Promise<ClientCredentials> {
	if (!oauth.registrationUrl) throw new ConnectionFlowError(`${connector.name} is not configured on this instance.`);
	const failed = (reason: string) => {
		// The status or the kind of failure only: never the body, which holds the client's secret.
		console.warn(`OAuth client registration for ${connector.slug} failed: ${reason}`);
		return new ConnectionFlowError(`Could not register Minerva with ${connector.name}. Try again later.`);
	};
	const endpoint = new URL(oauth.registrationUrl);
	let response: Response;
	let text: string | null;
	try {
		response = await dynamicClientRegistrationRequest(
			{ issuer: endpoint.origin, registration_endpoint: endpoint.href },
			{
				client_name: "Minerva",
				redirect_uris: [uri],
				scope: oauth.scopes.join(oauth.scopeSeparator ?? " "),
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_post",
			},
			{ [customFetch]: PROVIDER_NETWORK.fetch(env, workspace), signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) },
		);
		text = await boundedText(response);
	} catch (error) {
		throw failed(error instanceof Error ? error.name : "no answer");
	}
	if (response.status >= 400) throw failed(`HTTP ${response.status}`);
	let body: Json = null;
	try {
		body = text === null ? null : parseJson(text);
	} catch {
		// Not JSON: refused below.
	}
	const clientId = field(body, "client_id");
	const secret = field(body, "client_secret");
	if (clientId === null || secret === null) throw failed("an answer without a client");
	const sealed = await (await encryptionKeys(env)).encrypt(oauthClientBinding(oauth.app, uri, clientId), { secret });
	const stored = await env.DB.prepare(
		"INSERT INTO oauth_clients (provider, redirect_uri, client_id, secret_ciphertext, secret_key_version, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT (provider, redirect_uri) DO NOTHING",
	)
		.bind(oauth.app, uri, clientId, sealed.ciphertext, sealed.version, Date.now())
		.run();
	if (stored.meta.changes > 0) return { clientId, clientSecret: secret, redirectUri: uri };
	const winner = await FLOW_CLIENTS.of(env).stored(oauth.app, uri);
	if (winner === null) throw new Error(`The OAuth client of ${oauth.app} for ${uri} vanished after a concurrent registration`);
	return winner;
}
