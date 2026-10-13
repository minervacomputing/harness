// Linear's GraphQL API in memory, behind an injected `fetch`.
//
// Teams: Engineering (sub-team Web), Operations, Design, and Security, which the account cannot see.
// ENG-1 has sub-issues ENG-2 and OPS-2; ENG-3's parent is OPS-1; ENG-4 is done.

import { MAX_ISSUE_DEPTH, MAX_TEAM_DEPTH } from "../../../../src/connectors/linear/client.ts";
import { type Json, type JsonObject, parseJson } from "../../../../src/lib/json.ts";

type Value = Json | undefined;

export interface FakeTeam {
	key: string;
	name: string;
	parent: string | null;
	private?: boolean;
}

export const TEAMS: { [name: string]: FakeTeam } = {
	eng: { key: "ENG", name: "Engineering", parent: null },
	web: { key: "WEB", name: "Web", parent: "eng" },
	ops: { key: "OPS", name: "Operations", parent: null },
	des: { key: "DES", name: "Design", parent: null },
	sec: { key: "SEC", name: "Security", parent: null, private: true },
};
const PEOPLE = ["ada", "grace", "old"];
const COMMENTS = ["c1", "c2", "c3", "c4", "gone"];
const ISSUES = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "WEB-1", "OPS-1", "OPS-2", "SEC-1", "NEW"];

/** `str(UUID(int=n))`. */
function uuidOf(n: number): string {
	const hex = n.toString(16).padStart(32, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ID: { [name: string]: string } = Object.fromEntries(
	[...Object.keys(TEAMS), ...PEOPLE, ...COMMENTS, ...ISSUES].map((name, index) => [name, uuidOf(index + 1)]),
);
export const NAME: { [id: string]: string } = Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name]));
export const STATES: [name: string, type: string][] = [
	["Backlog", "backlog"],
	["Todo", "unstarted"],
	["In Progress", "started"],
	["Done", "completed"],
	["Canceled", "canceled"],
];
const NO_MORE = { hasNextPage: false, endCursor: null };
export const SECRET = "Secret ops thing";

function slug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export interface FakeIssue {
	id: string;
	identifier: string;
	team: string;
	title: string;
	description: string;
	parent: string | null;
	assignee: string | null;
	state: string;
	labels: string[];
	dueDate: string | null;
}

interface FakeComment {
	issue: string;
	body: string;
	parent: string | null;
	user: string;
	at: string;
	hidden?: boolean;
}

/** Linear's answer to an unknown or hidden object. */
class Missing extends Error {}

function newIssue(
	ident: string,
	team: string,
	title: string,
	options: { description?: string; parent?: string | null; assignee?: string | null; state?: string } = {},
): FakeIssue {
	return {
		id: ID[ident] as string,
		identifier: ident,
		team,
		title,
		description: options.description ?? "",
		parent: options.parent ?? null,
		assignee: options.assignee ?? null,
		state: options.state ?? "unstarted",
		labels: [],
		dueDate: null,
	};
}

function isObject(value: Value): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: Json): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type Hook = (name: string, variables: JsonObject) => Response | null | undefined | void;

export class FakeLinear {
	teams: { [name: string]: FakeTeam } = Object.fromEntries(Object.entries(TEAMS).map(([name, team]) => [name, { ...team }]));
	hidden = new Set(["sec"]);
	issues: { [ident: string]: FakeIssue } = {
		"ENG-1": newIssue("ENG-1", "eng", "Launch plan", {
			description: `Blocked by [${SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing), see https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f and linear.app/acme/view/hush`,
		}),
		"ENG-2": newIssue("ENG-2", "eng", "Write docs", { parent: "ENG-1", assignee: "ada" }),
		"ENG-3": newIssue("ENG-3", "eng", "Ops follow-up", { parent: "OPS-1" }),
		"ENG-4": newIssue("ENG-4", "eng", "Shipped", { state: "completed" }),
		"WEB-1": newIssue("WEB-1", "web", "Landing page"),
		"OPS-1": newIssue("OPS-1", "ops", SECRET),
		"OPS-2": newIssue("OPS-2", "ops", "Ops sub-task", { parent: "ENG-1" }),
		"SEC-1": newIssue("SEC-1", "sec", "Pen test"),
	};
	comments: { [name: string]: FakeComment } = {
		c1: { issue: "ENG-1", body: "First", parent: null, user: "Grace", at: "2026-09-01" },
		c2: { issue: "ENG-1", body: "Hidden", parent: null, user: "Bot", at: "2026-09-02", hidden: true },
		c3: { issue: "ENG-1", body: `Reply about [${SECRET}](https://linear.app/acme/issue/OPS-1/x)`, parent: "c1", user: "Ada", at: "2026-09-03" },
		c4: { issue: "ENG-2", body: "Elsewhere", parent: null, user: "Ada", at: "2026-09-04" },
	};
	labels: { [team: string]: JsonObject[] } = {
		eng: [
			{ id: "l-bug", name: "Bug", isGroup: false, parent: null },
			{ id: "l-area", name: "Area", isGroup: true, parent: null },
			{ id: "l-frontend", name: "Frontend", isGroup: false, parent: { name: "Area" } },
		],
		workspace: [{ id: "l-urgent", name: "Urgent", isGroup: false, parent: null }],
	};
	members: JsonObject[] = [
		{ id: ID.ada as string, name: "Ada Lovelace", displayName: "ada", active: true },
		{ id: ID.grace as string, name: "Grace Hopper", displayName: "grace", active: true },
		{ id: ID.old as string, name: "Old Timer", displayName: "old", active: false },
	];
	ops: [name: string, variables: JsonObject][] = [];
	writes: [name: string, input: JsonObject][] = [];
	hook: Hook | null = null;
	stray: string | null = null;
	lastFilter: Json | undefined = undefined;
	/** Requests that reached the fake, with their headers. */
	requests: Request[] = [];
	#comments = 0;

