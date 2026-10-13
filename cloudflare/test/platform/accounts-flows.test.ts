// The account flows on plain Better Auth (docs/plans/plain-better-auth.md), through the Worker as the browser
// uses them: sign-up by email code, open, closed or admitted by the setup key; the owner of an address taking
// over an account someone else made for it; the second factor after either first factor; the first password;
// resets and password changes ending sessions; email codes; and the routes the browser reaches.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BROWSER_ROUTES, getAuth } from "../../src/accounts/auth.ts";
import { SETUP_KEY_HEADER, claimSetup } from "../../src/accounts/instance.ts";
import { PASSWORD_ALREADY_SET } from "../../src/api/accounts.ts";
import { createApp } from "../../src/http/router.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { Browser, PASSWORD, SESSION_COOKIE, contractError, emailsTo, enableTwoFactor, installEmailLog, lastCode, signInWithCode, signedIn, totp, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

const db = env.DB;
const NEW_PASSWORD = "another long enough passphrase";

async function users(email: string): Promise<number> {
	return (await db.prepare(`SELECT count(*) AS n FROM "user" WHERE email = ?`).bind(email).first<{ n: number }>())!.n;
}

async function sessions(userId: string): Promise<number> {
	return (await db.prepare(`SELECT count(*) AS n FROM "session" WHERE "userId" = ?`).bind(userId).first<{ n: number }>())!.n;
}

async function sendCode(email: string, browser = new Browser(), headers: Record<string, string> = {}) {
	return browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers);
}

describe("sign-up by email code", () => {
	const app = createApp();
	/** A browser on an instance whose MINERVA_SIGNUP_OPEN is off. */
	const closed = () => new Browser((request) => Promise.resolve(app.fetch(request, { ...env, MINERVA_SIGNUP_OPEN: "false" }, createExecutionContext())));
	const KEY = env.MINERVA_SETUP_KEY;

	beforeEach(async () => {
		await db.batch([db.prepare("DELETE FROM instance_setup"), db.prepare("DELETE FROM instance_settings")]);
	});
	afterEach(async () => {
		await db.prepare("DELETE FROM instance_setup").run();
	});

	test("while sign-up is open, a code makes a verified user, who cannot name their own role", async () => {
		const email = uniqueEmail();
		const browser = new Browser();
		expect((await sendCode(email, browser)).status).toBe(200);
		const role = await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email), role: "admin" });
		expect([role.status, role.body.code]).toEqual([400, "FIELD_NOT_ALLOWED"]);
		expect(await users(email)).toBe(0);
		expect((await sendCode(email, browser)).status).toBe(200);
		const signedUp = await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email), name: "Ada" });
		expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(200);
		const row = await db.prepare(`SELECT name, role, "emailVerified" AS verified FROM "user" WHERE email = ?`).bind(email).first();
		expect(row).toEqual({ name: "Ada", role: "user", verified: 1 });
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});

	test("while it is closed, an unknown address gets no email and no code makes it a user", async () => {
		const email = uniqueEmail();
		const browser = closed();
		expect((await sendCode(email, browser)).status).toBe(200);
		expect(emailsTo(email)).toEqual([]);
		const refused = await browser.auth("/sign-in/email-otp", { email, otp: "000000" });
		expect(refused.status).toBe(400);
		expect(await users(email)).toBe(0);
		// A code our own server made, right as it is, is refused all the same.
		const otp = await getAuth(env).api.createVerificationOTP({ body: { email, type: "sign-in" } });
		expect((await browser.auth("/sign-in/email-otp", { email, otp })).status).toBe(400);
		expect(await users(email)).toBe(0);
		// An existing account still signs in.
		const { email: existing } = await signedIn();
		await signInWithCode(existing, {}, closed());
	});

	test("the setup key admits a sign-up on a closed instance, on both code routes, until setup is done", async () => {
		const withKey = { [SETUP_KEY_HEADER]: KEY };
		const operator = uniqueEmail("operator");
		expect((await sendCode(operator, closed(), { [SETUP_KEY_HEADER]: "wrong" })).status).toBe(200);
		expect(emailsTo(operator)).toEqual([]);

		// The key on the request for the code but not on the sign-in: the code is used up, and nobody is made.
		const browser = closed();
		await sendCode(operator, browser, withKey);
		const withoutKey = await browser.auth("/sign-in/email-otp", { email: operator, otp: lastCode(operator) });
		expect(withoutKey.status).toBe(400);
		expect(await users(operator)).toBe(0);
		expect((await browser.auth("/sign-in/email-otp", { email: operator, otp: lastCode(operator) }, withKey)).status).toBe(400);

		const { userId } = await signInWithCode(operator, withKey, closed());
		expect(await claimSetup(db, userId)).toBe(true);

		// Setup done: the key admits nobody any more.
		const late = uniqueEmail("late");
		expect((await sendCode(late, closed(), withKey)).status).toBe(200);
		expect(emailsTo(late)).toEqual([]);
		const otp = await getAuth(env).api.createVerificationOTP({ body: { email: late, type: "sign-in" } });
		expect((await closed().auth("/sign-in/email-otp", { email: late, otp }, withKey)).status).toBe(400);
		expect(await users(late)).toBe(0);
	});

	test("an account someone else made for an address, unverified, loses its password and sessions when the owner signs in", async () => {
		const email = uniqueEmail();
		const squatter = uuid7();
		const now = new Date().toISOString();
		await db.batch([
			db.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, '', ?, 0, ?, ?)`).bind(squatter, email, now, now),
			db
				.prepare(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, ?, ?, ?)`)
				.bind(uuid7(), squatter, squatter, await hashPassword(PASSWORD), now, now),
			db
				.prepare(`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)`)
				.bind(uuid7(), new Date(Date.now() + 3_600_000).toISOString(), `squatter-${uuid7()}`, now, now, squatter),
		]);
		// Unverified, the password signs nobody in.
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).body.code).toBe("EMAIL_NOT_VERIFIED");

		const { browser, userId } = await signInWithCode(email);
		expect(userId).toBe(squatter);
		expect(await db.prepare(`SELECT count(*) AS n FROM account WHERE "userId" = ?`).bind(userId).first()).toEqual({ n: 0 });
		expect(await sessions(userId)).toBe(1);
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
		// The owner sets a password of their own.
		expect((await browser.call("POST", "/api/me/password", { password: NEW_PASSWORD })).status).toBe(204);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});
});

