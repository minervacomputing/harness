// The security policy on top of Better Auth (plan: The web API). Better Auth decides who a
// request is; this decides what the browser may do with that, through Better Auth's hooks:
//
// - Routes. The browser reaches only BROWSER_ROUTES; every other endpoint (more organizations,
//   invitations, admin, impersonation, email changes, account deletion, the non-atomic code check)
//   answers 404 (auth.ts).
// - Credential stamps. Every session carries an HMAC of its user's id, email and password hash as they
//   were when the session was made, checked whenever a request carries the session (`revokeStale`).
//   Changing a password or an email therefore ends every session made before
//   it, in the same statement that changes it: nothing depends on a later delete. A session made from a
//   sign-in, a second factor or a password check takes the stamp of the credential that was checked, so
//   one that a reset overtook while it was being made is stale from the start.
// - Two factors for every sign-in. A first factor (password, email code, a verification that signs in)
//   for a user with two-factor makes only a placeholder session, already expired and stamped as pending,
//   which Better Auth's two-factor hook (widened to all of them, auth-options.ts) deletes before it
//   answers with the challenge; the stamp travels with the challenge. Trusted devices are off.
// - Who may create users and sessions at all: sign-up while signup is open (MINERVA_SIGNUP_OPEN or the
//   instance admins' setting) or admitted by the setup key before setup (instance.ts), our own server
//   code, and sessions only from the routes above for a verified address. Better Auth's `disableSignUp`
//   is off: the closure is this policy's, with Better Auth's answer, for the browser and our own calls.
// - Limits per address and per user (rate-limits.ts) alongside Better Auth's per IP, and the password
//   rules (passwords.ts).
// - A TOTP code works once (totp.ts).

import { createHmac } from "node:crypto";
import type { GenericEndpointContext } from "better-auth";
import { APIError, getSessionFromCtx, isAPIError } from "better-auth/api";
import { HttpError, detail } from "../http/errors.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import type { AuthPolicy } from "./auth-options.ts";
import { validatePassword } from "./passwords.ts";
import type { Action, RateLimits, Subject } from "./rate-limits.ts";
import { type AuthScope, type Holder, currentScope } from "./scope.ts";
import { claimTotpStep, invalidCode } from "./totp.ts";

/** Better Auth's endpoints the browser may call, as `METHOD /path` under /api/auth. */
export const BROWSER_ROUTES: ReadonlySet<string> = new Set([
	"POST /sign-up/email",
	"POST /sign-in/email",
	"POST /sign-out",
	"GET /get-session",
	"POST /change-password",
	"POST /email-otp/send-verification-otp",
	"POST /email-otp/verify-email",
	"POST /sign-in/email-otp",
	"POST /email-otp/request-password-reset",
	"POST /email-otp/reset-password",
	"POST /two-factor/enable",
	"POST /two-factor/disable",
	"POST /two-factor/get-totp-uri",
	"POST /two-factor/verify-totp",
	"POST /two-factor/verify-backup-code",
	"POST /two-factor/generate-backup-codes",
	"GET /organization/list",
	"GET /organization/get-full-organization",
]);

/** Routes that sign a user in with a first factor; Better Auth's two-factor hook covers all of them. */
export const FIRST_FACTOR = new Set(["/sign-in/email", "/sign-in/email-otp", "/email-otp/verify-email", "/verify-email"]);

/** Routes that answer a two-factor challenge, or, with a session, finish enabling two-factor. */
const SECOND_FACTOR = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);

/** Routes that replace the signed-in user's session with a new one (a new token, the same user). */
const REPLACE_SESSION = new Set(["/change-password", "/two-factor/enable", "/two-factor/disable", ...SECOND_FACTOR]);

/** Routes that check the signed-in user's password: the `reauthenticate` limit. */
const PASSWORD_CHECKS = new Set(["/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"]);

/** The stamp of a placeholder session whose sign-in waits for its second factor; never a valid stamp. */
const PENDING = "pending-second-factor";

/** The challenge Better Auth's two-factor hook makes (`2fa-<random>`), not its attempts or OTP rows. */
const CHALLENGE = /^2fa-(?!attempts-|otp-)/;
const CHALLENGE_STAMP = "minerva-stamp-";

