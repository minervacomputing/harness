// Better Auth's configuration (plan: The web API), shared by the Worker (auth.ts) and by the CLI that
// generates the D1 schema (scripts/auth-schema.ts), so the migrations are made from the same plugins and
// fields the Worker runs with. Everything that touches the Worker's bindings comes in through `AuthDeps`;
// this module imports nothing that needs the runtime.
//
// Better Auth 1.7.7 (pinned; the handoff records why). Storage is D1 through the Kysely adapter's own D1
// dialect, which has no interactive transactions: every multi-row operation of Better Auth (sign-up
// writes the user, then the credential account; a password reset updates the account, then deletes
// sessions) is a sequence of single statements. Its single-row consume and increment are one statement
// each (`DELETE … WHERE id IN (SELECT … LIMIT 1) RETURNING`, `UPDATE … RETURNING`), so codes are used once.
// What we add on top (provisioning, provision.ts) is written to recover from a crash between statements.
//
// The security policy (policy.ts) comes in as `AuthPolicy`: its database hooks decide which users and
// sessions may be made and stamp sessions with their credentials; its plugin adds limits and validators
// around Better Auth's endpoints; and Better Auth's two-factor hook is widened to every first factor.

import type { BetterAuthOptions, BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, emailOTP, organization, twoFactor } from "better-auth/plugins";
import { uuid7 } from "../lib/random.ts";
import { IP_LIMIT_OPTIONS } from "./ip-limits.ts";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.ts";

export type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

/** The security policy's side of Better Auth's hooks (policy.ts). */
export interface AuthPolicy {
	before(ctx: GenericEndpointContext): Promise<{ context: { body: Record<string, unknown> } } | undefined>;
	after(ctx: GenericEndpointContext): Promise<void>;
	userCreating(endpoint: GenericEndpointContext | null): Promise<boolean>;
	sessionCreating(session: { userId: string }, endpoint: GenericEndpointContext | null): Promise<false | { data: { credentialStamp: string; expiresAt?: Date } }>;
	verificationCreating(verification: { identifier: string; value: string; expiresAt: Date }, endpoint: GenericEndpointContext | null): Promise<boolean>;
	/** A password hash a request checked successfully (after any rehash). */
	passwordVerified(hash: string): void;
	/** A password hash a request is about to store in a new account. */
	passwordWritten(hash: string): void;
	/** An account about to be updated; false when the policy wrote it itself (a conditional password change). */
	accountUpdating(account: { password?: unknown }, endpoint: GenericEndpointContext | null): Promise<false | undefined>;
	existingUserSignedUp(email: string): Promise<void>;
}

export interface AuthDeps {
	/** MINERVA_SITE_URL: Better Auth's base URL and its only trusted origin. */
	siteUrl: string;
	/** Derived from MINERVA_SECRET_KEY (auth.ts); signs cookies and encrypts two-factor secrets. */
	secret: string;
	debug: boolean;
	/** The D1 binding; absent when the CLI generates the schema. */
	database?: BetterAuthOptions["database"];
	/** A keyed hash of an email code, so a leaked database does not hold usable codes. */
	hashCode(code: string): Promise<string>;
	sendCode(email: string, code: string, type: OtpType): Promise<void>;
	/** After any user is created (sign-up, an email code, the admin plugin, seed): provisioning. */
	userCreated(userId: string): Promise<void>;
	/** After any session is created: provisioning is repaired if a crash left it pending. */
	sessionCreated(userId: string): Promise<void>;
	/**
	 * A verified password whose hash has older scrypt parameters gets a new hash in its place, if the
	 * stored hash is still the old one; false when it no longer was.
	 */
	rehashed(oldHash: string, newHash: string): Promise<boolean>;
	policy: AuthPolicy;
}

/**
 * Better Auth's custom hash: our scrypt (passwords.ts), rehashed with the current parameters when verified.
 * A password whose stored hash changed while it was being checked (a reset in between) is refused rather
 * than accepted against the hash it replaced.
 */
function passwordHasher(deps: AuthDeps) {
	return {
		hash: (password: string) => hashPassword(password),
		verify: async ({ hash, password }: { hash: string; password: string }) => {
			const valid = await verifyPassword(password, hash);
			if (!valid) return false;
			let current = hash;
			if (needsRehash(hash)) {
				try {
					const newHash = await hashPassword(password);
					if (!(await deps.rehashed(hash, newHash))) return false;
					current = newHash;
				} catch (error) {
					console.error("Rehashing a password failed", error);
				}
			}
			deps.policy.passwordVerified(current);
			return true;
		},
	};
}