describe("the second factor", () => {
	async function withTwoFactor() {
		const account = await signedIn();
		return { ...account, ...(await enableTwoFactor(account.browser)) };
	}

	test("follows a password: no session, /api/me 401, until the TOTP code", async () => {
		const { email, uri } = await withTwoFactor();
		const browser = new Browser();
		const step = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		expect([step.status, step.body]).toEqual([200, { twoFactorRedirect: true, twoFactorMethods: ["totp"] }]);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await browser.call("POST", "/api/me/password", { password: NEW_PASSWORD })).status).toBe(401);
		const done = await browser.auth("/two-factor/verify-totp", { code: await totp(uri) });
		expect(done.status, JSON.stringify(done.body)).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});

	test("follows an email code too, and a backup code finishes it, once", async () => {
		const { email, backupCodes } = await withTwoFactor();
		const browser = new Browser();
		await sendCode(email, browser);
		const step = await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email) });
		expect([step.status, step.body]).toEqual([200, { twoFactorRedirect: true, twoFactorMethods: ["totp"] }]);
		expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await browser.auth("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);

		const again = new Browser();
		await again.auth("/sign-in/email", { email, password: PASSWORD });
		expect((await again.auth("/two-factor/verify-backup-code", { code: backupCodes[0] })).status).not.toBe(200);
		expect((await again.call("GET", "/api/me")).status).toBe(401);
	});
});

