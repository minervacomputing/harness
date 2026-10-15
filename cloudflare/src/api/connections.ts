// Connectors, connections and access (contract/src/public/connections.ts). The Workspace Durable Object holds
// connections and grants and their rules (`#usable`, who may change a shared connection, saving credentials,
// grant plans and the revocation they cause); the procedures here check the input, make the provider calls
// (providers.ts) and answer. OAuth flows are flows.ts's, their clients oauth-clients.ts's.
//
// No answer carries a credential: the Workspace's views (workspace/out.ts) are built field by field from the
// contract's types, and the reads are checked against its schemas, which drop any other field. A key sent
// here is passed to the provider and to the Workspace, which stores it encrypted.

import type { Access, Connector as ConnectorView, Resource } from "@minerva/contract";
import { connectorRegistry } from "../connectors/index.ts";
import { ACCOUNT_KIND, type Connector, type DiscoveryPage, kindOf } from "../gateway/connector.ts";
import { type GrantChange, InvalidGrants, checkChanges, resourceKey } from "../gateway/grants.ts";
import { ANY } from "../gateway/policy.ts";
import { actionsOut, authOf, isAdmin, kindsOut, requestedScopes } from "../workspace/out.ts";
import { CONNECTION_FLOWS, ConnectionFlowError, type FlowStart } from "./flows.ts";
import type { Member } from "./members.ts";
import { available } from "./oauth-clients.ts";
import { api, checkStopped, inWorkspace, refusal, unwrap } from "./procedures.ts";
import { keyAccount, withConnection } from "./providers.ts";

export const UNKNOWN_PROVIDER = "Unknown provider.";
const NO_KEY = "This provider does not connect with a key.";
const noOAuth = (connector: Connector) => `${connector.name} does not connect through OAuth.`;

/** The provider's connector, or `UNKNOWN_PROVIDER`. */
async function connectorOf(provider: string): Promise<Connector> {
	const connector = (await connectorRegistry()).find(provider);
	if (connector === null) throw refusal("UNKNOWN_PROVIDER", UNKNOWN_PROVIDER);
	return connector;
}

function connectorOut(connector: Connector): ConnectorView {
	const key = connector.auth.type === "api_key" ? connector.auth : null;
	return {
		slug: connector.slug,
		name: connector.name,
		auth: authOf(connector),
		kinds: kindsOut(connector),
		actions: actionsOut(connector),
		keyLabel: key?.label ?? null,
		keyHint: key?.hint ?? null,
	};
}

/** The caller's access to the connection and its connector; another user's personal connection is `NOT_FOUND`. */
async function usable(member: Member, connectionId: string): Promise<{ access: Access; connector: Connector }> {
	const access = unwrap(await member.object.getAccess(member.caller, connectionId));
	return { access, connector: await connectorOf(access.connection.provider) };
}

/** A shared connection (no owner) is changed only by workspace owners and admins. */
function adminsOnly(member: Member, access: Access, message: string): void {
	if (!access.connection.personal && !isAdmin(member.caller)) throw refusal("WORKSPACE_ADMINS_ONLY", message);
}

async function startFlow(flow: FlowStart): Promise<{ url: string }> {
	try {
		return { url: await CONNECTION_FLOWS.start(flow) };
	} catch (error) {
		if (error instanceof ConnectionFlowError) throw refusal("CONNECT_UNAVAILABLE", error.message);
		throw error;
	}
}

/** Only resources the account can see may be allowed: their names, from the provider, by `resourceKey`. Removing a grant never asks it. */
async function visibleNames(env: Env, member: Member, connector: Connector, connectionId: string, changes: GrantChange[]): Promise<{ [key: string]: string }> {
	const wanted = new Map<string, string[]>();
	for (const change of changes) {
		if (change.actions.length && change.id !== ANY && change.kind !== ACCOUNT_KIND) wanted.set(change.kind, [...(wanted.get(change.kind) ?? []), change.id]);
	}
	const names: { [key: string]: string } = {};
	if (wanted.size === 0) return names;
	const described = await withConnection(env, member, connector, connectionId, async (client) => {
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
				throw refusal("RESOURCE_NOT_VISIBLE", `Choose a ${label} that the connected account can see.`);
			}
			names[resourceKey(kind, id)] = name;
		}
	}
	return names;
}

const connectors = api.connectors.use(inWorkspace);
const connections = api.connections.use(inWorkspace);

export const connectorProcedures = connectors.router({
	list: connectors.list.handler(async ({ context }) => (await connectorRegistry()).all().filter((connector) => available(context.env, connector)).map(connectorOut)),
});

