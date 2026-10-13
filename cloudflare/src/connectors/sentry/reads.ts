// Sentry's operations, all reads: projects, issue search,
// single issues and their events.
//
// Issues are named by id or short id ("WEB-1A3"). `prepare` reads the issue, which tells its project, and
// authorizes there; the agent gets that read only if allowed. An issue never changes project (Sentry merges
// issues only within one), so it is not read again. An issue the account cannot see, or one too large to
// read, is refused like an ungranted one.
//
// Search takes fields, never Sentry's query syntax: Minerva builds the query, names the one project in the
// request, and refuses a response with an issue from any other project.
//
// An event is shown in part. Exceptions with their innermost stack frames and the source lines around them,
// an allowlist of tags, the runtime, OS and browser, and the request's method and address without its query
// are shown. Local variables, request headers, cookies and bodies, the user, breadcrumbs and attachments are
// left out. What an application put in messages, exception values, source lines, transaction names and request
// paths is shown as it is, links to other issues included.
//
// Numbers in an event are read as `_number` reads them, with what a JavaScript number cannot tell: a number
// written with a fraction of zero (20.0, which Python reads as a float and leaves out) counts as the integer,
// and an integer beyond 2^53 is left out (null) rather than shown rounded. A string of decimal digits from any
// script is a number, as Python's `int()` reads it; one that Python's `str.isdigit()` takes but `int()`
// refuses (superscripts, circled digits) is left out here, where Python's call fails with the generic error.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { DIGIT_CLASS, digitValue } from "../../lib/digits.ts";
import type { Json } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, pythonCollapse, truncate } from "../../lib/text.ts";
import { requestAddress } from "./address.ts";
import { EVENT_ID, ID, type Issue, type Project, SLUG, type SentryClient, type SentryEvent } from "./client.ts";
import { isDict } from "../../lib/json.ts";

export const PROJECT = "project";
/** Unseen issues and projects, and ones too large to read: an error naming either would say they exist. */
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN", "RESPONSE_TOO_LARGE"]);
export const MAX_SHORT = 500;
export const MAX_MESSAGE = 5_000;
export const MAX_VALUE = 2_000;
export const MAX_LINE = 500;
export const MAX_EXCEPTIONS = 10;
export const MAX_FRAMES = 40;
export const CONTEXT_LINES = 3;
export const MAX_TAGS = 50;

const SHORT_ID = /^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,13}$/;
const PERMALINK = /^https:\/\/([a-z0-9-]+\.)?sentry\.io\//;
export const SORTS: { readonly [sort: string]: string } = { last_seen: "date", first_seen: "new", events: "freq", users: "user" };
/**
 * Tags that describe where an event happened, for events and an issue's tag names. Others can carry users,
 * addresses, host names and whatever an application chose to tag.
 */
export const TAGS: ReadonlySet<string> = new Set([
	"environment",
	"release",
	"dist",
	"level",
	"handled",
	"mechanism",
	"logger",
	"transaction",
	"browser",
	"browser.name",
	"os",
	"os.name",
	"runtime",
	"runtime.name",
	"device",
	"device.family",
]);
const CONTEXTS = ["runtime", "os", "browser"] as const;
export const PAGE_NOTE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor.";

type Fields = { [key: string]: Json };

function clientOf(binding: Binding): SentryClient {
	return binding.client as SentryClient;
}

// Inputs. Pydantic's AfterValidators that normalize are transforms after the field's own checks; those that
// only check are refinements, in the validator's order.

/**
 * A pattern Pydantic checks with Rust's regex, whose `\s` is Unicode White_Space: shown as Pydantic shows it
 * (in the input's JSON Schema and its error message), tested as Rust tests it. JavaScript's `\s` would also
 * refuse U+FEFF and let U+0085 through.
 */
class RustPattern extends RegExp {
	readonly #tested: RegExp;

	constructor(shown: string, tested: RegExp) {
		super(shown);
		this.#tested = tested;
		// What JSON Schema and the error read; a property of its own, as RegExp's `source` is an accessor.
		Object.defineProperty(this, "source", { value: shown });
	}

	override exec(text: string): RegExpExecArray | null {
		this.#tested.lastIndex = 0;
		return this.#tested.exec(text);
	}
}

