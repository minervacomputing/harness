// Linear's GraphQL API.
//
// GraphQL answers with 200 even when a request failed, and reports why in `errors`. Reads fail closed: a
// response with any error is refused as a whole, so partial data is never used. A write counts as applied
// only when Linear confirms it (`success: true`), and as not applied only when Linear refused the request
// before running it (a malformed request, or only rate limit and authentication errors); anything else
// leaves its outcome unknown, which pauses further writes. Read responses are streamed with a byte limit.
//
// Responses are read by the camelCase names Linear sends; unknown fields are dropped, and a field of another
// type makes the response unexpected.
//
// `judge` and `classify` read a body as Python's `response.json()` does (pyjson.ts). Reads parse bodies as
// the core's `json()` does, UTF-8 only, so a body Python would also read as UTF-16 or UTF-32, or with an
// encoded surrogate or NaN, is an unexpected response here; Linear sends UTF-8 JSON.

import { z } from "zod";
import type { Effect, OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict, utf8 } from "../../lib/bytes.ts";
import { isDict, type Json, type JsonObject, parseJson } from "../../lib/json.ts";
import { pythonLoads } from "./pyjson.ts";
import { strOf } from "./python.ts";
import { extend } from "../../lib/arrays.ts";

export const API_URL = "https://api.linear.app";
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * How many parent teams (and parent issues) a request resolves; one more level is asked for, to tell
 * whether the chain goes on.
 */
export const MAX_TEAM_DEPTH = 8;
export const MAX_ISSUE_DEPTH = 5;
export const MAX_LIST_PAGES = 4;
/** Errors Linear raises before it runs a request. */
const REFUSED_BEFORE_RUNNING: ReadonlySet<string> = new Set(["ratelimited", "authentication error"]);
const MALFORMED: ReadonlySet<string> = new Set(["GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"]);

function nested(fields: string, depth: number): string {
	return depth === 0 ? "" : `parent { ${fields} ${nested(fields, depth - 1)} }`;
}

export const TEAM_FIELDS = `id key name description private ${nested("id", MAX_TEAM_DEPTH + 1)}`;
const ISSUE_SUMMARY = "id identifier title priorityLabel dueDate updatedAt url state { name type } assignee { name } team { id }";
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

const maybeText = () => z.string().nullable().default(null);

// The models.

export const PageInfo = z.object({ hasNextPage: z.boolean().default(false), endCursor: maybeText() });
export type PageInfo = z.output<typeof PageInfo>;

export interface TeamRef {
	id: string;
	parent: TeamRef | null;
}

export const TeamRef: z.ZodType<TeamRef, unknown> = z.lazy(() => z.object({ id: z.string(), parent: TeamRef.nullable().default(null) }));

const teamFields = {
	id: z.string(),
	parent: TeamRef.nullable().default(null),
	key: z.string(),
	name: z.string(),
	description: maybeText(),
	private: z.boolean().default(false),
};
export const Team = z.object(teamFields);
export type Team = z.output<typeof Team>;

const Teams = z.object({ nodes: z.array(Team), pageInfo: PageInfo });
export type Teams = z.output<typeof Teams>;

const Named = z.object({ name: maybeText() });
export type Named = z.output<typeof Named>;

export const State = z.object({ id: maybeText(), name: z.string(), type: z.string() });
export type State = z.output<typeof State>;

export const Person = z.object({ id: z.string(), name: z.string(), displayName: maybeText(), active: z.boolean().default(true) });
export type Person = z.output<typeof Person>;

export const Label = z.object({ id: z.string(), name: z.string(), isGroup: z.boolean().default(false), parent: Named.nullable().default(null) });
export type Label = z.output<typeof Label>;

export const IssueSummary = z.object({
	id: z.string(),
	identifier: z.string(),
	title: z.string(),
	priorityLabel: maybeText(),
	dueDate: maybeText(),
	updatedAt: maybeText(),
	url: maybeText(),
	state: State.nullable().default(null),
	assignee: Named.nullable().default(null),
	team: TeamRef,
});
export type IssueSummary = z.output<typeof IssueSummary>;

