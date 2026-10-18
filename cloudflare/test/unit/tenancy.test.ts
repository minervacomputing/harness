// Connection policies (src/gateway/tenancy.ts): the admission table, and the compile and the executor under a policy,
// per tenancy, with the fakes of executor-fakes.ts. GitHub's owners, with a transfer, are in connectors-github.test.ts.

import { describe, expect, test } from "vitest";
import { ACCOUNT_KIND, type Connector } from "../../src/gateway/connector.ts";
import { createExecutor } from "../../src/gateway/executor.ts";
import { resource } from "../../src/gateway/policy.ts";
import { type ConnectionPolicy, admission, inTenants } from "../../src/gateway/tenancy.ts";
import { FOLDER, FakeServer, KEYED, MIXED, Scenario, type ScenarioConnection, keyedConnection, keyedConnector, mixedConnection, mixedConnector, userGrants } from "./executor-fakes.ts";

const tenants = async () => ({});

function policyOf(...connectors: [string, string[] | null][]): ConnectionPolicy {
	return { revision: 1, connectors: connectors.map(([provider, listed]) => ({ provider, tenants: listed })) };
}

/** The fakes, with the keyed connector's account in one tenant and the mixed connector's folders each in one. */
function connectors(server: FakeServer): Connector[] {
	return [
		{ ...mixedConnector(server), tenancy: { kind: "resource", label: "Fake site", tenants } } as Connector,
		{ ...keyedConnector(server), tenancy: { kind: "account", label: "Fake workspace" } } as Connector,
	];
}

describe("admission", () => {
	const server = new FakeServer();
	const [byResource, byAccount] = connectors(server) as [Connector, Connector];
	const unknown = mixedConnector(server) as unknown as Connector;

	test("no policy admits every connection, as before", () => {
		for (const policy of [undefined, null]) {
			for (const connector of [byResource, byAccount, unknown]) expect(admission(policy, connector, null)).toEqual({ admitted: true, tenants: null });
		}
	});

	test("a connector the policy does not list is refused, whatever its tenant", () => {
		const policy = policyOf(["other", null]);
		for (const connector of [byResource, byAccount, unknown]) expect(admission(policy, connector, "acme")).toEqual({ admitted: false });
	});

	test("any tenant admits every connection of a listed connector", () => {
		for (const connector of [byResource, byAccount, unknown]) {
			expect(admission(policyOf([connector.slug, null]), connector, null)).toEqual({ admitted: true, tenants: null });
		}
	});

	test("a list admits an account in a listed tenant only, never one without a tenant", () => {
		const policy = policyOf(["keyed", ["acme", "beta"]]);
		expect(admission(policy, byAccount, "beta")).toEqual({ admitted: true, tenants: null });
		for (const tenant of ["evil", "ACME", "", null, undefined]) expect(admission(policy, byAccount, tenant)).toEqual({ admitted: false });
	});

	test("a list limits a connector with a tenant per resource, whatever the account's tenant", () => {
		const policy = policyOf(["mixed", ["acme"]]);
		for (const tenant of ["evil", null]) expect(admission(policy, byResource, tenant)).toEqual({ admitted: true, tenants: ["acme"] });
		expect(admission(policyOf(["mixed", []]), byResource, null)).toEqual({ admitted: true, tenants: [] });
	});

	test("a list refuses a connector whose tenancy is unknown", () => {
		expect(admission(policyOf(["mixed", ["acme"]]), unknown, "acme")).toEqual({ admitted: false });
	});

	test("a resource is in the tenants only when it names a listed one", () => {
		const inAcme = { ...resource(MIXED, FOLDER, "inbox"), tenant: "acme" };
		expect(inTenants(null, resource(MIXED, FOLDER, "inbox"))).toBe(true);
		expect(inTenants(["acme"], inAcme)).toBe(true);
		expect(inTenants(["beta"], inAcme)).toBe(false);
		expect(inTenants(["acme"], resource(MIXED, FOLDER, "inbox"))).toBe(false);
	});
});

/** A run of a user who may read every folder and the keyed account, under `policy`. */
function start(server: FakeServer, policy: ConnectionPolicy | undefined, options: { keyedTenant?: string | null; byResource?: boolean } = {}) {
	const keyed: ScenarioConnection = { ...keyedConnection(), tenant: options.keyedTenant ?? null };
	return Scenario.start({
		connectors: options.byResource === false ? [mixedConnector(server), connectors(server)[1] as Connector] : connectors(server),
		connections: [mixedConnection(), keyed],
		user: [...userGrants(MIXED, FOLDER, { "*": ["read", "create"] }), ...userGrants(KEYED, ACCOUNT_KIND, { [KEYED]: ["read"] })],
		fetch: server.fetch,
		...(policy ? { policy } : {}),
	});
}

/** The fake's folders, each in a site: inbox and archive in acme, secret in evil. */
function sited(server: FakeServer): FakeServer {
	server.tenantOf = (folder) => (folder === "secret" ? "evil" : "acme");
	return server;
}

