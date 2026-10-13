// The security policy on Better Auth (src/accounts/policy.ts), through the Worker as the browser
// uses it: two factors for every sign-in, credential stamps ending sessions, email codes used once within
// their budget, limits per address and per user, the routes the browser reaches, who may create accounts,
// and the password rules.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { GenericEndpointContext } from "better-auth";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getAuth, handleAuth } from "../../src/accounts/auth.ts";
import { hashPassword } from "../../src/accounts/passwords.ts";
import { BROWSER_ROUTES, Policy } from "../../src/accounts/policy.ts";
import { RateLimits } from "../../src/accounts/rate-limits.ts";
import { runInScope } from "../../src/accounts/scope.ts";
import { claimTotpStep } from "../../src/accounts/totp.ts";
import { createApp } from "../../src/http/router.ts";
import { Browser, ORIGIN, PASSWORD, SESSION_COOKIE, emailsTo, enableTwoFactor, forgetUsedTotp, freezeClockInWindow, installEmailLog, lastCode, nextTotp, signUp, signedIn, totp, uniqueEmail, withProductionHashing } from "./accounts-helpers.ts";

installEmailLog();
afterEach(() => vi.useRealTimers());

const db = env.DB;
const NEW_PASSWORD = "another long enough passphrase";

/** The user's sessions that are still valid by date, as ids. */
async function liveSessions(userId: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM "session" WHERE "userId" = ? AND "expiresAt" > ? ORDER BY id`)
		.bind(userId, new Date().toISOString())
		.all<{ id: string }>();
	return results.map((row) => row.id);
}

async function allSessions(userId: string): Promise<number> {
	return (await db.prepare(`SELECT count(*) AS n FROM "session" WHERE "userId" = ?`).bind(userId).first<{ n: number }>())!.n;
}

async function userCount(email: string): Promise<number> {
	return (await db.prepare(`SELECT count(*) AS n FROM "user" WHERE email = ?`).bind(email).first<{ n: number }>())!.n;
}

const app = createApp();

/** A browser whose every request is served by a Better Auth instance of its own, as another isolate's would be. */
function isolatedBrowser(): Browser {
	return new Browser((request) => Promise.resolve(app.fetch(request, { ...env }, createExecutionContext())));
}

async function storedPassword(userId: string): Promise<string> {
	return (await db.prepare(`SELECT password FROM account WHERE "userId" = ?`).bind(userId).first<{ password: string }>())!.password;
}

/** A password reset by email code, from a browser of its own. */
async function resetPassword(email: string, password = NEW_PASSWORD): Promise<void> {
	const browser = new Browser();
	expect((await browser.auth("/email-otp/request-password-reset", { email })).status).toBe(200);
	const reset = await browser.auth("/email-otp/reset-password", { email, otp: lastCode(email), password });
	expect(reset.status, JSON.stringify(reset.body)).toBe(200);
}

/** A signed-in user with two-factor on, and a second browser that has passed only the password. */
async function waitingForSecondFactor() {
	const { browser: first, email, userId } = await signedIn();
	const { uri, backupCodes } = await enableTwoFactor(first);
	const browser = new Browser();
	const step = await browser.auth("/sign-in/email", { email, password: PASSWORD });
	expect(step.status).toBe(200);
	expect(step.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
	return { first, browser, email, userId, uri, backupCodes };
}

/** better-call's signed cookie value: `<value>.<base64 HMAC-SHA256>`, %-encoded. */
async function signCookie(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
	return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...signature))}`);
}

