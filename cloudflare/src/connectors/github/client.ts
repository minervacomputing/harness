// GitHub's REST API (v3), as a GitHub App acting for a user.
// Repositories are addressed by id (`/repositories/{id}`), so a rename between two requests cannot change
// which repository a request reaches. Responses are validated before use.
//
// What changes from Python:
// - GitHub's 403 is worded from its body, which `forbidden` cannot read here (its response is read
//   synchronously), so `classify` words every 403 instead; it sees the same headers and body. The body is
//   UTF-8 with invalid bytes replaced, where Python's `response.json()` refused such a body and so ignored
//   its message.
// - Response models are zod's objects with defaults; unknown fields are dropped, as with Pydantic's
//   `extra="ignore"`. Pydantic's lax coercions (a number sent as a string, 1 for true) are not made: such a
//   response is an unexpected one.
// - Pagination's Link header and the base64 of file contents are read with Python's own rules (`re`'s `\s`,
//   `urlsplit`, `parse_qs`, non-validating `b64decode`), so a cursor and a file read as they did in Python. A
//   redirect's Location is decoded as httpx decodes headers. (A Link header that is not ASCII failed every
//   listing in Python, whose `bounded` re-encodes kept headers as ASCII; here it is read as Latin-1.)

import { z } from "zod";
import type { OperationErrorShape, ProviderClient, ProviderIo, ProviderRequest } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP, defaultForbidden } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { isDict, type Json, parseJson } from "../../lib/json.ts";
import { parseQs, quoteSegment, urlsplitStrict } from "../../lib/urlsplit.ts";

export const API_URL = "https://api.github.com";
/** The largest file GitHub returns inline, and room for its base64 encoding in the JSON around it. */
export const MAX_INLINE_FILE = 1024 * 1024;
export const MAX_CONTENTS_RESPONSE = 2 * 1024 * 1024;
/** A page of issues, pull requests or changed files, whose bodies and diffs can be large. */
export const MAX_PAGE_RESPONSE = 10 * 1024 * 1024;

const PROVIDER = "GitHub";

/** `quote(value, safe="")` (lib/urlsplit.ts). */
export const segment = quoteSegment;

/** A JSON value as text: a string as it is, anything else as JSON. */
function textOf(value: Json): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** JSON's text from bytes as `json.loads` reads them: UTF-8, a byte order mark skipped, invalid UTF-8 refused. */
function jsonText(bytes: Uint8Array): string {
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	return fromUtf8Strict(bytes.subarray(start));
}

/** The `message` of a JSON object body, as `str(response.json().get("message", ""))`; "" for any other body. */
function messageOf(body: string): string {
	let data: Json;
	try {
		data = parseJson(body.startsWith("\ufeff") ? body.slice(1) : body);
	} catch {
		return "";
	}
	if (!isDict(data)) return "";
	return Object.hasOwn(data, "message") ? textOf(data.message as Json) : "";
}

/** GitHub reports rate limits, and what the App may not do, as 403 (client.py `forbidden`). */
export function forbidden(provider: string, response: Response, body: string): OperationErrorShape {
	const message = messageOf(body).toLowerCase();
	if (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") || message.includes("rate limit")) {
		return new OperationError("PROVIDER_RATE_LIMITED", `${provider} is rate limiting requests. Try again later.`);
	}
	if (message.includes("not accessible by integration")) {
		return new OperationError(
			"PROVIDER_FORBIDDEN",
			"The Minerva GitHub App may not do this here: it is not installed on this repository, or lacks the permission.",
		);
	}
	return defaultForbidden(provider);
}

/** Every 403 is worded by `forbidden`; other statuses keep their meaning. */
function classify(provider: string, response: Response, body: string): OperationErrorShape | null {
	return response.status === 403 ? forbidden(provider, response, body) : null;
}

// Models (client.py): what GitHub returns, with Pydantic's defaults. A dict is a JSON object.

const dict = z.custom<{ [key: string]: Json }>((value) => isDict(value));

export const User = z.object({
	id: z.int(),
	login: z.string().default(""),
});

const Owner = z.object({
	login: z.string().default(""),
});

export const Repository = z.object({
	id: z.int(),
	full_name: z.string(),
	owner: Owner.nullable().default(null),
	private: z.boolean().default(false),
	description: z.string().nullable().default(null),
	default_branch: z.string().nullable().default(null),
	html_url: z.string().nullable().default(null),
	open_issues_count: z.int().nullable().default(null),
	archived: z.boolean().default(false),
	fork: z.boolean().default(false),
	pushed_at: z.string().nullable().default(null),
});
export type Repository = z.output<typeof Repository>;

const Installation = z.object({ id: z.int() });
const Installations = z.object({ installations: z.array(Installation).default(() => []) });
const InstallationRepositories = z.object({ repositories: z.array(Repository).default(() => []) });

const Label = z.object({ name: z.string().default("") });

