// Permission evaluation: layers, grants, wildcards, denies and asks, and the policy snapshot.

import { describe, expect, test } from "vitest";
import { ANY, DENY_ALL, type Decision, Layer, type LayerName, Policy, type Resource, resource } from "../../src/gateway/policy.ts";
import { parseJson } from "../../src/lib/json.ts";

const WORK = resource("c1", "project", "work");
const PRIVATE = resource("c1", "project", "private");
// The one refusal.
const WILDCARD_REFUSED = new Error("The wildcard selects grants; it is not a resource.");

type Grants = [id: string, actions: string[]][];

/** A layer's keys as given, an ask's allow keys included only where a test lists them. */
function layer(name: LayerName, restricted: boolean, allows: Grants = [], denies: Grants = [], asks: Grants = []): Layer {
	return Layer.build(name, restricted, [
		...allows.map(([resourceId, actions]) => ({ connectionId: "c1", kind: "project", resourceId, actions, effect: "allow" as const })),
		...denies.map(([resourceId, actions]) => ({ connectionId: "c1", kind: "project", resourceId, actions, effect: "deny" as const })),
		...asks.map(([resourceId, actions]) => ({ connectionId: "c1", kind: "project", resourceId, actions, effect: "ask" as const })),
	]);
}

test("lower layers only narrow", () => {
	const ceiling = layer("ceiling", true, [["work", ["read", "create"]]]);
	const user = layer("user", true, [
		["work", ["read"]],
		["private", ["read"]],
	]);
	const policy = new Policy([ceiling, user, layer("agent", false)]);
	expect(policy.permits(WORK, "read")).toBe(true);
	expect(policy.permits(WORK, "create"), "the user layer did not allow create").toBe(false);
	expect(policy.permits(PRIVATE, "read"), "the ceiling did not allow private").toBe(false);
});

test("unrestricted layers pass through but denies win", () => {
	const policy = new Policy([layer("ceiling", false, [], [["work", ["create"]]]), layer("user", true, [["work", ["read", "create"]]])]);
	expect(policy.permits(WORK, "read")).toBe(true);
	expect(policy.permits(WORK, "create")).toBe(false);
});

test("exact resource matching", () => {
	const policy = new Policy([layer("user", true, [["work", ["read"]]])]);
	expect(policy.permits(resource("c2", "project", "work"), "read"), "other connection").toBe(false);
	expect(policy.permits(resource("c1", "section", "work"), "read"), "other kind").toBe(false);
});

test("JSON round trip", () => {
	const policy = new Policy([layer("ceiling", false, [], [["private", ["read"]]]), layer("user", true, [["work", ["read"]]])]);
	const restored = Policy.fromJson(policy.toJson());
	expect(restored).toEqual(policy);
	expect(restored.toJson()).toEqual(policy.toJson());
	expect(DENY_ALL.permits(WORK, "read")).toBe(false);
});

test("the snapshot lists keys sorted and once, and survives structured cloning", () => {
	// Escapes, not the characters: U+E000 is invisible in most editors.
	const [privateUse, emoji] = ["\u{e000}", "\u{1f600}"];
	const policy = new Policy([
		Layer.build("user", true, [
			{ connectionId: "c1", kind: "project", resourceId: emoji, actions: ["read"], effect: "allow" },
			{ connectionId: "c1", kind: "project", resourceId: privateUse, actions: ["read", "read"], effect: "allow" },
			{ connectionId: "c1", kind: "project", resourceId: emoji, actions: ["read"], effect: "deny" },
			{ connectionId: "c1", kind: "project", resourceId: privateUse, actions: ["read"], effect: "deny" },
		]),
	]);
	const json = policy.toJson();
	// UTF-16 order, as `<` compares strings: the emoji's high surrogate (U+D83D) sorts before U+E000.
	const sorted = [
		["c1", "project", emoji, "read"],
		["c1", "project", privateUse, "read"],
	];
	expect(json).toEqual([{ name: "user", restricted: true, allows: sorted, denies: sorted, asks: [] }]);
	expect(Policy.fromJson(structuredClone(json)).toJson()).toEqual(json);
});