describe("two factors for every sign-in", () => {
	test("a password stops at the second factor: no session before it, and the waiting cookies reach nothing", async () => {
		const { first, browser, userId, uri } = await waitingForSecondFactor();
		expect((await first.call("GET", "/api/me")).status).toBe(200);
		const before = await liveSessions(userId);
		expect(before).toHaveLength(1);
		// Not even the placeholder: the first factor's session row is gone before the answer.
		expect(await allSessions(userId)).toBe(1);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect(browser.cookies.has("minerva.two_factor")).toBe(true);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await browser.auth("/get-session")).body).toBeNull();
		expect((await browser.auth("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
		expect((await browser.auth("/two-factor/disable", { password: PASSWORD })).status).toBe(401);
		expect(await liveSessions(userId)).toEqual(before);

		const done = await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri) });
		expect(done.status, JSON.stringify(done.body)).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		expect(browser.cookies.has("minerva.two_factor")).toBe(false);
	});

	test("an email code stops at the second factor too, and a backup code finishes it", async () => {
		const { email, userId, backupCodes } = await waitingForSecondFactor();
		const browser = new Browser();
		expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
		const step = await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email) });
		expect(step.status).toBe(200);
		expect(step.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await browser.auth("/two-factor/disable", { password: PASSWORD })).status).toBe(401);
		const before = await liveSessions(userId);
		const done = await browser.auth("/two-factor/verify-backup-code", { code: backupCodes[0] });
		expect(done.status, JSON.stringify(done.body)).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		expect(await liveSessions(userId)).toHaveLength(before.length + 1);
	});

	test("a challenge is finished only by its own user's second factor, and signs in only that user", async () => {
		const { browser, email, uri } = await waitingForSecondFactor();
		const other = await waitingForSecondFactor();
		expect((await browser.auth("/two-factor/verify-totp", { code: await totp(other.uri) })).status).toBe(401);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		const done = await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri) });
		expect(done.status).toBe(200);
		expect((await browser.call("GET", "/api/me")).body.user.email).toBe(email);
	});

	test("trusted devices are off: asking for one sets nothing, and a valid trust cookie is ignored", async () => {
		const { browser, email, userId, uri } = await waitingForSecondFactor();
		const done = await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri), trustDevice: true });
		expect(done.status).toBe(200);
		expect(done.response.headers.getSetCookie().some((cookie) => cookie.includes("trust_device"))).toBe(false);
		expect((await browser.auth("/sign-out", {})).status).toBe(200);

		// A trust cookie Better Auth itself would honour (signed with its secret, its record stored).
		const context = await getAuth(env).$context;
		const identifier = `trust-device-${"t".repeat(32)}`;
		await context.internalAdapter.createVerificationValue({ identifier, value: userId, expiresAt: new Date(Date.now() + 3_600_000) });
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(context.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${userId}!${identifier}`)));
		const token = btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
		browser.cookies.set("minerva.trust_device", await signCookie(context.secret, `${token}!${identifier}`));
		const again = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		expect(again.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("a password reset while the second factor is pending: the second factor then makes no session", async () => {
		const { browser, email, userId, uri } = await waitingForSecondFactor();
		await resetPassword(email);
		const done = await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri) });
		expect(done.status).toBe(401);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect(await liveSessions(userId)).toEqual([]);
		// The new password and the second factor still sign in (with a code of a later step: the last was used).
		await forgetUsedTotp(userId);
		const fresh = new Browser();
		expect((await fresh.auth("/sign-in/email", { email, password: NEW_PASSWORD })).body.twoFactorRedirect).toBe(true);
		expect((await fresh.auth("/two-factor/verify-totp", { code: await nextTotp(uri) })).status).toBe(200);
	});

	test("a TOTP code works once: of sign-ins sending the same code at once exactly one gets in, and it never works again", async () => {
		const { browser: first, email, userId } = await signedIn();
		const enabled = await first.auth("/two-factor/enable", { password: PASSWORD });
		const uri: string = enabled.body.totpURI;
		const setup = await totp(uri);
		expect((await first.auth("/two-factor/verify-totp", { code: setup })).status).toBe(200);
		const waiting = async () => {
			const browser = new Browser();
			expect((await browser.auth("/sign-in/email", { email, password: PASSWORD })).body.twoFactorRedirect).toBe(true);
			return browser;
		};
		// The code that turned two-factor on is used.
		const again = await waiting();
		const reused = await again.auth("/two-factor/verify-totp", { code: setup });
		expect([reused.status, reused.body.code]).toEqual([401, "INVALID_CODE"]);
		const before = await liveSessions(userId);
		const code = await nextTotp(uri);
		const racing = await Promise.all([again, await waiting(), await waiting(), await waiting()].map((browser) => browser.auth("/two-factor/verify-totp", { code })));
		expect(racing.map((answer) => answer.status).sort()).toEqual([200, 401, 401, 401]);
		for (const answer of racing.filter((answer) => answer.status === 401)) expect(answer.body.code).toBe("INVALID_CODE");
		expect(await liveSessions(userId)).toHaveLength(before.length + 1);
		// Neither it nor an older one works again; a wrong code is still Better Auth's to refuse and count.
		for (const old of [code, setup]) expect((await (await waiting()).auth("/two-factor/verify-totp", { code: old })).status).toBe(401);
		expect(await liveSessions(userId)).toHaveLength(before.length + 1);
		const row = await db.prepare(`SELECT s.last_step FROM totp_steps s JOIN "twoFactor" t ON t.id = s.two_factor_id WHERE t."userId" = ?`).bind(userId).first<{ last_step: number }>();
		expect(row?.last_step).toBeGreaterThanOrEqual(Math.floor(Date.now() / 30_000));
	});

	test("a claim needs the secret it was checked against, and a verified code that claimed nothing gets no session", async () => {
		const { browser, userId } = await signedIn();
		const enabled = await browser.auth("/two-factor/enable", { password: PASSWORD });
		const row = await db.prepare(`SELECT id, secret FROM "twoFactor" WHERE "userId" = ?`).bind(userId).first<{ id: string; secret: string }>();
		const context = await getAuth(env).$context;
		const code = await totp(enabled.body.totpURI);
		// Two-factor set up again between reading the secret and claiming the step: nothing is claimed.
		const settingUpAgain = {
			prepare: (query: string) => db.prepare(query),
			batch: async (statements: D1PreparedStatement[]) => {
				await db.prepare(`UPDATE "twoFactor" SET secret = 'replaced' WHERE id = ?`).bind(row!.id).run();
				return db.batch(statements);
			},
		} as unknown as D1Database;
		await expect(claimTotpStep(settingUpAgain, context.secretConfig, userId, code)).rejects.toMatchObject({ body: { code: "INVALID_CODE" } });
		expect((await db.prepare("SELECT count(*) AS n FROM totp_steps WHERE two_factor_id = ?").bind(row!.id).first<{ n: number }>())?.n).toBe(0);
		// Restored, a code claims its step once; one that matches no step claims nothing.
		await db.prepare(`UPDATE "twoFactor" SET secret = ? WHERE id = ?`).bind(row!.secret, row!.id).run();
		expect(await claimTotpStep(db, context.secretConfig, userId, "000000x")).toBe(false);
		expect(await claimTotpStep(db, context.secretConfig, userId, code)).toBe(true);
		await expect(claimTotpStep(db, context.secretConfig, userId, code)).rejects.toMatchObject({ body: { code: "INVALID_CODE" } });
		// Better Auth reads the clock later than the hook: a code it accepted that the hook claimed no step for.
		const policy = new Policy({ db, limits: new RateLimits(db, "k"), stampKey: "stamp-key", signupAllowed: async () => true, sendAlreadyExists: async () => {} });
		const endpoint = { path: "/two-factor/verify-totp" } as GenericEndpointContext;
		await expect(runInScope({ holder: null }, () => policy.sessionCreating({ userId }, endpoint))).rejects.toMatchObject({ body: { code: "INVALID_CODE" } });
	});

	test("the code that turns two-factor on works once too, and steps of an earlier secret do not count", async () => {
		const { browser, email, userId } = await signedIn();
		const other = new Browser();
		expect((await other.auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		const stale = await browser.auth("/two-factor/enable", { password: PASSWORD });
		const twoFactor = await db.prepare(`SELECT id FROM "twoFactor" WHERE "userId" = ?`).bind(userId).first<{ id: string }>();
		// A step far ahead, recorded for the secret this row had before it was set up again.
		await db.prepare("INSERT INTO totp_steps (two_factor_id, secret_hash, last_step) VALUES (?, 'earlier secret', ?)").bind(twoFactor!.id, 2 ** 40).run();
		const enabled = await browser.auth("/two-factor/enable", { password: PASSWORD });
		expect(enabled.body.totpURI).not.toBe(stale.body.totpURI);
		// Two sessions of the user send the code at once: one turns two-factor on, the other's code is used.
		const code = await totp(enabled.body.totpURI);
		const racing = await Promise.all([browser, other].map((session) => session.auth("/two-factor/verify-totp", { code })));
		expect(racing.map((answer) => [answer.status, answer.body.code ?? null]).sort()).toEqual([
			[200, null],
			[401, "INVALID_CODE"],
		]);
		expect((await db.prepare(`SELECT "twoFactorEnabled" AS on_ FROM "user" WHERE id = ?`).bind(userId).first<{ on_: number }>())?.on_).toBe(1);
		// Turning it off and on again makes a new authenticator, with no steps used.
		const winner = racing[0]!.status === 200 ? browser : other;
		expect((await winner.auth("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
		expect((await db.prepare("SELECT count(*) AS n FROM totp_steps WHERE two_factor_id = ?").bind(twoFactor!.id).first<{ n: number }>())?.n).toBe(0);
		const renewed = await winner.auth("/two-factor/enable", { password: PASSWORD });
		expect((await winner.auth("/two-factor/verify-totp", { code: await totp(renewed.body.totpURI) })).status).toBe(200);
	});
});

describe("verification signs in", () => {
	const ATTACKER_PASSWORD = "the attacker's own passphrase";
	const credentials = async (userId: string) => (await db.prepare(`SELECT count(*) AS n FROM account WHERE "userId" = ?`).bind(userId).first<{ n: number }>())!.n;

	test("in the browser that signed up, with the password it set; the session's stamp holds", async () => {
		const { browser, email } = await signUp();
		expect(browser.cookies.has("minerva.email_binding")).toBe(true);
		const verified = await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		expect(verified.status, JSON.stringify(verified.body)).toBe(200);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
		expect(browser.cookies.has("minerva.email_binding")).toBe(false);
		expect((await browser.call("GET", "/api/me")).body.user.email).toBe(email);
		// The password stays, and a code works once.
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		expect((await new Browser().auth("/email-otp/verify-email", { email, otp: lastCode(email) })).status).toBe(400);
		// A reset ends the session verifying made, as any other.
		await resetPassword(email);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("a user with two-factor gets the second step, not a session", async () => {
		const { browser: first, email, userId } = await signedIn();
		const { uri } = await enableTwoFactor(first);
		await db.prepare(`UPDATE "user" SET "emailVerified" = 0 WHERE id = ?`).bind(userId).run();
		const browser = new Browser();
		expect((await browser.auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
		const step = await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		expect(step.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		const done = await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri) });
		expect(done.status, JSON.stringify(done.body)).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});

	test("someone who signed up with another's address keeps no way in once its owner verifies it", async () => {
		const email = uniqueEmail("owner");
		const { browser: attacker } = await signUp(email, ATTACKER_PASSWORD);
		const code = lastCode(email); // in the owner's mailbox
		// The owner signs up too and is answered as for a new address; the email says the account exists.
		const owner = new Browser();
		expect((await owner.auth("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBe(200);
		expect(emailsTo(email).at(-1)?.subject).toBe("[Minerva] Account Already Exists");
		expect(owner.cookies.has("minerva.email_binding")).toBe(false);
		const verified = await owner.auth("/email-otp/verify-email", { email, otp: code });
		expect(verified.status, JSON.stringify(verified.body)).toBe(200);
		const userId: string = verified.body.user.id;
		// The owner is signed in to an account without the password someone else chose.
		expect((await owner.call("GET", "/api/me")).body.user.email).toBe(email);
		expect(await credentials(userId)).toBe(0);
		expect((await new Browser().auth("/sign-in/email", { email, password: ATTACKER_PASSWORD })).status).toBe(401);
		expect((await attacker.auth("/sign-in/email", { email, password: ATTACKER_PASSWORD })).status).toBe(401);
		expect((await attacker.call("GET", "/api/me")).status).toBe(401);
		// The owner chooses a password with a reset, and the session verifying made ends with it as usual.
		await resetPassword(email);
		expect((await owner.call("GET", "/api/me")).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	test("a binding for another password, or a forged one, does not keep the password", async () => {
		const email = uniqueEmail("owner");
		const { browser: attacker } = await signUp(email, ATTACKER_PASSWORD);
		// The attacker's own binding with its signature replaced: Better Auth's secret signs the cookie.
		const forged = new Browser();
		forged.cookies.set("minerva.email_binding", attacker.cookies.get("minerva.email_binding")!.replace(/\.[^.]*$/, ".AAAA"));
		const verified = await forged.auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		expect(verified.status).toBe(200);
		expect(await credentials(verified.body.user.id)).toBe(0);

		// A real binding, but for a password the account no longer has.
		const other = uniqueEmail("other");
		const { browser } = await signUp(other);
		const userId = (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(other).first<{ id: string }>())!.id;
		await db.prepare(`UPDATE account SET password = ? WHERE "userId" = ?`).bind(await hashPassword(NEW_PASSWORD), userId).run();
		expect((await browser.auth("/email-otp/verify-email", { email: other, otp: lastCode(other) })).status).toBe(200);
		expect(await credentials(userId)).toBe(0);
	});

	test("an unverified sign-in gets its code from the server, once while it is usable", async () => {
		const email = uniqueEmail();
		await signUp(email);
		const first = lastCode(email);
		const sent = emailsTo(email).length;
		// Signing in again while the sign-up's code is usable sends nothing, and that code still works.
		const browser = new Browser();
		for (let i = 0; i < 2; i++) expect((await browser.auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
		expect(emailsTo(email).length).toBe(sent);
		// Once it has expired, a sign-in sends a new one.
		await db.prepare(`UPDATE verification SET "expiresAt" = ? WHERE identifier = ?`).bind(new Date(Date.now() - 1000).toISOString(), `email-verification-otp-${email}`).run();
		expect((await browser.auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
		expect(emailsTo(email).length).toBe(sent + 1);
		const second = lastCode(email);
		expect((await browser.auth("/email-otp/verify-email", { email, otp: first })).status).toBe(400);
		expect((await browser.auth("/email-otp/verify-email", { email, otp: second })).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		// A wrong password learns nothing and gets no code.
		const stranger = uniqueEmail();
		await signUp(stranger);
		const before = emailsTo(stranger).length;
		await db.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(`email-verification-otp-${stranger}`).run();
		const wrong = new Browser();
		expect((await wrong.auth("/sign-in/email", { email: stranger, password: "not the passphrase" })).status).toBe(401);
		expect(emailsTo(stranger).length).toBe(before);
		expect(wrong.cookies.has("minerva.email_binding")).toBe(false);
	});

	test("races: a reset that overtakes a verification wins, and a sign-up's password never lands on an address verified meanwhile", async () => {
		const { email } = await signUp();
		const userId = (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>())!.id;
		const policy = new Policy({ db, limits: new RateLimits(db, "k"), stampKey: "stamp-key", signupAllowed: async () => true, sendAlreadyExists: async () => {} });
		const endpoint = { path: "/email-otp/verify-email" } as GenericEndpointContext;
		const kept = await storedPassword(userId);
		const scope = { holder: null, claimedEmail: email, binding: policy.stamp(userId, email, kept) };
		await runInScope(scope, () => policy.emailVerifying({ id: userId, emailVerified: false }));
		// The reset lands, then Better Auth marks the address verified and makes the session.
		await db.prepare(`UPDATE account SET password = ? WHERE "userId" = ?`).bind(await hashPassword(NEW_PASSWORD), userId).run();
		await db.prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE id = ?`).bind(userId).run();
		const made = await runInScope(scope, () => policy.sessionCreating({ userId }, endpoint));
		expect(made).toEqual({ data: { credentialStamp: policy.stamp(userId, email, kept) } });
		expect(policy.stamp(userId, email, kept)).not.toBe(policy.stamp(userId, email, await storedPassword(userId)));
		// Verified already (the reset verified it): the code verifies nothing and drops nothing.
		await expect(runInScope({ holder: null }, () => policy.emailVerifying({ id: userId, emailVerified: false }))).rejects.toMatchObject({ body: { code: "EMAIL_ALREADY_VERIFIED" } });
		expect(await credentials(userId)).toBe(1);
		// A sign-up whose user was written before the owner verified the address gets no password after it.
		const owner = uniqueEmail("owner");
		await signUp(owner, "the attacker's own passphrase");
		const ownerId = (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(owner).first<{ id: string }>())!.id;
		await db.prepare(`DELETE FROM account WHERE "userId" = ?`).bind(ownerId).run(); // its password not written yet
		const verified = await new Browser().auth("/email-otp/verify-email", { email: owner, otp: lastCode(owner) });
		expect(verified.status).toBe(200);
		const signUpEndpoint = { path: "/sign-up/email" } as GenericEndpointContext;
		const late = { holder: null } as { holder: null; writtenHash?: string };
		const hash = await hashPassword("the attacker's own passphrase");
		expect(await runInScope(late, () => policy.accountCreating({ userId: ownerId, password: hash }, signUpEndpoint))).toBe(false);
		expect(await credentials(ownerId)).toBe(0);
		expect(late.writtenHash).toBeUndefined();
	});

	test("codes a sign-in sends count against the address's emails", async () => {
		freezeClockInWindow();
		const email = uniqueEmail();
		await signUp(email);
		const expire = () => db.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(`email-verification-otp-${email}`).run();
		const sent = emailsTo(email).length;
		await expire();
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
		await expire(); // its attempts used up, say
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");
		expect(emailsTo(email).length).toBe(sent + 1);
	});

	test("a verification code signs nobody in to an address already verified", async () => {
		const { email } = await signedIn();
		const browser = new Browser();
		expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "email-verification" })).status).toBe(200);
		const answer = await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		expect([answer.status, answer.body.code]).toEqual([400, "EMAIL_ALREADY_VERIFIED"]);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
	});

	test("verifying needs the site's Origin", async () => {
		const { browser, email } = await signUp();
		expect((await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) }, { Origin: "https://evil.example" })).status).toBe(403);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect((await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) })).status).toBe(200);
	});
});

