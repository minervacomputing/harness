// The frontend's auth client (frontend/src/lib/auth.ts, step 5a4) run against the Worker: the steps the
// sign-in, sign-up, verification, code, two-factor, reset and account pages take, with the pending step they
// keep, the state they report and the sentences they show. No page is rendered; 5f drives the pages in a
// browser. The client reaches the Worker through a Browser's cookie jar in place of `fetch`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCheapHashing } from "./cheap-hashing.ts";
import { Browser, ORIGIN, PASSWORD, installEmailLog, lastCode, emailsTo, nextTotp, totp, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

type State = { kind: "authenticated"; user: { id: string; email: string } } | { kind: "anonymous"; pending: string | null; mfaTypes: string[] };
interface Frontend {
	auth: {
		login(v: { email: string; password: string }): Promise<State>;
		signup(v: { email: string; password: string }): Promise<State>;
		verifyEmail(v: { key: string }): Promise<State>;
		resendVerification(): Promise<void>;
		requestLoginCode(v: { email: string }): Promise<State>;
		confirmLoginCode(v: { code: string }): Promise<State>;
		mfaAuthenticate(v: { code: string }): Promise<State>;
		requestPasswordReset(v: { email: string }): Promise<State>;
		resetPassword(v: { key: string; password: string }): Promise<State>;
		logout(): Promise<void>;
		account: {
			changePassword(v: { current: string; next: string }): Promise<void>;
			twoFactorEnabled(): Promise<boolean>;
			startTwoFactor(password: string): Promise<{ uri: string; secret: string; recoveryCodes: string[] }>;
			confirmTwoFactor(code: string): Promise<void>;
			disableTwoFactor(password: string): Promise<void>;
			newRecoveryCodes(password: string): Promise<string[]>;
		};
	};
	authQuery: { queryKey: unknown[]; queryFn(context: { client: QueryCache; signal: AbortSignal }): Promise<State> };
	runAuthStep<Vars>(client: QueryCache, step: (vars: Vars) => Promise<State>, vars: Vars): Promise<State>;
	signOut(client: QueryCache, goToLogin: () => Promise<unknown>): Promise<void>;
	isSigningOut(): boolean;
	AuthError: new (...args: never[]) => Error & { fields: Record<string, string> };
	fieldErrors(error: unknown): Record<string, string>;
}

/** The part of a QueryClient the auth query uses; react-query itself is the frontend's, not this project's. */
class QueryCache {
	readonly data = new Map<string, unknown>();
	/** What was called on the client, in order, for the tests of what a sign-out does and when. */
	readonly calls: string[] = [];
	setQueryData(key: unknown, value: unknown): void {
		this.calls.push("set");
		this.data.set(JSON.stringify(key), value);
	}
	removeQueries(): void {
		this.data.clear();
	}
	async cancelQueries(): Promise<void> {
		this.calls.push("cancel");
	}
	clear(): void {
		this.calls.push("clear");
		this.data.clear();
	}
	async invalidateQueries(): Promise<void> {
		this.calls.push("invalidate");
	}
}

class MemoryStorage {
	readonly #items = new Map<string, string>();
	getItem = (key: string) => this.#items.get(key) ?? null;
	setItem = (key: string, value: string) => void this.#items.set(key, value);
	removeItem = (key: string) => void this.#items.delete(key);
}

let browser: Browser;
let frontend: Frontend;
let queryClient: QueryCache;
/** The requests the page's `fetch` sent since it loaded, as "METHOD /path". */
let requests: string[] = [];
/** How many sessions the page has ended (frontend/src/lib/session.ts), which work that waits checks. */
let sessionsEnded: () => number;
let failSignOut = false;

/** The client as a page loads it: fresh module state, the browser's cookies behind `fetch`. */
async function load(next = new Browser()): Promise<void> {
	browser = next;
	requests = [];
	failSignOut = false;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
		requests.push(`${request.method} ${new URL(request.url).pathname}`);
		if (failSignOut && new URL(request.url).pathname === "/api/auth/sign-out") throw new TypeError("fetch failed");
		return browser.fetch(request);
	});
	vi.resetModules();
	await useCheapHashing();
	// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
	frontend = (await import("@/lib/auth.ts")) as Frontend;
	// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
	sessionsEnded = ((await import("@/lib/session.ts")) as { sessionsEnded(): number }).sessionsEnded;
	queryClient = new QueryCache();
}