const IssueList = z.object({ nodes: z.array(IssueSummary), pageInfo: PageInfo });
const TeamIssues = z.object({ ...teamFields, issues: IssueList });
export type TeamIssues = z.output<typeof TeamIssues>;

const Labels = z.object({ nodes: z.array(Named), pageInfo: PageInfo });

const Relative = z.object({ identifier: z.string(), title: z.string(), state: State.nullable().default(null), team: TeamRef });
const Relatives = z.object({ nodes: z.array(Relative), pageInfo: PageInfo });

export const Comment = z.object({
	id: z.string(),
	body: z.string().default(""),
	createdAt: maybeText(),
	hideInLinear: z.boolean().default(false),
	// Only its id is asked for.
	parent: TeamRef.nullable().default(null),
	user: Named.nullable().default(null),
	botActor: Named.nullable().default(null),
	externalUser: Named.nullable().default(null),
});
export type Comment = z.output<typeof Comment>;

/** The first of the comment's actors that has a name. */
export function authorOf(comment: Comment): string | null {
	for (const actor of [comment.user, comment.botActor, comment.externalUser]) if (actor !== null && actor.name) return actor.name;
	return null;
}

const Comments = z.object({ nodes: z.array(Comment), pageInfo: PageInfo });

const Issue = z.object({
	id: z.string(),
	identifier: z.string(),
	title: z.string(),
	description: maybeText(),
	priorityLabel: maybeText(),
	estimate: z.number().nullable().default(null),
	dueDate: maybeText(),
	url: maybeText(),
	createdAt: maybeText(),
	updatedAt: maybeText(),
	completedAt: maybeText(),
	canceledAt: maybeText(),
	state: State.nullable().default(null),
	assignee: Named.nullable().default(null),
	creator: Named.nullable().default(null),
	project: Named.nullable().default(null),
	labels: Labels,
	team: Team,
	parent: Relative.nullable().default(null),
	children: Relatives,
	comments: Comments,
});
export type Issue = z.output<typeof Issue>;

const IssuePlace = z.object({ id: z.string(), identifier: z.string(), team: Team });
export type IssuePlace = z.output<typeof IssuePlace>;

export interface ParentIssue {
	id: string;
	team: TeamRef;
	parent: ParentIssue | null;
}

const ParentIssue: z.ZodType<ParentIssue, unknown> = z.lazy(() => z.object({ id: z.string(), team: TeamRef, parent: ParentIssue.nullable().default(null) }));

const IssueForUpdate = z.object({ id: z.string(), identifier: z.string(), team: Team, parent: ParentIssue.nullable().default(null) });
export type IssueForUpdate = z.output<typeof IssueForUpdate>;

// Only the ids of the issue and parent are asked for.
const CommentPlace = z.object({ id: z.string(), issue: TeamRef.nullable().default(null), parent: TeamRef.nullable().default(null) });
export type CommentPlace = z.output<typeof CommentPlace>;

export const Organization = z.object({ name: z.string(), urlKey: z.string() });
export type Organization = z.output<typeof Organization>;

const Viewer = z.object({ id: z.string(), name: z.string() });
export type Viewer = z.output<typeof Viewer>;

const Me = z.object({ viewer: Viewer, organization: Organization });
export type Me = z.output<typeof Me>;

/** What a write returns: the issue it created or changed. */
const Written = z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: maybeText(), state: State.nullable().default(null), team: TeamRef });
export type Written = z.output<typeof Written>;

const WrittenComment = z.object({ id: z.string(), createdAt: maybeText() });
export type WrittenComment = z.output<typeof WrittenComment>;

// Errors and outcomes.