describe("a run under a policy", () => {
	test("without a policy the snapshot and the calls are as before", async () => {
		const server = sited(new FakeServer());
		const run = await start(server, undefined);
		expect(run.snapshot.tenants).toBeUndefined();
		expect(run.tools).toEqual(expect.arrayContaining(["mixed_list_folders", "keyed_whoami"]));
		expect(run.snapshot.connectionIds).toEqual([MIXED, KEYED]);
		expect((await run.ok("mixed_list_folders", {})).result.count).toBe(3);
	});

	test("an account in a listed tenant is admitted; one in another, or with none, is not offered", async () => {
		const server = sited(new FakeServer());
		const admitted = await start(server, policyOf(["mixed", null], ["keyed", ["acme"]]), { keyedTenant: "acme" });
		expect(admitted.tools).toContain("keyed_whoami");
		expect((await admitted.ok("keyed_whoami", {})).result.count).toBe(1);
		for (const tenant of ["evil", null]) {
			const refused = await start(server, policyOf(["mixed", null], ["keyed", ["acme"]]), { keyedTenant: tenant });
			expect(refused.tools.filter((name) => name.startsWith("keyed"))).toEqual([]);
			expect(refused.snapshot.connectionIds).toEqual([MIXED]);
			expect(await refused.code("keyed_whoami", {})).toBe("UNKNOWN_OPERATION");
		}
	});

	test("a connector the policy leaves out is not offered", async () => {
		const run = await start(sited(new FakeServer()), policyOf(["keyed", null]));
		expect(run.tools.filter((name) => name.startsWith("mixed"))).toEqual([]);
		expect(run.snapshot.connectionIds).toEqual([KEYED]);
	});

	test("a resource of a listed tenant is used; one of another is refused at the call and dropped from results", async () => {
		const server = sited(new FakeServer());
		const run = await start(server, policyOf(["mixed", ["acme"]], ["keyed", null]));
		expect(run.snapshot.tenants).toEqual({ [MIXED]: ["acme"] });
		expect((await run.ok("mixed_copy_file", { source: "inbox", dest: "archive", name: "a" })).result.count).toBe(1);
		for (const args of [
			{ source: "secret", dest: "archive", name: "b" },
			{ source: "inbox", dest: "secret", name: "c" },
		]) {
			expect(await run.error("mixed_copy_file", args)).toEqual({ code: "POLICY_DENIED", message: "Your organization does not allow this Fake site." });
		}
		expect(server.posts()).toBe(1);
		expect((await run.ok("mixed_list_folders", {})).result.items.map((item) => item.id)).toEqual(["inbox", "archive"]);
	});

	test("the grants' refusal comes first: the tenant is named only for what the run may otherwise use", async () => {
		const server = sited(new FakeServer());
		const run = await Scenario.start({
			connectors: connectors(server),
			connections: [mixedConnection()],
			user: userGrants(MIXED, FOLDER, { inbox: ["read"], archive: ["read", "create"], secret: ["read"] }),
			fetch: server.fetch,
			policy: policyOf(["mixed", ["acme"]]),
		});
		const DENIED = { code: "POLICY_DENIED", message: "This resource or action is not available under the current permissions." };
		// No grant could allow creating in secret, nor in inbox: neither reveals secret's site.
		expect(await run.error("mixed_copy_file", { source: "inbox", dest: "secret", name: "a" })).toEqual(DENIED);
		expect(await run.error("mixed_copy_file", { source: "secret", dest: "inbox", name: "a" })).toEqual(DENIED);
		// Reading secret is granted, so its site is why the call is refused.
		expect(await run.error("mixed_copy_file", { source: "secret", dest: "archive", name: "a" })).toEqual({
			code: "POLICY_DENIED",
			message: "Your organization does not allow this Fake site.",
		});
		expect(server.posts()).toBe(0);
	});

	test("an empty list allows no resource", async () => {
		const server = sited(new FakeServer());
		const run = await start(server, policyOf(["mixed", []], ["keyed", null]));
		expect(run.snapshot.tenants).toEqual({ [MIXED]: [] });
		expect((await run.ok("mixed_list_folders", {})).result).toEqual({ items: [], count: 0 });
		expect(await run.code("mixed_copy_file", { source: "inbox", dest: "archive", name: "a" })).toBe("POLICY_DENIED");
	});

	test("a connector whose tenancy is unknown is refused under a list and admitted under any", async () => {
		const server = new FakeServer();
		const listed = await start(server, policyOf(["mixed", ["acme"]], ["keyed", null]), { byResource: false });
		expect(listed.tools.filter((name) => name.startsWith("mixed"))).toEqual([]);
		const any = await start(server, policyOf(["mixed", null], ["keyed", null]), { byResource: false });
		expect(any.snapshot.tenants).toBeUndefined();
		expect((await any.ok("mixed_list_folders", {})).result.count).toBe(3);
	});
});

test("a snapshot whose tenants cannot be read never calls a tool", async () => {
	const server = new FakeServer();
	const run = await start(server, policyOf(["mixed", ["acme"]], ["keyed", null]));
	const context = (tenants: unknown) => ({
		runId: run.runId,
		userId: run.snapshot.userId,
		permissions: run.snapshot.permissions,
		tools: run.snapshot.tools,
		run: run.state,
		credentials: run.credentials,
		fetch: server.fetch,
		tenants: tenants as { [connectionId: string]: string[] },
	});
	const host = { registry: run.registry, secretKey: "test-secret-not-a-real-key", waitUntil: () => {} };
	expect(() => createExecutor(context(run.snapshot.tenants), host)).not.toThrow();
	for (const malformed of [null, [], { [MIXED]: "acme" }, { [MIXED]: [""] }, { [MIXED]: [7] }]) {
		expect(() => createExecutor(context(malformed), host)).toThrow("The snapshot's tenants are malformed.");
	}
});
