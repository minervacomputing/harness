// Layers and grants, the pure parts (gateway/grants.ts): wildcards, connections that act on their account,
// the limit on grants, wildcards on kinds without them, asks and the actions they may sit on, and the validation of
// access settings. The provider's `describe` step between the checks and the plan belongs to the API.

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { ACCOUNT_KIND, type Connector, requiresOf } from "../../src/gateway/connector.ts";
import {
	DEFAULT_RESTRICTED,
	type EditableRow,
	type GrantChange,
	type GrantRow,
	InvalidGrants,
	MAX_GRANTS_PER_CONNECTION,
	askable,
	checkChanges,
	effectivePolicy,
	enforceable,
	planGrantChanges,
	resourceKey,
} from "../../src/gateway/grants.ts";
import { ANY, type Decision, chain, resource } from "../../src/gateway/policy.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { FOLDER, LABEL, keyedConnector, mixedConnector, variant } from "./fakes.ts";

const CONNECTION = "0199a000-0000-7000-8000-000000000001";
const USER = "0199a000-0000-7000-8000-0000000000aa";
const mixed = mixedConnector();

function grant(kind: string, resourceId: string, actions: string[], extra: Partial<EditableRow> = {}): EditableRow {
	return { layer: "user", subject: USER, connectionId: CONNECTION, kind, resourceId, resourceName: "", actions, effect: "allow", ...extra };
}

function change(kind: string, id: string, actions: string[], ask: string[] = []): GrantChange {
	return { kind, id, actions, ask };
}

function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof InvalidGrants) return error.message;
		throw error;
	}
	throw new Error("Expected InvalidGrants.");
}

describe("checkChanges", () => {
	test("each refusal", () => {
		const check = (...changes: GrantChange[]) => refusal(() => checkChanges(mixed, CONNECTION, changes));
		expect(check()).toBe("Nothing to change.");
		expect(check(...Array.from({ length: 101 }, (_, i) => change(FOLDER, `f${i}`, ["read"])))).toBe("Change at most 100 resources at once.");
		expect(check(change("task", "work", ["read"]))).toBe('Mixed has no resources of type "task".');
		expect(check(change(ACCOUNT_KIND, CONNECTION, ["read"]))).toBe('Mixed has no resources of type "account".');
		expect(check(change("it's", "work", ["read"]))).toBe(`Mixed has no resources of type "it's".`);
		expect(check(change('a"b', "work", ["read"]))).toBe('Mixed has no resources of type "a\\"b".');
		expect(check(change(FOLDER, "", ["read"]))).toBe("Choose a resource.");
		expect(check(change(FOLDER, "x".repeat(201), ["read"]))).toBe("Choose a resource.");
		expect(check(change(LABEL, ANY, ["read"]))).toBe("Permissions for label resources are set one at a time.");
		expect(check(change(FOLDER, "inbox", ["read"]), change(FOLDER, "inbox", []))).toBe("Each resource can only be listed once.");
		expect(check(change(FOLDER, "inbox", ["delete"]))).toBe('Mixed does not support "delete" on folder.');
		expect(check(change(LABEL, "red", ["create"]))).toBe('Mixed does not support "create" on label.');
	});

	test("ids are counted in UTF-16 units, and a wildcard is fine on a wildcard kind", () => {
		expect(() => checkChanges(mixed, CONNECTION, [change(FOLDER, "\u{1f600}".repeat(100), ["read"])])).not.toThrow();
		expect(refusal(() => checkChanges(mixed, CONNECTION, [change(FOLDER, `a${"\u{1f600}".repeat(100)}`, ["read"])]))).toBe("Choose a resource.");
		expect(() => checkChanges(mixed, CONNECTION, [change(FOLDER, ANY, ["read"]), change(FOLDER, "archive", ["create"])])).not.toThrow();
		expect(() => checkChanges(mixed, CONNECTION, Array.from({ length: 100 }, (_, i) => change(FOLDER, `f${i}`, ["read"])))).not.toThrow();
	});

	test("an ask must be one of the change's actions, and one no read needs", () => {
		const check = (...changes: GrantChange[]) => refusal(() => checkChanges(mixed, CONNECTION, changes));
		expect(check(change(FOLDER, "inbox", ["read"], ["create"]))).toBe("Mixed cannot ask before Create without allowing it.");
		expect(check(change(FOLDER, "inbox", ["read", "create"], ["read"]))).toBe("Mixed cannot ask before Read; it is needed to read.");
		expect(check(change(FOLDER, "inbox", ["read", "create"], ["create", "read"]))).toBe("Mixed cannot ask before Read; it is needed to read.");
		expect(() => checkChanges(mixed, CONNECTION, [change(FOLDER, "inbox", ["read", "create"], ["create"]), change(FOLDER, ANY, ["read"])])).not.toThrow();
	});

	test("account permissions apply to the connection itself", () => {
		const keyed = keyedConnector();
		expect(refusal(() => checkChanges(keyed, CONNECTION, [change(ACCOUNT_KIND, "other", ["read"])]))).toBe("Account permissions apply to the connection itself.");
		expect(() => checkChanges(keyed, CONNECTION, [change(ACCOUNT_KIND, CONNECTION, ["read"])])).not.toThrow();
	});
});

