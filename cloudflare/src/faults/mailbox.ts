// The test build's mailbox (src/faults/): every email the test Worker would send (src/accounts/emails.ts,
// with debug off) is kept here instead, in one Durable Object, for the account tests to read through the
// token-gated driver (routes.ts: `emails`, `emails-clear`). The test build has no Email Sending binding, so
// nothing it does reaches a real inbox. It keeps the newest messages only.

import { DurableObject } from "cloudflare:workers";
import type { Email, MailEnv } from "../accounts/emails.ts";

/** How many messages the mailbox keeps; older ones are dropped as new ones arrive. */
export const MAILBOX_LIMIT = 500;

export interface CapturedEmail extends Email {
	seq: number;
	/** When it was captured, in milliseconds. */
	at: number;
}

export class FaultMailbox extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS emails (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL) STRICT",
		);
	}

	capture(email: Email): void {
		const sql = this.ctx.storage.sql;
		sql.exec("INSERT INTO emails (at, recipient, subject, body) VALUES (?, ?, ?, ?)", Date.now(), email.to.toLowerCase(), email.subject, email.body);
		sql.exec("DELETE FROM emails WHERE seq <= (SELECT MAX(seq) FROM emails) - ?", MAILBOX_LIMIT);
	}

	/** The messages to one address (compared without case), or every message, oldest first. */
	list(to: string | null): CapturedEmail[] {
		const rows = to === null ? this.ctx.storage.sql.exec("SELECT * FROM emails ORDER BY seq") : this.ctx.storage.sql.exec("SELECT * FROM emails WHERE recipient = ? ORDER BY seq", to.toLowerCase());
		return rows.toArray().map((row) => ({ seq: Number(row.seq), at: Number(row.at), to: String(row.recipient), subject: String(row.subject), body: String(row.body) }));
	}

	/** Drops the messages to one address, or every message; answers how many were dropped. */
	clear(to: string | null): number {
		const cursor = to === null ? this.ctx.storage.sql.exec("DELETE FROM emails") : this.ctx.storage.sql.exec("DELETE FROM emails WHERE recipient = ?", to.toLowerCase());
		return cursor.rowsWritten;
	}
}

export function mailboxOf(env: unknown): DurableObjectStub<FaultMailbox> {
	return (env as { FAULT_MAILBOX: DurableObjectNamespace<FaultMailbox> }).FAULT_MAILBOX.getByName("mailbox");
}

/** The test build's transport (emails.ts MAIL_TRANSPORT): into the mailbox, never out. */
export async function captureEmail(env: MailEnv, email: Email): Promise<void> {
	await mailboxOf(env).capture(email);
}
