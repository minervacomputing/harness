// CSRF as Django checks it (web-api spec 3.2): unsafe methods must come from the site's origin and carry
// the `csrftoken` cookie's value in `X-CSRFToken` (double submit). In Django's order:
//
// 1. an `Origin` header, when present, must be the request's own origin or MINERVA_SITE_URL's;
// 2. without `Origin`, an HTTPS request needs a `Referer` with one of those origins;
// 3. the cookie must be set and well formed;
// 4. the header must equal it (compared in constant time).
//
// The page sends the cookie's value as it is, so only that form is accepted; Django's 64-character masked
// tokens are not (web-api spec 3.2: "the port only needs header equals cookie").
//
// Where the check sits among the others, and how a failure looks, depends on the route: Ninja routes
// check it before the session (403 `CSRF check Failed`, so an anonymous unsafe request gets 403, not
// 401), allauth routes answer with allauth's envelope, and uploads check it after the session.

import { timingSafeEqual } from "../lib/hash.ts";
import { ALPHANUMERIC, randomString } from "../lib/random.ts";
import { CSRF_COOKIE, readCookie } from "./cookies.ts";

export const CSRF_HEADER = "X-CSRFToken";

const SAFE = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const TOKEN = /^[A-Za-z0-9]{32}$/;

export type CsrfFailure = "bad_origin" | "no_referer" | "bad_referer" | "no_cookie" | "no_token" | "bad_token";

export function isSafeMethod(method: string): boolean {
	return SAFE.has(method.toUpperCase());
}

/** A new secret for the cookie: 32 letters and digits, as Django's. */
export function newCsrfToken(): string {
	return randomString(32, ALPHANUMERIC);
}

/** The request's CSRF cookie, if it holds a well-formed token. */
export function csrfCookieToken(request: Request): string | null {
	const value = readCookie(request, CSRF_COOKIE);
	return value !== null && TOKEN.test(value) ? value : null;
}

/** Why an unsafe request fails the check, or null when it passes (or is safe). */
export function checkCsrf(request: Request, siteUrl: string): CsrfFailure | null {
	if (isSafeMethod(request.method)) return null;
	const own = new URL(request.url);
	const allowed = new Set([own.origin, new URL(siteUrl).origin]);
	const origin = request.headers.get("Origin");
	if (origin !== null) {
		if (!allowed.has(origin)) return "bad_origin";
	} else if (own.protocol === "https:") {
		const referer = request.headers.get("Referer");
		if (!referer) return "no_referer";
		// The URL parser repairs `https:host`, which Django refuses, so the Referer must start with
		// `https://`; one carrying credentials is refused too.
		if (!referer.startsWith("https://")) return "bad_referer";
		let from: URL;
		try {
			from = new URL(referer);
		} catch {
			return "bad_referer";
		}
		if (from.username || from.password || !allowed.has(from.origin)) return "bad_referer";
	}
	const secret = csrfCookieToken(request);
	if (secret === null) return "no_cookie";
	const token = request.headers.get(CSRF_HEADER);
	if (!token) return "no_token";
	return timingSafeEqual(token, secret) ? null : "bad_token";
}
