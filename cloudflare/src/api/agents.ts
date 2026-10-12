// Agents (web-api 8.3), ported from backend/agents/api.py over the Workspace Durable Object, which holds
// the rules: who may edit (`_editable`), which connections may be added (`_connections`), the full
// replace, the revocation of the agent's runs when its connection set changes, and the last agent kept.

import { z } from "zod";
import { settings } from "../config.ts";
import { json, notFound } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App } from "../http/router.ts";
import { str } from "../lib/schema.ts";
import { readBody, uuid } from "./input.ts";
import { afterRevocation, memberRoute, param, valueOf } from "./members.ts";

/** `AgentIn`: a PUT is a full replace, so omitted fields take these defaults. */
export const AgentIn = z.object({
	name: str({ min: 1, max: 120 }),
	instructions: str({ max: 8000 }).default(""),
	connection_ids: z.array(uuid()).max(20).default([]),
});

const AGENTS = `/api/workspaces/:workspace${UUID}/agents`;
const AGENT = `${AGENTS}/:agent${UUID}`;

export function agentRoutes(app: App): void {
	app.get(
		AGENTS,
		memberRoute(async (_c, m) => json(200, await m.object.listAgents(m.caller))),
	);

	app.post(
		AGENTS,
		memberRoute(async (c, m) => {
			const input = await readBody(c.req.raw, AgentIn);
			return json(201, valueOf(await m.object.createAgent(m.caller, input)));
		}),
	);

	app.get(
		AGENT,
		memberRoute(async (c, m) => {
			const agent = await m.object.getAgent(m.caller, param(c, "agent"));
			return agent === null ? notFound("No Agent matches the given query.", settings(c.env).debug) : json(200, agent);
		}),
	);

	app.put(
		AGENT,
		memberRoute(async (c, m) => {
			const input = await readBody(c.req.raw, AgentIn);
			const { agent, revocation } = valueOf(await m.object.updateAgent(m.caller, param(c, "agent"), input));
			return afterRevocation(revocation, json(200, agent));
		}),
	);

	app.delete(
		AGENT,
		memberRoute(async (c, m) => {
			const { revocation } = valueOf(await m.object.deleteAgent(m.caller, param(c, "agent")));
			return afterRevocation(revocation, json(204, null));
		}),
	);
}
