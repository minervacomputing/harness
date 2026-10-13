// Intercom's REST API in memory, behind an injected `fetch`.
//
// The workspace has teams Support (1) and Billing (2, whose name is secret). Conversation 100 is in Support
// and links to 101, which is in Billing; 102 has no team, and 103 is assigned only to a teammate.

import { type Json, type JsonObject, parseJson } from "../../../../src/lib/json.ts";

export const SECRET = "SECRET merger";
export const ADMIN = "991";
export const SUPPORT = "1";
export const BILLING = "2";
export const T0 = 1790000000;
export const TOKEN = "WzE3OTAw+/=";

export function author(kind: string, authorId: string, name: string, email: string | null = null): JsonObject {
	return { type: kind, id: authorId, name, email };
}

export function part(partId: string, partType: string, by: JsonObject, body: string | null, fields: JsonObject = {}): JsonObject {
	return {
		type: "conversation_part",
		id: partId,
		part_type: partType,
		body,
		created_at: T0 + 100 * (Number(partId) - 199),
		author: by,
		attachments: [],
		redacted: false,
		...fields,
	};
}

export function conversation(conversationId: string, team: number | null, title: string, body: string, parts: JsonObject[] = [], fields: JsonObject = {}): JsonObject {
	return {
		type: "conversation",
		id: conversationId,
		title,
		created_at: T0,
		updated_at: T0 + 3600,
		waiting_since: null,
		state: "open",
		priority: "not_priority",
		team_assignee_id: team,
		admin_assignee_id: null,
		source: {
			type: "conversation",
			id: `s${conversationId}`,
			delivered_as: "customer_initiated",
			subject: "",
			body,
			author: author("user", "u1", "Carol", "carol@example.com"),
			attachments: [],
			redacted: false,
		},
		conversation_parts: { type: "conversation_part.list", conversation_parts: parts, total_count: parts.length },
		...fields,
	};
}

export const CAROL = author("user", "u1", "Carol", "carol@example.com");
export const ADA = author("admin", ADMIN, "Ada", "ada@example.com");

export function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function error(status: number, code: string): Response {
	return json(status, { type: "error.list", errors: [{ code, message: SECRET }] });
}

/** A deep copy of a JSON value. */
export function copy<T extends Json>(value: T): T {
	return parseJson(JSON.stringify(value)) as T;
}

export interface Sent {
	method: string;
	path: string;
	headers: Headers;
	/** The body as sent, and as JSON. */
	text: string;
	body: Json | null;
}

/** What answers a request before the fake's own routes, or null to let them. */
export type Hook = (method: string, path: string, body: JsonObject | null) => Response | null;

export class FakeIntercom {
	me: JsonObject = {
		type: "admin",
		id: ADMIN,
		name: "Ada",
		email: "ada@example.com",
		app: { type: "app", id_code: "abc123", name: "Acme", region: "Europe" },
	};
	teams: JsonObject[] = [
		{ type: "team", id: SUPPORT, name: "Support", admin_ids: [991, 992] },
		{ type: "team", id: BILLING, name: SECRET, admin_ids: [] },
	];
	conversations: { [id: string]: JsonObject };
	/** Ids search returns from an index that lags behind reassignments: {id: team the index shows}. */
	stale: { [id: string]: number } = {};
	readonly requests: Sent[] = [];
	readonly searches: JsonObject[] = [];
	readonly writes: [string, JsonObject][] = [];
	/** Requests the real API would not have answered this way: a wrong host or version. */
	readonly problems: string[] = [];
	hook: Hook | null = null;