describe("credential stamps", () => {
	test("a password change ends every other session at once and replaces this one", async () => {
		const { browser, email, userId } = await signedIn();
		const other = new Browser();
		expect((await other.auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		const oldCookie = browser.cookies.get(SESSION_COOKIE)!;
		// Without asking for the others to be revoked: the policy revokes them anyway.
		const changed = await browser.auth("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false });
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(browser.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		expect((await other.call("GET", "/api/me")).status).toBe(401);
		const replay = new Browser();
		replay.cookies.set(SESSION_COOKIE, oldCookie);
		expect((await replay.call("GET", "/api/me")).status).toBe(401);
		expect(await liveSessions(userId)).toHaveLength(1);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	test("a password written without the sessions being deleted after it (a crash between) still ends them", async () => {
		const { browser, userId } = await signedIn();
		await db.prepare(`UPDATE account SET password = ? WHERE "userId" = ?`).bind(await hashPassword(NEW_PASSWORD), userId).run();
		expect(await allSessions(userId)).toBe(1);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		// Deleted when it was used, not only refused.
		expect(await allSessions(userId)).toBe(0);
	});

	test("a reset by email code ends every session", async () => {
		const { browser, email } = await signedIn();
		await resetPassword(email);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	test("an email change ends the sessions", async () => {
		const { browser, userId } = await signedIn();
		await db.prepare(`UPDATE "user" SET email = ? WHERE id = ?`).bind(uniqueEmail("moved"), userId).run();
		expect((await browser.auth("/get-session")).body).toBeNull();
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("a sign-in takes the stamp of the password it checked, so a reset that overtakes it wins", async () => {
		const { email, userId } = await signedIn();
		const checked = await hashPassword(PASSWORD);
		const policy = new Policy({ db, limits: new RateLimits(db, "k"), stampKey: "stamp-key", signupAllowed: async () => true, sendAlreadyExists: async () => {} });
		const endpoint = { path: "/sign-in/email" } as GenericEndpointContext;
		const made = await runInScope({ holder: null, verifiedHash: checked }, () => policy.sessionCreating({ userId }, endpoint));
		const stored = (await db.prepare(`SELECT password FROM account WHERE "userId" = ?`).bind(userId).first<{ password: string }>())!.password;
		expect(made).toEqual({ data: { credentialStamp: policy.stamp(userId, email, checked) } });
		expect(policy.stamp(userId, email, checked)).not.toBe(policy.stamp(userId, email, stored));
		// Likewise the address it was given: an email change that lands meanwhile leaves the session stale.
		const claimed = await runInScope({ holder: null, verifiedHash: stored, claimedEmail: "before@example.com" }, () => policy.sessionCreating({ userId }, endpoint));
		expect(claimed).toEqual({ data: { credentialStamp: policy.stamp(userId, "before@example.com", stored) } });
		expect(policy.stamp(userId, "before@example.com", stored)).not.toBe(policy.stamp(userId, email, stored));
		// Outside a browser request, or on a route that signs nobody in, no session is made at all.
		expect(await policy.sessionCreating({ userId }, endpoint)).toBe(false);
		expect(await runInScope({ holder: null }, () => policy.sessionCreating({ userId }, { path: "/sign-up/email" } as GenericEndpointContext))).toBe(false);
	});

	test("a rehash while a session is replaced (two-factor turned off) keeps the new session valid", () =>
		withProductionHashing(async () => {
			const { browser: first, email, userId } = await signedIn();
			const { uri } = await enableTwoFactor(first);
			await db.prepare(`UPDATE account SET password = ? WHERE "userId" = ?`).bind(await hashPassword(PASSWORD, { logN: 10, r: 8, p: 1 }), userId).run();
			// A session made while the older hash is stored: an email code, then the second factor.
			const browser = new Browser();
			expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
			expect((await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email) })).body.twoFactorRedirect).toBe(true);
			expect((await browser.auth("/two-factor/verify-totp", { code: await nextTotp(uri) })).status).toBe(200);
			// Turning two-factor off checks the password (rehashing it) and replaces the session.
			expect((await browser.auth("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
			expect((await db.prepare(`SELECT password FROM account WHERE "userId" = ?`).bind(userId).first<{ password: string }>())!.password).toMatch(/^scrypt\$15\$8\$3\$/);
			expect((await browser.call("GET", "/api/me")).status).toBe(200);
		}),
	);

	test("a password change is written only over the password it checked, so a reset meanwhile is never undone", async () => {
		const { email, userId } = await signedIn();
		const stored = await storedPassword(userId);
		const policy = new Policy({ db, limits: new RateLimits(db, "k"), stampKey: "stamp-key", signupAllowed: async () => true, sendAlreadyExists: async () => {} });
		const holder = { sessionId: "unused", userId, email, stamp: "unused" };
		const endpoint = { path: "/change-password" } as GenericEndpointContext;
		const chosen = await hashPassword(NEW_PASSWORD);
		// The request checked a password a reset has since replaced: refused, and the reset's password stays.
		const before = runInScope({ holder, verifiedHash: await hashPassword(PASSWORD) }, () => policy.accountUpdating({ password: chosen }, endpoint));
		await expect(before).rejects.toMatchObject({ body: { code: "INVALID_PASSWORD" } });
		expect(await storedPassword(userId)).toBe(stored);
		// Still the password it checked: written here, conditionally, and Better Auth's own write skipped.
		expect(await runInScope({ holder, verifiedHash: stored }, () => policy.accountUpdating({ password: chosen }, endpoint))).toBe(false);
		expect(await storedPassword(userId)).toBe(chosen);
	});

	test("fixation: a session cookie from before sign-in is never adopted, and every sign-in gets a new token", async () => {
		const attacker = await signedIn();
		const victim = await signedIn();
		const planted = attacker.browser.cookies.get(SESSION_COOKIE)!;
		const browser = new Browser();
		browser.cookies.set(SESSION_COOKIE, planted);
		expect((await browser.auth("/sign-in/email", { email: victim.email, password: PASSWORD })).status).toBe(200);
		const mine = browser.cookies.get(SESSION_COOKIE)!;
		expect(mine).not.toBe(planted);
		expect((await browser.call("GET", "/api/me")).body.user.email).toBe(victim.email);
		expect((await attacker.browser.call("GET", "/api/me")).body.user.email).toBe(attacker.email);
		expect((await browser.auth("/sign-in/email", { email: victim.email, password: PASSWORD })).status).toBe(200);
		expect(browser.cookies.get(SESSION_COOKIE)).not.toBe(mine);
		// The stamp never leaves the server.
		const session = (await browser.auth("/get-session")).body.session;
		expect(session.userId).toBe(victim.userId);
		expect(session).not.toHaveProperty("credentialStamp");
	});

	test("every session cookie a request sends is checked; padding the header is refused, not checked in part", async () => {
		const { browser, userId } = await signedIn();
		const real = browser.cookies.get(SESSION_COOKIE)!;
		await db.prepare(`UPDATE "user" SET email = ? WHERE id = ?`).bind(uniqueEmail("moved"), userId).run();
		const padded = new Browser();
		for (let i = 0; i < 8; i++) padded.cookies.set(`p${i}.session_token`, `decoy-${i}.sig`);
		padded.cookies.set(SESSION_COOKIE, real);
		expect((await padded.call("GET", "/api/me")).status).toBe(400);
		expect((await padded.auth("/get-session")).status).toBe(400);
		padded.cookies.delete("p0.session_token");
		expect((await padded.auth("/get-session")).body).toBeNull();
		expect(await allSessions(userId)).toBe(0);
	});
});

describe("email codes", () => {
	const sendLoginCode = async (email: string) => expect((await new Browser().auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);

	test("are stored keyed, never as sent", async () => {
		const { email } = await signedIn();
		await sendLoginCode(email);
		const code = lastCode(email);
		const { results } = await db.prepare(`SELECT value FROM verification WHERE identifier LIKE ?`).bind(`%${email}`).all<{ value: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const { value } of results) expect(value).not.toContain(code);
	});

	test("an expired code is refused", async () => {
		const { email, userId } = await signedIn();
		await sendLoginCode(email);
		await db.prepare(`UPDATE verification SET "expiresAt" = ? WHERE identifier = ?`).bind(new Date(Date.now() - 1000).toISOString(), `sign-in-otp-${email}`).run();
		expect((await new Browser().auth("/sign-in/email-otp", { email, otp: lastCode(email) })).status).toBe(400);
		expect(await liveSessions(userId)).toHaveLength(1);
	});

	test("concurrent wrong guesses spend the budget: the right code is refused after", async () => {
		const { email, userId } = await signedIn();
		await sendLoginCode(email);
		const code = lastCode(email);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let round = 0; round < 3; round++) {
			const answers = await Promise.all(Array.from({ length: 5 }, () => new Browser().auth("/sign-in/email-otp", { email, otp: wrong })));
			for (const answer of answers) expect(answer.status).toBeGreaterThanOrEqual(400);
		}
		const browser = new Browser();
		expect((await browser.auth("/sign-in/email-otp", { email, otp: code })).status).toBeGreaterThanOrEqual(400);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect(await liveSessions(userId)).toHaveLength(1);
	});

	test("a code works once: duplicate submissions make one session", async () => {
		const { email, userId } = await signedIn();
		await sendLoginCode(email);
		const code = lastCode(email);
		const answers = await Promise.all(Array.from({ length: 5 }, () => new Browser().auth("/sign-in/email-otp", { email, otp: code })));
		expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
		expect(await liveSessions(userId)).toHaveLength(2);
	});

	test("a resend replaces the code: the older one is refused, and racing both signs in at most once", async () => {
		const { email } = await signedIn();
		await sendLoginCode(email);
		const older = lastCode(email);
		await sendLoginCode(email);
		const newer = lastCode(email);
		// One code per address at a time, so no other isolate can consume an older one.
		expect(await db.prepare(`SELECT count(*) AS n FROM verification WHERE identifier = ?`).bind(`sign-in-otp-${email}`).first()).toEqual({ n: 1 });
		if (older !== newer) expect((await isolatedBrowser().auth("/sign-in/email-otp", { email, otp: older })).status).toBe(400);
		expect((await isolatedBrowser().auth("/sign-in/email-otp", { email, otp: newer })).status).toBe(200);

		const racer = await signedIn();
		await Promise.all([sendLoginCode(racer.email), sendLoginCode(racer.email)]);
		const codes = [...new Set(emailsTo(racer.email).slice(-2).map((sent) => /\n\n([0-9]{6})/.exec(sent.body)![1]!))];
		const answers = await Promise.all(codes.flatMap((otp) => [isolatedBrowser(), isolatedBrowser()].map((browser) => browser.auth("/sign-in/email-otp", { email: racer.email, otp }))));
		expect(answers.filter((answer) => answer.status === 200).length).toBeLessThanOrEqual(1);
	});

	test("across isolates too: a code signs in once, and concurrent wrong guesses spend its budget", async () => {
		const { email, userId } = await signedIn();
		await sendLoginCode(email);
		const code = lastCode(email);
		const answers = await Promise.all(Array.from({ length: 4 }, () => isolatedBrowser().auth("/sign-in/email-otp", { email, otp: code })));
		expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
		expect(await liveSessions(userId)).toHaveLength(2);

		const other = await signedIn();
		await sendLoginCode(other.email);
		const right = lastCode(other.email);
		const wrong = right === "000000" ? "111111" : "000000";
		for (let round = 0; round < 3; round++) {
			await Promise.all(Array.from({ length: 4 }, () => isolatedBrowser().auth("/sign-in/email-otp", { email: other.email, otp: wrong })));
		}
		expect((await isolatedBrowser().auth("/sign-in/email-otp", { email: other.email, otp: right })).status).toBeGreaterThanOrEqual(400);
		expect(await liveSessions(other.userId)).toHaveLength(1);
	});
});

describe("limits per address and per user", () => {
	test("failed sign-ins: five per address across IPs, refused before the password is checked; a reset clears them", async () => {
		freezeClockInWindow();
		const { email } = await signedIn();
		const statuses = [];
		for (let i = 0; i < 5; i++) statuses.push((await new Browser().auth("/sign-in/email", { email, password: "not the passphrase" })).status);
		expect(statuses).toEqual([401, 401, 401, 401, 401]);
		const refused = await new Browser().auth("/sign-in/email", { email, password: PASSWORD });
		expect(refused.status).toBe(429);
		expect(refused.body).toEqual({ code: "TOO_MANY_LOGIN_ATTEMPTS", message: "Too many failed login attempts. Try again later." });
		await resetPassword(email);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	test("failed sign-ins at once cannot overrun the budget, and a right password costs nothing", async () => {
		freezeClockInWindow();
		const { email } = await signedIn();
		for (let i = 0; i < 6; i++) expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		const answers = await Promise.all(Array.from({ length: 10 }, () => new Browser().auth("/sign-in/email", { email, password: "not the passphrase" })));
		expect(answers.filter((answer) => answer.status === 401)).toHaveLength(5);
		expect(answers.filter((answer) => answer.status === 429)).toHaveLength(5);
	});

	test("codes: three sign-in codes a minute per address, one verification email per 10 s, five resets a minute", async () => {
		freezeClockInWindow();
		const { email } = await signedIn();
		const send = async (path: string, body: object) => (await new Browser().auth(path, body)).status;
		const login = [];
		for (let i = 0; i < 4; i++) login.push(await send("/email-otp/send-verification-otp", { email, type: "sign-in" }));
		expect(login).toEqual([200, 200, 200, 429]);
		const fresh = uniqueEmail();
		await signUp(fresh);
		expect([await send("/email-otp/send-verification-otp", { email: fresh, type: "email-verification" }), await send("/email-otp/send-verification-otp", { email: fresh, type: "email-verification" })]).toEqual([200, 429]);
		const resets = [];
		for (let i = 0; i < 6; i++) resets.push(await send("/email-otp/request-password-reset", { email }));
		expect(resets).toEqual([200, 200, 200, 200, 200, 429]);
		// Reset codes come only from request-password-reset; email changes are not available.
		for (const type of ["forget-password", "change-email"]) expect(await send("/email-otp/send-verification-otp", { email, type })).toBe(400);
	});

	test("password changes: five a minute per user, whatever the IP", async () => {
		freezeClockInWindow();
		const { browser } = await signedIn();
		const statuses = [];
		for (let i = 0; i < 6; i++) {
			const answer = await browser.auth("/change-password", { currentPassword: "not the passphrase", newPassword: NEW_PASSWORD }, { "CF-Connecting-IP": `10.200.0.${i + 1}` });
			statuses.push(answer.status);
		}
		expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
	});

	test("two-factor changes ask for the password every time", async () => {
		const { browser } = await signedIn();
		expect((await browser.auth("/two-factor/enable", {})).status).toBe(400);
		expect((await browser.auth("/two-factor/enable", { password: "not the passphrase" })).status).toBe(400);
		await enableTwoFactor(browser);
		expect((await browser.auth("/two-factor/disable", { password: "not the passphrase" })).status).toBe(400);
		expect((await browser.auth("/two-factor/disable", { password: PASSWORD })).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});
});

describe("what the browser reaches, and who creates accounts", () => {
	test("only the listed endpoints answer: more organizations, invitations, admin, impersonation and email changes are 404", async () => {
		const reached = new Set<string>();
		const refused: string[] = [];
		for (const endpoint of Object.values(getAuth(env).api) as { path?: string; options?: { method?: string | string[] } }[]) {
			if (!endpoint.path) continue;
			const declared = endpoint.options?.method ?? "GET";
			const methods = (Array.isArray(declared) ? declared : [declared]).flatMap((method) => (method === "*" ? ["GET", "POST"] : [method]));
			for (const method of methods.filter((method) => method === "GET" || method === "POST")) {
				const route = `${method} ${endpoint.path}`;
				if (BROWSER_ROUTES.has(route)) {
					reached.add(route);
					continue;
				}
				const path = endpoint.path.replace(/:[A-Za-z]+/g, "x");
				const answer = await new Browser().call(method, `/api/auth${path}`, method === "POST" ? {} : undefined);
				expect(answer.status, route).toBe(404);
				refused.push(route);
			}
		}
		expect([...reached].sort()).toEqual([...BROWSER_ROUTES].sort());
		for (const route of [
			"POST /organization/create",
			"POST /organization/invite-member",
			"POST /organization/delete",
			"POST /organization/update",
			"POST /admin/impersonate-user",
			"POST /admin/create-user",
			"POST /admin/set-role",
			"POST /change-email",
			"POST /update-user",
			"POST /delete-user",
			"POST /email-otp/check-verification-otp",
			"POST /email-otp/change-email",
			"POST /forget-password/email-otp",
			"POST /send-verification-email",
		]) {
			expect(refused).toContain(route);
		}
	});

	test("sign-up cannot set roles, verification, two-factor or server fields", async () => {
		const email = uniqueEmail();
		await new Browser().auth("/sign-up/email", {
			email,
			password: PASSWORD,
			name: "",
			role: "admin",
			emailVerified: true,
			twoFactorEnabled: true,
			banned: false,
			provisionedAt: "2020-01-01T00:00:00.000Z",
			credentialStamp: "x",
		});
		const row = await db.prepare(`SELECT role, "emailVerified" AS verified, "twoFactorEnabled" AS tfa FROM "user" WHERE email = ?`).bind(email).first<{ role: string; verified: number; tfa: number | null }>();
		if (row) expect({ ...row, tfa: row.tfa ?? 0 }).toEqual({ role: "user", verified: 0, tfa: 0 });
		const organizations = await db.prepare(`SELECT jurisdiction FROM organization o JOIN "user" u ON u.id = o."personalOwner" WHERE u.email = ?`).bind(email).all();
		for (const org of organizations.results) expect(org.jurisdiction).toBeNull();
	});

	test("closed sign-up holds on every path: the browser's sign-up, an email code, and the policy's own gate", async () => {
		const closed = { ...env, MINERVA_SIGNUP_OPEN: "false" };
		const email = uniqueEmail();
		const request = (path: string, body: object) =>
			handleAuth(
				closed,
				new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "10.201.0.1" }, body: JSON.stringify(body) }),
			);
		expect((await request("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBeGreaterThanOrEqual(400);
		await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
		await request("/sign-in/email-otp", { email, otp: "000000" });
		expect(await userCount(email)).toBe(0);
		const gate = (open: boolean) => new Policy({ db, limits: new RateLimits(db, "k"), stampKey: "s", signupAllowed: async () => open, sendAlreadyExists: async () => {} });
		const at = (path: string) => ({ path, headers: new Headers() }) as GenericEndpointContext;
		// A sign-up creates a user only once the before hook admitted it, which it does while sign-up is allowed.
		const signUp = (policy: Policy) =>
			runInScope({ holder: null }, async () => {
				await policy.before({ ...at("/sign-up/email"), body: { email, password: PASSWORD } } as unknown as GenericEndpointContext).catch(() => undefined);
				return policy.userCreating(at("/sign-up/email"));
			});
		expect(await signUp(gate(false))).toBe(false);
		expect(await signUp(gate(true))).toBe(true);
		expect(await runInScope({ holder: null }, () => gate(true).userCreating(at("/sign-up/email")))).toBe(false);
		for (const path of ["/sign-in/email-otp", "/admin/create-user", "/callback/x"]) expect(await runInScope({ holder: null, signupAdmitted: true }, () => gate(true).userCreating(at(path)))).toBe(false);
		// Our own server code (seed) runs outside any browser request.
		expect(await gate(false).userCreating(at("/admin/create-user"))).toBe(true);
	});

	test("a taken address at sign-up answers as a new one and tells its owner, once per 10 s", async () => {
		freezeClockInWindow();
		const { email } = await signedIn();
		const fresh = await new Browser().auth("/sign-up/email", { email: uniqueEmail(), password: PASSWORD, name: "" });
		const taken = await new Browser().auth("/sign-up/email", { email, password: PASSWORD, name: "" });
		await new Browser().auth("/sign-up/email", { email, password: PASSWORD, name: "" });
		expect(taken.status).toBe(fresh.status);
		expect(Object.keys(taken.body).sort()).toEqual(Object.keys(fresh.body).sort());
		expect(emailsTo(email).filter((sent) => sent.subject === "[Minerva] Account Already Exists")).toHaveLength(1);
	});

	test("an interrupted sign-up (the user written, not its password) recovers by signing up again and resetting", async () => {
		const { email } = await signUp();
		const userId = (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>())!.id;
		await db.prepare(`DELETE FROM account WHERE "userId" = ?`).bind(userId).run();
		expect((await new Browser().auth("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBe(200);
		const told = emailsTo(email).at(-1)!;
		expect(told.subject).toBe("[Minerva] Account Already Exists");
		expect(told.body).toContain("/reset-password");
		await resetPassword(email);
		const browser = new Browser();
		expect((await browser.auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});
});

describe("the password rules", () => {
	test("sign-up, reset and change refuse a weak password, with every reason listed", async () => {
		const common = await new Browser().auth("/sign-up/email", { email: uniqueEmail(), password: "1234567890", name: "" });
		expect(common.status).toBe(400);
		expect(common.body.code).toBe("PASSWORD_TOO_COMMON");
		expect(common.body.errors.map((error: { code: string }) => error.code)).toEqual(["password_too_common", "password_entirely_numeric"]);

		const { browser, email } = await signedIn(uniqueEmail("marguerite"));
		const similar = email.split("@")[0]!;
		const resetBrowser = new Browser();
		expect((await resetBrowser.auth("/email-otp/request-password-reset", { email })).status).toBe(200);
		const reset = await resetBrowser.auth("/email-otp/reset-password", { email, otp: lastCode(email), password: similar });
		expect(reset.status).toBe(400);
		expect(reset.body.code).toBe("PASSWORD_TOO_SIMILAR");

		const changed = await browser.auth("/change-password", { currentPassword: PASSWORD, newPassword: "qwertyuiop" });
		expect(changed.status).toBe(400);
		expect(changed.body.code).toBe("PASSWORD_TOO_COMMON");
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});
});