const ENVIRONMENT = new RustPattern("^[^\\s/]+$", /^[^\p{White_Space}/]+$/u);

const projectName = () =>
	z.string().trim().min(1).max(100)
		.describe("A project's id or slug, from list_projects.")
		.transform((value, ctx) => {
			const folded = value.toLowerCase();
			if (ID.test(folded) || SLUG.test(folded)) return folded;
			ctx.issues.push({ code: "custom", message: 'must be a project id or slug, such as "web"', input: value });
			return z.NEVER;
		});

const issueName = () =>
	z.string().trim().min(1).max(80)
		.describe('An issue\'s id, or its short id such as "WEB-1A3".')
		.transform((value, ctx) => {
			const upper = value.toUpperCase();
			if (ID.test(upper) || SHORT_ID.test(upper)) return upper;
			ctx.issues.push({ code: "custom", message: 'must be an issue id, or a short id such as "WEB-1A3"', input: value });
			return z.NEVER;
		});

/**
 * The default sits inside the pipe, where zod's JSON Schema shows it (after a transform it would be left out);
 * the transform keeps "latest" as it is, so the value is Pydantic's default, which it does not validate.
 */
const eventName = () =>
	z.string().trim().min(1).max(36)
		.default("latest")
		.describe('"latest" (default), "oldest", "recommended" (Sentry\'s pick), or an event id.')
		.transform((value, ctx) => {
			const folded = value.toLowerCase().replaceAll("-", "");
			if (folded === "latest" || folded === "oldest" || folded === "recommended" || EVENT_ID.test(folded)) return folded;
			ctx.issues.push({ code: "custom", message: 'must be "latest", "oldest", "recommended", or an event id', input: value });
			return z.NEVER;
		});

/** The run's own page token; the executor swaps it for Sentry's cursor before the call is prepared. */
const pageCursor = () => z.string().trim().max(200).nullable().default(null).meta({ title: "Cursor" });

const projectQuery = () => z.string().trim().min(1).max(100).refine(isSingleLine, SINGLE_LINE).describe("Words in the project's name or slug.");

const phrase = () =>
	z.string().trim().min(1).max(200)
		.refine(isSingleLine, SINGLE_LINE)
		.refine((value) => !value.includes('"') && !value.includes("\\"), "must not contain quotes or backslashes")
		.describe("A phrase the issue's message or title contains; no quotes or backslashes.");

const environment = () => z.string().trim().min(1).max(64).regex(ENVIRONMENT).refine(isSingleLine, SINGLE_LINE).describe("An environment's name.");

// Reading what Sentry sent.

/** `value.get(key)`: an own member, or null (None) when there is none. */
function get(value: Fields, key: string): Json {
	return Object.hasOwn(value, key) ? (value[key] as Json) : null;
}

/** The dicts in a list; nothing for anything else. */
function items(value: Json): Fields[] {
	return Array.isArray(value) ? value.filter(isDict) : [];
}

export function short(value: Json | undefined, limit: number = MAX_SHORT): string | null {
	if (typeof value !== "string") return null;
	const [shown] = truncate(pythonCollapse(value), limit);
	return shown || null;
}

function textOf(value: Json, limit: number): [string | null, boolean] {
	return truncate(typeof value === "string" && value ? value : null, limit);
}

const DIGITS = new RegExp(`^${DIGIT_CLASS}+$`, "u");

/** `_number`: an int (never a bool), or a string of decimal digits read as `int()` reads it; else null. */
export function numberOf(value: Json | undefined): number | null {
	if (typeof value === "boolean") return null;
	if (typeof value === "number") return Number.isSafeInteger(value) ? value + 0 : null;
	if (typeof value !== "string" || !DIGITS.test(value)) return null;
	let digits = "";
	for (const char of value) digits += String(digitValue(char) as number);
	const number = Number(digits);
	return Number.isSafeInteger(number) ? number : null;
}

