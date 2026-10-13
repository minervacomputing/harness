// A TOTP code works once. Better Auth accepts a
// code for the current time step or one either side, as often as it is sent. Before Better Auth checks a
// code on /two-factor/verify-totp (a sign-in's second factor, or the code that finishes turning two-factor
// on), the policy's hook finds the latest step the code is valid for and claims it in D1 with a
// conditional upsert (migrations/0005_totp_steps.sql): a step equal to or older than the authenticator's
// last claimed one is refused as an incorrect code. Of two requests with the same code, only one claims
// its step. A code that matches no step is left to Better Auth, which refuses and counts it; should
// Better Auth accept it anyway (its clock read later, across a step boundary), the policy refuses the
// session, so no code gets through unclaimed.

import { APIError } from "better-auth/api";
import { type SecretConfig, symmetricDecrypt } from "better-auth/crypto";
import { TWO_FACTOR_ERROR_CODES } from "better-auth/plugins";
import { hmac, sha256Hex, timingSafeEqual } from "../lib/hash.ts";

/** Better Auth's defaults, which auth-options.ts keeps: 30 s steps, six digits, HMAC-SHA-1 (RFC 6238). */
const PERIOD_MS = 30_000;
const DIGITS = 6;

/** RFC 4226's HOTP over the secret's UTF-8 bytes, as Better Auth keys it (`@better-auth/utils/otp`). */
export async function hotp(secret: string, step: number): Promise<string> {
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(step));
	const mac = await hmac("SHA-1", secret, counter);
	const offset = (mac[mac.length - 1] as number) & 15;
	const value = (((mac[offset] as number) & 127) << 24) | ((mac[offset + 1] as number) << 16) | ((mac[offset + 2] as number) << 8) | (mac[offset + 3] as number);
	return String(value % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The latest time step the code is valid for in Better Auth's window (one step either side), or null; every step is compared, in constant time. */
export async function matchingStep(secret: string, code: string, now: number): Promise<number | null> {
	const current = Math.floor(now / PERIOD_MS);
	let found: number | null = null;
	for (let step = current - 1; step <= current + 1; step++) {
		if (timingSafeEqual(await hotp(secret, step), code)) found = step;
	}
	return found;
}

/** Better Auth's answer to a wrong code. */
export function invalidCode(): APIError {
	return APIError.from("UNAUTHORIZED", TWO_FACTOR_ERROR_CODES.INVALID_CODE);
}

/**
 * Claims the step of a TOTP code for the user's authenticator: true once claimed, false when the code
 * matches no step, and Better Auth's "Invalid code" thrown for a step already used. Every authenticator
 * row of the user is checked (Better Auth reads one of them). A claim needs the row to still hold the
 * secret the code was checked against, so a request that read a secret since replaced claims nothing.
 */
export async function claimTotpStep(db: D1Database, secretConfig: string | SecretConfig, userId: string, code: string, now = Date.now()): Promise<boolean> {
	const { results } = await db.prepare(`SELECT id, secret FROM "twoFactor" WHERE "userId" = ?`).bind(userId).all<{ id: string; secret: string }>();
	const claims: D1PreparedStatement[] = [];
	for (const row of results) {
		const step = await matchingStep(await symmetricDecrypt({ key: secretConfig, data: row.secret }), code, now);
		if (step === null) continue;
		claims.push(
			db
				.prepare(
					`INSERT INTO totp_steps (two_factor_id, secret_hash, last_step) SELECT id, ?, ? FROM "twoFactor" WHERE id = ? AND secret = ? ` +
						`ON CONFLICT (two_factor_id) DO UPDATE SET secret_hash = excluded.secret_hash, last_step = excluded.last_step ` +
						`WHERE totp_steps.secret_hash <> excluded.secret_hash OR totp_steps.last_step < excluded.last_step`,
				)
				.bind(await sha256Hex(row.secret), step, row.id, row.secret),
		);
	}
	if (!claims.length) return false;
	const claimed = await db.batch(claims);
	if (claimed.some((result) => result.meta.changes === 0)) throw invalidCode();
	return true;
}
