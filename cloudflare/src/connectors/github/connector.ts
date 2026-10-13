// GitHub, through a GitHub App acting for the user.
// Resources are repositories, by GitHub's numeric id.
//
// Tokens are user-to-server tokens, which expire and rotate. The App has no scopes: what a token can reach
// is the intersection of the App's permissions, the repositories the App is installed on, and the user's own
// access (plus public repositories, which anyone may read). The connector therefore declares no consent, and
// the user picks repositories twice: on GitHub (the installation, linked from `manageLink`) and in Minerva
// (grants), which narrow that further.
//
// Tools name repositories as "owner/name"; the name is resolved to the id once, before authorization, the
// id is what is authorized, and every later request addresses `/repositories/<id>/...`, so a rename or a new
// repository taking the name cannot redirect a call. A renamed or transferred repository answers with a
// redirect, which is followed only to `/repositories/<id>` on the API host. A repository the account cannot
// see is refused like one without a grant. Grants follow a repository through renames and transfers.
//
// Listing pages are read with a byte limit. The executor still returns a continuation token when every
// record of a provider page was filtered out, so a model can tell that hidden repositories exist, but not
// which.
//
// GitHub's token endpoint answers form-encoded unless asked for JSON, and reports refusals as HTTP 200 with
// an `error` field. Token requests (workspace/credentials.ts) therefore ask for JSON; a refused refresh
// (`bad_refresh_token`) marks the connection for reconnecting, while other refusals, such as a misconfigured
// client, leave it unchanged.

import { z } from "zod";
import {
	type Binding,
	type Connector,
	type DiscoveryItem,
	type DiscoveryPage,
	OperationError,
	type Prepared,
	type ProviderOutput,
	type ScopedRecord,
	defineOperation,
	denied,
} from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { type Json, type JsonObject, parseJson } from "../../lib/json.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine, truncate } from "../../lib/text.ts";
import { type Comment, type Entry, GitHubClient, type Issue, MAX_INLINE_FILE, type Pull, type Repository } from "./client.ts";
import { extend } from "../../lib/arrays.ts";

export const REPOSITORY = "repository";
export const MAX_BODY = 20_000;
export const MAX_COMMENT_BODY = 4_000;
export const MAX_COMMENTS = 30;
export const MAX_PULL_FILES = 100;
export const MAX_PATCH_CHARS = 50_000;
/** GitHub lists at most this many directory entries, without pagination. */
export const MAX_DIRECTORY_ENTRIES = 1000;
export const MAX_INSTALLATION_PAGES = 5;
export const MAX_DISCOVERY_PAGES = 10;
export const MAX_DESCRIBE_CONCURRENCY = 8;

const INVALID_CURSOR = "This page token is invalid.";

// Inputs.

