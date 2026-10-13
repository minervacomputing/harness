// Sentry's REST API on sentry.io.
//
// A token reaches one organisation, the one the user chose on Sentry's consent screen, and the organisation
// list shows only that one. The list is read on sentry.io, and the organisation's API calls go to its region
// (us.sentry.io or de.sentry.io) when Sentry names one of those, or to sentry.io otherwise. The token is
// never sent to any other host. Paths name the organisation by the slug that same list gave.
//
// Every response is read with a byte limit and validated before use. Pages are followed by the cursor in the
// `Link` header; only the cursor is taken from it, never its address. Sentry's error messages are not passed on.
//
// Responses are strict UTF-8 JSON. Fields not named here are dropped; a field of another type makes the
// response unexpected.

import { z } from "zod";
import type { ProviderClient, ProviderIo, ProviderRequest } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, isDict, parseJson } from "../../lib/json.ts";

export const PROVIDER = "Sentry";
export const API_URL = "https://sentry.io";
export const REGIONS: ReadonlySet<string> = new Set(["https://us.sentry.io", "https://de.sentry.io"]);
/** Project, issue and user ids are positive integers; leading zeros are refused, so each has one spelling. */
export const ID = /^[1-9][0-9]{0,19}$/;
export const EVENT_ID = /^[0-9a-f]{32}$/;
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_EVENT = 8 * 1024 * 1024;
/** Sentry's cursors look like "1727950000000:0:0"; they are checked, never followed as addresses. */
const CURSOR = /^[0-9A-Za-z.:_-]{1,200}$/;
/** Whitespace around a Link header's parameters. */
const SPACE = `\\s`;
const LINK = new RegExp(`<[^>]*>((?:${SPACE}*;${SPACE}*[a-z]+="[^"]*")*)`, "g");
const PARAM = /([a-z]+)="([^"]*)"/g;

export const FORBIDDEN =
	"Sentry refused this request. The connected account may not be a member of this project's team, " +
	"or the connection lacks a permission; connecting it again asks for them.";
export const INVALID_CURSOR = "This page token is invalid.";
export const TOO_LARGE = "Sentry's response was too large to read.";
export const ONE_ORGANISATION = "Sentry did not name the one organisation this connection reaches.";

const text = () => z.string().nullable().default(null);
const integer = () => z.int().nullable().default(null);

export const User = z.object({ id: z.string(), name: text(), email: text() });
export type User = z.output<typeof User>;

const Links = z.object({ regionUrl: text() });

export const Organisation = z.object({ id: z.string(), slug: z.string(), name: text(), links: Links.nullable().default(null) });
export type Organisation = z.output<typeof Organisation>;

export const Project = z.object({ id: z.string(), slug: z.string(), name: text(), platform: text() });
export type Project = z.output<typeof Project>;

/** Required: the project decides who may see an issue, so a response without it is not guessed at. */
const IssueProject = z.object({ id: z.string(), slug: text(), name: text() });
const Assignee = z.object({ type: text(), name: text() });
const Release = z.object({ version: text() });
const TagSummary = z.object({ key: z.string(), name: text(), totalValues: integer() });

export const Issue = z.object({
	id: z.string(),
	shortId: text(),
	title: text(),
	culprit: text(),
	level: text(),
	status: text(),
	substatus: text(),
	priority: text(),
	count: text(),
	userCount: integer(),
	firstSeen: text(),
	lastSeen: text(),
	platform: text(),
	permalink: text(),
	project: IssueProject,
	assignedTo: Assignee.nullable().default(null),
	// Issue detail only.
	firstRelease: Release.nullable().default(null),
	lastRelease: Release.nullable().default(null),
	tags: z.array(TagSummary).default([]),
	numComments: integer(),
	userReportCount: integer(),
});
export type Issue = z.output<typeof Issue>;

const ShortId = z.object({ groupId: z.string(), organizationSlug: text() });

/** One event, as Sentry sent it; reads.ts picks what is shown. */
export type SentryEvent = { [key: string]: Json };

export function classify(_provider: string, response: Response): OperationError | null {
	if (response.status === 403) return new OperationError("PROVIDER_FORBIDDEN", FORBIDDEN);
	return null;
}

