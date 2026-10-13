// The API router. Only /api/* reaches it (static assets answer everything else, http/assets.ts), and every
// API response gets the security headers. Paths have no trailing slash; a path that matches no route, or a
// workspace id that is not a UUID, is 404 `{"detail": "Not Found"}`.
//
// Two rules hold for every request without a route asking for them, so a route added later cannot forget
// them, in this order:
//
// 1. CSRF (http/csrf.ts): an unsafe request that does not come from the site's origin is 403, before any
//    route runs or reads its body, whether or not a route matches. A POST under /api/auth/ is exempt: Better
//    Auth's route (accounts/routes.ts AUTH_ROUTE), registered before every other, answers all of them and
//    checks the origin itself.
// 2. A declared body over 2.5 MB is 413, except on OWN_SIZE_LIMIT, the upload, whose limit is its own.
//
// test/platform/worker.test.ts sends a cross-site request to every unsafe route. Later steps add their
// routes in their own modules (src/accounts, src/api) through `routes(app)` functions called from
// `createApp`, and read bodies with body.ts's `readJson`.

import { Hono, type MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { AUTH_ROUTE, accountRoutes } from "../accounts/routes.ts";
import { apiRoutes } from "../api/routes.ts";
import { settings } from "../config.ts";
import { MAX_JSON_BODY, TOO_LARGE, declaredOver } from "./body.ts";
import { fromSite } from "./csrf.ts";
import { HttpError, crossSite, detail, json, notFound, serverError } from "./errors.ts";
import { withSecurityHeaders } from "./headers.ts";
import { UPLOAD_ROUTE } from "./paths.ts";
import { probe } from "./probe.ts";

export interface AppEnv {
	Bindings: Env;
}

export type App = Hono<AppEnv>;

export { UPLOAD_ROUTE, UUID } from "./paths.ts";

/** `METHOD path` of the routes that take bodies of their own size: the upload, and its other methods, which are 405 "Use POST.". */
export const OWN_SIZE_LIMIT: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"].map((method) => `${method} ${UPLOAD_ROUTE}`));

export function createApp(): App {
	const app = new Hono<AppEnv>();
	app.use("/api/*", securityHeaders);
	app.use("/api/*", sameOrigin);
	app.use("/api/*", bodyCap);

	app.get("/api/health", () => json(200, { ok: true }));
	app.get("/api/probe", probe);

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

/** `/api/auth/`. */
const AUTH_PREFIX = AUTH_ROUTE.slice(0, -1);

/** CSRF (above): a middleware, so it runs for every request under /api/, matched by a route or not. */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
	const betterAuth = c.req.method === "POST" && new URL(c.req.url).pathname.startsWith(AUTH_PREFIX);
	if (!betterAuth && !fromSite(c.req.raw, settings(c.env).siteUrl)) return crossSite();
	await next();
};

/** The declared body cap (above). */
const bodyCap: MiddlewareHandler<AppEnv> = async (c, next) => {
	// Hono marks middleware with the method ALL; any other match is an endpoint.
	const endpoint = matchedRoutes(c).find((route) => route.method !== "ALL");
	const own = endpoint !== undefined && OWN_SIZE_LIMIT.has(`${endpoint.method} ${endpoint.path}`);
	if (!own && declaredOver(c.req.raw, MAX_JSON_BODY)) return detail(TOO_LARGE.status, TOO_LARGE.detail);
	await next();
};
