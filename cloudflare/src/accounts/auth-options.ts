// Better Auth's configuration (plan: The web API), shared by the Worker (auth.ts) and by the CLI that
// generates the D1 schema (scripts/auth-schema.ts), so the migrations are made from the same plugins and
// fields the Worker runs with. Everything that touches the Worker's bindings comes in through `AuthDeps`;
// this module imports nothing that needs the runtime.
//
// Better Auth 1.7.7 (pinned; the handoff records why), used with its own defaults: its scrypt hasher, its
// per-IP limiter, its email-code and two-factor plugins (docs/plans/plain-better-auth.md). Storage is D1
// through the Kysely adapter's own D1 dialect, which has no interactive transactions: every multi-row
// operation of Better Auth (a password reset updates the account, then deletes sessions) is a sequence of
// single statements. Its single-row consume and increment are one statement each, so codes are used once.
// What we add on top (provisioning, provision.ts) is written to recover from a crash between statements.
//
// Ours around it: sign-up only by email code, open or closed per request (`allowSignUp`, auth.ts), the
// two-factor challenge after an email code too (`everyFirstFactor`), and provisioning.

import type { BetterAuthOptions } from "better-auth";
import { admin, emailOTP, organization, twoFactor } from "better-auth/plugins";
import { uuid7 } from "../lib/random.ts";
import { IP_LIMIT_OPTIONS } from "./ip-limits.ts";

export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export interface AuthDeps {
	/** MINERVA_SITE_URL: Better Auth's base URL and its only trusted origin. */
	siteUrl: string;
	/** Derived from MINERVA_SECRET_KEY (auth.ts); signs cookies and encrypts two-factor secrets and email codes. */
	secret: string;
	debug: boolean;
	/** The D1 binding; absent when the CLI generates the schema. */
	database?: BetterAuthOptions["database"];
	/** Whether an email code may create a user for an address nobody has (instance.ts `signupAllowed`). */
	allowSignUp: boolean;
	sendCode(email: string, code: string, type: OtpType): Promise<void>;
	/** After any user is created (an email code, the admin plugin, seed): provisioning. */
	userCreated(userId: string): Promise<void>;
	/** After any session is created: provisioning is repaired if a crash left it pending. */
	sessionCreated(userId: string): Promise<void>;
}

/** Wrong guesses an email code takes before it is used up. */
export const CODE_ATTEMPTS = 3;

/** How long an email code works. */
export const CODE_SECONDS = 300;

/** Better Auth's only password rule. */
export const MIN_PASSWORD_LENGTH = 10;

/** Two weeks; a session in use is extended once a day. */
export const SESSION_SECONDS = 14 * 24 * 3600;

/** Routes that sign in with a first factor; the second factor follows each of them. */
const FIRST_FACTOR: ReadonlySet<string> = new Set(["/sign-in/email", "/sign-in/email-otp"]);

/**
 * Better Auth's two-factor plugin with its sign-in hook run after every first factor. Its own matcher has
 * `/sign-in/email` but not `/sign-in/email-otp`, so without this an email code would skip the second factor.
 */
function everyFirstFactor(plugin: ReturnType<typeof twoFactor>) {
	const after = plugin.hooks.after;
	// One hook in 1.7.7: the sign-in challenge. Anything else after an upgrade needs reviewing first.
	if (after.length !== 1) throw new Error("Better Auth's two-factor plugin changed its hooks; review everyFirstFactor.");
	return { ...plugin, hooks: { ...plugin.hooks, after: after.map((hook) => ({ ...hook, matcher: (ctx: { path?: string }) => FIRST_FACTOR.has(ctx.path ?? "") })) } };
}

/** Where Better Auth answers; the router sends `${AUTH_BASE_PATH}/*` to it. */
export const AUTH_BASE_PATH = "/api/auth";

