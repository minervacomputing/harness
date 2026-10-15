// The GitHub connector against an in-memory GitHub API behind an injected fetch, runs through the executor,
// and the token endpoint through the Workspace's refresh. Then the connector's own rules (inputs, cursors,
// files, 403s, records), and the registry with its fingerprints.

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { API_URL, Entry, Issue, Pull, Repository, forbidden, nextPage, USER_AGENT } from "../../src/connectors/github/client.ts";
import {
	type GitHubOptions,
	REPOSITORY,
	fileRecord,
	githubConnector,
	issueRecord,
	item,
	pageCursor,
	pageParams,
	pullRecord,
	repositoriesCursor,
	repositoryRecord,
} from "../../src/connectors/github/connector.ts";
import { EXPIRED } from "../../src/conversation/laravel-runs.ts";
import { type Connector, OperationError, type ProviderClient } from "../../src/gateway/connector.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { base64, utf8 } from "../../src/lib/bytes.ts";
import { EncryptionKeys } from "../../src/lib/encryption.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { percentDecode } from "../../src/lib/text.ts";
import { WorkspaceCore } from "../../src/workspace/core.ts";
import { type OAuth2, answerJson, tokenBody, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { oauthClients } from "../../src/workspace/env.ts";
import { connectionOut } from "../../src/workspace/out.ts";
import { Scenario, jsonResponse, userGrants } from "./executor-fakes.ts";
import {
	ADA,
	FakeConversations,
	FakeOAuth,
	binding,
	FakeObjects,
	FakeTimers,
	KEYS,
	SETTINGS,
	TokenEndpoint,
	USER,
	WORKSPACE,
	database,
	nodeSql,
	tokens,
} from "./workspace-support.ts";

const GITHUB = "0199a000-0000-7000-8000-0000000000a1";

type Data = { [key: string]: Json };

function repo(id: number, fullName: string, isPrivate = false): Data {
	return { id, full_name: fullName, private: isPrivate, default_branch: "main" };
}

function entry(path: string, kind = "file", content: Uint8Array | null = null, extra: Data = {}): Data {
	const data: Data = { type: kind, name: path.split("/").pop() as string, path, size: 0, ...extra };
	if (content !== null) Object.assign(data, { size: content.length, encoding: "base64", content: base64(content) });
	return data;
}

interface Sent {
	method: string;
	url: URL;
	headers: Headers;
	redirect: Request["redirect"];
	body: string;
}

/**
 * The GitHub REST API behind an injected fetch. The App is installed on acme
 * (acme/app, private acme/secret) and on ada (ada/notes, formerly ada/old-notes). acme/app has issues 1 and
 * 3, pull request 2, and some files.
 */
class FakeGitHub {
	readonly repos = new Map<number, Data>([
		[1, repo(1, "acme/app")],
		[2, repo(2, "acme/secret", true)],
		[3, repo(3, "ada/notes")],
	]);
	readonly installations = new Map<number, number[]>([
		[10, [1, 2]],
		[11, [3]],
	]);
	/** A renamed repository's Location, or null for a redirect without one. */
	readonly renamed = new Map<string, string | null>([["ada/old-notes", `${API_URL}/repositories/3`]]);
	/** The status GitHub redirects a renamed repository with. */
	renamedStatus = 301;
	readonly issues = new Map<number, Data[]>([
		[
			1,
			[
				{ number: 3, title: "Crash", state: "open", body: "x".repeat(30_000), comments: 2 },
				{ number: 2, title: "Fix crash", state: "open", pull_request: { url: "u" }, comments: 0 },
				{ number: 1, title: "Docs", state: "open", body: "Please", comments: 0 },
			],
		],
	]);
	readonly comments = new Map<string, Data[]>([
		[
			"1 3",
			[
				{ id: 7, body: "Same here", user: { login: "grace" } },
				{ id: 8, body: "+1" },
			],
		],
	]);
	readonly pull: Data = { number: 2, title: "Fix crash", state: "open", changed_files: 3, merged_at: null };
	readonly pullFiles: Data[] = [
		{ filename: "a.py", status: "modified", additions: 1, deletions: 1, patch: "a".repeat(30) },
		{ filename: "b.py", status: "added", additions: 5, deletions: 0, patch: "b".repeat(30) },
	];
	readonly contents: { [path: string]: Json } = {
		"": [entry("README.md"), entry("src", "dir")],
		"README.md": entry("README.md", "file", utf8("# App\nHello")),
		"src/za\u017c\u00f3\u0142\u0107.py": entry("src/za\u017c\u00f3\u0142\u0107.py", "file", utf8("print(1)\n")),
		"big.bin": { ...entry("big.bin"), size: 2_000_000, encoding: "none", content: "" },
		"logo.png": entry("logo.png", "file", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])),
		link: entry("link", "symlink", null, { target: "/etc/passwd" }),
		vendor: entry("vendor", "file", null, { submodule_git_url: "https://github.example/x/y.git" }),
	};
	readonly requests: Sent[] = [];
	readonly posts: Sent[] = [];
	/** Answers every request. */
	error: (() => Response) | null = null;
	/** Answers every POST. */
	refusePosts: (() => Response) | null = null;

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const sent: Sent = { method: request.method, url: new URL(request.url), headers: request.headers, redirect: request.redirect, body: await request.text() };
		this.requests.push(sent);
		if (sent.method === "POST") this.posts.push(sent);
		if (this.error !== null) return this.error();
		if (sent.method === "POST" && this.refusePosts !== null) return this.refusePosts();
		return this.#answer(sent) ?? jsonResponse(404, { message: "Not Found" });
	};

	#answer({ method, url, body }: Sent): Response | null {
		const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
		const params = url.searchParams;
		const [first, second, third, fourth, fifth] = parts;
		if (parts.length === 1 && first === "user") return jsonResponse(200, { id: 42, login: "ada" });
		if (parts.length === 2 && first === "user" && second === "installations") {
			return jsonResponse(200, { installations: [...this.installations.keys()].map((id) => ({ id })) });
		}
		if (parts.length === 4 && first === "user" && second === "installations" && fourth === "repositories") {
			const ids = this.installations.get(Number(third)) ?? [];
			const size = Number(params.get("per_page"));
			const start = (Number(params.get("page")) - 1) * size;
			return jsonResponse(200, { repositories: ids.slice(start, start + size).map((id) => this.repos.get(id) as Data) });
		}
		if (parts.length === 3 && first === "repos") {
			const full = `${second}/${third}`;
			const location = this.renamed.get(full);
			if (location !== undefined) return new Response(null, { status: this.renamedStatus, headers: location === null ? {} : { location } });
			const found = [...this.repos.values()].find((repository) => repository.full_name === full);
			return found === undefined ? null : jsonResponse(200, found);
		}
		if (first !== "repositories") return null;
		const repoId = Number(second);
		if (parts.length === 2) return this.repos.has(repoId) ? jsonResponse(200, this.repos.get(repoId)) : null;
		if (third === "issues" && parts.length === 3) {
			if (method === "POST") return jsonResponse(201, { number: 4, state: "open", ...(parseJson(body) as Data) });
			const issues = this.issues.get(repoId) ?? [];
			const page = Number(params.get("page") ?? "1");
			const size = Number(params.get("per_page"));
			const headers: { [name: string]: string } = {};
			if (page * size < issues.length) {
				const next = `${API_URL}/repositories/${second}/issues?per_page=${size}&after=Y3Vy%3D&page=${page + 1}`;
				headers.link = `<${next}>; rel="next", <${API_URL}/x?page=9>; rel="last"`;
			}
			return jsonResponse(200, issues.slice((page - 1) * size, page * size), headers);
		}
		if (third === "issues" && parts.length === 4) {
			const found = (this.issues.get(repoId) ?? []).find((issue) => issue.number === Number(fourth));
			return found === undefined ? null : jsonResponse(200, found);
		}
		if (third === "issues" && fifth === "comments" && parts.length === 5) {
			if (method === "POST") return jsonResponse(201, { id: 99, body: (parseJson(body) as Data).body as Json });
			return jsonResponse(200, this.comments.get(`${repoId} ${fourth}`) ?? []);
		}
		if (third === "pulls" && parts.length === 3) return jsonResponse(200, [this.pull]);
		if (third === "pulls" && fourth === "2" && parts.length === 4) return jsonResponse(200, this.pull);
		if (third === "pulls" && fourth === "2" && fifth === "files" && parts.length === 5) return jsonResponse(200, this.pullFiles);
		if (third === "contents") {
			const key = parts.slice(3).map(percentDecode).join("/");
			return Object.hasOwn(this.contents, key) ? jsonResponse(200, this.contents[key]) : null;
		}
		return null;
	}

	last(): Sent {
		return this.requests.at(-1) as Sent;
	}
}

