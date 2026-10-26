// The settings calls Laravel makes with a credential it holds (src/internal/connections.ts), against a fake GitHub reached
// through `PROVIDER_NETWORK`.

import type { ConnectionPolicy } from "@minerva/contract/internal";
import { afterEach, describe, expect, test } from "vitest";
import { PROVIDER_NETWORK } from "../../src/internal/providers.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { commands, refusalOf, scope, signedAssertions } from "./internal-support.ts";

signedAssertions();

const defaultNetwork = PROVIDER_NETWORK.fetch;
afterEach(() => {
	PROVIDER_NETWORK.fetch = defaultNetwork;
});

/** GitHub's `GET /user`, answered by `answer`, and its App's installations, on the user and on `example`; the tokens it saw are recorded. */
function fakeGitHub(answer: () => Response): string[] {
	const seen: string[] = [];
	PROVIDER_NETWORK.fetch = () => async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		seen.push(request.headers.get("Authorization") ?? "");
		if (request.method === "GET" && request.url === "https://api.github.com/user") return answer();
		if (request.method === "GET" && request.url.startsWith("https://api.github.com/user/installations?")) {
			return Response.json({ installations: [{ id: 7, account: { id: 900, login: "example" } }, { id: 8, account: { id: 583231, login: "octocat" } }] });
		}
		throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
	};
	return seen;
}

function describeAccount(provider = "github", kind: "oauth2" | "api_key" | "builtin" = "oauth2", within = scope()) {
	return commands.describeAccount({ scope: within, connection: { id: uuid7(), provider }, credential: { kind, secret: "gho_token", generation: 1 } });
}

