// Accounts: emails, password rules, scrypt hashes and the mailer.

import { describe, expect, test, vi } from "vitest";
import { MAIL_TRANSPORT, checkMailer, type EmailKind, parseFrom, render, sendEmail } from "../../src/accounts/emails.ts";
import { type AuthPolicy, authOptions } from "../../src/accounts/auth-options.ts";
import { hashPassword, needsRehash, quickRatio, SCRYPT, validatePassword, verifyPassword } from "../../src/accounts/passwords.ts";
import type { SettingsEnv } from "../../src/config.ts";

const FAST = { logN: 10, r: 8, p: 1 };

function settingsEnv(overrides: Partial<SettingsEnv> = {}): SettingsEnv {
	return {
		MINERVA_SITE_URL: "https://app.example.com",
		MINERVA_DOWNLOAD_ORIGIN: "https://files.example.com",
		MINERVA_DEBUG: "false",
		MINERVA_SIGNUP_OPEN: "true",
		MINERVA_EMAIL_FROM: "Minerva <noreply@app.example.com>",
		MINERVA_RUN_TIMEOUT_SECONDS: "",
		MINERVA_MODEL_PROVIDER: "workers-ai",
		MINERVA_MODEL_NAME: "@cf/example/model",
		MINERVA_MODEL_GATEWAY: "minerva-cf",
		MINERVA_MODEL_API: "chat",
		MINERVA_MODEL_MAX_OUTPUT_TOKENS: "8192",
		MINERVA_MODEL_REASONING_EFFORT: "",
		MINERVA_MODEL_REASONING_SUMMARY: "",
		MINERVA_FILES_FOLDER_BYTES: "268435456",
		MINERVA_FILES_FOLDER_ENTRIES: "10000",
		MINERVA_FILES_RUN_UPLOAD_BYTES: "",
		MINERVA_FILES_WORKSPACE_BYTES: "",
		MINERVA_FILES_UPLOAD_BYTES: "52428800",
		MINERVA_FILES_MESSAGE_ATTACHMENTS: "10",
		...overrides,
	};
}

describe("emails", () => {
	const SITE = "https://app.example.com";
	const signature = "\n\nThank you for using Minerva!\napp.example.com";

	test.each([
		["verify_signup", "[Minerva] Please Confirm Your Email Address", ["user ada@example.com has given your email address", "account on app.example.com", "\n\n123456"]],
		["verify_login", "[Minerva] Please Confirm Your Email Address", ["\n\n123456"]],
		["already_exists", "[Minerva] Account Already Exists", ["\n\nada@example.com\n\n", "https://app.example.com/reset-password"]],
		["login_code", "[Minerva] Sign-In Code", ["Your sign-in code", "\n\n123456\n\n", "safely ignored"]],
		["unknown_account", "[Minerva] Unknown Account", ["account with email ada@example.com", "https://app.example.com/signup"]],
		["password_reset_code", "[Minerva] Password Reset Code", ["Your password reset code", "\n\n123456\n\n", "safely ignored"]],
	] as const)("%s", (kind, subject, fragments) => {
		const email = render(kind as EmailKind, "ada@example.com", SITE, "123456");
		expect([email.to, email.subject]).toEqual(["ada@example.com", subject]);
		expect(email.body.startsWith("Hello from Minerva!\n\n") && email.body.endsWith(signature)).toBe(true);
		for (const fragment of fragments) expect(email.body).toContain(fragment);
	});

	test("a code email in full", () => {
		expect(render("login_code", "ada@example.com", SITE, "123456").body).toBe(
			"Hello from Minerva!\n\nYour sign-in code is listed below. Please enter it in your open browser window.\n\n123456\n\n" +
				"This mail can be safely ignored if you did not initiate this action.\n\nThank you for using Minerva!\napp.example.com",
		);
	});

	test("the sender is MINERVA_EMAIL_FROM", () => {
		expect(parseFrom("Minerva <noreply@app.example.com>")).toEqual({ name: "Minerva", email: "noreply@app.example.com" });
		expect(parseFrom("noreply@example.com")).toEqual({ name: "", email: "noreply@example.com" });
	});
});

