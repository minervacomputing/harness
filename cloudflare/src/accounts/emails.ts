// The account emails: an email code to sign in (which also signs up a new address) and one to reset a
// password, for the site "Minerva" at the host of MINERVA_SITE_URL.
//
// With MINERVA_DEBUG on, an email is written to the Worker's log; otherwise it goes through the Email Sending binding `EMAIL`. A
// Worker with neither refuses every request (`checkMailer`), so a deploy cannot silently drop codes. Codes
// never reach the log outside debug.

import { settings, type SettingsEnv } from "../config.ts";

export type CodeKind = "sign-in" | "password-reset";

export interface Email {
	to: string;
	subject: string;
	body: string;
}

export interface MailEnv extends SettingsEnv {
	EMAIL?: SendEmail;
}

const PURPOSE: Record<CodeKind, { subject: string; action: string }> = {
	"sign-in": { subject: "Your Minerva sign-in code", action: "sign in to Minerva" },
	"password-reset": { subject: "Your Minerva password reset code", action: "reset your Minerva password" },
};

/** An email with a code that works for `minutes`. */
export function codeEmail(kind: CodeKind, to: string, code: string, siteUrl: string, minutes: number): Email {
	const { subject, action } = PURPOSE[kind];
	const host = new URL(siteUrl).host;
	const body = `Enter this code to ${action} at ${host}:\n\n${code}\n\nIt expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.\n`;
	return { to, subject, body };
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