describe("describeAccount", () => {
	test("the account behind the credential: its stable id and label, and for GitHub's tenant per resource the owners it reaches", async () => {
		const seen = fakeGitHub(() => Response.json({ id: 583231, login: "octocat" }));
		expect(await describeAccount()).toEqual({
			outcome: "described",
			account: {
				id: "583231",
				label: "octocat",
				tenant: null,
				tenants: [
					{ id: "900", name: "example" },
					{ id: "583231", name: "octocat" },
				],
			},
		});
		expect(seen).toEqual(["Bearer gho_token", "Bearer gho_token"]);
	});

	test("a connector with a tenant per account answers it; one of unknown tenancy answers none", async () => {
		PROVIDER_NETWORK.fetch = () => async (input, init) => {
			const request = new Request(input as RequestInfo, init as RequestInit);
			if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ sub: "108", email: "ada@example.com", hd: "Example.com" });
			if (request.url === "https://api.todoist.com/api/v1/user") return Response.json({ id: "7", full_name: "Ada" });
			throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
		};
		expect(await describeAccount("google_calendar")).toEqual({
			outcome: "described",
			account: { id: "108", label: "ada@example.com", tenant: "example.com", tenants: [{ id: "example.com", name: "example.com" }] },
		});
		expect(await describeAccount("todoist")).toEqual({ outcome: "described", account: { id: "7", label: "Ada", tenant: null } });
	});

	test("a credential the provider refuses is CREDENTIAL_REFUSED; another failure PROVIDER_FAILED", async () => {
		fakeGitHub(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
		expect(await describeAccount()).toMatchObject({ outcome: "refused", code: "CREDENTIAL_REFUSED" });
		fakeGitHub(() => new Response("upstream", { status: 502 }));
		expect(await describeAccount()).toMatchObject({ outcome: "refused", code: "PROVIDER_FAILED" });
	});

	test("a key the provider refuses is CREDENTIAL_REFUSED, also where the connector words the refusal itself (Stripe)", async () => {
		PROVIDER_NETWORK.fetch = () => async () => Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
		const refused = await commands.describeAccount({ scope: scope(), connection: { id: uuid7(), provider: "stripe" }, credential: { kind: "api_key", secret: "rk_test_0123456789abcdef", generation: 1 } });
		expect(refused).toEqual({ outcome: "refused", code: "CREDENTIAL_REFUSED", message: "Stripe did not accept this key." });
	});

	test("an unknown connector is NOT_FOUND, a credential of another kind VALIDATION_FAILED, another environment WRONG_ENVIRONMENT", async () => {
		const seen = fakeGitHub(() => Response.json({ id: 1, login: "octocat" }));
		expect(await refusalOf(describeAccount("nothing"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(await refusalOf(describeAccount("github", "api_key"))).toMatchObject({
			code: "VALIDATION_FAILED",
			status: 422,
			data: { issues: [{ path: ["credential", "kind"] }] },
		});
		expect(await refusalOf(describeAccount("github", "oauth2", { ...scope(), environment: "staging" }))).toMatchObject({ code: "WRONG_ENVIRONMENT", status: 409 });
		expect(seen).toEqual([]);
	});
});

/** A fake GitHub of one installation with two repositories, the second hidden from `describe`. Requests are recorded. */
function fakeRepositories(options: { status?: number } = {}): string[] {
	const seen: string[] = [];
	const repositories = [
		{ id: 101, full_name: "example/app", owner: { id: 900, login: "example" }, private: true },
		{ id: 102, full_name: "example/site", owner: { id: 900, login: "example" }, private: false },
	];
	PROVIDER_NETWORK.fetch = () => async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		seen.push(`${request.method} ${url.pathname}`);
		if (options.status !== undefined) return Response.json({ message: "No" }, { status: options.status });
		if (url.pathname === "/user") return Response.json({ id: 583231, login: "octocat" });
		if (url.pathname === "/user/installations") return Response.json({ total_count: 1, installations: [{ id: 7 }] });
		if (url.pathname === "/user/installations/7/repositories") return Response.json({ total_count: 2, repositories });
		if (url.pathname === "/repositories/101") return Response.json(repositories[0]);
		if (url.pathname.startsWith("/repositories/")) return Response.json({ message: "Not Found" }, { status: 404 });
		throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
	};
	return seen;
}

const credential = { kind: "oauth2" as const, secret: "gho_token", generation: 3 };

function listResources(fields: { kind?: string; query?: string | null; parent?: string | null; cursor?: string | null } = {}) {
	return commands.listResources({
		scope: scope(),
		connection: { id: uuid7(), provider: "github" },
		credential,
		kind: fields.kind ?? "repository",
		query: fields.query ?? null,
		parent: fields.parent ?? null,
		cursor: fields.cursor ?? null,
	});
}

describe("listResources", () => {
	test("a kind's resources and a search", async () => {
		fakeRepositories();
		expect(await listResources()).toEqual({
			outcome: "listed",
			items: [
				{ id: "101", name: "example/app (private)", expandable: false },
				{ id: "102", name: "example/site", expandable: false },
			],
			next: null,
		});
		expect(await listResources({ query: "SITE" })).toEqual({ outcome: "listed", items: [{ id: "102", name: "example/site", expandable: false }], next: null });
	});

	test("a kind not declared, and a parent where nothing is browsed, are VALIDATION_FAILED; a page token not its own INVALID_CURSOR", async () => {
		const seen = fakeRepositories();
		expect(await refusalOf(listResources({ kind: "folder" }))).toMatchObject({ code: "VALIDATION_FAILED", data: { issues: [{ path: ["kind"] }] } });
		expect(await refusalOf(listResources({ parent: "101" }))).toMatchObject({ code: "VALIDATION_FAILED", data: { issues: [{ path: ["parent"] }] } });
		expect(seen).toEqual([]);
		expect(await listResources({ cursor: "not ours" })).toMatchObject({ outcome: "refused", code: "INVALID_CURSOR" });
	});

	test("a refused credential is CREDENTIAL_REFUSED, another failure PROVIDER_FAILED", async () => {
		fakeRepositories({ status: 401 });
		expect(await listResources()).toMatchObject({ outcome: "refused", code: "CREDENTIAL_REFUSED" });
		fakeRepositories({ status: 502 });
		expect(await listResources()).toMatchObject({ outcome: "refused", code: "PROVIDER_FAILED" });
	});
});

type Grant = { connection: string; kind: string; resource: string; name: string; actions: string[]; effect: "allow" | "deny" | "ask" };

function checkGrantEdit(connection: string, grants: Grant[], changes: { kind: string; id: string; actions: string[]; ask?: string[] }[], secret = "gho_token") {
	return commands.checkGrantEdit({
		scope: scope(),
		connection: { id: connection, provider: "github" },
		credential: { ...credential, secret },
		layer: { level: "user", subject: "42", restricted: true, revision: 4, grants },
		changes,
	});
}

describe("checkGrantEdit", () => {
	test("a repository allowed is named by the provider; other connections' grants and denies are kept in place", async () => {
		const seen = fakeRepositories();
		const connection = uuid7();
		const other: Grant = { connection: uuid7(), kind: "repository", resource: "*", name: "", actions: ["read"], effect: "allow" };
		const deny: Grant = { connection, kind: "repository", resource: "102", name: "example/site", actions: ["create"], effect: "deny" };
		expect(await checkGrantEdit(connection, [other, deny], [{ kind: "repository", id: "101", actions: ["read"] }])).toEqual({
			outcome: "valid",
			grants: [other, deny, { connection, kind: "repository", resource: "101", name: "example/app (private)", actions: ["read"], effect: "allow" }],
		});
		expect(seen).toEqual(["GET /repositories/101"]);
	});

	test("every repository, and an action that requires another, sorted after the kept grants", async () => {
		const seen = fakeRepositories();
		const connection = uuid7();
		const stored: Grant = { connection, kind: "repository", resource: "101", name: "example/app (private)", actions: ["read"], effect: "allow" };
		expect(await checkGrantEdit(connection, [stored], [{ kind: "repository", id: "*", actions: ["create", "read"] }])).toEqual({
			outcome: "valid",
			grants: [
				{ connection, kind: "repository", resource: "*", name: "", actions: ["create", "read"], effect: "allow" },
				stored,
			],
		});
		// Neither `*` nor a resource already allowed asks the provider.
		expect(await checkGrantEdit(connection, [stored], [{ kind: "repository", id: "101", actions: ["create", "read"] }])).toMatchObject({ outcome: "valid" });
		expect(seen).toEqual([]);
	});

	test("removals never call the provider, so they work with any credential", async () => {
		const seen = fakeRepositories({ status: 401 });
		const connection = uuid7();
		const stored: Grant = { connection, kind: "repository", resource: "101", name: "example/app (private)", actions: ["read"], effect: "allow" };
		expect(await checkGrantEdit(connection, [stored], [{ kind: "repository", id: "101", actions: [] }], "")).toEqual({ outcome: "valid", grants: [] });
		expect(seen).toEqual([]);
	});

	test("a repository allowed under a blank name is not new, so narrowing it never calls the provider", async () => {
		const seen = fakeRepositories({ status: 401 });
		const connection = uuid7();
		const stored: Grant = { connection, kind: "repository", resource: "101", name: "", actions: ["create", "read"], effect: "allow" };
		expect(await checkGrantEdit(connection, [stored], [{ kind: "repository", id: "101", actions: ["read"] }], "")).toEqual({
			outcome: "valid",
			grants: [{ ...stored, actions: ["read"] }],
		});
		expect(seen).toEqual([]);
	});

	test("a repository the account cannot see, an action without what it requires, and a change GitHub cannot take are invalid", async () => {
		fakeRepositories();
		const connection = uuid7();
		expect(await checkGrantEdit(connection, [], [{ kind: "repository", id: "102", actions: ["read"] }])).toEqual({
			outcome: "invalid",
			message: "Choose a repository that the connected account can see.",
		});
		expect(await checkGrantEdit(connection, [], [{ kind: "repository", id: "101", actions: ["create"] }])).toMatchObject({ outcome: "invalid" });
		expect(await checkGrantEdit(connection, [], [{ kind: "issue", id: "1", actions: ["read"] }])).toMatchObject({ outcome: "invalid" });
	});

	test("two grants on one repository are kept as one with both's actions; a layer over its limit is invalid", async () => {
		fakeRepositories();
		const connection = uuid7();
		const read: Grant = { connection, kind: "repository", resource: "101", name: "example/app (private)", actions: ["read"], effect: "allow" };
		const answer = await checkGrantEdit(connection, [read, { ...read, name: "", actions: ["create"] }], [{ kind: "repository", id: "*", actions: ["read"] }]);
		expect(answer).toEqual({
			outcome: "valid",
			grants: [
				{ connection, kind: "repository", resource: "*", name: "", actions: ["read"], effect: "allow" },
				{ ...read, actions: ["create", "read"] },
			],
		});
		const full = Array.from({ length: 10_000 }, (_, i): Grant => ({ connection: uuid7(), kind: "repository", resource: String(i), name: "", actions: ["read"], effect: "allow" }));
		expect(await checkGrantEdit(connection, full, [{ kind: "repository", id: "*", actions: ["read"] }])).toEqual({ outcome: "invalid", message: "A layer can have at most 10,000 permissions." });
	});

	test("asked actions become an ask row after the resource's allow row, stored rows of one resource merged, other grants kept in place", async () => {
		const seen = fakeRepositories();
		const connection = uuid7();
		const other: Grant = { connection: uuid7(), kind: "repository", resource: "*", name: "", actions: ["create"], effect: "ask" };
		const deny: Grant = { connection, kind: "repository", resource: "102", name: "example/site", actions: ["create"], effect: "deny" };
		const app = { connection, kind: "repository", resource: "101", name: "example/app (private)" };
		const allowed: Grant = { ...app, actions: ["create", "read"], effect: "allow" };
		const asked: Grant = { ...app, name: "", actions: ["create"], effect: "ask" };
		const every = { connection, kind: "repository", resource: "*", name: "" };
		expect(await checkGrantEdit(connection, [asked, other, deny, allowed], [{ kind: "repository", id: "*", actions: ["create", "read"], ask: ["create"] }])).toEqual({
			outcome: "valid",
			grants: [
				other,
				deny,
				{ ...every, actions: ["read"], effect: "allow" },
				{ ...every, actions: ["create"], effect: "ask" },
				{ ...app, actions: ["read"], effect: "allow" },
				{ ...app, actions: ["create"], effect: "ask" },
			],
		});
		expect(seen).toEqual([]);
		// A repository newly asked before is named by the provider, as one allowed is; allowing what was asked drops the ask.
		expect(await checkGrantEdit(connection, [], [{ kind: "repository", id: "101", actions: ["read", "create"], ask: ["create"] }])).toEqual({
			outcome: "valid",
			grants: [
				{ ...app, actions: ["read"], effect: "allow" },
				{ ...app, actions: ["create"], effect: "ask" },
			],
		});
		expect(seen).toEqual(["GET /repositories/101"]);
		expect(await checkGrantEdit(connection, [allowed, asked], [{ kind: "repository", id: "101", actions: ["create", "read"] }])).toEqual({ outcome: "valid", grants: [allowed] });
	});

	test("an ask before reading, or before an action the change does not allow, is invalid without a request", async () => {
		const seen = fakeRepositories();
		expect(await checkGrantEdit(uuid7(), [], [{ kind: "repository", id: "101", actions: ["read"], ask: ["read"] }])).toEqual({
			outcome: "invalid",
			message: "GitHub cannot ask before Read code, issues and pull requests; it is needed to read.",
		});
		expect(await checkGrantEdit(uuid7(), [], [{ kind: "repository", id: "101", actions: ["read"], ask: ["create"] }])).toEqual({
			outcome: "invalid",
			message: "GitHub cannot ask before Open issues and comment without allowing it.",
		});
		expect(seen).toEqual([]);
	});

	test("a Web site is named by its pattern without a request; an action sites do not have, or a host with no domain, is invalid", async () => {
		const sent: string[] = [];
		PROVIDER_NETWORK.fetch = () => async (input) => {
			sent.push(String(input));
			throw new TypeError("The Web names sites without a request.");
		};
		const connection = uuid7();
		const edit = (actions: string[], id = "*.python.org") =>
			commands.checkGrantEdit({
				scope: scope(),
				connection: { id: connection, provider: "web" },
				credential: { kind: "builtin", secret: "", generation: 1 },
				layer: { level: "agent", subject: uuid7(), restricted: false, revision: 1, grants: [] },
				changes: [{ kind: "site", id, actions }],
			});
		expect(await edit(["browse"])).toEqual({
			outcome: "valid",
			grants: [{ connection, kind: "site", resource: "*.python.org", name: "python.org, including subdomains", actions: ["browse"], effect: "allow" }],
		});
		for (const actions of [["read"], ["search"]]) expect(await edit(actions), actions[0]).toMatchObject({ outcome: "invalid" });
		for (const id of ["co.uk", "github.io"]) expect(await edit(["browse"], id), id).toMatchObject({ outcome: "invalid" });
		expect(sent).toEqual([]);
	});

	test("a refused credential is CREDENTIAL_REFUSED", async () => {
		fakeRepositories({ status: 401 });
		expect(await checkGrantEdit(uuid7(), [], [{ kind: "repository", id: "101", actions: ["read"] }])).toMatchObject({ outcome: "refused", code: "CREDENTIAL_REFUSED" });
	});
});

describe("under a connection policy", () => {
	/** A fake GitHub of one installation holding example's (900) repository 101 and partner's (777) 103. Requests are recorded. */
	function fakeOwners(): { seen: string[]; transfer: (id: number, owner: { id: number; login: string }) => void } {
		const seen: string[] = [];
		const repositories = [
			{ id: 101, full_name: "example/app", owner: { id: 900, login: "example" }, private: true },
			{ id: 103, full_name: "partner/tool", owner: { id: 777, login: "partner" }, private: false },
		];
		PROVIDER_NETWORK.fetch = () => async (input, init) => {
			const request = new Request(input as RequestInfo, init as RequestInit);
			const url = new URL(request.url);
			seen.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/user/installations") return Response.json({ total_count: 1, installations: [{ id: 7 }] });
			if (url.pathname === "/user/installations/7/repositories") return Response.json({ total_count: 2, repositories });
			const found = repositories.find((repository) => url.pathname === `/repositories/${repository.id}`);
			if (found) return Response.json(found);
			throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
		};
		const transfer = (id: number, owner: { id: number; login: string }) => {
			const found = repositories.find((repository) => repository.id === id) as (typeof repositories)[number];
			Object.assign(found, { owner, full_name: `${owner.login}/${found.full_name.split("/")[1]}` });
		};
		return { seen, transfer };
	}

	const owners = (...tenants: string[]) => ({ revision: 2, connectors: [{ provider: "github", tenants }] });
	const offersOnly = (provider: string) => ({ revision: 2, connectors: [{ provider, tenants: null }] });

	function list(policy: ConnectionPolicy, provider = "github", cursor: string | null = null, query: string | null = null) {
		return commands.listResources({
			scope: scope(),
			connection: { id: uuid7(), provider, tenant: null },
			credential: provider === "github" ? credential : { kind: "builtin", secret: "", generation: 1 },
			kind: provider === "github" ? "repository" : "site",
			query,
			parent: null,
			cursor,
			policy,
		});
	}

	function edit(connection: string, grants: Grant[], changes: { kind: string; id: string; actions: string[] }[], policy: ConnectionPolicy) {
		return commands.checkGrantEdit({
			scope: scope(),
			connection: { id: connection, provider: "github", tenant: null },
			credential,
			layer: { level: "ceiling", subject: null, restricted: true, revision: 4, grants },
			changes,
			policy,
		});
	}

	const NOT_ALLOWED = { outcome: "refused", code: "CONNECTION_NOT_ALLOWED", message: "Your organization does not allow this connection." };

	test("listResources leaves out the repositories of owners it does not allow, and refuses a connector it does not offer", async () => {
		const { seen } = fakeOwners();
		expect(await list(owners("900"))).toEqual({ outcome: "listed", items: [{ id: "101", name: "example/app (private)", expandable: false }], next: null });
		expect(await list(offersOnly("github"))).toMatchObject({ outcome: "listed", items: [{ id: "101" }, { id: "103" }] });
		seen.length = 0;
		expect(await list(offersOnly("notion"))).toEqual(NOT_ALLOWED);
		expect(seen).toEqual([]);
	});

	test("the Web is listed and allowed by domain", async () => {
		const sent: string[] = [];
		PROVIDER_NETWORK.fetch = () => async (input) => {
			sent.push(String(input));
			throw new TypeError("The Web lists and names sites without a request.");
		};
		const domains = (...tenants: string[]) => ({ revision: 2, connectors: [{ provider: "web", tenants }] });
		expect(await list(domains("wikipedia.org"), "web", null, "https://en.wikipedia.org/wiki/Owl")).toEqual({
			outcome: "listed",
			items: [
				{ id: "en.wikipedia.org", name: "en.wikipedia.org", expandable: false },
				{ id: "*.en.wikipedia.org", name: "en.wikipedia.org, including subdomains", expandable: false },
				{ id: "*.wikipedia.org", name: "wikipedia.org, including subdomains", expandable: false },
			],
			next: null,
		});
		expect(await list(domains("wikipedia.org"), "web", null, "example.com")).toEqual({ outcome: "listed", items: [], next: null });
		const connection = uuid7();
		const edit = (id: string) =>
			commands.checkGrantEdit({
				scope: scope(),
				connection: { id: connection, provider: "web", tenant: null },
				credential: { kind: "builtin", secret: "", generation: 1 },
				layer: { level: "user", subject: uuid7(), restricted: true, revision: 1, grants: [] },
				changes: [{ kind: "site", id, actions: ["browse"] }],
				policy: domains("wikipedia.org"),
			});
		for (const id of ["en.wikipedia.org", "*.wikipedia.org", "*"]) expect(await edit(id), id).toMatchObject({ outcome: "valid" });
		expect(await edit("example.com")).toEqual({ outcome: "refused", code: "TENANT_NOT_ALLOWED", message: "Your organization does not allow the domain of example.com." });
		expect(await edit("*.wikipedia.org.example.com")).toEqual({
			outcome: "refused",
			code: "TENANT_NOT_ALLOWED",
			message: "Your organization does not allow the domain of wikipedia.org.example.com, including subdomains.",
		});
		expect(sent).toEqual([]);
	});

	test("listResources keeps the page token of a page whose every item it leaves out, so the next page is reached", async () => {
		const seen: string[] = [];
		const installations = [
			{ id: 7, repositories: [{ id: 103, full_name: "partner/tool", owner: { id: 777, login: "partner" }, private: false }] },
			{ id: 8, repositories: [{ id: 101, full_name: "example/app", owner: { id: 900, login: "example" }, private: true }] },
		];
		PROVIDER_NETWORK.fetch = () => async (input, init) => {
			const url = new URL(new Request(input as RequestInfo, init as RequestInit).url);
			seen.push(url.pathname);
			if (url.pathname === "/user/installations") return Response.json({ total_count: 2, installations: installations.map(({ id }) => ({ id })) });
			const found = installations.find(({ id }) => url.pathname === `/user/installations/${id}/repositories`);
			if (found) return Response.json({ total_count: found.repositories.length, repositories: found.repositories });
			throw new TypeError(`Unexpected request ${url}`);
		};
		const first = await list(owners("900"));
		expect(first).toEqual({ outcome: "listed", items: [], next: expect.any(String) });
		expect(await list(owners("900"), "github", (first as { next: string }).next)).toEqual({
			outcome: "listed",
			items: [{ id: "101", name: "example/app (private)", expandable: false }],
			next: null,
		});
		expect(seen.filter((path) => path.endsWith("/repositories"))).toEqual(["/user/installations/7/repositories", "/user/installations/8/repositories"]);
	});

	test("a connection of a connector with a tenant per account is admitted by the tenant Laravel sends with it", async () => {
		const seen: string[] = [];
		PROVIDER_NETWORK.fetch = () => async (input, init) => {
			const request = new Request(input as RequestInfo, init as RequestInit);
			const url = new URL(request.url);
			seen.push(url.pathname);
			if (url.origin === "https://www.googleapis.com" && url.pathname === "/calendar/v3/users/me/calendarList") {
				return Response.json({ items: [{ id: "ada@example.com", summary: "Ada", accessRole: "owner" }] });
			}
			throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
		};
		const policy = { revision: 2, connectors: [{ provider: "google_calendar", tenants: ["example.com"] }] };
		const connection = uuid7();
		const calendar = (tenant: string | null) => ({ id: connection, provider: "google_calendar", tenant });
		const listed = (tenant: string | null) =>
			commands.listResources({ scope: scope(), connection: calendar(tenant), credential, kind: "calendar", query: null, parent: null, cursor: null, policy });
		const edited = (tenant: string | null, actions: string[]) =>
			commands.checkGrantEdit({
				scope: scope(),
				connection: calendar(tenant),
				credential,
				layer: { level: "user", subject: "42", restricted: true, revision: 1, grants: [{ connection, kind: "calendar", resource: "*", name: "", actions: ["read"], effect: "allow" }] },
				changes: [{ kind: "calendar", id: "*", actions }],
				policy,
			});
		expect(await listed("example.com")).toEqual({ outcome: "listed", items: [{ id: "ada@example.com", name: "Ada", expandable: false }], next: null });
		expect(await edited("example.com", ["create", "read"])).toMatchObject({ outcome: "valid", grants: [{ connection, kind: "calendar", resource: "*", actions: ["create", "read"] }] });
		expect(seen).toEqual(["/calendar/v3/users/me/calendarList"]);
		for (const tenant of ["other.example", null]) {
			expect(await listed(tenant)).toEqual(NOT_ALLOWED);
			expect(await edited(tenant, ["create", "read"])).toEqual(NOT_ALLOWED);
			// Removals are always valid.
			expect(await edited(tenant, [])).toEqual({ outcome: "valid", grants: [] });
		}
		expect(seen).toHaveLength(1);
	});

	test("checkGrantEdit refuses another owner's repository as TENANT_NOT_ALLOWED, also one transferred since it was allowed; removals stay valid", async () => {
		const { seen, transfer } = fakeOwners();
		const connection = uuid7();
		expect(await edit(connection, [], [{ kind: "repository", id: "101", actions: ["read"] }], owners("900"))).toMatchObject({ outcome: "valid" });
		expect(await edit(connection, [], [{ kind: "repository", id: "103", actions: ["read"] }], owners("900"))).toEqual({
			outcome: "refused",
			code: "TENANT_NOT_ALLOWED",
			message: "Your organization does not allow the GitHub owner of partner/tool.",
		});
		// Every repository: the calls it covers are checked.
		expect(await edit(connection, [], [{ kind: "repository", id: "*", actions: ["read"] }], owners("900"))).toMatchObject({ outcome: "valid" });
		// example transfers its repository to partner: an edit that keeps the grant allows it again, so it is refused.
		transfer(101, { id: 777, login: "partner" });
		const stored: Grant = { connection, kind: "repository", resource: "101", name: "example/app (private)", actions: ["read"], effect: "allow" };
		expect(await edit(connection, [stored], [{ kind: "repository", id: "101", actions: ["create", "read"] }], owners("900"))).toEqual({
			outcome: "refused",
			code: "TENANT_NOT_ALLOWED",
			message: "Your organization does not allow the GitHub owner of example/app (private).",
		});
		seen.length = 0;
		expect(await edit(connection, [stored], [{ kind: "repository", id: "101", actions: [] }], owners("900"))).toEqual({ outcome: "valid", grants: [] });
		expect(await edit(connection, [stored], [{ kind: "repository", id: "101", actions: [] }], offersOnly("notion"))).toEqual({ outcome: "valid", grants: [] });
		expect(seen).toEqual([]);
		expect(await edit(connection, [], [{ kind: "repository", id: "*", actions: ["read"] }], offersOnly("notion"))).toEqual(NOT_ALLOWED);
	});
});