export function unseen(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

export function projectResource(binding: Binding, project: string): Resource {
	if (!ID.test(project)) throw clientOf(binding).unexpected();
	return binding.resource(PROJECT, project);
}

/** The project a call names, by id or slug. One the account cannot see is refused like an ungranted one. */
async function resolveProject(binding: Binding, name: string): Promise<[Resource, Project]> {
	const client = clientOf(binding);
	let project: Project;
	try {
		project = await client.project(name);
	} catch (error) {
		if (unseen(error)) throw denied();
		throw error;
	}
	if (!ID.test(name) && project.slug !== name) throw client.unexpected();
	return [projectResource(binding, project.id), project];
}

/**
 * The issue a call names, read in full, and its project. One the account cannot see is refused like one in
 * an ungranted project.
 */
async function resolveIssue(binding: Binding, name: string): Promise<[Resource, Issue]> {
	const client = clientOf(binding);
	let issue: Issue;
	try {
		const issueId = ID.test(name) ? name : await client.shortId(name);
		issue = await client.issue(issueId);
	} catch (error) {
		if (unseen(error)) throw denied();
		throw error;
	}
	return [projectResource(binding, issue.project.id), issue];
}

/** reads.py `_issue`. */
export function issueRecord(issue: Issue): Fields {
	const assignee = issue.assignedTo;
	return {
		id: issue.id,
		short_id: short(issue.shortId),
		title: short(issue.title),
		culprit: short(issue.culprit),
		level: issue.level,
		status: issue.status,
		substatus: issue.substatus,
		priority: issue.priority,
		events: numberOf(issue.count),
		users: issue.userCount,
		first_seen: issue.firstSeen,
		last_seen: issue.lastSeen,
		platform: short(issue.platform),
		project: { id: issue.project.id, slug: short(issue.project.slug) },
		assignee: assignee !== null ? { type: assignee.type, name: short(assignee.name) } : null,
		link: issue.permalink && PERMALINK.test(issue.permalink) ? issue.permalink : null,
	};
}

/** reads.py `_issue_detail`. */
export function issueDetail(issue: Issue): Fields {
	return {
		...issueRecord(issue),
		first_release: issue.firstRelease !== null ? short(issue.firstRelease.version) : null,
		last_release: issue.lastRelease !== null ? short(issue.lastRelease.version) : null,
		tags: issue.tags
			.filter((tag) => TAGS.has(tag.key))
			.slice(0, MAX_TAGS)
			.map((tag) => ({ key: short(tag.key), name: short(tag.name), events: tag.totalValues })),
		comments: issue.numComments,
		user_reports: issue.userReportCount,
	};
}

/** The source lines within CONTEXT_LINES of the frame's line, each once, in order. */
function sourceLines(frame: Fields, line: number | null): Fields[] {
	const pairs = get(frame, "context");
	if (line === null || !Array.isArray(pairs)) return [];
	const shown = new Map<number, Fields>();
	for (const pair of pairs) {
		if (!Array.isArray(pair) || pair.length !== 2) continue;
		const number = numberOf(pair[0]);
		const text = pair[1];
		if (number === null || typeof text !== "string" || Math.abs(number - line) > CONTEXT_LINES || shown.has(number)) continue;
		const [code, cut] = truncate(text, MAX_LINE);
		shown.set(number, { line: number, code, code_truncated: cut });
	}
	return [...shown.keys()].sort((a, b) => a - b).map((number) => shown.get(number) as Fields);
}

function frameRecord(frame: Fields): Fields {
	const line = numberOf(get(frame, "lineNo"));
	return {
		file: short(get(frame, "filename")),
		function: short(get(frame, "function")),
		module: short(get(frame, "module")),
		line,
		column: numberOf(get(frame, "colNo")),
		in_app: get(frame, "inApp") === true,
		source: sourceLines(frame, line),
	};
}

function exceptionRecord(value: Fields): Fields {
	const stacktrace = get(value, "stacktrace");
	const frames = isDict(stacktrace) ? items(get(stacktrace, "frames")) : [];
	const mechanism = get(value, "mechanism");
	const handled = isDict(mechanism) ? get(mechanism, "handled") : null;
	const [text, cut] = textOf(get(value, "value"), MAX_VALUE);
	return {
		type: short(get(value, "type")),
		value: text,
		value_truncated: cut,
		module: short(get(value, "module")),
		mechanism: isDict(mechanism) ? { type: short(get(mechanism, "type")), handled: typeof handled === "boolean" ? handled : null } : null,
		// Sentry lists frames outermost first; the innermost, where the error was raised, are kept.
		frames: frames.slice(-MAX_FRAMES).map(frameRecord),
		frame_count: frames.length,
		frames_truncated: frames.length > MAX_FRAMES,
	};
}

/** reads.py `_event`: what is shown of an event. */
export function eventRecord(event: SentryEvent): Fields {
	const values: Fields[] = [];
	let request: Fields | null = null;
	for (const entry of items(get(event, "entries"))) {
		const data = get(entry, "data");
		if (!isDict(data)) continue;
		const type = get(entry, "type");
		if (type === "exception") {
			for (const value of items(get(data, "values"))) values.push(value);
		} else if (type === "request" && request === null) {
			const address = requestAddress(get(data, "url"));
			request = { method: short(get(data, "method"), 20), url: address === null ? null : short(address) };
		}
	}
	// Tag keys are TAGS', none of them a property of Object.prototype; a repeated key keeps its place and its last value.
	const tags: Fields = {};
	for (const tag of items(get(event, "tags"))) {
		const key = get(tag, "key");
		if (typeof key === "string" && TAGS.has(key)) tags[key] = short(get(tag, "value"));
	}
	const found = get(event, "contexts");
	const contexts: Fields = isDict(found) ? found : {};
	const given = get(event, "sdk");
	const sdk: Fields = isDict(given) ? given : {};
	const release = get(event, "release");
	const [message, messageCut] = textOf(get(event, "message"), MAX_MESSAGE);
	const shownContexts: Fields = {};
	for (const name of CONTEXTS) {
		const context = get(contexts, name);
		if (isDict(context)) shownContexts[name] = { name: short(get(context, "name"), 100), version: short(get(context, "version"), 100) };
	}
	return {
		id: get(event, "eventID"),
		date: short(get(event, "dateCreated"), 40),
		title: short(get(event, "title")),
		message,
		message_truncated: messageCut,
		platform: short(get(event, "platform"), 40),
		culprit: short(get(event, "culprit")),
		location: short(get(event, "location")),
		release: isDict(release) ? short(get(release, "version")) : Object.hasOwn(tags, "release") ? (tags.release as Json) : null,
		environment: Object.hasOwn(tags, "environment") ? (tags.environment as Json) : null,
		tags,
		// The last exceptions are the ones raised last; earlier ones are their causes.
		exceptions: values.slice(-MAX_EXCEPTIONS).map(exceptionRecord),
		exceptions_truncated: values.length > MAX_EXCEPTIONS,
		request,
		contexts: shownContexts,
		sdk: { name: short(get(sdk, "name"), 100), version: short(get(sdk, "version"), 100) },
	};
}

/** `str(value) == id` for an id Sentry sent as a string or an integer. */
function sameId(value: Json, id: string): boolean {
	if (typeof value === "string") return value === id;
	return typeof value === "number" && Number.isSafeInteger(value) && String(value) === id;
}

// Operations.

const ListProjects = z
	.strictObject({
		query: projectQuery().nullable().default(null).meta({ title: "Query" }),
		cursor: pageCursor(),
	})
	.meta({ title: "ListProjects" });

export const LIST_PROJECTS = defineOperation<z.output<typeof ListProjects>>({
	name: "list_projects",
	title: "List projects",
	description: `List the Sentry projects you may read. ${PAGE_NOTE}`,
	input: ListProjects,
	needs: [[PROJECT, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: PROJECT, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await clientOf(binding).projects({ query: data.query, after: data.cursor });
				const records = page.items.map((project) => ({
					resource: projectResource(binding, project.id),
					data: { id: project.id, slug: project.slug, name: short(project.name), platform: short(project.platform) },
				}));
				return { records, nextCursor: page.next };
			},
		};
	},
});