test("a snapshot not of toJson's shape is refused, never read as unrestricted", () => {
	// A missing key is refused: a layer without restricted must not pass everything.
	const valid = { name: "user", restricted: true, allows: [], denies: [] };
	const broken: unknown[] = [
		{ name: "user", allows: [], denies: [] },
		{ ...valid, restricted: "false" },
		{ ...valid, name: "admin" },
		{ ...valid, allows: undefined },
		{ ...valid, denies: [["c1", "project", "work"]] },
		{ ...valid, allows: [["c1", "project", "work", 1]] },
		{ ...valid, asks: null },
		{ ...valid, asks: [["c1", "project", "work"]] },
		null,
	];
	for (const item of broken) expect(() => Policy.fromJson([item] as never), JSON.stringify(item)).toThrow(TypeError);
	expect(() => Policy.fromJson({} as never)).toThrow("Not a policy snapshot: it is a list of layers.");
	expect(() => Policy.fromJson(parseJson('[{"name":"user","allows":[],"denies":[]}]') as never)).toThrow(
		"Not a policy snapshot: each layer has a known name, restricted, and allows, denies and any asks of four strings each.",
	);
	expect(Policy.fromJson([valid] as never).permits(WORK, "read")).toBe(false);
});

test("a layer cannot change once built", () => {
	const guarded = layer("user", true, [[ANY, ["read"]]], [["hidden", ["read"]]]);
	const policy = new Policy([guarded]);
	const unknown = resource("c1", "project", "r", [], true);
	expect(policy.permits(unknown, "read")).toBe(false);
	expect(() => {
		(guarded.denies[0] as string[])[3] = "create";
	}).toThrow(TypeError);
	expect(() => (guarded.denies as unknown as string[][]).splice(0)).toThrow(TypeError);
	expect(() => (policy.layers as Layer[]).pop()).toThrow(TypeError);
	// The instances too: restricted, the keys the snapshot shows and the layers cannot be replaced.
	const writable = (target: object) => target as { [key: string]: unknown };
	expect(() => {
		writable(guarded).restricted = false;
	}).toThrow(TypeError);
	expect(() => {
		writable(guarded).denies = [];
	}).toThrow(TypeError);
	expect(() => {
		writable(policy).layers = [];
	}).toThrow(TypeError);
	expect(policy.permits(unknown, "read")).toBe(false);
	expect(policy.toJson()[0]?.denies).toEqual([["c1", "project", "hidden", "read"]]);
	// The snapshot is a copy the caller may change.
	const json = policy.toJson();
	json[0]?.denies.splice(0);
	expect(policy.toJson()[0]?.denies).toHaveLength(1);
});

const REQUIRES = (action: string) => (action === "create" ? "read" : null);
const NEW = resource("c1", "project", "created-later");

test("a wildcard allows every resource including new ones", () => {
	const policy = new Policy([layer("user", true, [[ANY, ["read"]]])]);
	expect(policy.permits(WORK, "read")).toBe(true);
	expect(policy.permits(NEW, "read")).toBe(true);
	expect(policy.permits(WORK, "create")).toBe(false);
	expect(policy.permits(resource("c2", "project", "work"), "read"), "wildcards stay on their connection").toBe(false);
	expect(policy.permits(resource("c1", "section", "work"), "read"), "and on their kind").toBe(false);
});

test("the wildcard is not a resource", () => {
	expect(() => new Policy([layer("user", false)]).permits(resource("c1", "project", ANY), "read")).toThrow(WILDCARD_REFUSED);
});

test("denies win over wildcards, and wildcard denies win over everything", () => {
	const exactDeny = new Policy([layer("user", true, [[ANY, ["read"]]], [["private", ["read"]]])]);
	expect(exactDeny.permits(WORK, "read")).toBe(true);
	expect(exactDeny.permits(PRIVATE, "read")).toBe(false);
	const wildcardDeny = new Policy([layer("ceiling", false, [], [[ANY, ["create"]]]), layer("user", true, [["work", ["read", "create"]]])]);
	expect(wildcardDeny.permits(WORK, "create")).toBe(false);
	expect(wildcardDeny.permits(WORK, "read")).toBe(true);
});

