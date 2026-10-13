// Connectors, connections and access. The Workspace
// Durable Object holds connections and grants and their rules (`_usable`, who may change a shared
// connection, saving credentials, grant plans and the revocation they cause); the routes here check in
// Python's order, make the provider calls (providers.ts) and answer. OAuth flows are flows.ts's, their
// clients oauth-clients.ts's.

import { z } from "zod";
import { connectorRegistry } from "../connectors/index.ts";
import type { AccessOut, ConnectorOut, ResourceOut } from "../contracts/api.ts";
import type { Connector, DiscoveryPage } from "../contracts/connectors.ts";
import type { GrantChange } from "../contracts/policy.ts";
import { ACCOUNT_KIND, kindOf } from "../gateway/connector.ts";
import { InvalidGrants, MAX_CHANGES, checkChanges, resourceKey } from "../gateway/grants.ts";
import { ANY } from "../gateway/policy.ts";
import { HttpError, detail, json } from "../http/errors.ts";
import { UUID } from "../http/paths.ts";
import type { App } from "../http/router.ts";
import { pythonRepr } from "../lib/text.ts";
import { actionsOut, authOf, isAdmin, kindsOut, requestedScopes } from "../workspace/out.ts";
import { CONNECTION_FLOWS, ConnectionFlowError, type FlowStart } from "./flows.ts";
import { available } from "./oauth-clients.ts";
import { readBody, readQuery } from "./input.ts";
import { type Member, afterRevocation, memberRoute, param, valueOf } from "./members.ts";
import { keyAccount, withConnection } from "./providers.ts";

export const UNKNOWN_PROVIDER = "Unknown provider.";

const KeyIn = z.object({ key: z.string().min(1).max(500) });
/** An action id: any string (an unknown one is refused with the connector's words). */
const Action = z.string();
const ConsentIn = z.object({ actions: z.array(Action).max(10).default([]) });
const ChangeIn = z.object({ kind: z.string().min(1).max(64), id: z.string().min(1).max(200), actions: z.array(Action).max(10) });
const AccessChangesIn = z.object({ changes: z.array(ChangeIn).min(1).max(MAX_CHANGES) });
const ResourceQuery = z.object({
	kind: z.string().min(1).max(64),
	q: z.string().max(100).optional(),
	cursor: z.string().max(1000).optional(),
	parent: z.string().min(1).max(200).optional(),
});

const BASE = `/api/workspaces/:workspace${UUID}`;
const CONNECTION = `${BASE}/connections/:connection${UUID}`;
const PROVIDER = `${BASE}/connections/:provider`;

/** `_connector_or_404`. */
async function connectorOr404(provider: string): Promise<Connector> {
	const connector = (await connectorRegistry()).find(provider);
	if (connector === null) throw new HttpError(detail(404, UNKNOWN_PROVIDER));
	return connector;
}

function connectorOut(connector: Connector): ConnectorOut {
	const key = connector.auth.type === "api_key" ? connector.auth : null;
	return {
		slug: connector.slug,
		name: connector.name,
		auth: authOf(connector),
		kinds: kindsOut(connector),
		actions: actionsOut(connector),
		key_label: key?.label ?? null,
		key_hint: key?.hint ?? null,
	};
}

/** `_usable`, with what the routes need: the caller's access to the connection and its connector. */
async function usable(member: Member, connectionId: string): Promise<{ access: AccessOut; connector: Connector }> {
	const access = valueOf(await member.object.getAccess(member.caller, connectionId));
	return { access, connector: await connectorOr404(access.connection.provider) };
}

/** A shared connection (no owner) is changed only by workspace owners and admins. */
function adminsOnly(member: Member, access: AccessOut, message: string): void {
	if (!access.connection.personal && !isAdmin(member.caller)) throw new HttpError(detail(403, message));
}

async function startFlow(flow: FlowStart): Promise<Response> {
	try {
		return json(200, { url: await CONNECTION_FLOWS.start(flow) });
	} catch (error) {
		if (error instanceof ConnectionFlowError) return detail(503, error.message);
		throw error;
	}
}

