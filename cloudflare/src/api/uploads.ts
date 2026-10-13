// The upload: `POST /api/workspaces/{ws}/uploads?name=<file name>` with the
// raw file as its body, with its checks in this order: CSRF (the router's, 403), the request itself (405
// for another method, the Content-Length, the upload limit, the name) before anything is read, then the
// session (401), membership (401), and the Workspace's reservation (3 arriving and 30 waiting per user, the
// workspace's quota) before the body streams into the workspace's bucket while it is hashed
// (files/uploads.ts `receiveUpload`). A refused or failed upload leaves no row and no object.

import type { Context } from "hono";
import { currentSession, withSessionCookies } from "../accounts/auth.ts";
import { filesBucket } from "../addressing.ts";
import { settings } from "../config.ts";
import { checkUploadRequest, receiveUpload } from "../files/uploads.ts";
import { USE_POST } from "../files/limits.ts";
import { HttpError, detail, json, unauthorized } from "../http/errors.ts";
import { UPLOAD_ROUTE } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import { type Member, member, param, refused } from "./members.ts";

async function upload(c: Context<AppEnv>): Promise<Response> {
	const config = settings(c.env);
	const checked = checkUploadRequest(c.req.raw, config.files.uploadBytes);
	if (!checked.ok) return refused(checked.refusal);
	const session = await currentSession(c.env, c.req.raw);
	if (!session.user || !session.sessionId) return withSessionCookies(unauthorized(), session);
	let m: Member;
	try {
		m = await member(c.env, session, param(c, "workspace"));
	} catch (error) {
		if (error instanceof HttpError) return withSessionCookies(error.response, session);
		throw error;
	}
	// A write to R2 that ends after the upload's deadline has its object deleted after the response too.
	const waitUntil = (work: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(work);
		} catch {
			// Without an execution context (a request made outside a Worker) the delete is best effort.
		}
	};
	const outcome = await receiveUpload(m.object, filesBucket(c.env, m.workspace), m.caller, { ...checked.value, body: c.req.raw.body }, { waitUntil });
	return withSessionCookies(outcome.ok ? json(201, outcome.value) : refused(outcome.refusal), session);
}

export function uploadRoutes(app: App): void {
	app.post(UPLOAD_ROUTE, upload);
	// Every other method is "Use POST.", after the router's CSRF check.
	app.on(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"], UPLOAD_ROUTE, () => detail(405, USE_POST));
}
