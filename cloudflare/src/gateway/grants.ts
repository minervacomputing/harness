// Layers and grants, the pure parts: the policy a run
// starts with, built from the Workspace Durable Object's rows, and the checks and plan of a grant edit.
// Storing the rows, bumping the layer's version and revoking runs are the Workspace's (step 2b).

import type { ConnectionId, UserId } from "../contracts/common.ts";
import type { Connector } from "../contracts/connectors.ts";
import type { GrantChange, GrantRow } from "../contracts/policy.ts";
import { ACCOUNT_KIND, actionOf, kindOf, requiresOf } from "./connector.ts";
import { ANY, Layer, type LayerName, Policy } from "./policy.ts";
import type { Registry } from "./registry.ts";
import { compareText } from "../lib/arrays.ts";

export type Level = GrantRow["layer"];

/**
 * A missing layer means: the ceiling passes everything through, a user allows nothing until they choose,
 * an agent inherits whatever the layers above allow.
 */
export const DEFAULT_RESTRICTED: { readonly [level in Level]: boolean } = { ceiling: false, user: true, agent: false };
export const MAX_CHANGES = 100;
export const MAX_GRANTS_PER_CONNECTION = 500;

/** A grant edit the connector cannot enforce; the API answers 422 with its message. */
export class InvalidGrants extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidGrants";
	}
}

/** One layer as the Workspace stores it: whether it is restricted, and its grants. */
export interface LayerRows {
	restricted: boolean;
	grants: readonly GrantRow[];
}

/** The layers that apply to a run by one user with one agent; null where none is stored. */
export interface RunLayers {
	ceiling: LayerRows | null;
	user: LayerRows | null;
	agent: LayerRows | null;
}

/** The provider of a connection in the workspace, or null when there is no such connection. */
export type ProviderOf = (connectionId: ConnectionId) => string | null;

/**
 * Denies always apply. An allow counts only for a kind the connector still declares, and a wildcard allow
 * only where the kind supports one, so a hand-edited row cannot widen access.
 */
export function enforceable(grant: GrantRow, registry: Registry, providerOf: ProviderOf): boolean {
	if (grant.effect === "deny") return true;
	const provider = providerOf(grant.connectionId);
	const connector = provider === null ? null : registry.find(provider);
	const kind = connector === null ? null : kindOf(connector, grant.kind);
	return kind !== null && (grant.resourceId !== ANY || (kind.wildcard ?? false));
}

function toLayer(name: LayerName, level: Level, layer: LayerRows | null, registry: Registry, providerOf: ProviderOf): Layer {
	if (layer === null) return new Layer(name, DEFAULT_RESTRICTED[level], [], []);
	return Layer.build(
		name,
		layer.restricted,
		layer.grants.filter((grant) => enforceable(grant, registry, providerOf)),
	);
}

/** Every layer that applies to a run by this user with this agent, in the order ceiling, user, agent. */
export function effectivePolicy(layers: RunLayers, registry: Registry, providerOf: ProviderOf): Policy {
	return new Policy([
		toLayer("ceiling", "ceiling", layers.ceiling, registry, providerOf),
		toLayer("user", "user", layers.user, registry, providerOf),
		toLayer("agent", "agent", layers.agent, registry, providerOf),
	]);
}

/** The allow grants users set on the connection: one user's, or with null, every user's. */
export function userGrants(grants: readonly GrantRow[], connectionId: ConnectionId, userId: UserId | null): GrantRow[] {
	return grants
		.filter((grant) => grant.layer === "user" && grant.connectionId === connectionId && grant.effect === "allow")
		.filter((grant) => userId === null || grant.subject === userId)
		.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.resourceId, b.resourceId));
}

/** Every action the user (or, with null, any user) allows on some resource of the connection. */
export function allowedActions(grants: readonly GrantRow[], connectionId: ConnectionId, userId: UserId | null): Set<string> {
	return new Set(userGrants(grants, connectionId, userId).flatMap((grant) => grant.actions));
}

function label(connector: Connector, actionId: string): string {
	return actionOf(connector, actionId)?.label ?? actionId;
}

