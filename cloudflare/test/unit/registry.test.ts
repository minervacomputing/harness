// The registry and its checks of connector declarations, with the fakes of fakes.ts.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ACCOUNT_KIND, type ActionSpec, type Connector, consentGiven, defineOperation, termsOf } from "../../src/gateway/connector.ts";
import { InvalidConnector, LookupError, Registry, fingerprint, inputSchema, meaning, validate } from "../../src/gateway/registry.ts";
import { parseJson } from "../../src/lib/json.ts";
import { record } from "../../src/lib/schema.ts";
import { FOLDER, FakeServer, LABEL, keyedConnector, mixedConnector, variant } from "./fakes.ts";

const mixedAuth = mixedConnector().auth as Extract<Connector["auth"], { type: "oauth2" }>;

test("the fakes are valid declarations", () => {
	expect(() => validate([mixedConnector(), keyedConnector()])).not.toThrow();
});

describe("invalid declarations are rejected", () => {
	const cases: [string, Connector][] = [
		["an unknown kind in needs", variant({ changes: { copy_file: { needs: [["nope", "read"]] } } })],
		["an action the kind does not have", variant({ changes: { list_labels: { needs: [[LABEL, "create"]] } } })],
		["an output action that applies to no kind", variant({ changes: { list_labels: { outputAction: "create" } } })],
		["no needs", variant({ changes: { list_labels: { needs: [] } } })],
		["a camelCase name", variant({ changes: { list_labels: { name: "listLabels" } } })],
		["a digit in the name", variant({ changes: { list_labels: { name: "list_labels2" } } })],
		["a duplicate name", variant({ changes: { list_labels: { name: "list_folders" } } })],
		["a tool name over 64 characters", variant({ changes: { list_labels: { name: "a".repeat(60) } } })],
		["paginated without a cursor", variant({ changes: { list_labels: { paginated: true } } })],
		[
			"a requires cycle",
			variant({
				actions: [
					{ id: "read", label: "Read", requires: "create" },
					{ id: "create", label: "Create", requires: "read" },
				],
			}),
		],
		["requiring an unknown action", variant({ actions: [{ id: "read", label: "Read", requires: "write" }] })],
		["a kind listing an undeclared action", variant({ kinds: [{ id: FOLDER, label: "Folder", actions: ["read", "delete"] }] })],
		["a wildcard account kind", variant({ kinds: [{ id: ACCOUNT_KIND, label: "Account", actions: ["read"], wildcard: true }] })],
		["an uppercase slug", variant({ slug: "Mixed" })],
		["an uppercase app", variant({ auth: { ...mixedAuth, app: "Mixed" } })],
		["an http token URL", variant({ auth: { ...mixedAuth, tokenUrl: "http://mixed.example/token" } })],
		["redirect_uri in authorize params", variant({ auth: { ...mixedAuth, authorizeParams: [["redirect_uri", "x"]] } })],
		[
			"a repeated authorize param",
			variant({
				auth: {
					...mixedAuth,
					authorizeParams: [
						["prompt", "a"],
						["prompt", "b"],
					],
				},
			}),
		],
	];

	test.each(cases)("%s", (_, connector) => {
		expect(() => validate([connector])).toThrow(InvalidConnector);
	});
});

test("messages name what is wrong, quoted", () => {
	expect(() => validate([variant({ changes: { copy_file: { needs: [["nope", "read"]] } } })])).toThrow('mixed.copy_file: unknown kind "nope".');
	expect(() => validate([variant({ slug: "Mixed" })])).toThrow('"Mixed": slugs are unique lowercase words joined by underscores.');
	expect(() => validate([variant({ changes: { list_labels: { name: "a".repeat(60) } } })])).toThrow("the tool name would exceed 64 characters.");
	expect(() => validate([keyedConnector(), keyedConnector()])).toThrow('"keyed": slugs are unique');
});