export const Issue = z.object({
	number: z.int(),
	title: z.string().default(""),
	state: z.string().default(""),
	body: z.string().nullable().default(null),
	user: Owner.nullable().default(null),
	labels: z.array(Label).default(() => []),
	comments: z.int().default(0),
	created_at: z.string().nullable().default(null),
	updated_at: z.string().nullable().default(null),
	closed_at: z.string().nullable().default(null),
	html_url: z.string().nullable().default(null),
	pull_request: dict.nullable().default(null),
});
export type Issue = z.output<typeof Issue>;

export const Comment = z.object({
	id: z.int(),
	body: z.string().nullable().default(null),
	user: Owner.nullable().default(null),
	created_at: z.string().nullable().default(null),
	html_url: z.string().nullable().default(null),
});
export type Comment = z.output<typeof Comment>;

const Branch = z.object({ ref: z.string().default("") });

export const Pull = z.object({
	number: z.int(),
	title: z.string().default(""),
	state: z.string().default(""),
	body: z.string().nullable().default(null),
	user: Owner.nullable().default(null),
	draft: z.boolean().default(false),
	merged_at: z.string().nullable().default(null),
	head: Branch.nullable().default(null),
	base: Branch.nullable().default(null),
	created_at: z.string().nullable().default(null),
	updated_at: z.string().nullable().default(null),
	html_url: z.string().nullable().default(null),
	changed_files: z.int().nullable().default(null),
	additions: z.int().nullable().default(null),
	deletions: z.int().nullable().default(null),
});
export type Pull = z.output<typeof Pull>;

export const PullFile = z.object({
	filename: z.string(),
	status: z.string().default(""),
	additions: z.int().default(0),
	deletions: z.int().default(0),
	patch: z.string().nullable().default(null),
});
export type PullFile = z.output<typeof PullFile>;

export const Entry = z.object({
	type: z.string(),
	name: z.string().default(""),
	path: z.string().default(""),
	size: z.int().default(0),
	encoding: z.string().nullable().default(null),
	content: z.string().nullable().default(null),
	submodule_git_url: z.string().nullable().default(null),
	html_url: z.string().nullable().default(null),
});
export type Entry = z.output<typeof Entry>;

/** `Entry | list[Entry]`: a file, or a directory's entries. */
const Contents = z.union([Entry, z.array(Entry)]);

/** One page of a listing, and GitHub's next page as the query parameters its Link header names (null on the last). */
export interface Page<T> {
	items: T[];
	next: { [key: string]: string } | null;
}

/** A repository id in a redirect: 1 to 20 ASCII digits. */
const ID = /^\d{1,20}$/u;
const NEXT_LINK = /<([^>]+)>;\s*rel="next"/u;

/** client.py `_next`: the `page` and `after` of the Link header's next page, or null. */
export function nextPage(response: Response): { [key: string]: string } | null {
	const match = NEXT_LINK.exec(response.headers.get("link") ?? "");
	if (match === null) return null;
	const query = parseQs(urlsplitStrict(match[1] as string).query);
	const next: { [key: string]: string } = {};
	for (const key of ["page", "after"]) {
		const values = query.get(key);
		if (values !== undefined && values.length > 0) next[key] = values[0] as string;
	}
	return Object.keys(next).length > 0 ? next : null;
}

const LATIN_1 = /^[\u0000-\u00ff]*$/;
const ASCII = /^[\u0000-\u007f]*$/;

/**
 * A response header as httpx reads it: every header's bytes as ASCII, else as UTF-8 if all of them are
 * valid UTF-8, else as Latin-1. `fetch` gives each byte of a value as one character; a value with a
 * character beyond Latin-1 was already decoded, and is read as it is. ProviderHTTP has dropped
 * Content-Encoding and Content-Length, which httpx would weigh too; only one that is not ASCII could
 * change the outcome.
 */
export function httpxHeader(headers: Headers, name: string): string | null {
	const value = headers.get(name);
	if (value === null) return null;
	const texts: string[] = [];
	headers.forEach((item, key) => texts.push(key, item));
	if (texts.every((text) => ASCII.test(text)) || !texts.every((text) => LATIN_1.test(text))) return value;
	const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
	try {
		for (const text of texts) fromUtf8Strict(bytes(text));
	} catch {
		return value;
	}
	return fromUtf8Strict(bytes(value));
}

export interface GitHubClientOptions {
	baseUrl?: string;
	/** MAX_PAGE_RESPONSE; tests lower it, as Python's monkeypatch did. */
	maxPageResponse?: number;
}

/**
 * Thin client for the GitHub REST API, as a GitHub App acting for a user. Repositories are addressed by id
 * (`/repositories/{id}`), so a rename between two requests cannot change which repository a request
 * reaches. Responses are validated before use.
 */
export class GitHubClient implements ProviderClient {
	readonly http: ProviderHTTP;
	readonly #baseUrl: string;
	readonly #maxPageResponse: number;