	names(): string[] {
		return this.ops.map(([name]) => name);
	}

	// Shapes

	#chain(name: string | null, levels: number): JsonObject | null {
		if (name === null) return null;
		const node: JsonObject = { id: ID[name] as string };
		if (levels > 1) node.parent = this.#chain((this.teams[name] as FakeTeam).parent, levels - 1);
		return node;
	}

	#team(name: string): JsonObject {
		const team = this.teams[name] as FakeTeam;
		return {
			id: ID[name] as string,
			key: team.key,
			name: team.name,
			description: null,
			private: team.private ?? false,
			parent: this.#chain(team.parent, MAX_TEAM_DEPTH + 1),
		};
	}

	static state(team: string, type: string): JsonObject {
		const name = (STATES.find(([, kind]) => kind === type) as [string, string])[0];
		return { id: `${team}-${type}`, name, type };
	}

	#url(issue: FakeIssue): string {
		return `https://linear.app/acme/issue/${issue.identifier}/${slug(issue.title)}`;
	}

	#summary(issue: FakeIssue): JsonObject {
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			priorityLabel: "No priority",
			dueDate: issue.dueDate,
			updatedAt: "2026-09-05T00:00:00.000Z",
			url: this.#url(issue),
			state: FakeLinear.state(issue.team, issue.state),
			assignee: issue.assignee ? { name: issue.assignee } : null,
			team: { id: ID[issue.team] as string },
		};
	}

	#relative(issue: FakeIssue): JsonObject {
		return {
			identifier: issue.identifier,
			title: issue.title,
			state: FakeLinear.state(issue.team, issue.state),
			team: { id: ID[issue.team] as string },
		};
	}

	#comment(name: string): JsonObject {
		const comment = this.comments[name] as FakeComment;
		return {
			id: ID[name] as string,
			body: comment.body,
			createdAt: comment.at,
			hideInLinear: comment.hidden ?? false,
			parent: comment.parent ? { id: ID[comment.parent] as string } : null,
			user: { name: comment.user },
			botActor: null,
			externalUser: null,
		};
	}

	#full(issue: FakeIssue): JsonObject {
		const ident = issue.identifier;
		const parent = issue.parent ? this.issues[issue.parent] : undefined;
		const children = Object.values(this.issues).filter((item) => item.parent === ident);
		const comments = Object.entries(this.comments)
			.filter(([, comment]) => comment.issue === ident)
			.map(([name]) => name);
		return {
			...this.#summary(issue),
			description: issue.description,
			estimate: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			completedAt: null,
			canceledAt: null,
			creator: { name: "Ada Lovelace" },
			project: null,
			labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo: NO_MORE },
			team: this.#team(issue.team),
			parent: parent ? this.#relative(parent) : null,
			children: { nodes: children.map((child) => this.#relative(child)), pageInfo: NO_MORE },
			comments: { nodes: [...comments].reverse().map((name) => this.#comment(name)), pageInfo: NO_MORE },
		};
	}

	#parents(ident: string | null, levels: number): JsonObject | null {
		if (ident === null) return null;
		const issue = this.issues[ident] as FakeIssue;
		const node: JsonObject = { id: issue.id, team: { id: ID[issue.team] as string } };
		if (levels > 1) node.parent = this.#parents(issue.parent, levels - 1);
		return node;
	}

	// Lookups

	#findTeam(value: Value): string {
		const name = typeof value === "string" ? NAME[value] : undefined;
		if (name === undefined || !(name in this.teams) || this.hidden.has(name)) throw new Missing();
		return name;
	}

	#findIssue(value: Value): FakeIssue {
		const text = String(value);
		const issue = this.issues[text.toUpperCase()] ?? this.issues[NAME[text] ?? ""];
		if (issue === undefined || this.hidden.has(issue.team)) throw new Missing();
		return issue;
	}

	#visibleTeams(): string[] {
		return Object.keys(this.teams).filter((name) => !this.hidden.has(name));
	}

	static #compare(value: Json, condition: JsonObject): boolean {
		for (const [op, arg] of Object.entries(condition)) {
			let ok: boolean;
			if (op === "eq") ok = value === arg;
			else if (op === "neq") ok = value !== arg;
			else if (op === "in") ok = (arg as Json[]).includes(value);
			else if (op === "nin") ok = !(arg as Json[]).includes(value);
			else if (op === "eqIgnoreCase") ok = String(value).toLowerCase() === String(arg).toLowerCase();
			else if (op === "containsIgnoreCase") ok = String(value).toLowerCase().includes(String(arg).toLowerCase());
			else throw new Error(`Unknown comparison ${op}`);
			if (!ok) return false;
		}
		return true;
	}

	#matches(issue: FakeIssue, where: JsonObject): boolean {
		for (const [key, condition] of Object.entries(where)) {
			let ok: boolean;
			if (key === "and") ok = (condition as JsonObject[]).every((item) => this.#matches(issue, item));
			else if (key === "or") ok = (condition as JsonObject[]).some((item) => this.#matches(issue, item));
			else if (key === "id") ok = FakeLinear.#compare(issue.id, condition as JsonObject);
			else if (key === "team") ok = FakeLinear.#compare(ID[issue.team] as string, (condition as JsonObject).id as JsonObject);
			else if (key === "state") ok = FakeLinear.#compare(issue.state, (condition as JsonObject).type as JsonObject);
			else if (key === "title") ok = FakeLinear.#compare(issue.title, condition as JsonObject);
			else if (key === "assignee") ok = (issue.assignee === "ada") === (((condition as JsonObject).isMe as JsonObject).eq as boolean);
			else if (key === "parent") ok = issue.parent !== null && this.#matches(this.issues[issue.parent] as FakeIssue, condition as JsonObject);
			else throw new Error(`Unknown filter ${key}`);
			if (!ok) return false;
		}
		return true;
	}

	#visibleIssues(): FakeIssue[] {
		return Object.values(this.issues).filter((issue) => !this.hidden.has(issue.team));
	}

	static #paged(nodes: Json[], variables: JsonObject): JsonObject {
		const size = (variables.first as number | undefined) || 100;
		const after = variables.after;
		const start = typeof after === "string" && after ? Number(after.slice(1)) : 0;
		const end = start + size;
		const more = end < nodes.length;
		return { nodes: nodes.slice(start, end), pageInfo: { hasNextPage: more, endCursor: more ? `c${end}` : null } };
	}

	// Dispatch

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		this.requests.push(request.clone());
		const url = new URL(request.url);
		if (url.origin !== "https://api.linear.app" || url.pathname !== "/graphql" || request.method !== "POST") {
			throw new Error(`Unexpected request ${request.method} ${request.url}`);
		}
		if (request.redirect !== "manual") throw new Error("Provider requests never follow redirects.");
		const body = parseJson(await request.text()) as JsonObject;
		const name = (/^\s*(?:query|mutation)\s+(\w+)/.exec(body.query as string) as RegExpExecArray)[1] as string;
		const variables = (body.variables as JsonObject | null) ?? {};
		this.ops.push([name, variables]);
		const hooked = this.hook?.(name, variables);
		if (hooked) return hooked;
		let data: JsonObject;
		try {
			data = this.#answer(name, variables);
		} catch (error) {
			if (!(error instanceof Missing)) throw error;
			return json(200, { data: null, errors: [{ message: "Entity not found", extensions: { type: "invalid input" } }] });
		}
		return json(200, { data });
	};

	#answer(name: string, v: JsonObject): JsonObject {
		switch (name) {
			case "Me":
				return { viewer: { id: ID.ada as string, name: "Ada Lovelace" }, organization: { name: "Acme", urlKey: "acme" } };
			case "Organization":
				return { organization: { name: "Acme", urlKey: "acme" } };
			case "Viewer":
				return { viewer: { id: ID.ada as string, name: "Ada Lovelace" } };
			case "Team":
				return { team: this.#team(this.#findTeam(v.id)) };
			case "TeamByKey": {
				const found = this.#visibleTeams().filter((team) => (this.teams[team] as FakeTeam).key.toLowerCase() === String(v.key).toLowerCase());
				return { teams: { nodes: found.map((team) => this.#team(team)), pageInfo: NO_MORE } };
			}
			case "Teams": {
				const filter = isObject(v.filter) ? v.filter : {};
				const ids = isObject(filter.id) ? (filter.id.in as string[] | undefined) : undefined;
				const found = this.#visibleTeams().filter((team) => ids === undefined || ids.includes(ID[team] as string));
				return { teams: FakeLinear.#paged(found.map((team) => this.#team(team)), v) };
			}
			case "TeamIssues": {
				this.lastFilter = v.filter;
				const team = this.#findTeam(v.id);
				const where = isObject(v.filter) ? v.filter : {};
				const issues = this.#visibleIssues().filter((issue) => issue.team === team && this.#matches(issue, where));
				if (this.stray) issues.push(this.issues[this.stray] as FakeIssue);
				return { team: { ...this.#team(team), issues: FakeLinear.#paged(issues.map((issue) => this.#summary(issue)), v) } };
			}
			case "States": {
				const team = this.#findTeam(v.id);
				return { team: { states: FakeLinear.#paged(STATES.map(([, kind]) => FakeLinear.state(team, kind)), v) } };
			}
			case "TeamLabels": {
				const team = this.#findTeam(v.id);
				return { team: { labels: FakeLinear.#paged(this.labels[team] ?? [], v) } };
			}
			case "WorkspaceLabels":
				return { issueLabels: FakeLinear.#paged(this.labels.workspace ?? [], v) };
			case "Members":
				this.#findTeam(v.id);
				return { team: { members: FakeLinear.#paged(this.members, v) } };
			case "IssuePlace": {
				const issue = this.#findIssue(v.id);
				return { issue: { id: issue.id, identifier: issue.identifier, team: this.#team(issue.team) } };
			}
			case "IssueTeam":
				return { issue: { team: { id: ID[this.#findIssue(v.id).team] as string } } };
			case "Issue":
				return { issue: this.#full(this.#findIssue(v.id)) };
			case "IssueForUpdate": {
				const issue = this.#findIssue(v.id);
				return {
					issue: { id: issue.id, identifier: issue.identifier, team: this.#team(issue.team), parent: this.#parents(issue.parent, MAX_ISSUE_DEPTH + 1) },
				};
			}
			case "OpenSubIssues": {
				const issues = this.#visibleIssues();
				const found = (key: string) => ({ nodes: issues.filter((issue) => this.#matches(issue, v[key] as JsonObject)).map((issue) => ({ id: issue.id })).slice(0, 1) });
				return { elsewhere: found("elsewhere"), deeper: found("deeper") };
			}
			case "CommentPlace": {
				const commentName = NAME[String(v.id)];
				const comment = commentName === undefined ? undefined : this.comments[commentName];
				if (commentName === undefined || comment === undefined) throw new Missing();
				return {
					comment: {
						id: ID[commentName] as string,
						issue: { id: ID[comment.issue] as string },
						parent: comment.parent ? { id: ID[comment.parent] as string } : null,
					},
				};
			}
			case "IssueCreate": {
				const data = v.input as JsonObject;
				this.writes.push([name, data]);
				const team = NAME[data.teamId as string] as string;
				const issue = newIssue("NEW", team, data.title as string, { description: (data.description as string | undefined) ?? "" });
				issue.identifier = `${(this.teams[team] as FakeTeam).key}-9`;
				return { issueCreate: { success: true, issue: this.#written(issue) } };
			}
			case "IssueUpdate": {
				const input = v.input as JsonObject;
				this.writes.push([name, { id: v.id as string, ...input }]);
				const issue = this.#findIssue(v.id);
				if (Object.hasOwn(input, "title")) issue.title = input.title as string;
				return { issueUpdate: { success: true, issue: this.#written(issue) } };
			}
			case "CommentCreate":
				this.writes.push([name, v.input as JsonObject]);
				this.#comments += 1;
				return { commentCreate: { success: true, comment: { id: uuidOf(0xc0ffee00 + this.#comments), createdAt: "now" } } };
		}
		throw new Error(`Unknown operation ${name}`);
	}

	#written(issue: FakeIssue): JsonObject {
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			url: this.#url(issue),
			state: FakeLinear.state(issue.team, issue.state),
			team: { id: ID[issue.team] as string },
		};
	}
}