test("a tool name with a two-digit alias may fill 64 characters, not more", () => {
	// mixed99_ is 8 characters.
	expect(() => validate([variant({ changes: { list_labels: { name: "a".repeat(56) } } })])).not.toThrow();
	expect(() => validate([variant({ changes: { list_labels: { name: "a".repeat(57) } } })])).toThrow(InvalidConnector);
});

test("the output action needs to apply to only one of the kinds", () => {
	const mixedOutput = { needs: [[FOLDER, "read"], [LABEL, "read"]] as [string, string][], outputAction: "create" };
	expect(() => validate([variant({ changes: { list_folders: mixedOutput } })])).not.toThrow();
});

test("every action of a need's requires chain must apply to its kind", () => {
	// create requires read: a kind with create alone cannot be needed for create.
	const kinds = [
		{ id: FOLDER, label: "Folder", actions: ["create"] },
		{ id: LABEL, label: "Label", actions: ["read"] },
	];
	expect(() => validate([variant({ kinds, changes: { list_folders: { needs: [[FOLDER, "create"]], outputAction: "create" } } })])).toThrow(
		'mixed.list_folders: "read" does not apply to "folder".',
	);
});

test("consent needs OAuth, and tool names are unique", () => {
	const keyed = keyedConnector();
	const withConsent = { ...keyed, operations: keyed.operations.map((op) => ({ ...op, consent: [["x"]] })) };
	expect(() => validate([withConsent])).toThrow("keyed.whoami: consent needs an OAuth connector.");
	// The same connector twice: the slug repeats before the tool name does.
	expect(() => validate([keyedConnector(), keyedConnector()])).toThrow(InvalidConnector);
	// Two slugs whose tool names collide: a_b + c and a + b_c.
	const one = { ...keyed, slug: "a_b", operations: keyed.operations.map((op) => ({ ...op, name: "c" })) };
	const two = { ...keyed, slug: "a", operations: keyed.operations.map((op) => ({ ...op, name: "b_c" })) };
	expect(() => validate([one, two])).toThrow('"a_b_c" is declared by both a_b and a.');
});

