// The accounts port against what Django and allauth answer today (test/fixtures/accounts-vectors.py):
// emails and password validators; and the scrypt hashes, rate-limit keys and mailer rules.

import { describe, expect, test, vi } from "vitest";
import vectors from "../fixtures/accounts-vectors.json" with { type: "json" };
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

describe("emails, as allauth renders them", () => {
	for (const [kind, expected] of Object.entries(vectors.emails)) {
		test(kind, () => {
			const email = render(kind as EmailKind, vectors.address, vectors.site.url, vectors.code);
			expect(email).toEqual({ to: expected.to[0], subject: expected.subject, body: expected.body });
		});
	}

	test("the sender is MINERVA_EMAIL_FROM", () => {
		expect(parseFrom(vectors.site.from)).toEqual({ name: "Minerva", email: "noreply@app.example.com" });
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

describe("password validators, as Django's", () => {
	for (const row of vectors.passwords) {
		test(JSON.stringify(row.password), () => {
			expect(validatePassword(row.password)).toEqual(row.signup);
			expect(validatePassword(row.password, { email: vectors.address })).toEqual(row.with_user);
		});
	}

	test("quick_ratio", () => {
		expect(quickRatio("", "")).toBe(1);
		expect(quickRatio("abcd", "bcde")).toBe(0.75);
		expect(quickRatio("a", "a".repeat(10))).toBeCloseTo(0.18181818181818182, 15);
	});
});

describe("scrypt hashes", () => {
	test("today's parameters, recorded in the hash", async () => {
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

	test("today's parameters verify without a rehash; older ones are replaced, and refused if the stored hash changed meanwhile", async () => {
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
