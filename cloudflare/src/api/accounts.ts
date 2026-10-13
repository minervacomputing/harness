// The procedures outside a workspace (contract/src/accounts.ts): who is signed in, their first password, the
// first-run setup and the instance's administration (accounts/instance.ts). The mount (api/orpc.ts) refuses a visitor everywhere but
// the setup's status, and a caller who is not an instance admin under /api/instance, before the body is read.
// Every change an admin makes requires the role again in its own statement, so a role removed a moment ago
// counts, even for a request already past the mount's check.
//
// An admin can remove another user's two-factor (docs/plans/auth-fixes.md, C3): someone with a user's password and a session can
// put their own authenticator on the account, and no password reset undoes that. The owner resets the password first (ending the
// sessions and the password the attacker knew), then an admin removes the authenticator and any session left.

import { type InstanceAdmin, type InstanceSettings, REFUSALS } from "@minerva/contract";
import { ORPCError } from "@orpc/server";
import { isAPIError } from "better-auth/api";
import { getAuth } from "../accounts/auth.ts";
import { ADMINS_ONLY, ALREADY_SET_UP, INVALID_KEY, LAST_ADMIN, NO_SUCH_USER, OWN_TWO_FACTOR, claimSetup, isInstanceAdmin, isSetUp, setupKeyValid, signupOverride } from "../accounts/instance.ts";
import { ensureProvisioned, listWorkspaces } from "../accounts/provision.ts";
import { settings as config } from "../config.ts";
import { api, instanceAdmin, refusal, signedIn } from "./procedures.ts";

/** The SQL condition that the caller (the next parameter) is an admin: in each change's own statement, so a role removed meanwhile counts. */
const CALLER_IS_ADMIN = `EXISTS (SELECT 1 FROM "user" WHERE id = ? AND role = 'admin')`;

async function currentSettings(env: Env): Promise<InstanceSettings> {
	const override = await signupOverride(env.DB);
	const configured = config(env).signupOpen;
	return { signupOpen: override ?? configured, signupOpenOverride: override, signupOpenConfigured: configured };
}

async function admins(env: Env): Promise<InstanceAdmin[]> {
	return (await env.DB.prepare(`SELECT id, email, name FROM "user" WHERE role = 'admin' ORDER BY "createdAt", id`).all<InstanceAdmin>()).results;
}

