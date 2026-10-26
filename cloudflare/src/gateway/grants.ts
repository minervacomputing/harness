// Layers and grants, the pure parts: the policy a run starts with, built from the layers Laravel's start names
// (internal/start.ts), and the checks and plan of a grant edit (internal/connections.ts `checkGrantEdit`). Laravel
// stores the layers.

import { MAX_ACCESS_CHANGES } from "@minerva/contract";
import type { ConnectionId } from "../shared/rpc.ts";
import { ACCOUNT_KIND, type Connector, actionOf, kindOf, requiresOf, termsOf } from "./connector.ts";
import { ANY, type Effect, type GrantInput, Layer, type LayerName, Policy, chain } from "./policy.ts";
import type { Registry } from "./registry.ts";
import { compareText } from "../lib/arrays.ts";

/** A grant of a layer. */
export interface GrantRow {
	layer: "ceiling" | "user" | "agent";
	/** The user of a user layer, the agent of an agent layer. */
	subject: string | null;
	connectionId: ConnectionId;
	kind: string;
	/** ≤200 characters, or `*`. */
	resourceId: string;
	/** Display only, ≤300 characters. */
	resourceName: string;
	/** Sorted, unique. */
	actions: string[];
	effect: Effect;
}

/** A row a grant edit plans: allows and asks, never denies, which pass through it untouched. */
export type EditableRow = GrantRow & { effect: Exclude<Effect, "deny"> };

/** One change of a grant edit (≤100 per edit; empty actions remove the grant). */
export interface GrantChange {
	kind: string;
	id: string;
	actions: string[];
	/** Those of `actions` asked before each call. */
	ask: string[];
}

export type Level = GrantRow["layer"];

/**
 * A missing layer means: the ceiling passes everything through, a user allows nothing until they choose,
 * an agent inherits whatever the layers above allow.
 */
export const DEFAULT_RESTRICTED: { readonly [level in Level]: boolean } = { ceiling: false, user: true, agent: false };
/** The API's limit (contract `MAX_ACCESS_CHANGES`), checked again where grants are planned. */
export const MAX_CHANGES = MAX_ACCESS_CHANGES;
export const MAX_GRANTS_PER_CONNECTION = 500;

/** A grant edit the connector cannot enforce; `checkGrantEdit` answers `invalid` with its message. */
export class InvalidGrants extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidGrants";
	}
}

/** One layer: whether it is restricted, and its grants. */
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

function connectorOf(connectionId: ConnectionId, registry: Registry, providerOf: ProviderOf): Connector | null {
	const provider = providerOf(connectionId);
	return provider === null ? null : registry.find(provider);
}

/**
 * Denies always apply. An allow, or the allow an ask row carries, counts only for a kind the connector still declares,
 * and a wildcard one only where the kind supports one, so a hand-edited row cannot widen access.
 */
export function enforceable(grant: GrantRow, registry: Registry, providerOf: ProviderOf): boolean {
	switch (grant.effect) {
		case "deny":
			return true;
		case "ask":
		case "allow": {
			const connector = connectorOf(grant.connectionId, registry, providerOf);
			const kind = connector === null ? null : kindOf(connector, grant.kind);
			return kind !== null && (grant.resourceId !== ANY || (kind.wildcard ?? false));
		}
	}
}

const ASKABLE = new WeakMap<Connector, ReadonlySet<string>>();

/**
 * The actions an ask may sit on: those no operation that only reads needs, directly or through `requires`, so a read
 * never waits for anyone and a connector cannot make one. Today every write action and never `read`.
 */
export function askable(connector: Connector): ReadonlySet<string> {
	const known = ASKABLE.get(connector);
	if (known !== undefined) return known;
	const requires = requiresOf(connector);
	const read = new Set<string>();
	for (const op of connector.operations) {
		if (termsOf(op).mutates) continue;
		for (const [, action] of op.needs) for (const item of chain(action, requires)) read.add(item);
	}
	const found: ReadonlySet<string> = new Set(connector.actions.map((action) => action.id).filter((id) => !read.has(id)));
	ASKABLE.set(connector, found);
	return found;
}

/**
 * The keys a row compiles to. A deny always applies, and an allow where it is enforceable. An ask asks always, and
 * allows too where an allow would be enforceable, so it passes a restricted layer only as that allow would. Its actions
 * that cannot be asked before (`askable`), all of them on a connector this engine lacks, deny instead.
 */