export function authOptions(deps: AuthDeps) {
	return {
		appName: "Minerva",
		baseURL: deps.siteUrl,
		basePath: AUTH_BASE_PATH,
		secret: deps.secret,
		// Exact origins only: the site itself. Better Auth adds baseURL's origin; nothing else is trusted.
		trustedOrigins: [new URL(deps.siteUrl).origin],
		database: deps.database,
		telemetry: { enabled: false },
		emailAndPassword: {
			enabled: true,
			// Users are made by an email code (the email-OTP plugin below), never from a password: the
			// password comes after, set by the signed-in user (routes.ts `/api/me/password`).
			disableSignUp: true,
			requireEmailVerification: true,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			revokeSessionsOnPasswordReset: true,
		},
		session: {
			expiresIn: SESSION_SECONDS,
			updateAge: 24 * 3600,
			// Every request reads the session from D1, so a revoked session ends on its next request.
			cookieCache: { enabled: false },
			// Five minutes from a sign-in count as recent. The sensitive endpoints the browser reaches (password,
			// two-factor) ask for the password every time; this bounds any that rely on a recent sign-in.
			freshAge: 300,
		},
		// On everywhere (Better Auth's default is production only), counted in D1 so every isolate shares them,
		// per address and path, with the numbers of ip-limits.ts instead of Better Auth's own.
		rateLimit: { enabled: true, storage: "database", ...IP_LIMIT_OPTIONS },
		user: {
			additionalFields: {
				// Null until the user's organization, workspace and Workspace object exist (provision.ts).
				provisionedAt: { type: "date", required: false, input: false, returned: false },
			},
		},
		advanced: {
			// Cloudflare sets CF-Connecting-IP and overwrites a client's; forwarded headers are not read.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			useSecureCookies: !deps.debug,
			cookiePrefix: "minerva",
			// Our tables (workspaces, memberships, oauth_flows) and the API's ids are UUIDs.
			// No schema check at run time: Better Auth runs it once for each instance, which is once for each
			// request (auth.ts), and the requests sharing an instance would all wait on its D1 queries. The
			// migrations are checked against the schema by the platform tests.
			database: { generateId: () => uuid7(), validateSchema: false },
		},
		databaseHooks: {
			user: { create: { after: async (user: { id: string }) => deps.userCreated(user.id) } },
			session: { create: { after: async (session: { userId: string }) => deps.sessionCreated(session.userId) } },
		},
		plugins: [
			emailOTP({
				sendVerificationOTP: ({ email, otp, type }) => deps.sendCode(email, otp, type),
				// Off, `/sign-in/email-otp` makes a verified user for a new address; on, an unknown address gets no
				// email and its code is refused. An unverified user (made before codes were the only sign-up) loses
				// its passwords and sessions when its owner signs in with a code.
				disableSignUp: !deps.allowSignUp,
				expiresIn: CODE_SECONDS,
				allowedAttempts: CODE_ATTEMPTS,
				// Encrypted with Better Auth's secret: hashing six digits would be undone at once by whoever reads D1.
				storeOTP: "encrypted",
			}),
			everyFirstFactor(twoFactor({ issuer: "Minerva" })),
			organization({
				// Organizations are made by provisioning only; the UI does not show them yet (plan: The web API).
				allowUserToCreateOrganization: false,
				disableOrganizationDeletion: true,
				schema: {
					organization: {
						additionalFields: {
							// The user a personal organization was made for: unique, so a retried provisioning finds it.
							// Deleting that user is refused while it exists (its workspaces' data needs cleanup first).
							personalOwner: {
								type: "string",
								required: false,
								input: false,
								unique: true,
								references: { model: "user", field: "id", onDelete: "restrict" },
							},
							// Where the organization's workspaces keep their data (src/addressing.ts); server-controlled.
							jurisdiction: { type: "string", required: false, input: false },
						},
					},
				},
			}),
			admin({ defaultRole: "user", adminRoles: ["admin"] }),
		],
	} satisfies BetterAuthOptions;
}