test("requirements are checked on the same resource", () => {
	const policy = new Policy([
		layer("ceiling", false, [], [["work", ["read"]]]),
		layer("user", true, [
			["work", ["read", "create"]],
			["private", ["read"]],
		]),
	]);
	expect(policy.permits(WORK, "create"), "without requirements only the action itself counts").toBe(true);
	expect(policy.permits(WORK, "create", REQUIRES)).toBe(false);
	expect(policy.permits(PRIVATE, "read", REQUIRES)).toBe(true);
	expect(policy.permits(PRIVATE, "create", REQUIRES)).toBe(false);
});

describe("permitsAny matches some concrete resource", () => {
	const cases: [string, Layer[], string, boolean][] = [
		["nothing allowed", [layer("user", true)], "read", false],
		["an exact allow", [layer("user", true, [["work", ["read"]]])], "read", true],
		["a wildcard allow", [layer("user", true, [[ANY, ["read"]]])], "read", true],
		["unrestricted", [layer("user", false)], "read", true],
		["a wildcard deny", [layer("user", false, [], [[ANY, ["read"]]])], "read", false],
		// A deny on one resource leaves every other resource.
		["a deny on one resource", [layer("user", false, [], [["work", ["read"]]])], "read", true],
		["a wildcard allow and one deny", [layer("user", true, [[ANY, ["read"]]], [["work", ["read"]]])], "read", true],
		// create needs read on the same resource; allowing them on different resources is not enough.
		[
			"create and read on different resources",
			[
				layer("user", true, [
					["work", ["create"]],
					["private", ["read"]],
				]),
			],
			"create",
			false,
		],
		[
			"create on one, read on all",
			[
				layer("user", true, [
					["work", ["create"]],
					[ANY, ["read"]],
				]),
			],
			"create",
			true,
		],
		["create and read on all, read denied on one", [layer("user", true, [[ANY, ["create", "read"]]], [["work", ["read"]]])], "create", true],
		["the ceiling's exact allow under the user's wildcard", [layer("ceiling", true, [["work", ["read", "create"]]]), layer("user", true, [[ANY, ["read", "create"]]])], "create", true],
		["allows on different resources in two layers", [layer("ceiling", true, [["work", ["read"]]]), layer("user", true, [["private", ["read"]]])], "read", false],
	];

	test.each(cases)("%s", (_, layers, action, expected) => {
		const policy = new Policy(layers);
		expect(policy.permitsAny("c1", "project", action, REQUIRES)).toBe(expected);
		// permitsAny must agree with checking every resource that could matter.
		expect([WORK, PRIVATE, NEW].some((r) => policy.permits(r, action, REQUIRES))).toBe(expected);
	});
});

// Folders: "docs" holds "drafts", which holds the file "essay".
const ESSAY = resource("c1", "project", "essay", ["drafts", "docs"]);

test("a grant on a folder covers what is inside it", () => {
	const policy = new Policy([layer("user", true, [["docs", ["read"]]])]);
	expect(policy.permits(ESSAY, "read")).toBe(true);
	expect(policy.permits(resource("c1", "project", "drafts", ["docs"]), "read")).toBe(true);
	expect(policy.permits(resource("c1", "project", "docs"), "create")).toBe(false);
	expect(policy.permits(resource("c1", "project", "notes", ["home"]), "read")).toBe(false);
});

test("a deny on any enclosing folder wins", () => {
	const policy = new Policy([
		layer("ceiling", false, [], [["drafts", ["read"]]]),
		layer("user", true, [
			[ANY, ["read"]],
			["essay", ["read"]],
		]),
	]);
	expect(policy.permits(ESSAY, "read")).toBe(false);
	expect(policy.permits(resource("c1", "project", "essay", ["docs"]), "read")).toBe(true);
});

