// Better Auth's per-IP limit on each route the browser reaches (src/accounts/ip-limits.ts): a person's pace
// passes, a burst is refused, and the guards against guessing do not rest on these numbers.

import { describe, expect, test } from "vitest";
import { IP_RULES } from "../../src/accounts/ip-limits.ts";
import { BROWSER_ROUTES } from "../../src/accounts/policy.ts";
import { Browser, PASSWORD, enableTwoFactor, installEmailLog, lastCode, signedIn, totp, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

const WRONG = "not the passphrase";

/** The statuses of `count` requests in a row from one browser. */
async function statuses(count: number, send: (browser: Browser, i: number) => Promise<{ status: number }>, browser = new Browser()): Promise<number[]> {
	const out: number[] = [];
	for (let i = 0; i < count; i++) out.push((await send(browser, i)).status);
	return out;
}

describe("the table", () => {
	test("every route the browser reaches has a rule, and no rule is for another route", () => {
		const routes = [...BROWSER_ROUTES].map((route) => route.slice(route.indexOf(" ") + 1)).sort();
		expect(Object.keys(IP_RULES).sort()).toEqual(routes);
	});

	test("a rule is a whole number of requests in a positive number of seconds, and no route is looser than a read", () => {
		for (const [path, rule] of Object.entries(IP_RULES)) {
			expect(Number.isInteger(rule.max) && rule.max > 0 && rule.window > 0, path).toBe(true);
		}
		// Anything that checks a password or a code, or sends mail, is far tighter than the session reads.
		for (const path of Object.keys(IP_RULES).filter((path) => !["/get-session", "/sign-out", "/organization/list", "/organization/get-full-organization"].includes(path))) {
			expect(IP_RULES[path]?.max, path).toBeLessThanOrEqual(10);
		}
	});
});

describe("a person's pace passes", () => {
	test("eight wrong passwords in a row from one address, for different accounts, are all answered", async () => {
		const answers = await statuses(8, (browser) => browser.auth("/sign-in/email", { email: uniqueEmail(), password: WRONG }));
		expect(answers).toEqual(Array(8).fill(401));
	});

	test("six wrong codes in a row are answered by the code's own budget, never by the IP limit", async () => {
		const { email } = await signedIn();
		const browser = new Browser();
		expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
		const answers = await statuses(6, (b) => b.auth("/sign-in/email-otp", { email, otp: "000000" }), browser);
		// Three wrong guesses spend the code (the fourth is refused as spent), then there is none.
		expect(answers).toEqual([400, 400, 400, 403, 400, 400]);
	});

	test("a hundred and fifty session reads and twenty sign-outs in a row are all answered", async () => {
		const { browser } = await signedIn();
		expect(await statuses(150, (b) => b.auth("/get-session"), browser)).toEqual(Array(150).fill(200));
		expect((await statuses(20, (b) => b.auth("/sign-out", {}), new Browser())).every((status) => status !== 429)).toBe(true);
	});

	test("ten code requests in a minute for different addresses, and ten sign-ups, are answered", async () => {
		const requests = await statuses(10, (browser) => browser.auth("/email-otp/send-verification-otp", { email: uniqueEmail(), type: "sign-in" }));
		expect(requests).toEqual(Array(10).fill(200));
		const signUps = await statuses(10, (browser) => browser.auth("/sign-up/email", { email: uniqueEmail(), password: PASSWORD, name: "" }));
		expect(signUps.every((status) => status !== 429)).toBe(true);
	}, 30_000);
});

describe("a burst is refused", () => {
	test("the eleventh password in a row is a 429 with a wait, only for that address and path", async () => {
		const browser = new Browser();
		const answers: { status: number; wait: string | null }[] = [];
		for (let i = 0; i < 11; i++) {
			const answer = await browser.auth("/sign-in/email", { email: uniqueEmail(), password: WRONG });
			answers.push({ status: answer.status, wait: answer.response.headers.get("X-Retry-After") });
		}
		expect(answers.map((answer) => answer.status)).toEqual([...Array(10).fill(401), 429]);
		expect(Number(answers[10]?.wait)).toBeGreaterThan(0);
		expect(Number(answers[10]?.wait)).toBeLessThanOrEqual(10);
		// Another path from the same address, and the same path from another address, are not affected.
		expect((await browser.auth("/get-session")).status).toBe(200);
		expect((await new Browser().auth("/sign-in/email", { email: uniqueEmail(), password: WRONG })).status).toBe(401);
	});

	test("the three hundred and first session read in a row is refused", async () => {
		const browser = new Browser();
		const answers = await statuses(301, (b) => b.auth("/get-session"), browser);
		expect(answers.slice(0, 300).every((status) => status === 200)).toBe(true);
		expect(answers[300]).toBe(429);
	}, 60_000);

	test("the eleventh code request in a minute is refused, whatever the address", async () => {
		const answers = await statuses(11, (browser) => browser.auth("/email-otp/request-password-reset", { email: uniqueEmail() }));
		expect(answers.slice(0, 10).every((status) => status === 200)).toBe(true);
		expect(answers[10]).toBe(429);
	});

	test("the eleventh code or second factor checked in a row is refused", async () => {
		const wrongCode = await statuses(11, (browser) => browser.auth("/email-otp/verify-email", { email: uniqueEmail(), otp: "000000" }));
		expect(wrongCode.slice(0, 10).every((status) => status !== 429)).toBe(true);
		expect(wrongCode[10]).toBe(429);
		const wrongSecondFactor = await statuses(11, (browser) => browser.auth("/two-factor/verify-totp", { code: "000000" }));
		expect(wrongSecondFactor.slice(0, 10).every((status) => status !== 429)).toBe(true);
		expect(wrongSecondFactor[10]).toBe(429);
	});
});

describe("the guards against guessing do not rest on the IP limit", () => {
	test("a wrong email code is spent after three guesses, so the right one is refused, from any addresses", async () => {
		const { email } = await signedIn();
		const first = new Browser();
		expect((await first.auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
		const code = lastCode(email);
		// Each guess from an address of its own: no IP limit is near.
		const guesses = [];
		for (let i = 0; i < 3; i++) guesses.push((await new Browser().auth("/sign-in/email-otp", { email, otp: code === "000000" ? "111111" : "000000" })).status);
		guesses.push((await new Browser().auth("/sign-in/email-otp", { email, otp: code })).status);
		// Three wrong guesses, then the right code is refused too.
		expect(guesses).toEqual([400, 400, 400, 403]);
	});

	test("a second-factor challenge allows five wrong codes, then not even the right one", async () => {
		const { browser: first, email } = await signedIn();
		const { uri } = await enableTwoFactor(first);
		const waiting = new Browser();
		const step = await waiting.auth("/sign-in/email", { email, password: PASSWORD });
		expect(step.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
		const wrong = await totp(uri, Date.now() + 10 * 60_000);
		const answers = await statuses(5, (b) => b.auth("/two-factor/verify-totp", { code: wrong }), waiting);
		expect(answers.every((status) => status === 401)).toBe(true);
		const right = await waiting.auth("/two-factor/verify-totp", { code: await totp(uri, Date.now() + 30_000) });
		expect(right.status).not.toBe(200);
		expect(waiting.cookies.has("minerva.session_token")).toBe(false);
	});
});