const SearchIssues = z
	.strictObject({
		project: projectName().meta({ title: "Project" }),
		text: phrase().nullable().default(null).meta({ title: "Text" }),
		status: z
			.enum(["unresolved", "resolved", "archived", "any"])
			.describe("Archived issues were once called ignored.")
			.default("unresolved")
			.meta({ title: "Status" }),
		level: z.enum(["fatal", "error", "warning", "info", "debug"]).nullable().default(null).meta({ title: "Level" }),
		environment: environment().nullable().default(null).meta({ title: "Environment" }),
		period: z
			.enum(["24h", "7d", "14d", "30d", "90d"])
			.describe("Only issues with events in this period, counted back from now.")
			.default("14d")
			.meta({ title: "Period" }),
		sort: z.enum(["last_seen", "first_seen", "events", "users"]).default("last_seen").meta({ title: "Sort" }),
		limit: z.int().min(1).max(25).default(10).meta({ title: "Limit" }),
		cursor: pageCursor(),
	})
	.meta({ title: "SearchIssues" });

type SearchIssues = z.output<typeof SearchIssues>;

/** The search, built from fields. An empty query is sent too: without one Sentry shows unresolved issues. */
export function queryOf(data: SearchIssues): string {
	const parts: string[] = [];
	if (data.status !== "any") parts.push(`is:${data.status}`);
	if (data.level !== null) parts.push(`level:${data.level}`);
	if (data.text !== null) parts.push(`"${data.text}"`);
	return parts.join(" ");
}