test("partial ancestry never helps and fears every exact deny", () => {
	// The unknown ancestors could be "docs", so an allow on it does not count.
	const unknown = resource("c1", "project", "essay", ["drafts"], true);
	expect(new Policy([layer("user", true, [["docs", ["read"]]])]).permits(unknown, "read")).toBe(false);
	// Under a wildcard it is readable, until any exact deny exists: that deny could be on an unknown ancestor.
	expect(new Policy([layer("user", true, [[ANY, ["read"]]])]).permits(unknown, "read")).toBe(true);
	const guarded = new Policy([layer("user", true, [[ANY, ["read"]]], [["elsewhere", ["read"]]])]);
	expect(guarded.permits(unknown, "read")).toBe(false);
	expect(guarded.permits(ESSAY, "read"), "complete ancestry is judged by its own ids").toBe(true);
	// Denies for other actions are irrelevant, but a deny on a required action counts.
	const createDenied = new Policy([layer("user", true, [[ANY, ["read", "create"]]], [["elsewhere", ["create"]]])]);
	expect(createDenied.permits(unknown, "read")).toBe(true);
	const readDenied = new Policy([layer("user", true, [[ANY, ["read", "create"]]], [["elsewhere", ["read"]]])]);
	expect(readDenied.permits(unknown, "create", REQUIRES)).toBe(false);
});

test("the wildcard is never an ancestor", () => {
	expect(() => new Policy([layer("user", false)]).permits(resource("c1", "project", "essay", [ANY]), "read")).toThrow(WILDCARD_REFUSED);
});

test("permitsAny sees allows on nested folders across layers", () => {
	const policy = new Policy([layer("ceiling", true, [["docs", ["read"]]]), layer("user", true, [["drafts", ["read"]]])]);
	expect(policy.permitsAny("c1", "project", "read"), "flat resources cannot pass both layers").toBe(false);
	expect(policy.permitsAny("c1", "project", "read", undefined, true)).toBe(true);
	expect(policy.permits(ESSAY, "read")).toBe(true);
	const denied = new Policy([...policy.layers, layer("agent", false, [], [["docs", ["read"]]])]);
	expect(denied.permitsAny("c1", "project", "read", undefined, true)).toBe(false);
});

/** A seeded PRNG (mulberry32): the property must hold for any layers, so any seeded stream tests it. */
function seeded(seed: number) {
	let state = seed >>> 0;
	const random = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
	const randint = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
	const choice = <T>(items: readonly T[]) => items[randint(0, items.length - 1)] as T;
	const sample = <T>(items: readonly T[], count: number) => {
		const pool = [...items];
		const picked: T[] = [];
		for (let i = 0; i < count; i++) picked.push(...pool.splice(randint(0, pool.length - 1), 1));
		return picked;
	};
	return { random, randint, choice, sample };
}

test("hierarchical permitsAny is exact over every placement", () => {
	// For any layers, permitsAny says yes exactly when some resource, inside any set of mentioned folders,
	// passes. Real trees allow fewer placements, so it may say yes where none does.
	const rng = seeded(7);
	const ids = ["a", "b", "c"];
	const choices = [...ids, ANY];
	for (let trial = 0; trial < 400; trial++) {
		const layers: Layer[] = [];
		for (const name of ["ceiling", "user", "agent"] as const) {
			const allows: Grants = Array.from({ length: rng.randint(0, 2) }, () => [rng.choice(choices), rng.sample(["read", "create"], rng.randint(1, 2))]);
			const denies: Grants = Array.from({ length: rng.randint(0, 1) }, () => [rng.choice(choices), rng.sample(["read", "create"], 1)]);
			const asks: Grants = Array.from({ length: rng.randint(0, 2) }, () => [rng.choice(choices), rng.sample(["read", "create"], rng.randint(1, 2))]);
			layers.push(layer(name, rng.random() < 0.7, allows, denies, asks));
		}
		const policy = new Policy(layers);
		for (const action of ["read", "create"]) {
			const placements: Resource[] = [];
			for (const id of [...ids, "new"]) {
				for (let mask = 0; mask < 8; mask++) {
					placements.push(resource("c1", "project", id, ids.filter((w) => w !== id && (mask >> ids.indexOf(w)) & 1)));
				}
			}
			const some = placements.some((r) => policy.permits(r, action, REQUIRES));
			expect(policy.permitsAny("c1", "project", action, REQUIRES, true), `trial ${trial}, ${action}`).toBe(some);
		}
	}
});

const ALLOW: Decision = { effect: "allow" };
const DENY: Decision = { effect: "deny" };
const asked = (...layers: LayerName[]): Decision => ({ effect: "ask", layers });