describe("inputs are strict at every depth", () => {
	const withInput = (input: z.ZodType, paginated = false) => variant({ operations: [defineOperation({ ...mixedConnector().operations[0]!, input, paginated })] });
	const text = () => z.string().trim().min(1).max(10);
	const RECORD_RULE = (at: string) => `input records are lib/schema.ts's record, since zod's drops a "__proto__" key (at ${at})`;
	const PROTOTYPE_RULE = (at: string) => `an input field cannot be named as a property of Object.prototype, which zod would read or assign (at ${at})`;

	test("the root refuses unknown fields", () => {
		const unknown = "mixed.list_folders: inputs are strict objects, which refuse unknown fields (at input).";
		expect(() => validate([withInput(z.object({}))])).toThrow(unknown);
		expect(() => validate([withInput(z.looseObject({}))])).toThrow(unknown);
		expect(() => validate([withInput(record(z.unknown()))])).toThrow(unknown);
		expect(() => validate([withInput(z.strictObject({}).optional())])).toThrow(unknown);
		const cursor = z.strictObject({ cursor: z.string().trim().max(10).nullable().default(null) });
		expect(() => validate([withInput(cursor, true)])).not.toThrow();
	});

	const refused: [string, z.ZodType, string][] = [
		["a nested object that drops unknown fields", z.strictObject({ lines: z.array(z.object({ a: text() })) }), "inputs are strict objects, which refuse unknown fields (at input.lines[])"],
		["a nested object that passes them on", z.strictObject({ meta: z.looseObject({}) }), "inputs are strict objects, which refuse unknown fields (at input.meta)"],
		["an object with a catchall", z.strictObject({ meta: z.strictObject({}).catchall(z.unknown()) }), "inputs are strict objects, which refuse unknown fields (at input.meta)"],
		["coercion", z.strictObject({ n: z.coerce.number() }), "inputs never coerce (at input.n)"],
		["zod's record, which drops \"__proto__\"", z.strictObject({ filter: z.record(z.string(), z.unknown()) }), RECORD_RULE("input.filter")],
		["zod's record in an array", z.strictObject({ sorts: z.array(z.record(z.string(), z.unknown())) }), RECORD_RULE("input.sorts[]")],
		["zod's loose record", z.strictObject({ meta: z.looseRecord(z.literal("a"), z.unknown()) }), RECORD_RULE("input.meta")],
		["zod's partial record", z.strictObject({ meta: z.partialRecord(z.enum(["a"]), z.unknown()) }), RECORD_RULE("input.meta")],
		["an intersection, which assigns the keys it merges", z.strictObject({ m: z.intersection(record(z.unknown()), record(z.unknown())) }), "inputs cannot use zod's intersection, which assigns the keys it merges (at input.m)"],
		["a field named __proto__, which zod assigns", z.strictObject({ ["__proto__"]: text() }), PROTOTYPE_RULE("input.__proto__")],
		["a field named constructor, which zod reads when it is missing", z.strictObject({ constructor: z.unknown() }), PROTOTYPE_RULE("input.constructor")],
		["a nested field named toString", z.strictObject({ a: z.array(z.strictObject({ toString: text().optional() })) }), PROTOTYPE_RULE("input.a[].toString")],
		[
			"a discriminator named constructor",
			z.strictObject({ v: z.discriminatedUnion("constructor", [z.strictObject({ constructor: z.literal("a") }), z.strictObject({ constructor: z.literal("b") })]) }),
			PROTOTYPE_RULE("input.v.constructor"),
		],
		["a record of objects that drop unknown fields", z.strictObject({ filter: record(z.object({})) }), "inputs are strict objects, which refuse unknown fields (at input.filter{value})"],
		["zod's custom", z.strictObject({ c: z.custom<string>((value) => typeof value === "string") }), "inputs cannot use zod's custom (at input.c)"],
		["a transform before validation", z.strictObject({ p: z.preprocess((value) => value, text()) }), "inputs validate before they transform (at input.p)"],
		["a catch, which accepts what fails", z.strictObject({ c: z.strictObject({}).catch({}) }), "inputs cannot use zod's catch (at input.c)"],
		["a nested object in a lazy schema", z.strictObject({ tree: z.lazy(() => z.object({})) }), "inputs are strict objects, which refuse unknown fields (at input.tree)"],
	];

	test.each(refused)("refused: %s", (_, input, message) => {
		expect(() => validate([withInput(input)])).toThrow(`mixed.list_folders: ${message}.`);
	});

	test("a lazy schema is checked as zod parses it", () => {
		// A getter that would answer differently the second time: zod caches the first answer.
		let calls = 0;
		const input = z.strictObject({ nested: z.lazy(() => (++calls === 1 ? z.strictObject({}) : z.looseObject({}))) });
		expect(() => validate([withInput(input)])).not.toThrow();
		expect(input.safeParse({ nested: { extra: 1 } }).success).toBe(false);
	});

	test("zod reads a missing field through the prototype, so fields are not named after its properties", () => {
		const inherited = z.strictObject({ constructor: z.unknown() }).safeParse({});
		expect(inherited.data?.constructor).toBe(Object);
		const named = z.strictObject({ hasOwn: text().optional(), proto: text().optional() });
		expect(() => validate([withInput(named)])).not.toThrow();
	});

	test("records are accepted, with the JSON Schema the model sees", () => {
		const input = z.strictObject({
			filter: record(z.unknown())
				.refine((value) => JSON.stringify(value).length <= 50, "must be at most 50 characters as JSON")
				.nullable()
				.default(null),
			properties: record(z.unknown(), { min: 1, max: 100 }),
			flags: record(z.boolean()).optional(),
		});
		const op = defineOperation({ ...mixedConnector().operations[0]!, input });
		expect(() => validate([variant({ operations: [op] })])).not.toThrow();
		expect(inputSchema(op)).toEqual({
			type: "object",
			properties: {
				filter: { anyOf: [{ type: "object", propertyNames: { type: "string" }, additionalProperties: {} }, { type: "null" }], default: null },
				properties: { type: "object", propertyNames: { type: "string" }, additionalProperties: {}, minProperties: 1, maxProperties: 100 },
				flags: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "boolean" } },
			},
			required: ["properties"],
			additionalProperties: false,
		});
		// A "__proto__" key the model sends is refused at the root (an unknown field) and in a record.
		expect(input.safeParse(parseJson('{"__proto__":{"properties":{"a":1}}}')).success).toBe(false);
		expect(input.safeParse(parseJson('{"properties":{"__proto__":{"x":1}}}')).success).toBe(false);
	});

	test("nested inputs are accepted, refuse unknown fields and never coerce", () => {
		const Line = z.strictObject({ description: text(), quantity: z.int().min(1), tax: z.enum(["exclusive", "inclusive"]) });
		const input = z.strictObject({
			lines: z.array(Line).min(1),
			mode: z.literal("all").or(z.null()).default(null),
			team: text().transform((value) => value.toUpperCase()),
			tags: z.tuple([text()], text()).optional(),
		});
		expect(() => validate([withInput(input)])).not.toThrow();
		expect(input.parse({ lines: [{ description: " Work ", quantity: 2, tax: "exclusive" }], team: " eng " })).toEqual({
			lines: [{ description: "Work", quantity: 2, tax: "exclusive" }],
			mode: null,
			team: "ENG",
		});
		expect(input.safeParse({ lines: [{ description: "x", quantity: 1, tax: "exclusive", connection_id: "c2" }], team: "x" }).success).toBe(false);
		expect(input.safeParse({ lines: [{ description: "x", quantity: "1", tax: "exclusive" }], team: "x" }).success).toBe(false);
	});
});

