// The stream token (docs/plans/credentials-and-facts.md, The token): its keys, and every check a token must pass.

import { SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { base64url } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { MAX_LIFETIME_SECONDS, MAX_SKEW_SECONDS, STREAM_AUDIENCE, STREAM_PURPOSE, streamKeys, verifyStreamToken } from "../../src/stream/token.ts";

const secret = (fill: number, length = 32) => base64url(new Uint8Array(length).fill(fill), { pad: false });
const KEYS = streamKeys(`k1:${secret(1)},k2:${secret(2)}`)!;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const SECONDS = NOW / 1000;
const [ORG, CONVERSATION, RUN] = [uuid7(), uuid7(), uuid7()];

interface Signed {
	/** Null for a token without one. */
	kid?: string | null;
	key?: Uint8Array;
	alg?: string;
	claims?: Record<string, unknown>;
	iat?: number;
	exp?: number;
}

function sign({ kid = "k1", key = KEYS.get("k1")!, alg = "HS256", claims = {}, iat = SECONDS, exp = SECONDS + 300 }: Signed = {}): Promise<string> {
	const payload = { aud: STREAM_AUDIENCE, purpose: STREAM_PURPOSE, env: "test", org: ORG, conversation: CONVERSATION, run: RUN, iat, exp, ...claims };
	const header = kid === null ? { alg } : { alg, kid };
	return new SignJWT(payload).setProtectedHeader(header).sign(key);
}

const verify = (token: string, now = NOW) => verifyStreamToken(token, KEYS, "test", now);

describe("the keys", () => {
	test("id:secret entries, each 32 bytes or more of URL-safe base64, padded or not", () => {
		const keys = streamKeys(` a:${secret(1)} , b-2_c:${base64url(new Uint8Array(40).fill(3))}`);
		expect([...(keys?.keys() ?? [])]).toEqual(["a", "b-2_c"]);
		expect(keys?.get("a")).toEqual(new Uint8Array(32).fill(1));
		expect(keys?.get("b-2_c")).toHaveLength(40);
	});

	test("nothing, or anything malformed, is no keys at all", () => {
		for (const value of [undefined, "", " , ", "a", `:${secret(1)}`, `a:${secret(1, 31)}`, `a:${secret(1)},a:${secret(2)}`, `a b:${secret(1)}`, `a:${secret(1)}!`, `a:${secret(1)},b`, `${"x".repeat(33)}:${secret(1)}`]) {
			expect(streamKeys(value), String(value)).toBeNull();
		}
		// Standard base64's alphabet is not the URL-safe one.
		expect(streamKeys(`a:${base64url(new Uint8Array(32).fill(0xfb), { pad: false }).replaceAll("-", "+").replaceAll("_", "/")}`)).toBeNull();
	});
});

describe("a token", () => {
	test("signed with either key, grants its run until its expiry", async () => {
		const grant = { organization: ORG, conversation: CONVERSATION, run: RUN, expiresAt: (SECONDS + 300) * 1000 };
		expect(await verify(await sign())).toEqual(grant);
		expect(await verify(await sign({ kid: "k2", key: KEYS.get("k2")! }))).toEqual(grant);
	});

	test("with a wrong or missing key, or another algorithm, is refused", async () => {
		expect(await verify(await sign({ kid: "k2" }))).toBeNull();
		expect(await verify(await sign({ kid: "k3" }))).toBeNull();
		expect(await verify(await sign({ kid: null }))).toBeNull();
		expect(await verify(await sign({ alg: "HS512", key: new Uint8Array(64).fill(1) }))).toBeNull();
		expect(await verify("not.a.token")).toBeNull();
		// An unsigned token.
		const [header, payload] = (await sign()).split(".");
		const none = `${base64url(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k1" })), { pad: false })}.${payload}.`;
		expect(header).toBeTruthy();
		expect(await verify(none)).toBeNull();
	});

	test("for another audience, purpose or environment, or without a claim, is refused", async () => {
		for (const claims of [{ aud: "minerva-other" }, { purpose: "download" }, { env: "production" }, { org: "not-a-uuid" }, { run: 7 }, { conversation: null }]) {
			expect(await verify(await sign({ claims })), JSON.stringify(claims)).toBeNull();
		}
		for (const missing of ["purpose", "env", "org", "conversation", "run", "aud"]) {
			expect(await verify(await sign({ claims: { [missing]: undefined } })), missing).toBeNull();
		}
	});

	test("is refused at its expiry without tolerance, past five minutes of life, or issued too far ahead", async () => {
		const token = await sign({ exp: SECONDS + 60 });
		expect(await verify(token, NOW + 59_999)).not.toBeNull();
		expect(await verify(token, NOW + 60_000)).toBeNull();
		expect(await verify(await sign({ exp: SECONDS + MAX_LIFETIME_SECONDS + 1 }))).toBeNull();
		expect(await verify(await sign({ exp: SECONDS }))).toBeNull();
		expect(await verify(await sign({ iat: SECONDS + 10, exp: SECONDS + 5 }))).toBeNull();
		// A clock ahead of the engine's by the skew allowed, and no more.
		expect(await verify(await sign({ iat: SECONDS + MAX_SKEW_SECONDS, exp: SECONDS + MAX_SKEW_SECONDS + 60 }))).not.toBeNull();
		expect(await verify(await sign({ iat: SECONDS + MAX_SKEW_SECONDS + 1, exp: SECONDS + MAX_SKEW_SECONDS + 60 }))).toBeNull();
		expect(await verify(await sign({ iat: SECONDS + 0.5 }))).toBeNull();
	});
});
