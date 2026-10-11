// GET /api/probe: what the account tests (test/account) cannot see from outside, measured inside the
// deployed Worker. It answers only a request with `X-Minerva-Probe: <probeToken(MINERVA_SECRET_KEY)>`;
// any other request gets the same 404 as a path with no route. It touches only fixed objects named by the
// nil UUID, which no workspace or conversation can have (ids are UUIDv7), and writes nothing else.
//
// - `objects`: one RPC to each Durable Object class through addressing.ts, without and with the EU
//   jurisdiction, each answering the name and jurisdiction it was addressed with;
// - `d1Migrations`: the migrations D1 has applied, to compare with migrations/;
// - `json`: the runtime's JSON.parse against parseJson after a lone backslash key (lib/json.ts).

import type { Context } from "hono";
import { conversationObject, sandboxObject, scriptsObject, workspaceObject } from "../addressing.ts";
import { settings } from "../config.ts";
import type { WorkspaceRef } from "../contracts/common.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import { escapedKeyCheck } from "../lib/json.ts";
import { json, notFound } from "./errors.ts";
import { PROBE_HEADER, probeToken } from "./probe-token.ts";
import type { AppEnv } from "./router.ts";

const NIL = "00000000-0000-0000-0000-000000000000";

export async function probe(c: Context<AppEnv>): Promise<Response> {
	const given = c.req.header(PROBE_HEADER) ?? "";
	if (!timingSafeEqual(given, await probeToken(c.env.MINERVA_SECRET_KEY))) {
		return notFound(`No route for ${c.req.method} ${c.req.path}`, settings(c.env).debug);
	}
	// Hono types its ExecutionContext without `exports`; the runtime's has it.
	const { exports } = c.executionCtx as unknown as ExecutionContext;
	const objects: Record<string, unknown> = {};
	for (const jurisdiction of [null, "eu"] as const) {
		const workspace: WorkspaceRef = { id: NIL, jurisdiction };
		const calls = {
			workspace: () => workspaceObject(c.env, workspace).about(),
			conversation: () => conversationObject(c.env, workspace, NIL).about(),
			scripts: () => scriptsObject(c.env, workspace, NIL).about(),
			sandbox: () => sandboxObject(c.env, exports, workspace, NIL).about(),
		};
		for (const [kind, call] of Object.entries(calls)) {
			objects[`${kind}:${jurisdiction ?? "default"}`] = await call().catch((error: unknown) => ({ error: String(error) }));
		}
	}
	const migrations = await c.env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
	return json(200, { objects, d1Migrations: migrations.results.map((row) => row.name), json: escapedKeyCheck() });
}
