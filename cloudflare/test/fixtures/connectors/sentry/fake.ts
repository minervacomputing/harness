// Sentry's API behind an injected `fetch`: the API of one organisation, "acme",
// in the de.sentry.io region, with two projects (web, and payroll, whose name is the secret) and three issues.
// Ids, names and addresses are made up; addresses use reserved example domains and private networks.

import type { Json } from "../../../../src/lib/json.ts";

export const SECRET = "SECRET payroll";
export const WEB = "11";
export const PAYROLL = "12";
export const TOKEN = "token";
export const SCOPES = ["org:read", "project:read", "event:read"];
export const API_URL = "https://sentry.io";
export const REGIONS: ReadonlySet<string> = new Set(["https://us.sentry.io", "https://de.sentry.io"]);
/** What an event holds that must never reach the agent. */
export const LEAKS = ["hunter2", "sessionid=", "token=abc", "pw@", "ada@example.com", "crumb text", "10.0.0.7"];

export type SentryObject = { [key: string]: Json };

export function issue(issueId: string, project: SentryObject, title: string, fields: SentryObject = {}): SentryObject {
	return {
		id: issueId,
		shortId: `${(project.slug as string).toUpperCase()}-${issueId}`,
		title,
		culprit: "app.views in checkout",
		level: "error",
		status: "unresolved",
		substatus: "ongoing",
		priority: "high",
		count: "150",
		userCount: 12,
		firstSeen: "2026-09-01T10:00:00Z",
		lastSeen: "2026-10-02T10:00:00Z",
		platform: "python",
		permalink: `https://acme.sentry.io/issues/${issueId}/`,
		project: { id: project.id as string, slug: project.slug as string, name: project.name as string },
		assignedTo: { type: "user", id: "5", name: "Grace", email: "grace@example.com" },
		activity: [{ type: "note", data: { text: "see PAYROLL-202" } }],
		seenBy: [{ email: "seen@example.com" }],
		...fields,
	};
}

export function frame(n: number): SentryObject {
	const context: Json[] = [];
	for (let line = 15; line < 26; line++) context.push([line, `line ${line}`]);
	return {
		filename: `app/f${n}.py`,
		absPath: `/srv/app/f${n}.py`,
		function: `fn${n}`,
		module: `app.f${n}`,
		lineNo: 20,
		colNo: null,
		inApp: n % 2 === 0,
		context,
		vars: { password: "hunter2" },
	};
}

export function event(parent: SentryObject, fields: SentryObject = {}): SentryObject {
	return {
		eventID: "9fac2ceed9344f2bbfdd1fdacb0ed9b1",
		groupID: parent.id as string,
		projectID: (parent.project as SentryObject).id as string,
		title: parent.title as string,
		message: "",
		platform: "python",
		culprit: "app.views in checkout",
		location: "app/f44.py",
		dateCreated: "2026-10-02T10:00:00Z",
		release: { version: "web@1.4.2" },
		user: { email: "ada@example.com", ip_address: "10.0.0.7" },
		tags: [
			{ key: "environment", value: "production" },
			{ key: "level", value: "error" },
			{ key: "user", value: "email:ada@example.com" },
			{ key: "url", value: "https://shop.example.com/cart?token=abc" },
			{ key: "runtime", value: "CPython 3.14" },
		],
		contexts: {
			runtime: { name: "CPython", version: "3.14.0" },
			os: { name: "Linux", version: "6.1" },
			device: { model: "x" },
		},
		sdk: { name: "sentry.python", version: "2.40.0" },
		entries: [
			{
				type: "exception",
				data: {
					values: [
						{ type: "KeyError", value: "'cart'", stacktrace: { frames: [frame(0)] } },
						{
							type: "ValueError",
							value: "bad total",
							module: null,
							mechanism: { type: "django", handled: false },
							stacktrace: { frames: Array.from({ length: 45 }, (_, n) => frame(n)) },
						},
					],
				},
			},
			{ type: "breadcrumbs", data: { values: [{ message: "crumb text" }] } },
			{
				type: "request",
				data: {
					method: "POST",
					url: "https://user:pw@shop.example.com:8443/cart?token=abc#top",
					headers: [["Cookie", "sessionid=1"]],
					data: { card: "4242" },
				},
			},
		],
		...fields,
	};
}

