// Better Auth's per-IP limit for each route the browser reaches (policy.ts BROWSER_ROUTES), replacing its
// defaults, which stop people: 3 requests per 10 s on every sign-in, sign-up and password route, 3 per
// minute on the code routes and on every second-factor route. Four wrong codes in 10 s, or a few people
// signing in at once from one office, got a 429.
//
// What a rule means. The limiter (better-auth/api/rate-limiter, storage "database") keys a row by the
// client's address and the path. A request is allowed while fewer than `max` have been allowed in a row,
// each less than `window` seconds after the one before; a refused request counts for nothing, so a client
// that hammers is refused until `window` seconds after its last allowed request, then gets `max` more. It
// is a brake on volume from one address (IPv6 by its /64), not the guard against guessing: that is
// per address, per code and per user, and none of it depends on these numbers:
//
// - sign-in by password: 5 failed attempts per address in 300 s (rate-limits.ts `login_failed`);
// - email codes: 3 attempts per code (`allowedAttempts`), and 3 codes per address per minute
//   (`request_login_code`), 5 resets per address per minute (`reset_password`), one verification email per
//   address per 10 s (`confirm_email`);
// - second factor: Better Auth's own lockout of the user after 10 failed codes for 15 minutes, 5 attempts
//   per challenge, and a TOTP step is used once (totp.ts);
// - password and two-factor changes: 5 password changes and 10 password re-checks per user per minute.
//
// Routes are tiered by what they cost and what they guard:
//
//   reads (session, sign-out, organizations)  generous    100 to 300 per 10 s
//   passwords and codes being checked         moderate    10 per 10 s
//   sign-up and code requests (they send mail) moderate   10 per 60 s
//
// The IP is `CF-Connecting-IP` (auth-options.ts), which Cloudflare sets; without it everyone shares one
// bucket per path. A new route in BROWSER_ROUTES needs a line here (a test checks).

export interface IpRule {
	/** Seconds a client may be quiet before its count starts again. */
	window: number;
	/** Requests allowed in a row, each within `window` of the one before. */
	max: number;
}

const READ: IpRule = { window: 10, max: 100 };
const CHECK: IpRule = { window: 10, max: 10 };
const MAIL: IpRule = { window: 60, max: 10 };

/** Better Auth's route (under /api/auth) to its limit. */
export const IP_RULES: Readonly<Record<string, IpRule>> = {
	"/get-session": { window: 10, max: 300 },
	"/sign-out": READ,
	"/organization/list": READ,
	"/organization/get-full-organization": READ,

	"/sign-in/email": CHECK,
	"/sign-in/email-otp": CHECK,
	"/email-otp/verify-email": CHECK,
	"/email-otp/reset-password": CHECK,
	"/change-password": CHECK,
	"/two-factor/enable": CHECK,
	"/two-factor/disable": CHECK,
	"/two-factor/get-totp-uri": CHECK,
	"/two-factor/verify-totp": CHECK,
	"/two-factor/verify-backup-code": CHECK,
	"/two-factor/generate-backup-codes": CHECK,

	"/sign-up/email": MAIL,
	"/email-otp/send-verification-otp": MAIL,
	"/email-otp/request-password-reset": MAIL,
};

/** What Better Auth's `rateLimit` option takes besides `enabled` and `storage`. */
export const IP_LIMIT_OPTIONS = {
	// A route without a rule (none the browser reaches; a new one fails the test) gets the read rate.
	window: READ.window,
	max: READ.max,
	customRules: IP_RULES,
} as const;