	constructor(accessToken: string, io: ProviderIo, options: GitHubClientOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? API_URL).replace(/\/+$/, "");
		this.#maxPageResponse = options.maxPageResponse ?? MAX_PAGE_RESPONSE;
		this.http = new ProviderHTTP(io, {
			provider: PROVIDER,
			baseUrl: this.#baseUrl,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			classify,
		});
	}

	close(): Promise<void> {
		return this.http.close();
	}

	#validate<T>(schema: z.ZodType<T>, data: Json): T {
		const result = schema.safeParse(data);
		if (!result.success) throw this.http.unexpected(result.error);
		return result.data;
	}

	/** A response's body as JSON; one that does not parse is an unexpected response. */
	async #body(response: Response): Promise<Json> {
		const bytes = new Uint8Array(await response.arrayBuffer());
		try {
			return parseJson(jsonText(bytes));
		} catch (error) {
			throw this.http.unexpected(error);
		}
	}

	#get<T>(schema: z.ZodType<T>, path: string, query: ProviderRequest["query"] = {}): Promise<T> {
		return this.http.parsed({ method: "GET", path, query }, schema);
	}

	async #page<T>(schema: z.ZodType<T>, path: string, query: ProviderRequest["query"]): Promise<Page<T>> {
		const response = await this.http.bounded(
			{ method: "GET", path, query },
			this.#maxPageResponse,
			new OperationError("PROVIDER_LIMIT", "GitHub returned more than Minerva reads at once."),
		);
		const items = this.#validate(z.array(schema), await this.#body(response));
		return { items, next: nextPage(response) };
	}

	user(): Promise<z.output<typeof User>> {
		return this.#get(User, "/user");
	}

	async installations(page: number): Promise<{ id: number }[]> {
		const found = await this.#get(Installations, "/user/installations", { per_page: 100, page });
		return found.installations;
	}

	async installationRepositories(installationId: number, options: { page: number; perPage: number }): Promise<Repository[]> {
		const found = await this.#get(InstallationRepositories, `/user/installations/${installationId}/repositories`, {
			per_page: options.perPage,
			page: options.page,
		});
		return found.repositories;
	}

	/** The repository with this name. A renamed or transferred one redirects to its id. */
	async find(owner: string, name: string): Promise<Repository> {
		const response = await this.http.request({ method: "GET", path: `/repos/${segment(owner)}/${segment(name)}`, redirects: true });
		if (response.status >= 300 && response.status < 400) {
			// Followed only to /repositories/<id> on the API host, the id in ASCII digits.
			const location = httpxHeader(response.headers, "location") ?? "";
			const prefix = `${this.#baseUrl}/repositories/`;
			const id = location.startsWith(prefix) ? location.slice(prefix.length) : null;
			if (id === null || !ID.test(id)) throw this.http.unexpected();
			const repository = await this.repository(id);
			if (String(repository.id) !== id) throw this.http.unexpected();
			return repository;
		}
		return this.#validate(Repository, await this.#body(response));
	}

	repository(repoId: string): Promise<Repository> {
		return this.#get(Repository, `/repositories/${segment(repoId)}`);
	}

	issues(repoId: string, query: ProviderRequest["query"]): Promise<Page<Issue>> {
		return this.#page(Issue, `/repositories/${segment(repoId)}/issues`, query);
	}

	issue(repoId: string, number: number): Promise<Issue> {
		return this.#get(Issue, `/repositories/${segment(repoId)}/issues/${number}`);
	}

	async comments(repoId: string, number: number, options: { perPage: number }): Promise<Comment[]> {
		const page = await this.#page(Comment, `/repositories/${segment(repoId)}/issues/${number}/comments`, { per_page: options.perPage });
		return page.items;
	}

	pulls(repoId: string, query: ProviderRequest["query"]): Promise<Page<Pull>> {
		return this.#page(Pull, `/repositories/${segment(repoId)}/pulls`, query);
	}

	pull(repoId: string, number: number): Promise<Pull> {
		return this.#get(Pull, `/repositories/${segment(repoId)}/pulls/${number}`);
	}

	async pullFiles(repoId: string, number: number, options: { perPage: number }): Promise<PullFile[]> {
		const page = await this.#page(PullFile, `/repositories/${segment(repoId)}/pulls/${number}/files`, { per_page: options.perPage });
		return page.items;
	}

	async contents(repoId: string, path: string, ref: string | null): Promise<Entry | Entry[]> {
		const encoded = path ? path.split("/").map(segment).join("/") : "";
		const query = ref ? { ref } : {};
		const response = await this.http.download({ method: "GET", path: `/repositories/${segment(repoId)}/contents/${encoded}`, query }, MAX_CONTENTS_RESPONSE);
		return this.#validate(Contents, await this.#body(response));
	}

	async createIssue(repoId: string, title: string, body: string | null): Promise<Issue> {
		const payload: { [key: string]: Json } = { title };
		if (body) payload.body = body;
		const data = await this.http.json({ method: "POST", path: `/repositories/${segment(repoId)}/issues`, json: payload });
		return this.#validate(Issue, data);
	}

	async comment(repoId: string, number: number, body: string): Promise<Comment> {
		const data = await this.http.json({ method: "POST", path: `/repositories/${segment(repoId)}/issues/${number}/comments`, json: { body } });
		return this.#validate(Comment, data);
	}
}
