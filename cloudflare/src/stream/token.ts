// The stream token (docs/plans/credentials-and-facts.md, The stream): a JWT that Laravel signs for one run, which the
// browser sends to read that run's events. HS256 with a key both sides hold (MINERVA_STREAM_KEYS), naming the key by
// `kid`; the claims name the engine's environment, the organization, the conversation and the run, and it lives at most
// five minutes. Anything that does not check out is refused, and nothing says why.

import { type JWTPayload, jwtVerify } from "jose";
import { base64url, fromBase64 } from "../lib/bytes.ts";
import { isUuid } from "../lib/random.ts";

/** The token's audience and purpose: the engine's run stream, and nothing else Laravel signs. */
export const STREAM_AUDIENCE = "minerva-engine";
export const STREAM_PURPOSE = "run-stream";
/** The longest a token may live, from `iat` to `exp`. */
export const MAX_LIFETIME_SECONDS = 300;
/** How far ahead of the engine's clock `iat` may be, for skew: so a token is used at most 330 s from its check. */
export const MAX_SKEW_SECONDS = 30;
/** A key's secret has at least this many bytes. */
const MIN_SECRET_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** What a verified token allows: one run's stream, until `expiresAt` (epoch ms). */
export interface StreamGrant {
	organization: string;
	conversation: string;
	run: string;
	expiresAt: number;
}

/**
 * MINERVA_STREAM_KEYS: `id:secret` entries, comma separated, each secret at least 32 bytes in URL-safe base64. Laravel
 * signs with one; the engine accepts any. Null when the value is empty or malformed (then the stream is off), so a bad
 * value never half-works.
 */
export function streamKeys(value: string | undefined): ReadonlyMap<string, Uint8Array> | null {
	const entries = (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) return null;
	const keys = new Map<string, Uint8Array>();
	for (const entry of entries) {
		const split = entry.indexOf(":");
		const id = split < 0 ? "" : entry.slice(0, split);
		const secret = split < 0 ? null : decodeSecret(entry.slice(split + 1));
		if (!KEY_ID.test(id) || secret === null || secret.length < MIN_SECRET_BYTES || keys.has(id)) return null;
		keys.set(id, secret);
	}
	return keys;
}

/** URL-safe base64, padded or not, in its canonical spelling; null for anything else. */
function decodeSecret(text: string): Uint8Array | null {
	const bare = text.replace(/={1,2}$/, "");
	if (!/^[A-Za-z0-9_-]+$/.test(bare)) return null;
	try {
		const bytes = fromBase64(bare);
		return base64url(bytes, { pad: false }) === bare ? bytes : null;
	} catch {
		return null;
	}
}

/** The token's grant, or null when it does not verify for this engine's environment at `now` (epoch ms). */
export async function verifyStreamToken(token: string, keys: ReadonlyMap<string, Uint8Array>, environment: string, now: number = Date.now()): Promise<StreamGrant | null> {
	let payload: JWTPayload;
	try {
		const verified = await jwtVerify(
			token,
			(header) => {
				const key = typeof header.kid === "string" ? keys.get(header.kid) : undefined;
				if (key === undefined) throw new Error("Unknown key.");
				return key;
			},
			{
				algorithms: ["HS256"],
				audience: STREAM_AUDIENCE,
				requiredClaims: ["iat", "exp", "purpose", "env", "org", "conversation", "run"],
				// `exp` has no tolerance: the stream closes at it. `iat`'s skew is checked below.
				clockTolerance: 0,
				currentDate: new Date(now),
			},
		);
		payload = verified.payload;
	} catch {
		return null;
	}
	const { iat, exp, purpose, env, org, conversation, run } = payload as Record<string, unknown>;
	if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
	const issued = iat as number;
	const expires = exp as number;
	if (expires <= issued || expires - issued > MAX_LIFETIME_SECONDS || issued > now / 1000 + MAX_SKEW_SECONDS || expires * 1000 <= now) return null;
	if (purpose !== STREAM_PURPOSE || env !== environment) return null;
	if (typeof org !== "string" || typeof conversation !== "string" || typeof run !== "string" || !isUuid(org) || !isUuid(conversation) || !isUuid(run)) return null;
	return { organization: org, conversation, run, expiresAt: expires * 1000 };
}
