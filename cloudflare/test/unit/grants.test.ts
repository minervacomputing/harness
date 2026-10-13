// Layers and grants, the pure parts (gateway/grants.ts): wildcards, connections that act on their account,
// the limit on grants, wildcards on kinds without them, and the validation of access settings. The provider's `describe` step between the checks
// and the plan belongs to the API (step 5).

import { describe, expect, test } from "vitest";
import type { GrantChange, GrantRow } from "../../src/contracts/policy.ts";
import { ACCOUNT_KIND } from "../../src/gateway/connector.ts";
import {
	DEFAULT_RESTRICTED,
	InvalidGrants,
	MAX_GRANTS_PER_CONNECTION,
	allowedActions,
	checkChanges,
	effectivePolicy,
	enforceable,
	planGrantChanges,
	resourceKey,
} from "../../src/gateway/grants.ts";
import { ANY, resource } from "../../src/gateway/policy.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { FOLDER, LABEL, keyedConnector, mixedConnector } from "./fakes.ts";

const CONNECTION = "0199a000-0000-7000-8000-000000000001";
const USER = "0199a000-0000-7000-8000-0000000000aa";
const mixed = mixedConnector();

function grant(kind: string, resourceId: string, actions: string[], extra: Partial<GrantRow> = {}): GrantRow {
	return { layer: "user", subject: USER, connectionId: CONNECTION, kind, resourceId, resourceName: "", actions, effect: "allow", ...extra };
}

function change(kind: string, id: string, actions: string[]): GrantChange {
	return { kind, id, actions };
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
		let rows: GrantRow[] = [];
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
		expect(saved.upserts).toEqual([{ kind: FOLDER, resourceId: "archive", actions: ["create"], resourceName: "Archive" }]);
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
		expect(plan.upserts).toEqual([{ kind: FOLDER, resourceId: "inbox", actions: ["create", "read"], resourceName: "Inbox" }]);
		expect(planGrantChanges(mixed, [], [change(FOLDER, "ghost", [])], names())).toEqual({ upserts: [], deletes: [], state: new Map() });
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
			{ name: "ceiling", restricted: DEFAULT_RESTRICTED.ceiling, allows: [], denies: [] },
			{ name: "user", restricted: DEFAULT_RESTRICTED.user, allows: [], denies: [] },
			{ name: "agent", restricted: DEFAULT_RESTRICTED.agent, allows: [], denies: [] },
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
			{ ceiling: { restricted: false, grants: [grant(LABEL, ANY, ["read"], { layer: "ceiling", subject: null, effect: "deny" })] }, user: { restricted: false, grants: [] }, agent: null },
			registry,
			providerOf,
		);
		expect(denied.permitsAny(CONNECTION, LABEL, "read")).toBe(false);
		expect(denied.permitsAny(CONNECTION, FOLDER, "read")).toBe(true);
	});
});

test("allowed actions: one user's or every user's allow grants on the connection", () => {
	const rows = [
		grant(FOLDER, "inbox", ["read"]),
		grant(FOLDER, "archive", ["create", "read"], { subject: "someone-else" }),
		grant(FOLDER, "secret", ["read", "create"], { effect: "deny" }),
		grant(LABEL, "red", ["read"], { connectionId: "other" }),
		grant(FOLDER, "x", ["create"], { layer: "agent", subject: "agent" }),
	];
	expect(allowedActions(rows, CONNECTION, USER)).toEqual(new Set(["read"]));
	expect(allowedActions(rows, CONNECTION, null)).toEqual(new Set(["read", "create"]));
});
