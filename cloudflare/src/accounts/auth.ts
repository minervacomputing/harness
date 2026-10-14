// Better Auth in the Worker (ARCHITECTURE.md: The web API): an instance for each request, its handler at /api/auth/*
// behind our list of the routes the browser may use, and the session helpers our own routes use.

import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { settings } from "../config.ts";
import { UNPARSEABLE, readJson } from "../http/body.ts";
import { HttpError, errorAnswer, noRoute } from "../http/errors.ts";
import type { Json } from "../lib/json.ts";
import { AUTH_BASE_PATH, CODE_SECONDS, authOptions } from "./auth-options.ts";
import { codeEmail, sendEmail } from "./emails.ts";
import { signupAllowed } from "./instance.ts";
import { ensureProvisioned, provision } from "./provision.ts";

/**
 * Better Auth's endpoints the browser may call, as `METHOD /path` under /api/auth. Every other one (more
 * organizations, invitations, admin, impersonation, email changes, account deletion, sign-up with a
 * password) answers 404: Better Auth's `disabledPaths` lists what is closed, so an endpoint an upgrade
 * adds would be open there.
 */
export const BROWSER_ROUTES: ReadonlySet<string> = new Set([
	"POST /sign-in/email",
	"POST /sign-out",
	"GET /get-session",
	"POST /change-password",
	"POST /email-otp/send-verification-otp",
	"POST /sign-in/email-otp",
	"POST /email-otp/request-password-reset",
	"POST /email-otp/reset-password",
	"POST /two-factor/enable",
	"POST /two-factor/disable",
	"POST /two-factor/get-totp-uri",
	"POST /two-factor/verify-totp",
	"POST /two-factor/verify-backup-code",
	"POST /two-factor/generate-backup-codes",
	"GET /organization/list",
	"GET /organization/get-full-organization",
]);

/** The routes where an email code can make a new user, so the only ones that ask whether sign-up is open. */
const SIGN_UP_ROUTES: ReadonlySet<string> = new Set(["/email-otp/send-verification-otp", "/sign-in/email-otp"]);

/** A key of its own for Better Auth, derived from MINERVA_SECRET_KEY. */
function derive(secretKey: string, purpose: string): string {
	return createHmac("sha256", secretKey).update(`minerva/${purpose}`).digest("base64url");
}

function build(env: Env, allowSignUp: boolean) {
	const config = settings(env);
	return betterAuth(
		authOptions({
			siteUrl: config.siteUrl,
			// Not to be changed: it encrypts the two-factor secrets and backup codes already stored.
			secret: derive(env.MINERVA_SECRET_KEY, "better-auth"),
			debug: config.debug,
			database: env.DB,
			allowSignUp,
			sendCode: async (email, code, type) => {
				// The two codes our pages ask for; any other kind Better Auth can make here has no use, and is not sent.
				const kind = type === "sign-in" ? "sign-in" : type === "forget-password" ? "password-reset" : null;
				if (kind) await sendEmail(env, codeEmail(kind, email, code, config.siteUrl, CODE_SECONDS / 60));
			},
			userCreated: async (userId) => {
				// The user exists whatever happens here; a failure leaves provisioning pending (provision.ts).
				await provision(env, userId).catch((error: unknown) => console.error("Provisioning failed; it is retried on the next sign-in", userId, error));
			},
			sessionCreated: (userId) => ensureProvisioned(env, userId),
			passwordReplaced: async (userId) => {
				// Two-factor's pending challenges: `2fa-<random>` rows holding the user's id. Their attempt counters
				// (`2fa-attempts-…`) hold a number, and trusted devices (`trust-device-…`) stay (ARCHITECTURE.md: The web API, Accepted trade-offs).
				await env.DB.prepare(`DELETE FROM verification WHERE identifier LIKE '2fa-%' AND value = ?`).bind(userId).run();
			},
		}),
	);
}