describe("planGrantChanges", () => {
	const names = (entries: [kind: string, id: string, name: string][] = []) => new Map(entries.map(([kind, id, name]) => [resourceKey(kind, id), name]));

	test("a requirement may be met on the resource or by the kind's wildcard", () => {
		// Create on one folder relies on the wildcard read.
		let rows: EditableRow[] = [];
		const apply = (changes: GrantChange[], given = names()) => {
			const plan = planGrantChanges(mixed, rows, changes, given);
			const byKey = new Map(rows.map((row) => [resourceKey(row.kind, row.resourceId), row]));
			for (const { kind, resourceId } of plan.deletes) byKey.delete(resourceKey(kind, resourceId));
			for (const { kind, resourceId, actions, resourceName } of plan.upserts) byKey.set(resourceKey(kind, resourceId), grant(kind, resourceId, actions, { resourceName }));
			rows = [...byKey.values()];
			return plan;
		};
		apply([change(FOLDER, ANY, ["read"])]);
		const saved = apply([change(FOLDER, "archive", ["create"])], names([[FOLDER, "archive", "Archive"]]));
		expect(saved.upserts).toEqual([{ kind: FOLDER, resourceId: "archive", actions: ["create"], ask: [], resourceName: "Archive" }]);
		expect([...saved.state.values()].map(({ kind, id, actions }) => [kind, id, [...actions]])).toEqual([
			[FOLDER, ANY, ["read"]],
			[FOLDER, "archive", ["create"]],
		]);
		// The stored name says which grant relies on the wildcard.
		expect(refusal(() => apply([change(FOLDER, ANY, [])]))).toBe("Create on Archive also requires Read.");
		const removed = apply([change(FOLDER, "archive", [])]);
		expect(removed.deletes).toEqual([{ kind: FOLDER, resourceId: "archive" }]);
		expect(apply([change(FOLDER, ANY, [])]).deletes).toEqual([{ kind: FOLDER, resourceId: ANY }]);
		expect(rows).toEqual([]);
	});

	test("create needs read on the same resource; the name is the provider's, else the stored one, else the id", () => {
		expect(refusal(() => planGrantChanges(mixed, [], [change(FOLDER, "work", ["create"])], names([[FOLDER, "work", "Work"]])))).toBe(
			"Create on Work also requires Read.",
		);
		expect(refusal(() => planGrantChanges(mixed, [], [change(FOLDER, "work", ["create"])], names()))).toBe("Create on work also requires Read.");
		const stored = [grant(FOLDER, "work", ["read"], { resourceName: "Stored" })];
		expect(refusal(() => planGrantChanges(mixed, stored, [change(FOLDER, "work", ["create"])], names()))).toBe("Create on Stored also requires Read.");
		expect(planGrantChanges(mixed, [], [change(FOLDER, "work", ["create", "read", "read"])], names()).upserts[0]?.actions).toEqual(["create", "read"]);
	});

	test("only the kinds a change touches are checked", () => {
		// A stored grant that breaks a requirement (a hand edit) does not block a change to another kind.
		const broken = [grant(FOLDER, "work", ["create"])];
		expect(() => planGrantChanges(mixed, broken, [change(LABEL, "red", ["read"])], names())).not.toThrow();
		expect(refusal(() => planGrantChanges(mixed, broken, [change(FOLDER, "inbox", ["read"])], names()))).toBe("Create on work also requires Read.");
	});

	test("a widened grant keeps its stored name; removing one that does not exist writes nothing", () => {
		const stored = [grant(FOLDER, "inbox", ["read"], { resourceName: "Inbox" })];
		const plan = planGrantChanges(mixed, stored, [change(FOLDER, "inbox", ["read", "create"])], names());
		expect(plan.upserts).toEqual([{ kind: FOLDER, resourceId: "inbox", actions: ["create", "read"], ask: [], resourceName: "Inbox" }]);
		expect(planGrantChanges(mixed, [], [change(FOLDER, "ghost", [])], names())).toEqual({ upserts: [], deletes: [], state: new Map() });
	});

	test("asks go through the plan: a change sets a resource's actions and asks together, and they still need what they require", () => {
		const stored = [grant(FOLDER, "inbox", ["read"], { resourceName: "Inbox" }), grant(FOLDER, "inbox", ["create"], { effect: "ask" }), grant(FOLDER, "archive", ["read", "create"])];
		const kept = planGrantChanges(mixed, stored, [change(FOLDER, "work", ["read"])], names());
		const entries = (plan: ReturnType<typeof planGrantChanges>) => [...plan.state.values()].map(({ kind, id, actions, ask }) => [kind, id, [...actions].sort(), [...ask].sort()]);
		// The two rows of inbox are one resource, its create asked; archive asks nothing.
		expect(entries(kept)).toEqual([
			[FOLDER, "inbox", ["create", "read"], ["create"]],
			[FOLDER, "archive", ["create", "read"], []],
			[FOLDER, "work", ["read"], []],
		]);
		const asked = planGrantChanges(mixed, stored, [change(FOLDER, "archive", ["read", "create"], ["create"])], names());
		expect(asked.upserts).toEqual([{ kind: FOLDER, resourceId: "archive", actions: ["create", "read"], ask: ["create"], resourceName: "" }]);
		expect(entries(asked)[1]).toEqual([FOLDER, "archive", ["create", "read"], ["create"]]);
		const allowed = planGrantChanges(mixed, stored, [change(FOLDER, "inbox", ["read", "create"])], names());
		expect(allowed.upserts).toEqual([{ kind: FOLDER, resourceId: "inbox", actions: ["create", "read"], ask: [], resourceName: "Inbox" }]);
		expect(entries(allowed)[0]).toEqual([FOLDER, "inbox", ["create", "read"], []]);
		expect(refusal(() => planGrantChanges(mixed, [], [change(FOLDER, "work", ["create"], ["create"])], names()))).toBe("Create on work also requires Read.");
		expect(planGrantChanges(mixed, stored, [change(FOLDER, "inbox", [])], names()).deletes).toEqual([{ kind: FOLDER, resourceId: "inbox" }]);
	});

	test("a connection has a limited number of grants", () => {
		// Widening f0 there is refused by the provider's
		// describe (f0 does not exist at the fake), not by the limit, which counts resources.
		const full = Array.from({ length: MAX_GRANTS_PER_CONNECTION }, (_, i) => grant(FOLDER, `f${i}`, ["read"]));
		expect(refusal(() => planGrantChanges(mixed, full, [change(FOLDER, "inbox", ["read"])], names()))).toBe("A connection can have at most 500 permissions.");
		expect(() => planGrantChanges(mixed, full, [change(FOLDER, "f0", ["read", "create"])], names())).not.toThrow();
		const fewer = planGrantChanges(mixed, full, [change(FOLDER, "f0", [])], names());
		expect(fewer.deletes).toEqual([{ kind: FOLDER, resourceId: "f0" }]);
		expect(fewer.state.size).toBe(MAX_GRANTS_PER_CONNECTION - 1);
		const rest = full.slice(1);
		expect(() => planGrantChanges(mixed, rest, [change(FOLDER, "inbox", ["read"])], names())).not.toThrow();
	});
});

