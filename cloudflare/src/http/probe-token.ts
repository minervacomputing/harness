// The probe's header and token (http/probe.ts), apart from the probe so the account tests can import them
// in Node without the Worker's modules. Workers Logs keep request headers and blank only those whose names
// look secret: `X-Minerva-Probe` was kept whole, `X-Minerva-Probe-Token` is blanked (checked on the production
// and test Workers 2026-10-12), so the name ends in "Token", and the salt changed with it so that the tokens
// already in the logs no longer open the probe.

import { saltedHmacHex } from "../lib/hash.ts";

export const PROBE_HEADER = "X-Minerva-Probe-Token";

/** Derived from MINERVA_SECRET_KEY; the account tests compute it from ../.env.cloudflare. */
export function probeToken(secretKey: string): Promise<string> {
	return saltedHmacHex("minerva.probe-token", "probe", secretKey, "SHA-256");
}