describe("the first password", () => {
	test("is set once by the signed-in user; then it is changed or reset, not set", async () => {
		const email = uniqueEmail();
		const { browser } = await signInWithCode(email);
		const short = await browser.call("POST", "/api/me/password", { password: "short" });
		expect([short.status, short.body.code, short.body.data.issues[0].path]).toEqual([422, "VALIDATION_FAILED", ["password"]]);
		expect((await browser.call("POST", "/api/me/password", { password: PASSWORD })).status).toBe(204);
		const again = await browser.call("POST", "/api/me/password", { password: NEW_PASSWORD });
		expect([again.status, again.body]).toEqual([409, contractError("PASSWORD_ALREADY_SET", PASSWORD_ALREADY_SET)]);
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(401);
	});

	test("is set by one of two requests sent at once, and the other is told it is set", async () => {
		const { browser, userId } = await signInWithCode(uniqueEmail());
		const answers = await Promise.all([PASSWORD, NEW_PASSWORD].map((password) => browser.call("POST", "/api/me/password", { password })));
		expect(answers.map((answer) => answer.status).sort()).toEqual([204, 409]);
		expect(await db.prepare(`SELECT count(*) AS n FROM account WHERE "userId" = ? AND "providerId" = 'credential'`).bind(userId).first()).toEqual({ n: 1 });
	});

	test("is refused without a session, and from another site", async () => {
		expect((await new Browser().call("POST", "/api/me/password", { password: PASSWORD })).body).toEqual(contractError("UNAUTHORIZED", "Unauthorized"));
		const email = uniqueEmail();
		const { browser, userId } = await signInWithCode(email);
		const crossSite = await browser.call("POST", "/api/me/password", { password: PASSWORD }, { Origin: "https://evil.example" });
		expect([crossSite.status, crossSite.body]).toEqual([403, contractError("CROSS_SITE", "Cross-site request refused.")]);
		expect(await db.prepare(`SELECT count(*) AS n FROM account WHERE "userId" = ?`).bind(userId).first()).toEqual({ n: 0 });
	});
});

