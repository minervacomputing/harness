// The Access assertion the internal API checks (src/internal/access.ts), against a key set of the test's own.

import { type JWTPayload, SignJWT, createLocalJWKSet, createRemoteJWKSet, customFetch, errors, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AccessSettings } from "../../src/config.ts";
import { ACCESS_KEYS, ASSERTION_HEADER, AccessUnavailable, accessClient } from "../../src/internal/access.ts";

const ACCESS: AccessSettings = { issuer: "https://team.cloudflareaccess.example", audience: "aud-tag", clients: ["old.access", "laravel.access"] };

let key: CryptoKey;
let stranger: CryptoKey;
const published = ACCESS_KEYS.of;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	key = pair.privateKey;
	stranger = (await generateKeyPair("RS256")).privateKey;
	const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
	ACCESS_KEYS.of = () => createLocalJWKSet({ keys: [jwk] });
});

afterAll(() => {
	ACCESS_KEYS.of = published;
});

interface Assertion {
	claims?: JWTPayload;
	issuer?: string;
	audience?: string;
	expires?: string | number;
	signer?: CryptoKey;
	kid?: string;
}

async function assertion({ claims = { common_name: "laravel.access" }, issuer = ACCESS.issuer, audience = ACCESS.audience, expires = "5m", signer, kid = "k1" }: Assertion = {}): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid })
		.setIssuer(issuer)
		.setAudience([audience])
		.setIssuedAt()
		.setExpirationTime(expires)
		.sign(signer ?? key);
}

function request(token: string | null): Request {
	return new Request("https://engine.example/internal/v1/catalog", token === null ? {} : { headers: { [ASSERTION_HEADER]: token } });
}

test("a service token's assertion names its client", async () => {
	expect(await accessClient(request(await assertion()), ACCESS)).toBe("laravel.access");
	// The token being rotated out still works while it is listed.
	expect(await accessClient(request(await assertion({ claims: { common_name: "old.access" } })), ACCESS)).toBe("old.access");
});

test("anything else is refused", async () => {
	const refused = async (token: string | null) => expect(await accessClient(request(token), ACCESS)).toBeNull();
	await refused(null);
	await refused("");
	await refused("not a token");
	await refused(await assertion({ claims: { common_name: "someone.access" } }));
	// A user's identity token has an email and no common_name.
	await refused(await assertion({ claims: { email: "ada@example.com", sub: "user-id" } }));
	await refused(await assertion({ issuer: "https://other.cloudflareaccess.example" }));
	await refused(await assertion({ audience: "another-application" }));
	await refused(await assertion({ expires: Math.floor(Date.now() / 1000) - 120 }));
	await refused(await assertion({ signer: stranger }));
	await refused(await assertion({ signer: stranger, kid: "unknown" }));
	// An assertion must say when it was issued and when it expires.
	const builder = () => new SignJWT({ common_name: "laravel.access" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ACCESS.issuer).setAudience(ACCESS.audience);
	await refused(await builder().setIssuedAt().sign(key));
	await refused(await builder().setExpirationTime("5m").sign(key));
});

test("only RS256 is accepted", async () => {
	const secret = new TextEncoder().encode("a shared secret long enough for HS256");
	const hs = await new SignJWT({ common_name: "laravel.access" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(ACCESS.issuer).setAudience(ACCESS.audience).setIssuedAt().setExpirationTime("5m").sign(secret);
	expect(await accessClient(request(hs), ACCESS)).toBeNull();
	const payload = (await assertion()).split(".")[1];
	const none = `${btoa(JSON.stringify({ alg: "none" })).replaceAll("=", "")}.${payload}.`;
	expect(await accessClient(request(none), ACCESS)).toBeNull();
});

test("keys that cannot be read are a failure, not a refusal", async () => {
	const local = ACCESS_KEYS.of;
	try {
		ACCESS_KEYS.of = () => async () => {
			throw new errors.JWKSTimeout();
		};
		await expect(accessClient(request(await assertion()), ACCESS)).rejects.toBeInstanceOf(AccessUnavailable);
		ACCESS_KEYS.of = () => async () => {
			throw new TypeError("fetch failed");
		};
		await expect(accessClient(request(await assertion()), ACCESS)).rejects.toBeInstanceOf(AccessUnavailable);
		// Access's endpoint failing, or answering with something that is not a key set.
		for (const answer of [new Response("Unavailable", { status: 503 }), Response.json({ keys: "none" }), new Response("<html>")]) {
			ACCESS_KEYS.of = (issuer) => createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), { [customFetch]: async () => answer.clone() });
			await expect(accessClient(request(await assertion()), ACCESS)).rejects.toBeInstanceOf(AccessUnavailable);
		}
	} finally {
		ACCESS_KEYS.of = local;
	}
});