/** `dict.get(key)`: an own key only, so a "__proto__" key is data and nothing is inherited. */
function get(value: Json | undefined, key: string): Json | undefined {
	return isDict(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function errorsOf(body: Json | undefined): JsonObject[] {
	const errors = get(body, "errors");
	if (!Array.isArray(errors)) return [];
	return errors.map((error) => (isDict(error) ? error : {}));
}

function kindOf(error: JsonObject): [type: string, code: string] {
	const extensions = get(error, "extensions");
	if (!isDict(extensions)) return ["", ""];
	const kind = get(extensions, "type");
	const code = get(extensions, "code");
	return [typeof kind === "string" ? kind.toLowerCase() : "", typeof code === "string" ? code.toUpperCase() : ""];
}

/** An owned error for Linear's errors. Linear's own messages never reach the model. */
export function errorFor(provider: string, errors: JsonObject[]): OperationError {
	const kinds = errors.map(kindOf);
	const types = new Set(kinds.map(([kind]) => kind));
	const codes = new Set(kinds.map(([, code]) => code));
	// `str(error.get("message", ""))`: a message that is null reads "None".
	const messages = errors
		.map((error) => {
			const message = get(error, "message");
			return strOf(message === undefined ? "" : message).toLowerCase();
		})
		.join(" ");
	if (types.has("ratelimited") || codes.has("RATELIMITED")) {
		return new OperationError("PROVIDER_RATE_LIMITED", `${provider} is rate limiting requests. Try again later.`);
	}
	if (types.has("authentication error")) return new OperationError("CONNECTION_UNAUTHORIZED", `The ${provider} connection is no longer authorized.`);
	if (types.has("forbidden") || types.has("feature not accessible")) {
		return new OperationError("PROVIDER_FORBIDDEN", `${provider} refused this request for the connected account.`);
	}
	if (messages.includes("not found")) return new OperationError("NOT_FOUND", `${provider} did not find this object.`);
	if (types.has("invalid input") || types.has("user error") || types.has("graphql error")) {
		return new OperationError("PROVIDER_REJECTED", `${provider} rejected this request.`);
	}
	return new OperationError("PROVIDER_FAILED", `${provider} could not complete this request.`);
}

/**
 * A read's JSON, as the core's `json()` reads every body: UTF-8 with a byte order mark skipped. Python's
 * `response.json()` would also read UTF-16, UTF-32, encoded surrogates and NaN, which are refused here as
 * an unexpected response.
 */
function strictJson(bytes: Uint8Array): Json {
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	return parseJson(fromUtf8Strict(bytes.subarray(start)));
}

/**
 * Names the error of a failed response from its GraphQL errors; null goes by the status. Reads the bytes
 * received (`bytes`) as Python's `response.json()` does (pyjson.ts), not the text decoded with
 * replacement characters.
 */
export function classify(provider: string, _response: Response, body: string, bytes: Uint8Array = utf8(body)): OperationErrorShape | null {
	const parsed = pythonLoads(bytes);
	if (parsed === undefined) return null;
	const errors = errorsOf(parsed);
	return errors.length ? errorFor(provider, errors) : null;
}

function refusedBeforeRunning(error: JsonObject, hasData: boolean): boolean {
	const [kind, code] = kindOf(error);
	if (REFUSED_BEFORE_RUNNING.has(kind)) return true;
	// A malformed request is refused before execution, and GraphQL then leaves out `data`. Other errors
	// without `data` are not trusted: Linear might leave it out after a mutation ran too.
	return !hasData && (kind === "graphql error" || MALFORMED.has(code));
}

/**
 * What a mutation did. Only Linear's confirmation counts as applied, and only a refusal before the
 * mutation ran as not applied: an error raised after it committed can look like any other. The body is read
 * as `classify` reads it; one that does not parse, invalid UTF-8 included, leaves a write Linear answered
 * with a success status unknown.
 */
export function judge(response: Response, body: string, bytes: Uint8Array = utf8(body)): Effect | null {
	const parsed = pythonLoads(bytes);
	if (!isDict(parsed)) return response.ok ? "unknown" : null;
	const data = get(parsed, "data");
	if (isDict(data)) {
		for (const payload of Object.values(data)) if (get(payload, "success") === true) return "applied";
	}
	const errors = errorsOf(parsed);
	const hasData = Object.hasOwn(parsed, "data");
	if (errors.length && errors.every((error) => refusedBeforeRunning(error, hasData))) return "not_applied";
	return "unknown";
}

type Variables = { [name: string]: Json };

/** Thin client for Linear's GraphQL API. Responses are validated before use. */
export class LinearClient implements ProviderClient {
	readonly #http: ProviderHTTP;

	constructor(io: ProviderIo, accessToken: string, baseUrl: string = API_URL) {
		this.#http = new ProviderHTTP(io, { provider: "Linear", baseUrl, headers: { Authorization: `Bearer ${accessToken}` }, classify, judge });
	}

	close(): Promise<void> {
		return this.#http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.#http.unexpected(cause);
	}

	/** A read. Any error refuses the whole response. */
	async query(document: string, variables: Variables = {}): Promise<JsonObject> {
		const response = await this.#http.bounded(
			{ method: "POST", path: "/graphql", json: { query: document, variables } },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", "Linear returned more than Minerva reads."),
		);
		let body: Json;
		try {
			body = strictJson(new Uint8Array(await response.arrayBuffer()));
		} catch (error) {
			throw this.unexpected(error);
		}
		const errors = errorsOf(body);
		if (errors.length) throw errorFor("Linear", errors);
		const data = get(body, "data");
		if (!isDict(data)) throw this.unexpected();
		return data;
	}

	async #model<T>(schema: z.ZodType<T, unknown>, document: string, variables: Variables, ...path: string[]): Promise<T> {
		let value: Json | undefined = await this.query(document, variables);
		for (const key of path) value = get(value, key);
		const parsed = schema.safeParse(value ?? null);
		if (!parsed.success) throw this.unexpected(parsed.error);
		return parsed.data;
	}

	/** The one write of an operation. Its outcome is judged by `judge`. */
	async #mutate(document: string, variables: Variables, field: string): Promise<JsonObject> {
		const body = await this.#http.json({ method: "POST", path: "/graphql", mutating: true, json: { query: document, variables } });
		const payload = get(get(body, "data"), field);
		if (isDict(payload) && get(payload, "success") === true) return payload;
		const errors = errorsOf(body);
		if (errors.length) throw errorFor("Linear", errors);
		throw new OperationError("WRITE_UNCONFIRMED", "Linear did not confirm the change.");
	}

	me(): Promise<Me> {
		return this.#model(Me, "query Me { viewer { id name } organization { name urlKey } }", {});
	}

	organization(): Promise<Organization> {
		return this.#model(Organization, "query Organization { organization { name urlKey } }", {}, "organization");
	}

	viewer(): Promise<Viewer> {
		return this.#model(Viewer, "query Viewer { viewer { id name } }", {}, "viewer");
	}

	team(teamId: string): Promise<Team> {
		return this.#model(Team, `query Team($id: String!) { team(id: $id) { ${TEAM_FIELDS} } }`, { id: teamId }, "team");
	}

	async teamByKey(key: string): Promise<Team[]> {
		const found = await this.#model(
			Teams,
			`query TeamByKey($key: String!) { teams(first: 2, filter: { key: { eqIgnoreCase: $key } }) { nodes { ${TEAM_FIELDS} } ${PAGE_INFO} } }`,
			{ key },
			"teams",
		);
		return found.nodes;
	}

	teams(options: { first: number; after: string | null; ids?: string[] }): Promise<Teams> {
		const variables: Variables = { first: options.first, after: options.after };
		if (options.ids !== undefined) variables.filter = { id: { in: options.ids } };
		return this.#model(
			Teams,
			`query Teams($first: Int!, $after: String, $filter: TeamFilter) { teams(first: $first, after: $after, filter: $filter) { nodes { ${TEAM_FIELDS} } ${PAGE_INFO} } }`,
			variables,
			"teams",
		);
	}

	teamIssues(teamId: string, options: { first: number; after: string | null; filter: JsonObject | null }): Promise<TeamIssues> {
		return this.#model(
			TeamIssues,
			"query TeamIssues($id: String!, $first: Int!, $after: String, $filter: IssueFilter) " +
				`{ team(id: $id) { ${TEAM_FIELDS} issues(first: $first, after: $after, filter: $filter, ` +
				`orderBy: updatedAt) { nodes { ${ISSUE_SUMMARY} } ${PAGE_INFO} } } }`,
			{ id: teamId, first: options.first, after: options.after, filter: options.filter },
			"team",
		);
	}

	/** Every node of a connection, up to MAX_LIST_PAGES pages; and whether more were left out. */
	async #pages<T>(schema: z.ZodType<T, unknown>, document: string, variables: Variables, ...path: string[]): Promise<[T[], boolean]> {
		const connection = z.object({ nodes: z.array(schema), pageInfo: PageInfo });
		const nodes: T[] = [];
		let after: string | null = null;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const found: { nodes: T[]; pageInfo: PageInfo } = await this.#model(connection, document, { ...variables, after }, ...path);
			extend(nodes, found.nodes);
			after = found.pageInfo.endCursor;
			if (!found.pageInfo.hasNextPage || after === null) return [nodes, found.pageInfo.hasNextPage];
		}
		return [nodes, true];
	}

	async states(teamId: string): Promise<[State[], boolean]> {
		return this.#pages(
			State,
			`query States($id: String!, $after: String) { team(id: $id) { states(first: 100, after: $after) { nodes { id name type } ${PAGE_INFO} } } }`,
			{ id: teamId },
			"team",
			"states",
		);
	}

	/** Labels issues in the team can have: the team's own and the workspace's. */
	async labels(teamId: string): Promise<[Label[], boolean]> {
		const fields = `nodes { id name isGroup parent { name } } ${PAGE_INFO}`;
		const [own, moreOwn] = await this.#pages(
			Label,
			`query TeamLabels($id: String!, $after: String) { team(id: $id) { labels(first: 250, after: $after) { ${fields} } } }`,
			{ id: teamId },
			"team",
			"labels",
		);
		const [shared, moreShared] = await this.#pages(
			Label,
			`query WorkspaceLabels($after: String) { issueLabels(first: 250, after: $after, filter: { team: { null: true } }) { ${fields} } }`,
			{},
			"issueLabels",
		);
		const labels = new Map<string, Label>();
		for (const label of [...own, ...shared]) if (!labels.has(label.id)) labels.set(label.id, label);
		return [[...labels.values()], moreOwn || moreShared];
	}

	async members(teamId: string): Promise<[Person[], boolean]> {
		return this.#pages(
			Person,
			`query Members($id: String!, $after: String) { team(id: $id) { members(first: 250, after: $after) { nodes { id name displayName active } ${PAGE_INFO} } } }`,
			{ id: teamId },
			"team",
			"members",
		);
	}

	issuePlace(issueId: string): Promise<IssuePlace> {
		return this.#model(
			IssuePlace,
			`query IssuePlace($id: String!) { issue(id: $id) { id identifier team { ${TEAM_FIELDS} } } }`,
			{ id: issueId },
			"issue",
		);
	}

	issueTeam(issueId: string): Promise<TeamRef> {
		return this.#model(TeamRef, "query IssueTeam($id: String!) { issue(id: $id) { team { id } } }", { id: issueId }, "issue", "team");
	}

	issue(issueId: string, comments: number): Promise<Issue> {
		return this.#model(
			Issue,
			"query Issue($id: String!, $comments: Int!) { issue(id: $id) { " +
				"id identifier title description priorityLabel estimate dueDate url createdAt updatedAt " +
				"completedAt canceledAt state { name type } assignee { name } creator { name } project { name } " +
				`labels(first: 50) { nodes { name } ${PAGE_INFO} } team { ${TEAM_FIELDS} } ` +
				"parent { identifier title team { id } } " +
				`children(first: 50) { nodes { identifier title state { name type } team { id } } ${PAGE_INFO} } ` +
				"comments(first: $comments, orderBy: createdAt) { nodes { id body createdAt hideInLinear " +
				`parent { id } user { name } botActor { name } externalUser { name } } ${PAGE_INFO} } } }`,
			{ id: issueId, comments },
			"issue",
		);
	}

	issueForUpdate(issueId: string): Promise<IssueForUpdate> {
		const chain = nested("id team { id }", MAX_ISSUE_DEPTH + 1);
		return this.#model(
			IssueForUpdate,
			`query IssueForUpdate($id: String!) { issue(id: $id) { id identifier team { ${TEAM_FIELDS} } ${chain} } }`,
			{ id: issueId },
			"issue",
		);
	}

	/**
	 * Whether the issue has open sub-issues (to `depth` levels down) in other teams, and whether it has
	 * sub-issues deeper than that. Only issues the account can see are found.
	 */
	async openSubIssues(issueId: string, teamId: string, depth: number): Promise<[elsewhere: boolean, deeper: boolean]> {
		const under = (level: number): JsonObject => {
			let filter: JsonObject = { id: { eq: issueId } };
			for (let i = 0; i < level; i++) filter = { parent: filter };
			return filter;
		};
		const levels: JsonObject[] = [];
		for (let level = 1; level <= depth; level++) levels.push(under(level));
		const elsewhere: JsonObject = {
			and: [{ team: { id: { neq: teamId } } }, { state: { type: { nin: ["completed", "canceled"] } } }, { or: levels }],
		};
		const data = await this.query(
			"query OpenSubIssues($elsewhere: IssueFilter!, $deeper: IssueFilter!) { " +
				"elsewhere: issues(first: 1, filter: $elsewhere) { nodes { id } } " +
				"deeper: issues(first: 1, filter: $deeper) { nodes { id } } }",
			{ elsewhere, deeper: under(depth + 1) },
		);
		const found = (key: string): boolean => {
			const nodes = get(get(data, key), "nodes");
			if (!Array.isArray(nodes)) throw this.unexpected();
			return nodes.length > 0;
		};
		return [found("elsewhere"), found("deeper")];
	}

	commentPlace(commentId: string): Promise<CommentPlace> {
		return this.#model(
			CommentPlace,
			"query CommentPlace($id: String!) { comment(id: $id) { id issue { id } parent { id } } }",
			{ id: commentId },
			"comment",
		);
	}

	async createIssue(input: JsonObject): Promise<Written | null> {
		const payload = await this.#mutate(
			"mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success " +
				"issue { id identifier title url state { name type } team { id } } } }",
			{ input },
			"issueCreate",
		);
		return written(get(payload, "issue"));
	}

	async updateIssue(issueId: string, input: JsonObject): Promise<Written | null> {
		const payload = await this.#mutate(
			"mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, " +
				"input: $input) { success issue { id identifier title url state { name type } team { id } } } }",
			{ id: issueId, input },
			"issueUpdate",
		);
		return written(get(payload, "issue"));
	}

	async createComment(input: JsonObject): Promise<WrittenComment | null> {
		const payload = await this.#mutate(
			"mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id createdAt } } }",
			{ input },
			"commentCreate",
		);
		const parsed = WrittenComment.safeParse(get(payload, "comment") ?? null);
		return parsed.success ? parsed.data : null;
	}
}

/** The written issue, or null when Linear did not return it; the write itself was confirmed. */
function written(value: Json | undefined): Written | null {
	const parsed = Written.safeParse(value ?? null);
	return parsed.success ? parsed.data : null;
}
