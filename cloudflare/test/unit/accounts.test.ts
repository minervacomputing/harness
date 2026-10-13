// Accounts: the emails, the mailer and the options Better Auth runs with.

import { describe, expect, test, vi } from "vitest";
import { authOptions } from "../../src/accounts/auth-options.ts";
import { MAIL_TRANSPORT, checkMailer, codeEmail, parseFrom, sendEmail } from "../../src/accounts/emails.ts";
import type { SettingsEnv } from "../../src/config.ts";

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

	test("a sign-in code, which is also how a new address signs up", () => {
		expect(codeEmail("sign-in", "ada@example.com", "123456", SITE, 5)).toEqual({
			to: "ada@example.com",
			subject: "Your Minerva sign-in code",
			body: "Enter this code to sign in to Minerva at app.example.com:\n\n123456\n\nIt expires in 5 minutes. If you did not ask for it, you can ignore this email.\n",
		});
	});

	test("a password reset code", () => {
		const email = codeEmail("password-reset", "ada@example.com", "654321", SITE, 5);
		expect(email.subject).toBe("Your Minerva password reset code");
		expect(email.body).toContain("reset your Minerva password at app.example.com:\n\n654321\n\n");
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
		await sendEmail(env, { to: "ada@example.com", subject: "Your Minerva sign-in code", body: "123456" });
		expect(send).toHaveBeenCalledWith({
			from: { name: "Minerva", email: "noreply@app.example.com" },
			to: "ada@example.com",
			subject: "Your Minerva sign-in code",
			text: "123456",
		});
	});

	test("a transport set by the test build replaces the binding, but not debug's log", async () => {
		const captured = vi.fn(async () => {});
		const send = vi.fn();
		MAIL_TRANSPORT.send = captured;
		try {
			expect(() => checkMailer(settingsEnv())).not.toThrow();
			const email = { to: "ada@example.com", subject: "Your Minerva sign-in code", body: "123456" };
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

describe("Better Auth's options", () => {
	const never = async (): Promise<never> => {
		throw new Error("unused");
	};
	const options = (allowSignUp: boolean) => authOptions({ siteUrl: "http://localhost", secret: "s".repeat(32), debug: true, allowSignUp, sendCode: never, userCreated: never, sessionCreated: never });
	const plugin = (allowSignUp: boolean, id: string) => options(allowSignUp).plugins.find((candidate) => candidate.id === id);

	test("no user is made from a password; an email code makes one only when sign-up is allowed", () => {
		expect(options(true).emailAndPassword).toMatchObject({ disableSignUp: true, requireEmailVerification: true, minPasswordLength: 10, revokeSessionsOnPasswordReset: true });
		expect((plugin(true, "email-otp") as { options: { disableSignUp: boolean } }).options).toMatchObject({ disableSignUp: false, storeOTP: "encrypted", allowedAttempts: 3 });
		expect((plugin(false, "email-otp") as { options: { disableSignUp: boolean } }).options.disableSignUp).toBe(true);
	});

	test("the second factor follows a password and an email code", () => {
		const twoFactor = plugin(false, "two-factor") as { hooks: { after: { matcher(ctx: { path?: string }): boolean }[] } };
		const matches = (path: string) => twoFactor.hooks.after.some((hook) => hook.matcher({ path }));
		expect(["/sign-in/email", "/sign-in/email-otp"].filter(matches)).toEqual(["/sign-in/email", "/sign-in/email-otp"]);
		expect(["/sign-up/email", "/get-session", "/two-factor/verify-totp"].filter(matches)).toEqual([]);
	});
});
