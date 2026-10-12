// The emails allauth sends today (web-api spec 5.9), with the same subjects and bodies: the templates are
// allauth's, rendered for the site "Minerva" at the host of MINERVA_SITE_URL, and
// test/fixtures/accounts-vectors.json holds what Django renders for them.
//
// The transport changes (plan: The web API): with MINERVA_DEBUG on, an email is written to the Worker's
// log, as `make dev` prints codes today; otherwise it goes through the Email Sending binding `EMAIL`. A
// Worker with neither refuses every request (`checkMailer`), so a deploy cannot silently drop codes. Codes
// never reach the log outside debug.

import { settings, type SettingsEnv } from "../config.ts";

export type EmailKind = "verify_signup" | "verify_login" | "already_exists" | "login_code" | "unknown_account" | "password_reset_code";

export interface Email {
	to: string;
	subject: string;
	body: string;
}

export interface MailEnv extends SettingsEnv {
	EMAIL?: SendEmail;
}

const SUBJECTS: Record<EmailKind, string> = {
	verify_signup: "Please Confirm Your Email Address",
	verify_login: "Please Confirm Your Email Address",
	already_exists: "Account Already Exists",
	login_code: "Sign-In Code",
	unknown_account: "Unknown Account",
	password_reset_code: "Password Reset Code",
};

const IGNORE = "This mail can be safely ignored if you did not initiate this action.";

function content(kind: EmailKind, to: string, site: { url: string; domain: string }, code: string | undefined): string {
	switch (kind) {
		case "verify_signup":
		case "verify_login":
			return (
				`You're receiving this email because user ${to} has given your email address to register an account on ${site.domain}.\n\n` +
				`Your email verification code is listed below. Please enter it in your open browser window.\n\n${code}`
			);
		case "already_exists":
			return (
				"You are receiving this email because you or someone else tried to signup for an\naccount using email address:\n\n" +
				`${to}\n\n` +
				"However, an account using that email address already exists.  In case you have\n" +
				"forgotten about this, please use the password forgotten procedure to recover\nyour account:\n\n" +
				`${site.url}/reset-password`
			);
		case "login_code":
			return `Your sign-in code is listed below. Please enter it in your open browser window.\n\n${code}\n\n${IGNORE}`;
		case "unknown_account":
			return (
				`You are receiving this email because you, or someone else, tried to access an account with email ${to}. ` +
				"However, we do not have any record of such an account in our database.\n\n" +
				`${IGNORE}\n\nIf it was you, you can sign up for an account using the link below.\n\n${site.url}/signup`
			);
		case "password_reset_code":
			return `Your password reset code is listed below. Please enter it in your open browser window.\n\n${code}\n\n${IGNORE}`;
	}
}

/** The email as allauth renders it. `to` is also the user's display name, which is their address. */
export function render(kind: EmailKind, to: string, siteUrl: string, code?: string): Email {
	const site = { url: siteUrl, domain: new URL(siteUrl).host };
	const body = `Hello from Minerva!\n\n${content(kind, to, site, code)}\n\nThank you for using Minerva!\n${site.domain}`;
	return { to, subject: `[Minerva] ${SUBJECTS[kind]}`, body };
}

/** `Name <address>` or a bare address, as MINERVA_EMAIL_FROM is written. */
export function parseFrom(from: string): { name: string; email: string } {
	const match = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
	if (match) return { name: match[1] ?? "", email: match[2] ?? "" };
	return { name: "", email: from.trim() };
}

/**
 * Where an email goes when debug is off, if not through the Email Sending binding. Production leaves it
 * unset. The test build (src/faults/mailbox.ts) sets it to a capture its token-gated driver reads, and has
 * no EMAIL binding, so the test Worker sends no mail.
 */
export const MAIL_TRANSPORT: { send: ((env: MailEnv, email: Email) => Promise<void>) | null } = { send: null };

/** Refuses to run without a way to deliver codes: debug's log, the Email Sending binding or the test build's capture. */
export function checkMailer(env: MailEnv): void {
	if (!settings(env).debug && !env.EMAIL && !MAIL_TRANSPORT.send) {
		throw new Error("Emails need the EMAIL binding (Email Sending) unless MINERVA_DEBUG is on.");
	}
}

export async function sendEmail(env: MailEnv, email: Email): Promise<void> {
	const { debug, emailFrom } = settings(env);
	if (debug) {
		console.log(`Email to ${email.to} from ${emailFrom}\nSubject: ${email.subject}\n\n${email.body}`);
		return;
	}
	checkMailer(env);
	if (MAIL_TRANSPORT.send) return MAIL_TRANSPORT.send(env, email);
	const from = parseFrom(emailFrom);
	await env.EMAIL!.send({ from: from.name ? from : from.email, to: email.to, subject: email.subject, text: email.body });
}
