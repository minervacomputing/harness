// The procedures outside a workspace (contract/src/accounts.ts): who is signed in, the first-run setup and the
// instance's administration (accounts/instance.ts). The mount (api/orpc.ts) refuses a visitor everywhere but
// the setup's status, and a caller who is not an instance admin under /api/instance, before the body is read.
// Every change an admin makes requires the role again in its own statement, so a role removed a moment ago
// counts, even for a request already past the mount's check.

import type { InstanceAdmin, InstanceSettings } from "@minerva/contract";
import { ADMINS_ONLY, ALREADY_SET_UP, INVALID_KEY, LAST_ADMIN, NO_SUCH_USER, claimSetup, isInstanceAdmin, isSetUp, setupKeyValid, signupOverride } from "../accounts/instance.ts";
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
});
