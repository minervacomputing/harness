// Accounts: Better Auth's routes at /api/auth/* (its wire format, plan: The web API) and the development
// seed (6.4). Who is signed in, their first password, the first-run setup and the instance's administration
// are the contract's (api/accounts.ts). Better Auth's routes check their own origin rules, so the router exempts POSTs to them,
// and only them, from our CSRF check (http/router.ts).

import { settings } from "../config.ts";
import { json, noRoute } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { handleAuth } from "./auth.ts";
import { checkMailer } from "./emails.ts";
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

	// `make seed` for the local Worker, run by scripts/seed.ts; absent outside debug.
	app.post("/api/dev/seed", async (c) => {
		if (!settings(c.env).debug) return noRoute();
		return json(200, { lines: await seed(c.env) });
	});
}