/** The caller is still an admin, or `INSTANCE_ADMINS_ONLY`: why a change that requires the role changed nothing. */
async function stillAdmin(env: Env, userId: string): Promise<void> {
	if (!(await isInstanceAdmin(env.DB, userId))) throw refusal("INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
}

export const meProcedure = api.me.use(signedIn).handler(async ({ context: { env, user } }) => {
	// A user whose provisioning a crash left pending gets it finished here (accounts/provision.ts).
	await ensureProvisioned(env, user.id);
	return {
		user: { id: user.id, email: user.email, name: user.name, role: user.role === "admin" ? ("admin" as const) : ("user" as const) },
		workspaces: await listWorkspaces(env, user.id),
	};
});

export const PASSWORD_ALREADY_SET = "This account already has a password.";

/** Whether the user has a password: Better Auth's credential account, with a hash. */
async function hasPassword(db: D1Database, userId: string): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS found FROM account WHERE "userId" = ? AND "providerId" = 'credential' AND password IS NOT NULL`).bind(userId).first();
	return row !== null;
}

/** A password Better Auth's rules refuse, as the contract's 422 on `password`. */
function passwordRefused(code: "PASSWORD_TOO_SHORT" | "PASSWORD_TOO_LONG", message: string): ORPCError<"VALIDATION_FAILED", unknown> {
	const issues = [{ path: ["password"], message, code: code === "PASSWORD_TOO_SHORT" ? "too_small" : "too_big" }];
	return new ORPCError("VALIDATION_FAILED", { defined: true, status: REFUSALS.VALIDATION_FAILED, message: `password: ${message}`, data: { issues } });
}

// The first password of a user an email code signed up (plan: plain Better Auth). A password already set is changed with the
// current one or reset by email code, so this refuses it, before Better Auth spends a hash on it (its limiter does not count
// `auth.api` calls). The mount's CSRF check and JSON reader apply, as to every procedure.
export const passwordProcedures = api.password.router({
	set: api.password.set.use(signedIn).handler(async ({ context: { env, request, user }, input: { password } }) => {
		if (await hasPassword(env.DB, user.id)) throw refusal("PASSWORD_ALREADY_SET", PASSWORD_ALREADY_SET);
		try {
			await getAuth(env).api.setPassword({ body: { newPassword: password }, headers: request.headers });
		} catch (error) {
			// Set by a request that raced this one past the check above: Better Auth's own check, or the unique index on the
			// credential account (migration 0007) refusing the second insert.
			if (await hasPassword(env.DB, user.id)) throw refusal("PASSWORD_ALREADY_SET", PASSWORD_ALREADY_SET);
			if (!isAPIError(error)) throw error;
			const { code, message } = (error.body ?? {}) as { code?: string; message?: string };
			if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") throw passwordRefused(code, message ?? code);
			if (error.statusCode === 401) throw refusal("UNAUTHORIZED", "Unauthorized");
			throw error;
		}
	}),
});

export const setupProcedures = api.setup.router({
	status: api.setup.status.handler(async ({ context: { env } }) => ({ needed: !(await isSetUp(env.DB)) })),

	claim: api.setup.claim.use(signedIn).handler(async ({ context: { env, user }, input: { headers } }) => {
		if (!(await setupKeyValid(env, headers["x-minerva-setup-key"]))) throw refusal("INVALID_SETUP_KEY", INVALID_KEY);
		if (!(await claimSetup(env.DB, user.id))) throw refusal("ALREADY_SET_UP", ALREADY_SET_UP);
	}),
});

const instance = api.instance.use(instanceAdmin);

export const instanceProcedures = instance.router({
	settings: {
		get: instance.settings.get.handler(({ context: { env } }) => currentSettings(env)),

		update: instance.settings.update.handler(async ({ context: { env, user }, input: { signupOpen } }) => {
			const value = signupOpen === null ? null : signupOpen ? 1 : 0;
			const saved = await env.DB.prepare(
				`INSERT INTO instance_settings (id, signup_open, updated_at, updated_by) SELECT 1, ?, ?, ? WHERE ${CALLER_IS_ADMIN} ` +
					"ON CONFLICT (id) DO UPDATE SET signup_open = excluded.signup_open, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
			)
				.bind(value, Date.now(), user.id, user.id)
				.run();
			if (saved.meta.changes === 0) throw refusal("INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
			return currentSettings(env);
		}),
	},

	admins: {
		list: instance.admins.list.handler(({ context: { env } }) => admins(env)),

		add: instance.admins.add.handler(async ({ context: { env, user }, input: { email } }) => {
			const promoted = await env.DB.prepare(`UPDATE "user" SET role = 'admin', "updatedAt" = ? WHERE email = ? AND ${CALLER_IS_ADMIN} RETURNING id`)
				.bind(new Date().toISOString(), email.trim().toLowerCase(), user.id)
				.first<{ id: string }>();
			if (promoted === null) {
				await stillAdmin(env, user.id);
				throw refusal("NO_SUCH_USER", NO_SUCH_USER);
			}
			return admins(env);
		}),

		remove: instance.admins.remove.handler(async ({ context: { env, user }, input: { userId } }) => {
			// One statement: of concurrent removals of the last two admins, the second finds one left, and a
			// caller removed meanwhile removes nobody.
			const demoted = await env.DB.prepare(
				`UPDATE "user" SET role = 'user', "updatedAt" = ? WHERE id = ? AND role = 'admin' AND (SELECT count(*) FROM "user" WHERE role = 'admin') > 1 AND ${CALLER_IS_ADMIN}`,
			)
				.bind(new Date().toISOString(), userId, user.id)
				.run();
			if (demoted.meta.changes > 0) return;
			await stillAdmin(env, user.id);
			if (!(await isInstanceAdmin(env.DB, userId))) throw refusal("NOT_FOUND", "Not found.");
			throw refusal("KEEP_ONE_ADMIN", LAST_ADMIN);
		}),
	},

	users: {
		removeTwoFactor: instance.users.removeTwoFactor.handler(async ({ context: { env, user }, input: { email } }) => {
			const target = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email.trim().toLowerCase()).first<{ id: string }>();
			if (target === null) throw refusal("NO_SUCH_USER", NO_SUCH_USER);
			// Better Auth's own route turns it off with the password. Here a session alone would do, so a stolen session could
			// strip its own account's second factor; and an admin who lost their authenticator has no session to call this with.
			if (target.id === user.id) throw refusal("OWN_TWO_FACTOR", OWN_TWO_FACTOR);
			// One batch, one transaction, each statement requiring the caller's role. Removed: the authenticator with its backup
			// codes (Better Auth's `twoFactor` row), the flag its sign-in hook reads, pending challenges (`2fa-<random>` holding the
			// user's id) and trusted devices (`trust-device-…`, which would skip a second factor set up again), and every session.
			// The challenges' attempt counters hold a number, not the id, and expire with them.
			const now = new Date().toISOString();
			const results = await env.DB.batch([
				env.DB.prepare(`DELETE FROM "twoFactor" WHERE "userId" = ? AND ${CALLER_IS_ADMIN}`).bind(target.id, user.id),
				env.DB.prepare(`DELETE FROM verification WHERE (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%') AND value = ? AND ${CALLER_IS_ADMIN}`).bind(
					target.id,
					user.id,
				),
				env.DB.prepare(`DELETE FROM session WHERE "userId" = ? AND ${CALLER_IS_ADMIN}`).bind(target.id, user.id),
				env.DB.prepare(`UPDATE "user" SET "twoFactorEnabled" = 0, "updatedAt" = ? WHERE id = ? AND ${CALLER_IS_ADMIN}`).bind(now, target.id, user.id),
			]);
			if ((results.at(-1)?.meta.changes ?? 0) > 0) return;
			await stillAdmin(env, user.id);
			// Deleted since it was looked up.
			throw refusal("NO_SUCH_USER", NO_SUCH_USER);
		}),
	},
});