export const SEARCH_ISSUES = defineOperation<SearchIssues>({
	name: "search_issues",
	title: "Search issues",
	description:
		"Search one Sentry project's issues (grouped errors) by status, level, environment and a phrase, most recently seen first by default. " +
		PAGE_NOTE,
	input: SearchIssues,
	needs: [[PROJECT, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [resource, project] = await resolveProject(binding, data.project);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				const params: [string, string | number][] = [
					["project", project.id],
					["query", queryOf(data)],
					["statsPeriod", data.period],
					["sort", SORTS[data.sort] as string],
					["limit", data.limit],
					["collapse", "stats"],
					["collapse", "unhandled"],
				];
				if (data.environment !== null) params.push(["environment", data.environment]);
				let page: Awaited<ReturnType<SentryClient["issues"]>>;
				try {
					page = await client.issues(params, data.cursor);
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED") throw new OperationError("INVALID_ARGUMENTS", "Sentry could not run this search.");
					throw error;
				}
				// The request names one project; an issue from another means the response cannot be trusted.
				if (page.items.some((issue) => issue.project.id !== project.id)) throw client.unexpected();
				return { records: page.items.map((issue) => ({ resource, data: issueRecord(issue) })), nextCursor: page.next };
			},
		};
	},
});

const GetIssue = z.strictObject({ issue: issueName().meta({ title: "Issue" }) }).meta({ title: "GetIssue" });

export const GET_ISSUE = defineOperation<z.output<typeof GetIssue>>({
	name: "get_issue",
	title: "Get an issue",
	description: "Get a Sentry issue by id or short id: its status, counts, releases and tag names. Use get_issue_event for its stack trace.",
	input: GetIssue,
	needs: [[PROJECT, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [resource, issue] = await resolveIssue(binding, data.issue);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				return { records: [{ resource, data: issueDetail(issue) }] };
			},
		};
	},
});

const GetIssueEvent = z
	.strictObject({ issue: issueName().meta({ title: "Issue" }), event: eventName().meta({ title: "Event" }) })
	.meta({ title: "GetIssueEvent" });

export const GET_ISSUE_EVENT = defineOperation<z.output<typeof GetIssueEvent>>({
	name: "get_issue_event",
	title: "Get an issue's event",
	description:
		`Get one event of a Sentry issue, the latest by default: its exceptions with the innermost ${MAX_FRAMES} stack frames and nearby source lines, ` +
		"tags, release, environment and runtime. Local variables, request headers and bodies, the user and breadcrumbs are left out.",
	input: GetIssueEvent,
	needs: [[PROJECT, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [resource, issue] = await resolveIssue(binding, data.issue);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				let event: SentryEvent;
				try {
					event = await client.event(issue.id, data.event);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") throw new OperationError("NOT_FOUND", "This issue has no such event.");
					throw error;
				}
				// The event must belong to the issue authorized, as read: an id merged into another issue is read
				// as that issue.
				const eventId = get(event, "eventID");
				if (
					!sameId(get(event, "groupID"), issue.id) ||
					!sameId(get(event, "projectID"), issue.project.id) ||
					typeof eventId !== "string" ||
					!EVENT_ID.test(eventId) ||
					(EVENT_ID.test(data.event) && eventId !== data.event)
				) {
					throw client.unexpected();
				}
				return { records: [{ resource, data: { issue: issue.id, ...eventRecord(event) } }] };
			},
		};
	},
});
