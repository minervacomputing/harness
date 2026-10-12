// `make seed` for the Worker (web-api spec 6.4): ada@example.com and grace@example.com with the password
// `password`, verified, without two-factor, each with a personal workspace. Re-running resets them and
// signs out their sessions. Known credentials, so it refuses to run unless MINERVA_DEBUG is on, creating
// nothing; a deployed build never has debug on (cloudflare.config.ts).
//
// Accounts are made through Better Auth's API (the admin plugin's createUser, called from the server),
// so provisioning runs from the same hook as for any other user, and reset through its adapter.

import { settings } from "../config.ts";
import { getAuth } from "./auth.ts";
import { ensureProvisioned } from "./provision.ts";

export const SEED_PASSWORD = "password";
export const SEED_ACCOUNTS: readonly (readonly [email: string, name: string])[] = [
	["ada@example.com", "Ada Lovelace"],
	["grace@example.com", "Grace Hopper"],
];

export class SeedRefused extends Error {
	constructor() {
		super("Seed accounts have a known password; this only runs with MINERVA_DEBUG=true.");
		this.name = "SeedRefused";
	}
}

/** Creates or resets the seed accounts; returns the lines `make seed` prints. */
export async function seed(env: Env): Promise<string[]> {
	if (!settings(env).debug) throw new SeedRefused();
	const auth = getAuth(env);
	const context = await auth.$context;
	const lines: string[] = [];
	for (const [email, name] of SEED_ACCOUNTS) {
		const existing = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
		if (!existing) {
			await auth.api.createUser({ body: { email, name, password: SEED_PASSWORD, role: "user", data: { emailVerified: true } } });
			lines.push(`created  ${email}`);
			continue;
		}
		const userId = existing.user.id;
		const hash = await context.password.hash(SEED_PASSWORD);
		if (existing.accounts.some((account) => account.providerId === "credential")) {
			await context.internalAdapter.updatePassword(userId, hash);
		} else {
			await context.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
		}
		await context.internalAdapter.updateUser(userId, { emailVerified: true, twoFactorEnabled: false, banned: false });
		await env.DB.prepare(`DELETE FROM "twoFactor" WHERE "userId" = ?`).bind(userId).run();
		await context.internalAdapter.deleteUserSessions(userId);
		await ensureProvisioned(env, userId);
		lines.push(`reset  ${email}`);
	}
	lines.push(`Password for all seed accounts: ${SEED_PASSWORD}`);
	return lines;
}