/** Two weeks; a session in use is extended once a day. */
export const SESSION_SECONDS = 14 * 24 * 3600;

/** Better Auth's two-factor plugin with its sign-in hook run after every first factor (policy.ts), not just a password. */
function everyFirstFactor(plugin: ReturnType<typeof twoFactor>, firstFactor: ReadonlySet<string>) {
	const after = plugin.hooks.after;
	// One hook in 1.7.7: the sign-in challenge. Anything else after an upgrade needs reviewing first.
	if (after.length !== 1) throw new Error("Better Auth's two-factor plugin changed its hooks; review policy.ts.");
	return { ...plugin, hooks: { ...plugin.hooks, after: after.map((hook) => ({ ...hook, matcher: (ctx: { path?: string }) => firstFactor.has(ctx.path ?? "") })) } };
}

/** Routes that sign in with a first factor; kept here, not imported, so the CLI loads no runtime code. */
const FIRST_FACTOR: ReadonlySet<string> = new Set(["/sign-in/email", "/sign-in/email-otp", "/email-otp/verify-email", "/verify-email"]);

/** The policy's hooks around every endpoint (policy.ts). First among the plugins, so its limits run first. */
function policyPlugin(policy: AuthPolicy) {
	return {
		id: "minerva-policy",
		hooks: {
			before: [{ matcher: () => true, handler: createAuthMiddleware(async (ctx) => policy.before(ctx as unknown as GenericEndpointContext)) }],
			after: [{ matcher: () => true, handler: createAuthMiddleware(async (ctx) => policy.after(ctx as unknown as GenericEndpointContext)) }],
		},
	} satisfies BetterAuthPlugin;
}

function passwordWrite(deps: AuthDeps, account: { password?: unknown }): undefined {
	if (typeof account.password === "string") deps.policy.passwordWritten(account.password);
	return undefined;
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
			// Sign-up is closed by the policy's before hook (policy.ts), which answers as this option would:
			// whether it is open is the instance admins' setting or MINERVA_SIGNUP_OPEN, read per request.
			disableSignUp: false,
			requireEmailVerification: true,
			autoSignIn: false,
			minPasswordLength: 10,
			password: passwordHasher(deps),
			revokeSessionsOnPasswordReset: true,
			// Sign-up with a taken address answers as for a new one; the owner gets an email instead.
			onExistingUserSignUp: async ({ user }: { user: { email: string } }) => deps.policy.existingUserSignedUp(user.email),
		},
		emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: false },
		session: {
			expiresIn: SESSION_SECONDS,
			updateAge: 24 * 3600,
			// Every request reads the session from D1, so a revoked session ends on its next request.
			cookieCache: { enabled: false },
			// Five minutes from a sign-in count as recent. The sensitive endpoints the browser reaches (password,
			// two-factor) ask for the password every time; this bounds any that rely on a recent sign-in.
			freshAge: 300,
			additionalFields: {
				// What the session's user, address and password were when it was made (policy.ts).
				credentialStamp: { type: "string", required: false, input: false, returned: false },
			},
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
			user: {
				create: {
					before: async (_user, endpoint) => deps.policy.userCreating(endpoint ?? null),
					after: async (user: { id: string }) => deps.userCreated(user.id),
				},
			},
			session: {
				create: {
					before: async (session, endpoint) => deps.policy.sessionCreating(session, endpoint ?? null),
					after: async (session: { userId: string }) => deps.sessionCreated(session.userId),
				},
			},
			verification: { create: { before: async (verification, endpoint) => deps.policy.verificationCreating(verification, endpoint ?? null) } },
			account: {
				create: { before: async (account) => passwordWrite(deps, account) },
				update: { before: async (account, endpoint) => deps.policy.accountUpdating(account, endpoint ?? null) },
			},
		},
		plugins: [
			policyPlugin(deps.policy),
			emailOTP({
				sendVerificationOTP: ({ email, otp, type }) => deps.sendCode(email, otp, type),
				overrideDefaultEmailVerification: true,
				sendVerificationOnSignUp: true,
				// A code for an unknown address never creates an account.
				disableSignUp: true,
				allowedAttempts: 3,
				storeOTP: { hash: (otp: string) => deps.hashCode(otp) },
			}),
			everyFirstFactor(twoFactor({ issuer: "Minerva" }), FIRST_FACTOR),
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