/** The connector with no install link configured, and the test seams `options` sets. */
function connector(options: GitHubOptions = {}): Connector<ProviderClient> {
	return githubConnector({ appSlug: () => null, ...options }) as unknown as Connector<ProviderClient>;
}

function denyOnCeiling(resourceId: string, actions: string[]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: GITHUB, kind: REPOSITORY, resourceId, resourceName: "", actions, effect: "deny" };
}

/** Starts a run for an agent with the user's GitHub connection and `grants` (repository id to actions). */
function start(github: FakeGitHub, grants: { [id: string]: string[] }, options: { ceiling?: GrantRow[]; connector?: GitHubOptions } = {}): Promise<Scenario> {
	return Scenario.start({
		connectors: [connector(options.connector)],
		connections: [{ id: GITHUB, provider: "github", payload: { kind: "oauth2", access_token: "t", refresh_token: null, scopes: [] } }],
		user: userGrants(GITHUB, REPOSITORY, grants),
		ceiling: options.ceiling ?? [],
		fetch: github.fetch,
	});
}

function items(outcome: { result: { items: Data[] } }): Data[] {
	return outcome.result.items;
}

describe("the connector and its settings page", () => {
	test("account, discovery and names", async () => {
		const github = new FakeGitHub();
		const gh = githubConnector({ appSlug: () => null });
		const client = gh.client("token", settingsIo(github.fetch));
		expect(await gh.account(client)).toEqual({ id: "42", label: "ada" });
		expect(github.last().headers.get("authorization")).toBe("Bearer token");
		expect(github.last().headers.get("accept")).toBe("application/vnd.github+json");
		expect(github.last().headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(github.last().headers.get("user-agent")).toBe(USER_AGENT);
		const page = (cursor: string | null) => gh.discover(client, REPOSITORY, { query: null, cursor });
		const first = await page(null);
		expect(first.items.map((found) => [found.id, found.name])).toEqual([
			["1", "acme/app"],
			["2", "acme/secret (private)"],
		]);
		const second = await page(first.nextCursor ?? null);
		expect(second.items.map((found) => found.name)).toEqual(["ada/notes"]);
		expect(second.nextCursor).toBeNull();
		const found = await gh.discover(client, REPOSITORY, { query: "NOTES", cursor: null });
		expect(found.items.map((repository) => repository.id)).toEqual(["3"]);
		// An installation removed meanwhile is skipped, not the one after it.
		github.installations.delete(10);
		expect((await page(first.nextCursor ?? null)).items.map((repository) => repository.name)).toEqual(["ada/notes"]);
		expect((await page('{"installation": 10, "page": 2}')).items.map((repository) => repository.name)).toEqual(["ada/notes"]);
		github.installations.set(10, [1, 2]);
		for (const cursor of ["{}", '{"installation": 0, "page": 1}', "[1]", '{"installation": 11, "page": "1"}']) {
			await expect(page(cursor)).rejects.toMatchObject({ code: "INVALID_CURSOR", message: "This page token is invalid." });
		}
		expect(await gh.describe(client, REPOSITORY, ["3", "1", "404", "../x"])).toEqual({ "3": "ada/notes", "1": "acme/app" });
		// "../x" was never sent; "404" was, and GitHub did not find it.
		expect(github.requests.filter((sent) => sent.url.pathname.startsWith("/repositories/")).map((sent) => sent.url.pathname)).toEqual([
			"/repositories/3",
			"/repositories/1",
			"/repositories/404",
		]);
		// Ids that are not ASCII digits are never asked for.
		const before = github.requests.length;
		expect(await gh.describe(client, REPOSITORY, ["\u00b2", "\u0663", "", "-1", "1 "])).toEqual({});
		expect(github.requests.slice(before)).toEqual([]);
	});

	test("the install link needs a valid slug", () => {
		let slug: string | null = null;
		const gh = githubConnector({ appSlug: () => slug });
		expect(gh.manageLink?.()).toBeNull();
		slug = "minerva-dev";
		expect(gh.manageLink?.()).toEqual(["Choose repositories on GitHub", "https://github.com/apps/minerva-dev/installations/new"]);
		for (slug of ["evil.com/x", "", "Minerva", " minerva-dev", "a".repeat(101)]) expect(gh.manageLink?.()).toBeNull();
		// As the connection lists it, with the link where the user chooses repositories on GitHub.
		slug = "minerva-dev";
		const out = connectionOut(gh as unknown as Connector, { id: GITHUB, provider: "github", ownerId: USER, label: "ada", status: "active", createdAt: 0, scopes: [] }, []);
		expect([out.manageLabel, out.manageUrl, out.consentNeeded]).toEqual(["Choose repositories on GitHub", "https://github.com/apps/minerva-dev/installations/new", []]);
	});

	test("without a slug given, the link reads MINERVA_GITHUB_APP_SLUG from the Worker's bindings", () => {
		const env = (globalThis as unknown as { process: { env: { [name: string]: string | undefined } } }).process.env;
		const before = env.MINERVA_GITHUB_APP_SLUG;
		try {
			delete env.MINERVA_GITHUB_APP_SLUG;
			const gh = githubConnector();
			expect(gh.manageLink?.()).toBeNull();
			env.MINERVA_GITHUB_APP_SLUG = "minerva-dev";
			expect(gh.manageLink?.()?.[1]).toBe("https://github.com/apps/minerva-dev/installations/new");
		} finally {
			if (before === undefined) delete env.MINERVA_GITHUB_APP_SLUG;
			else env.MINERVA_GITHUB_APP_SLUG = before;
		}
	});

	test("GitHub is offered only when configured", async () => {
		// GitHub registers no client of its own, so it is offered once MINERVA_GITHUB_CLIENT_ID and _SECRET are
		// set (the part of the configuration the API's connector list reads).
		const auth = githubConnector().auth as OAuth2;
		expect(auth.app).toBe("github");
		expect(auth.registrationUrl ?? null).toBeNull();
		const keys = await EncryptionKeys.parse(KEYS);
		const clients = (env: { [name: string]: string }) => oauthClients(env as unknown as Env, keys).configured(auth.app);
		expect(clients({})).toBeNull();
		expect(clients({ MINERVA_GITHUB_CLIENT_ID: "", MINERVA_GITHUB_CLIENT_SECRET: "s" })).toBeNull();
		expect(clients({ MINERVA_GITHUB_CLIENT_ID: "Iv1.x", MINERVA_GITHUB_CLIENT_SECRET: "s" })).toEqual({ clientId: "Iv1.x", clientSecret: "s" });
	});
});

describe("runs", () => {
	test("repositories are listed and read by grant", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read"] });
		expect(items(await run.ok("github_list_repositories", {})).map((found) => found.full_name)).toEqual(["acme/app"]);
		const [repository] = items(await run.ok("github_get_repository", { repository: "acme/app" }));
		expect(repository?.default_branch).toBe("main");
		expect(github.last().url.pathname).toBe("/repositories/1");
		for (const name of ["acme/secret", "acme/missing"]) expect(await run.code("github_get_repository", { repository: name })).toBe("POLICY_DENIED");
		// The run's token, and never a redirect followed by fetch.
		expect(new Set(github.requests.map((sent) => sent.headers.get("authorization")))).toEqual(new Set(["Bearer t"]));
		expect(new Set(github.requests.map((sent) => sent.redirect))).toEqual(new Set(["manual"]));
	});

	test("a deny on one repository wins over the wildcard", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "*": ["read"] }, { ceiling: [denyOnCeiling("2", ["create", "read"])] });
		expect(items(await run.ok("github_list_repositories", {})).map((found) => found.id)).toEqual([1]);
		expect(await run.code("github_list_issues", { repository: "acme/secret" })).toBe("POLICY_DENIED");
	});

	test("a renamed repository is authorized by its id", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "3": ["read"] });
		expect(items(await run.ok("github_get_repository", { repository: "ada/old-notes" }))[0]?.full_name).toBe("ada/notes");
		// A redirect elsewhere, or to a repository that turns out to be another, is not followed.
		for (const location of ["https://evil.example/repositories/3", `${API_URL}/repositories/3/../1`, `${API_URL}/users/3`]) {
			github.renamed.set("ada/old-notes", location);
			expect(await run.error("github_get_repository", { repository: "ada/old-notes" })).toEqual({
				code: "PROVIDER_FAILED",
				message: "GitHub returned an unexpected response.",
			});
		}
		expect(github.requests.every((sent) => sent.url.origin === API_URL)).toBe(true);
		// An id in other digits, in the Location's UTF-8 or Latin-1, is not followed.
		const sent = github.requests.length;
		for (const location of [`${API_URL}/repositories/\u00d9\u00a3`, `${API_URL}/repositories/\u00b2`, `${API_URL}/repositories/\u00d9\u00a3\u00ff`]) {
			github.renamed.set("ada/old-notes", location);
			expect(await run.code("github_get_repository", { repository: "ada/old-notes" })).toBe("PROVIDER_FAILED");
		}
		expect(github.requests.slice(sent).map((request) => request.url.pathname)).toEqual(Array(3).fill("/repos/ada/old-notes"));
		// Any 3xx is judged as a redirect: one without a Location is unexpected, and a 304 to /repositories/<id>
		// is followed there too.
		github.renamed.set("ada/old-notes", null);
		expect(await run.error("github_get_repository", { repository: "ada/old-notes" })).toEqual({
			code: "PROVIDER_FAILED",
			message: "GitHub returned an unexpected response.",
		});
		github.renamed.set("ada/old-notes", `${API_URL}/repositories/3`);
		github.renamedStatus = 304;
		expect(items(await run.ok("github_get_repository", { repository: "ada/old-notes" }))[0]?.full_name).toBe("ada/notes");
		github.renamedStatus = 301;
		(github.repos.get(3) as Data).id = 1;
		expect(await run.code("github_get_repository", { repository: "ada/old-notes" })).toBe("PROVIDER_FAILED");
	});

	test("issues skip pull requests and page through GitHub's cursors", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read"] });
		const first = await run.ok("github_list_issues", { repository: "acme/app", limit: 2 });
		// The page held issue 3 and pull request 2.
		expect(items(first).map((issue) => issue.number)).toEqual([3]);
		expect(items(first)[0]).not.toHaveProperty("body");
		const request = github.last();
		expect(request.url.pathname).toBe("/repositories/1/issues");
		expect([request.url.searchParams.get("state"), request.url.searchParams.get("sort")]).toEqual(["open", "updated"]);
		const second = await run.ok("github_list_issues", { repository: "acme/app", limit: 2, cursor: first.result.next_cursor as string });
		expect(items(second).map((issue) => issue.number)).toEqual([1]);
		expect([github.last().url.searchParams.get("page"), github.last().url.searchParams.get("after")]).toEqual(["2", "Y3Vy="]);
		// The listing's parameters, then the cursor's.
		expect([...github.last().url.searchParams.keys()]).toEqual(["state", "sort", "direction", "per_page", "page", "after"]);
		expect(second.result).not.toHaveProperty("next_cursor");
		const limited = await start(github, { "1": ["read"] }, { connector: { maxPageResponse: 1000 } });
		expect(await limited.error("github_list_issues", { repository: "acme/app" })).toEqual({
			code: "PROVIDER_LIMIT",
			message: "GitHub returned more than Minerva reads at once.",
		});
	});

	test("reading an issue and a pull request", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read"] });
		const [issue] = items(await run.ok("github_get_issue", { repository: "acme/app", number: 3 })) as Data[];
		expect([(issue?.body as string).length, issue?.body_truncated]).toEqual([20_000, true]);
		expect((issue?.comment_list as Data[]).map((comment) => comment.body)).toEqual(["Same here", "+1"]);
		expect(issue?.comments_truncated).toBe(false);
		expect(await run.code("github_get_issue", { repository: "acme/app", number: 9 })).toBe("NOT_FOUND");

		const small = await start(github, { "1": ["read"] }, { connector: { maxPatchChars: 40 } });
		const [pull] = items(await small.ok("github_get_pull_request", { repository: "acme/app", number: 2 }));
		expect((pull?.files as Data[]).map((file) => [file.patch, file.patch_truncated])).toEqual([
			["a".repeat(30), false],
			["b".repeat(10), true],
		]);
		expect(pull?.files_truncated).toBe(true);
		const pulls = await run.ok("github_list_pull_requests", { repository: "acme/app", state: "all" });
		expect(items(pulls)[0]?.number).toBe(2);
	});

	test("reading files", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read"] });
		const read = async (path: string, extra: Data = {}) => items(await run.ok("github_read_file", { repository: "acme/app", path, ...extra }))[0] as Data;

		const top = await read("");
		expect((top.entries as Data[]).map((found) => found.path)).toEqual(["README.md", "src"]);
		expect(top.entries_truncated).toBe(false);
		const readme = await read("README.md", { max_chars: 5, ref: "v1.0" });
		expect([readme.text, readme.truncated]).toEqual(["# App", true]);
		expect(github.last().url.searchParams.get("ref")).toBe("v1.0");
		expect((await read("src/za\u017c\u00f3\u0142\u0107.py")).text).toBe("print(1)\n");
		expect(github.last().url.pathname.startsWith("/repositories/1/contents/src/za%C5%BC")).toBe(true);
		for (const [path, code] of [
			["big.bin", "FILE_TOO_LARGE"],
			["logo.png", "UNSUPPORTED_FILE"],
			["link", "UNSUPPORTED_FILE"],
			["vendor", "UNSUPPORTED_FILE"],
			["missing.txt", "NOT_FOUND"],
		]) {
			expect(await run.code("github_read_file", { repository: "acme/app", path: path as string })).toBe(code);
		}
		const sent = github.requests.length;
		const invalid: Data[] = [
			{ path: "../other/x" },
			{ path: "/etc/passwd" },
			{ path: "a//b" },
			{ path: "a/./b" },
			{ path: "a\tb" },
			{ path: "a\rb" },
			{ path: "README.md", ref: "../../x" },
			{ path: "README.md", ref: "-flag" },
			{ repository: "acme/.." },
			{ repository: "acme/app/extra" },
		];
		for (const args of invalid) {
			expect(await run.code("github_read_file", { repository: "acme/app", ...args }), JSON.stringify(args)).toBe("INVALID_ARGUMENTS");
		}
		expect(github.requests.length).toBe(sent);
	});

	test("writing needs create and sends one request", async () => {
		const github = new FakeGitHub();
		expect((await start(github, { "1": ["read"] })).tools).not.toContain("github_create_issue");
		const run = await start(github, { "1": ["read", "create"] });
		const created = await run.ok("github_create_issue", { repository: "acme/app", title: "Idea", body: "Details\nhere" });
		expect(items(created)[0]?.number).toBe(4);
		const [post] = github.posts;
		expect(post?.url.pathname).toBe("/repositories/1/issues");
		expect(parseJson(post?.body as string)).toEqual({ title: "Idea", body: "Details\nhere" });
		const commented = await run.ok("github_add_comment", { repository: "acme/app", number: 3, body: "Thanks" });
		expect([items(commented)[0]?.id, items(commented)[0]?.number]).toEqual([99, 3]);
		expect(github.posts.at(-1)?.url.pathname).toBe("/repositories/1/issues/3/comments");

		expect(await run.code("github_create_issue", { repository: "ada/notes", title: "x" })).toBe("POLICY_DENIED");
		expect(await run.code("github_create_issue", { repository: "acme/app", title: "two\nlines" })).toBe("INVALID_ARGUMENTS");
		expect(github.posts).toHaveLength(2);
		expect(run.writes().map((write) => write.status)).toEqual(["succeeded", "succeeded"]);
	});

	test("an issue asked for twice, whitespace aside, is opened once", async () => {
		// The write key is hashed from the normalized arguments: stripped, with the body's default.
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read", "create"] });
		const first = await run.ok("github_create_issue", { repository: "acme/app", title: "Idea" });
		const again = await run.ok("github_create_issue", { repository: " acme/app ", title: "Idea\n", body: null });
		expect([again.repeat, again.writeKey]).toEqual([true, first.writeKey]);
		expect(github.posts).toHaveLength(1);
		// An empty body is not sent.
		await run.ok("github_create_issue", { repository: "acme/app", title: "Other", body: "  " });
		expect(parseJson(github.posts.at(-1)?.body as string)).toEqual({ title: "Other" });
	});

	test("a write the App may not make is reported as not applied", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read", "create"] });
		github.refusePosts = () => jsonResponse(403, { message: "Resource not accessible by integration" });
		const refused = await run.error("github_create_issue", { repository: "acme/app", title: "x" });
		expect(refused).toEqual({
			code: "PROVIDER_FORBIDDEN",
			message: "The Minerva GitHub App may not do this here: it is not installed on this repository, or lacks the permission.",
		});
		github.refusePosts = null;
		expect(items(await run.ok("github_create_issue", { repository: "acme/app", title: "y" }))[0]?.title).toBe("y");
		expect(github.posts).toHaveLength(2);
		expect([run.paused(), run.writes().map((write) => write.status)]).toEqual([false, ["succeeded"]]);
	});

	test.each([
		["the primary limit", () => jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })],
		["a secondary limit", () => jsonResponse(403, { message: "You have exceeded a secondary rate limit." })],
		["429", () => jsonResponse(429, { message: "Too many" }, { "retry-after": "30" })],
	])("rate limits: %s", async (_, response) => {
		const github = new FakeGitHub();
		const run = await start(github, { "*": ["read"] });
		github.error = response;
		expect(await run.error("github_get_repository", { repository: "acme/app" })).toEqual({
			code: "PROVIDER_RATE_LIMITED",
			message: "GitHub is rate limiting requests. Try again later.",
		});
	});
});

