// Accounts: Better Auth's routes at /api/auth/* (its wire format, plan: The web API), `GET /api/me`
//, the instance's setup and administration (instance-routes.ts) and the development seed
// (6.4). Better Auth's routes check their own origin rules, so the router exempts POSTs to them, and only
// them, from our CSRF check (http/router.ts).

import { settings } from "../config.ts";
import { json, notFound, unauthorized } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { currentSession, handleAuth, withSessionCookies } from "./auth.ts";
import { checkMailer } from "./emails.ts";
import { instanceRoutes } from "./instance-routes.ts";
import { ensureProvisioned, listWorkspaces } from "./provision.ts";
import { seed } from "./seed.ts";

/** The one route Better Auth answers; the router knows it by this path. */
export const AUTH_ROUTE = "/api/auth/*";

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
			user: { id: user.id, email: user.email, name: user.name, is_staff: user.role === "admin" },
			workspaces: await listWorkspaces(c.env, user.id),
		};
		return withSessionCookies(json(200, body), session);
	});

	instanceRoutes(app);

	// `make seed` for the local Worker, run by scripts/seed.ts; absent outside debug.
	app.post("/api/dev/seed", async (c) => {
		if (!settings(c.env).debug) return notFound();
		return json(200, { lines: await seed(c.env) });
	});
}
