// The contract's routes (contract/), served by one oRPC OpenAPIHandler mounted under /api/ after every Hono
// route (http/router.ts), so it answers only what none of them did. A request reaches a procedure in this
// order, each step refusing before the next runs:
//
// 1. the router: CSRF for unsafe methods and the declared body cap (http/router.ts);
// 2. this mount, for a path under /api/workspaces/{ws}: the session, then membership of {ws} (401). The body
//    is not read yet, so a non-member's body is never read, however slow;
// 3. oRPC matches the method and path (404), then reads the body with http/body.ts's `readJson` (415, 413,
//    400). The interceptor below replaces oRPC's own reader, which takes forms and any content type and
//    parses with JSON.parse (lib/json.ts has why that is wrong);
// 4. middleware: the input's workspace is the path's (procedures.ts `inWorkspace`);
// 5. zod validates the input (422 `VALIDATION_FAILED` with `data.issues`), then the handler runs.
//
// Every answer is in the contract's error shape (`{defined, code, status, message, data?}`), and the cookies
// Better Auth set while reading the session go on every answer the mount gives: success, refusal and 401.

import { REFUSALS } from "@minerva/contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { type AnyRouter, ORPCError, ValidationError } from "@orpc/server";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { UNPARSEABLE, readJson } from "../http/body.ts";
import { HttpError, SERVER_ERROR, errorAnswer, noRoute, serverError } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App } from "../http/router.ts";
import type { Json } from "../lib/json.ts";
import { agentProcedures } from "./agents.ts";
import { type Member, member } from "./members.ts";
import { type ApiContext, api, refusal } from "./procedures.ts";

const router = api.router({ agents: agentProcedures });

/** The request's JSON body, undefined without one; a body `readJson` refuses, or that breaks off, is thrown as a refusal. */
async function jsonBody(request: Request): Promise<Json | undefined> {
	if (request.body === null) return undefined;
	let read: Awaited<ReturnType<typeof readJson>>;
	try {
		read = await readJson(request);
	} catch {
		read = { ok: false, refusal: UNPARSEABLE };
	}
	if (!read.ok) throw refusal(read.refusal.code, read.refusal.detail);
	return read.value;
}

/**
 * A refusal our code made (procedures.ts `refusal`, `invalidInput` below): declared, with one of our codes. oRPC
 * would mark any error whose code and status match the error map as declared, so this is checked before it does.
 */
function ours(error: unknown): boolean {
	return error instanceof ORPCError && error.defined && Object.hasOwn(REFUSALS, error.code) && !(error.cause instanceof ValidationError);
}

/** Anything not ours (a crash, an output that failed its schema, a failure of oRPC's own) is logged and answers 500. */
function crashed(error: unknown): ORPCError<string, unknown> {
	console.error("Unhandled error in a contract route", error);
	return refusal("INTERNAL_SERVER_ERROR", SERVER_ERROR);
}

/** zod's issues as the contract's 422: each issue's path and message, and the first one as the message. */
function invalidInput(error: ValidationError): ORPCError<"VALIDATION_FAILED", unknown> {
	const issues = error.issues.map((issue) => ({
		path: (issue.path ?? []).map((part) => {
			const key = typeof part === "object" ? part.key : part;
			return typeof key === "number" ? key : String(key);
		}),
		message: issue.message,
		// zod's issues carry their kind; Standard Schema's need not.
		code: String((issue as { code?: unknown }).code ?? "invalid"),
	}));
	const first = issues[0];
	const field = first?.path.at(-1);
	const message = first === undefined ? "Invalid input." : field === undefined ? first.message : `${field}: ${first.message}`;
	return new ORPCError("VALIDATION_FAILED", { defined: true, status: REFUSALS.VALIDATION_FAILED, message, data: { issues } });
}

/** oRPC's handler for the contract's router, with our body reader and our errors. */
export function contractHandler(procedures: AnyRouter): OpenAPIHandler<ApiContext> {
	return new OpenAPIHandler(procedures, {
		interceptors: [
			// Around matching, decoding and the call. oRPC calls `request.body()` to decode the input; ours answers
			// instead of oRPC's reader. What decoding throws that is not ours would answer in oRPC's own shape.
			async (options) => {
				let body: Promise<Json | undefined> | null = null;
				try {
					return await options.next({ ...options, request: { ...options.request, body: () => (body ??= jsonBody(options.context.request)) } });
				} catch (error) {
					throw ours(error) ? error : crashed(error);
				}
			},
		],
		// Around the procedure, before oRPC compares its errors with the error map.
		clientInterceptors: [
			async ({ next }) => {
				try {
					return await next();
				} catch (error) {
					if (error instanceof ORPCError && error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) throw invalidInput(error.cause);
					throw ours(error) ? error : crashed(error);
				}
			},
		],
	});
}

/** The contract's routes, as the mount serves them. */
export const handler = contractHandler(router);

/** A path in a workspace, with the workspace's segment as sent. */
const IN_WORKSPACE = /^\/api\/workspaces\/([^/]+)(?:\/|$)/;
/** A workspace id as the API writes it (http/paths.ts `UUID`, without Hono's braces). */
const WORKSPACE_ID = new RegExp(`^${UUID.slice(1, -1)}$`);

export function contractRoutes(app: App): void {
	app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/*", async (c, next) => {
		const path = new URL(c.req.url).pathname;
		const workspace = IN_WORKSPACE.exec(path)?.[1];
		// No trailing slash, and a workspace only as a lowercase UUID: anything else is no route (http/router.ts).
		if (path.endsWith("/") || (workspace !== undefined && !WORKSPACE_ID.test(workspace))) return next();
		// Hono answers HEAD with the GET route and drops the body; oRPC matches the method it is given.
		const request = c.req.method === "HEAD" ? new Request(c.req.raw, { method: "GET" }) : c.req.raw;
		if (workspace === undefined) {
			const { matched, response } = await handler.handle(request, { prefix: "/api", context: { request, member: null } });
			return matched ? noStore(response) : next();
		}
		const session = await currentSession(c.env, c.req.raw);
		const answer = async (): Promise<Response> => {
			let caller: Member;
			try {
				caller = await member(c.env, session, workspace);
			} catch (error) {
				if (error instanceof HttpError) return errorAnswer("UNAUTHORIZED", "Unauthorized");
				throw error;
			}
			const { matched, response } = await handler.handle(request, { prefix: "/api", context: { request, member: caller } });
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

function noStore(response: Response): Response {
	if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
	return response;
}