describe("the mailer", () => {
	test("refuses to run without debug or the Email Sending binding", async () => {
		expect(() => checkMailer(settingsEnv())).toThrow(/EMAIL binding/);
		expect(() => checkMailer(settingsEnv({ MINERVA_DEBUG: "true" }))).not.toThrow();
		const send = vi.fn(async () => ({ messageId: "m" }));
		const env = { ...settingsEnv(), EMAIL: { send } as unknown as SendEmail };
		expect(() => checkMailer(env)).not.toThrow();
		await sendEmail(env, { to: "ada@example.com", subject: "[Minerva] Sign-In Code", body: "123456" });
		expect(send).toHaveBeenCalledWith({
			from: { name: "Minerva", email: "noreply@app.example.com" },
			to: "ada@example.com",
			subject: "[Minerva] Sign-In Code",
			text: "123456",
		});
	});

	test("a transport set by the test build replaces the binding, but not debug's log", async () => {
		const captured = vi.fn(async () => {});
		const send = vi.fn();
		MAIL_TRANSPORT.send = captured;
		try {
			expect(() => checkMailer(settingsEnv())).not.toThrow();
			const email = { to: "ada@example.com", subject: "[Minerva] Sign-In Code", body: "123456" };
			await sendEmail({ ...settingsEnv(), EMAIL: { send } as unknown as SendEmail }, email);
			expect(captured).toHaveBeenCalledWith(expect.anything(), email);
			expect(send).not.toHaveBeenCalled();
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await sendEmail(settingsEnv({ MINERVA_DEBUG: "true" }), email);
			expect(captured).toHaveBeenCalledTimes(1);
			log.mockRestore();
		} finally {
			MAIL_TRANSPORT.send = null;
		}
	});

	test("writes to the log in debug, and only there", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const send = vi.fn();
		await sendEmail({ ...settingsEnv({ MINERVA_DEBUG: "true" }), EMAIL: { send } as unknown as SendEmail }, { to: "ada@example.com", subject: "s", body: "123456" });
		expect(send).not.toHaveBeenCalled();
		expect(log.mock.calls[0]?.[0]).toContain("123456");
		log.mockRestore();
	});
});

describe("password rules", () => {
	const SHORT = "password_too_short";
	const COMMON = "password_too_common";
	const NUMERIC = "password_entirely_numeric";
	const SIMILAR = "password_too_similar";

	test.each([
		["", [SHORT], [SHORT]],
		["short", [SHORT], [SHORT]],
		["password", [SHORT, COMMON], [SHORT, COMMON]],
		["123456789", [SHORT, COMMON, NUMERIC], [SHORT, COMMON, NUMERIC]],
		["1234567890", [COMMON, NUMERIC], [COMMON, NUMERIC]],
		["abcdefghij", [COMMON], [COMMON]],
		["aaaaaaaaaa", [COMMON], [COMMON]],
		// The common list is compared in lowercase, without surrounding spaces.
		["PASSWORD1234", [COMMON], [COMMON]],
		["  password  ", [COMMON], [COMMON]],
		["qwertyuiop", [COMMON], [COMMON]],
		["correct horse battery staple", [], []],
		["trustno1trustno1", [], []],
		// Numbers in any script are numbers; lengths count characters, not UTF-16 units.
		["\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660", [NUMERIC], [NUMERIC]],
		["\u00b2".repeat(10), [NUMERIC], [NUMERIC]],
		["\u{1f600}".repeat(9), [SHORT], [SHORT]],
		["\u{1f600}".repeat(10), [], []],
		["\u00e9".repeat(10), [], []],
		// Similarity to the address, only once the user is known.
		["ada@example.com", [], [SIMILAR]],
		["adaexample", [], [SIMILAR]],
		["example.com1", [], [SIMILAR]],
		["ada@example.comx", [], [SIMILAR]],
		["Ada Lovelace!", [], []],
		["lovelace-ada-1815", [], []],
	])("%j", (password, signup, withUser) => {
		expect(validatePassword(password).map((error) => error.code)).toEqual(signup);
		expect(validatePassword(password, { email: "ada@example.com" }).map((error) => error.code)).toEqual(withUser);
	});

	test("every failing rule is listed, with its message, the similar one first", () => {
		expect(validatePassword("123", { email: "123@example.com" })).toEqual([
			{ message: "The password is too similar to the email.", code: SIMILAR },
			{ message: "This password is too short. It must contain at least 10 characters.", code: SHORT },
			{ message: "This password is too common.", code: COMMON },
			{ message: "This password is entirely numeric.", code: NUMERIC },
		]);
	});

	test("the similarity ratio counts the characters two texts share", () => {
		expect(quickRatio("", "")).toBe(1);
		expect(quickRatio("abcd", "bcde")).toBe(0.75);
		expect(quickRatio("a", "a".repeat(10))).toBeCloseTo(0.18181818181818182, 15);
	});
});