describe("fingerprints", () => {
	test("the fingerprint follows what an operation means", async () => {
		const base = mixedConnector(new FakeServer());
		const op = base.operations[1]!;
		expect(op.name).toBe("copy_file");
		const print = await fingerprint(base, op);
		expect(print).toMatch(/^[0-9a-f]{16}$/);
		expect(await fingerprint(mixedConnector(new FakeServer()), op)).toBe(print);
		expect(await fingerprint(base, { ...op, revision: 2 })).not.toBe(print);
		expect(await fingerprint(base, { ...op, needs: [[FOLDER, "create"]] })).not.toBe(print);
		const unrequired = variant({
			actions: [
				{ id: "read", label: "Read" },
				{ id: "create", label: "Create" },
			],
		});
		expect(await fingerprint(unrequired, op)).not.toBe(print);
		const noWildcard = variant({ kinds: [{ id: FOLDER, label: "Folder", actions: ["read", "create"] }, base.kinds[1]!] });
		expect(await fingerprint(noWildcard, op)).not.toBe(print);
	});

	test("descriptions and browsing are not part of it; field descriptions are", async () => {
		const base = mixedConnector();
		const op = base.operations[1]!;
		const print = await fingerprint(base, op);
		expect(await fingerprint(base, { ...op, description: "Another text.", title: "Another title" })).toBe(print);
		expect(await fingerprint({ ...base, browsable: [], name: "Renamed" }, op)).toBe(print);
		const described = z.strictObject({ ...(op.input as unknown as z.ZodObject).shape, name: z.string().trim().min(1).max(100).describe("The copy's name.") });
		expect(await fingerprint(base, { ...op, input: described as never })).not.toBe(print);
	});

	test("what the contract covers", () => {
		const base = mixedConnector();
		const labels = base.operations[2]!;
		expect(meaning(base, { ...labels, consent: [["b", "a", "b"], ["a"]] })).toEqual({
			revision: 1,
			input: { type: "object", properties: {}, additionalProperties: false },
			needs: [[LABEL, "read"]],
			output: "read",
			consent: [["a"], ["a", "b"]],
			mutates: false,
			paginated: false,
			requires: { read: ["read"] },
			kinds: { label: { actions: ["read"], wildcard: false, hierarchical: false } },
		});
		const copy = meaning(base, base.operations[1]!);
		expect(copy.needs).toEqual([
			[FOLDER, "create"],
			[FOLDER, "read"],
		]);
		expect(copy.requires).toEqual({ create: ["create", "read"], read: ["read"] });
		expect(copy.kinds).toEqual({ folder: { actions: ["create", "read"], wildcard: true, hierarchical: false } });
		expect(copy.consent).toBeNull();
		expect(copy.mutates).toBe(true);
	});

	test("the input schema is zod's, without $schema", () => {
		expect(inputSchema(mixedConnector().operations[1]!)).toEqual({
			type: "object",
			properties: {
				source: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9-]+$" },
				dest: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9-]+$" },
				name: { type: "string", minLength: 1, maxLength: 100 },
			},
			required: ["source", "dest", "name"],
			additionalProperties: false,
		});
	});
});

