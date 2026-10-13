// The test build's driver header and token (routes.ts), apart from it so the account tests can import them
// in Node without the Worker's modules. Workers Logs keep request headers and blank only those whose names
// look secret: `X-Minerva-Faults` was kept whole, `X-Minerva-Faults-Token` is blanked (checked on the test
// Worker 2026-10-12), so the name ends in "Token", and the token is derived anew so that the ones already in
// the test Worker's logs no longer open the driver. scripts/bundle.ts finds the header and the purpose label
// (its markers `X-Minerva-Faults` and `minerva.faults`) in a build that must not have the driver.

import { hmacSha256Hex } from "../lib/hash.ts";

export const FAULTS_HEADER = "X-Minerva-Faults-Token";

/** HMAC-SHA256 of a purpose label under MINERVA_SECRET_KEY; the account tests compute it from the test Worker's secrets file. */
export function faultsToken(secretKey: string): Promise<string> {
	return hmacSha256Hex(secretKey, "minerva.faults-token");
}