function compiled(grant: GrantRow, registry: Registry, providerOf: ProviderOf): GrantInput[] {
	const row = (actions: readonly string[], effect: Effect): GrantInput => ({ connectionId: grant.connectionId, kind: grant.kind, resourceId: grant.resourceId, actions, effect });
	switch (grant.effect) {
		case "deny":
			return [row(grant.actions, "deny")];
		case "allow":
			return enforceable(grant, registry, providerOf) ? [row(grant.actions, "allow")] : [];
		case "ask": {
			const connector = connectorOf(grant.connectionId, registry, providerOf);
			const can = connector === null ? new Set<string>() : askable(connector);
			const asked = grant.actions.filter((action) => can.has(action));
			const rows = [row(grant.actions.filter((action) => !can.has(action)), "deny"), row(asked, "ask")];
			if (enforceable(grant, registry, providerOf)) rows.push(row(asked, "allow"));
			return rows;
		}
	}
}

function toLayer(name: LayerName, level: Level, layer: LayerRows | null, registry: Registry, providerOf: ProviderOf): Layer {
	if (layer === null) return Layer.build(name, DEFAULT_RESTRICTED[level], []);
	return Layer.build(
		name,
		layer.restricted,
		layer.grants.flatMap((grant) => compiled(grant, registry, providerOf)),
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
		for (const actionId of change.ask) {
			if (!change.actions.includes(actionId)) throw new InvalidGrants(`${connector.name} cannot ask before ${label(connector, actionId)} without allowing it.`);
			if (!askable(connector).has(actionId)) throw new InvalidGrants(`${connector.name} cannot ask before ${label(connector, actionId)}; it is needed to read.`);
		}
	}
}

/** How a (kind, resource id) pair is keyed in grant states and in the names of `applyGrantChanges`. */
export function resourceKey(kind: string, id: string): string {
	return JSON.stringify([kind, id]);
}

/** One resource's allowed actions in a grant state, and those of them asked before. */
export interface GrantEntry {
	kind: string;
	id: string;
	actions: Set<string>;
	/** A subset of `actions`. */
	ask: Set<string>;
}

/** A layer's allow and ask grants on one connection: (kind, id) to actions, keyed by `resourceKey`. */
export type GrantState = Map<string, GrantEntry>;

/**
 * Checks the grants as they will be after the change. A requirement may be met by a wildcard grant, and an action
 * asked before counts as on, so asking before creating still needs reading.
 */
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

/** What a grant edit writes: resources created or updated (actions and asks sorted and unique), and resources deleted. */
export interface GrantPlan {
	upserts: { kind: string; resourceId: string; actions: string[]; ask: string[]; resourceName: string }[];
	deletes: { kind: string; resourceId: string }[];
	/** The layer's allow and ask grants on the connection afterwards, the empty ones left out. */
	state: GrantState;
}

/**
 * The pure part of `apply_grant_changes`: a layer's allow and ask grants on one connection with the changes
 * applied, checked, all or nothing (InvalidGrants). `current` are those grants as stored, rows of one resource
 * merged: their actions together, and asked before where any of them asks. `names` are the provider's names for
 * display, keyed by `resourceKey`, and win over stored ones. Call `checkChanges` first, before asking the provider
 * for names.
 */
export function planGrantChanges(
	connector: Connector,
	current: readonly EditableRow[],
	changes: readonly GrantChange[],
	names: ReadonlyMap<string, string>,
): GrantPlan {
	const state: GrantState = new Map();
	const stored = new Map<string, string>();
	for (const grant of current) {
		const key = resourceKey(grant.kind, grant.resourceId);
		const entry = state.get(key) ?? { kind: grant.kind, id: grant.resourceId, actions: new Set<string>(), ask: new Set<string>() };
		for (const action of grant.actions) entry.actions.add(action);
		switch (grant.effect) {
			case "ask":
				for (const action of grant.actions) entry.ask.add(action);
				break;
			case "allow":
				break;
		}
		state.set(key, entry);
		if (grant.resourceName && !stored.has(key)) stored.set(key, grant.resourceName);
	}
	const existing = new Set(state.keys());
	for (const change of changes) {
		state.set(resourceKey(change.kind, change.id), { kind: change.kind, id: change.id, actions: new Set(change.actions), ask: new Set(change.ask) });
	}
	checkState(connector, state, new Map([...stored, ...names]), new Set(changes.map((change) => change.kind)));
	const plan: GrantPlan = { upserts: [], deletes: [], state: new Map() };
	for (const change of changes) {
		const key = resourceKey(change.kind, change.id);
		if (change.actions.length === 0) {
			if (existing.has(key)) plan.deletes.push({ kind: change.kind, resourceId: change.id });
			continue;
		}
		const resourceName = names.get(key) ?? stored.get(key) ?? "";
		plan.upserts.push({ kind: change.kind, resourceId: change.id, actions: [...new Set(change.actions)].sort(), ask: [...new Set(change.ask)].sort(), resourceName });
	}
	for (const [key, entry] of state) if (entry.actions.size > 0) plan.state.set(key, entry);
	return plan;
}