describe("the policy a run starts with", () => {
	const providerOf = (id: string) => (id === CONNECTION ? "mixed" : id === "gone-provider" ? "gone" : null);

	test("missing layers take their defaults, in the order ceiling, user, agent", async () => {
		const registry = await Registry.create([mixedConnector()]);
		const policy = effectivePolicy({ ceiling: null, user: null, agent: null }, registry, providerOf);
		expect(policy.toJson()).toEqual([
			{ name: "ceiling", restricted: DEFAULT_RESTRICTED.ceiling, allows: [], denies: [], asks: [] },
			{ name: "user", restricted: DEFAULT_RESTRICTED.user, allows: [], denies: [], asks: [] },
			{ name: "agent", restricted: DEFAULT_RESTRICTED.agent, allows: [], denies: [], asks: [] },
		]);
		expect(policy.permitsAny(CONNECTION, FOLDER, "read")).toBe(false);
	});

	test("a wildcard on a kind without wildcards is ignored", async () => {
		// Only a hand edit can store this; the API rejects it.
		const registry = await Registry.create([mixedConnector()]);
		const rows = [grant(FOLDER, "inbox", ["read"]), grant(LABEL, ANY, ["read"])];
		const policy = effectivePolicy({ ceiling: { restricted: false, grants: [] }, user: { restricted: true, grants: rows }, agent: null }, registry, providerOf);
		expect(policy.permitsAny(CONNECTION, LABEL, "read")).toBe(false);
		expect(policy.permits(resource(CONNECTION, FOLDER, "inbox"), "read")).toBe(true);
		expect(policy.toJson()[1]?.allows).toEqual([[CONNECTION, FOLDER, "inbox", "read"]]);
	});

	test("allows on kinds or providers no longer declared are dropped; denies always apply", async () => {
		const registry = await Registry.create([mixedConnector()]);
		const check = (row: GrantRow) => enforceable(row, registry, providerOf);
		expect(check(grant(FOLDER, "inbox", ["read"]))).toBe(true);
		expect(check(grant(FOLDER, ANY, ["read"]))).toBe(true);
		expect(check(grant("removed", "x", ["read"]))).toBe(false);
		expect(check(grant(LABEL, ANY, ["read"]))).toBe(false);
		expect(check(grant(FOLDER, "x", ["read"], { connectionId: "gone-provider" }))).toBe(false);
		expect(check(grant(FOLDER, "x", ["read"], { connectionId: "deleted" }))).toBe(false);
		for (const row of [grant("removed", "x", ["read"]), grant(LABEL, ANY, ["read"]), grant(FOLDER, "x", ["read"], { connectionId: "gone-provider" })]) {
			expect(check({ ...row, effect: "deny" })).toBe(true);
		}
		const denied = effectivePolicy(
			{ ceiling: { restricted: false, grants: [{ ...grant(LABEL, ANY, ["read"], { layer: "ceiling", subject: null }), effect: "deny" }] }, user: { restricted: false, grants: [] }, agent: null },
			registry,
			providerOf,
		);
		expect(denied.permitsAny(CONNECTION, LABEL, "read")).toBe(false);
		expect(denied.permitsAny(CONNECTION, FOLDER, "read")).toBe(true);
	});
});