export function connectionRoutes(app: App): void {
	app.get(
		`${BASE}/connectors`,
		memberRoute(async (c) => json(200, (await connectorRegistry()).all().filter((connector) => available(c.env, connector)).map(connectorOut))),
	);

	app.get(
		`${BASE}/connections`,
		memberRoute(async (_c, m) => json(200, await m.object.listConnections(m.caller))),
	);

	// Registered before the provider routes, whose `:provider` would otherwise match a connection id.
	app.put(
		`${CONNECTION}/key`,
		memberRoute(async (c, m) => {
			const { key } = await readBody(c.req.raw, KeyIn);
			const { access, connector } = await usable(m, param(c, "connection"));
			adminsOnly(m, access, "Only workspace admins can replace the key of shared connections.");
			if (connector.auth.type !== "api_key") return detail(422, "This provider does not connect with a key.");
			const account = await keyAccount(c.env, m.workspace, connector, key);
			const saved = await m.object.saveConnection(m.caller, { provider: connector.slug, account, credentials: { kind: "api_key", key }, connectionId: access.connection.id });
			return json(200, valueOf(saved));
		}),
	);

	app.post(
		`${CONNECTION}/reconnect`,
		memberRoute(async (c, m) => {
			const { actions } = await readBody(c.req.raw, ConsentIn);
			const { access, connector } = await usable(m, param(c, "connection"));
			adminsOnly(m, access, "Only workspace admins can reconnect shared connections.");
			if (connector.auth.type === "builtin") return detail(422, `${connector.name} has no account to reconnect.`);
			const unknown = actions.find((action) => !connector.actions.some((declared) => declared.id === action));
			if (unknown !== undefined) return detail(422, `${connector.name} has no action ${pythonRepr(unknown)}.`);
			if (connector.auth.type !== "oauth2") return detail(503, `${connector.name} does not connect through OAuth.`);
			// A shared connection serves every member who allows something on it.
			const allowed = (await m.object.allowedActions(m.caller, access.connection.id)) ?? [];
			const scopes = requestedScopes(connector, new Set([...allowed, ...actions]));
			return startFlow({ env: c.env, member: m, connector, connectionId: access.connection.id, scopes });
		}),
	);

	app.delete(
		CONNECTION,
		memberRoute(async (c, m) => {
			const { revocation } = valueOf(await m.object.deleteConnection(m.caller, param(c, "connection")));
			return afterRevocation(revocation, json(204, null));
		}),
	);

	app.get(
		`${CONNECTION}/access`,
		memberRoute(async (c, m) => json(200, valueOf(await m.object.getAccess(m.caller, param(c, "connection"))))),
	);

	app.get(
		`${CONNECTION}/access/resources`,
		memberRoute(async (c, m) => {
			const query = readQuery(c.req.raw, ResourceQuery);
			const { access, connector } = await usable(m, param(c, "connection"));
			if (kindOf(connector, query.kind) === null) return detail(422, `${connector.name} has no resources of type ${pythonRepr(query.kind)}.`);
			const browse = (connector.browsable ?? []).includes(query.kind) && !query.q;
			if (query.parent !== undefined && !browse) return detail(422, "Only resources that nest can be browsed, and not while searching.");
			let page: DiscoveryPage;
			if (query.kind === ACCOUNT_KIND) {
				page = { items: [{ id: access.connection.id, name: access.connection.label }], nextCursor: null };
			} else {
				const options = { cursor: query.cursor ?? null };
				page = await withConnection(c.env, m, connector, access.connection.id, async (client) => {
					if (!browse) return connector.discover(client, query.kind, { query: query.q || null, ...options });
					if (!connector.children) throw new Error(`${connector.slug} browses ${query.kind} without children()`);
					return connector.children(client, query.kind, query.parent ?? null, options);
				});
			}
			const granted = new Map(access.grants.filter((grant) => grant.kind === query.kind).map((grant) => [grant.id, grant.actions]));
			const inherited = granted.get(ANY) ?? [];
			const items: ResourceOut[] = page.items
				.filter((item) => item.id !== ANY)
				.map((item) => ({ id: item.id, name: item.name, actions: granted.get(item.id) ?? [], inherited, expandable: browse && (item.expandable ?? false) }));
			return json(200, { items, next_cursor: page.nextCursor ?? null });
		}),
	);

	app.patch(
		`${CONNECTION}/access`,
		memberRoute(async (c, m) => {
			const { changes: body } = await readBody(c.req.raw, AccessChangesIn);
			const changes: GrantChange[] = body.map((change) => ({ kind: change.kind, id: change.id, actions: change.actions }));
			const { access, connector } = await usable(m, param(c, "connection"));
			const connectionId = access.connection.id;
			try {
				checkChanges(connector, connectionId, changes);
			} catch (error) {
				if (error instanceof InvalidGrants) return detail(422, error.message);
				throw error;
			}
			// Only resources the account can see may be allowed; removing a grant never needs the provider.
			const wanted = new Map<string, string[]>();
			for (const change of changes) {
				if (change.actions.length && change.id !== ANY && change.kind !== ACCOUNT_KIND) wanted.set(change.kind, [...(wanted.get(change.kind) ?? []), change.id]);
			}
			const names: { [key: string]: string } = {};
			if (wanted.size) {
				const described = await withConnection(c.env, m, connector, connectionId, async (client) => {
					const found = new Map<string, { [id: string]: string }>();
					for (const [kind, ids] of wanted) found.set(kind, await connector.describe(client, kind, ids));
					return found;
				});
				for (const [kind, ids] of wanted) {
					const found = described.get(kind) ?? {};
					for (const id of ids) {
						const name = Object.hasOwn(found, id) ? found[id] : undefined;
						if (typeof name !== "string") {
							const label = (kindOf(connector, kind)?.label ?? kind).toLowerCase();
							return detail(422, `Choose a ${label} that the connected account can see.`);
						}
						names[resourceKey(kind, id)] = name;
					}
				}
			}
			const { access: saved, revocation } = valueOf(await m.object.applyGrantChanges(m.caller, connectionId, changes, names));
			return afterRevocation(revocation, json(200, saved));
		}),
	);

	app.post(
		`${PROVIDER}/authorize`,
		memberRoute(async (c, m) => {
			const connector = await connectorOr404(param(c, "provider"));
			return startFlow({ env: c.env, member: m, connector, connectionId: null, scopes: null });
		}),
	);

	app.post(
		`${PROVIDER}/enable`,
		memberRoute(async (c, m) => json(200, valueOf(await m.object.enableBuiltin(m.caller, param(c, "provider"))))),
	);

	app.post(
		`${PROVIDER}/key`,
		memberRoute(async (c, m) => {
			const { key } = await readBody(c.req.raw, KeyIn);
			const connector = await connectorOr404(param(c, "provider"));
			if (connector.auth.type !== "api_key") return detail(422, "This provider does not connect with a key.");
			const account = await keyAccount(c.env, m.workspace, connector, key);
			const saved = await m.object.saveConnection(m.caller, { provider: connector.slug, account, credentials: { kind: "api_key", key }, connectionId: null });
			return json(200, valueOf(saved));
		}),
	);
}