function json(status: number, body: Json, headers: { [name: string]: string } = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A request as the fake saw it. */
export interface Seen {
	method: string;
	url: URL;
	headers: Headers;
}

export type Hook = (request: Seen) => Response | null;

export class FakeSentry {
	requests: Seen[] = [];
	/** What went wrong in a request (token, host, region, path); a test checks it stayed empty. */
	problems: string[] = [];
	user: SentryObject = { id: "42", name: "Ada Lovelace", email: "ada@example.com" };
	organisations: SentryObject[] = [{ id: "7", slug: "acme", name: "Acme", links: { regionUrl: "https://de.sentry.io" } }];
	projects: SentryObject[];
	issues: SentryObject[];
	events: { [issueId: string]: SentryObject } = {};
	hook: Hook | null = null;
	/** An explicit event id the fake answers with whatever event it has. */
	answer = "b".repeat(32);

	constructor() {
		const web = { id: WEB, slug: "web", name: "Web", platform: "python" };
		const payroll = { id: PAYROLL, slug: "payroll", name: SECRET, platform: "go" };
		this.projects = [web, payroll];
		this.issues = [issue("101", web, "ValueError: bad total"), issue("102", web, "KeyError: cart", { status: "resolved" }), issue("202", payroll, `${SECRET} failed`)];
		for (const item of this.issues) this.events[item.id as string] = event(item);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const seen: Seen = { method: request.method, url: new URL(request.url), headers: request.headers };
		this.requests.push(seen);
		return this.handle(seen);
	};

	handle(request: Seen): Response {
		const { url } = request;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) this.problems.push(`authorization ${request.headers.get("authorization")}`);
		if (url.hostname !== "sentry.io" && url.hostname !== "de.sentry.io") this.problems.push(`host ${url.hostname}`);
		const path = url.pathname;
		const params = url.searchParams;
		const hooked = this.hook?.(request) ?? null;
		if (hooked !== null) return hooked;
		if (url.hostname === "sentry.io" && path === "/api/0/auth/") return json(200, this.user);
		if (url.hostname === "sentry.io" && path === "/api/0/organizations/") return json(200, this.organisations);
		const links = (this.organisations[0] as SentryObject).links as SentryObject | null;
		const region = links ? (links.regionUrl as string | null) : null;
		const expected = region !== null && REGIONS.has(region) ? region : API_URL;
		if (`https://${url.hostname}` !== expected) this.problems.push(`region ${url.hostname} instead of ${expected}`);
		const parts = path.replace(/^\/api\/0\//, "").replace(/^\/+|\/+$/g, "").split("/");
		const [a, b, c, d, e, f] = parts;
		if (parts.length === 3 && a === "organizations" && b === "acme" && c === "projects") {
			const found = this.projects.filter((project) => (project.slug as string).includes(params.get("query") ?? ""));
			return this.page(found, params, Number(params.get("per_page")));
		}
		if (parts.length === 3 && a === "projects" && b === "acme") {
			const found = this.projects.find((project) => project.id === c || project.slug === c);
			return found ? json(200, found) : json(404, {});
		}
		if (parts.length === 3 && a === "organizations" && b === "acme" && c === "issues") {
			const found = this.issues.filter((item) => (item.project as SentryObject).id === params.get("project"));
			return this.page(found, params, Number(params.get("limit")));
		}
		if (parts.length === 4 && a === "organizations" && b === "acme" && c === "shortids") {
			const found = this.issues.find((item) => item.shortId === d);
			if (!found) return json(404, {});
			return json(200, { organizationSlug: "acme", groupId: found.id as string, group: { id: "0" } });
		}
		if (parts.length === 4 && a === "organizations" && b === "acme" && c === "issues") {
			const found = this.issues.find((item) => item.id === d);
			return found ? json(200, found) : json(404, {});
		}
		if (parts.length === 6 && a === "organizations" && b === "acme" && c === "issues" && e === "events") {
			const found = this.events[d as string];
			if (found === undefined || !["latest", "oldest", "recommended", found.eventID, this.answer].includes(f as string)) return json(404, {});
			return json(200, found);
		}
		this.problems.push(`unexpected path ${path}`);
		return json(500, {});
	}

	page(items: SentryObject[], params: URLSearchParams, size: number): Response {
		const start = Number((params.get("cursor") ?? "0:0:0").split(":")[1]);
		const link =
			start + size < items.length
				? `<https://elsewhere.example.com/?cursor=0:${start + size}:0>; rel="next"; results="true"; cursor="0:${start + size}:0"`
				: '<https://de.sentry.io/>; rel="next"; results="false"; cursor="0:99:0"';
		return json(200, items.slice(start, start + size), { Link: link });
	}

	/** Requests to the organisation's API under `kind`. */
	api(kind = ""): Seen[] {
		return this.requests.filter((request) => request.url.pathname.startsWith(`/api/0/organizations/acme/${kind}`));
	}
}