describe("asks", () => {
	test("each effect, and permits holds under an ask", () => {
		// An ask row a connector can enforce compiles to its ask and its allow (grants.ts).
		const policy = new Policy([layer("user", true, [["work", ["read", "create"]], ["private", ["read"]]], [], [["work", ["create"]]])]);
		expect(policy.effect(WORK, "read")).toEqual(ALLOW);
		expect(policy.effect(WORK, "create")).toEqual(asked("user"));
		expect(policy.effect(PRIVATE, "create")).toEqual(DENY);
		expect([policy.permits(WORK, "read"), policy.permits(WORK, "create"), policy.permits(PRIVATE, "create")]).toEqual([true, true, false]);
	});

	test("an ask on a folder reaches what is inside it", () => {
		const policy = new Policy([layer("user", true, [[ANY, ["create"]]], [], [["docs", ["create"]]])]);
		expect(policy.effect(ESSAY, "create")).toEqual(asked("user"));
		expect(policy.effect(resource("c1", "project", "drafts", ["docs"]), "create")).toEqual(asked("user"));
		expect(policy.effect(resource("c1", "project", "notes", ["home"]), "create")).toEqual(ALLOW);
	});

	test("the nearest grant decides between an ask and an allow, an ask first at one resource", () => {
		const notes = resource("c1", "project", "notes", ["docs"]);
		const allowInsideAsk = new Policy([layer("user", true, [["essay", ["create"]], ["docs", ["create"]]], [], [["docs", ["create"]]])]);
		expect(allowInsideAsk.effect(ESSAY, "create"), "the allow on the file is nearer").toEqual(ALLOW);
		expect(allowInsideAsk.effect(notes, "create")).toEqual(asked("user"));
		const askInsideAllow = new Policy([layer("user", true, [["docs", ["create"]]], [], [["essay", ["create"]]])]);
		expect(askInsideAllow.effect(ESSAY, "create")).toEqual(asked("user"));
		expect(askInsideAllow.effect(notes, "create")).toEqual(ALLOW);
		const both = new Policy([layer("user", true, [["drafts", ["create"]]], [], [["drafts", ["create"]]])]);
		expect(both.effect(ESSAY, "create")).toEqual(asked("user"));
		const wildcardAsk = new Policy([layer("user", true, [[ANY, ["create"]], ["drafts", ["create"]]], [], [[ANY, ["create"]]])]);
		expect(wildcardAsk.effect(ESSAY, "create"), "drafts is nearer than every resource").toEqual(ALLOW);
		expect(wildcardAsk.effect(notes, "create")).toEqual(asked("user"));
		expect(wildcardAsk.effect(NEW, "create")).toEqual(asked("user"));
	});

	test("the worst wins across layers and the requirements: deny, then ask, then allow", () => {
		const user = layer("user", true, [[ANY, ["read", "create"]]]);
		expect(new Policy([layer("ceiling", false, [], [], [[ANY, ["create"]]]), user]).effect(WORK, "create"), "a ceiling's ask binds a user's allow").toEqual(asked("ceiling"));
		const askedAndDenied = new Policy([layer("ceiling", false, [], [["work", ["create"]]]), layer("user", true, [[ANY, ["read", "create"]]], [], [[ANY, ["create"]]])]);
		expect(askedAndDenied.effect(WORK, "create")).toEqual(DENY);
		expect(askedAndDenied.effect(PRIVATE, "create")).toEqual(asked("user"));
		const requirementDenied = new Policy([layer("ceiling", false, [], [["work", ["read"]]]), layer("user", true, [[ANY, ["read", "create"]]], [], [[ANY, ["create"]]])]);
		expect(requirementDenied.effect(WORK, "create", REQUIRES)).toEqual(DENY);
	});

	test("every layer that asked, once each, in layer order", () => {
		const policy = new Policy([
			layer("ceiling", false, [], [], [[ANY, ["read"]]]),
			layer("user", true, [[ANY, ["read", "create"]]], [], [[ANY, ["read", "create"]]]),
			layer("agent", false, [], [], [["work", ["create"]]]),
		]);
		// create is asked by the user and the agent, the read it requires by the ceiling and the user.
		expect(policy.effect(WORK, "create", REQUIRES)).toEqual(asked("ceiling", "user", "agent"));
		expect(policy.effect(PRIVATE, "create", REQUIRES)).toEqual(asked("ceiling", "user"));
		expect(policy.effect(PRIVATE, "create")).toEqual(asked("user"));
	});

	test("an unrestricted layer asks without restricting; a restricted one holding only an ask denies", () => {
		const agent = new Policy([layer("user", true, [[ANY, ["read", "create"]]]), layer("agent", false, [], [], [["work", ["create"]]])]);
		expect(agent.effect(WORK, "create")).toEqual(asked("agent"));
		expect(agent.effect(PRIVATE, "create")).toEqual(ALLOW);
		// An ask the connector cannot enforce compiles to its ask alone, which never lets a restricted layer pass.
		const askOnly = new Policy([layer("user", true, [], [], [["work", ["create"]]])]);
		expect(askOnly.effect(WORK, "create")).toEqual(DENY);
		expect(askOnly.permits(WORK, "create")).toBe(false);
		expect(askOnly.permitsAny("c1", "project", "create")).toBe(false);
	});

	describe("partial ancestry", () => {
		const unknown = resource("c1", "project", "essay", ["drafts"], true);
		const known = resource("c1", "project", "essay", ["drafts"]);

		test("a known ancestor's allow wins over an exact ask elsewhere: the unknown ones are farther", () => {
			const policy = new Policy([layer("user", true, [["drafts", ["create"]], ["elsewhere", ["create"]]], [], [["elsewhere", ["create"]]])]);
			expect(policy.effect(unknown, "create")).toEqual(ALLOW);
		});

		test("where * or an unrestricted default would decide, any exact ask for the action asks", () => {
			const wildcard = new Policy([layer("user", true, [[ANY, ["read", "create"]], ["elsewhere", ["create"]]], [], [["elsewhere", ["create"]]])]);
			expect(wildcard.effect(unknown, "create")).toEqual(asked("user"));
			expect(wildcard.effect(known, "create"), "complete ancestry is judged by its own ids").toEqual(ALLOW);
			expect(wildcard.effect(unknown, "read"), "an ask for another action is irrelevant").toEqual(ALLOW);
			expect(wildcard.effect(unknown, "create", REQUIRES)).toEqual(asked("user"));
			const unrestricted = new Policy([layer("agent", false, [], [], [["elsewhere", ["create"]]])]);
			expect(unrestricted.effect(unknown, "create")).toEqual(asked("agent"));
			expect(unrestricted.effect(known, "create")).toEqual(ALLOW);
		});

		test("an exact deny still denies, whatever asks", () => {
			const policy = new Policy([layer("user", true, [[ANY, ["create"]]], [["elsewhere", ["create"]]], [[ANY, ["create"]]])]);
			expect(policy.effect(unknown, "create")).toEqual(DENY);
			expect(policy.effect(known, "create")).toEqual(asked("user"));
		});
	});

	test("permitsAny counts an ask as an allow, but never an ask alone in a restricted layer", () => {
		const cases: [string, Layer[], boolean][] = [
			["an ask with its allow", [layer("user", true, [[ANY, ["read"]], ["work", ["create"]]], [], [["work", ["create"]]])], true],
			["an ask alone", [layer("user", true, [[ANY, ["read"]]], [], [["work", ["create"]]])], false],
			["an unrestricted layer's ask", [layer("user", true, [[ANY, ["read", "create"]]]), layer("agent", false, [], [], [[ANY, ["create"]]])], true],
			["a deny over an ask", [layer("user", true, [[ANY, ["read", "create"]]], [[ANY, ["create"]]], [[ANY, ["create"]]])], false],
		];
		for (const [why, layers, expected] of cases) {
			const policy = new Policy(layers);
			expect(policy.permitsAny("c1", "project", "create", REQUIRES), why).toBe(expected);
			expect([WORK, PRIVATE, NEW].some((r) => policy.permits(r, "create", REQUIRES)), why).toBe(expected);
		}
	});

	test("the snapshot keeps asks, and one stored before asks existed reads as none", () => {
		const policy = new Policy([layer("user", true, [["work", ["read", "create"]]], [], [["work", ["create"]]])]);
		const json = policy.toJson();
		expect(json).toEqual([
			{
				name: "user",
				restricted: true,
				allows: [
					["c1", "project", "work", "create"],
					["c1", "project", "work", "read"],
				],
				denies: [],
				asks: [["c1", "project", "work", "create"]],
			},
		]);
		expect(Policy.fromJson(structuredClone(json)).effect(WORK, "create")).toEqual(asked("user"));
		const stored = parseJson('[{"name":"user","restricted":true,"allows":[["c1","project","work","create"],["c1","project","work","read"]],"denies":[]}]');
		const old = Policy.fromJson(stored as never);
		expect(old.effect(WORK, "create")).toEqual(ALLOW);
		expect(old.toJson()[0]?.asks).toEqual([]);
	});
});

