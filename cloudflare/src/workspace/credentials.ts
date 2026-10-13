// Stored credentials and their refresh. The Workspace keeps them encrypted; these helpers read a
// decrypted payload, decide whether it needs a refresh, and run the generic OAuth2 refresh a connector's
// `auth` declaration describes, through an injected `fetch`. Storing the result, the single flight and the
// generation fence are the Workspace's (core.ts).

import type { Auth, Connector } from "../contracts/connectors.ts";
import { base64, utf8 } from "../lib/bytes.ts";
import { type Json, type JsonObject, parseJson, truthy } from "../lib/json.ts";
import type { ClientCredentials, Log, OAuthClients } from "./ports.ts";

/** Refresh OAuth access tokens with less than this left. */
export const REFRESH_MARGIN_SECONDS = 120;
/** The timeout for token requests. */
export const TOKEN_TIMEOUT_MS = 20_000;
/** A token response larger than this is not a token response. */
export const TOKEN_BODY_LIMIT = 1 << 20;
/** Legacy Todoist tokens report a 10-year expiry; anything beyond a year is treated as non-expiring. */
export const MAX_EXPIRES_IN = 365 * 24 * 3600;

export const EXPIRED = "The connection expired. Reconnect it in Minerva.";

export type OAuth2 = Extract<Auth, { type: "oauth2" }>;

function own(payload: JsonObject, key: string): Json | undefined {
	return Object.hasOwn(payload, key) ? payload[key] : undefined;
}

/** A decrypted payload: always an object; anything else is unreadable. */
export function asPayload(value: Json): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("A credential payload is a JSON object.");
	return value;
}

export type CredentialKind = "oauth2" | "api_key" | "builtin";

/** Payloads written before `kind` was recorded are OAuth. */
export function kindOf(payload: JsonObject): CredentialKind {
	const kind = own(payload, "kind");
	return kind === "api_key" || kind === "builtin" ? kind : "oauth2";
}

/** The scopes the credentials carry, sorted and unique; null when unknown (API keys, built-ins, old rows). */
export function scopesOf(payload: JsonObject): string[] | null {
	if (kindOf(payload) !== "oauth2") return null;
	const scopes = own(payload, "scopes");
	if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return null;
	return [...new Set(scopes as string[])].sort();
}