describe("the registry", () => {
	test("validates before it answers", async () => {
		await expect(Registry.create([variant({ slug: "Mixed" })])).rejects.toThrow(InvalidConnector);
	});

	test("contracts and resolution", async () => {
		const registry = await Registry.create([mixedConnector(), keyedConnector()]);
		const contract = registry.contract("mixed", "copy_file");
		expect(contract).toBe(await fingerprint(mixedConnector(), mixedConnector().operations[1]!));
		expect(registry.resolve("mixed", "copy_file", contract)?.name).toBe("copy_file");
		// A tool whose contract changed, or that no longer exists, resolves to nothing (OPERATION_CHANGED).
		expect(registry.resolve("mixed", "copy_file", "stale")).toBeNull();
		expect(registry.resolve("mixed", "copy_file", "")).toBeNull();
		expect(registry.resolve("mixed", "delete_file", contract)).toBeNull();
		expect(registry.resolve("gone", "copy_file", contract)).toBeNull();
		expect(() => registry.get("gone")).toThrow(new LookupError('Unknown connector "gone".'));
		expect(() => registry.contract("mixed", "nope")).toThrow(new LookupError("Unknown operation mixed.nope."));
		expect(registry.find("gone")).toBeNull();
		expect(registry.all().map((connector) => connector.slug)).toEqual(["mixed", "keyed"]);
	});
});

test("a registered declaration is frozen, so its contract keeps describing it", async () => {
	const connector = mixedConnector();
	const registry = await Registry.create([connector]);
	const contract = registry.contract("mixed", "copy_file");
	const copy = connector.operations[1]!;
	expect(() => {
		(copy as { mutates?: boolean }).mutates = false;
	}).toThrow(TypeError);
	expect(() => (copy.needs as [string, string][]).pop()).toThrow(TypeError);
	expect(() => connector.kinds[0]!.actions.push("delete")).toThrow(TypeError);
	expect(() => connector.actions.push({ id: "delete", label: "Delete" })).toThrow(TypeError);
	expect(() => connector.operations.pop()).toThrow(TypeError);
	expect(registry.resolve("mixed", "copy_file", contract)).toBe(copy);
	expect(await fingerprint(connector, copy)).toBe(contract);
});