	constructor() {
		const body =
			'<p>Hi, see <a href="https://app.intercom.com/a/inbox/abc123/inbox/conversation/101">' +
			SECRET +
			'</a> and <a href="https://example.com/docs">docs</a></p>' +
			'<p><img src="https://downloads.intercomcdn.com/i/1.png"></p>';
		this.conversations = {
			"100": conversation("100", 1, "Login issue", body, [
				part("200", "comment", CAROL, "<p>Still broken</p>"),
				part("201", "assignment", ADA, `<p>${SECRET}</p>`, { assigned_to: { type: "team", id: "2" } }),
				part("202", "note", ADA, "<p>Checking &amp; <b>logs</b></p>"),
				part("203", "comment", author("team", BILLING, SECRET), "<p>From the team</p>"),
				part("204", "close", ADA, null),
				part("205", "comment", CAROL, `<p>${SECRET}</p>`, { redacted: true }),
				part("206", "comment", author("bot", "b1", "Fin"), "<p>Bot</p>", { attachments: [{ name: "log.txt" }] }),
			]),
			"101": conversation("101", 2, SECRET, `<p>${SECRET}</p>`),
			"102": conversation("102", 0, "Refund", "<p>Refund please</p>", [], { state: "closed" }),
			"103": conversation("103", null, "Invoice", "<p>Invoice copy</p>", [], { admin_assignee_id: 991 }),
		};
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		const body = text ? (parseJson(text) as JsonObject) : null;
		this.requests.push({ method: request.method, path: url.pathname, headers: request.headers, text, body });
		if (url.host !== "api.intercom.io") this.problems.push(`host ${url.host}`);
		if (request.headers.get("intercom-version") !== "2.16") this.problems.push(`version ${request.headers.get("intercom-version")}`);
		if (request.redirect !== "manual") this.problems.push(`redirect ${request.redirect}`);
		const path = url.pathname;
		const hooked = this.hook?.(request.method, path, body) ?? null;
		if (hooked !== null) return hooked;
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (request.method === "GET" && parts.length === 1 && parts[0] === "me") return json(200, this.me);
		if (request.method === "GET" && parts.length === 1 && parts[0] === "teams") return json(200, { type: "team.list", teams: this.teams });
		if (request.method === "GET" && parts.length === 2 && parts[0] === "conversations") {
			const found = this.conversations[parts[1] as string];
			return found ? json(200, found) : error(404, "not_found");
		}
		if (request.method === "POST" && parts.length === 2 && parts[0] === "conversations" && parts[1] === "search") return this.#search(body as JsonObject);
		if (request.method === "POST" && parts.length === 3 && parts[0] === "conversations" && parts[2] === "reply") {
			const conversationId = parts[1] as string;
			const sent = body as JsonObject;
			this.writes.push([conversationId, sent]);
			const found = this.conversations[conversationId];
			if (found === undefined) return error(404, "not_found");
			const listed = (found.conversation_parts as JsonObject).conversation_parts as JsonObject[];
			const by = author("admin", sent.admin_id as string, "Ada", "ada@example.com");
			listed.push(part(String(300 + this.writes.length), sent.message_type as string, by, sent.body as string));
			return json(200, found);
		}
		this.problems.push(`unexpected ${request.method} ${path}`);
		return json(599, {});
	};

	#search(body: JsonObject): Response {
		this.searches.push(body);
		const query = body.query as JsonObject;
		if (query.operator !== "AND") this.problems.push(`operator ${String(query.operator)}`);
		const matches = (found: JsonObject): boolean => {
			for (const filter of query.value as JsonObject[]) {
				const value = filter.value;
				if (filter.field === "team_assignee_id") {
					const team = Object.hasOwn(this.stale, found.id as string) ? this.stale[found.id as string] : found.team_assignee_id;
					if ((team || 0) !== value) return false;
				} else if (filter.field === "state") {
					if (found.state !== value) return false;
				} else if (filter.field === "updated_at") {
					if (filter.operator !== ">") this.problems.push(`updated_at ${String(filter.operator)}`);
					if ((found.updated_at as number) < (value as number)) return false;
				} else if (filter.field === "source.body") {
					if (filter.operator !== "~") this.problems.push(`source.body ${String(filter.operator)}`);
					const source = found.source as JsonObject;
					if (!(source.body as string).toLowerCase().includes((value as string).toLowerCase())) return false;
				} else {
					this.problems.push(`field ${String(filter.field)}`);
				}
			}
			return true;
		};
		const ids = Object.keys(this.conversations).filter((id) => matches(this.conversations[id] as JsonObject));
		ids.push(...Object.keys(this.stale).filter((id) => !Object.hasOwn(this.conversations, id)));
		const pagination = body.pagination as JsonObject;
		const perPage = pagination.per_page as number;
		let start = 0;
		if (Object.hasOwn(pagination, "starting_after")) {
			const after = pagination.starting_after as string;
			if (!after.startsWith(TOKEN)) return error(400, "parameter_invalid");
			start = Number(after.slice(TOKEN.length));
		}
		const stop = start + perPage;
		const pages: JsonObject = { type: "pages", page: 1, per_page: perPage };
		if (stop < ids.length) pages.next = { per_page: perPage, starting_after: `${TOKEN}${stop}` };
		return json(200, {
			type: "conversation.list",
			conversations: ids.slice(start, stop).map((id) => ({ type: "conversation", id, title: SECRET })),
			total_count: ids.length,
			pages,
		});
	}

	reads(suffix: string): Sent[] {
		return this.requests.filter((request) => request.method === "GET" && request.path.endsWith(suffix));
	}
}