describe("tokens", () => {
	test("GitHub's token responses", () => {
		const auth = githubConnector().auth as OAuth2;
		const creds = { clientId: "id", clientSecret: "secret", redirectUri: "https://minerva.example/api/oauth/github/callback" };
		const init = tokenRequest(auth, creds, [
			["code", "c"],
			["redirect_uri", creds.redirectUri],
			["grant_type", "authorization_code"],
			["code_verifier", "v"],
		]);
		const headers = new Headers(init.headers);
		// GitHub answers form-encoded unless asked for JSON.
		expect([headers.get("accept"), headers.get("content-type"), init.redirect]).toEqual(["application/json", "application/x-www-form-urlencoded", "manual"]);
		expect([...new URLSearchParams(init.body as string).keys()]).toEqual(["client_id", "client_secret", "code", "redirect_uri", "grant_type", "code_verifier"]);
		const now = Date.UTC(2026, 9, 11, 12, 0, 0);
		const body = tokenBody({ access_token: "a", refresh_token: "r", expires_in: 28800, scope: "" });
		expect(body === null ? null : tokenPayload(body, now)).toEqual({ kind: "oauth2", access_token: "a", refresh_token: "r", scopes: [], expires_at: now / 1000 + 28800 });
		// GitHub reports a refused code with HTTP 200.
		for (const text of [JSON.stringify({ error: "bad_verification_code" }), JSON.stringify({ token_type: "bearer" }), "access_token=a&scope="]) {
			expect(tokenBody(answerJson(utf8(text)))).toBeNull();
		}
	});

	async function workspace() {
		const sql = nodeSql(database());
		const keys = await EncryptionKeys.parse(KEYS);
		const oauth = new FakeOAuth();
		oauth.clients.set("github", { clientId: "id", clientSecret: "secret" });
		const endpoint = new TokenEndpoint();
		const timers = new FakeTimers();
		const logs: { message: string; fields: unknown }[] = [];
		const core = new WorkspaceCore({
			sql,
			timers,
			keys,
			registry: await Registry.create([connector()]),
			settings: SETTINGS,
			conversations: new FakeConversations(),
			objects: new FakeObjects(),
			oauth,
			fetch: endpoint.fetch,
			log: (message, fields) => logs.push({ message, fields }),
		});
		await core.init({ workspace: { id: WORKSPACE, jurisdiction: null }, kind: "personal", ownerId: USER, createdAt: timers.now() });
		// Tokens that expire now, with no scopes (the App has none).
		const saved = await core.saveConnection(ADA, {
			provider: "github",
			account: { id: "42", label: "ada" },
			credentials: { kind: "oauth2", access_token: "old", refresh_token: "r1", expires_at: Math.floor(timers.now() / 1000), scopes: [] },
			connectionId: null,
		});
		if (!saved.ok) throw new Error(saved.refusal.detail);
		const id = saved.value.id;
		const stored = async (): Promise<JsonObject> => {
			const row = sql.exec<{ ciphertext: string; key_version: string }>("SELECT ciphertext, key_version FROM connections WHERE id = ?", id)[0];
			return (await keys.decrypt(binding(id), { ciphertext: row?.ciphertext as string, version: row?.key_version as string })) as JsonObject;
		};
		const status = () => sql.exec<{ status: string }>("SELECT status FROM connections WHERE id = ?", id)[0]?.status;
		return { core, endpoint, keys, logs, id, stored, status };
	}

	test("a refused GitHub refresh needs reconnecting", async () => {
		const w = await workspace();
		w.endpoint.responses.push(tokens({ error: "bad_refresh_token" }));
		expect(await w.core.lease(w.id, { settings: ADA })).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		const [sent] = w.endpoint.sent;
		expect([sent?.url, sent?.headers.accept]).toEqual(["https://github.com/login/oauth/access_token", "application/json"]);
		expect(sent?.fields).toEqual({ client_id: "id", client_secret: "secret", grant_type: "refresh_token", refresh_token: "r1" });
		expect(w.status()).toBe("error");
	});

	test("a misconfigured client keeps the connection", async () => {
		const w = await workspace();
		w.endpoint.responses.push(tokens({ error: "incorrect_client_credentials" }));
		expect(await w.core.lease(w.id, { settings: ADA })).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: "GitHub could not refresh the connection." });
		expect((await w.stored()).refresh_token).toBe("r1");
		expect(w.status()).toBe("active");
		expect(w.logs.map((log) => log.fields)).toContainEqual(expect.objectContaining({ error: "incorrect_client_credentials" }));
		w.endpoint.responses.push(tokens({ access_token: "new", refresh_token: "r2", expires_in: 28800 }));
		const lease = await w.core.lease(w.id, { settings: ADA });
		if ("refused" in lease) throw new Error(lease.message);
		expect(((await w.keys.decrypt(binding(w.id), lease.sealed)) as JsonObject).access_token).toBe("new");
		expect((await w.stored()).refresh_token).toBe("r2");
		expect(w.status()).toBe("active");
	});
});

