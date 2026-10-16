// The internal API's routes (docs/plans/contract.md): the commands Laravel sends, under /internal/v1/, served by oRPC's
// OpenAPIHandler with our body reader and error shape (handler.ts `contractHandler`), its own codes and body cap. A
// request reaches a command in this order, each step refusing before the next runs:
//
// 1. without the internal settings (config.ts `internal`), every /internal/ path is 404, as if nothing were here;
// 2. the Access assertion (access.ts): 401 `UNAUTHORIZED` without a valid one, and nothing says why; 503 when Access's keys
//    cannot be read. No body is read before this;
// 3. the declared body cap, 16 MB (413);
// 4. oRPC matches the method and path (404), reads the body (415, 413, 400), and the command's middleware checks its
//    environment (409 `WRONG_ENVIRONMENT`); then zod validates the input (422) and the handler runs.
//
// No cookie authenticates these routes, so they have no CSRF check. A body can hold a credential (the settings calls):
// nothing here logs one.

import { INTERNAL_REFUSALS, MAX_INTERNAL_BODY } from "@minerva/contract/internal";
import { settings } from "../config.ts";
import { TOO_LARGE, declaredOver } from "../http/body.ts";
import { errorAnswer, json, noRoute, serverError, unauthorized } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { AccessUnavailable, accessClient } from "./access.ts";
import { contractHandler } from "./handler.ts";
import { type InternalContext, internalRouter } from "./procedures.ts";

const handler = contractHandler<InternalContext>(internalRouter, { codes: INTERNAL_REFUSALS, maxBody: MAX_INTERNAL_BODY });

/** The answer when Access's keys cannot be read: a failure Laravel retries. */
function accessUnavailable(): Response {
	return json(INTERNAL_REFUSALS.UNAVAILABLE, {
		defined: true,
		code: "UNAVAILABLE",
		status: INTERNAL_REFUSALS.UNAVAILABLE,
		message: "The engine could not check the request's credentials. Try again.",
	});
}

async function answer(request: Request, env: Env): Promise<Response> {
	const internal = settings(env).internal;
	if (internal === null) return noRoute();
	let client: string | null;
	try {
		client = await accessClient(request, internal.access);
	} catch (error) {
		if (!(error instanceof AccessUnavailable)) throw error;
		console.error("Cloudflare Access's keys could not be read", error.cause);
		return accessUnavailable();
	}
	if (client === null) return unauthorized();
	return serveInternal(request, env, client);
}

/**
 * Steps 1, 3 and 4 for a request whose `client` is already known: Access's check (step 2) is the caller's. The test build's
 * driver (src/faults/routes.ts) calls it behind its own token.
 */
export async function serveInternal(request: Request, env: Env, client: string): Promise<Response> {
	const internal = settings(env).internal;
	if (internal === null) return noRoute();
	if (declaredOver(request, MAX_INTERNAL_BODY)) return errorAnswer(TOO_LARGE.code, TOO_LARGE.detail);
	const { matched, response } = await handler.handle(request, { context: { request, env, environment: internal.environment, client } });
	return matched ? response : noRoute();
}

export function internalRoutes(app: App): void {
	// Every version's prefix, so a path under one this engine does not serve is 404 here too, in the same shape.
	app.all("/internal/*", async (c) => {
		try {
			return await answer(c.req.raw, c.env);
		} catch (error) {
			console.error("Unhandled error in an internal route", error);
			return serverError();
		}
	});
}