/** Rejects changes the connector cannot enforce, before anything asks the provider about them. */
export function checkChanges(connector: Connector, connectionId: ConnectionId, changes: readonly GrantChange[]): void {
	if (changes.length === 0) throw new InvalidGrants("Nothing to change.");
	if (changes.length > MAX_CHANGES) throw new InvalidGrants(`Change at most ${MAX_CHANGES} resources at once.`);
	const seen = new Set<string>();
	for (const change of changes) {
		const kind = kindOf(connector, change.kind);
		if (kind === null) throw new InvalidGrants(`${connector.name} has no resources of type ${JSON.stringify(change.kind)}.`);
		if (!change.id || change.id.length > 200) throw new InvalidGrants("Choose a resource.");
		if (change.id === ANY && !kind.wildcard) throw new InvalidGrants(`Permissions for ${kind.label.toLowerCase()} resources are set one at a time.`);
		if (kind.id === ACCOUNT_KIND && change.id !== connectionId) throw new InvalidGrants("Account permissions apply to the connection itself.");
		const key = resourceKey(change.kind, change.id);
		if (seen.has(key)) throw new InvalidGrants("Each resource can only be listed once.");
		seen.add(key);
		for (const actionId of change.actions) {
			if (!kind.actions.includes(actionId)) {
				throw new InvalidGrants(`${connector.name} does not support ${JSON.stringify(actionId)} on ${kind.label.toLowerCase()}.`);
			}
		}
	}
}

/** How a (kind, resource id) pair is keyed in grant states and in the names of `applyGrantChanges`. */
export function resourceKey(kind: string, id: string): string {
	return JSON.stringify([kind, id]);
}

/** One resource's allowed actions in a grant state. */
export interface GrantEntry {
	kind: string;
	id: string;
	actions: Set<string>;
}

/** A user's allow grants on one connection: (kind, id) to actions, keyed by `resourceKey`. */
export type GrantState = Map<string, GrantEntry>;

/** Checks the grants as they will be after the change. A requirement may be met by a wildcard grant. */
export function checkState(connector: Connector, state: GrantState, names: ReadonlyMap<string, string>, kinds: ReadonlySet<string>): void {
	let count = 0;
	for (const entry of state.values()) if (entry.actions.size > 0) count++;
	if (count > MAX_GRANTS_PER_CONNECTION) throw new InvalidGrants(`A connection can have at most ${MAX_GRANTS_PER_CONNECTION} permissions.`);
	const requires = requiresOf(connector);
	const entries = [...state.values()].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id));
	for (const { kind, id, actions } of entries) {
		if (!kinds.has(kind)) continue;
		const inherited = state.get(resourceKey(kind, ANY))?.actions ?? new Set<string>();
		for (const actionId of [...actions].sort()) {
			const required = requires(actionId);
			if (required !== null && !actions.has(required) && !inherited.has(required)) {
				const name = names.get(resourceKey(kind, id)) || id;
				throw new InvalidGrants(`${label(connector, actionId)} on ${name} also requires ${label(connector, required)}.`);
			}
		}
	}
}

/** What a grant edit writes: rows created or updated (actions sorted and unique), and rows deleted. */
export interface GrantPlan {
	upserts: { kind: string; resourceId: string; actions: string[]; resourceName: string }[];
	deletes: { kind: string; resourceId: string }[];
	/** The user's allow grants on the connection afterwards, the empty ones left out. */
	state: GrantState;
}

/**
 * The pure part of `apply_grant_changes`: the user's allow grants on one connection with the changes
 * applied, checked, all or nothing (InvalidGrants). `current` are those grants as stored; `names` are
 * the provider's names for display, keyed by `resourceKey`, and win over stored ones. Call
 * `checkChanges` first, before asking the provider for names.
 */
export function planGrantChanges(
	connector: Connector,
	current: readonly GrantRow[],
	changes: readonly GrantChange[],
	names: ReadonlyMap<string, string>,
): GrantPlan {
	const rows = new Map(current.map((grant) => [resourceKey(grant.kind, grant.resourceId), grant]));
	const state: GrantState = new Map();
	for (const [key, grant] of rows) state.set(key, { kind: grant.kind, id: grant.resourceId, actions: new Set(grant.actions) });
	const stored = new Map<string, string>();
	for (const [key, grant] of rows) if (grant.resourceName) stored.set(key, grant.resourceName);
	for (const change of changes) state.set(resourceKey(change.kind, change.id), { kind: change.kind, id: change.id, actions: new Set(change.actions) });
	checkState(connector, state, new Map([...stored, ...names]), new Set(changes.map((change) => change.kind)));
	const plan: GrantPlan = { upserts: [], deletes: [], state: new Map() };
	for (const change of changes) {
		const key = resourceKey(change.kind, change.id);
		const row = rows.get(key);
		if (change.actions.length === 0) {
			if (row !== undefined) plan.deletes.push({ kind: change.kind, resourceId: change.id });
			continue;
		}
		const resourceName = names.get(key) ?? row?.resourceName ?? "";
		plan.upserts.push({ kind: change.kind, resourceId: change.id, actions: [...new Set(change.actions)].sort(), resourceName });
	}
	for (const [key, entry] of state) if (entry.actions.size > 0) plan.state.set(key, entry);
	return plan;
}
