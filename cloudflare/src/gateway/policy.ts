// The permission model's data and its pure evaluation. No storage, so it
// is cheap to test exhaustively. A run's start builds its policy (grants.ts) and offers tools with
// `permitsAny` (tools.ts); the executor decides every call with `effect`, and shows a record only where `permits` holds.

import { compareText } from "../lib/arrays.ts";
import type { ConnectionId } from "../shared/rpc.ts";

/** Selects every resource of a kind, including later ones. Never a real resource id. */
export type Any = "*";

/** `(connection id, resource kind, resource id, action)`. */
export type GrantKey = [connection: ConnectionId, kind: string, resource: string, action: string];

/** A layer as a run snapshots it: lists sorted, round-trip stable. */
export interface LayerSnapshot {
	name: "ceiling" | "user" | "agent" | "deny-all";
	/** An unrestricted layer passes everything its denies do not block. */
	restricted: boolean;
	allows: GrantKey[];
	denies: GrantKey[];
	/** What needs the user's approval of each call. A snapshot stored before asks existed has none. */
	asks: GrantKey[];
}

/**
 * The effective policy: ceiling ∩ user ∩ agent, the worst effect wins (deny over ask over allow), in that order
 * (`["ceiling", "user", "agent"]` is pinned by a test). Only enforceable rows are kept: denies always, allows only
 * for a declared kind and not `*` unless the kind is wildcard; an ask row asks always and allows only where an allow
 * row would, and denies what it cannot ask before (grants.ts).
 */
export type PolicySnapshot = LayerSnapshot[];

/**
 * A resource as a connector names it. `within` lists ancestors nearest first, for
 * hierarchical kinds only; `partial` says ancestors beyond them may exist, so any exact deny for the
 * action blocks and unknown ancestors never help an allow. At most 64 ancestors, no `*`, no duplicates.
 */
export interface Resource {
	connectionId: ConnectionId;
	kind: string;
	id: string;
	within: string[];
	partial: boolean;
	/** Its tenant, for a connector with a tenant per resource (connector.ts `Tenancy`); grants do not read it. */
	tenant?: string;
}

/** A grant on every resource of a kind, including ones created later. Never a real resource id. */
export const ANY: Any = "*";

/** Stands for every resource id no layer mentions; it matches only wildcard grants. */
const UNMENTIONED: unique symbol = Symbol("unmentioned");
type Id = string | typeof UNMENTIONED;

/** The action an action requires on the same resource, if any. */
export type RequiresOf = (action: string) => string | null | undefined;

export type LayerName = LayerSnapshot["name"];

/** What a layer, a grant row or the policy says of an action on a resource. */
export type Effect = "deny" | "ask" | "allow";

/** The policy's answer for one call's need. An ask names every layer that asked, in layer order. */
export type Decision = { effect: "deny" } | { effect: "ask"; layers: LayerName[] } | { effect: "allow" };

/** One grant row as `Layer.build` reads it: its actions become one key each. */
export interface GrantInput {
	connectionId: ConnectionId;
	kind: string;
	resourceId: string;
	actions: readonly string[];
	effect: Effect;
}

/** A layer's keys by effect. */
export interface LayerKeys {
	allows: Iterable<GrantKey>;
	asks: Iterable<GrantKey>;
	denies: Iterable<GrantKey>;
}

/**
 * A resource on a connection. For kinds that nest (folders), `within` holds the ids of the enclosing
 * resources, nearest first: a grant on any of them applies to this resource too, and a deny on any of
 * them wins. `partial`: there may be ancestors beyond `within` the connector could not see. They could
 * carry a deny, so any exact deny for the action blocks, and they never help an allow.
 */
export function resource(connectionId: ConnectionId, kind: string, id: string, within: readonly string[] = [], partial = false): Resource {
	return { connectionId, kind, id, within: [...within], partial };
}

function idsOf(resource: Resource): string[] {
	return [resource.id, ...resource.within];
}

function encode(connectionId: string, kind: string, id: string, action: string): string {
	return JSON.stringify([connectionId, kind, id, action]);
}