beforeEach(async () => {
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("sessionStorage", new MemoryStorage());
	await load();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const state = () => frontend.authQuery.queryFn({ client: queryClient, signal: new AbortController().signal });
/** What the app has cached as the auth state. */
const cached = () => queryClient.data.get(JSON.stringify(frontend.authQuery.queryKey));

/** What a failing step throws, as the pages read it. */
async function failure(step: Promise<unknown>): Promise<{ message: string; fields: Record<string, string> }> {
	try {
		await step;
	} catch (error) {
		expect(error).toBeInstanceOf(frontend.AuthError);
		return { message: (error as Error).message, fields: frontend.fieldErrors(error) };
	}
	throw new Error("The step did not fail");
}

/** Signs up and verifies through the client; the password is held, so verifying signs in. */
async function newAccount(email = uniqueEmail()): Promise<string> {
	const { auth } = frontend;
	expect(await auth.signup({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify_email", mfaTypes: [] });
	const signed = await auth.verifyEmail({ key: lastCode(email) });
	expect(signed).toMatchObject({ kind: "authenticated", user: { email } });
	return email;
}

describe("sign-up, verification and sign-in", () => {
	test("sign-up waits for the emailed code, which verifies the address and signs in", async () => {
		const { auth } = frontend;
		const email = uniqueEmail();
		expect(await state()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });

		expect(await auth.signup({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify_email", mfaTypes: [] });
		// The step survives a reload of the page (a new module with the same sessionStorage).
		expect(await state()).toMatchObject({ pending: "verify_email" });

		expect(await failure(auth.verifyEmail({ key: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		const signed = await auth.verifyEmail({ key: lastCode(email) });
		expect(signed).toMatchObject({ kind: "authenticated", user: { email } });

		// /api/me is the source of the state, and fills the `me` query the app reads.
		queryClient = new QueryCache();
		const reread = await state();
		expect(reread).toEqual({ kind: "authenticated", user: { id: (signed as { user: { id: string } }).user.id, email } });
		const [me] = [...queryClient.data.values()] as { user: { email: string }; workspaces: unknown[] }[];
		expect(me).toMatchObject({ user: { email }, workspaces: [{ kind: "personal" }] });
	});

	test("sign-up errors name the field", async () => {
		const { auth } = frontend;
		const weak = await failure(auth.signup({ email: uniqueEmail(), password: "short" }));
		expect(weak.fields.password).toMatch(/too short/);
		const numeric = await failure(auth.signup({ email: uniqueEmail(), password: "12345678901234" }));
		expect(Object.keys(numeric.fields)).toEqual(["password"]);
		expect(await failure(auth.signup({ email: "not an address", password: PASSWORD }))).toEqual({ message: "Enter a valid email address.", fields: { email: "Enter a valid email address." } });
	});

	test("a taken address looks like a new one and no code ever works", async () => {
		const email = await newAccount();
		await load();
		expect(await frontend.auth.signup({ email, password: PASSWORD })).toMatchObject({ pending: "verify_email" });
		expect((await failure(frontend.auth.verifyEmail({ key: "123456" }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("signing in with the wrong password or an unknown address gives allauth's sentence on the password field", async () => {
		const email = await newAccount();
		await load();
		const expected = { message: "The email address and/or password you specified are not correct.", fields: { password: "The email address and/or password you specified are not correct." } };
		expect(await failure(frontend.auth.login({ email, password: "not the password" }))).toEqual(expected);
		expect(await failure(frontend.auth.login({ email: uniqueEmail("nobody"), password: PASSWORD }))).toEqual(expected);
	});

	test("an unverified account that signs in with its password is sent a code and goes on to verify", async () => {
		const email = uniqueEmail();
		expect((await new Browser().auth("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBe(200);
		await load();
		const before = emailsTo(email).length;
		const next = await frontend.auth.login({ email, password: PASSWORD });
		expect(next).toEqual({ kind: "anonymous", pending: "verify_email", mfaTypes: [] });
		expect(emailsTo(email).length).toBe(before + 1);
		// The password was right, so it is still at hand and verifying signs in.
		expect(await frontend.auth.verifyEmail({ key: lastCode(email) })).toMatchObject({ kind: "authenticated", user: { email } });
	});

	test("verifying after a reload ends at the sign-in page: the password was only in memory", async () => {
		const email = uniqueEmail();
		await frontend.auth.signup({ email, password: PASSWORD });
		await load(browser); // a reload: the module is new, sessionStorage keeps the pending step
		expect(await state()).toMatchObject({ pending: "verify_email" });
		// Asking again within ten seconds of the last code is refused by the server, which is fine: one is on its way.
		await frontend.auth.resendVerification();
		expect(await frontend.auth.verifyEmail({ key: lastCode(email) })).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
		expect(await frontend.auth.login({ email, password: PASSWORD })).toMatchObject({ kind: "authenticated" });
	});

	test("an expired verification code leaves the step open, and a new code finishes it", async () => {
		const email = uniqueEmail();
		await frontend.auth.signup({ email, password: PASSWORD });
		const stale = lastCode(email);
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * 60_000 });
		try {
			expect(await failure(frontend.auth.verifyEmail({ key: stale }))).toEqual({ message: "That code has expired. Request a new one.", fields: { code: "That code has expired. Request a new one." } });
			expect(await state()).toMatchObject({ pending: "verify_email" });
			await frontend.auth.resendVerification();
			expect(await frontend.auth.verifyEmail({ key: lastCode(email) })).toMatchObject({ kind: "authenticated", user: { email } });
		} finally {
			vi.useRealTimers();
		}
	});

	test("asking again at once is fine (a code just went out); the limit per IP is an error, not a sent code", async () => {
		const email = uniqueEmail();
		await frontend.auth.signup({ email, password: PASSWORD });
		const sent = emailsTo(email).length;
		await frontend.auth.resendVerification(); // sends
		await frontend.auth.resendVerification(); // our 10 s limit per address: the code from a moment ago stands
		expect(emailsTo(email).length).toBe(sent + 1);
		// The IP limit on code requests is ten in a minute (ip-limits.ts): the next eight pass, the eleventh is refused.
		for (let request = 3; request <= 10; request++) await frontend.auth.resendVerification();
		expect(await failure(frontend.auth.resendVerification())).toEqual({ message: "Too many attempts. Wait a moment and try again.", fields: {} });
		expect(emailsTo(email).length).toBe(sent + 1);
	});

	test("a step whose pending state is gone says so", async () => {
		expect((await failure(frontend.auth.verifyEmail({ key: "123456" }))).message).toBe("That step timed out. Go back to sign in and start again.");
		expect((await failure(frontend.auth.confirmLoginCode({ code: "123456" }))).message).toBe("That step timed out. Go back to sign in and start again.");
	});

	test("sign-out ends the session", async () => {
		await newAccount();
		expect((await state()).kind).toBe("authenticated");
		await frontend.auth.logout();
		expect(await state()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
	});
});

describe("sign-in by email code", () => {
	test("a code signs in, a wrong one is Incorrect code, and an unknown address looks the same", async () => {
		const email = await newAccount();
		await load();
		const { auth } = frontend;
		const before = emailsTo(email).length;
		expect(await auth.requestLoginCode({ email })).toEqual({ kind: "anonymous", pending: "login_by_code", mfaTypes: [] });
		expect(emailsTo(email).length).toBe(before + 1);
		expect(await failure(auth.confirmLoginCode({ code: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		expect(await auth.confirmLoginCode({ code: lastCode(email) })).toMatchObject({ kind: "authenticated", user: { email } });

		await load();
		const stranger = uniqueEmail("nobody");
		expect(await frontend.auth.requestLoginCode({ email: stranger })).toMatchObject({ pending: "login_by_code" });
		expect(emailsTo(stranger)).toEqual([]);
		expect((await failure(frontend.auth.confirmLoginCode({ code: "123456" }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("a delayed /api/me answer cannot refill the cache after it was cleared", async () => {
		await newAccount();
		const controller = new AbortController();
		// The answer arrives after the request was cancelled (a sign-out or a new sign-in cleared the cache).
		const answer = browser.fetch;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const response = await answer(input, init);
			controller.abort();
			return response;
		});
		await expect(frontend.authQuery.queryFn({ client: queryClient, signal: controller.signal })).rejects.toBeDefined();
		expect(queryClient.data.size).toBe(0);
	});

	test("three wrong codes end the step: the next sentence says to ask again, and the step is gone", async () => {
		const email = await newAccount();
		await load();
		await frontend.auth.requestLoginCode({ email });
		for (let attempt = 0; attempt < 3; attempt++) await failure(frontend.auth.confirmLoginCode({ code: "000000" }));
		// Better Auth also limits sign-ins per address to three in ten seconds; the fourth try comes from another one.
		await load(new Browser());
		// The app's cache says the step is pending; the failure that ends it takes it out (what useAuthStep does).
		queryClient.setQueryData(frontend.authQuery.queryKey, { kind: "anonymous", pending: "login_by_code", mfaTypes: [] });
		const code = lastCode(email);
		await expect(frontend.runAuthStep(queryClient, frontend.auth.confirmLoginCode, { code })).rejects.toMatchObject({ message: "Too many incorrect codes. Request a new one.", endsStep: true });
		expect(cached()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
		expect(await state()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
	});

	test("a step that succeeds replaces the cache; becoming signed in drops what was cached before", async () => {
		const email = await newAccount();
		await load();
		queryClient.setQueryData(["me"], { user: { email: "someone-else@example.com" } });
		const next = await frontend.runAuthStep(queryClient, frontend.auth.login, { email, password: PASSWORD });
		expect(next).toMatchObject({ kind: "authenticated", user: { email } });
		expect([...queryClient.data.keys()]).toEqual([JSON.stringify(frontend.authQuery.queryKey)]);
		expect(cached()).toEqual(next);
	});
});

describe("two-factor", () => {
	test("setup takes the password and a code; sign-in then asks for a code or a recovery code", async () => {
		const email = await newAccount();
		const { auth } = frontend;
		expect(await auth.account.twoFactorEnabled()).toBe(false);
		expect(await failure(auth.account.startTwoFactor("not the password"))).toEqual({ message: "Incorrect password.", fields: {} });
		const started = await auth.account.startTwoFactor(PASSWORD);
		expect(started.uri).toMatch(/^otpauth:\/\/totp\//);
		expect(started.secret).toMatch(/^[A-Z2-7]+$/);
		expect(started.recoveryCodes).toHaveLength(10);
		expect(await auth.account.twoFactorEnabled()).toBe(false);
		expect((await failure(auth.account.confirmTwoFactor("000000"))).fields).toEqual({ code: "Incorrect code." });
		await auth.account.confirmTwoFactor(await totp(started.uri));
		expect(await auth.account.twoFactorEnabled()).toBe(true);
		expect((await state()).kind).toBe("authenticated");

		// A fresh browser: the password gets only to the second factor.
		await load();
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "mfa_authenticate", mfaTypes: ["totp"] });
		expect(await state()).toMatchObject({ kind: "anonymous", pending: "mfa_authenticate" });
		expect(await failure(frontend.auth.mfaAuthenticate({ code: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		// Authenticator apps show the digits in two groups. A code works once: this is the next step's.
		const code = await nextTotp(started.uri);
		expect(await frontend.auth.mfaAuthenticate({ code: `${code.slice(0, 3)} ${code.slice(3)}` })).toMatchObject({ kind: "authenticated", user: { email } });

		// A recovery code works once, typed with or without its hyphen.
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		const recovery = started.recoveryCodes[0]!;
		expect(await frontend.auth.mfaAuthenticate({ code: recovery.replace("-", "") })).toMatchObject({ kind: "authenticated" });
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		expect((await failure(frontend.auth.mfaAuthenticate({ code: recovery }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("a sign-in that waited too long for its second factor is over", async () => {
		const email = await newAccount();
		const started = await frontend.auth.account.startTwoFactor(PASSWORD);
		await frontend.auth.account.confirmTwoFactor(await totp(started.uri));
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		browser.cookies.delete("minerva.two_factor"); // the cookie's ten minutes ran out
		expect(await failure(frontend.auth.mfaAuthenticate({ code: await totp(started.uri) }))).toEqual({ message: "Your sign-in timed out. Sign in again.", fields: {} });
		expect(await state()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
	});

	test("an email code for a two-factor user goes on to the second factor too", async () => {
		const email = await newAccount();
		const started = await frontend.auth.account.startTwoFactor(PASSWORD);
		await frontend.auth.account.confirmTwoFactor(await totp(started.uri));
		await load();
		await frontend.auth.requestLoginCode({ email });
		expect(await frontend.auth.confirmLoginCode({ code: lastCode(email) })).toMatchObject({ kind: "anonymous", pending: "mfa_authenticate" });
	});

	test("recovery codes can be replaced, and two-factor can be turned off with the password", async () => {
		const email = await newAccount();
		const { auth } = frontend;
		const started = await auth.account.startTwoFactor(PASSWORD);
		await auth.account.confirmTwoFactor(await totp(started.uri));
		expect(await failure(auth.account.newRecoveryCodes("not the password"))).toEqual({ message: "Incorrect password.", fields: {} });
		const fresh = await auth.account.newRecoveryCodes(PASSWORD);
		expect(fresh).toHaveLength(10);
		expect(fresh).not.toEqual(started.recoveryCodes);
		expect((await failure(auth.account.disableTwoFactor("not the password"))).message).toBe("Incorrect password.");
		await auth.account.disableTwoFactor(PASSWORD);
		expect(await auth.account.twoFactorEnabled()).toBe(false);
		await load();
		expect(await frontend.auth.login({ email, password: PASSWORD })).toMatchObject({ kind: "authenticated" });
	});
});

describe("password reset and change", () => {
	test("a reset code sets the password, ends the way on at sign-in, and signs every session out", async () => {
		const email = await newAccount();
		const signedIn = browser;
		await load();
		const { auth } = frontend;
		expect(await auth.requestPasswordReset({ email })).toEqual({ kind: "anonymous", pending: "password_reset_by_code", mfaTypes: [] });
		const code = lastCode(email);
		expect(await failure(auth.resetPassword({ key: "000000", password: "another long enough passphrase" }))).toEqual({ message: "Incorrect code.", fields: { key: "Incorrect code." } });
		expect((await failure(auth.resetPassword({ key: code, password: "short" }))).fields.password).toMatch(/too short/);
		expect(await auth.resetPassword({ key: code, password: "another long enough passphrase" })).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
		expect(await auth.login({ email, password: "another long enough passphrase" })).toMatchObject({ kind: "authenticated" });

		await load(signedIn);
		expect(await state()).toMatchObject({ kind: "anonymous" });
	});

	test("an unknown address is told the same and no email goes out", async () => {
		const stranger = uniqueEmail("nobody");
		expect(await frontend.auth.requestPasswordReset({ email: stranger })).toMatchObject({ pending: "password_reset_by_code" });
		expect(emailsTo(stranger)).toEqual([]);
	});

	test("changing the password keeps this session and names the field that is wrong", async () => {
		const email = await newAccount();
		const { auth } = frontend;
		const other = await (async () => {
			const second = new Browser();
			await second.auth("/sign-in/email", { email, password: PASSWORD });
			return second;
		})();
		expect(await failure(auth.account.changePassword({ current: "not the password", next: "another long enough passphrase" }))).toEqual({
			message: "Please type your current password.",
			fields: { current_password: "Please type your current password." },
		});
		expect((await failure(auth.account.changePassword({ current: PASSWORD, next: "short" }))).fields.new_password).toMatch(/too short/);
		await auth.account.changePassword({ current: PASSWORD, next: "another long enough passphrase" });
		expect((await state()).kind).toBe("authenticated");
		expect((await other.call("GET", "/api/me")).status).toBe(401);
	});
});

describe("signing out", () => {
	test("ends the session with one request, then leaves for the sign-in page before the cache is dropped, and nothing is fetched again", async () => {
		await newAccount();
		await state();
		queryClient.calls.length = 0;
		requests = [];
		const endedBefore = sessionsEnded();
		const during: boolean[] = [];
		await frontend.signOut(queryClient, async () => {
			during.push(frontend.isSigningOut());
			queryClient.calls.push("login");
		});
		// Everything in flight is cancelled first; the cache says signed out before the page changes (so the sign-in
		// page lets the visitor in, and the app shell is not sent there with a way back), and is dropped after.
		expect(queryClient.calls).toEqual(["cancel", "set", "login", "clear", "set"]);
		expect(requests).toEqual(["POST /api/auth/sign-out"]);
		expect(during).toEqual([true]);
		// Noted once the server ended the session, so a send waiting to be repeated knows not to.
		expect(sessionsEnded()).toBe(endedBefore + 1);
		expect(frontend.isSigningOut()).toBe(false);
		expect(cached()).toEqual({ kind: "anonymous", pending: null, mfaTypes: [] });
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("a sign-out the server cannot be asked for leaves the user signed in and fetches again what was cancelled", async () => {
		await newAccount();
		queryClient.calls.length = 0;
		failSignOut = true;
		const reached: string[] = [];
		const error = await failure(frontend.signOut(queryClient, async () => void reached.push("login")));
		expect(error.message).toBe("The server could not be reached.");
		expect(queryClient.calls).toEqual(["cancel", "invalidate"]);
		expect(reached).toEqual([]);
		expect(sessionsEnded()).toBe(0);
		expect(frontend.isSigningOut()).toBe(false);
		failSignOut = false;
		expect((await state()).kind).toBe("authenticated");
	});

	test("the next person signing in on this page sees their own account", async () => {
		const first = await newAccount();
		await frontend.signOut(queryClient, async () => undefined);
		const second = await newAccount();
		expect(second).not.toBe(first);
		expect(await state()).toMatchObject({ kind: "authenticated", user: { email: second } });
	});

	test("a form whose submit handler fails does not leave an unhandled rejection (a 429 on sign-in)", async () => {
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it.
		const { submitForm } = (await import("@/components/form.tsx")) as { submitForm(form: unknown): (event: unknown) => void };
		let rejected = 0;
		let last: unknown;
		const form = {
			handleSubmit: async () => {
				rejected++;
				try {
					await frontend.auth.login({ email: uniqueEmail(), password: "not the password" });
				} catch (error) {
					last = error;
					throw error;
				}
			},
		};
		let prevented = false;
		submitForm(form)({ preventDefault: () => void (prevented = true) });
		await new Promise((resolve) => setTimeout(resolve, 50));
		// An unhandled rejection would fail the run (vitest reports it); the handler ran and the event was claimed.
		expect([prevented, rejected]).toEqual([true, 1]);
		expect(last).toBeInstanceOf(frontend.AuthError);
	}, 30_000);
});

test("too many sign-ins in a short time say to wait", async () => {
	const email = await newAccount();
	await load();
	let last = "";
	for (let attempt = 0; attempt < 8; attempt++) {
		const outcome = await failure(frontend.auth.login({ email, password: "not the password" }));
		last = outcome.message;
		if (last !== "The email address and/or password you specified are not correct.") break;
	}
	expect(["Too many attempts. Wait a moment and try again.", "Too many failed login attempts. Try again later."]).toContain(last);
});
