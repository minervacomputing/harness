// The routes of the instance's administration (instance.ts): the first-run setup and what instance admins
// change. Every admin route reads the caller's role from D1, and every change requires it again in its
// own statement, so a role removed a moment ago counts, even for a request already past the first check.

import type { Context } from "hono";
import { z } from "zod";
import { readBody } from "../api/input.ts";
import { settings } from "../config.ts";
import { HttpError, detail, json, unauthorized } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App, AppEnv } from "../http/router.ts";
import { str } from "../lib/schema.ts";
import { type CurrentSession, currentSession, withSessionCookies } from "./auth.ts";
import { ADMINS_ONLY, ALREADY_SET_UP, INVALID_KEY, LAST_ADMIN, NO_SUCH_USER, claimSetup, isSetUp, setupKeyValid, signupOverride } from "./instance.ts";

const SetupIn = z.object({ key: str({ min: 1, max: 500 }) });
const SettingsIn = z.object({ signup_open: z.boolean().nullable() });
const AdminIn = z.object({ email: str({ min: 1, max: 254 }) });

interface AdminOut {
	id: string;
	email: string;
	name: string;
}

/** The signed-in user, or the anonymous 401. */
function signedIn(session: CurrentSession): NonNullable<CurrentSession["user"]> {
	if (!session.user) throw new HttpError(unauthorized());
	return session.user;
}

/** The SQL condition that the caller (the next parameter) is an admin: in each change's own statement, so a role removed meanwhile counts. */
const CALLER_IS_ADMIN = `EXISTS (SELECT 1 FROM "user" WHERE id = ? AND role = 'admin')`;

/** The signed-in instance admin, read from D1 on every request (a role removed a moment ago counts). */
async function admin(env: Env, session: CurrentSession): Promise<string> {
	const user = signedIn(session);
	const row = await env.DB.prepare(`SELECT role FROM "user" WHERE id = ?`).bind(user.id).first<{ role: string | null }>();
	if (row?.role !== "admin") throw new HttpError(detail(403, ADMINS_ONLY));
	return user.id;
}

async function settingsOut(env: Env): Promise<Response> {
	const override = await signupOverride(env.DB);
	const configured = settings(env).signupOpen;
	return json(200, { signup_open: override ?? configured, signup_open_override: override, signup_open_configured: configured });
}

async function adminsOut(env: Env): Promise<Response> {
	const rows = await env.DB.prepare(`SELECT id, email, name FROM "user" WHERE role = 'admin' ORDER BY "createdAt", id`).all<AdminOut>();
	return json(200, rows.results);
}

/** A route that reads the session and answers with its cookies, whatever it throws. */
function sessionRoute(handler: (env: Env, request: Request, session: CurrentSession, c: Context<AppEnv>) => Promise<Response>): (c: Context<AppEnv>) => Promise<Response> {
	return async (c) => {
		const session = await currentSession(c.env, c.req.raw);
		let response: Response;
		try {
			response = await handler(c.env, c.req.raw, session, c);
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;
			response = error.response;
		}
		return withSessionCookies(response, session);
	};
}

export function instanceRoutes(app: App): void {
	// Whether the first-run setup is still open, for a setup page; nothing else about the instance.
	app.get("/api/setup", async (c) => json(200, { needed: !(await isSetUp(c.env.DB)) }));

	app.post(
		"/api/setup",
		sessionRoute(async (env, request, session) => {
			const user = signedIn(session);
			const { key } = await readBody(request, SetupIn);
			if (!(await setupKeyValid(env, key))) return detail(403, INVALID_KEY);
			if (!(await claimSetup(env.DB, user.id))) return detail(409, ALREADY_SET_UP);
			return new Response(null, { status: 204 });
		}),
	);

	app.get(
		"/api/instance/settings",
		sessionRoute(async (env, _request, session) => {
			await admin(env, session);
			return settingsOut(env);
		}),
	);

	app.patch(
		"/api/instance/settings",
		sessionRoute(async (env, request, session) => {
			const userId = await admin(env, session);
			const { signup_open } = await readBody(request, SettingsIn);
			const value = signup_open === null ? null : signup_open ? 1 : 0;
			const saved = await env.DB.prepare(
				`INSERT INTO instance_settings (id, signup_open, updated_at, updated_by) SELECT 1, ?, ?, ? WHERE ${CALLER_IS_ADMIN} ` +
					"ON CONFLICT (id) DO UPDATE SET signup_open = excluded.signup_open, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
			)
				.bind(value, Date.now(), userId, userId)
				.run();
			if (saved.meta.changes === 0) return detail(403, ADMINS_ONLY);
			return settingsOut(env);
		}),
	);

	app.get(
		"/api/instance/admins",
		sessionRoute(async (env, _request, session) => {
			await admin(env, session);
			return adminsOut(env);
		}),
	);

	app.post(
		"/api/instance/admins",
		sessionRoute(async (env, request, session) => {
			const caller = await admin(env, session);
			const { email } = await readBody(request, AdminIn);
			const promoted = await env.DB.prepare(`UPDATE "user" SET role = 'admin', "updatedAt" = ? WHERE email = ? AND ${CALLER_IS_ADMIN} RETURNING id`)
				.bind(new Date().toISOString(), email.trim().toLowerCase(), caller)
				.first<{ id: string }>();
			if (promoted === null) {
				await admin(env, session);
				return detail(404, NO_SUCH_USER);
			}
			return adminsOut(env);
		}),
	);

	app.delete(
		`/api/instance/admins/:user${UUID}`,
		sessionRoute(async (env, _request, session, c) => {
			const caller = await admin(env, session);
			const userId = c.req.param("user") ?? "";
			// One statement: of concurrent removals of the last two admins, the second finds one left, and a
			// caller removed meanwhile removes nobody.
			const demoted = await env.DB.prepare(
				`UPDATE "user" SET role = 'user', "updatedAt" = ? WHERE id = ? AND role = 'admin' AND (SELECT count(*) FROM "user" WHERE role = 'admin') > 1 AND ${CALLER_IS_ADMIN}`,
			)
				.bind(new Date().toISOString(), userId, caller)
				.run();
			if (demoted.meta.changes > 0) return new Response(null, { status: 204 });
			await admin(env, session);
			const target = await env.DB.prepare(`SELECT role FROM "user" WHERE id = ?`).bind(userId).first<{ role: string | null }>();
			if (target?.role !== "admin") return detail(404, "Not Found");
			return detail(422, LAST_ADMIN);
		}),
	);
}
