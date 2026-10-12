// The API router. Only /api/* reaches it (static assets answer everything else, http/assets.ts), and every
// API response gets the security headers. Paths have no trailing slash; a path that matches no route, or a
// workspace id that is not a UUID, is 404 `{"detail": "Not Found"}` (web-api spec 8).
//
// Two rules hold for every route without the route asking for them, so a route added in a later step
// cannot forget them: a declared body over 2.5 MB is 413, as the web role's ASGI wrapper answers before
// Django today (web-api 1), and an unsafe request to a route fails closed without a valid CSRF token
// (web-api 3.2), before the route's session check. The exemptions: CHECKED_LATER, routes that check CSRF
// themselves after the session; and Better Auth's one route (accounts/routes.ts AUTH_ROUTE), whose client
// sends no token and which checks the request's origin against its trusted origins itself (only the
// token check is skipped: the body cap and the security headers still apply). test/platform/worker.test.ts
// sends a tokenless request to every other unsafe route.
//
// Later steps add their routes in their own modules (src/accounts, src/api) through `routes(app)` functions
// called from `createApp`, and read bodies with body.ts's `readJson`.

import { Hono, type MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { AUTH_ROUTE, accountRoutes } from "../accounts/routes.ts";
import { apiRoutes } from "../api/routes.ts";
import { settings } from "../config.ts";
import { MAX_JSON_BODY } from "./body.ts";
import { csrfCookie } from "./cookies.ts";
import { checkCsrf, csrfCookieToken, isSafeMethod, newCsrfToken } from "./csrf.ts";
import { HttpError, csrfFailed, json, notFound, serverError, tooLarge } from "./errors.ts";
import { withSecurityHeaders } from "./headers.ts";
import { UPLOAD_ROUTE } from "./paths.ts";
import { probe } from "./probe.ts";

export interface AppEnv {
	Bindings: Env;
}

export type App = Hono<AppEnv>;

export { UPLOAD_ROUTE, UUID } from "./paths.ts";

/**
 * `METHOD path` of the routes that check CSRF themselves, after the session, and take bodies of their own
 * size: the upload, and its other methods, which are 405 "Use POST." before anything else, as today.
 */
export const CHECKED_LATER: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"].map((method) => `${method} ${UPLOAD_ROUTE}`));

export function createApp(): App {
	const app = new Hono<AppEnv>();
	app.use("/api/*", securityHeaders);
	app.use("/api/*", requestRules);

	app.get("/api/health", () => json(200, { ok: true }));
	app.get("/api/probe", probe);

	// Sets (or renews) the CSRF cookie the page echoes in X-CSRFToken; 204 with an empty body.
	app.get("/api/csrf", (c) => {
		const { debug } = settings(c.env);
		const token = csrfCookieToken(c.req.raw) ?? newCsrfToken();
		return new Response(null, { status: 204, headers: { "Set-Cookie": csrfCookie(token, { debug }), "Cache-Control": "no-store" } });
	});

	accountRoutes(app);
	apiRoutes(app);

	app.notFound((c) => notFound(`No route for ${c.req.method} ${c.req.path}`, settings(c.env).debug));
	app.onError((error, c) => {
		if (error instanceof HttpError) return error.response;
		console.error("Unhandled error", c.req.method, c.req.path, error);
		return serverError();
	});
	return app;
}

const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
	await next();
	c.res = withSecurityHeaders(c.res);
};

/** The body cap and CSRF, for every route (above). A path no route matches is left to the 404, as Django resolves URLs first. */
const requestRules: MiddlewareHandler<AppEnv> = async (c, next) => {
	// Hono marks middleware with the method ALL; any other match is an endpoint.
	const endpoint = matchedRoutes(c).find((route) => route.method !== "ALL");
	const exempt = endpoint !== undefined && CHECKED_LATER.has(`${endpoint.method} ${endpoint.path}`);
	if (!exempt && declaredTooLarge(c.req.raw)) return tooLarge();
	const ownOrigins = endpoint !== undefined && endpoint.path === AUTH_ROUTE;
	if (endpoint && !exempt && !ownOrigins && !isSafeMethod(c.req.method) && checkCsrf(c.req.raw, settings(c.env).siteUrl) !== null) {
		return csrfFailed();
	}
	await next();
};

/** A Content-Length over the JSON cap, or one that is not a number (web-api 1). */
function declaredTooLarge(request: Request): boolean {
	const declared = request.headers.get("Content-Length");
	return declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > MAX_JSON_BODY);
}
