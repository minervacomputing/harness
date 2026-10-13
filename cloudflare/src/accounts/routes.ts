// Accounts: Better Auth's routes at /api/auth/* (its wire format, plan: The web API), `GET /api/me`, the
// first password (`POST /api/me/password`), the instance's setup and administration (instance-routes.ts)
// and the development seed (6.4). Better Auth's routes check their own origin rules, so the router exempts
// POSTs to them, and only them, from our CSRF check (http/router.ts); ours, the password among them, get it.

import { isAPIError } from "better-auth/api";
import { z } from "zod";
import { readBody } from "../api/input.ts";
import { settings } from "../config.ts";
import { json, noRoute, refused, unauthorized, validationError } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { currentSession, getAuth, handleAuth, sessionRoute, signedIn, withSessionCookies } from "./auth.ts";
import { checkMailer } from "./emails.ts";
import { instanceRoutes } from "./instance-routes.ts";
import { ensureProvisioned, listWorkspaces } from "./provision.ts";
import { seed } from "./seed.ts";

/** The one route Better Auth answers; the router knows it by this path. */
export const AUTH_ROUTE = "/api/auth/*";

export const PASSWORD_ALREADY_SET = "This account already has a password.";

const PasswordIn = z.object({ password: z.string() });

/** Whether the user has a password: Better Auth's credential account, with a hash. */
async function hasPassword(db: D1Database, userId: string): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS found FROM account WHERE "userId" = ? AND "providerId" = 'credential' AND password IS NOT NULL`).bind(userId).first();
	return row !== null;
}

export function accountRoutes(app: App): void {
	// No way to deliver codes, no accounts: a deploy without the Email Sending binding (and debug off) fails closed.
	app.use("/api/*", async (c, next) => {
		checkMailer(c.env);
		await next();
	});

	app.on(["GET", "POST"], AUTH_ROUTE, (c) => handleAuth(c.env, c.req.raw));

	app.get("/api/me", async (c) => {
		const session = await currentSession(c.env, c.req.raw);
		const user = session.user;
		if (!user) return withSessionCookies(unauthorized(), session);
		// A user whose provisioning a crash left pending gets it finished here (provision.ts).
		await ensureProvisioned(c.env, user.id);
		const body = {
			user: { id: user.id, email: user.email, name: user.name, role: user.role === "admin" ? "admin" : "user" },
			workspaces: await listWorkspaces(c.env, user.id),
		};
		return withSessionCookies(json(200, body), session);
	});

	// The first password of a user an email code signed up: the sign-up form's password, sent once the code has
	// signed the user in. A password already set is changed with the current one or reset by email code, so this
	// refuses it, before Better Auth spends a hash on it (its limiter does not count `auth.api` calls).
	app.post(
		"/api/me/password",
		sessionRoute(async (env, request, session) => {
			const user = signedIn(session);
			const { password } = await readBody(request, PasswordIn);
			if (await hasPassword(env.DB, user.id)) return refused("PASSWORD_ALREADY_SET", PASSWORD_ALREADY_SET);
			try {
				await getAuth(env).api.setPassword({ body: { newPassword: password }, headers: request.headers });
			} catch (error) {
				// Set by a request that raced this one past the check above: Better Auth's own check, or the unique
				// index on the credential account (migration 0007) refusing the second insert.
				if (await hasPassword(env.DB, user.id)) return refused("PASSWORD_ALREADY_SET", PASSWORD_ALREADY_SET);
				if (!isAPIError(error)) throw error;
				const { code, message } = (error.body ?? {}) as { code?: string; message?: string };
				if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
					return validationError([{ type: code === "PASSWORD_TOO_SHORT" ? "too_small" : "too_big", loc: ["body", "password"], msg: message ?? code }]);
				}
				if (error.statusCode === 401) return unauthorized();
				throw error;
			}
			return new Response(null, { status: 204 });
		}),
	);

	instanceRoutes(app);

	// `make seed` for the local Worker, run by scripts/seed.ts; absent outside debug.
	app.post("/api/dev/seed", async (c) => {
		if (!settings(c.env).debug) return noRoute();
		return json(200, { lines: await seed(c.env) });
	});
}