export type Auth = ReturnType<typeof build>;

// An instance for each call (a request makes one), never one for the isolate: Better Auth's instance
// holds locks that requests sharing it would wait on. Kysely runs a SQLite dialect's queries one at a
// time under one lock, and codes are consumed under a lock for each address. A request cancelled while
// it held one (its client left mid-query) never released it, and every later request of the isolate
// waited until it timed out. Building one takes well under a millisecond. Each caller builds it just
// before using it, so that no instance is left starting (its adapter's imports) for a request that
// has already answered.
//
// Sign-up is off unless asked for: only handleAuth asks, for a browser's email code while it is open.
export function getAuth(env: Env, { allowSignUp = false }: { allowSignUp?: boolean } = {}): Auth {
	return build(env, allowSignUp);
}

/**
 * Better Auth's routes the browser may use (BROWSER_ROUTES); the rest answer 404. On the two email-code
 * routes, a new address may sign up while sign-up is open, or with the setup key before setup (instance.ts).
 *
 * A body is read with the API's JSON reader (http/body.ts `readJson`: `application/json` only, so no
 * form reaches Better Auth) before Better Auth sees it, and passed on re-serialized: Better Auth parses
 * with the runtime's JSON parser, which a key written with escapes can put in a state that misreads later
 * keys in the isolate (ARCHITECTURE.md: Spike results, JSON keys). Its bodies' keys are plain names, so a key that
 * would need an escape is refused, and the text Better Auth parses has none.
 */
export async function handleAuth(env: Env, request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	const route = path.slice(AUTH_BASE_PATH.length);
	if (!path.startsWith(`${AUTH_BASE_PATH}/`) || !BROWSER_ROUTES.has(`${request.method} ${route}`)) return noRoute();
	const headers = new Headers(request.headers);
	let body: string | null = null;
	if (request.body) {
		const read = await readJson(request);
		if (!read.ok) return errorAnswer(read.refusal.code, read.refusal.detail);
		headers.set("Content-Type", "application/json");
		if (read.value !== undefined) body = plainJson(read.value);
	}
	const allowSignUp = SIGN_UP_ROUTES.has(route) && (await signupAllowed(env, request.headers));
	return getAuth(env, { allowSignUp }).handler(new Request(request.url, { method: request.method, headers, body }));
}

const PLAIN_KEY = /^[A-Za-z0-9_.:-]*$/;

function plainJson(value: Json): string {
	const check = (node: Json): void => {
		if (Array.isArray(node)) node.forEach(check);
		else if (node !== null && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				if (!PLAIN_KEY.test(key)) throw new HttpError(errorAnswer(UNPARSEABLE.code, UNPARSEABLE.detail));
				check(child);
			}
		}
	};
	check(value);
	return JSON.stringify(value);
}

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	emailVerified: boolean;
	role: string | null;
}

export interface CurrentSession {
	/** Null without a valid session. */
	user: SessionUser | null;
	sessionId: string | null;
	/** Cookies Better Auth set while reading the session (a refresh, or clearing a stale cookie). */
	headers: Headers;
}

/** The request's session for our own routes, read from D1 on every request (no cookie cache). */
export async function currentSession(env: Env, request: Request): Promise<CurrentSession> {
	const { headers, response } = await getAuth(env).api.getSession({ headers: request.headers, returnHeaders: true });
	if (!response) return { user: null, sessionId: null, headers };
	const { user, session } = response;
	return {
		user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified, role: user.role ?? null },
		sessionId: session.id,
		headers,
	};
}

/** Adds the cookies Better Auth set while reading the session to our route's answer. */
export function withSessionCookies(response: Response, session: CurrentSession): Response {
	const cookies = session.headers.getSetCookie();
	if (cookies.length === 0) return response;
	const out = new Response(response.body, response);
	for (const cookie of cookies) out.headers.append("Set-Cookie", cookie);
	return out;
}