describe("scrypt hashes", () => {
	test("the production parameters, recorded in the hash", async () => {
		expect(SCRYPT).toEqual({ logN: 15, r: 8, p: 3 });
		const hash = await hashPassword("correct horse battery staple");
		expect(hash).toMatch(/^scrypt\$15\$8\$3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
		expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
		expect(needsRehash(hash)).toBe(false);
	});

	test("verification, salts and older parameters", async () => {
		const hash = await hashPassword("password", FAST);
		expect(await verifyPassword("password", hash)).toBe(true);
		expect(await verifyPassword("Password", hash)).toBe(false);
		expect(await hashPassword("password", FAST)).not.toBe(hash);
		expect(needsRehash(hash)).toBe(true);
		// Non-ASCII passwords are hashed as UTF-8.
		const unicode = await hashPassword("zażółć gęślą jaźń", FAST);
		expect(await verifyPassword("zażółć gęślą jaźń", unicode)).toBe(true);
	});

	test("an unknown or malformed hash matches nothing", async () => {
		for (const hash of ["", "!unusable", "pbkdf2_sha256$1500000$salt$hash", "scrypt$15$8$3$c2FsdA$", "scrypt$40$8$1$c2FsdHNhbHRzYWx0c2FsdA$" + "A".repeat(43)]) {
			expect(await verifyPassword("password", hash)).toBe(false);
			expect(needsRehash(hash)).toBe(true);
		}
	});
});


describe("Better Auth's custom hash", () => {
	const never = async (): Promise<never> => {
		throw new Error("unused");
	};
	// The hashes the policy is told were verified (policy.ts: a session takes the stamp of the checked hash).
	let verified: string[] = [];
	const policy = new Proxy({} as AuthPolicy, { get: (_target, name) => (name === "passwordVerified" ? (hash: string) => verified.push(hash) : never) });
	const hasher = (rehashed: (old: string, hash: string) => Promise<boolean>) =>
		authOptions({ siteUrl: "http://localhost", secret: "s".repeat(32), debug: true, hashCode: never, sendCode: never, userCreated: never, sessionCreated: never, rehashed, policy })
			.emailAndPassword.password;

	test("hashes with the production parameters verify without a rehash; older ones are replaced, and refused if the stored hash changed meanwhile", async () => {
		verified = [];
		const calls: string[] = [];
		const current = await hashPassword("password");
		expect(await hasher(never).verify({ hash: current, password: "password" })).toBe(true);
		expect(await hasher(never).verify({ hash: current, password: "wrong" })).toBe(false);
		expect(verified).toEqual([current]);
		const old = await hashPassword("password", FAST);
		let replacement = "";
		const replaced = hasher(async (from, to) => (calls.push(from), (replacement = to), expect(to).toMatch(/^scrypt\$15\$8\$3\$/), true));
		expect(await replaced.verify({ hash: old, password: "password" })).toBe(true);
		expect(calls).toEqual([old]);
		expect(verified).toEqual([current, replacement]);
		expect(await hasher(async () => false).verify({ hash: old, password: "password" })).toBe(false);
		expect(await hasher(never).verify({ hash: old, password: "wrong" })).toBe(false);
		expect(verified).toEqual([current, replacement]);
	});
});
