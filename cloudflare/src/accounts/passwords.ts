// Passwords (plan: The web API). The rules are Django's default validators, with lengths in code points
// (characters as people count them); the hash is scrypt instead of Django's PBKDF2, whose 1,500,000
// iterations WebCrypto refuses.
//
// A hash is `scrypt$<log2 N>$<r>$<p>$<salt>$<key>` (salt 16 bytes, key 32, both base64 without padding),
// so the parameters can be raised later and old hashes still verified (`needsRehash`). N 2^15, r 8, p 3
// is one of OWASP's equivalent settings (never go below them). It costs about 87 ms of CPU in local workerd
// on Apple silicon and about 260 ms on the edge (one hash per request, Workers Logs' CPU time, median of 10,
// measured twice 2026-10-12; plan: The web API), and 32 MiB of memory, since the p lanes run one after
// another. Of the other equivalents measured there, 2^14/p 5 took about 190 ms with half the memory, the
// thing that makes a guess expensive in parallel; 2^16/p 2 and 2^17/p 1 took about 310 and 320 ms and need
// 64 and 128 MiB, half and all of an isolate's 128 MB, which concurrent sign-ins share.
//
// Better Auth calls `hashPassword` and `verifyPassword` as its custom hash (auth-options.ts), including for
// a sign-in with an unknown address, which it hashes the password for so it takes as long as a wrong one.

import { scrypt } from "node:crypto";
import { timingSafeEqual } from "../lib/hash.ts";
import { randomBytes } from "../lib/random.ts";
import { WORD_CLASS } from "../lib/text.ts";
import { COMMON_PASSWORDS } from "./common-passwords.ts";

export interface ScryptParams {
	logN: number;
	r: number;
	p: number;
}

export const SCRYPT: Readonly<ScryptParams> = { logN: 15, r: 8, p: 3 };

/**
 * The parameters new hashes get, and the ones `needsRehash` measures a stored hash against. Always SCRYPT
 * in a deployment: no setting or binding changes it. Only the platform tests lower it
 * (test/platform/cheap-hashing.ts), so that accounts there do not each cost a production hash.
 */
export const HASHING: { params: Readonly<ScryptParams> } = { params: SCRYPT };

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ENCODED = /^scrypt\$([0-9]{1,2})\$([0-9]{1,2})\$([0-9]{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

function unbase64(text: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function derive(password: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
	const N = 2 ** params.logN;
	// scrypt needs 128 · r · N bytes, and a little more for its own bookkeeping.
	const maxmem = 128 * params.r * N * 2;
	return new Promise((resolve, reject) => {
		scrypt(new TextEncoder().encode(password), salt, KEY_BYTES, { N, r: params.r, p: params.p, maxmem }, (error, key) => {
			if (error) reject(error);
			else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
		});
	});
}

export async function hashPassword(password: string, params: ScryptParams = HASHING.params): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const key = await derive(password, salt, params);
	return `scrypt$${params.logN}$${params.r}$${params.p}$${base64(salt)}$${base64(key)}`;
}

function parse(encoded: string): { params: ScryptParams; salt: Uint8Array; key: Uint8Array } | null {
	const match = ENCODED.exec(encoded);
	if (!match) return null;
	const params = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
	// Bounds that keep a corrupted row from asking for gigabytes.
	if (params.logN < 10 || params.logN > 20 || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 16) return null;
	const salt = unbase64(match[4] ?? "");
	const key = unbase64(match[5] ?? "");
	if (!salt || !key || key.length !== KEY_BYTES) return null;
	return { params, salt, key };
}

/** Whether the password matches the stored hash; an unknown or malformed hash matches nothing. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const parsed = parse(encoded);
	if (!parsed) return false;
	const key = await derive(password, parsed.salt, parsed.params);
	return timingSafeEqual(key, parsed.key);
}

/** A hash made with weaker parameters than new hashes get, to be replaced after the next successful sign-in. */
export function needsRehash(encoded: string): boolean {
	const parsed = parse(encoded);
	const { logN, r, p } = HASHING.params;
	return !parsed || parsed.params.logN < logN || parsed.params.r < r || parsed.params.p < p;
}

// The validators, in Django's order: similarity to the user's attributes (only when a user is known:
// allauth's headless sign-up validates without one), minimum length 10, the common-password list, not
// entirely numeric. Every failing validator adds its error.

export interface PasswordError {
	message: string;
	code: "password_too_similar" | "password_too_short" | "password_too_common" | "password_entirely_numeric";
}

const MIN_LENGTH = 10;
const MAX_SIMILARITY = 0.7;

let common: Set<string> | null = null;

function isCommon(password: string): boolean {
	common ??= new Set(COMMON_PASSWORDS.split("\n"));
	return common.has(password.toLowerCase().trim());
}

/** difflib.SequenceMatcher(a, b).quick_ratio(): an upper bound of the ratio from the characters alone. */
export function quickRatio(a: string, b: string): number {
	const left = Array.from(a);
	const right = Array.from(b);
	const counts = new Map<string, number>();
	for (const char of right) counts.set(char, (counts.get(char) ?? 0) + 1);
	let matches = 0;
	for (const char of left) {
		const available = counts.get(char) ?? 0;
		counts.set(char, available - 1);
		if (available > 0) matches += 1;
	}
	const total = left.length + right.length;
	return total ? (2 * matches) / total : 1;
}

function exceedsMaximumLengthRatio(password: string, value: string): boolean {
	const passwordLength = [...password].length;
	const valueLength = [...value].length;
	return passwordLength >= 10 * valueLength && valueLength < (MAX_SIMILARITY / 2) * passwordLength;
}

const NON_WORD = new RegExp(`[^${WORD_CLASS}]+`, "u");

/** UserAttributeSimilarityValidator over the attributes the user model has: only `email` (verbose name "email"). */
function tooSimilar(password: string, user: { email: string }): boolean {
	const lowered = password.toLowerCase();
	const value = user.email.toLowerCase();
	if (!value) return false;
	for (const part of [...value.split(NON_WORD), value]) {
		if (exceedsMaximumLengthRatio(lowered, part)) continue;
		if (quickRatio(lowered, part) >= MAX_SIMILARITY) return true;
	}
	return false;
}

export function validatePassword(password: string, user?: { email: string }): PasswordError[] {
	const errors: PasswordError[] = [];
	if (user && tooSimilar(password, user)) errors.push({ message: "The password is too similar to the email.", code: "password_too_similar" });
	if ([...password].length < MIN_LENGTH) {
		errors.push({ message: `This password is too short. It must contain at least ${MIN_LENGTH} characters.`, code: "password_too_short" });
	}
	if (isCommon(password)) errors.push({ message: "This password is too common.", code: "password_too_common" });
	if (/^\p{N}+$/u.test(password)) errors.push({ message: "This password is entirely numeric.", code: "password_entirely_numeric" });
	return errors;
}
