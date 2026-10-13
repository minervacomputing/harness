// What Google connectors share: one OAuth app, the
// OpenID account, and how Google reports errors.
//
// Google reports rate limits, an API that is not enabled and some size limits as 403. Python reads them in
// ProviderHTTP's `forbidden` hook from the response's JSON; here that hook is synchronous and has no body,
// so the same mapping runs in `classify` (which gets the body and runs first) for 403s, and a 403 it does
// not name falls through to the default PROVIDER_FORBIDDEN, as `default_forbidden` did.

import { z } from "zod";
import type { Auth, OperationErrorShape } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { isDict, type Json, parseJson } from "../../lib/json.ts";
import { model } from "./model.ts";

export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const RATE_LIMITED: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
/** The API is not enabled in the operator's Google Cloud project. */
export const NOT_CONFIGURED: ReadonlySet<string> = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
export const TOO_LARGE: ReadonlySet<string> = new Set(["exportSizeLimitExceeded"]);

/** The Google app's OAuth declaration, with `openid email` and the connector's base scopes. */
export function oauth(...scopes: string[]): Extract<Auth, { type: "oauth2" }> {
	return {
		type: "oauth2",
		app: "google",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		scopes: ["openid", "email", ...scopes],
		// Google only issues a refresh token for offline access, and only on the consent screen. Earlier
		// grants are kept when more scopes are requested.
		authorizeParams: [
			["access_type", "offline"],
			["prompt", "consent"],
			["include_granted_scopes", "true"],
		],
		loginHint: true,
	};
}

/** `dict.get(key, default)` on an own key. */
function get(value: { [key: string]: Json }, key: string, fallback: Json): Json {
	return Object.hasOwn(value, key) ? (value[key] as Json) : fallback;
}

class Unreadable extends Error {}

/**
 * The `reason`s of `error.errors[]` and `error.details[]`, as `_reasons` reads them: any shape Python's
 * `.get` would fail on (an item or `error` that is not an object, a body that is not JSON) yields none at
 * all (so does a reason that is a list or an object, which a Python set cannot hold), and only string reasons
 * are kept.
 */
export function reasons(body: string): Set<string> {
	try {
		let data: Json;
		try {
			data = parseJson(body);
		} catch {
			throw new Unreadable();
		}
		if (!isDict(data)) throw new Unreadable();
		const error = get(data, "error", {});
		if (!isDict(error)) throw new Unreadable();
		const found = new Set<Json>();
		for (const field of ["errors", "details"]) {
			for (const item of iterate(get(error, field, []))) {
				if (!isDict(item)) throw new Unreadable();
				const reason = get(item, "reason", null);
				// A list or an object cannot go into Python's set: the TypeError that follows reads as no reasons at all.
				if (typeof reason === "object" && reason !== null) throw new Unreadable();
				found.add(reason);
			}
		}
		return new Set([...found].filter((reason): reason is string => typeof reason === "string"));
	} catch (error) {
		if (error instanceof Unreadable) return new Set();
		throw error;
	}
}

/** What Python's `for item in value` yields: a list's items, a dict's keys, a string's characters; else TypeError. */
function iterate(value: Json): Json[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return Array.from(value);
	if (isDict(value)) return Object.keys(value);
	throw new Unreadable();
}

/** Google's 403s that are not about the account: rate limits, a disabled API, an export too large; else null. */
export function forbidden(provider: string, body: string): OperationErrorShape | null {
	const found = reasons(body);
	if ([...found].some((reason) => RATE_LIMITED.has(reason))) {
		return new OperationError("PROVIDER_RATE_LIMITED", `${provider} is rate limiting requests. Try again later.`);
	}
	if ([...found].some((reason) => NOT_CONFIGURED.has(reason))) {
		return new OperationError(
			"PROVIDER_NOT_CONFIGURED",
			`The ${provider} API is not enabled for this Minerva instance's Google Cloud project. Ask the operator to enable it.`,
		);
	}
	if ([...found].some((reason) => TOO_LARGE.has(reason))) {
		return new OperationError("FILE_TOO_LARGE", `This file is too large for ${provider} to export.`);
	}
	return null;
}

/** ProviderHTTP's `classify` for Google: the 403 reasons above. */
export function classify(provider: string, response: Response, body: string): OperationErrorShape | null {
	return response.status === 403 ? forbidden(provider, body) : null;
}

/** The OpenID userinfo: `sub` is stable, the email address can change. */
export const GoogleUser = model(
	{
		sub: z.string(),
		email: z.string().nullable().default(null),
		name: z.string().nullable().default(null),
	},
	{ camel: false },
);
export type GoogleUser = z.output<typeof GoogleUser>;
