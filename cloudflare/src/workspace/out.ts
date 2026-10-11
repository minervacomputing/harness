// The API's shapes as the Workspace builds them, ported from backend/connections/api.py (`_connection_out`,
// `_allowed`, `_kinds`, `_actions`, `get_access`), connections/oauth.py (`consent_needed`,
// `requested_scopes`) and agents/api.py (`_out`) (connectors 11.7, 13; web-api 8.3, 8.5).

import type { AccessOut, ActionOut, AgentOut, AllowedOut, ConnectionOut, ConversationOut, GrantOut, KindOut } from "../contracts/api.ts";
import type { Caller, UserId } from "../contracts/common.ts";
import type { Connector, Operation } from "../contracts/connectors.ts";
import type { GrantRow } from "../contracts/policy.ts";
import { actionOf, consentGiven, kindOf } from "../gateway/connector.ts";
import { ANY } from "../gateway/policy.ts";
import { sortByCodePoint } from "../lib/order.ts";
import { isoTime } from "../lib/time.ts";

/** Names of resources shown per allowed action in a connection's summary. */
export const SUMMARY_NAMES = 3;

export function isAdmin(caller: Caller): boolean {
	return caller.role === "owner" || caller.role === "admin";
}

export function authOf(connector: Connector): ConnectionOut["auth"] {
	return connector.auth.type;
}

export function actionsOut(connector: Connector): ActionOut[] {
	return connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null }));
}

export function kindsOut(connector: Connector): KindOut[] {
	const browsable = new Set(connector.browsable ?? []);
	return connector.kinds.map((kind) => ({
		id: kind.id,
		label: kind.label,
		actions: [...kind.actions],
		wildcard: kind.wildcard ?? false,
		hierarchical: kind.hierarchical ?? false,
		note: kind.note ?? null,
		listed: kind.listed ?? true,
		browsable: browsable.has(kind.id),
	}));
}

function needActions(op: Operation<never>): Set<string> {
	return new Set(op.needs.map(([, action]) => action));
}

function hasConsent(op: Operation<never>): boolean {
	return op.consent !== null && op.consent !== undefined && op.consent.length > 0;
}

/**
 * `_lacking`: operations the allowed actions make usable (every action they need is allowed, any kind) but
 * the scopes do not cover, each with the actions to blame: those no covered operation already performs,
 * or all of its actions when there are none.
 */
function lacking(connector: Connector, scopes: readonly string[], actions: ReadonlySet<string>): [Operation<never>, Set<string>][] {
	const usable = connector.operations.filter((op) => [...needActions(op)].every((action) => actions.has(action)));
	const covered = new Set(usable.filter((op) => !hasConsent(op) || consentGiven(op.consent, scopes)));
	const served = new Set([...covered].flatMap((op) => [...needActions(op)]));
	const out: [Operation<never>, Set<string>][] = [];
	for (const op of usable) {
		if (covered.has(op)) continue;
		const used = needActions(op);
		const blamed = new Set([...used].filter((action) => !served.has(action)));
		out.push([op, blamed.size ? blamed : used]);
	}
	return out;
}

/**
 * `consent_needed`: allowed actions some operation cannot perform yet because the provider did not grant
 * its scopes, in the connector's order. Unknown scopes need nothing: the provider is then the one to refuse.
 */
export function consentNeeded(connector: Connector, scopes: readonly string[] | null, actions: ReadonlySet<string>): string[] {
	if (scopes === null || connector.auth.type !== "oauth2") return [];
	const missing = new Set(lacking(connector, scopes, actions).flatMap(([, used]) => [...used]));
	return connector.actions.filter((action) => missing.has(action.id)).map((action) => action.id);
}

/**
 * `requested_scopes`: the connector's base scopes, then what the operations behind `actions` need (the first
 * option of each), sorted. Stored scopes are not trusted to be current: the user may have revoked access at
 * the provider since. For the reconnect flow (connectors 11.7).
 */