test("freezing reaches inside what was frozen already, and the declared properties stay put", async () => {
	const base = mixedConnector();
	// An outer array frozen by the connector, with pairs it left mutable.
	const copy = { ...base.operations[1]!, needs: Object.freeze([[FOLDER, "read"], [FOLDER, "create"]]) as [string, string][] };
	const connector = { ...base, operations: [base.operations[0]!, copy, base.operations[2]!] };
	const registry = await Registry.create([connector]);
	const contract = registry.contract("mixed", "copy_file");
	expect(() => {
		(copy.needs[1] as string[])[1] = "read";
	}).toThrow(TypeError);
	const writable = connector as unknown as { [key: string]: unknown };
	for (const key of ["slug", "kinds", "actions", "auth", "operations", "browsable"]) {
		expect(() => {
			writable[key] = [];
		}, key).toThrow(TypeError);
	}
	expect(registry.find("mixed")?.kinds[0]?.wildcard).toBe(true);
	expect(registry.resolve("mixed", "copy_file", contract)).toBe(copy);
	expect(await fingerprint(connector, copy)).toBe(contract);
	// The rest of the connector may keep state.
	writable.name = "Renamed";
	expect(connector.name).toBe("Renamed");
});

test("a declaration read through a getter is read once, so lookups see what was fingerprinted", async () => {
	// A getter that builds a fresh list on every read.
	const base = mixedConnector();
	const fresh = Object.defineProperty({ ...base }, "operations", {
		get: () => mixedConnector().operations,
		enumerable: true,
		configurable: true,
	});
	const registry = await Registry.create([fresh]);
	expect(fresh.operations).toBe(fresh.operations);
	const op = fresh.operations[1]!;
	expect(registry.resolve("mixed", "copy_file", registry.contract("mixed", "copy_file"))).toBe(op);
	expect(Object.isFrozen(op.needs[0])).toBe(true);
});

test("getters inside a declaration are read once too, as freezing alone keeps them", async () => {
	const base = mixedConnector();
	let mutates = false;
	let requires: string | null = "read";
	const list = Object.defineProperty({ ...base.operations[0]! }, "mutates", { get: () => mutates, enumerable: true, configurable: true });
	const create: ActionSpec = Object.defineProperty({ id: "create", label: "Create" }, "requires", { get: () => requires, enumerable: true, configurable: true });
	const connector = { ...base, actions: [base.actions[0]!, create], operations: [list, ...base.operations.slice(1)] };
	const registry = await Registry.create([connector]);
	const contract = registry.contract("mixed", "copy_file");
	mutates = true;
	requires = null;
	expect(termsOf(list).mutates).toBe(false);
	expect(create.requires).toBe("read");
	expect(await fingerprint(connector, connector.operations[1]!)).toBe(contract);
});

test("kind and action ids are only names, even __proto__", async () => {
	const proto = variant({
		kinds: [{ id: "__proto__", label: "Proto", actions: ["read"], wildcard: true }],
		operations: [{ ...mixedConnector().operations[0]!, needs: [["__proto__", "read"]] }],
	});
	const registry = await Registry.create([proto]);
	expect(registry.contract("mixed", "list_folders")).toMatch(/^[0-9a-f]{16}$/);
	expect(Object.keys(meaning(proto, proto.operations[0]!).kinds as object)).toEqual(["__proto__"]);
});

test("an operation's defaults: reads, no consent, revision 1, not mutating, not paginated", () => {
	expect(termsOf(mixedConnector().operations[0]!)).toEqual({ outputAction: "read", consent: null, revision: 1, mutates: false, paginated: false });
	expect(termsOf(mixedConnector().operations[1]!).mutates).toBe(true);
	expect(termsOf(mixedConnector().operations[2]!).consent).toEqual([["labels"]]);
});

test("consent: unknown scopes pass, known ones must hold one set in full", () => {
	const consent = [["files"], ["labels", "all"]];
	expect(consentGiven(null, [])).toBe(true);
	expect(consentGiven(consent, null)).toBe(true);
	expect(consentGiven(consent, [])).toBe(false);
	expect(consentGiven(consent, ["files"])).toBe(true);
	expect(consentGiven(consent, ["labels"])).toBe(false);
	expect(consentGiven(consent, ["all", "labels", "x"])).toBe(true);
	// An empty option needs nothing; no options at all can never be met.
	expect(consentGiven([[]], [])).toBe(true);
	expect(consentGiven([], ["files"])).toBe(false);
});
