// Laravel's run stream (docs/plans/credentials-and-facts.md, The route): `GET /stream/v1`, a Laravel conversation's run
// read by the browser from Laravel's pages with a stream token (stream/token.ts) Laravel signed for that run. The token is
// in `Authorization: Bearer` and the cursor in Last-Event-ID, so no id is in the URL. Off (404, as if nothing were here)
// unless the internal API's settings, MINERVA_LARAVEL_URL and MINERVA_STREAM_KEYS are all set.
//
// A token that does not verify is 401 `UNAUTHORIZED`, and nothing says why: the browser asks Laravel for a new one. A
// conversation the recovery index does not bind to the token's organization, or an object that does not hold the run for
// that organization, is 404. The events are relayed as the public stream's are (stream/relay.ts), and the response closes
// hard at the token's `exp`; the browser resumes from its last event with a new token, so a member Laravel removed loses the
// stream within one token's life.
//
// CORS answers Laravel's origin alone, with `Vary: Origin`, on every answer (the 401 included, so the browser can read it),
// and a preflight needs no token. CORS is not the authentication: every GET needs a valid token whatever its origin, and no
// cookie is ever read.

import type { Context } from "hono";
import { conversationObject } from "../addressing.ts";
import { settings } from "../config.ts";
import { errorAnswer, noRoute, serverError, unauthorized } from "../http/errors.ts";
import type { App, AppEnv } from "../http/router.ts";
import { conversationOf } from "../internal/recovery.ts";
import { Relay, openSocket, streamCursor } from "./relay.ts";
import { streamKeys, verifyStreamToken } from "./token.ts";

export const LARAVEL_STREAM_PATH = "/stream/v1";
/** How long a browser may keep a preflight's answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** The route's settings, or null when it is off. A MINERVA_STREAM_KEYS that does not parse turns it off, and is logged. */
function streamSettings(env: Env): { environment: string; origin: string; keys: ReadonlyMap<string, Uint8Array> } | null {
	const parsed = settings(env);
	if (parsed.internal === null || parsed.laravelUrl === null) return null;
	const value = (env as unknown as { MINERVA_STREAM_KEYS?: unknown }).MINERVA_STREAM_KEYS;
	if (typeof value !== "string" || !value.trim()) return null;
	const keys = streamKeys(value);
	if (keys === null) {
		console.error("MINERVA_STREAM_KEYS is malformed: Laravel's run stream is off.");
		return null;
	}
	return { environment: parsed.internal.environment, origin: parsed.laravelUrl, keys };
}

/** The answer with CORS for Laravel's origin, when the request comes from it. */
function withCors(response: Response, request: Request, origin: string): Response {
	let out = response;
	try {
		out.headers.append("Vary", "Origin");
	} catch {
		out = new Response(response.body, response);
		out.headers.append("Vary", "Origin");
	}
	if (request.headers.get("Origin") === origin) out.headers.set("Access-Control-Allow-Origin", origin);
	return out;
}

function preflight(request: Request, origin: string): Response {
	const response = new Response(null, { status: 204 });
	if (request.headers.get("Origin") === origin) {
		response.headers.set("Access-Control-Allow-Methods", "GET");
		response.headers.set("Access-Control-Allow-Headers", "Authorization, Last-Event-ID");
		response.headers.set("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS));
	}
	return response;
}

/** The bearer token, or null when the header is missing or not one. */
function bearer(request: Request): string | null {
	const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get("Authorization") ?? "");
	return match?.[1] ?? null;
}

async function stream(request: Request, env: Env, config: NonNullable<ReturnType<typeof streamSettings>>): Promise<Response> {
	const token = bearer(request);
	const grant = token === null ? null : await verifyStreamToken(token, config.keys, config.environment);
	if (grant === null) return unauthorized();
	const indexed = await conversationOf(env.DB, grant.conversation);
	if (indexed === null || indexed.organization !== grant.organization) return noRoute();
	const stub = conversationObject(env, indexed.workspace, grant.conversation);
	const reader = { organization: grant.organization };
	const after = streamCursor(request);
	const socket = await openSocket(stub, grant.run, reader, after);
	if (socket === null) return noRoute();
	// Nothing to recheck while it runs: the token's end closes it.
	const relay = new Relay(after, (cursor) => openSocket(stub, grant.run, reader, cursor), async () => true, grant.expiresAt);
	relay.attach(socket);
	return new Response(relay.readable, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
	});
}

async function answer(c: Context<AppEnv>): Promise<Response> {
	const config = streamSettings(c.env);
	if (config === null) return noRoute();
	const request = c.req.raw;
	let response: Response;
	try {
		if (c.req.path !== LARAVEL_STREAM_PATH) response = noRoute();
		else if (request.method === "OPTIONS") response = preflight(request, config.origin);
		else if (request.method !== "GET") response = errorAnswer("METHOD_NOT_ALLOWED", "Use GET.", { Allow: "GET, OPTIONS" });
		else response = await stream(request, c.env, config);
	} catch (error) {
		console.error("Unhandled error in Laravel's run stream", error);
		response = serverError();
	}
	return withCors(response, request, config.origin);
}

export function laravelStreamRoutes(app: App): void {
	app.all("/stream/*", answer);
}
