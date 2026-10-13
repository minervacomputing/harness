// Pure permission evaluation. No storage, so it
// is cheap to test exhaustively. The Workspace Durable Object builds a run's policy at start (grants.ts)
// and offers tools with `permitsAny` (tools.ts); the executor checks every call with `permits`.

import type { ConnectionId } from "../contracts/common.ts";
import type { Any, GrantKey, LayerSnapshot, PolicySnapshot, Resource } from "../contracts/policy.ts";
import { compareText } from "../lib/arrays.ts";

/** A grant on every resource of a kind, including ones created later. Never a real resource id. */
export const ANY: Any = "*";

/** Stands for every resource id no layer mentions; it matches only wildcard grants. */
const UNMENTIONED: unique symbol = Symbol("unmentioned");
type Id = string | typeof UNMENTIONED;

/** The action an action requires on the same resource, if any. */
export type RequiresOf = (action: string) => string | null | undefined;

export type LayerName = LayerSnapshot["name"];

/** One grant row as `Layer.build` reads it: its actions become one key each. */
export interface GrantInput {
	connectionId: ConnectionId;
	kind: string;
	resourceId: string;
	actions: readonly string[];
	effect: "allow" | "deny";
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

/** Immutable: the instance and its keys are frozen, the sets private. */
export class Layer {
	readonly name: LayerName;
	readonly restricted: boolean;
	/** Sorted and unique, as the snapshot writes them. */
	readonly allows: readonly GrantKey[];
	readonly denies: readonly GrantKey[];
	readonly #allows: ReadonlySet<string>;
	readonly #denies: ReadonlySet<string>;

	constructor(name: LayerName, restricted: boolean, allows: Iterable<GrantKey>, denies: Iterable<GrantKey>) {
		this.name = name;
		this.restricted = restricted;
		this.allows = canonical(allows);
		this.denies = canonical(denies);
		this.#allows = new Set(this.allows.map((key) => encode(...key)));
		this.#denies = new Set(this.denies.map((key) => encode(...key)));
		Object.freeze(this);
	}

	static build(name: LayerName, restricted: boolean, grants: Iterable<GrantInput>): Layer {
		const allows: GrantKey[] = [];
		const denies: GrantKey[] = [];
		for (const grant of grants) {
			const target = grant.effect === "deny" ? denies : allows;
			for (const action of grant.actions) target.push([grant.connectionId, grant.kind, grant.resourceId, action]);
		}
		return new Layer(name, restricted, allows, denies);
	}

	#matches(keys: ReadonlySet<string>, connectionId: string, kind: string, ids: readonly Id[], action: string): boolean {
		if (keys.has(encode(connectionId, kind, ANY, action))) return true;
		return ids.some((item) => item !== UNMENTIONED && keys.has(encode(connectionId, kind, item, action)));
	}

	blocks(connectionId: string, kind: string, ids: readonly Id[], action: string, partial = false): boolean {
		if (partial && this.denies.some((key) => key[0] === connectionId && key[1] === kind && key[3] === action)) return true;
		return this.#matches(this.#denies, connectionId, kind, ids, action);
	}

	passes(connectionId: string, kind: string, ids: readonly Id[], action: string): boolean {
		return !this.restricted || this.#matches(this.#allows, connectionId, kind, ids, action);
	}
}

/** The action, then what it requires, and so on, stopping at a repeat. */
function chain(action: string, requiresOf: RequiresOf): string[] {
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

function isLayerSnapshot(item: unknown): item is LayerSnapshot {
	if (typeof item !== "object" || item === null) return false;
	const layer = item as { [key: string]: unknown };
	return LAYER_NAMES.has(layer.name) && typeof layer.restricted === "boolean" && isGrantKeys(layer.allows) && isGrantKeys(layer.denies);
}

/** The intersection of layers. Lower layers can only narrow what higher layers allow. Frozen, as a Layer. */
export class Policy {
	readonly layers: readonly Layer[];

	constructor(layers: readonly Layer[]) {
		this.layers = Object.freeze([...layers]);
		Object.freeze(this);
	}

	#permits(connectionId: string, kind: string, ids: readonly Id[], action: string, partial = false): boolean {
		if (this.layers.some((layer) => layer.blocks(connectionId, kind, ids, action, partial))) return false;
		return this.layers.every((layer) => layer.passes(connectionId, kind, ids, action));
	}

	/**
	 * The action and every action it requires, on this one resource. Requirements are checked here rather
	 * than only when grants are saved, because layers can combine into a policy that allows an action
	 * without its requirement.
	 */
	permits(resource: Resource, action: string, requiresOf: RequiresOf = noRequirements): boolean {
		const ids = idsOf(resource);
		if (ids.includes(ANY)) throw new Error("The wildcard selects grants; it is not a resource.");
		return chain(action, requiresOf).every((item) => this.#permits(resource.connectionId, resource.kind, ids, item, resource.partial));
	}

	/**
	 * Whether some resource of this kind could pass `permits`. Exact for flat kinds.
	 *
	 * Resources no layer mentions all behave alike, so one symbolic candidate stands for them. For kinds
	 * that nest, one more candidate sits inside every mentioned resource that nothing denies. Any resource
	 * that passes has only such ancestors, and more of them can only add allows, so this candidate passes
	 * whenever some real one does. It may also pass when no real resource does (the ancestors need not
	 * nest), so it may only open reads whose results are then checked one by one.
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
		return candidates.some((ids) => actions.every((item) => this.#permits(connectionId, kind, ids, item)));
	}

	/** The run snapshot's form: each layer's keys sorted. */
	toJson(): PolicySnapshot {
		return this.layers.map((layer) => ({
			name: layer.name,
			restricted: layer.restricted,
			allows: layer.allows.map((key): GrantKey => [...key]),
			denies: layer.denies.map((key): GrantKey => [...key]),
		}));
	}

	/**
	 * Throws on data not of `toJson`'s shape, a missing key included, so a snapshot
	 * read back from storage fails closed: a layer without `restricted` never passes everything.
	 */
	static fromJson(data: PolicySnapshot): Policy {
		if (!Array.isArray(data)) throw new TypeError("Not a policy snapshot: it is a list of layers.");
		return new Policy(
			data.map((item) => {
				if (!isLayerSnapshot(item)) {
					throw new TypeError("Not a policy snapshot: each layer has a known name, restricted, and allows and denies of four strings each.");
				}
				return new Layer(item.name, item.restricted, item.allows, item.denies);
			}),
		);
	}
}

export const DENY_ALL = new Policy([new Layer("deny-all", true, [], [])]);
