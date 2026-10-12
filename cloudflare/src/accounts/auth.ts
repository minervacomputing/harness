// Better Auth in the Worker (plan: The web API): an instance for each request, with its security
// policy (policy.ts), its handler at /api/auth/*, and the session helper our own routes use.

import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { settings } from "../config.ts";
import { readBytes } from "../http/body.ts";
import { HttpError, notFound, unparseableBody } from "../http/errors.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { AUTH_BASE_PATH, type OtpType, authOptions } from "./auth-options.ts";
import { type EmailKind, render, sendEmail } from "./emails.ts";
import { signupAllowed } from "./instance.ts";
import { BROWSER_ROUTES, Policy, withoutTrustedDevice } from "./policy.ts";
import { ensureProvisioned, provision } from "./provision.ts";
import { RateLimits } from "./rate-limits.ts";
import { runInScope } from "./scope.ts";

/** A key of its own for Better Auth, derived from MINERVA_SECRET_KEY. */
function derive(secretKey: string, purpose: string): string {
	return createHmac("sha256", secretKey).update(`minerva/${purpose}`).digest("base64url");
}

const OTP_EMAILS: Record<OtpType, EmailKind> = {
	"email-verification": "verify_signup",
	"sign-in": "login_code",
	"forget-password": "password_reset_code",
	"change-email": "verify_signup",
};

function policyFor(env: Env): Policy {
	const config = settings(env);
	return new Policy({
		db: env.DB,
		limits: new RateLimits(env.DB, derive(env.MINERVA_SECRET_KEY, "rate-limits")),
		stampKey: derive(env.MINERVA_SECRET_KEY, "session-stamp"),
		signupAllowed: (headers) => signupAllowed(env, headers),
		sendAlreadyExists: (email) => sendEmail(env, render("already_exists", email, config.siteUrl)),
	});
}

function build(env: Env, policy: Policy) {
	const config = settings(env);
	const codeKey = derive(env.MINERVA_SECRET_KEY, "email-code");
	return betterAuth(
		authOptions({
			siteUrl: config.siteUrl,
			secret: derive(env.MINERVA_SECRET_KEY, "better-auth"),
			debug: config.debug,
			database: env.DB,
			hashCode: async (code) => createHmac("sha256", codeKey).update(code).digest("hex"),
			sendCode: (email, code, type) => sendEmail(env, render(OTP_EMAILS[type], email, config.siteUrl, code)),
			userCreated: async (userId) => {
				// The user exists whatever happens here; a failure leaves provisioning pending (provision.ts).
				await provision(env, userId).catch((error: unknown) => console.error("Provisioning failed; it is retried on the next sign-in", userId, error));
			},
			sessionCreated: (userId) => ensureProvisioned(env, userId),
			// Conditional on the old hash, so a password changed meanwhile is never overwritten. The user's
			// sessions move to the new hash's stamp in the same batch, so a rehash signs nobody out.
			rehashed: async (old, hash) => {
				const owner = await env.DB.prepare(
					`SELECT a."userId" AS user_id, u.email FROM account a JOIN "user" u ON u.id = a."userId" WHERE a."providerId" = 'credential' AND a.password = ?`,
				)
					.bind(old)
					.first<{ user_id: string; email: string }>();
				if (!owner) return false;
				const [updated] = await env.DB.batch([
					env.DB.prepare(`UPDATE account SET password = ?, "updatedAt" = ? WHERE "providerId" = 'credential' AND password = ?`).bind(hash, new Date().toISOString(), old),
					env.DB.prepare(
						`UPDATE "session" SET "credentialStamp" = ? WHERE "userId" = ? AND "credentialStamp" = ? ` +
							`AND EXISTS (SELECT 1 FROM account WHERE "userId" = ? AND "providerId" = 'credential' AND password = ?)`,
					).bind(policy.stamp(owner.user_id, owner.email, hash), owner.user_id, policy.stamp(owner.user_id, owner.email, old), owner.user_id, hash),
				]);
				return (updated?.meta.changes ?? 0) > 0;
			},
			policy,
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
export function getAuth(env: Env, policy: Policy = policyFor(env)): Auth {
	return build(env, policy);
}

/**
 * Better Auth's own routes, those the browser may use (policy.ts); the rest answer 404. Trusted-device
 * cookies are dropped and sessions whose credentials changed are deleted before Better Auth reads them,
 * and the request runs in a scope of its own for the policy's hooks.
 *
 * The body is read under the API's cap before Better Auth sees it, and a JSON body is read with
 * `parseJson` and passed on re-serialized: Better Auth parses any `…json` media type with the runtime's
 * JSON parser, which a key written with escapes can put in a state that misreads later keys in the
 * isolate (plan: Spike results, JSON keys). Its bodies' keys are plain names, so a key that would need an
 * escape is refused, and the text Better Auth parses has none. Every content type naming JSON is treated
 * so and passed on as `application/json`; other bodies (forms) are not parsed as JSON.
 */
export async function handleAuth(env: Env, request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (!path.startsWith(`${AUTH_BASE_PATH}/`) || !BROWSER_ROUTES.has(`${request.method} ${path.slice(AUTH_BASE_PATH.length)}`)) return notFound();
	const headers = new Headers(request.headers);
	const cookies = withoutTrustedDevice(headers.get("Cookie"));
	if (cookies) headers.set("Cookie", cookies);
	else headers.delete("Cookie");
	let body: Uint8Array | string | null = null;
	if (request.body) {
		const bytes = await readBytes(request);
		if (bytes.byteLength > 0) body = bytes;
		if (/json/i.test(headers.get("Content-Type") ?? "")) {
			headers.set("Content-Type", "application/json");
			if (body !== null) body = plainJson(bytes);
		}
	}
	const policy = policyFor(env);
	await policy.revokeStale(headers.get("Cookie"));
	const forwarded = new Request(request.url, { method: request.method, headers, body });
	const auth = getAuth(env, policy);
	return runInScope({ holder: null }, () => auth.handler(forwarded));
}

const PLAIN_KEY = /^[A-Za-z0-9_.:-]*$/;

function plainJson(bytes: Uint8Array): string {
	let value: Json;
	try {
		value = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new HttpError(unparseableBody());
	}
	const check = (node: Json): void => {
		if (Array.isArray(node)) node.forEach(check);
		else if (node !== null && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				if (!PLAIN_KEY.test(key)) throw new HttpError(unparseableBody());
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

/**
 * The request's session for our own routes, read from D1 on every request (no cookie cache), after
 * sessions whose credentials changed are deleted (policy.ts).
 */
export async function currentSession(env: Env, request: Request): Promise<CurrentSession> {
	const policy = policyFor(env);
	await policy.revokeStale(request.headers.get("Cookie"));
	const { headers, response } = await getAuth(env, policy).api.getSession({ headers: request.headers, returnHeaders: true });
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