/** "owner/name" as its two parts; the name is "" without a slash. */
function partition(value: string): [owner: string, name: string] {
	const at = value.indexOf("/");
	return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

function repositoryName() {
	return z.string().trim().min(3).max(140)
		.regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
		.refine((value) => ![".", ".."].includes(partition(value)[1]), 'must be "owner/name"')
		.describe('The repository as "owner/name".');
}

const number = () => z.int().min(1).max(10 ** 9);
const cursor = () => z.string().trim().max(1000).nullable().default(null);
const state = () => z.string().trim().regex(/^(open|closed|all)$/).default("open");

const PATH_MESSAGE = 'must be a path inside the repository, like "docs/intro.md", or "" for the top';

/** "" is the top; any other path's parts are neither empty, "." nor "..". */
function pathParts(value: string): boolean {
	return value === "" || !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** A ref git could name: no "..", "//", leading "/" or "-", trailing "/" or ".lock". */
function validRef(value: string): boolean {
	return !(value.includes("..") || value.startsWith("/") || value.startsWith("-") || value.endsWith("/") || value.endsWith(".lock") || value.includes("//"));
}

const ListRepositories = z.strictObject({
	limit: z.int().min(1).max(100).default(30),
	cursor: cursor(),
});

const GetRepository = z.strictObject({
	repository: repositoryName(),
});

const ListIssues = z.strictObject({
	repository: repositoryName(),
	state: state(),
	limit: z.int().min(1).max(50).default(20),
	cursor: cursor(),
});

const GetIssue = z.strictObject({
	repository: repositoryName(),
	number: number(),
});

const ListPullRequests = z.strictObject({
	repository: repositoryName(),
	state: state(),
	limit: z.int().min(1).max(50).default(20),
	cursor: cursor(),
});

const GetPullRequest = z.strictObject({
	repository: repositoryName(),
	number: number(),
});

const ReadFile = z.strictObject({
	repository: repositoryName(),
	path: z.string().trim().max(1000)
		.refine((value) => value === "" || isSingleLine(value), SINGLE_LINE)
		.refine(pathParts, PATH_MESSAGE)
		.describe('A path inside the repository, like "src/app.py"; "" lists the top.')
		.default(""),
	ref: z.string().trim().min(1).max(255)
		.regex(/^[A-Za-z0-9._/-]+$/)
		.refine(validRef, "is not a valid branch, tag, or commit")
		.describe("A branch, tag, or commit. Defaults to the default branch.")
		.nullable()
		.default(null),
	max_chars: z.int().min(1).max(100_000).default(20_000),
});

const CreateIssue = z.strictObject({
	repository: repositoryName(),
	title: z.string().trim().min(1).max(256).refine(isSingleLine, SINGLE_LINE),
	body: z.string().trim().max(MAX_BODY).refine(isPlainText, PLAIN_TEXT).nullable().default(null),
});

const AddComment = z.strictObject({
	repository: repositoryName(),
	number: number().describe("The issue or pull request number."),
	body: z.string().trim().min(1).max(MAX_BODY).refine(isPlainText, PLAIN_TEXT),
});

// Records.

function clientOf(binding: Binding): GitHubClient {
	return binding.client as GitHubClient;
}

/** The repository a call names, as the resource that is authorized. Repositories the account cannot see are refused like repositories without a grant. */
async function resolve(binding: Binding, repository: string): Promise<Resource> {
	const [owner, name] = partition(repository);
	let found: Repository;
	try {
		found = await clientOf(binding).find(owner, name);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
	return binding.resource(REPOSITORY, String(found.id));
}

export function repositoryRecord(repository: Repository): JsonObject {
	return {
		id: repository.id,
		full_name: repository.full_name,
		private: repository.private,
		description: repository.description,
		default_branch: repository.default_branch,
		open_issues_and_pull_requests: repository.open_issues_count,
		archived: repository.archived,
		fork: repository.fork,
		pushed_at: repository.pushed_at,
		url: repository.html_url,
	};
}

export function issueRecord(issue: Issue, options: { body?: boolean } = {}): JsonObject {
	const data: JsonObject = {
		number: issue.number,
		type: issue.pull_request !== null ? "pull_request" : "issue",
		title: issue.title,
		state: issue.state,
		author: issue.user !== null ? issue.user.login : null,
		labels: issue.labels.map((label) => label.name),
		comments: issue.comments,
		created_at: issue.created_at,
		updated_at: issue.updated_at,
		closed_at: issue.closed_at,
		url: issue.html_url,
	};
	if (options.body) [data.body, data.body_truncated] = truncate(issue.body, MAX_BODY);
	return data;
}

export function commentRecord(comment: Comment): JsonObject {
	const [text, truncated] = truncate(comment.body, MAX_COMMENT_BODY);
	return {
		id: comment.id,
		author: comment.user !== null ? comment.user.login : null,
		created_at: comment.created_at,
		body: text,
		body_truncated: truncated,
		url: comment.html_url,
	};
}

export function pullRecord(pull: Pull, options: { body?: boolean } = {}): JsonObject {
	const data: JsonObject = {
		number: pull.number,
		title: pull.title,
		state: pull.merged_at ? "merged" : pull.state,
		draft: pull.draft,
		author: pull.user !== null ? pull.user.login : null,
		head: pull.head !== null ? pull.head.ref : null,
		base: pull.base !== null ? pull.base.ref : null,
		created_at: pull.created_at,
		updated_at: pull.updated_at,
		url: pull.html_url,
	};
	if (options.body) {
		[data.body, data.body_truncated] = truncate(pull.body, MAX_BODY);
		data.changed_files = pull.changed_files;
		data.additions = pull.additions;
		data.deletions = pull.deletions;
	}
	return data;
}

/** Control, format, unassigned, private-use and separator characters other than the space. */
const UNPRINTABLE = /(?! )[\p{C}\p{Z}]/u;
const pageValue = z.string().min(1).max(500).refine((value) => !UNPRINTABLE.test(value));
const PageState = z.strictObject({ page: pageValue.regex(/^\d{1,6}$/).optional(), after: pageValue.optional() });

/** GitHub's next page, from a cursor this connector returned: a page number or an opaque `after`. */
export function pageParams(cursor: string | null): { [key: string]: string } {
	if (cursor === null) return {};
	let state: Json;
	try {
		state = parseJson(cursor);
	} catch {
		throw new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	}
	const parsed = PageState.safeParse(state);
	if (!parsed.success) throw new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	return Object.fromEntries(Object.entries(parsed.data).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The cursor of the next page: its query parameters as JSON, or null for the last page. */
export function pageCursor(params: { [key: string]: string } | null): string | null {
	return params !== null && Object.keys(params).length > 0 ? JSON.stringify(params) : null;
}

const RepositoriesState = z.strictObject({ installation: z.int().min(1).max(10 ** 15 - 1), page: z.int().min(1).max(9_999) });

/**
 * (installation id, page) from a cursor this connector returned; (0, 1) to start. The settings page holds
 * it, so it is checked as strictly as tool input.
 */
export function repositoriesCursor(cursor: string | null): [installation: number, page: number] {
	if (cursor === null) return [0, 1];
	let state: Json;
	try {
		state = parseJson(cursor);
	} catch {
		throw new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	}
	const parsed = RepositoriesState.safeParse(state);
	if (!parsed.success) throw new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	return [parsed.data.installation, parsed.data.page];
}

async function installationIds(client: GitHubClient): Promise<number[]> {
	const ids: number[] = [];
	for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
		const found = await client.installations(page);
		extend(ids, found.map((installation) => installation.id));
		if (found.length < 100) return [...new Set(ids)].sort((a, b) => a - b);
	}
	throw new OperationError("PROVIDER_LIMIT", "The Minerva GitHub App has more installations than Minerva can list.");
}

/**
 * One page of the repositories the App is installed on and the user can access, installation after
 * installation in id order. The cursor names the installation by id, so installations added or removed
 * meanwhile do not shift it; one that was removed is skipped.
 */
async function repositoriesPage(client: GitHubClient, cursor: string | null, limit: number): Promise<[Repository[], string | null]> {
	let [installation, page] = repositoriesCursor(cursor);
	const installations = await installationIds(client);
	const remaining = installations.filter((id) => id >= installation);
	const first = remaining[0];
	if (first === undefined) return [[], null];
	if (first !== installation) page = 1;
	const found = await client.installationRepositories(first, { page, perPage: limit });
	let following: { installation: number; page: number } | null = null;
	if (found.length === limit) following = { installation: first, page: page + 1 };
	else if (remaining.length > 1) following = { installation: remaining[1] as number, page: 1 };
	return [found, following !== null ? JSON.stringify(following) : null];
}

/** A repository as the settings page lists it. */
export function item(repository: Repository): DiscoveryItem {
	return { id: String(repository.id), name: `${repository.full_name}${repository.private ? " (private)" : ""}` };
}

// Operations.

const LIST_REPOSITORIES = defineOperation<z.output<typeof ListRepositories>>({
	name: "list_repositories",
	title: "List repositories",
	description: "List the GitHub repositories you may read. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListRepositories,
	needs: [[REPOSITORY, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: REPOSITORY, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const [found, following] = await repositoriesPage(clientOf(binding), data.cursor, data.limit);
				const records = found.map((repository): ScopedRecord => ({ resource: binding.resource(REPOSITORY, String(repository.id)), data: repositoryRecord(repository) }));
				return { records, nextCursor: following };
			},
		};
	},
});

const GET_REPOSITORY = defineOperation<z.output<typeof GetRepository>>({
	name: "get_repository",
	title: "Get a repository",
	description: "Read a repository's details, such as its default branch and description.",
	input: GetRepository,
	needs: [[REPOSITORY, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const fresh = await clientOf(binding).repository(resource.id);
				return { records: [{ resource, data: repositoryRecord(fresh) }] };
			},
		};
	},
});

/** The listing's query: the call's state, most recently updated first, then GitHub's next page. */
function listQuery(data: { state: string; limit: number; cursor: string | null }): { [key: string]: string | number } {
	return { state: data.state, sort: "updated", direction: "desc", per_page: data.limit, ...pageParams(data.cursor) };
}

const LIST_ISSUES = defineOperation<z.output<typeof ListIssues>>({
	name: "list_issues",
	title: "List issues",
	description:
		"List issues in a repository, most recently updated first, without pull requests. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListIssues,
	needs: [[REPOSITORY, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await clientOf(binding).issues(resource.id, listQuery(data));
				// GitHub lists pull requests as issues too; they have their own tool.
				const records = page.items.filter((issue) => issue.pull_request === null).map((issue): ScopedRecord => ({ resource, data: issueRecord(issue) }));
				return { records, nextCursor: pageCursor(page.next) };
			},
		};
	},
});

const GET_ISSUE = defineOperation<z.output<typeof GetIssue>>({
	name: "get_issue",
	title: "Read an issue",
	description: `Read an issue or pull request conversation: its text and its first ${MAX_COMMENTS} comments.`,
	input: GetIssue,
	needs: [[REPOSITORY, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				const issue = await client.issue(resource.id, data.number);
				const comments = issue.comments ? await client.comments(resource.id, data.number, { perPage: MAX_COMMENTS }) : [];
				const record: JsonObject = {
					...issueRecord(issue, { body: true }),
					comment_list: comments.map(commentRecord),
					comments_truncated: issue.comments > comments.length,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const LIST_PULL_REQUESTS = defineOperation<z.output<typeof ListPullRequests>>({
	name: "list_pull_requests",
	title: "List pull requests",
	description:
		"List pull requests in a repository, most recently updated first. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListPullRequests,
	needs: [[REPOSITORY, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await clientOf(binding).pulls(resource.id, listQuery(data));
				return { records: page.items.map((pull): ScopedRecord => ({ resource, data: pullRecord(pull) })), nextCursor: pageCursor(page.next) };
			},
		};
	},
});

function getPullRequest(maxPatchChars: number) {
	return defineOperation<z.output<typeof GetPullRequest>>({
		name: "get_pull_request",
		title: "Read a pull request",
		description: `Read a pull request with its first ${MAX_PULL_FILES} changed files and their diffs (at most ${MAX_PATCH_CHARS} characters of diff in total). Use get_issue for its comments.`,
		input: GetPullRequest,
		needs: [[REPOSITORY, "read"]],
		async prepare(binding, data): Promise<Prepared> {
			const resource = await resolve(binding, data.repository);
			return {
				requirements: [{ need: resource, action: "read" }],
				async execute(): Promise<ProviderOutput> {
					const client = clientOf(binding);
					const pull = await client.pull(resource.id, data.number);
					const files = await client.pullFiles(resource.id, data.number, { perPage: MAX_PULL_FILES });
					let budget = maxPatchChars;
					const listed: JsonObject[] = [];
					for (const file of files) {
						let patch = file.patch;
						let patchTruncated = false;
						if (patch !== null) {
							[patch, patchTruncated] = truncate(patch, Math.max(budget, 0));
							budget -= patch.length;
						}
						listed.push({
							path: file.filename,
							status: file.status,
							additions: file.additions,
							deletions: file.deletions,
							// Null when GitHub gives no patch (binary or very large changes).
							patch,
							patch_truncated: patchTruncated,
						});
					}
					const record: JsonObject = {
						...pullRecord(pull, { body: true }),
						files: listed,
						files_truncated: (pull.changed_files || 0) > files.length,
					};
					return { records: [{ resource, data: record }] };
				},
			};
		},
	});
}

function unsupported(message: string): OperationError {
	return new OperationError("UNSUPPORTED_FILE", message);
}

/** A text file's record; anything else GitHub returns for a path is refused. */
export function fileRecord(entry: Entry, maxChars: number): JsonObject {
	if (entry.type === "submodule" || entry.submodule_git_url) throw unsupported("This is a submodule, another repository. Minerva does not follow it.");
	if (entry.type === "symlink") throw unsupported("This is a link to a path outside the repository or to a directory.");
	if (entry.type !== "file") throw unsupported("Minerva cannot read this kind of entry.");
	if (entry.size > MAX_INLINE_FILE || entry.encoding !== "base64" || entry.content === null) {
		throw new OperationError("FILE_TOO_LARGE", `Minerva reads files up to ${MAX_INLINE_FILE} bytes.`);
	}
	let raw: Uint8Array;
	try {
		// GitHub wraps the base64 in lines, which atob skips as whitespace.
		raw = Uint8Array.from(atob(entry.content), (char) => char.charCodeAt(0));
	} catch {
		throw new OperationError("PROVIDER_FAILED", "GitHub returned an unexpected response.");
	}
	if (raw.includes(0)) throw unsupported("This looks like a binary file. Minerva reads text files.");
	// Invalid UTF-8 reads as U+FFFD; a byte order mark is dropped.
	const [text, truncated] = truncate(new TextDecoder().decode(raw), maxChars);
	return { path: entry.path, type: "file", size: entry.size, text, truncated, url: entry.html_url };
}

const READ_FILE = defineOperation<z.output<typeof ReadFile>>({
	name: "read_file",
	title: "Read a file",
	description: "Read a text file from a repository, or list a directory. Files up to 1 MB can be read.",
	input: ReadFile,
	needs: [[REPOSITORY, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await clientOf(binding).contents(resource.id, data.path, data.ref);
				const record: JsonObject = Array.isArray(found)
					? {
							path: data.path,
							type: "dir",
							entries: found.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, size: entry.size })),
							entries_truncated: found.length >= MAX_DIRECTORY_ENTRIES,
						}
					: fileRecord(found, data.max_chars);
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const WRITE_WARNING =
	"Everyone who can see the repository sees what you write; mentions notify people, subscribers are notified, and the repository's automation may run.";

const CREATE_ISSUE = defineOperation<z.output<typeof CreateIssue>>({
	name: "create_issue",
	title: "Open an issue",
	description: `Open an issue with a title and text in a repository where you have create permission. ${WRITE_WARNING}`,
	input: CreateIssue,
	needs: [[REPOSITORY, "create"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const issue = await clientOf(binding).createIssue(resource.id, data.title, data.body);
				return { records: [{ resource, data: issueRecord(issue) }] };
			},
		};
	},
});

const ADD_COMMENT = defineOperation<z.output<typeof AddComment>>({
	name: "add_comment",
	title: "Comment",
	description: `Comment on an issue or pull request in a repository where you have create permission. ${WRITE_WARNING}`,
	input: AddComment,
	needs: [[REPOSITORY, "create"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolve(binding, data.repository);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const comment = await clientOf(binding).comment(resource.id, data.number, data.body);
				return { records: [{ resource, data: { ...commentRecord(comment), number: data.number } }] };
			},
		};
	},
});

/** `MINERVA_GITHUB_APP_SLUG` as the Worker is configured: nodejs_compat puts its bindings in `process.env`. */
function configuredAppSlug(): string | null {
	const env = (globalThis as { process?: { env?: { [name: string]: string | undefined } } }).process?.env;
	const value = env?.MINERVA_GITHUB_APP_SLUG;
	return typeof value === "string" ? value : null;
}

export interface GitHubOptions {
	/** The GitHub App's URL name (github.com/apps/<slug>), for the link that installs it; read each time the link is shown. */
	appSlug?: () => string | null | undefined;
	baseUrl?: string;
	/** MAX_PAGE_RESPONSE and MAX_PATCH_CHARS, which tests lower. */
	maxPageResponse?: number;
	maxPatchChars?: number;
}

export function githubConnector(options: GitHubOptions = {}): Connector<GitHubClient> {
	const appSlug = options.appSlug ?? configuredAppSlug;
	return {
		slug: "github",
		name: "GitHub",
		kinds: [{ id: REPOSITORY, label: "Repository", actions: ["read", "create"], wildcard: true }],
		actions: [
			{ id: "read", label: "Read code, issues and pull requests" },
			{ id: "create", label: "Open issues and comment", requires: "read" },
		],
		// A GitHub App: what it may do is set by the App's permissions and where it is installed, not scopes.
		auth: {
			type: "oauth2",
			app: "github",
			authorizeUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
			scopes: [],
		},
		operations: [
			LIST_REPOSITORIES,
			GET_REPOSITORY,
			LIST_ISSUES,
			GET_ISSUE,
			LIST_PULL_REQUESTS,
			getPullRequest(options.maxPatchChars ?? MAX_PATCH_CHARS),
			READ_FILE,
			CREATE_ISSUE,
			ADD_COMMENT,
		],
		client(secret, io) {
			return new GitHubClient(secret, io, {
				...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
				...(options.maxPageResponse === undefined ? {} : { maxPageResponse: options.maxPageResponse }),
			});
		},
		manageLink() {
			const slug = appSlug();
			if (!slug || !/^[a-z0-9-]{1,100}$/.test(slug)) return null;
			return ["Choose repositories on GitHub", `https://github.com/apps/${slug}/installations/new`];
		},
		async account(client) {
			// The numeric id is stable; the login can change.
			const user = await client.user();
			return { id: String(user.id), label: user.login || "GitHub" };
		},
		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			if (!query) {
				const [found, following] = await repositoriesPage(client, cursor, 100);
				return { items: found.map(item), nextCursor: following };
			}
			const text = query.toLowerCase();
			const matches: Repository[] = [];
			let following: string | null = null;
			for (let round = 0; round < MAX_DISCOVERY_PAGES; round++) {
				let found: Repository[];
				[found, following] = await repositoriesPage(client, following, 100);
				extend(matches, found.filter((repository) => repository.full_name.toLowerCase().includes(text)));
				if (following === null) return { items: matches.map(item), nextCursor: null };
			}
			throw new OperationError("PROVIDER_LIMIT", "There are more repositories than Minerva can search.");
		},
		async describe(client, _kind, ids) {
			// At most MAX_DESCRIBE_CONCURRENCY requests at once; the first failure other than a repository the
			// account cannot see fails it all. Ids that are not digits are never sent.
			const found: (Repository | null)[] = new Array(ids.length).fill(null);
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < ids.length) {
					const index = next++;
					const repoId = ids[index] as string;
					if (!/^\d+$/.test(repoId)) continue;
					try {
						found[index] = await client.repository(repoId);
					} catch (error) {
						if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN")) continue;
						throw error;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(MAX_DESCRIBE_CONCURRENCY, ids.length) }, worker));
			const names: { [id: string]: string } = {};
			for (const repository of found) {
				if (repository !== null && ids.includes(String(repository.id))) names[String(repository.id)] = item(repository).name;
			}
			return names;
		},
	};
}
