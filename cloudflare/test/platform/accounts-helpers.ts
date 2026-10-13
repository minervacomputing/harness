// Shared by the accounts platform tests: a browser with cookies, an Origin and an IP of its own, the emails
// written to the log (debug is on), from which the tests read codes, and accounts made as the sign-up page
// makes them. Better Auth's routes are at /api/auth.

import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { REFUSALS, type RefusalCode } from "../../src/shared/rpc.ts";

export const ORIGIN = "http://localhost";
export const PASSWORD = "a long enough passphrase";

/** A refusal's body in the contract's error shape (http/errors.ts `errorAnswer`). */
export function contractError(code: RefusalCode, message: string): { defined: true; code: RefusalCode; status: number; message: string } {
	return { defined: true, code, status: REFUSALS[code], message };
}

let ipCounter = 0;
let log: MockInstance<typeof console.log>;

/** Captures console.log for each test of the file that calls it. */
export function installEmailLog(): void {
	beforeEach(() => {
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		log.mockRestore();
	});
}

export interface Sent {
	subject: string;
	body: string;
}

/** The emails written to the log for an address, oldest first. */
export function emailsTo(address: string): Sent[] {
	return log.mock.calls
		.map((call) => String(call[0]))
		.filter((text) => text.startsWith(`Email to ${address} `))
		.map((text) => ({ subject: /\nSubject: (.*)\n/.exec(text)?.[1] ?? "", body: text.slice(text.indexOf("\n\n") + 2) }));
}

export function lastCode(address: string): string {
	const sent = emailsTo(address).at(-1);
	const code = sent ? /\n\n([0-9]{6})(\n|$)/.exec(sent.body)?.[1] : undefined;
	if (!code) throw new Error(`No code was sent to ${address}`);
	return code;
}

export function uniqueEmail(name = "ada"): string {
	return `${name}-${uuid7().slice(-12)}@example.com`;
}

export interface Answer {
	status: number;
	body: any;
	response: Response;
}

/** A browser: keeps its cookies, sends the site's Origin on unsafe requests, and has an IP of its own. */
export class Browser {
	readonly cookies = new Map<string, string>();
	readonly setCookies: string[] = [];
	// A valid address of its own, so Better Auth's per-IP limits keep the tests apart.
	readonly ip = `10.${(++ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
	readonly fetcher: (request: Request) => Promise<Response>;
	constructor(fetcher: (request: Request) => Promise<Response> = (request) => exports.default.fetch(request)) {
		this.fetcher = fetcher;
	}

	async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
		const all: Record<string, string> = { "CF-Connecting-IP": this.ip, ...headers };
		if (this.cookies.size) all.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		if (method !== "GET") all.Origin ??= ORIGIN;
		if (body !== undefined) all["Content-Type"] ??= "application/json";
		const response = await this.fetcher(
			new Request(`${ORIGIN}${path}`, { method, headers: all, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }),
		);
		this.keep(response);
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : null, response };
	}

	/** Stores the cookies a response sets, drops the ones it expires. */
	private keep(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			this.setCookies.push(cookie);
			const [pair] = cookie.split(";");
			const split = pair!.indexOf("=");
			const name = pair!.slice(0, split);
			const value = pair!.slice(split + 1);
			if (/Max-Age=0/.test(cookie)) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	/** `fetch` for a client library: this browser's cookies, Origin on unsafe requests and IP; the response unread. */
	readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
		const headers = new Headers(request.headers);
		headers.set("CF-Connecting-IP", this.ip);
		if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
		if (request.method !== "GET" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
		const response = await this.fetcher(new Request(request, { headers }));
		this.keep(response);
		return response;
	};

	/** Better Auth's routes. */
	auth(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
		return this.call(body === undefined ? "GET" : "POST", `/api/auth${path}`, body, headers);
	}
}

/** Signs in with an email code from a browser of its own (which signs up a new address while sign-up is open). */
export async function signInWithCode(email: string, headers: Record<string, string> = {}, browser = new Browser()): Promise<{ browser: Browser; userId: string }> {
	const sent = await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers);
	expect(sent.status, JSON.stringify(sent.body)).toBe(200);
	const signedIn = await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email) }, headers);
	expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
	expect(signedIn.body.token).toEqual(expect.any(String));
	return { browser, userId: signedIn.body.user.id };
}

/** A new account, signed in, as the sign-up page makes it: an email code, then its first password. */
export async function signedIn(email = uniqueEmail(), password = PASSWORD): Promise<{ browser: Browser; email: string; userId: string }> {
	const { browser, userId } = await signInWithCode(email);
	const set = await browser.call("POST", "/api/me/password", { password });
	expect(set.status, JSON.stringify(set.body)).toBe(204);
	return { browser, email, userId };
}

/** The session cookie's value in a browser (debug is on, so the name has no `__Secure-` prefix). */
export const SESSION_COOKIE = "minerva.session_token";

/** RFC 6238 with Better Auth's settings (SHA-1, 6 digits, 30 s) for the secret in an `otpauth://` URI. */
export async function totp(uri: string, at = Date.now()): Promise<string> {
	const encoded = new URL(uri).searchParams.get("secret") ?? "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of encoded.replace(/=+$/, "").toUpperCase()) {
		buffer = (buffer << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 255);
		}
	}
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(at / 30_000)));
	const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
	const offset = mac[19]! & 15;
	const value = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
	return String(value % 1_000_000).padStart(6, "0");
}

/** The code for the next time step, which Better Auth still accepts (it allows one step either side). */
export function nextTotp(uri: string): Promise<string> {
	return totp(uri, Date.now() + 30_000);
}

/** Turns two-factor on for a signed-in browser's user: the TOTP URI and backup codes. */
export async function enableTwoFactor(browser: Browser): Promise<{ uri: string; backupCodes: string[] }> {
	const enabled = await browser.auth("/two-factor/enable", { password: PASSWORD });
	expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
	const uri: string = enabled.body.totpURI;
	const verified = await browser.auth("/two-factor/verify-totp", { code: await totp(uri) });
	expect(verified.status, JSON.stringify(verified.body)).toBe(200);
	return { uri, backupCodes: enabled.body.backupCodes };
}
