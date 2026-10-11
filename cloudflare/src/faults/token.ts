// The test build's driver header and token (routes.ts), apart from it so the account tests can import them
// in Node without the Worker's modules.

import { saltedHmacHex } from "../lib/hash.ts";

export const FAULTS_HEADER = "X-Minerva-Faults";

/** Derived from MINERVA_SECRET_KEY; the account tests compute it from the test Worker's secrets file. */
export function faultsToken(secretKey: string): Promise<string> {
	return saltedHmacHex("minerva.faults", "faults", secretKey, "SHA-256");
}
