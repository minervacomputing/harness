// allauth's rate limits (web-api spec 5.7) as counters in D1, shared by every isolate rather than per
// process as today. allauth keeps a sliding log of timestamps per key; this keeps one row per key and fixed
// window, and estimates the sliding count as the current window's count plus the previous window's,
// weighted by how much of it the sliding window still covers. A refused attempt is not counted, as in
// allauth; checking the previous window (closed, so it no longer changes) and then counting with a
// conditional upsert keeps the limit under concurrency.
//
// Keys hold an HMAC of the address, user or IP under MINERVA_SECRET_KEY, never the value itself.
//
// The policy (policy.ts) counts the per-address and per-user rates; per IP, Better Auth's own limiter
// counts every route in D1 instead, with the numbers of ip-limits.ts (auth-options.ts), so the `ip` rates
// here and `manage_email` (email changes are not available yet) are kept as today's table but not applied.

import { hmacSha256Hex } from "../lib/hash.ts";

export interface Rate {
	/** The scope of the key: the client's IP, an address (`key`), or the signed-in user. */
	per: "ip" | "key" | "user";
	amount: number;
	seconds: number;
}

/** allauth's defaults; `confirm_email` limits sending codes, one per address every 10 s. */
export const RATE_LIMITS = {
	login: [{ per: "ip", amount: 30, seconds: 60 }],
	login_failed: [
		{ per: "ip", amount: 10, seconds: 60 },
		{ per: "key", amount: 5, seconds: 300 },
	],
	signup: [{ per: "ip", amount: 20, seconds: 60 }],
	request_login_code: [
		{ per: "ip", amount: 20, seconds: 60 },
		{ per: "key", amount: 3, seconds: 60 },
	],
	reset_password: [
		{ per: "ip", amount: 20, seconds: 60 },
		{ per: "key", amount: 5, seconds: 60 },
	],
	reset_password_from_key: [{ per: "ip", amount: 20, seconds: 60 }],
	confirm_email: [{ per: "key", amount: 1, seconds: 10 }],
	change_password: [{ per: "user", amount: 5, seconds: 60 }],
	reauthenticate: [{ per: "user", amount: 10, seconds: 60 }],
	manage_email: [{ per: "user", amount: 10, seconds: 60 }],
} as const satisfies Record<string, readonly Rate[]>;

export type Action = keyof typeof RATE_LIMITS;

export interface Subject {
	/** Missing when only the per-address or per-user counts matter (clearing them). */
	ip?: string;
	key?: string;
	user?: string;
}

/** A counted attempt, which can be taken back (`rollback`) as allauth does after a successful login. */
export interface Usage {
	rows: { key: string; windowStart: number }[];
}

export class RateLimits {
	readonly #db: D1Database;
	readonly #secret: string;
	readonly #now: () => number;

	constructor(db: D1Database, secret: string, now: () => number = Date.now) {
		this.#db = db;
		this.#secret = secret;
		this.#now = now;
	}

	async #keys(action: Action, subject: Subject): Promise<{ key: string; rate: Rate }[]> {
		const keys: { key: string; rate: Rate }[] = [];
		for (const rate of RATE_LIMITS[action] as readonly Rate[]) {
			const value = rate.per === "ip" ? subject.ip : rate.per === "key" ? subject.key : subject.user;
			// allauth skips a rate whose value is missing (no address, or nobody signed in).
			if (value === undefined) continue;
			const digest = await hmacSha256Hex(this.#secret, `minerva.accounts.rate-limit\u0000${rate.per}\u0000${value}`);
			keys.push({ key: `${action}:${rate.per}:${rate.seconds}:${digest}`, rate });
		}
		return keys;
	}

	async #capacity(key: string, rate: Rate, now: number): Promise<{ windowStart: number; cap: number }> {
		const duration = rate.seconds * 1000;
		const windowStart = Math.floor(now / duration) * duration;
		const previous = await this.#db
			.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?")
			.bind(key, windowStart - duration)
			.first<{ count: number }>();
		const weight = 1 - (now - windowStart) / duration;
		return { windowStart, cap: Math.ceil(rate.amount - (previous?.count ?? 0) * weight) };
	}

	/** Whether every rate of the action still allows an attempt, without counting one (allauth's dry run). */
	async allows(action: Action, subject: Subject): Promise<boolean> {
		const now = this.#now();
		for (const { key, rate } of await this.#keys(action, subject)) {
			const { windowStart, cap } = await this.#capacity(key, rate, now);
			const current = await this.#db
				.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?")
				.bind(key, windowStart)
				.first<{ count: number }>();
			if ((current?.count ?? 0) >= cap) return false;
		}
		return true;
	}

	/**
	 * Counts an attempt against every rate of the action, or returns null when one of them is used up. As in
	 * allauth, the rates before the one that refused stay counted.
	 */
	async consume(action: Action, subject: Subject): Promise<Usage | null> {
		const now = this.#now();
		const usage: Usage = { rows: [] };
		for (const { key, rate } of await this.#keys(action, subject)) {
			const { windowStart, cap } = await this.#capacity(key, rate, now);
			if (cap < 1) return null;
			const counted = await this.#db
				.prepare(
					"INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES (?, ?, 1, ?) " +
						"ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count",
				)
				.bind(key, windowStart, windowStart + 2 * rate.seconds * 1000, cap)
				.first<{ count: number }>();
			if (!counted) return null;
			usage.rows.push({ key, windowStart });
		}
		return usage;
	}

	/** Takes back the attempts a `consume` counted. */
	async rollback(usage: Usage): Promise<void> {
		if (!usage.rows.length) return;
		const statements = usage.rows.flatMap(({ key, windowStart }) => [
			this.#db.prepare("DELETE FROM rate_limits WHERE key = ? AND window_start = ? AND count = 1").bind(key, windowStart),
			this.#db.prepare("UPDATE rate_limits SET count = count - 1 WHERE key = ? AND window_start = ? AND count > 1").bind(key, windowStart),
		]);
		await this.#db.batch(statements);
	}

	/** Forgets every count of the action for a subject (a password reset clears failed logins for the address). */
	async clear(action: Action, subject: Subject): Promise<void> {
		const keys = await this.#keys(action, subject);
		if (keys.length) await this.#db.batch(keys.map(({ key }) => this.#db.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key)));
	}
}