/** A cursor from a call, checked before it is sent. */
export function cursor(value: string | null): string | null {
	if (value !== null && !CURSOR.test(value)) throw new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	return value;
}

/** The cursor of the next page in a `Link` header, when Sentry says it has results. */
export function linkCursor(header: string): string | null {
	for (const match of header.matchAll(LINK)) {
		// The last value of a name wins.
		const params = new Map<string, string>();
		for (const [, name, value] of (match[1] as string).matchAll(PARAM)) params.set(name as string, value as string);
		if (params.get("rel") === "next" && params.get("results") === "true") {
			const found = params.get("cursor");
			if (found === undefined || !CURSOR.test(found)) throw new OperationError("PROVIDER_LIMIT", "Sentry returned a page token Minerva cannot use.");
			return found;
		}
	}
	return null;
}

/** The cursor of the next page, from the `Link` header. */
export function nextCursor(response: Response): string | null {
	return linkCursor(response.headers.get("link") ?? "");
}

/** A refused page request is the cursor's fault when one was sent: other arguments are checked first. */
export function invalidCursor(error: unknown, sent: string | null): unknown {
	if (error instanceof OperationError && error.code === "PROVIDER_REJECTED" && sent !== null) return new OperationError("INVALID_CURSOR", INVALID_CURSOR);
	return error;
}

/** A query string in the order given, for a request that repeats a parameter (ProviderHTTP's query takes one value each). */
function withQuery(path: string, params: [string, string | number][]): string {
	return `${path}?${new URLSearchParams(params.map(([name, value]): [string, string] => [name, String(value)]))}`;
}

export interface Page<T> {
	items: T[];
	next: string | null;
}

export class SentryClient implements ProviderClient {
	readonly #token: string;
	readonly #io: ProviderIo;
	readonly #control: ProviderHTTP;
	#region: ProviderHTTP | null = null;
	#organisation: Organisation | null = null;
	/** The lookup in flight, so concurrent calls (describe's) share one. */
	#looking: Promise<Organisation> | null = null;

	constructor(token: string, io: ProviderIo) {
		this.#token = token;
		this.#io = io;
		this.#control = this.#open(API_URL);
	}

