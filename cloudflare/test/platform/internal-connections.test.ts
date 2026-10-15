// The settings calls Laravel makes with a credential it holds (src/internal/connections.ts), against a fake GitHub reached
// through `PROVIDER_NETWORK`.

import { afterEach, describe, expect, test } from "vitest";
import { PROVIDER_NETWORK } from "../../src/internal/providers.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { commands, refusalOf, scope, signedAssertions } from "./internal-support.ts";

signedAssertions();

const defaultNetwork = PROVIDER_NETWORK.fetch;
afterEach(() => {
	PROVIDER_NETWORK.fetch = defaultNetwork;
});

/** GitHub's `GET /user`, answered by `answer`; the tokens it saw are recorded. */
function fakeGitHub(answer: () => Response): string[] {
	const seen: string[] = [];
	PROVIDER_NETWORK.fetch = () => async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		if (request.method !== "GET" || request.url !== "https://api.github.com/user") throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
		seen.push(request.headers.get("Authorization") ?? "");
		return answer();
	};
	return seen;
}

function describeAccount(provider = "github", kind: "oauth2" | "api_key" | "builtin" = "oauth2", within = scope()) {
	return commands.describeAccount({ scope: within, connection: { id: uuid7(), provider }, credential: { kind, secret: "gho_token", generation: 1 } });
}

describe("describeAccount", () => {
	test("the account behind the credential: its stable id and label, and no tenant yet", async () => {
		const seen = fakeGitHub(() => Response.json({ id: 583231, login: "octocat" }));
		expect(await describeAccount()).toEqual({ outcome: "described", account: { id: "583231", label: "octocat", tenant: null } });
		expect(seen).toEqual(["Bearer gho_token"]);
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
		{ id: 101, full_name: "example/app", private: true },
		{ id: 102, full_name: "example/site", private: false },
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

function listResources(fields: { kind?: string; query?: string | null; parent?: string | null; cursor?: string | null; connection?: string; builtin?: string } = {}) {
	return commands.listResources({
		scope: scope(),
		connection: { id: fields.connection ?? uuid7(), provider: fields.builtin ?? "github" },
		credential: fields.builtin === undefined ? credential : { kind: "builtin", secret: "", generation: 1 },
		kind: fields.kind ?? "repository",
		query: fields.query ?? null,
		parent: fields.parent ?? null,
		cursor: fields.cursor ?? null,
	});
}

describe("listResources", () => {
	test("a kind's resources, a search, and the account itself (the Web's)", async () => {
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
		const connection = uuid7();
		expect(await listResources({ kind: "account", connection, builtin: "web" })).toEqual({ outcome: "listed", items: [{ id: connection, name: "Web", expandable: false }], next: null });
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

type Grant = { connection: string; kind: string; resource: string; name: string; actions: string[]; effect: "allow" | "deny" };

function checkGrantEdit(connection: string, grants: Grant[], changes: { kind: string; id: string; actions: string[] }[], secret = "gho_token") {
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

	test("the account is named by the provider's account", async () => {
		const connection = uuid7();
		const answer = await commands.checkGrantEdit({
			scope: scope(),
			connection: { id: connection, provider: "web" },
			credential: { kind: "builtin", secret: "", generation: 1 },
			layer: { level: "agent", subject: uuid7(), restricted: false, revision: 1, grants: [] },
			changes: [{ kind: "account", id: connection, actions: ["search"] }],
		});
		expect(answer).toEqual({ outcome: "valid", grants: [{ connection, kind: "account", resource: connection, name: "Web", actions: ["search"], effect: "allow" }] });
	});

	test("a refused credential is CREDENTIAL_REFUSED", async () => {
		fakeRepositories({ status: 401 });
		expect(await checkGrantEdit(uuid7(), [], [{ kind: "repository", id: "101", actions: ["read"] }])).toMatchObject({ outcome: "refused", code: "CREDENTIAL_REFUSED" });
	});
});
