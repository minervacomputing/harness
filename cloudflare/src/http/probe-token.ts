// The probe's header and token (http/probe.ts), apart from the probe so the account tests can import them
// in Node without the Worker's modules.

import { saltedHmacHex } from "../lib/hash.ts";

export const PROBE_HEADER = "X-Minerva-Probe";

/** Derived from MINERVA_SECRET_KEY; the account tests compute it from ../.env.cloudflare. */
export function probeToken(secretKey: string): Promise<string> {
	return saltedHmacHex("minerva.probe", "probe", secretKey, "SHA-256");
}