describe("resets and changes end sessions", () => {
	async function reset(email: string, password: string): Promise<void> {
		const browser = new Browser();
		expect((await browser.auth("/email-otp/request-password-reset", { email })).status).toBe(200);
		expect(emailsTo(email).at(-1)?.subject).toBe("Your Minerva password reset code");
		const answer = await browser.auth("/email-otp/reset-password", { email, otp: lastCode(email), password });
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
	}

	test("a reset ends every session, and gives an account without a password its first", async () => {
		const email = uniqueEmail();
		const { browser: first } = await signInWithCode(email);
		const { browser: second } = await signInWithCode(email);
		await reset(email, PASSWORD);
		for (const browser of [first, second]) expect((await browser.call("GET", "/api/me")).status).toBe(401);
		const signedInAgain = new Browser();
		expect((await signedInAgain.auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);

		await reset(email, NEW_PASSWORD);
		expect((await signedInAgain.call("GET", "/api/me")).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	/** Whether a browser's pending second-factor challenge is still stored. */
	async function challengeStored(userId: string): Promise<boolean> {
		return (await db.prepare(`SELECT 1 FROM verification WHERE identifier LIKE '2fa-%' AND value = ?`).bind(userId).first()) !== null;
	}

	test("a reset ends the second-factor challenges started before it, and only the user's own", async () => {
		const { browser, email } = await signedIn();
		const { uri, backupCodes } = await enableTwoFactor(browser);
		const other = await signedIn();
		const { uri: otherUri } = await enableTwoFactor(other.browser);
		// Two of the target's challenges, after an email code and after a password; the other user's after a password.
		const target = new Browser();
		await sendCode(email, target);
		expect((await target.auth("/sign-in/email-otp", { email, otp: lastCode(email) })).body.twoFactorRedirect).toBe(true);
		const targetByPassword = new Browser();
		expect((await targetByPassword.auth("/sign-in/email", { email, password: PASSWORD })).body.twoFactorRedirect).toBe(true);
		const bystander = new Browser();
		expect((await bystander.auth("/sign-in/email", { email: other.email, password: PASSWORD })).body.twoFactorRedirect).toBe(true);

		await reset(email, NEW_PASSWORD);
		const refused = await target.auth("/two-factor/verify-backup-code", { code: backupCodes[0] });
		expect([refused.status, refused.body.code]).toEqual([401, "INVALID_TWO_FACTOR_COOKIE"]);
		expect((await target.call("GET", "/api/me")).status).toBe(401);
		const alsoRefused = await targetByPassword.auth("/two-factor/verify-totp", { code: await totp(uri) });
		expect([alsoRefused.status, alsoRefused.body.code]).toEqual([401, "INVALID_TWO_FACTOR_COOKIE"]);
		expect((await bystander.auth("/two-factor/verify-totp", { code: await totp(otherUri) })).status).toBe(200);

		const again = new Browser();
		expect((await again.auth("/sign-in/email", { email, password: NEW_PASSWORD })).body.twoFactorRedirect).toBe(true);
		expect((await again.auth("/two-factor/verify-totp", { code: await totp(uri) })).status).toBe(200);
		expect((await again.call("GET", "/api/me")).status).toBe(200);
	});

	test("a password change ends them too, even without revokeOtherSessions; a refused change does not", async () => {
		const { browser, email, userId } = await signedIn();
		const { uri } = await enableTwoFactor(browser);
		const pending = new Browser();
		expect((await pending.auth("/sign-in/email", { email, password: PASSWORD })).body.twoFactorRedirect).toBe(true);
		const wrong = await browser.auth("/change-password", { currentPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD });
		expect([wrong.status, wrong.body.code]).toEqual([400, "INVALID_PASSWORD"]);
		expect(await challengeStored(userId)).toBe(true);

		const changed = await browser.auth("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(await challengeStored(userId)).toBe(false);
		const refused = await pending.auth("/two-factor/verify-totp", { code: await totp(uri) });
		expect([refused.status, refused.body.code]).toEqual([401, "INVALID_TWO_FACTOR_COOKIE"]);
		expect((await pending.call("GET", "/api/me")).status).toBe(401);
	});

	test("a password change with revokeOtherSessions ends the others and keeps this browser signed in", async () => {
		const { browser, email } = await signedIn();
		const other = new Browser();
		expect((await other.auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		const changed = await browser.auth("/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true });
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		expect((await other.call("GET", "/api/me")).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});
});

describe("email codes", () => {
	// Three wrong guesses using a code up: accounts-ip-limits.test.ts, from addresses of their own.

	test("expire", async () => {
		const { email } = await signedIn();
		await sendCode(email);
		await db.prepare(`UPDATE verification SET "expiresAt" = ? WHERE identifier = ?`).bind(new Date(Date.now() - 1000).toISOString(), `sign-in-otp-${email}`).run();
		const expired = await new Browser().auth("/sign-in/email-otp", { email, otp: lastCode(email) });
		expect([expired.status, expired.body.code]).toEqual([400, "OTP_EXPIRED"]);
	});

	test("are stored encrypted, work once, and a resend replaces the code", async () => {
		const { email } = await signedIn();
		await sendCode(email);
		const older = lastCode(email);
		const stored = await db.prepare(`SELECT value FROM verification WHERE identifier = ?`).bind(`sign-in-otp-${email}`).first<{ value: string }>();
		expect(stored?.value).not.toContain(older);
		await sendCode(email);
		const newer = lastCode(email);
		if (older !== newer) expect((await new Browser().auth("/sign-in/email-otp", { email, otp: older })).status).toBe(400);
		expect((await new Browser().auth("/sign-in/email-otp", { email, otp: newer })).status).toBe(200);
		expect((await new Browser().auth("/sign-in/email-otp", { email, otp: newer })).status).toBe(400);
	});
});

test("only the listed endpoints answer: sign-up by password, email verification, admin and the rest are 404", async () => {
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
			const answer = await new Browser().call(method, `/api/auth${endpoint.path.replace(/:[A-Za-z]+/g, "x")}`, method === "POST" ? {} : undefined);
			expect(answer.status, route).toBe(404);
			refused.push(route);
		}
	}
	expect([...reached].sort()).toEqual([...BROWSER_ROUTES].sort());
	for (const route of [
		"POST /sign-up/email",
		"POST /email-otp/verify-email",
		"POST /email-otp/check-verification-otp",
		"POST /organization/create",
		"POST /organization/invite-member",
		"POST /admin/impersonate-user",
		"POST /admin/create-user",
		"POST /admin/set-role",
		"POST /change-email",
		"POST /update-user",
		"POST /delete-user",
		"POST /email-otp/change-email",
		"POST /send-verification-email",
	]) {
		expect(refused).toContain(route);
	}
});