/** Lists of strings in order: element by element (UTF-16 order), a prefix first. */
export function compareLists(a: readonly string[], b: readonly string[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const order = compareText(a[i] as string, b[i] as string);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}

/** Unique keys in the order `toJson` writes them, frozen, so they cannot drift from the sets. */
function canonical(keys: Iterable<GrantKey>): readonly GrantKey[] {
	const unique = new Map<string, GrantKey>();
	for (const key of keys) unique.set(encode(...key), Object.freeze([key[0], key[1], key[2], key[3]]) as GrantKey);
	return Object.freeze([...unique.values()].sort(compareLists));
}

/** Whether `keys` hold one for the action on any resource of the kind but `*`. */
function holdsExact(keys: readonly GrantKey[], connectionId: string, kind: string, action: string): boolean {
	return keys.some((key) => key[0] === connectionId && key[1] === kind && key[2] !== ANY && key[3] === action);
}

/** Immutable: the instance and its keys are frozen, the sets private. */
export class Layer {
	readonly name: LayerName;
	readonly restricted: boolean;
	/** Sorted and unique, as the snapshot writes them. */
	readonly allows: readonly GrantKey[];
	readonly asks: readonly GrantKey[];
	readonly denies: readonly GrantKey[];
	readonly #allows: ReadonlySet<string>;
	readonly #asks: ReadonlySet<string>;
	readonly #denies: ReadonlySet<string>;

	constructor(name: LayerName, restricted: boolean, keys: LayerKeys) {
		this.name = name;
		this.restricted = restricted;
		this.allows = canonical(keys.allows);
		this.asks = canonical(keys.asks);
		this.denies = canonical(keys.denies);
		this.#allows = new Set(this.allows.map((key) => encode(...key)));
		this.#asks = new Set(this.asks.map((key) => encode(...key)));
		this.#denies = new Set(this.denies.map((key) => encode(...key)));
		Object.freeze(this);
	}

	static build(name: LayerName, restricted: boolean, grants: Iterable<GrantInput>): Layer {
		const keys = { allows: [] as GrantKey[], asks: [] as GrantKey[], denies: [] as GrantKey[] };
		for (const grant of grants) {
			let target: GrantKey[];
			switch (grant.effect) {
				case "deny":
					target = keys.denies;
					break;
				case "ask":
					target = keys.asks;
					break;
				case "allow":
					target = keys.allows;
					break;
			}
			for (const action of grant.actions) target.push([grant.connectionId, grant.kind, grant.resourceId, action]);
		}
		return new Layer(name, restricted, keys);
	}

	#matches(keys: ReadonlySet<string>, connectionId: string, kind: string, ids: readonly Id[], action: string): boolean {
		if (keys.has(encode(connectionId, kind, ANY, action))) return true;
		return ids.some((item) => item !== UNMENTIONED && keys.has(encode(connectionId, kind, item, action)));
	}

	/**
	 * This layer's effect on one action. Deny when a deny matches, or with `partial` any exact deny for the action. Else,
	 * when the layer passes (it is unrestricted, or an allow matches), the nearest of its asks and allows decides: the
	 * resource, its ancestors nearest first, then `*`, an ask before an allow at each; unrestricted with none, allow. A
	 * restricted layer no allow matches denies, so an ask alone never lets one pass.
	 */
	effect(connectionId: string, kind: string, ids: readonly Id[], action: string, partial: boolean): Effect {
		if (partial && holdsExact(this.denies, connectionId, kind, action)) return "deny";
		if (this.#matches(this.#denies, connectionId, kind, ids, action)) return "deny";
		if (this.restricted && !this.#matches(this.#allows, connectionId, kind, ids, action)) return "deny";
		for (const item of ids) {
			if (item === UNMENTIONED) continue;
			if (this.#asks.has(encode(connectionId, kind, item, action))) return "ask";
			if (this.#allows.has(encode(connectionId, kind, item, action))) return "allow";
		}
		// What decides now is `*` or the unrestricted default, which reach the unknown ancestors too, and one of them
		// could be where an exact ask sits.
		if (partial && holdsExact(this.asks, connectionId, kind, action)) return "ask";
		if (this.#asks.has(encode(connectionId, kind, ANY, action))) return "ask";
		return "allow";
	}
}

/** The action, then what it requires, and so on, stopping at a repeat. */
export function chain(action: string, requiresOf: RequiresOf): string[] {
	const items: string[] = [];
	let current: string | null | undefined = action;
	while (current !== null && current !== undefined && !items.includes(current)) {
		items.push(current);
		current = requiresOf(current);
	}
	return items;
}

const noRequirements: RequiresOf = () => null;

const LAYER_NAMES: ReadonlySet<unknown> = new Set(["ceiling", "user", "agent", "deny-all"] satisfies LayerName[]);

function isGrantKeys(value: unknown): value is GrantKey[] {
	return Array.isArray(value) && value.every((key) => Array.isArray(key) && key.length === 4 && key.every((part) => typeof part === "string"));
}

function isLayerSnapshot(item: unknown): item is Omit<LayerSnapshot, "asks"> & { asks?: GrantKey[] } {
	if (typeof item !== "object" || item === null) return false;
	const layer = item as { [key: string]: unknown };
	return (
		LAYER_NAMES.has(layer.name) &&
		typeof layer.restricted === "boolean" &&
		isGrantKeys(layer.allows) &&
		isGrantKeys(layer.denies) &&
		(layer.asks === undefined || isGrantKeys(layer.asks))
	);
}

const DENY: Decision = Object.freeze({ effect: "deny" });
const ALLOW: Decision = Object.freeze({ effect: "allow" });

/** The intersection of layers. Lower layers can only narrow what higher layers allow. Frozen, as a Layer. */
export class Policy {
	readonly layers: readonly Layer[];

	constructor(layers: readonly Layer[]) {
		this.layers = Object.freeze([...layers]);
		Object.freeze(this);
	}

	/** The worst effect of every layer on every one of `actions`, with the layers that asked. */
	#decide(connectionId: string, kind: string, ids: readonly Id[], actions: readonly string[], partial: boolean): Decision {
		const asked = new Set<LayerName>();
		for (const action of actions) {
			for (const layer of this.layers) {
				const effect = layer.effect(connectionId, kind, ids, action, partial);
				switch (effect) {
					case "deny":
						return DENY;
					case "ask":
						asked.add(layer.name);
						break;
					case "allow":
						break;
				}
			}
		}
		if (asked.size === 0) return ALLOW;
		return { effect: "ask", layers: [...new Set(this.layers.map((layer) => layer.name))].filter((name) => asked.has(name)) };
	}

	/**
	 * The action and every action it requires, on this one resource. Requirements are checked here rather
	 * than only when grants are saved, because layers can combine into a policy that allows an action
	 * without its requirement.
	 */
	effect(resource: Resource, action: string, requiresOf: RequiresOf = noRequirements): Decision {
		const ids = idsOf(resource);
		if (ids.includes(ANY)) throw new Error("The wildcard selects grants; it is not a resource.");
		return this.#decide(resource.connectionId, resource.kind, ids, chain(action, requiresOf), resource.partial);
	}

	/** Whether `effect` allows the call, with the user's approval or without. */
	permits(resource: Resource, action: string, requiresOf: RequiresOf = noRequirements): boolean {
		return this.effect(resource, action, requiresOf).effect !== "deny";
	}

	/**
	 * Whether some resource of this kind could pass `permits`, so an ask counts as an allow. Exact for flat kinds.
	 *
	 * Resources no layer mentions all behave alike, so one symbolic candidate stands for them. For kinds
	 * that nest, one more candidate sits inside every mentioned resource that nothing denies. Any resource
	 * that passes has only such ancestors, and more of them can only add allows, so this candidate passes
	 * whenever some real one does. It may also pass when no real resource does (the ancestors need not
	 * nest), so it may only open reads whose results are then checked one by one. Asks never decide whether a
	 * resource is denied, so the candidates ignore them.
	 */
	permitsAny(connectionId: string, kind: string, action: string, requiresOf: RequiresOf = noRequirements, hierarchical = false): boolean {
		const mentioned = new Set<string>();
		for (const layer of this.layers) {
			for (const key of [...layer.allows, ...layer.denies]) {
				if (key[0] === connectionId && key[1] === kind && key[2] !== ANY) mentioned.add(key[2]);
			}
		}
		const actions = chain(action, requiresOf);
		const candidates: Id[][] = [...[...mentioned].map((item) => [item]), [UNMENTIONED]];
		if (hierarchical) {
			const denied = new Set<string>();
			for (const layer of this.layers) {
				for (const key of layer.denies) {
					if (key[0] === connectionId && key[1] === kind && actions.includes(key[3])) denied.add(key[2]);
				}
			}
			candidates.push([UNMENTIONED, ...[...mentioned].filter((item) => !denied.has(item)).sort()]);
		}
		return candidates.some((ids) => this.#decide(connectionId, kind, ids, actions, false).effect !== "deny");
	}

	/** The run snapshot's form: each layer's keys sorted. */
	toJson(): PolicySnapshot {
		return this.layers.map((layer) => ({
			name: layer.name,
			restricted: layer.restricted,
			allows: layer.allows.map((key): GrantKey => [...key]),
			denies: layer.denies.map((key): GrantKey => [...key]),
			asks: layer.asks.map((key): GrantKey => [...key]),
		}));
	}

	/**
	 * Throws on data not of `toJson`'s shape, a missing key included, so a snapshot
	 * read back from storage fails closed: a layer without `restricted` never passes everything. Only `asks` may be
	 * missing, as in a snapshot stored before asks existed, and reads as none.
	 */
	static fromJson(data: PolicySnapshot): Policy {
		if (!Array.isArray(data)) throw new TypeError("Not a policy snapshot: it is a list of layers.");
		return new Policy(
			data.map((item) => {
				if (!isLayerSnapshot(item)) {
					throw new TypeError("Not a policy snapshot: each layer has a known name, restricted, and allows, denies and any asks of four strings each.");
				}
				return new Layer(item.name, item.restricted, { allows: item.allows, asks: item.asks ?? [], denies: item.denies });
			}),
		);
	}
}

export const DENY_ALL = new Policy([Layer.build("deny-all", true, [])]);
