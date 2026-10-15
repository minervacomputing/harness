// The OAuth connection flow: `authorize` for a
// new connection and `reconnect` for an existing one start it (`CONNECTION_FLOWS.start`, answered as
// `{url}`), and the provider sends the browser back to `GET /api/oauth/{provider}/callback`, which redeems
// the code with the client that started the flow and saves the connection through the Workspace object.
//
// The flow is a row of D1's `oauth_flows` keyed by the Better Auth session that started it: one per
// session (a newer authorization replaces it), valid 600 s, with its `state`, PKCE verifier, provider,
// workspace, the connection a reconnect renews and the client it was sent to. The callback compares the
// state in constant time, then deletes the row on that state with `DELETE … RETURNING` before anything
// else, so it is used once even if a later step fails, and of concurrent callbacks exactly one gets it.
// A callback with another state, or for another provider, leaves the flow alone (so a forged or stale
// callback cannot cancel the user's attempt); an expired one is removed. A callback from another session (another user, another browser) finds no flow or another
// flow, whose state does not match. State and
// verifier come from oauth4webapi (32 random bytes each, S256 challenge); the token request and the
// reading of its answer are the ones the Workspace's refresh uses (workspace/credentials.ts), which keep
// what each provider expects (form or JSON, Basic or body credentials, GitHub's errors in a 200).

import { calculatePKCECodeChallenge, generateRandomCodeVerifier, generateRandomState } from "oauth4webapi";
import { type CurrentSession, currentSession, withSessionCookies } from "../accounts/auth.ts";
import { settings } from "../config.ts";
import { connectorRegistry } from "../connectors/index.ts";
import { type Connector, type CredentialPayload, OperationError } from "../gateway/connector.ts";
import { HttpError, errorAnswer } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { PROVIDER_NETWORK, providerAccount } from "../internal/providers.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { TOKEN_TIMEOUT_MS, answerJson, boundedBody, issuingClient, tokenBody, tokenPayload, tokenRequest } from "../workspace/credentials.ts";
import { isAdmin } from "../workspace/out.ts";
import { type Member, member, param } from "./members.ts";
import { FLOW_CLIENTS, clientCredentials, oauthOf } from "./oauth-clients.ts";

/** A user-facing failure while connecting an account: 503 when starting, `?error=` on the callback. */
export class ConnectionFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionFlowError";
	}
}

export interface FlowStart {
	env: Env;
	member: Member;
	connector: Connector;
	/** The connection a reconnect renews, which the flow must end with the same provider account. */
	connectionId: string | null;
	/** The scopes to ask for; null for the connector's own (a new connection). */
	scopes: string[] | null;
}

/** How long a flow may take, from the authorization to the callback (`popFlow`). */
export const FLOW_MS = 600_000;

export const EXPIRED_FLOW = "This connection attempt expired or did not start here. Please try again.";

/** Where the provider sends the browser back; `provider` is a slug. */
export const CALLBACK_ROUTE = "/api/oauth/:provider{[-a-zA-Z0-9_]+}/callback";

export const CONNECTION_FLOWS: { start(flow: FlowStart): Promise<string> } = {
	/** Stores the session's flow and answers where the user grants access. */
	async start({ env, member: m, connector, connectionId, scopes }) {
		const oauth = oauthOf(connector);
		const creds = await clientCredentials(env, m.workspace, connector);
		const state = generateRandomState();
		const verifier = generateRandomCodeVerifier();
		const challenge = await calculatePKCECodeChallenge(verifier);
		// The renewed connection's account, for a provider that preselects it (Google).
		const hint = connectionId !== null && oauth.loginHint ? ((await m.object.connectionAccount(connectionId))?.accountId ?? null) : null;
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO oauth_flows (session_id, state, verifier, provider, workspace_id, connection_id, client_id, issued_at, expires_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, verifier = excluded.verifier, " +
				"provider = excluded.provider, workspace_id = excluded.workspace_id, connection_id = excluded.connection_id, " +
				"client_id = excluded.client_id, issued_at = excluded.issued_at, expires_at = excluded.expires_at",
		)
			.bind(m.sessionId, state, verifier, connector.slug, m.workspace.id, connectionId, creds.clientId, now, now + FLOW_MS)
			.run();
		const params: [string, string][] = [
			...(oauth.authorizeParams ?? []),
			["client_id", creds.clientId],
			["state", state],
			["response_type", "code"],
			["redirect_uri", creds.redirectUri],
		];
		// Providers without scopes (Notion) let the user choose what to share on their own consent screen.
		const scope = (scopes?.length ? scopes : oauth.scopes).join(oauth.scopeSeparator ?? " ");
		if (scope) params.push(["scope", scope]);
		if (oauth.pkce ?? true) params.push(["code_challenge", challenge], ["code_challenge_method", "S256"]);
		if (hint !== null) params.push(["login_hint", hint]);
		return `${oauth.authorizeUrl}?${new URLSearchParams(params)}`;
	},
};

interface FlowRow {
	state: string;
	verifier: string;
	provider: string;
	workspace_id: string;
	connection_id: string | null;
	client_id: string;
	issued_at: number;
}

const FLOW_COLUMNS = "state, verifier, provider, workspace_id, connection_id, client_id, issued_at";