/** A layer as raw grants, for the reference model below. */
interface LayerSpec {
	name: LayerName;
	restricted: boolean;
	allows: Grants;
	asks: Grants;
	denies: Grants;
}

/**
 * The layer's effect, as the design states it, in other terms than the policy's: each grant's distance from the
 * resource (0 for itself, then its ancestors in order, `within.length + 1` for `*`).
 */
function referenceEffect(spec: LayerSpec, target: Resource, action: string): "deny" | "ask" | "allow" {
	const ladder = [target.id, ...target.within, ANY];
	const distance = (grants: Grants) => ladder.findIndex((id) => grants.some(([granted, actions]) => granted === id && actions.includes(action)));
	const exact = (grants: Grants) => grants.some(([granted, actions]) => granted !== ANY && actions.includes(action));
	if (distance(spec.denies) >= 0 || (target.partial && exact(spec.denies))) return "deny";
	const allow = distance(spec.allows);
	const ask = distance(spec.asks);
	if (spec.restricted && allow < 0) return "deny";
	const nearest = Math.min(...[allow, ask].filter((found) => found >= 0));
	const star = ladder.length - 1;
	if (nearest < star) return ask === nearest ? "ask" : "allow";
	if (target.partial && exact(spec.asks)) return "ask";
	return ask === star ? "ask" : "allow";
}