describe("asks", () => {
	const providerOf = (id: string) => (id === CONNECTION ? "mixed" : id === "gone-provider" ? "gone" : null);
	const ask = (kind: string, resourceId: string, actions: string[], extra: Partial<EditableRow> = {}) => grant(kind, resourceId, actions, { effect: "ask", ...extra });

	test("an action is askable when no operation that only reads needs it, directly or through what it requires", () => {
		expect([...askable(mixedConnector())]).toEqual(["create"]);
		// A write that reads its source does not make read a read's need.
		const writesOnly = variant({ operations: mixedConnector().operations.filter((op) => op.name === "copy_file") });
		expect([...askable(writesOnly)]).toEqual(["read", "create"]);
		const actions = [
			{ id: "read", label: "Read" },
			{ id: "comment", label: "Comment", requires: "read" },
			{ id: "edit", label: "Edit", requires: "comment" },
			{ id: "delete", label: "Delete" },
		];
		const base = mixedConnector().operations[0] as Connector["operations"][number];
		const op = (name: string, action: string, mutates?: boolean) => ({ ...base, name, needs: [[FOLDER, action]] as [string, string][], ...(mutates === undefined ? {} : { mutates }) });
		// A read needing edit needs comment and read through `requires`; mutates false is a read, as omitted is.
		expect([...askable(variant({ actions, operations: [op("peek", "edit", false), op("remove", "delete", true)] }))]).toEqual(["delete"]);
		expect([...askable(variant({ actions, operations: [op("peek", "comment"), op("change", "edit", true), op("remove", "delete", true)] }))]).toEqual(["edit", "delete"]);
	});

	test("today's catalog: every action only writes need, never read; Sentry and the Web none", () => {
		const of = (slug: string) => [...askable(CONNECTORS.find((connector) => connector.slug === slug) as Connector)].sort();
		expect(of("gmail")).toEqual(["draft", "send"]);
		expect(of("slack")).toEqual(["post", "reply"]);
		expect(of("stripe")).toEqual(["credit", "refund"]);
		expect(of("xero")).toEqual(["draft_bills", "draft_sales"]);
		expect(of("sentry")).toEqual([]);
		expect(of("web")).toEqual([]);
		for (const connector of CONNECTORS) {
			const requires = requiresOf(connector);
			const written = new Set(connector.operations.filter((op) => op.mutates).flatMap((op) => op.needs.flatMap(([, action]) => chain(action, requires))));
			written.delete("read");
			expect(of(connector.slug), connector.slug).toEqual([...written].sort());
		}
	});

	test("an ask row asks, and passes a restricted layer only where an allow would", async () => {
		const registry = await Registry.create([mixedConnector()]);
		const inbox = resource(CONNECTION, FOLDER, "inbox");
		const user = [grant(FOLDER, ANY, ["read"]), ask(FOLDER, "inbox", ["create"])];
		const restricted = effectivePolicy({ ceiling: null, user: { restricted: true, grants: user }, agent: null }, registry, providerOf);
		expect(restricted.toJson()[1]).toEqual({
			name: "user",
			restricted: true,
			allows: [
				[CONNECTION, FOLDER, ANY, "read"],
				[CONNECTION, FOLDER, "inbox", "create"],
			],
			denies: [],
			asks: [[CONNECTION, FOLDER, "inbox", "create"]],
		});
		expect(restricted.effect(inbox, "create", requiresOf(mixed))).toEqual({ effect: "ask", layers: ["user"] } satisfies Decision);
		expect(restricted.effect(resource(CONNECTION, FOLDER, "archive"), "create")).toEqual({ effect: "deny" } satisfies Decision);
		// The ceiling asks on every folder without restricting anyone.
		const ceiling = effectivePolicy(
			{ ceiling: { restricted: false, grants: [ask(FOLDER, ANY, ["create"], { layer: "ceiling", subject: null })] }, user: { restricted: true, grants: [grant(FOLDER, ANY, ["read", "create"])] }, agent: null },
			registry,
			providerOf,
		);
		expect(ceiling.toJson()[0]).toMatchObject({ restricted: false, asks: [[CONNECTION, FOLDER, ANY, "create"]] });
		expect(ceiling.effect(inbox, "create")).toEqual({ effect: "ask", layers: ["ceiling"] } satisfies Decision);
		expect(ceiling.effect(inbox, "read")).toEqual({ effect: "allow" } satisfies Decision);
	});

	test("an ask row the connector cannot enforce asks in an unrestricted layer and denies in a restricted one", async () => {
		const registry = await Registry.create([mixedConnector()]);
		// A kind the connector no longer declares: create is askable, but no allow is enforceable on it.
		const gone = resource(CONNECTION, "removed", "x");
		const rows = [ask("removed", "x", ["create"])];
		const unrestricted = effectivePolicy({ ceiling: null, user: { restricted: true, grants: [grant("removed", "x", ["create"])] }, agent: { restricted: false, grants: rows } }, registry, providerOf);
		expect(unrestricted.toJson()[2]).toMatchObject({ allows: [], denies: [], asks: [[CONNECTION, "removed", "x", "create"]] });
		expect(unrestricted.toJson()[1]?.allows).toEqual([]);
		const restricted = effectivePolicy({ ceiling: null, user: { restricted: true, grants: rows }, agent: null }, registry, providerOf);
		expect(restricted.toJson()[1]).toMatchObject({ allows: [], denies: [], asks: [[CONNECTION, "removed", "x", "create"]] });
		expect(restricted.effect(gone, "create")).toEqual({ effect: "deny" } satisfies Decision);
		const agentOnly = effectivePolicy({ ceiling: null, user: { restricted: false, grants: [] }, agent: { restricted: false, grants: rows } }, registry, providerOf);
		expect(agentOnly.effect(gone, "create")).toEqual({ effect: "ask", layers: ["agent"] } satisfies Decision);
		// A wildcard on a kind without wildcards: the same.
		const label = effectivePolicy({ ceiling: null, user: { restricted: true, grants: [ask(LABEL, ANY, ["create"])] }, agent: null }, registry, providerOf);
		expect(label.toJson()[1]).toMatchObject({ allows: [], asks: [[CONNECTION, LABEL, ANY, "create"]] });
	});

	test("an ask on an action a read needs denies it, as does any ask on a connector this engine lacks", async () => {
		const registry = await Registry.create([mixedConnector()]);
		const user = { restricted: false, grants: [ask(FOLDER, "inbox", ["read", "create"]), ask(FOLDER, "x", ["create"], { connectionId: "gone-provider" })] };
		const policy = effectivePolicy({ ceiling: null, user, agent: null }, registry, providerOf);
		expect(policy.toJson()[1]).toEqual({
			name: "user",
			restricted: false,
			allows: [[CONNECTION, FOLDER, "inbox", "create"]],
			denies: [
				[CONNECTION, FOLDER, "inbox", "read"],
				["gone-provider", FOLDER, "x", "create"],
			],
			asks: [[CONNECTION, FOLDER, "inbox", "create"]],
		});
		expect(policy.effect(resource(CONNECTION, FOLDER, "inbox"), "read")).toEqual({ effect: "deny" } satisfies Decision);
		expect(policy.effect(resource(CONNECTION, FOLDER, "archive"), "read")).toEqual({ effect: "allow" } satisfies Decision);
	});
});
