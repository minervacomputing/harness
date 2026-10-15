// The contract's routes (contract/), served by one oRPC OpenAPIHandler mounted under /api/ after every Hono
// route (http/router.ts), so it answers only what none of them did. A request reaches a procedure in this
// order, each step refusing before the next runs:
//
// 1. the router: CSRF for unsafe methods and the declared body cap (http/router.ts);
// 2. this mount reads the session and admits the caller before the body is read, so the body of a caller it
//    refuses is never read, however slow (`admit`):
//    - under /api/workspaces/{ws}: a session and membership of {ws} (401), before the path is matched, so a
//      non-member learns nothing of the workspace's routes;
//    - elsewhere it finds the procedure first (no route goes on to the router's 404, before the session is
//      read), then the procedure's place in the contract says who may call it (`ACCESS`): anyone (the
//      setup's status), an instance admin (everything under `instance`, read from D1: 403
//      `INSTANCE_ADMINS_ONLY`), and by default any signed-in user (401);
// 3. oRPC matches the method and path (404), then reads the body with http/body.ts's `readJson` (415, 413,
//    400). internal/handler.ts's interceptor replaces oRPC's own reader, which takes forms and any content type and
//    parses with JSON.parse (lib/json.ts has why that is wrong);
// 4. middleware checks that the procedure is called by whom the mount admitted (procedures.ts `signedIn`,
//    `instanceAdmin`, and `inWorkspace`, for which the input's workspace is also the path's);
// 5. zod validates the input (422 `VALIDATION_FAILED` with `data.issues`), then the handler runs.
//
// Every answer is in the contract's error shape (`{defined, code, status, message, data?}`), and the cookies
// Better Auth set while reading the session go on every answer the mount gives: success, refusal and 401.

import { REFUSALS } from "@minerva/contract";
import { StandardOpenAPIMatcher } from "@orpc/openapi/standard";
import { type CurrentSession, currentSession, withSessionCookies } from "../accounts/auth.ts";
import { ADMINS_ONLY, isInstanceAdmin } from "../accounts/instance.ts";
import { MAX_JSON_BODY } from "../http/body.ts";
import { HttpError, errorAnswer, noRoute, serverError, unauthorized } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App } from "../http/router.ts";
import { contractHandler } from "../internal/handler.ts";
import { instanceProcedures, meProcedure, passwordProcedures, setupProcedures } from "./accounts.ts";
import { agentProcedures } from "./agents.ts";
import { connectionProcedures, connectorProcedures } from "./connections.ts";
import { conversationProcedures, runProcedures, uploadProcedures } from "./conversations.ts";
import { member } from "./members.ts";
import { type ApiContext, api } from "./procedures.ts";

const router = api.router({
	me: meProcedure,
	password: passwordProcedures,
	setup: setupProcedures,
	instance: instanceProcedures,
	agents: agentProcedures,
	connectors: connectorProcedures,
	connections: connectionProcedures,
	conversations: conversationProcedures,
	runs: runProcedures,
	uploads: uploadProcedures,
});

/** The contract's routes, as the mount serves them. */
export const handler = contractHandler<ApiContext>(router, { codes: REFUSALS, maxBody: MAX_JSON_BODY });

/** A path in a workspace, with the workspace's segment as sent. */
const IN_WORKSPACE = /^\/api\/workspaces\/([^/]+)(?:\/|$)/;
/** A workspace id as the API writes it (http/paths.ts `UUID`, without Hono's braces). */
const WORKSPACE_ID = new RegExp(`^${UUID.slice(1, -1)}$`);

/** Who may call a procedure outside a workspace, by its place in the contract (a procedure's, else its router's); anyone else signed in by default. */
const ACCESS: Readonly<Record<string, "anyone" | "admin">> = { "setup.status": "anyone", instance: "admin" };

function access(procedure: readonly string[]): "anyone" | "admin" | "user" {
	return ACCESS[procedure.join(".")] ?? ACCESS[procedure[0] ?? ""] ?? "user";
}

/** The handler's own matching, to find a procedure outside a workspace before the mount admits its caller. */
const matcher = new StandardOpenAPIMatcher();
matcher.init(router);

/**
 * The context of a caller the mount admits (2. above), or the refusal: `workspace` is the path's, else `procedure` is the procedure's
 * place in the contract. Reads no body.
 */
async function admit(env: Env, request: Request, workspace: string | undefined, procedure: readonly string[], session: CurrentSession): Promise<ApiContext | Response> {
	const context: ApiContext = { request, env, user: session.user, member: null, admin: false };
	const user = session.sessionId === null ? null : session.user;
	if (workspace !== undefined) {
		if (user === null) return unauthorized();
		try {
			return { ...context, member: await member(env, session, workspace) };
		} catch (error) {
			if (error instanceof HttpError) return unauthorized();
			throw error;
		}
	}
	const who = access(procedure);
	if (who === "anyone") return context;
	if (user === null) return unauthorized();
	if (who === "user") return context;
	if (!(await isInstanceAdmin(env.DB, user.id))) return errorAnswer("INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
	return { ...context, admin: true };
}

export function contractRoutes(app: App): void {
	app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/*", async (c, next) => {
		const path = new URL(c.req.url).pathname;
		const workspace = IN_WORKSPACE.exec(path)?.[1];
		// No trailing slash, and a workspace only as a lowercase UUID: anything else is no route (http/router.ts).
		if (path.endsWith("/") || (workspace !== undefined && !WORKSPACE_ID.test(workspace))) return next();
		// Hono answers HEAD with the GET route and drops the body; oRPC matches the method it is given.
		const request = c.req.method === "HEAD" ? new Request(c.req.raw, { method: "GET" }) : c.req.raw;
		// Outside a workspace the procedure is found first, as the handler matches (the path after the prefix, without its outer slashes).
		const procedure = workspace === undefined ? await matcher.match(request.method, `/${path.slice("/api".length).replace(/^\/|\/$/g, "")}`) : undefined;
		if (workspace === undefined && procedure === undefined) return next();
		const session = await currentSession(c.env, c.req.raw);
		const answer = async (): Promise<Response> => {
			const context = await admit(c.env, request, workspace, procedure?.path ?? [], session);
			if (context instanceof Response) return context;
			const { matched, response } = await handler.handle(request, { prefix: "/api", context });
			return matched ? noStore(response) : noRoute();
		};
		// The cookies Better Auth set go on every answer, a crash's 500 too.
		let response: Response;
		try {
			response = await answer();
		} catch (error) {
			console.error("Unhandled error in a contract route", error);
			response = serverError();
		}
		return withSessionCookies(response, session);
	});
}

/** Every answer is kept out of caches. oRPC labels JSON it wrote itself; a streamed read's body (api/conversations.ts) is JSON too. */
function noStore(response: Response): Response {
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	if (response.body !== null && !response.headers.has("Content-Type")) response.headers.set("Content-Type", "application/json; charset=utf-8");
	return response;
}
