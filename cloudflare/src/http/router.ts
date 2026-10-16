// The router, for every request; every response gets the security headers, and a path no route answers is 404 `NOT_FOUND`.
// /internal/* is the internal API Laravel calls (internal/mount.ts), with its own authentication and body cap; /stream/* is
// Laravel's run stream (stream/route.ts), read by browsers with a stream token and no cookie; /api/probe answers only its
// token (probe.ts). No cookie authenticates any route, so none has a CSRF check.

import { Hono, type MiddlewareHandler } from "hono";
import { internalRoutes } from "../internal/mount.ts";
import { laravelStreamRoutes } from "../stream/route.ts";
import { noRoute, serverError } from "./errors.ts";
import { withSecurityHeaders } from "./headers.ts";
import { probe } from "./probe.ts";

export interface AppEnv {
	Bindings: Env;
}

export type App = Hono<AppEnv>;

export function createApp(): App {
	const app = new Hono<AppEnv>();
	app.use("*", securityHeaders);

	app.get("/api/probe", probe);

	internalRoutes(app);
	laravelStreamRoutes(app);

	app.notFound(() => noRoute());
	app.onError((error, c) => {
		console.error("Unhandled error", c.req.method, c.req.path, error);
		return serverError();
	});
	return app;
}

const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
	await next();
	c.res = withSecurityHeaders(c.res);
};