/** Email codes (`<type>-otp-<address>`), and the routes that send a new one in place of the last. */
const EMAIL_CODE = /^(?:sign-in|email-verification|forget-password|change-email)-otp-/;
const CODE_SENDS = new Set(["/email-otp/send-verification-otp", "/email-otp/request-password-reset", "/sign-up/email"]);

/** Session cookies of any prefix; their values are `<token>.<signature>`. */
const SESSION_COOKIE = /session_token$/;
/** More than a browser ever sends; a request with more is refused rather than checked in part. */
const MAX_SESSION_COOKIES = 8;

export function credentialStamp(key: string, userId: string, email: string, password: string | null): string {
	return createHmac("sha256", key).update(`minerva/session-stamp\u0000${userId}\u0000${email}\u0000${password ?? ""}`).digest("base64url");
}

export interface PolicyDeps {
	db: D1Database;
	limits: RateLimits;
	/** Derived from MINERVA_SECRET_KEY for the stamps alone. */
	stampKey: string;
	/** Whether a sign-up may create an account; `headers` are the request's, null for our own server code (instance.ts). */
	signupAllowed(headers: Headers | null): Promise<boolean>;
	/** Tells the owner of an address that someone tried to sign up with it ("Account Already Exists"). */
	sendAlreadyExists(email: string): Promise<void>;
}

interface Credentials {
	email: string;
	emailVerified: boolean;
	twoFactorEnabled: boolean;
	password: string | null;
}

type Body = Record<string, unknown>;

function tooMany(code = "TOO_MANY_REQUESTS", message = "Too many requests. Please try again later."): APIError {
	return new APIError("TOO_MANY_REQUESTS", { code, message });
}