	#open(baseUrl: string): ProviderHTTP {
		return new ProviderHTTP(this.#io, {
			provider: PROVIDER,
			baseUrl,
			headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
			classify,
		});
	}

	async close(): Promise<void> {
		await this.#control.close();
		if (this.#region !== null) await this.#region.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.#control.unexpected(cause);
	}

	/** A GET read with a byte limit; too large a response is RESPONSE_TOO_LARGE. */
	#read(http: ProviderHTTP, path: string, query: ProviderRequest["query"] = {}, limit: number = MAX_RESPONSE): Promise<Response> {
		return http.bounded({ method: "GET", path, query }, limit, new OperationError("RESPONSE_TOO_LARGE", TOO_LARGE));
	}

	/** The response's JSON, fitted to `schema`. */
	async #model<T>(schema: z.ZodType<T>, response: Response): Promise<T> {
		const result = schema.safeParse(await this.#json(response));
		if (!result.success) throw this.unexpected(result.error);
		return result.data;
	}

	async #json(response: Response): Promise<Json> {
		const bytes = new Uint8Array(await response.arrayBuffer());
		try {
			return parseJson(fromUtf8Strict(bytes));
		} catch (error) {
			throw this.unexpected(error);
		}
	}

	#list<T>(schema: z.ZodType<T>, response: Response): Promise<T[]> {
		return this.#model(z.array(schema), response);
	}

	async user(): Promise<User> {
		const found = await this.#model(User, await this.#read(this.#control, "/api/0/auth/"));
		if (!ID.test(found.id)) throw this.unexpected();
		return found;
	}

	async organisations(): Promise<Organisation[]> {
		const found = await this.#list(Organisation, await this.#read(this.#control, "/api/0/organizations/"));
		if (found.some((organisation) => !ID.test(organisation.id) || !SLUG.test(organisation.slug))) throw this.unexpected();
		return found;
	}

	/** The one organisation this token reaches, read once per client. */
	organisation(): Promise<Organisation> {
		if (this.#organisation !== null) return Promise.resolve(this.#organisation);
		this.#looking ??= this.organisations().then(
			(found) => {
				this.#looking = null;
				if (found.length !== 1) throw new OperationError("PROVIDER_FAILED", ONE_ORGANISATION);
				this.#organisation = found[0] as Organisation;
				return this.#organisation;
			},
			(error: unknown) => {
				this.#looking = null;
				throw error;
			},
		);
		return this.#looking;
	}

	/** The client for the organisation's region, and the path prefix naming the organisation. */
	async #api(): Promise<[ProviderHTTP, string]> {
		const organisation = await this.organisation();
		if (this.#region === null) {
			const region = organisation.links ? organisation.links.regionUrl : null;
			this.#region = this.#open(region !== null && REGIONS.has(region) ? region : API_URL);
		}
		return [this.#region, `/api/0/organizations/${organisation.slug}`];
	}

	async #orgRead(path: string, query: ProviderRequest["query"] = {}, limit: number = MAX_RESPONSE): Promise<Response> {
		const [http, prefix] = await this.#api();
		return this.#read(http, prefix + path, query, limit);
	}

	async #projectRead(project: string): Promise<Response> {
		const [http] = await this.#api();
		const organisation = await this.organisation();
		return this.#read(http, `/api/0/projects/${organisation.slug}/${project}/`);
	}

	async projects(options: { query?: string | null; after?: string | null; perPage?: number } = {}): Promise<Page<Project>> {
		const after = options.after ?? null;
		const query: ProviderRequest["query"] = { per_page: options.perPage ?? 100 };
		if (options.query) query.query = options.query;
		if (after !== null) query.cursor = cursor(after);
		let response: Response;
		try {
			response = await this.#orgRead("/projects/", query);
		} catch (error) {
			throw invalidCursor(error, after);
		}
		const found = await this.#list(Project, response);
		if (found.some((project) => !ID.test(project.id))) throw this.unexpected();
		return { items: found, next: nextCursor(response) };
	}

	/** A project by id or slug. */
	async project(name: string): Promise<Project> {
		const found = await this.#model(Project, await this.#projectRead(name));
		if (!ID.test(found.id) || (ID.test(name) && found.id !== name)) throw this.unexpected();
		return found;
	}

	#checked(issue: Issue): Issue {
		if (!ID.test(issue.id) || !ID.test(issue.project.id)) throw this.unexpected();
		return issue;
	}

	/** One page of the organisation's issues; `params` in the order they are sent (`collapse` repeats). */
	async issues(params: [string, string | number][], after: string | null): Promise<Page<Issue>> {
		const sent: [string, string | number][] = after === null ? params : [...params, ["cursor", cursor(after) as string]];
		let response: Response;
		try {
			response = await this.#orgRead(withQuery("/issues/", sent));
		} catch (error) {
			throw invalidCursor(error, after);
		}
		const found = (await this.#list(Issue, response)).map((issue) => this.#checked(issue));
		return { items: found, next: nextCursor(response) };
	}

	/** An issue by id. Sentry answers for an id merged into another issue with that issue. */
	async issue(issueId: string): Promise<Issue> {
		return this.#checked(await this.#model(Issue, await this.#orgRead(`/issues/${issueId}/`)));
	}

	/** The id of the issue a short id names. */
	async shortId(shortId: string): Promise<string> {
		const found = await this.#model(ShortId, await this.#orgRead(`/shortids/${shortId}/`));
		const organisation = await this.organisation();
		if (!ID.test(found.groupId) || (found.organizationSlug !== null && found.organizationSlug !== organisation.slug)) throw this.unexpected();
		return found.groupId;
	}

	/** One event of an issue, as Sentry sent it; reads.ts picks what is shown. */
	async event(issueId: string, event: string): Promise<SentryEvent> {
		const found = await this.#json(await this.#orgRead(`/issues/${issueId}/events/${event}/`, {}, MAX_EVENT));
		if (!isDict(found)) throw this.unexpected();
		return found;
	}
}