export function requestedScopes(connector: Connector, actions: ReadonlySet<string>): string[] {
	if (connector.auth.type !== "oauth2") throw new TypeError(`${connector.name} does not connect through OAuth.`);
	const requested = [...connector.auth.scopes];
	const base = new Set(requested);
	const extra = new Set<string>();
	for (const [op] of lacking(connector, [], actions)) for (const scope of op.consent?.[0] ?? []) extra.add(scope);
	return [...requested, ...sortByCodePoint([...extra].filter((scope) => !base.has(scope)))];
}

/** `_allowed`: the user's grants by action, in the connector's order of kinds and actions. `grants` are in (kind, id) order. */
export function allowedOut(connector: Connector, grants: readonly GrantRow[]): AllowedOut[] {
	const allowed: AllowedOut[] = [];
	for (const kind of connector.kinds) {
		for (const actionId of kind.actions) {
			const on = grants.filter((grant) => grant.kind === kind.id && grant.actions.includes(actionId));
			if (on.length === 0) continue;
			const some = on.filter((grant) => grant.resourceId !== ANY);
			allowed.push({
				kind: kind.id,
				kind_label: kind.label,
				action: actionId,
				action_label: actionOf(connector, actionId)?.label ?? actionId,
				all: some.length < on.length,
				count: some.length,
				names: some.slice(0, SUMMARY_NAMES).map((grant) => grant.resourceName || grant.resourceId),
			});
		}
	}
	return allowed;
}

/** A connection as the Workspace stores it, for the API. */
export interface ConnectionView {
	id: string;
	provider: string;
	ownerId: UserId | null;
	label: string;
	status: ConnectionOut["status"];
	createdAt: number;
	scopes: string[] | null;
}

/** `_connection_out`. `grants` are the caller's allow grants on the connection, in (kind, id) order. */
export function connectionOut(connector: Connector, connection: ConnectionView, grants: readonly GrantRow[]): ConnectionOut {
	const actions = new Set(grants.flatMap((grant) => grant.actions));
	const manage = connector.manageLink ? connector.manageLink() : null;
	return {
		id: connection.id,
		provider: connection.provider,
		provider_name: connector.name,
		auth: authOf(connector),
		label: connection.label,
		status: connection.status,
		personal: connection.ownerId !== null,
		created_at: isoTime(connection.createdAt),
		consent_needed: consentNeeded(connector, connection.scopes, actions),
		manage_label: manage ? manage[0] : null,
		manage_url: manage ? manage[1] : null,
		allowed: allowedOut(connector, grants),
	};
}

/** `get_access`: only grants on kinds the connector still declares. */
export function accessOut(connector: Connector, connection: ConnectionView, grants: readonly GrantRow[]): AccessOut {
	const listed: GrantOut[] = grants
		.filter((grant) => kindOf(connector, grant.kind) !== null)
		.map((grant) => ({ kind: grant.kind, id: grant.resourceId, name: grant.resourceName || null, actions: [...grant.actions] }));
	return { connection: connectionOut(connector, connection, grants), kinds: kindsOut(connector), actions: actionsOut(connector), grants: listed };
}

export interface AgentView {
	id: string;
	ownerId: UserId;
	name: string;
	instructions: string;
	connectionIds: string[];
	createdAt: number;
}

/** `can_edit`: the agent's owner, or a workspace owner or admin. */
export function agentOut(caller: Caller, agent: AgentView): AgentOut {
	return {
		id: agent.id,
		name: agent.name,
		instructions: agent.instructions,
		connection_ids: [...agent.connectionIds],
		can_edit: agent.ownerId === caller.userId || isAdmin(caller),
		created_at: isoTime(agent.createdAt),
	};
}

export function conversationOut(row: { id: string; agent_id: string; title: string; updated_at: number }): ConversationOut {
	return { id: row.id, agent_id: row.agent_id, title: row.title, updated_at: isoTime(row.updated_at) };
}