/** The session's flow for this provider and state, deleted whatever follows; null if there is none or it expired. */
async function popFlow(db: D1Database, sessionId: string, provider: string, state: string | null, now: number): Promise<FlowRow | null> {
	const flow = await db.prepare(`SELECT ${FLOW_COLUMNS} FROM oauth_flows WHERE session_id = ?`).bind(sessionId).first<FlowRow>();
	if (flow === null) return null;
	const take = () => db.prepare(`DELETE FROM oauth_flows WHERE session_id = ? AND state = ? RETURNING ${FLOW_COLUMNS}`).bind(sessionId, flow.state).first<FlowRow>();
	if (now - flow.issued_at > FLOW_MS) {
		await take();
		return null;
	}
	if (!state || flow.provider !== provider || !timingSafeEqual(flow.state, state)) return null;
	// Null when a concurrent callback took it first, or a newer authorization replaced it.
	return take();
}

/** `exchange_code`: tokens for the code, redeemed by the client the flow sent the user to. */
async function exchangeCode(env: Env, workspace: WorkspaceRef, connector: Connector, code: string, flow: FlowRow): Promise<CredentialPayload> {
	const oauth = oauthOf(connector);
	const creds = await issuingClient(connector, oauth, flow.client_id, FLOW_CLIENTS.of(env), settings(env).siteUrl);
	if (creds === null) throw new ConnectionFlowError(`${connector.name} was reconfigured during the authorization. Please try again.`);
	const fields: [string, string][] = [
		["code", code],
		["redirect_uri", creds.redirectUri],
		["grant_type", "authorization_code"],
	];
	if (oauth.pkce ?? true) fields.push(["code_verifier", flow.verifier]);
	const refused = (reason: string) => {
		// The status only: the answer may hold tokens.
		console.warn(`OAuth code exchange for ${connector.slug} failed: ${reason}`);
		return new ConnectionFlowError(`${connector.name} did not accept the authorization. Please try again.`);
	};
	let response: Response;
	let bytes: Uint8Array | null;
	try {
		response = await PROVIDER_NETWORK.fetch(env, workspace)(oauth.tokenUrl, { ...tokenRequest(oauth, creds, fields), signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
		bytes = await boundedBody(response);
	} catch (error) {
		throw refused(error instanceof Error ? error.name : "no answer");
	}
	const body = response.status >= 400 || bytes === null ? null : tokenBody(answerJson(bytes));
	if (body === null) throw refused(`HTTP ${response.status}`);
	return { ...tokenPayload(body, Date.now()), client_id: creds.clientId, token_url: oauth.tokenUrl } as unknown as CredentialPayload;
}

/** A 302 to `{SITE_URL}{path}`, with the parameters form-encoded (spaces as `+`). */
function redirect(siteUrl: string, path: string, params: [string, string][] = []): Response {
	const query = params.length ? `?${new URLSearchParams(params)}` : "";
	return new Response(null, { status: 302, headers: { Location: `${siteUrl}${path}${query}`, "Cache-Control": "no-store" } });
}

/** The value of a query parameter given more than once is its last. */
function lastParam(query: URLSearchParams, name: string): string | null {
	return query.getAll(name).at(-1) ?? null;
}

/** The OAuth callback; every exit is a redirect into the app. */
async function callback(env: Env, request: Request, provider: string, session: CurrentSession): Promise<Response> {
	const site = settings(env).siteUrl;
	if (!session.user || !session.sessionId) return redirect(site, "/login");
	const connector = (await connectorRegistry()).find(provider);
	if (connector === null) return redirect(site, "/");
	const query = new URL(request.url).searchParams;
	const flow = await popFlow(env.DB, session.sessionId, provider, lastParam(query, "state"), Date.now());
	if (flow === null) return redirect(site, "/", [["error", EXPIRED_FLOW]]);
	const page = `/w/${flow.workspace_id}/connections`;
	let m: Member;
	try {
		m = await member(env, session, flow.workspace_id);
	} catch (error) {
		if (error instanceof HttpError) return redirect(site, "/");
		throw error;
	}
	const code = lastParam(query, "code");
	if (lastParam(query, "error") || !code) return redirect(site, page, [["error", `${connector.name} was not connected.`]]);
	try {
		if (flow.connection_id !== null) {
			const existing = await m.object.connectionAccount(flow.connection_id);
			if (existing !== null && existing.ownerId !== null && existing.ownerId !== m.caller.userId) throw new ConnectionFlowError("This connection belongs to someone else.");
			if (existing !== null && existing.ownerId === null && !isAdmin(m.caller)) throw new ConnectionFlowError("Only workspace admins can reconnect shared connections.");
		}
		const tokens = await exchangeCode(env, m.workspace, connector, code, flow);
		let account: { id: string; label: string };
		try {
			account = await providerAccount(env, m.workspace, connector, tokens.kind === "oauth2" ? tokens.access_token : "");
		} catch (error) {
			if (error instanceof OperationError) throw new ConnectionFlowError(error.message);
			throw error;
		}
		const saved = await m.object.saveConnection(m.caller, { provider: connector.slug, account, credentials: tokens, connectionId: flow.connection_id });
		if (!saved.ok) throw new ConnectionFlowError(saved.refusal.detail);
		return redirect(site, page, [["connected", saved.value.id]]);
	} catch (error) {
		if (error instanceof ConnectionFlowError) return redirect(site, page, [["error", error.message]]);
		throw error;
	}
}

export function flowRoutes(app: App): void {
	app.get(CALLBACK_ROUTE, async (c) => {
		const session = await currentSession(c.env, c.req.raw);
		return withSessionCookies(await callback(c.env, c.req.raw, param(c, "provider"), session), session);
	});
	// GET only, after the CSRF check the router makes on unsafe methods.
	app.on(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], CALLBACK_ROUTE, () => errorAnswer("METHOD_NOT_ALLOWED", "Use GET.", { Allow: "GET" }));
}