function failure(run: () => unknown): [string, string] | null {
	try {
		run();
		return null;
	} catch (error) {
		if (error instanceof OperationError) return [error.code, error.message];
		throw error;
	}
}

const INVALID: [string, string] = ["INVALID_CURSOR", "This page token is invalid."];

describe("the connector's rules", () => {
	const gh = githubConnector({ appSlug: () => null });

	test.each([
		["list_repositories", null, { limit: 30, cursor: null }],
		["list_repositories", { limit: 100, cursor: "  abc  " }, { limit: 100, cursor: "abc" }],
		["get_repository", { repository: "  acme/app\n" }, { repository: "acme/app" }],
		["get_repository", { repository: "acme/..." }, { repository: "acme/..." }],
		["list_issues", { repository: "acme/app", state: " closed " }, { repository: "acme/app", state: "closed", limit: 20, cursor: null }],
		["read_file", { repository: "acme/app" }, { repository: "acme/app", path: "", ref: null, max_chars: 20_000 }],
		["read_file", { repository: "acme/app", path: " src/a.py ", ref: "feature/x" }, { repository: "acme/app", path: "src/a.py", ref: "feature/x", max_chars: 20_000 }],
		["create_issue", { repository: "acme/app", title: "  Idea  " }, { repository: "acme/app", title: "Idea", body: null }],
		["create_issue", { repository: "acme/app", title: "x", body: "a\tb\r\nc" }, { repository: "acme/app", title: "x", body: "a\tb\r\nc" }],
	])("%s normalizes %j, which write keys and query hashes hash", async (name, input, expected) => {
		const op = gh.operations.find((candidate) => candidate.name === name);
		expect(await validateInput(op?.input as never, input)).toEqual({ ok: true, data: expected });
	});

	test.each([
		["list_repositories", { limit: true }],
		["list_repositories", { connection_id: "other" }],
		["list_repositories", "acme/app"],
		["get_repository", { repository: "acme/." }],
		["get_repository", { repository: "ac.me/app" }],
		["get_repository", { repository: "acme/\u00e1pp" }],
		["list_issues", { repository: "acme/app", state: "OPEN" }],
		["get_issue", { repository: "acme/app", number: 1_000_000_001 }],
		["get_issue", { repository: "acme/app", number: 9007199254740993 }],
		["read_file", { repository: "acme/app", path: "a/" }],
		["read_file", { repository: "acme/app", path: "README.md", ref: "main.lock" }],
		["read_file", { repository: "acme/app", path: "README.md", ref: "a b" }],
		["create_issue", { repository: "acme/app", title: "tab\there" }],
		["create_issue", { repository: "acme/app", title: "x", body: "a\u0000b" }],
		["add_comment", { repository: "acme/app", number: 3, body: "a\u007fb" }],
	])("%s refuses %j", async (name, input) => {
		const op = gh.operations.find((candidate) => candidate.name === name);
		expect(await validateInput(op?.input as never, input)).toMatchObject({ ok: false });
	});

	test("the Link header's next page: only its page and after", () => {
		const next = (link: string) => nextPage(new Response(null, { headers: { link } }));
		expect(next(`<${API_URL}/repositories/1/issues?per_page=2&after=Y3Vy%3D&page=2>; rel="next", <${API_URL}/x?page=9>; rel="last"`)).toEqual({
			page: "2",
			after: "Y3Vy=",
		});
		expect(next(`<${API_URL}/x?page=9>; rel="last", <https://elsewhere.example/x?page=4>;rel="next"`)).toEqual({ page: "4" });
		expect(next(`<${API_URL}/x?page=&after=a+b%2Bc>; rel="next"`)).toEqual({ after: "a b+c" });
		expect(next(`<${API_URL}/x?page=4&page=5>; rel="next"`)).toEqual({ page: "4" });
		for (const link of [`<${API_URL}/x?page=3>; rel="last"`, `<${API_URL}/x?per_page=2>; rel="next"`, `<${API_URL}/x#page=2?page=3>; rel="next"`, ""]) {
			expect(next(link), link).toBeNull();
		}
	});

	test("listing cursors hold a page number or GitHub's after, nothing else", () => {
		expect(pageParams(null)).toEqual({});
		expect(pageParams("{}")).toEqual({});
		expect(pageParams('{"after": "Y3Vy=", "page": "2"}')).toEqual({ after: "Y3Vy=", page: "2" });
		expect(pageParams('{"after": "a b"}')).toEqual({ after: "a b" });
		expect(pageParams(pageCursor({ page: "123456" }))).toEqual({ page: "123456" });
		for (const cursor of [
			'{"page": 2}',
			'{"page": ""}',
			'{"page": "1234567"}',
			'{"page": "\\u0663"}',
			'{"page": "1a"}',
			'{"after": "a\\u0000b"}',
			'{"after": "a\\u00a0b"}',
			'{"after": "a\\u200bb"}',
			'{"after": "\\ud800"}',
			`{"after": "${"x".repeat(501)}"}`,
			'{"x": "1"}',
			'{"__proto__": {"page": "1"}}',
			'{"\\u005f_proto__": {"page": "1"}}',
			'{"constructor": "1"}',
			'{"page": "1", "page": "x"}',
			"[1]",
			"null",
			"nope",
		]) {
			expect(failure(() => pageParams(cursor)), cursor).toEqual(INVALID);
		}
		expect([pageCursor(null), pageCursor({})]).toEqual([null, null]);
	});

	test("repository cursors name an installation and a page", () => {
		expect(repositoriesCursor(null)).toEqual([0, 1]);
		expect(repositoriesCursor('{"installation": 999999999999999, "page": 9999}')).toEqual([999999999999999, 9999]);
		for (const cursor of [
			'{"installation": 10}',
			'{"installation": 0, "page": 1}',
			'{"installation": 1000000000000000, "page": 1}',
			'{"installation": 5, "page": 10000}',
			'{"installation": 11, "page": "1"}',
			'{"installation": true, "page": 1}',
			'{"installation": 1.5, "page": 1}',
			'{"installation": 11, "page": 1, "extra": "x"}',
			'{"installation": 11, "page": 1, "__proto__": {"x": 1}}',
			'{"installation": 11, "page": 1, "\\u005f_proto__": {"x": 1}}',
			"[1]",
			"not json",
		]) {
			expect(failure(() => repositoriesCursor(cursor)), cursor).toEqual(INVALID);
		}
	});

	test("files: base64 text, and what is refused", () => {
		const file = (content: string | null, extra: Data = {}) => Entry.parse({ type: "file", path: "a.txt", size: 5, encoding: "base64", content, ...extra });
		expect(fileRecord(file("aGVs\nbG8=\n", { html_url: "u" }), 20)).toEqual({ path: "a.txt", type: "file", size: 5, text: "hello", truncated: false, url: "u" });
		expect(fileRecord(file("aGVsbG8="), 3)).toMatchObject({ text: "hel", truncated: true });
		// Unpadded base64 reads; a byte order mark is dropped; invalid UTF-8 reads as U+FFFD.
		expect(fileRecord(file("aGVsbG8"), 20).text).toBe("hello");
		expect(fileRecord(file("77u/aGk="), 20).text).toBe("hi");
		expect(fileRecord(file("//5hYg=="), 20).text).toBe("\ufffd\ufffdab");
		expect(fileRecord(file("8J+YgPCfmIDwn5iA"), 2)).toMatchObject({ text: "\u{1f600}", truncated: true });
		expect(failure(() => fileRecord(file("YQBi"), 20))).toEqual(["UNSUPPORTED_FILE", "This looks like a binary file. Minerva reads text files."]);
		for (const content of ["Y", "YQ\u00e9==", "YQ=a", "Y*Q="]) {
			expect(failure(() => fileRecord(file(content), 20)), content).toEqual(["PROVIDER_FAILED", "GitHub returned an unexpected response."]);
		}
		const tooLarge: [string, string] = ["FILE_TOO_LARGE", "Minerva reads files up to 1048576 bytes."];
		expect(failure(() => fileRecord(file("eA==", { size: 1_048_577 }), 20))).toEqual(tooLarge);
		expect(failure(() => fileRecord(file("", { encoding: "none" }), 20))).toEqual(tooLarge);
		expect(failure(() => fileRecord(file(null), 20))).toEqual(tooLarge);
		expect(failure(() => fileRecord(Entry.parse({ type: "dir", path: "src" }), 20))?.[0]).toBe("UNSUPPORTED_FILE");
	});

	test("bodies are strict UTF-8 JSON", async () => {
		const github = new FakeGitHub();
		const run = await start(github, { "1": ["read"] });
		const repository = utf8(JSON.stringify(repo(1, "acme/app")));
		github.error = () => new Response(Uint8Array.from([0xef, 0xbb, 0xbf, ...repository]), { status: 200 });
		expect(items(await run.ok("github_get_repository", { repository: "acme/app" }))[0]?.full_name).toBe("acme/app");
		github.error = () => new Response(Uint8Array.from([...repository.subarray(0, -2), 0xff, 0x7d]), { status: 200 });
		expect(await run.code("github_get_repository", { repository: "acme/app" })).toBe("PROVIDER_FAILED");
	});

	test("403s are worded from GitHub's message and headers", () => {
		const worded = (body: string, headers: { [name: string]: string } = {}) => {
			const error = forbidden("GitHub", new Response(body, { status: 403, headers }), body);
			return error.code === "PROVIDER_FORBIDDEN" && error.message.startsWith("The Minerva GitHub App") ? "APP" : error.code;
		};
		expect(worded('{"message": "API rate limit exceeded"}', { "x-ratelimit-remaining": "0" })).toBe("PROVIDER_RATE_LIMITED");
		expect(worded('{"message": "You have exceeded a secondary rate limit."}')).toBe("PROVIDER_RATE_LIMITED");
		expect(worded("{}", { "retry-after": "30" })).toBe("PROVIDER_RATE_LIMITED");
		expect(worded('{"message": "Resource not accessible by integration"}')).toBe("APP");
		for (const body of ['{"message": "Must have admin rights to Repository."}', "not json", '[{"message": "rate limit"}]', '{"message": {"detail": "rate limit"}}', ""]) {
			expect(worded(body), body).toBe("PROVIDER_FORBIDDEN");
		}
		expect(worded("{}", { "x-ratelimit-remaining": "1" })).toBe("PROVIDER_FORBIDDEN");
	});

	test("records", () => {
		const repository = Repository.parse({ id: 2, full_name: "acme/secret", private: true, open_issues_count: 4, extra: "dropped" });
		expect(repositoryRecord(repository)).toEqual({
			id: 2,
			full_name: "acme/secret",
			private: true,
			description: null,
			default_branch: null,
			open_issues_and_pull_requests: 4,
			archived: false,
			fork: false,
			pushed_at: null,
			url: null,
		});
		expect(item(repository)).toEqual({ id: "2", name: "acme/secret (private)" });
		const issue = Issue.parse({ number: 2, title: "Fix", state: "open", pull_request: { url: "u" }, labels: [{ name: "bug" }], user: { login: "ada" } });
		expect(issueRecord(issue)).toMatchObject({ number: 2, type: "pull_request", author: "ada", labels: ["bug"] });
		expect(issueRecord(issue, { body: true })).toMatchObject({ body: null, body_truncated: false });
		const pull = Pull.parse({ number: 2, state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "fix" }, base: null });
		expect(pullRecord(pull)).toMatchObject({ state: "merged", head: "fix", base: null, author: null });
		expect(Issue.safeParse({ number: "2" }).success).toBe(false);
	});
});