/** Better Auth's own answer when `disableSignUp` is on (api/routes/sign-up). */
function signUpDisabled(): APIError {
	return APIError.from("BAD_REQUEST", { message: "Email and password sign up is not enabled", code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
}

function passwordChanged(): APIError {
	return APIError.from("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" });
}

function challengeExpired(): APIError {
	return APIError.from("UNAUTHORIZED", { code: "INVALID_TWO_FACTOR_COOKIE", message: "Invalid two factor cookie" });
}

/** The password rules; the first failure names the error, all of them are listed. */
function checkPassword(password: unknown, email?: string): void {
	if (typeof password !== "string") return;
	const errors = validatePassword(password, email === undefined ? undefined : { email });
	const first = errors[0];
	if (first) throw new APIError("BAD_REQUEST", { code: first.code.toUpperCase(), message: first.message, errors });
}

export class Policy implements AuthPolicy {
	readonly #deps: PolicyDeps;

	constructor(deps: PolicyDeps) {
		this.#deps = deps;
	}

	stamp(userId: string, email: string, password: string | null): string {
		return credentialStamp(this.#deps.stampKey, userId, email, password);
	}

	async #credentials(userId: string): Promise<Credentials | null> {
		const row = await this.#deps.db
			.prepare(
				`SELECT u.email, u."emailVerified" AS verified, u."twoFactorEnabled" AS two_factor, ` +
					`(SELECT a.password FROM account a WHERE a."userId" = u.id AND a."providerId" = 'credential' ORDER BY a.id LIMIT 1) AS password ` +
					`FROM "user" u WHERE u.id = ?`,
			)
			.bind(userId)
			.first<{ email: string; verified: number; two_factor: number | null; password: string | null }>();
		if (!row) return null;
		return { email: row.email, emailVerified: row.verified === 1, twoFactorEnabled: row.two_factor === 1, password: row.password };
	}

	/**
	 * Deletes the sessions a request's cookies name whose credentials changed since they were made (or
	 * that never got a stamp), before Better Auth reads them. Every session cookie counts, whatever its
	 * prefix or signature: a stale session is deleted however it is named.
	 */
	async revokeStale(cookieHeader: string | null): Promise<void> {
		const tokens = sessionTokens(cookieHeader);
		if (!tokens.length) return;
		const { results } = await this.#deps.db
			.prepare(
				`SELECT s.id, s."userId" AS user_id, s."credentialStamp" AS stamp, u.email, ` +
					`(SELECT a.password FROM account a WHERE a."userId" = u.id AND a."providerId" = 'credential' ORDER BY a.id LIMIT 1) AS password ` +
					`FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE s.token IN (${tokens.map(() => "?").join(", ")})`,
			)
			.bind(...tokens)
			.all<{ id: string; user_id: string; stamp: string | null; email: string; password: string | null }>();
		const stale = results.filter((row) => row.stamp === null || !timingSafeEqual(row.stamp, this.stamp(row.user_id, row.email, row.password)));
		if (!stale.length) return;
		// Conditional on the stamp read, so a session whose stamp a rehash just carried over is kept.
		await this.#deps.db.batch(stale.map((row) => this.#deps.db.prepare(`DELETE FROM "session" WHERE id = ? AND "credentialStamp" IS ?`).bind(row.id, row.stamp)));
	}

	async #limit(action: Action, subject: Subject): Promise<void> {
		if (!(await this.#deps.limits.consume(action, subject))) throw tooMany();
	}

	/** The session the request carries, as Better Auth reads it, and the stamp it was made with. */
	async #holder(ctx: GenericEndpointContext, scope: AuthScope): Promise<Holder | null> {
		const session = await getSessionFromCtx(ctx);
		if (!session) return null;
		const row = await this.#deps.db.prepare(`SELECT "credentialStamp" AS stamp FROM "session" WHERE id = ?`).bind(session.session.id).first<{ stamp: string | null }>();
		if (!row?.stamp || row.stamp === PENDING) return null;
		scope.holder = { sessionId: session.session.id, userId: session.user.id, email: session.user.email, stamp: row.stamp };
		return scope.holder;
	}

	/** The two-factor challenge the request's cookie names, with the stamp its first factor left. */
	async #challenge(ctx: GenericEndpointContext, scope: AuthScope): Promise<void> {
		const cookie = ctx.context.createAuthCookie("two_factor");
		const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
		if (!identifier) return;
		const row = await ctx.context.internalAdapter.findVerificationValue(CHALLENGE_STAMP + identifier);
		if (!row || row.expiresAt < new Date()) return;
		const [userId, stamp] = row.value.split(" ");
		if (userId && stamp) scope.challenge = { userId, stamp, identifier };
	}

	async before(ctx: GenericEndpointContext): Promise<{ context: { body: Body } } | undefined> {
		const scope = currentScope();
		if (!scope) {
			// Our own server code signs nobody up while sign-up is closed either.
			if (ctx.path === "/sign-up/email" && !(await this.#deps.signupAllowed(null))) throw signUpDisabled();
			return undefined;
		}
		const body: Body = ctx.body !== null && typeof ctx.body === "object" ? (ctx.body as Body) : {};
		const email = typeof body.email === "string" ? body.email.toLowerCase() : undefined;
		if (FIRST_FACTOR.has(ctx.path ?? "")) scope.claimedEmail = email;
		switch (ctx.path) {
			case "/sign-in/email": {
				if (email === undefined) return undefined;
				// Counted before the password is checked, so concurrent guesses cannot overrun the budget.
				const usage = await this.#deps.limits.consume("login_failed", { key: email });
				if (!usage) throw tooMany("TOO_MANY_LOGIN_ATTEMPTS", "Too many failed login attempts. Try again later.");
				scope.loginUsage = usage;
				return undefined;
			}
			case "/sign-up/email":
				// Sign-up has no user yet, so the password is not compared with one.
				checkPassword(body.password);
				// After the password, as Better Auth checked `disableSignUp` in the endpoint, after this hook.
				if (!(await this.#deps.signupAllowed(ctx.headers ?? null))) throw signUpDisabled();
				scope.signupAdmitted = true;
				return undefined;
			case "/email-otp/reset-password":
				checkPassword(body.password, email);
				return undefined;
			case "/email-otp/send-verification-otp": {
				const action = body.type === "sign-in" ? "request_login_code" : body.type === "email-verification" ? "confirm_email" : null;
				// Reset codes come from request-password-reset; email changes are not available yet.
				if (action === null) throw APIError.from("BAD_REQUEST", { code: "UNSUPPORTED_OTP_TYPE", message: "This kind of code cannot be requested here." });
				if (email !== undefined) await this.#limit(action, { key: email });
				return undefined;
			}
			case "/email-otp/request-password-reset":
				if (email !== undefined) await this.#limit("reset_password", { key: email });
				return undefined;
			case "/change-password": {
				const holder = await this.#holder(ctx, scope);
				if (!holder) return undefined;
				await this.#limit("change_password", { user: holder.userId });
				checkPassword(body.newPassword, holder.email);
				// The new password makes every other session stale; this one is replaced by a fresh one.
				return { context: { body: { revokeOtherSessions: true } } };
			}
		}
		if (PASSWORD_CHECKS.has(ctx.path ?? "")) {
			const holder = await this.#holder(ctx, scope);
			if (holder) await this.#limit("reauthenticate", { user: holder.userId });
			return undefined;
		}
		if (SECOND_FACTOR.has(ctx.path ?? "")) {
			if (!(await this.#holder(ctx, scope))) await this.#challenge(ctx, scope);
			// A TOTP code works once (totp.ts). Without a holder or a challenge Better Auth refuses the request.
			const userId = scope.holder?.userId ?? scope.challenge?.userId;
			if (ctx.path === "/two-factor/verify-totp" && userId && typeof body.code === "string") {
				scope.totpClaimed = await claimTotpStep(this.#deps.db, ctx.context.secretConfig, userId, body.code);
			}
			return { context: { body: { trustDevice: false } } };
		}
		return undefined;
	}

	async after(ctx: GenericEndpointContext): Promise<void> {
		const scope = currentScope();
		if (!scope) return;
		const returned = (ctx.context as { returned?: unknown }).returned;
		if (ctx.path === "/sign-in/email" && scope.loginUsage) {
			const wrong = isAPIError(returned) && (returned.body as { code?: unknown } | undefined)?.code === "INVALID_EMAIL_OR_PASSWORD";
			if (!wrong) await this.#deps.limits.rollback(scope.loginUsage);
		}
		if (ctx.path === "/email-otp/reset-password" && !isAPIError(returned)) {
			const email = (ctx.body as Body | undefined)?.email;
			if (typeof email === "string") await this.#deps.limits.clear("login_failed", { key: email.toLowerCase() });
		}
	}

	/** Users are created by a sign-up the before hook admitted, and by our own server code (seed); nothing else. */
	async userCreating(endpoint: GenericEndpointContext | null): Promise<boolean> {
		const scope = currentScope();
		if (!scope) return true;
		return endpoint?.path === "/sign-up/email" && scope.signupAdmitted === true;
	}

	async sessionCreating(session: { userId: string }, endpoint: GenericEndpointContext | null): Promise<false | { data: { credentialStamp: string; expiresAt?: Date } }> {
		const scope = currentScope();
		const path = endpoint?.path;
		if (!scope || !endpoint || !path) return false;
		// Better Auth reads the clock after the hook: a code it accepted across a step boundary, which the
		// hook found no step for, gets no session (totp.ts).
		if (path === "/two-factor/verify-totp" && !scope.totpClaimed) throw invalidCode();
		const user = await this.#credentials(session.userId);
		if (!user?.emailVerified) return false;
		if (FIRST_FACTOR.has(path)) {
			// The address and password this sign-in checked, not whatever is stored now: a change in between wins.
			const stamp = this.stamp(session.userId, scope.claimedEmail ?? user.email, scope.verifiedHash ?? user.password);
			scope.signIn = { userId: session.userId, stamp };
			if (user.twoFactorEnabled) return { data: { credentialStamp: PENDING, expiresAt: new Date(0) } };
			return { data: { credentialStamp: stamp } };
		}
		if (REPLACE_SESSION.has(path) && scope.holder?.userId === session.userId) {
			if (scope.writtenHash !== undefined) return { data: { credentialStamp: this.stamp(session.userId, user.email, scope.writtenHash) } };
			// The session it replaces, as it is now: a rehash while checking the password moved its stamp.
			const current = await this.#deps.db.prepare(`SELECT "credentialStamp" AS stamp FROM "session" WHERE id = ?`).bind(scope.holder.sessionId).first<{ stamp: string | null }>();
			return { data: { credentialStamp: current?.stamp ?? scope.holder.stamp } };
		}
		if (SECOND_FACTOR.has(path) && scope.challenge?.userId === session.userId) {
			const { stamp, identifier } = scope.challenge;
			await endpoint.context.internalAdapter.deleteVerificationByIdentifier(CHALLENGE_STAMP + identifier);
			if (!timingSafeEqual(stamp, this.stamp(session.userId, user.email, user.password))) throw challengeExpired();
			return { data: { credentialStamp: stamp } };
		}
		return false;
	}

	/** A two-factor challenge is made only for a first factor this request passed; its stamp is kept beside it. */
	async verificationCreating(verification: { identifier: string; value: string; expiresAt: Date }, endpoint: GenericEndpointContext | null): Promise<boolean> {
		if (EMAIL_CODE.test(verification.identifier)) {
			// A new code replaces the address's earlier ones, so only the latest code can be used, even by
			// requests racing in other isolates (Better Auth consumes the newest row, then deletes the rest).
			if (endpoint && CODE_SENDS.has(endpoint.path ?? "")) await endpoint.context.internalAdapter.deleteVerificationByIdentifier(verification.identifier);
			return true;
		}
		if (!CHALLENGE.test(verification.identifier)) return true;
		const signIn = currentScope()?.signIn;
		if (!signIn || !endpoint || signIn.userId !== verification.value) return false;
		await endpoint.context.internalAdapter.createVerificationValue({
			identifier: CHALLENGE_STAMP + verification.identifier,
			value: `${signIn.userId} ${signIn.stamp}`,
			expiresAt: verification.expiresAt,
		});
		return true;
	}

	passwordVerified(hash: string): void {
		const scope = currentScope();
		if (scope) scope.verifiedHash = hash;
	}

	passwordWritten(hash: string): void {
		const scope = currentScope();
		if (scope) scope.writtenHash = hash;
	}

	/**
	 * A password change is written here, conditional on the hash the request checked, in place of Better
	 * Auth's unconditional write: a reset that lands while the change runs is never undone by it.
	 */
	async accountUpdating(account: { password?: unknown }, endpoint: GenericEndpointContext | null): Promise<false | undefined> {
		const scope = currentScope();
		if (!scope || typeof account.password !== "string") return undefined;
		scope.writtenHash = account.password;
		if (endpoint?.path !== "/change-password") return undefined;
		const checked = scope.verifiedHash;
		if (!scope.holder || checked === undefined) throw passwordChanged();
		const written = await this.#deps.db
			.prepare(`UPDATE account SET password = ?, "updatedAt" = ? WHERE "userId" = ? AND "providerId" = 'credential' AND password = ?`)
			.bind(account.password, new Date().toISOString(), scope.holder.userId, checked)
			.run();
		if (written.meta.changes === 0) throw passwordChanged();
		return false;
	}

	/** Sign-up with a taken address answers as if it were new and mails the owner, once per address per 10 s. */
	async existingUserSignedUp(email: string): Promise<void> {
		if (await this.#deps.limits.consume("confirm_email", { key: email.toLowerCase() })) await this.#deps.sendAlreadyExists(email);
	}
}

/**
 * The tokens of every session cookie in a Cookie header (better-call's reading: quotes and %-escapes).
 * Every one is checked, so padding the header cannot push the one Better Auth reads out of reach.
 */
export function sessionTokens(header: string | null): string[] {
	const tokens = new Set<string>();
	if (!header) return [];
	for (const part of header.split(";")) {
		const split = part.indexOf("=");
		if (split < 0 || !SESSION_COOKIE.test(part.slice(0, split).trim())) continue;
		let value = part.slice(split + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		try {
			value = decodeURIComponent(value);
		} catch {
			// Kept as sent; better-call does the same.
		}
		const dot = value.lastIndexOf(".");
		const token = dot > 0 ? value.slice(0, dot) : value;
		if (token) tokens.add(token);
		if (tokens.size > MAX_SESSION_COOKIES) throw new HttpError(detail(400, "Too many session cookies."));
	}
	return [...tokens];
}

/** Better Auth's trusted-device cookie, of any prefix, removed from every request: trusted devices are off. */
const TRUST_DEVICE_COOKIE = /trust_device$/;

export function withoutTrustedDevice(header: string | null): string | null {
	if (!header) return header;
	return header
		.split(";")
		.filter((part) => {
			const split = part.indexOf("=");
			return split < 0 || !TRUST_DEVICE_COOKIE.test(part.slice(0, split).trim());
		})
		.join(";");
}
