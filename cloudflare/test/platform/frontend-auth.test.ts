// The frontend's auth client (frontend/src/lib/auth.ts, auth-client.ts and account.ts) against the Worker: the
// steps the sign-in, sign-up, verification, code, two-factor, reset and account pages take, the step each leaves
// pending, and the field a failure names. No page is rendered. Signing in and signing out load a whole page in
// the app, which cannot happen here: a step answers `signed-in`, and a sign-out resolves only once the server
// has ended the session; the pages act on those. The browser walk (test/account) drives the pages.
// The client reaches the Worker through a Browser's cookie jar in place of `fetch`.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCheapHashing } from "./cheap-hashing.ts";
import { Browser, ORIGIN, PASSWORD, installEmailLog, lastCode, emailsTo, nextTotp, totp, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

type Anonymous = { kind: "anonymous"; pending: string | null };
type State = { kind: "authenticated"; user: { id: string; email: string } } | Anonymous;
type StepResult = { kind: "signed-in" } | Anonymous;
interface Frontend {
	auth: {
		login(v: { email: string; password: string }): Promise<StepResult>;
		signup(v: { email: string; password: string }): Promise<StepResult>;
		verifyEmail(v: { code: string }): Promise<StepResult>;
		resendVerification(): Promise<void>;
		requestLoginCode(v: { email: string }): Promise<StepResult>;
		confirmLoginCode(v: { code: string }): Promise<StepResult>;
		confirmSecondFactor(v: { code: string }): Promise<StepResult>;
		requestPasswordReset(v: { email: string }): Promise<StepResult>;
		resetPassword(v: { code: string; password: string }): Promise<StepResult>;
		logout(): Promise<void>;
	};
	account: {
		changePassword(v: { current: string; next: string }): Promise<void>;
		twoFactorEnabled(): Promise<boolean>;
		startTwoFactor(password: string): Promise<{ uri: string; secret: string; recoveryCodes: string[] }>;
		confirmTwoFactor(code: string): Promise<void>;
		disableTwoFactor(password: string): Promise<void>;
		newRecoveryCodes(password: string): Promise<string[]>;
	};
	authQuery: { queryKey: unknown[] };
	authStep(run: (vars: never) => Promise<StepResult>): object;
	AuthError: new (...args: never[]) => Error & { endsStep: boolean };
	fieldErrors(error: unknown): Record<string, string>;
}
/** The frontend's own copy of TanStack Query, the one its modules use. */
interface Query {
	QueryClient: new () => QueryClient;
	MutationObserver: new (client: QueryClient, options: object) => { mutate(vars: unknown): Promise<StepResult> };
}
interface QueryClient {
	fetchQuery(options: object): Promise<State>;
	getQueryData(key: unknown): unknown;
	setQueryData(key: unknown, data: unknown): void;
	getQueryCache(): { getAll(): Array<{ state: { data: unknown } }> };
}

class MemoryStorage {
	readonly #items = new Map<string, string>();
	getItem = (key: string) => this.#items.get(key) ?? null;
	setItem = (key: string, value: string) => void this.#items.set(key, value);
	removeItem = (key: string) => void this.#items.delete(key);
	get contents() {
		return JSON.stringify([...this.#items]);
	}
}

let browser: Browser;
let frontend: Frontend;
let query: Query;
let storage: MemoryStorage;
/** What the next sign-out request meets: the server, no network, or a server error. */
let signOutFails: "no" | "network" | "server" = "no";

/** The client as a page loads it: fresh module state, the browser's cookies behind `fetch`. */
async function load(next = new Browser()): Promise<void> {
	browser = next;
	signOutFails = "no";
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
		if (new URL(request.url).pathname === "/api/auth/sign-out") {
			if (signOutFails === "network") throw new TypeError("fetch failed");
			if (signOutFails === "server") return new Response("<html>restarting</html>", { status: 502, headers: { "Content-Type": "text/html" } });
		}
		return browser.fetch(request);
	});
	vi.resetModules();
	await useCheapHashing();
	const [auth, client, account, tanstack] = await Promise.all([
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
		import("@/lib/auth.ts"),
		// @ts-expect-error As above.
		import("@/lib/auth-client.ts"),
		// @ts-expect-error As above.
		import("@/lib/account.ts"),
		// @ts-expect-error As above.
		import("@/../node_modules/@tanstack/react-query"),
	]);
	frontend = { ...auth, ...client, ...account } as Frontend;
	query = tanstack as Query;
}

beforeEach(async () => {
	storage = new MemoryStorage();
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("sessionStorage", storage);
	await load();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Who the server says is signed in, as a page that has just loaded asks. */
const state = () => new query.QueryClient().fetchQuery(frontend.authQuery);
const signedIn = { kind: "signed-in" };
const noStep = { kind: "anonymous", pending: null };

/** What a failing step throws, as the pages read it. */
async function failure(step: Promise<unknown>): Promise<{ message: string; fields: Record<string, string> }> {
	const error = await step.then(
		() => expect.unreachable("the step did not fail"),
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(frontend.AuthError);
	return { message: (error as Error).message, fields: frontend.fieldErrors(error) };
}

/** Signs up and verifies through the client, which signs in with the password it held. */
async function newAccount(email = uniqueEmail()): Promise<string> {
	expect(await frontend.auth.signup({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify-email" });
	expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual(signedIn);
	return email;
}

async function withTwoFactor(email: string): Promise<{ uri: string; recoveryCodes: string[] }> {
	const started = await frontend.account.startTwoFactor(PASSWORD);
	await frontend.account.confirmTwoFactor(await totp(started.uri));
	return started;
}

describe("sign-up, verification and sign-in", () => {
	test("sign-up waits for the emailed code, which verifies the address and signs in", async () => {
		const email = uniqueEmail();
		expect(await state()).toEqual(noStep);
		expect(await frontend.auth.signup({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify-email" });
		// The step survives a reload (a new module, the same sessionStorage), which holds the address and no secret.
		await load(browser);
		expect(await state()).toEqual({ kind: "anonymous", pending: "verify-email" });
		expect(storage.contents).toContain(email);
		expect(storage.contents).not.toContain(PASSWORD);

		expect(await failure(frontend.auth.verifyEmail({ code: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		await frontend.auth.resendVerification();
		// The reload forgot the password, so verifying leaves signing in to the sign-in page.
		expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual(noStep);
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual(signedIn);

		// /api/me is the source of the state, and fills the `me` query the app reads.
		const queryClient = new query.QueryClient();
		expect(await queryClient.fetchQuery(frontend.authQuery)).toMatchObject({ kind: "authenticated", user: { email } });
		const cached = queryClient.getQueryCache().getAll().map((entry) => entry.state.data);
		expect(cached).toContainEqual(expect.objectContaining({ user: expect.objectContaining({ email }), workspaces: [expect.objectContaining({ kind: "personal" })] }));
	});

	test("sign-up errors name the field", async () => {
		const weak = await failure(frontend.auth.signup({ email: uniqueEmail(), password: "short" }));
		expect(weak.fields.password).toMatch(/too short/);
		const numeric = await failure(frontend.auth.signup({ email: uniqueEmail(), password: "12345678901234" }));
		expect(Object.keys(numeric.fields)).toEqual(["password"]);
		expect(await failure(frontend.auth.signup({ email: "not an address", password: PASSWORD }))).toEqual({ message: "Enter a valid email address.", fields: { email: "Enter a valid email address." } });
	});

	test("a taken address looks like a new one, and no code ever works for it", async () => {
		const email = await newAccount();
		await load();
		expect(await frontend.auth.signup({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify-email" });
		expect((await failure(frontend.auth.verifyEmail({ code: "123456" }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("a wrong password and an unknown address get the same answer, on the password field", async () => {
		const email = await newAccount();
		await load();
		const expected = { message: "The email address or password is not correct.", fields: { password: "The email address or password is not correct." } };
		expect(await failure(frontend.auth.login({ email, password: "not the password" }))).toEqual(expected);
		expect(await failure(frontend.auth.login({ email: uniqueEmail("nobody"), password: PASSWORD }))).toEqual(expected);
	});

	test("an unverified account that signs in with its password is sent a code and goes on to verify", async () => {
		const email = uniqueEmail();
		expect((await new Browser().auth("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBe(200);
		const before = emailsTo(email).length;
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify-email" });
		expect(emailsTo(email).length).toBe(before + 1);
		expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual(signedIn);
		expect(await state()).toMatchObject({ kind: "authenticated", user: { email } });
	});

	test("an expired verification code leaves the step open, and a new code finishes it", async () => {
		const email = uniqueEmail();
		await frontend.auth.signup({ email, password: PASSWORD });
		const stale = lastCode(email);
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * 60_000 });
		const expired = "That code has expired. Request a new one.";
		expect(await failure(frontend.auth.verifyEmail({ code: stale }))).toEqual({ message: expired, fields: { code: expired } });
		expect(await state()).toEqual({ kind: "anonymous", pending: "verify-email" });
		await frontend.auth.resendVerification();
		expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual(signedIn);
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
});

describe("sign-in by email code", () => {
	test("a code signs in, a wrong one is an incorrect code, and an unknown address looks the same", async () => {
		const email = await newAccount();
		await load();
		const before = emailsTo(email).length;
		expect(await frontend.auth.requestLoginCode({ email })).toEqual({ kind: "anonymous", pending: "sign-in-code" });
		expect(emailsTo(email).length).toBe(before + 1);
		expect(await failure(frontend.auth.confirmLoginCode({ code: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		expect(await frontend.auth.confirmLoginCode({ code: lastCode(email) })).toEqual(signedIn);
		expect(await state()).toMatchObject({ kind: "authenticated", user: { email } });

		await load();
		const stranger = uniqueEmail("nobody");
		expect(await frontend.auth.requestLoginCode({ email: stranger })).toEqual({ kind: "anonymous", pending: "sign-in-code" });
		expect(emailsTo(stranger)).toEqual([]);
		expect((await failure(frontend.auth.confirmLoginCode({ code: "123456" }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("a step goes on while storage refuses it (full, say), and ends even when storage cannot forget it", async () => {
		const email = await newAccount();
		const full = () => {
			throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
		};
		storage.setItem = full;
		await load();
		expect(await frontend.auth.requestLoginCode({ email })).toEqual({ kind: "anonymous", pending: "sign-in-code" });
		expect(await state()).toEqual({ kind: "anonymous", pending: "sign-in-code" });
		expect(await frontend.auth.confirmLoginCode({ code: lastCode(email) })).toEqual(signedIn);

		storage = new MemoryStorage();
		vi.stubGlobal("sessionStorage", storage);
		await load();
		await frontend.auth.requestLoginCode({ email });
		storage.removeItem = full;
		await frontend.auth.logout();
		expect(await state()).toEqual(noStep);
	});

	test("a pending step ends when its time runs out, and says so", async () => {
		const email = await newAccount();
		await load();
		await frontend.auth.requestLoginCode({ email });
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60_000 + 1_000 });
		expect(await state()).toEqual(noStep);
		const timedOut = await failure(frontend.auth.confirmLoginCode({ code: lastCode(email) }));
		expect(timedOut.message).toBe("That step timed out. Go back to sign in and start again.");
		expect((await failure(frontend.auth.verifyEmail({ code: "123456" }))).message).toBe(timedOut.message);
	});

	test("as a mutation, a step's answer becomes the cached state, and three wrong codes take the step out of it", async () => {
		const email = await newAccount();
		await load();
		const queryClient = new query.QueryClient();
		const step = (run: (vars: never) => Promise<StepResult>) => new query.MutationObserver(queryClient, frontend.authStep(run));
		await step(frontend.auth.requestLoginCode).mutate({ email });
		expect(queryClient.getQueryData(frontend.authQuery.queryKey)).toEqual({ kind: "anonymous", pending: "sign-in-code" });
		for (let attempt = 0; attempt < 3; attempt++) await failure(step(frontend.auth.confirmLoginCode).mutate({ code: "000000" }));
		// Better Auth also limits sign-ins per address to three in ten seconds; the fourth try comes from another IP.
		browser = new Browser();
		const code = lastCode(email);
		await expect(step(frontend.auth.confirmLoginCode).mutate({ code })).rejects.toMatchObject({ message: "Too many incorrect codes. Request a new one.", endsStep: true });
		expect(queryClient.getQueryData(frontend.authQuery.queryKey)).toEqual(noStep);
		expect(await state()).toEqual(noStep);
	});
});

describe("two-factor", () => {
	test("setup takes the password and a code; sign-in then asks for a code or a recovery code", async () => {
		const email = await newAccount();
		const { account } = frontend;
		expect(await account.twoFactorEnabled()).toBe(false);
		expect(await failure(account.startTwoFactor("not the password"))).toMatchObject({ message: "That password is not correct." });
		const started = await account.startTwoFactor(PASSWORD);
		expect(started.uri).toMatch(/^otpauth:\/\/totp\//);
		expect(started.secret).toMatch(/^[A-Z2-7]+$/);
		expect(started.recoveryCodes).toHaveLength(10);
		expect(await account.twoFactorEnabled()).toBe(false);
		expect((await failure(account.confirmTwoFactor("000000"))).fields).toEqual({ code: "Incorrect code." });
		await account.confirmTwoFactor(await totp(started.uri));
		expect(await account.twoFactorEnabled()).toBe(true);

		// A fresh browser: the password gets only to the second factor.
		await load();
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "second-factor" });
		expect(await state()).toEqual({ kind: "anonymous", pending: "second-factor" });
		expect(await failure(frontend.auth.confirmSecondFactor({ code: "000000" }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		// Authenticator apps show the digits in two groups. A code works once: this is the next step's.
		const code = await nextTotp(started.uri);
		expect(await frontend.auth.confirmSecondFactor({ code: `${code.slice(0, 3)} ${code.slice(3)}` })).toEqual(signedIn);
		expect(await state()).toMatchObject({ kind: "authenticated", user: { email } });

		// A recovery code works once, typed with or without its hyphen.
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		const recovery = started.recoveryCodes[0]!;
		expect(await frontend.auth.confirmSecondFactor({ code: recovery.replace("-", "") })).toEqual(signedIn);
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		expect((await failure(frontend.auth.confirmSecondFactor({ code: recovery }))).fields).toEqual({ code: "Incorrect code." });
	});

	test("an email code and a verification that signs in go on to the second factor too", async () => {
		const email = await newAccount();
		await withTwoFactor(email);
		await load();
		await frontend.auth.requestLoginCode({ email });
		expect(await frontend.auth.confirmLoginCode({ code: lastCode(email) })).toEqual({ kind: "anonymous", pending: "second-factor" });
		expect(await state()).toEqual({ kind: "anonymous", pending: "second-factor" });

		// An address that must be verified again: the sign-in after verifying asks for the second factor as well.
		await env.DB.prepare(`UPDATE "user" SET "emailVerified" = 0 WHERE email = ?`).bind(email).run();
		await load();
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual({ kind: "anonymous", pending: "verify-email" });
		expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual({ kind: "anonymous", pending: "second-factor" });
		expect(await state()).toEqual({ kind: "anonymous", pending: "second-factor" });
	});

	test("a sign-in that waited too long for its second factor is over", async () => {
		const email = await newAccount();
		const started = await withTwoFactor(email);
		await load();
		await frontend.auth.login({ email, password: PASSWORD });
		browser.cookies.delete("minerva.two_factor"); // the cookie's ten minutes ran out
		const error = await frontend.auth.confirmSecondFactor({ code: await nextTotp(started.uri) }).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ message: "Your sign-in timed out. Sign in again.", endsStep: true });
		expect(frontend.fieldErrors(error)).toEqual({});
	});

	test("recovery codes can be replaced, and two-factor can be turned off with the password", async () => {
		const email = await newAccount();
		const { account } = frontend;
		const started = await withTwoFactor(email);
		expect((await failure(account.newRecoveryCodes("not the password"))).message).toBe("That password is not correct.");
		const fresh = await account.newRecoveryCodes(PASSWORD);
		expect(fresh).toHaveLength(10);
		expect(fresh).not.toEqual(started.recoveryCodes);
		expect((await failure(account.disableTwoFactor("not the password"))).message).toBe("That password is not correct.");
		await account.disableTwoFactor(PASSWORD);
		expect(await account.twoFactorEnabled()).toBe(false);
		await load();
		expect(await frontend.auth.login({ email, password: PASSWORD })).toEqual(signedIn);
	});
});

describe("password reset and change", () => {
	test("a reset code sets the password, leads back to sign-in, and signs every session out", async () => {
		const email = await newAccount();
		const signedInBrowser = browser;
		await load();
		const { auth } = frontend;
		expect(await auth.requestPasswordReset({ email })).toEqual({ kind: "anonymous", pending: "password-reset" });
		const code = lastCode(email);
		const another = "another long enough passphrase";
		expect(await failure(auth.resetPassword({ code: "000000", password: another }))).toEqual({ message: "Incorrect code.", fields: { code: "Incorrect code." } });
		expect((await failure(auth.resetPassword({ code, password: "short" }))).fields.password).toMatch(/too short/);
		expect(await auth.resetPassword({ code, password: another })).toEqual(noStep);
		expect(await auth.login({ email, password: another })).toEqual(signedIn);

		await load(signedInBrowser);
		expect(await state()).toEqual(noStep);
	});

	test("an unknown address is told the same, and no email goes out", async () => {
		const stranger = uniqueEmail("nobody");
		expect(await frontend.auth.requestPasswordReset({ email: stranger })).toEqual({ kind: "anonymous", pending: "password-reset" });
		expect(emailsTo(stranger)).toEqual([]);
	});

	test("changing the password keeps this session, ends the others, and names the field that is wrong", async () => {
		const email = await newAccount();
		const other = new Browser();
		await other.auth("/sign-in/email", { email, password: PASSWORD });
		const another = "another long enough passphrase";
		expect(await failure(frontend.account.changePassword({ current: "not the password", next: another }))).toEqual({
			message: "That password is not correct.",
			fields: { currentPassword: "That password is not correct." },
		});
		expect((await failure(frontend.account.changePassword({ current: PASSWORD, next: "short" }))).fields.password).toMatch(/too short/);
		await frontend.account.changePassword({ current: PASSWORD, next: another });
		expect((await state()).kind).toBe("authenticated");
		expect((await other.call("GET", "/api/me")).status).toBe(401);
	});
});

describe("signing out", () => {
	test("resolves once the server has ended the session, and again when there was none", async () => {
		await newAccount();
		await frontend.auth.logout();
		expect(await state()).toEqual(noStep);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		await frontend.auth.logout();
	});

	test("a sign-out the server cannot be asked for, or that it fails, leaves the user signed in", async () => {
		await newAccount();
		signOutFails = "network";
		expect(await failure(frontend.auth.logout())).toEqual({ message: "The server could not be reached.", fields: {} });
		signOutFails = "server";
		expect(await failure(frontend.auth.logout())).toEqual({ message: "The server could not complete this step.", fields: {} });
		expect((await state()).kind).toBe("authenticated");
	});
});

test("a form whose submit handler fails does not leave an unhandled rejection (a refused sign-in)", async () => {
	// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it.
	const { submitForm } = (await import("@/components/form.tsx")) as { submitForm(form: unknown): (event: unknown) => void };
	let submitted = 0;
	let last: unknown;
	const form = {
		handleSubmit: async () => {
			submitted++;
			await frontend.auth.login({ email: uniqueEmail(), password: "not the password" }).catch((error: unknown) => {
				last = error;
				throw error;
			});
		},
	};
	let prevented = false;
	submitForm(form)({ preventDefault: () => void (prevented = true) });
	await vi.waitFor(() => expect(last).toBeInstanceOf(frontend.AuthError));
	// An unhandled rejection would fail the run (vitest reports it); the handler ran and the event was claimed.
	expect([prevented, submitted]).toEqual([true, 1]);
}, 30_000);

test("too many sign-ins in a short time say to wait", async () => {
	const email = await newAccount();
	await load();
	let last = "";
	for (let attempt = 0; attempt < 8; attempt++) {
		last = (await failure(frontend.auth.login({ email, password: "not the password" }))).message;
		if (last !== "The email address or password is not correct.") break;
	}
	expect(["Too many attempts. Wait a moment and try again.", "Too many failed sign-in attempts. Try again later."]).toContain(last);
});
