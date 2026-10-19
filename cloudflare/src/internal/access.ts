// Who may call the internal API: Laravel, with a Cloudflare Access service token.
// Access checks the token at the edge, in front of /internal/*, and adds its signed assertion; the Worker checks that
// assertion again before anything reads the request, so a route that Access does not cover, or a request that reaches the
// Worker some other way, is refused all the same.

import { type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { AccessSettings } from "../config.ts";

/** The header Access adds once it has checked a service token. */
export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

/** Access's clocks and ours may differ by this much. */
const CLOCK_TOLERANCE_SECONDS = 30;

const remote = new Map<string, JWTVerifyGetKey>();

/** The issuer's published keys, fetched and cached per isolate by jose, which fetches again for a key id it has not seen. */
function publishedKeys(issuer: string): JWTVerifyGetKey {
	let keys = remote.get(issuer);
	if (keys === undefined) {
		keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
		remote.set(issuer, keys);
	}
	return keys;
}

/** Where an issuer's keys come from: Access's certificates. Replaced only by the platform tests, with a key set of their own. */
export const ACCESS_KEYS: { of: (issuer: string) => JWTVerifyGetKey } = { of: publishedKeys };

/** The keys could not be read (Access's endpoint failed or timed out): a failure to retry, not a refusal. */
export class AccessUnavailable extends Error {
	constructor(options?: ErrorOptions) {
		super("Cloudflare Access's keys could not be read.", options);
		this.name = "AccessUnavailable";
	}
}

/**
 * The issuer's keys, with every failure to read them made `AccessUnavailable`: a timeout, an answer that is not 200, a key set
 * that is not one. Only an assertion whose key is not in a set that was read (none matches, or several do) is refused.
 */
function keysOf(issuer: string): JWTVerifyGetKey {
	const keys = ACCESS_KEYS.of(issuer);
	return async (header, token) => {
		try {
			return await keys(header, token);
		} catch (error) {
			if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error;
			throw new AccessUnavailable({ cause: error });
		}
	};
}

/**
 * The client id of the service token behind the request's assertion, or null when there is none or it does not verify: RS256
 * only, signed by one of the issuer's keys, issued by it for the application's audience, current, and naming one of the
 * configured service tokens as its `common_name`. A user's identity token has no `common_name`, so it never passes. Throws
 * `AccessUnavailable` when the keys cannot be read.
 */
export async function accessClient(request: Request, access: AccessSettings): Promise<string | null> {
	const assertion = request.headers.get(ASSERTION_HEADER);
	if (!assertion) return null;
	let claims: Record<string, unknown>;
	try {
		const verified = await jwtVerify(assertion, keysOf(access.issuer), {
			issuer: access.issuer,
			audience: access.audience,
			algorithms: ["RS256"],
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
			requiredClaims: ["exp", "iat"],
		});
		claims = verified.payload;
	} catch (error) {
		if (error instanceof AccessUnavailable) throw error;
		return null;
	}
	const client = claims.common_name;
	return typeof client === "string" && access.clients.includes(client) ? client : null;
}