describe("the registry", () => {
	// What each tool means, as runs snapshot it. A change here stops the tool in running runs
	// (OPERATION_CHANGED), so it is made on purpose: update these when a declaration or zod changes.
	const FINGERPRINTS = {
		list_repositories: "15126dda5c25df94",
		get_repository: "2819e5401dcbfe65",
		list_issues: "1772913a9c711556",
		get_issue: "53512dd25c3b9b5e",
		list_pull_requests: "1772913a9c711556",
		get_pull_request: "53512dd25c3b9b5e",
		read_file: "f7a743fcde5c31e9",
		create_issue: "c600aaad2ee965f1",
		add_comment: "5352384c953c11af",
	};

	test("accepts GitHub's declarations, and prints their fingerprints", async () => {
		const gh = githubConnector({ appSlug: () => null });
		const registry = await Registry.create([gh]);
		const fingerprints = Object.fromEntries(gh.operations.map((op) => [op.name, registry.contract("github", op.name)]));
		console.info(`github fingerprints:\n${Object.entries(fingerprints).map(([name, value]) => `  github_${name}  ${value}`).join("\n")}`);
		expect(fingerprints).toEqual(FINGERPRINTS);
		// The test seams change no contract.
		const seams = githubConnector({ appSlug: () => "x", maxPageResponse: 1, maxPatchChars: 1, baseUrl: "https://github.example/api" });
		const other = await Registry.create([seams]);
		for (const op of gh.operations) expect(other.contract("github", op.name)).toBe(fingerprints[op.name]);
	});

	test("the Worker's registry serves GitHub", async () => {
		const registry = await Registry.create(CONNECTORS);
		expect(registry.find("github")?.operations.map((op) => op.name)).toEqual([
			"list_repositories",
			"get_repository",
			"list_issues",
			"get_issue",
			"list_pull_requests",
			"get_pull_request",
			"read_file",
			"create_issue",
			"add_comment",
		]);
	});
});