/** Epoch seconds, or null when the token does not expire. */
export function expiresAtOf(payload: JsonObject): number | null {
	const value = own(payload, "expires_at");
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `_needs_refresh`: `expires_at` is set and less than 120 s away. */
export function needsRefresh(expiresAt: number | null, nowMs: number): boolean {
	return expiresAt !== null && expiresAt - nowMs / 1000 < REFRESH_MARGIN_SECONDS;
}

/**
 * `_scopes(body)`: `scope`, else `scopes` (HubSpot). A list of strings is joined with spaces; a string is
 * split on commas (GitHub) and whitespace, then sorted and de-duplicated; anything else is unknown (connectors
 * 11.5). As `body.get("scope", …)` does, a `scope` present with null is null, not `scopes`.
 */
export function parseScopes(body: JsonObject): string[] | null {
	let scope = Object.hasOwn(body, "scope") ? body.scope : own(body, "scopes");
	if (Array.isArray(scope) && scope.every((item) => typeof item === "string")) scope = scope.join(" ");
	if (typeof scope !== "string") return null;
	return [...new Set(scope.replaceAll(",", " ").split(/\s+/).filter(Boolean))].sort();
}

/** `_token_body`: a JSON object without an `error` key and with a string `access_token`, else null. */
export function tokenBody(text: string): JsonObject | null {
	let body: Json;
	try {
		body = parseJson(text);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	if (Object.hasOwn(body, "error") || typeof own(body, "access_token") !== "string") return null;
	return body;
}

/** `_json_field`: a string field of a JSON object body, else null. */
function jsonField(text: string, field: string): string | null {
	try {
		const body = parseJson(text);
		if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
		const value = own(body, field);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

/**
 * The stored token payload. `expires_at` is set only from a JSON number `expires_in` that is an integer
 * under a year (`3600.0` is one); a string or a boolean sets none.
 */
export function tokenPayload(body: JsonObject, nowMs: number): JsonObject {
	const refresh = own(body, "refresh_token");
	const payload: JsonObject = {
		kind: "oauth2",
		access_token: body.access_token as string,
		refresh_token: refresh === undefined ? null : refresh,
		scopes: parseScopes(body),
	};
	const expiresIn = own(body, "expires_in");
	if (typeof expiresIn === "number" && Number.isInteger(expiresIn) && expiresIn < MAX_EXPIRES_IN) {
		payload.expires_at = Math.floor(nowMs / 1000) + expiresIn;
	}
	return payload;
}

/**
 * Providers may omit the refresh token when an account reconnects. The previous one
 * is kept only if the same recorded client issued both, and with it the endpoint that issued it, where it
 * is only ever sent.
 */
export function keepRefreshToken(previous: JsonObject, tokens: JsonObject): JsonObject {
	if (own(tokens, "kind") !== "oauth2" || truthy(own(tokens, "refresh_token")) || !truthy(own(previous, "refresh_token"))) return tokens;
	const issuer = own(previous, "client_id") ?? null;
	if (issuer === null || issuer !== (own(tokens, "client_id") ?? null)) return tokens;
	return { ...tokens, refresh_token: previous.refresh_token as Json, token_url: own(previous, "token_url") ?? null };
}

export function redirectUri(siteUrl: string, slug: string): string {
	return `${siteUrl}/api/oauth/${slug}/callback`;
}

/**
 * `issuing_client`: the client that issued a connection's tokens, which alone can refresh them. Tokens
 * saved before the issuer was recorded (no `client_id`) are tried with the current client.
 */
export async function issuingClient(connector: Connector, oauth: OAuth2, clientId: Json | undefined, clients: OAuthClients, siteUrl: string): Promise<ClientCredentials | null> {
	const issuer = clientId ?? null;
	const uri = redirectUri(siteUrl, connector.slug);
	const configured = clients.configured(oauth.app);
	if (configured !== null && (issuer === null || issuer === configured.clientId)) return { ...configured, redirectUri: uri };
	const stored = await clients.stored(oauth.app, uri);
	if (stored !== null && (issuer === null || issuer === stored.clientId)) return stored;
	return null;
}

/** GitHub answers token requests form-encoded unless asked for JSON. */
const TOKEN_HEADERS = { Accept: "application/json" };

/**
 * `_token_request`: POST to the token endpoint with the client authenticated as the provider expects:
 * `basic` as HTTP Basic, otherwise `client_id` and `client_secret` first in the body; JSON or a form. Never
 * redirected: a refresh token goes only to the endpoint that issued it.
 */
export function tokenRequest(oauth: OAuth2, creds: ClientCredentials, fields: [string, string][]): RequestInit {
	const headers: { [name: string]: string } = { ...TOKEN_HEADERS };
	let all = fields;
	if (oauth.clientAuth === "basic") headers.Authorization = `Basic ${base64(utf8(`${creds.clientId}:${creds.clientSecret}`))}`;
	else all = [["client_id", creds.clientId], ["client_secret", creds.clientSecret], ...fields];
	let body: string;
	if (oauth.jsonBody) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(Object.fromEntries(all));
	} else {
		headers["Content-Type"] = "application/x-www-form-urlencoded";
		body = new URLSearchParams(all).toString();
	}
	return { method: "POST", headers, body, redirect: "manual" };
}

export type RefreshResult =
	/** New tokens to store as the next generation. */
	| { kind: "refreshed"; payload: JsonObject }
	/** Null: the grant is no longer valid, so the connection needs reconnecting. */
	| { kind: "invalid" }
	/**
	 * PROVIDER_UNAVAILABLE, the connection unchanged. `reached` false: the request may or may not have
	 * reached the provider (a transport error), so a rotated refresh token may have been spent.
	 */
	| { kind: "unavailable"; message: string; reached: boolean };

/** A refresh ready to send: the Workspace records `refreshing` first, then calls `send`. */
export type RefreshPlan = { kind: "invalid" } | { kind: "send"; tokenUrl: string; send: () => Promise<RefreshResult> };

const DEAD_REFRESH_TOKENS: ReadonlySet<string> = new Set(["bad_refresh_token", "invalid_grant", "invalid_refresh_token"]);

/** The body as text, up to TOKEN_BODY_LIMIT bytes; null beyond it. */
export async function boundedText(response: Response): Promise<string | null> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > TOKEN_BODY_LIMIT) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

export interface RefreshDeps {
	clients: OAuthClients;
	siteUrl: string;
	fetch: typeof fetch;
	now(): number;
	log: Log;
}

/**
 * `_refresh(connection, tokens)` up to the request: no refresh token, a connector that is not OAuth, or an
 * issuer that is no longer configured mean the grant is gone; otherwise the request to send (connectors
 * 9.3). `send` never throws: a transport error is `unavailable` with `reached` false.
 */
export async function planRefresh(connector: Connector, tokens: JsonObject, deps: RefreshDeps, connectionId: string): Promise<RefreshPlan> {
	const refreshToken = own(tokens, "refresh_token");
	if (!truthy(refreshToken) || typeof refreshToken !== "string") return { kind: "invalid" };
	const oauth = connector.auth;
	if (oauth.type !== "oauth2") return { kind: "invalid" };
	const creds = await issuingClient(connector, oauth, own(tokens, "client_id"), deps.clients, deps.siteUrl);
	if (creds === null) {
		deps.log("The OAuth client that issued a connection is no longer configured", { connection: connectionId });
		return { kind: "invalid" };
	}
	// The endpoint that issued the tokens: a connector that later moves its endpoint keeps working for
	// connections made before, and a changed declaration cannot redirect their refresh tokens.
	const stored = own(tokens, "token_url");
	const tokenUrl = typeof stored === "string" && stored ? stored : oauth.tokenUrl;
	const name = connector.name;
	const cannotRefresh: RefreshResult = { kind: "unavailable", message: `${name} could not refresh the connection.`, reached: true };
	const send = async (): Promise<RefreshResult> => {
		let response: Response;
		let text: string | null;
		try {
			response = await deps.fetch(tokenUrl, {
				...tokenRequest(oauth, creds, [
					["grant_type", "refresh_token"],
					["refresh_token", refreshToken],
				]),
				signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
			});
			text = await boundedText(response);
		} catch {
			return { kind: "unavailable", message: `${name} could not be reached.`, reached: false };
		}
		if (text === null) return cannotRefresh;
		if (response.status === 400 || response.status === 401) return { kind: "invalid" };
		// Atlassian refuses a refresh token that expired or was revoked with 403.
		if (response.status === 403 && jsonField(text, "error") === "invalid_grant") return { kind: "invalid" };
		if (response.status >= 400) return cannotRefresh;
		const body = tokenBody(text);
		if (body === null) {
			const error = jsonField(text, "error");
			// GitHub's and Slack's refusals of a refresh token that expired or was revoked; other refusals (a
			// misconfigured client) are the operator's to fix and leave the connection as it is.
			if (error !== null && DEAD_REFRESH_TOKENS.has(error)) return { kind: "invalid" };
			deps.log("Refreshing a connection failed", { connection: connectionId, error: error ?? "unexpected response" });
			return cannotRefresh;
		}
		const refreshed = tokenPayload(body, deps.now());
		// Providers that do not rotate refresh tokens (Google) omit them from the response. A non-string
		// refresh token is taken as omitted.
		const rotated = refreshed.refresh_token;
		refreshed.refresh_token = typeof rotated === "string" && rotated ? rotated : refreshToken;
		// A refresh that does not mention scopes keeps the ones granted before.
		if (refreshed.scopes === null) refreshed.scopes = own(tokens, "scopes") ?? null;
		refreshed.client_id = creds.clientId;
		refreshed.token_url = tokenUrl;
		return { kind: "refreshed", payload: refreshed };
	};
	return { kind: "send", tokenUrl, send };
}
