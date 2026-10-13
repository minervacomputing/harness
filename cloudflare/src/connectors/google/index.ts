// What Google connectors share: one OAuth app, the OpenID account, and how Google reports errors.
//
// Google reports rate limits, an API that is not enabled and some size limits as 403, named by a `reason`
// in the body. ProviderHTTP's `forbidden` hook has no body, so `classify` (which gets the body and runs
// first) reads them for 403s; a 403 it does not name falls through to the default PROVIDER_FORBIDDEN.

import { z } from "zod";
import type { Auth, OperationErrorShape } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { parseJson } from "../../lib/json.ts";

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

const ErrorBody = z.object({
	error: z.object({ errors: z.array(z.unknown()).default([]), details: z.array(z.unknown()).default([]) }),
});
const Reason = z.object({ reason: z.string() });

/** The string `reason`s of an error body's `error.errors[]` and `error.details[]`; none for any other shape. */
export function reasons(body: string): Set<string> {
	let data: unknown;
	try {
		data = parseJson(body);
	} catch {
		return new Set();
	}
	const parsed = ErrorBody.safeParse(data);
	if (!parsed.success) return new Set();
	const { errors, details } = parsed.data.error;
	return new Set([...errors, ...details].flatMap((item) => {
		const found = Reason.safeParse(item);
		return found.success ? [found.data.reason] : [];
	}));
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
export const GoogleUser = z.object({
	sub: z.string(),
	email: z.string().nullable().default(null),
	name: z.string().nullable().default(null),
});
export type GoogleUser = z.output<typeof GoogleUser>;