export const connectionProcedures = connections.router({
	list: connections.list.handler(({ context: { member } }) => member.object.listConnections(member.caller)),

	authorize: connections.authorize.handler(async ({ context, input }) => {
		const connector = await connectorOf(input.provider);
		if (connector.auth.type !== "oauth2") throw refusal("WRONG_CONNECTION_METHOD", noOAuth(connector));
		return startFlow({ env: context.env, member: context.member, connector, connectionId: null, scopes: null });
	}),

	enable: connections.enable.handler(async ({ context: { member }, input }) => unwrap(await member.object.enableBuiltin(member.caller, input.provider))),

	connectKey: connections.connectKey.handler(async ({ context: { env, member }, input }) => {
		const connector = await connectorOf(input.provider);
		if (connector.auth.type !== "api_key") throw refusal("WRONG_CONNECTION_METHOD", NO_KEY);
		const account = await keyAccount(env, member.workspace, connector, input.key);
		return unwrap(await member.object.saveConnection(member.caller, { provider: connector.slug, account, credentials: { kind: "api_key", key: input.key }, connectionId: null }));
	}),

	replaceKey: connections.replaceKey.handler(async ({ context: { env, member }, input }) => {
		const { access, connector } = await usable(member, input.connectionId);
		adminsOnly(member, access, "Only workspace admins can replace the key of shared connections.");
		if (connector.auth.type !== "api_key") throw refusal("WRONG_CONNECTION_METHOD", NO_KEY);
		const account = await keyAccount(env, member.workspace, connector, input.key);
		const connectionId = access.connection.id;
		return unwrap(await member.object.saveConnection(member.caller, { provider: connector.slug, account, credentials: { kind: "api_key", key: input.key }, connectionId }));
	}),

	reconnect: connections.reconnect.handler(async ({ context: { env, member }, input }) => {
		const { access, connector } = await usable(member, input.connectionId);
		adminsOnly(member, access, "Only workspace admins can reconnect shared connections.");
		if (connector.auth.type === "builtin") throw refusal("WRONG_CONNECTION_METHOD", `${connector.name} has no account to reconnect.`);
		if (connector.auth.type !== "oauth2") throw refusal("WRONG_CONNECTION_METHOD", noOAuth(connector));
		const unknown = input.actions.find((action) => !connector.actions.some((declared) => declared.id === action));
		if (unknown !== undefined) throw refusal("UNKNOWN_ACTION", `${connector.name} has no action ${JSON.stringify(unknown)}.`);
		// A shared connection serves every member who allows something on it.
		const allowed = (await member.object.allowedActions(member.caller, access.connection.id)) ?? [];
		const scopes = requestedScopes(connector, new Set([...allowed, ...input.actions]));
		return startFlow({ env, member, connector, connectionId: access.connection.id, scopes });
	}),

	delete: connections.delete.handler(async ({ context: { member }, input }) => {
		checkStopped(unwrap(await member.object.deleteConnection(member.caller, input.connectionId)).revocation);
	}),

	access: connections.access.handler(async ({ context: { member }, input }) => unwrap(await member.object.getAccess(member.caller, input.connectionId))),

	resources: connections.resources.handler(async ({ context: { env, member }, input }) => {
		const { access, connector } = await usable(member, input.connectionId);
		if (kindOf(connector, input.kind) === null) throw refusal("UNKNOWN_RESOURCE_KIND", `${connector.name} has no resources of type ${JSON.stringify(input.kind)}.`);
		const browse = (connector.browsable ?? []).includes(input.kind) && !input.q;
		if (input.parent !== undefined && !browse) throw refusal("CANNOT_BROWSE", "Only resources that nest can be browsed, and not while searching.");
		let page: DiscoveryPage;
		if (input.kind === ACCOUNT_KIND) {
			page = { items: [{ id: access.connection.id, name: access.connection.label }], nextCursor: null };
		} else {
			const options = { cursor: input.cursor ?? null };
			page = await withConnection(env, member, connector, access.connection.id, async (client) => {
				if (!browse) return connector.discover(client, input.kind, { query: input.q || null, ...options });
				if (!connector.children) throw new Error(`${connector.slug} browses ${input.kind} without children()`);
				return connector.children(client, input.kind, input.parent ?? null, options);
			});
		}
		const granted = new Map(access.grants.filter((grant) => grant.kind === input.kind).map((grant) => [grant.id, grant.actions]));
		const inherited = granted.get(ANY) ?? [];
		const items: Resource[] = page.items
			.filter((item) => item.id !== ANY)
			.map((item) => ({ id: item.id, name: item.name, actions: granted.get(item.id) ?? [], inherited, expandable: browse && (item.expandable ?? false) }));
		return { items, nextCursor: page.nextCursor ?? null };
	}),

	changeAccess: connections.changeAccess.handler(async ({ context: { env, member }, input }) => {
		const changes: GrantChange[] = input.changes.map((change) => ({ kind: change.kind, id: change.id, actions: change.actions }));
		const { access, connector } = await usable(member, input.connectionId);
		const connectionId = access.connection.id;
		try {
			checkChanges(connector, connectionId, changes);
		} catch (error) {
			if (error instanceof InvalidGrants) throw refusal("INVALID_ACCESS_CHANGE", error.message);
			throw error;
		}
		const names = await visibleNames(env, member, connector, connectionId, changes);
		const { access: saved, revocation } = unwrap(await member.object.applyGrantChanges(member.caller, connectionId, changes, names));
		checkStopped(revocation);
		return saved;
	}),
});