function referenceDecision(specs: LayerSpec[], target: Resource, action: string): Decision {
	const actions = action === "create" ? ["create", "read"] : [action];
	const effects = specs.map((spec) => actions.map((item) => referenceEffect(spec, target, item)));
	if (effects.flat().includes("deny")) return DENY;
	const layers = specs.filter((_, i) => effects[i]?.includes("ask")).map((spec) => spec.name);
	return layers.length > 0 ? { effect: "ask", layers } : ALLOW;
}

test("the effect agrees with a reference model of the rule over random layers and resources", () => {
	const rng = seeded(11);
	const ids = ["a", "b", "c"];
	const choices = [...ids, ANY];
	const grants = (most: number): Grants => Array.from({ length: rng.randint(0, most) }, () => [rng.choice(choices), rng.sample(["read", "create"], rng.randint(1, 2))]);
	const seen = { deny: 0, ask: 0, allow: 0 };
	for (let trial = 0; trial < 1500; trial++) {
		const specs: LayerSpec[] = (["ceiling", "user", "agent"] as const).map((name) => ({
			name,
			restricted: rng.random() < 0.4,
			allows: grants(3),
			asks: grants(2),
			denies: rng.random() < 0.3 ? grants(1) : [],
		}));
		const policy = new Policy(specs.map((spec) => layer(spec.name, spec.restricted, spec.allows, spec.denies, spec.asks)));
		for (const id of [...ids, "new"]) {
			const within = rng.sample(
				ids.filter((other) => other !== id),
				rng.randint(0, 2),
			);
			const target = resource("c1", "project", id, within, rng.random() < 0.3);
			for (const action of ["read", "create"]) {
				const expected = referenceDecision(specs, target, action);
				seen[expected.effect]++;
				expect(policy.effect(target, action, REQUIRES), `trial ${trial}, ${action} on ${JSON.stringify(target)}`).toEqual(expected);
			}
		}
	}
	// Each effect comes up often enough to test it.
	expect(Math.min(seen.deny, seen.ask, seen.allow), JSON.stringify(seen)).toBeGreaterThan(200);
});
