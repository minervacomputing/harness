// oRPC's handler for a contract's router, with our body reader and our error shape; the internal API's (internal/mount.ts)
// names its own codes and body cap.

import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { type AnyRouter, ORPCError, ValidationError } from "@orpc/server";
import { UNPARSEABLE, readJson } from "../http/body.ts";
import { SERVER_ERROR } from "../http/errors.ts";
import type { Json } from "../lib/json.ts";

/** The codes this module answers with itself: the body reader's, `VALIDATION_FAILED` and `INTERNAL_SERVER_ERROR`. */
type OwnCode = "INVALID_JSON" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "VALIDATION_FAILED" | "INTERNAL_SERVER_ERROR";

/** An API's refusal codes with their statuses, which must include the codes this module answers with. */
type Codes = Readonly<Record<string, number>> & Readonly<Record<OwnCode, number>>;

/** A refusal as the API declares it (every code is declared, so it is `defined`). */
function refusal(codes: Codes, code: string, message: string): ORPCError<string, undefined> {
	return new ORPCError(code, { defined: true, status: codes[code], message });
}

/**
 * The request's JSON body, undefined without one; a body `readJson` refuses, or that breaks off, is thrown as a refusal.
 * A browser sends a POST without a body (the link's, for a procedure whose input is all in the path) with
 * `Content-Length: 0` and no type, which arrives with an empty body: that is no body too.
 */
async function jsonBody(request: Request, codes: Codes, limit: number): Promise<Json | undefined> {
	if (request.body === null || (!request.headers.has("Content-Type") && request.headers.get("Content-Length")?.trim() === "0")) return undefined;
	let read: Awaited<ReturnType<typeof readJson>>;
	try {
		read = await readJson(request, limit);
	} catch {
		read = { ok: false, refusal: UNPARSEABLE };
	}
	if (!read.ok) throw refusal(codes, read.refusal.code, read.refusal.detail);
	return read.value;
}

/**
 * A refusal our code made (a procedure's, `invalidInput` below): declared, with one of the API's codes. oRPC would mark any
 * error whose code and status match the error map as declared, so this is checked before it does.
 */
function ours(error: unknown, codes: Codes): boolean {
	return error instanceof ORPCError && error.defined && Object.hasOwn(codes, error.code) && !(error.cause instanceof ValidationError);
}

/** Anything not ours (a crash, an output that failed its schema, a failure of oRPC's own) is logged and answers 500. */
function crashed(error: unknown, codes: Codes): ORPCError<string, unknown> {
	console.error("Unhandled error in a contract route", error);
	return refusal(codes, "INTERNAL_SERVER_ERROR", SERVER_ERROR);
}

/** zod's issues as the contract's 422: each issue's path and message, and the first one as the message. */
function invalidInput(error: ValidationError, codes: Codes): ORPCError<"VALIDATION_FAILED", unknown> {
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
	return new ORPCError("VALIDATION_FAILED", { defined: true, status: codes.VALIDATION_FAILED, message, data: { issues } });
}

/** oRPC's handler for a contract's router, with our body reader, reading at most `maxBody` bytes, and our errors, with `codes`. */
export function contractHandler<Context extends { request: Request }>(procedures: AnyRouter, { codes, maxBody }: { codes: Codes; maxBody: number }): OpenAPIHandler<Context> {
	return new OpenAPIHandler(procedures, {
		interceptors: [
			// Around matching, decoding and the call. oRPC calls `request.body()` to decode the input; ours answers
			// instead of oRPC's reader. What decoding throws that is not ours would answer in oRPC's own shape.
			async (options) => {
				let body: Promise<Json | undefined> | null = null;
				try {
					return await options.next({ ...options, request: { ...options.request, body: () => (body ??= jsonBody(options.context.request, codes, maxBody)) } });
				} catch (error) {
					throw ours(error, codes) ? error : crashed(error, codes);
				}
			},
		],
		// Around the procedure, before oRPC compares its errors with the error map.
		clientInterceptors: [
			async ({ next }) => {
				try {
					return await next();
				} catch (error) {
					if (error instanceof ORPCError && error.code === "BAD_REQUEST" && error.cause instanceof ValidationError) throw invalidInput(error.cause, codes);
					throw ours(error, codes) ? error : crashed(error, codes);
				}
			},
		],
	});
}
