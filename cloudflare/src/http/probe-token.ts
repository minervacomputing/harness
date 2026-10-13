// The probe's header and token (http/probe.ts), apart from the probe so the account tests can import them
// in Node without the Worker's modules. Workers Logs keep request headers and blank only those whose names
// look secret: `X-Minerva-Probe` was kept whole, `X-Minerva-Probe-Token` is blanked (checked on the production
// and test Workers 2026-10-12), so the name ends in "Token", and the token is derived anew so that the ones
// already in the logs no longer open the probe.

import { hmacSha256Hex } from "../lib/hash.ts";

export const PROBE_HEADER = "X-Minerva-Probe-Token";

/** HMAC-SHA256 of a purpose label under MINERVA_SECRET_KEY; the account tests compute it from the instance's secrets.env. */
export function probeToken(secretKey: string): Promise<string> {
	return hmacSha256Hex(secretKey, "minerva.probe-token");
}
