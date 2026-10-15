// The test build's Access issuer (src/faults/settings.ts, index.ts): a placeholder whose keys are never fetched, so the
// internal API of a deployed test build refuses every assertion.

import { SignJWT, generateKeyPair } from "jose";
import { expect, test } from "vitest";
import { ASSERTION_HEADER, accessClient } from "../../src/internal/access.ts";
import { FAULTS_SETTINGS } from "../../src/faults/settings.ts";

test("an assertion for the placeholder issuer is refused, with no request for its keys", async () => {
	const issuer = FAULTS_SETTINGS.MINERVA_ACCESS_ISSUER;
	const { privateKey } = await generateKeyPair("RS256");
	const assertion = await new SignJWT({ common_name: "faults" })
		.setProtectedHeader({ alg: "RS256", kid: "faults" })
		.setIssuer(issuer)
		.setAudience(["faults"])
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
	const fetched: string[] = [];
	const fetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		fetched.push(new Request(input, init).url);
		return fetch(input, init);
	};
	try {
		const request = new Request("https://engine.example/internal/v1/catalog", { headers: { [ASSERTION_HEADER]: assertion } });
		expect(await accessClient(request, { issuer, audience: "faults", clients: ["faults"] })).toBeNull();
	} finally {
		globalThis.fetch = fetch;
	}
	expect(fetched).toEqual([]);
});
