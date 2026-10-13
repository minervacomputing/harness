// backend/tests/test_outlook_calendar.py, case by case: the Outlook Calendar connector against an in-memory
// Microsoft Graph behind an injected `fetch`, and runs through the executor. Tool inputs, times and page
// state are compared with vectors from today's Python (test/fixtures/connectors/outlook_calendar/generate.py).

import { describe, expect, test } from "vitest";
import { Time } from "../../src/connectors/outlook_calendar/client.ts";
import {
	type CalendarOptions,
	checkDateOrDateTime,
	checkDateTime,
	eventPayload,
	outlookCalendarConnector,
	pageState,
	shownTime,
	utc,
	windowOf,
} from "../../src/connectors/outlook_calendar/connector.ts";
import { ZONES } from "../../src/connectors/outlook_calendar/zones.ts";
import { ValueError } from "../../src/lib/pyerrors.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { ceilingRow, jsonResponse, operation, received, startRun, vectors, type Received } from "../fixtures/connectors/microsoft/runs.ts";
import { changedOnPurpose } from "./changed.ts";

type JsonObject = { [key: string]: Json };

const SECRET = "SECRET merger";
const [DEFAULT, WORK, SHARED, PRIVATE] = ["AAMkCALDEFAULT", "AAMkCALWORK000", "AAMkCALSHARED0", "AAMkCALPRIVATE"] as const;
// Another id Graph accepts for Work (an id from before immutable ids), answered with Work's own id.
const WORK_ALIAS = "AQMkLEGACYWORK";
const USER_ID = "00000000-0000-0000-0000-00000000a0a0";
const READ_SCOPES = ["Calendars.Read", "User.Read", "openid", "profile"];
const WRITE_SCOPES = ["Calendars.ReadWrite", "User.Read", "openid", "profile"];

function calendarOf(id: string, name: string, options: { default?: boolean; owner?: string } = {}): JsonObject {
	const owner = options.owner ?? "me@contoso.com";
	return { id, name, isDefaultCalendar: options.default ?? false, canEdit: owner === "me@contoso.com", owner: { name: owner, address: owner } };
}

function timed(id: string, start: string, end: string, fields: JsonObject = {}): JsonObject {
	return {
		id,
		subject: id.charAt(0).toUpperCase() + id.slice(1).toLowerCase(),
		body: { contentType: "text", content: "Agenda" },
		start: { dateTime: `${start}.0000000`, timeZone: "UTC" },
		end: { dateTime: `${end}.0000000`, timeZone: "UTC" },
		isAllDay: false,
		isCancelled: false,
		showAs: "busy",
		sensitivity: "normal",
		location: { displayName: "Room 1" },
		organizer: { emailAddress: { name: "Grace", address: "grace@example.com" } },
		attendees: [],
		webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
		type: "singleInstance",
		categories: [],
		...fields,
	};
}

type Hook = (method: string, path: string, params: { [name: string]: string }) => Response | null;

/**
 * Microsoft Graph's calendar API (test_outlook_calendar.py `FakeGraph`). Calendars: the default one, Work, a
 * calendar Grace shared, and Private. Graph also finds Work under an older id, and answers with the id it
 * lists.
 */
class FakeGraph {
	calendars: { [id: string]: JsonObject } = {
		[DEFAULT]: calendarOf(DEFAULT, "Calendar", { default: true }),
		[WORK]: calendarOf(WORK, "Work"),
		[SHARED]: calendarOf(SHARED, "Grace's calendar", { owner: "grace@example.com" }),
		[PRIVATE]: calendarOf(PRIVATE, "Private"),
	};
	events: { [id: string]: JsonObject[] };
	user: JsonObject = { id: USER_ID, displayName: "Me", mail: "me@contoso.com", userPrincipalName: "me@contoso.onmicrosoft.com" };
	pageSize: number | null = null;
	requests: Received[] = [];
	writes: [string, JsonObject][] = [];
	hook: Hook | null = null;

	constructor() {
		const attendees = Array.from({ length: 52 }, (_, i) => ({
			emailAddress: { name: `Person ${i}`, address: `p${i}@example.com` },
			type: "required",
			status: { response: "accepted", time: "0001-01-01T00:00:00Z" },
		}));
		this.events = {
			[DEFAULT]: [
				timed("standup00001", "2026-10-05T07:00:00", "2026-10-05T07:15:00", {
					body: { contentType: "text", content: "x".repeat(5000) },
					attendees,
					onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/1" },
				}),
				{ ...timed("holiday00001", "2026-10-06T00:00:00", "2026-10-08T00:00:00"), isAllDay: true, showAs: "free" },
				timed("review000001", "2026-10-09T13:00:00", "2026-10-09T14:00:00"),
			],
			[WORK]: [timed("planning0001", "2026-10-05T09:00:00", "2026-10-05T10:00:00")],
			[SHARED]: [timed("graces000001", "2026-10-05T11:00:00", "2026-10-05T12:00:00")],
			[PRIVATE]: [timed("private00001", "2026-10-05T18:00:00", "2026-10-05T19:00:00", { subject: SECRET })],
		};
	}

	#notFound(): Response {
		return jsonResponse(404, { error: { code: "ErrorItemNotFound", message: SECRET } });
	}

	#find(id: string): JsonObject | undefined {
		return this.calendars[id === WORK_ALIAS ? WORK : id];
	}

	#page(path: string, items: Json[], params: { [name: string]: string }): Response {
		const top = this.pageSize ?? Number(params.$top ?? 10);
		const start = Number(params.$skip ?? 0);
		const body: JsonObject = { value: items.slice(start, start + top) };
		if (start + top < items.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0${path}?$top=${top}&$skip=${start + top}`;
		return jsonResponse(200, body);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = await received(input, init);
		this.requests.push(request);
		const path = request.path;
		const hooked = this.hook?.(request.method, path, request.params) ?? null;
		if (hooked !== null) return hooked;
		const [a, b, c, d] = path.replace(/^\/+|\/+$/g, "").split("/");
		const size = path.replace(/^\/+|\/+$/g, "").split("/").length;
		if (request.method === "POST") {
			const event = JSON.parse(request.body) as JsonObject;
			this.writes.push([path, event]);
			if (a === "me" && b === "calendars" && d === "events" && size === 4 && this.#find(c as string)) {
				const created = {
					...timed("created00001", "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
					subject: event.subject as string,
					start: event.start as Json,
					end: event.end as Json,
					isAllDay: event.isAllDay as Json,
					organizer: { emailAddress: { address: "me@contoso.com" } },
				};
				return jsonResponse(201, created);
			}
			throw new Error(path);
		}
		if (a === "me" && size === 1) return jsonResponse(200, this.user);
		if (a === "me" && b === "calendar" && size === 2) return jsonResponse(200, this.calendars[DEFAULT] as JsonObject);
		if (a === "me" && b === "calendars" && size === 2) return this.#page(path, Object.values(this.calendars), request.params);
		if (a === "me" && b === "calendars" && size === 3) {
			const found = this.#find(c as string);
			return found ? jsonResponse(200, found) : this.#notFound();
		}
		if (a === "me" && b === "calendars" && d === "calendarView" && size === 4) {
			const found = this.#find(c as string);
			if (found === undefined) return this.#notFound();
			if (!("startDateTime" in request.params && "endDateTime" in request.params)) throw new Error(path);
			return this.#page(path, this.events[found.id as string] as Json[], request.params);
		}
		throw new Error(path);
	};

	views(): Received[] {
		return this.requests.filter((request) => request.path.endsWith("/calendarView"));
	}

	client(options: CalendarOptions = {}) {
		return outlookCalendarConnector(options).client("token", settingsIo(this.fetch));
	}
}

function start(graph: FakeGraph, grants: { [calendar: string]: string[] }, options: { scopes?: string[]; ceiling?: ReturnType<typeof ceilingRow>[]; connector?: CalendarOptions } = {}) {
	const rows = Object.fromEntries(Object.entries(grants).map(([id, actions]) => [`calendar:${id}`, actions]));
	return startRun(outlookCalendarConnector(options.connector), graph.fetch, { scopes: options.scopes ?? WRITE_SCOPES, grants: rows, ceiling: options.ceiling ?? [] });
}

type Run = Awaited<ReturnType<typeof start>>;
type Item = { [key: string]: Json };

async function items(run: Run, tool: string, args: Json): Promise<Item[]> {
	return (await run.ok(tool, args)).result.items as Item[];
}

async function ids(run: Run, tool: string, args: Json): Promise<string[]> {
	return (await items(run, tool, args)).map((item) => item.id as string);
}

/** generate.py's `outcome`: what a call gives, or the error it raises. */
function outcome(call: () => unknown): { [key: string]: unknown } {
	try {
		return { value: call() };
	} catch (error) {
		if (error instanceof OperationError) return { error: error.code };
		if (error instanceof ValueError) return { error: "ValueError", message: error.message };
		throw error;
	}
}

describe("connecting and discovery", () => {
	test("test_account_discovery_and_names", async () => {
		const graph = new FakeGraph();
		const connector = outlookCalendarConnector();
		const account = await connector.account(graph.client());
		expect([account.id, account.label]).toEqual([USER_ID, "me@contoso.com"]);
		const page = await connector.discover(graph.client(), "calendar", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[DEFAULT, "Calendar"],
			[WORK, "Work"],
			[SHARED, "Grace's calendar"],
			[PRIVATE, "Private"],
		]);
		const found = await connector.discover(graph.client(), "calendar", { query: "GRACE", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([SHARED]);
		const described = await connector.describe(graph.client(), "calendar", [WORK, WORK.toLowerCase(), WORK_ALIAS, "AAMkNOSUCHCAL", "primary"]);
		expect(described).toEqual({ [WORK]: "Work" });
	});

	test("test_calendar_pages_are_followed_up_to_a_cap", async () => {
		const graph = new FakeGraph();
		graph.pageSize = 1;
		const connector = outlookCalendarConnector();
		const page = await connector.discover(graph.client(), "calendar", { query: null, cursor: null });
		expect(page.items).toHaveLength(4);
		expect(graph.requests.map((request) => request.params.$skip)).toEqual([undefined, "1", "2", "3"]);
		// The cap is ten pages; an account with more calendars than that is refused.
		for (let n = 0; n < 7; n++) graph.calendars[`AAMkCALEXTRA${n}`] = calendarOf(`AAMkCALEXTRA${n}`, `Extra ${n}`);
		await expect(connector.discover(graph.client(), "calendar", { query: null, cursor: null })).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
	});

	test("test_calendar_scopes_follow_the_allowed_actions", () => {
		const connector = outlookCalendarConnector();
		const base = ["offline_access", "User.Read", "Calendars.Read"];
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(base);
		expect(requestedScopes(connector, new Set(["read", "create"]))).toEqual([...base, "Calendars.ReadWrite"]);
		expect(connector.auth).toMatchObject({
			type: "oauth2",
			app: "microsoft",
			authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			scopes: base,
		});
		expect(consentNeeded(connector, ["User.Read", "Calendars.Read"], new Set(["read", "create"]))).toEqual(["create"]);
		// Read-write covers reading, in any of the spellings Microsoft reports.
		expect(consentNeeded(connector, ["https://graph.microsoft.com/calendars.readwrite"], new Set(["read", "create"]))).toEqual([]);
		expect(consentNeeded(connector, ["calendars.read"], new Set(["read"]))).toEqual([]);
		expect(consentNeeded(connector, ["Calendars.ReadBasic"], new Set(["read"]))).toEqual(["read"]);
	});

	test("every request asks for immutable ids and carries the token", async () => {
		const graph = new FakeGraph();
		await outlookCalendarConnector().account(graph.client());
		await outlookCalendarConnector().discover(graph.client(), "calendar", { query: null, cursor: null });
		expect(graph.requests).toHaveLength(2);
		for (const request of graph.requests) {
			expect(request.headers.get("prefer")).toContain('IdType="ImmutableId"');
			expect(request.headers.get("authorization")).toBe("Bearer token");
			expect(request.host).toBe("graph.microsoft.com");
		}
	});
});

describe("time zones", () => {
	test("test_only_documented_zones_are_offered", () => {
		for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"]) expect(ZONES.has(zone)).toBe(true);
		for (const zone of ["Europe/Zurich", "US/Eastern", "CET", "Local"]) expect(ZONES.has(zone)).toBe(false);
	});

	test("the zones are today's, which are the documented ones the system's IANA list knows", () => {
		expect([...ZONES].sort()).toEqual(vectors("outlook_calendar").zones);
	});
});

describe("page state", () => {
	test("test_cursors_belong_to_their_calendar", () => {
		const state = { calendar: WORK, page: "skip:2", start: "a", end: "b" };
		expect(pageState(JSON.stringify(state), WORK)).toEqual(state);
		const refused: [string, string][] = [
			[JSON.stringify(state), DEFAULT],
			[JSON.stringify({ ...state, extra: "x" }), WORK],
			[JSON.stringify({ ...state, page: 2 }), WORK],
			[JSON.stringify([state]), WORK],
			["skip:2", WORK],
		];
		for (const [cursor, calendar] of refused) expect(() => pageState(cursor, calendar)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
	});

	test("agrees with Python on states", () => {
		const cases = vectors("outlook_calendar").page_state as { cursor: string; calendar: string; value?: unknown; error?: string }[];
		expect(cases).toHaveLength(6);
		for (const { cursor, calendar, ...expected } of cases) expect(outcome(() => pageState(cursor, calendar))).toEqual(expected);
	});
});

describe("times and tool inputs, as today's Python reads them", () => {
	test("_date_time agrees with Python on 43 texts", () => {
		const cases = vectors("outlook_calendar").date_time as { [raw: string]: unknown };
		expect(Object.keys(cases)).toHaveLength(43);
		expect(Object.fromEntries(Object.keys(cases).map((raw) => [raw, outcome(() => checkDateTime(raw))]))).toEqual(cases);
	});

	test("_date_or_date_time agrees with Python on dates and times", () => {
		const cases = vectors("outlook_calendar").date_or_date_time as { [raw: string]: unknown };
		expect(Object.keys(cases)).toHaveLength(56);
		expect(Object.fromEntries(Object.keys(cases).map((raw) => [raw, outcome(() => checkDateOrDateTime(raw))]))).toEqual(cases);
	});

	test("_utc agrees with Python, fractions of a second kept", () => {
		const cases = vectors("outlook_calendar").utc as { [raw: string]: unknown };
		expect(Object.keys(cases)).toHaveLength(12);
		expect(Object.fromEntries(Object.keys(cases).map((raw) => [raw, outcome(() => utc(raw))]))).toEqual(cases);
	});

	test("the event times Graph reports are shown as _time shows them", () => {
		const cases = vectors("outlook_calendar").times as { time: JsonObject; all_day: boolean; shown: string | null }[];
		expect(cases).toHaveLength(9);
		expect(cases.map(({ time, all_day }) => shownTime(Time(time), all_day))).toEqual(cases.map(({ shown }) => shown));
	});

	for (const [key, name] of [
		["list_events", "list_events"],
		["create_event", "create_event"],
	] as const) {
		test(`inputs of ${name}: normalized arguments, refusals, the window and the payload`, async () => {
			const cases = vectors("outlook_calendar")[key] as { args: Json; data?: JsonObject; message?: string; window?: string[]; payload?: JsonObject }[];
			expect(cases.length).toBeGreaterThan(30);
			const op = operation(outlookCalendarConnector(), name);
			const actual = [];
			const wanted = cases.filter((item) => !changedOnPurpose(item.args)).map(({ message, ...rest }) => (message !== undefined ? { args: rest.args, refused: true } : rest));
			for (const { args } of wanted) {
				const result = await validateInput(op.input as never, args);
				if (!result.ok) {
					actual.push({ args, refused: true });
					continue;
				}
				const data = result.data as { time_min?: string | null; time_max?: string | null };
				const entry: { [key: string]: unknown } = { args, data: result.data };
				if (name === "list_events" && (data.time_min || data.time_max)) entry.window = windowOf(data as { time_min: string | null; time_max: string | null }, 0);
				if (name === "create_event") entry.payload = eventPayload(result.data as never);
				actual.push(entry);
			}
			expect(actual).toEqual(wanted);
		});
	}
});

describe("reading", () => {
	test("test_calendars_without_a_grant_or_unknown_look_alike", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [WORK]: ["read"], [SHARED]: ["read"] });
		expect(await ids(run, "outlook_calendar_list_calendars", {})).toEqual([WORK, SHARED]);
		const shared = (await items(run, "outlook_calendar_list_calendars", {}))[1];
		expect(shared).toEqual({ id: SHARED, name: "Grace's calendar", default: false, can_edit: false, owner: "grace@example.com" });
		for (const calendar_id of [PRIVATE, "primary", "AAMkNOSUCHCAL"]) {
			expect(await run.code("outlook_calendar_list_events", { calendar_id })).toBe("POLICY_DENIED");
		}
		expect(graph.views()).toHaveLength(0);
		// Another id Graph accepts for a granted calendar is that calendar.
		const events = await items(run, "outlook_calendar_list_events", { calendar_id: WORK_ALIAS });
		expect(new Set(events.map((event) => event.calendar_id))).toEqual(new Set([WORK]));
		expect(graph.views().at(-1)?.path).toBe(`/me/calendars/${WORK}/calendarView`);
		for (const calendar_id of ["Work", "../me", "short", "AAMk/CAL/WORK"]) {
			expect(await run.code("outlook_calendar_list_events", { calendar_id })).toBe("INVALID_ARGUMENTS");
		}
	});

	test("test_a_deny_holds_under_every_id_graph_accepts", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { "*": ["read", "create"] }, { ceiling: [ceilingRow("calendar", DEFAULT, "deny"), ceilingRow("calendar", WORK, "deny", ["create"])] });
		expect(await run.code("outlook_calendar_list_events", { calendar_id: "primary" })).toBe("POLICY_DENIED");
		expect(await run.code("outlook_calendar_list_events", { calendar_id: DEFAULT })).toBe("POLICY_DENIED");
		expect(await ids(run, "outlook_calendar_list_calendars", {})).not.toContain(DEFAULT);
		expect(graph.views()).toHaveLength(0);
		const event = { subject: "x", start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z" };
		for (const calendar_id of ["primary", WORK, WORK_ALIAS]) {
			expect(await run.code("outlook_calendar_create_event", { calendar_id, ...event })).toBe("POLICY_DENIED");
		}
		expect(graph.writes).toHaveLength(0);
		await run.ok("outlook_calendar_list_events", { calendar_id: WORK_ALIAS });
		await run.ok("outlook_calendar_create_event", { calendar_id: SHARED, ...event });
		expect(graph.writes.map(([path]) => path)).toEqual([`/me/calendars/${SHARED}/events`]);
	});

	test("test_events_are_read_in_utc_and_in_full", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [DEFAULT]: ["read"] });
		const args = { calendar_id: "primary", time_min: "2026-10-01T00:00:00+02:00", time_max: "2026-10-31T00:00:00Z" };
		const [standup, holiday, review] = (await items(run, "outlook_calendar_list_events", args)) as [Item, Item, Item];
		const views = graph.views();
		expect(views).toHaveLength(1);
		const request = views[0] as Received;
		expect(request.path).toBe(`/me/calendars/${DEFAULT}/calendarView`);
		expect([request.params.startDateTime, request.params.endDateTime]).toEqual(["2026-09-30T22:00:00Z", "2026-10-31T00:00:00Z"]);
		expect(request.params.$orderby).toBe("start/dateTime");
		expect(request.params.$top).toBe("25");
		const prefer = request.headers.get("prefer") as string;
		expect(prefer).toContain('outlook.timezone="UTC"');
		expect(prefer).toContain('outlook.body-content-type="text"');
		expect(prefer).toContain('IdType="ImmutableId"');

		expect([standup.start, standup.end, standup.all_day]).toEqual(["2026-10-05T07:00:00Z", "2026-10-05T07:15:00Z", false]);
		expect(standup.calendar_id).toBe(DEFAULT);
		expect((standup.body as string).length).toBeLessThanOrEqual(4000);
		expect(standup.body_truncated).toBe(true);
		expect(standup.attendees).toHaveLength(50);
		expect(standup.attendees_incomplete).toBe(true);
		expect((standup.attendees as Json[])[0]).toEqual({ email: "p0@example.com", name: "Person 0", type: "required", response: "accepted" });
		expect(standup.online_meeting_url).toBe("https://teams.microsoft.com/l/meetup-join/1");
		expect(standup.organizer).toBe("grace@example.com");
		expect(standup.location).toBe("Room 1");
		expect([holiday.start, holiday.end, holiday.all_day]).toEqual(["2026-10-06", "2026-10-08", true]);
		expect(review.body).toBe("Agenda");
		expect(review.body_truncated).toBe(false);
		expect(review.attendees_incomplete).toBe(false);
	});

	test("test_the_window_defaults_to_thirty_days", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [DEFAULT]: ["read"] });
		const window = (): [number, number] => {
			const params = (graph.views().at(-1) as Received).params;
			return [Date.parse(params.startDateTime as string), Date.parse(params.endDateTime as string)];
		};
		const DAY = 86_400_000;
		const before = Math.floor(Date.now() / 1000) * 1000;
		await run.ok("outlook_calendar_list_events", { calendar_id: DEFAULT });
		const [startAt, endAt] = window();
		expect(before <= startAt && startAt <= Date.now()).toBe(true);
		expect(endAt - startAt).toBe(30 * DAY);
		await run.ok("outlook_calendar_list_events", { calendar_id: DEFAULT, time_min: "2026-10-01T09:00:00+02:00" });
		expect(window()).toEqual([Date.UTC(2026, 9, 1, 7), Date.UTC(2026, 9, 31, 7)]);
		await run.ok("outlook_calendar_list_events", { calendar_id: DEFAULT, time_max: "2026-10-31T00:00:00Z" });
		expect(window()).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31)]);
		// Fractions of a second are kept.
		const bounds = { time_min: "2026-10-01T00:00:00.5+02:00", time_max: "2026-10-01T00:00:00.75+02:00" };
		await run.ok("outlook_calendar_list_events", { calendar_id: DEFAULT, ...bounds });
		const params = (graph.views().at(-1) as Received).params;
		expect([params.startDateTime, params.endDateTime]).toEqual(["2026-09-30T22:00:00.500000Z", "2026-09-30T22:00:00.750000Z"]);

		const invalid: JsonObject[] = [
			{ time_min: "2026-10-02T00:00:00Z", time_max: "2026-10-01T00:00:00Z" },
			{ time_min: "2026-01-01T00:00:00Z", time_max: "2027-01-03T00:00:00Z" },
			{ time_min: "2026-10-01" },
			{ time_min: "2026-10-01T09:00:00" },
			{ time_min: "2026-W40-1T09:00:00Z" },
			{ time_min: "2026-10-01T09:00:00+00:99" },
			{ time_min: "9999-12-31T00:00:00Z" },
			{ time_max: "0001-01-01T00:00:00Z" },
		];
		for (const change of invalid) expect(await run.code("outlook_calendar_list_events", { calendar_id: DEFAULT, ...change })).toBe("INVALID_ARGUMENTS");
	});

	test("the default window starts at the clock, microseconds kept only when there are some", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [DEFAULT]: ["read"] }, { connector: { now: () => Date.UTC(2026, 9, 7, 12, 34, 56, 789) } });
		await run.ok("outlook_calendar_list_events", { calendar_id: DEFAULT });
		const params = (graph.views().at(-1) as Received).params;
		expect([params.startDateTime, params.endDateTime]).toEqual(["2026-10-07T12:34:56.789000Z", "2026-11-06T12:34:56.789000Z"]);
		const whole = new FakeGraph();
		const other = await start(whole, { [DEFAULT]: ["read"] }, { connector: { now: () => Date.UTC(2026, 9, 7, 12, 34, 56) } });
		await other.ok("outlook_calendar_list_events", { calendar_id: DEFAULT });
		const { startDateTime, endDateTime } = (whole.views().at(-1) as Received).params;
		expect([startDateTime, endDateTime]).toEqual(["2026-10-07T12:34:56Z", "2026-11-06T12:34:56Z"]);
	});

	test("test_later_pages_repeat_the_first_pages_window", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [DEFAULT]: ["read"] });
		const args = { calendar_id: DEFAULT, time_min: "2026-10-01T00:00:00Z", limit: 2 };
		const first = await run.ok("outlook_calendar_list_events", args);
		expect((first.result.items as Item[]).map((item) => item.id)).toEqual(["standup00001", "holiday00001"]);
		const token = first.result.next_cursor as string;
		expect(token).not.toContain("skip");
		const firstParams = (graph.views().at(-1) as Received).params;
		const second = await run.ok("outlook_calendar_list_events", { ...args, cursor: token });
		expect((second.result.items as Item[]).map((item) => item.id)).toEqual(["review000001"]);
		expect("next_cursor" in second.result && second.result.next_cursor !== undefined).toBe(false);
		const view = graph.views().at(-1) as Received;
		expect(view.params.$skip).toBe("2");
		expect(view.headers.get("prefer")).toContain('outlook.timezone="UTC"');
		expect([view.params.startDateTime, view.params.endDateTime]).toEqual([firstParams.startDateTime, firstParams.endDateTime]);
		expect(await run.code("outlook_calendar_list_events", { ...args, calendar_id: "primary", cursor: token })).toBe("INVALID_CURSOR");
	});

	test("an unexpected answer is named as one, and Graph's text never reaches the model", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [DEFAULT]: ["read"] });
		graph.hook = (_method, path) => (path.endsWith("/calendarView") ? jsonResponse(200, { value: [{ id: 5 }] }) : null);
		const failed = await run.error("outlook_calendar_list_events", { calendar_id: DEFAULT });
		expect(failed.code).toBe("PROVIDER_FAILED");
		expect(failed.message).toBe("Outlook Calendar returned an unexpected response.");
		graph.hook = () => jsonResponse(404, { error: { code: "ErrorItemNotFound", message: SECRET } });
		expect(JSON.stringify(await run.error("outlook_calendar_list_events", { calendar_id: DEFAULT }))).not.toContain(SECRET);
	});
});

describe("creating", () => {
	test("test_creating_needs_the_create_grant_and_read_write_consent", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, { [DEFAULT]: ["read"], [WORK]: ["read", "create"] });
		const event = { subject: "Focus", start: "2026-10-05T10:00:00+02:00", end: "2026-10-05T11:00:00+02:00" };
		for (const calendar_id of ["primary", DEFAULT, PRIVATE, "AAMkNOSUCHCAL"]) {
			expect(await run.code("outlook_calendar_create_event", { calendar_id, ...event })).toBe("POLICY_DENIED");
		}
		expect(graph.writes).toHaveLength(0);

		// The user allowed it, but Microsoft has not given Minerva write access yet: the tool is not offered.
		run = await start(graph, { [WORK]: ["read", "create"] }, { scopes: READ_SCOPES });
		expect(run.tools).toContain("outlook_calendar_list_events");
		expect(run.tools).not.toContain("outlook_calendar_create_event");
		expect(await run.code("outlook_calendar_create_event", { calendar_id: WORK, ...event })).toBe("UNKNOWN_OPERATION");
		expect(graph.writes).toHaveLength(0);
	});

	test("test_timed_events_are_sent_in_utc_without_attendees", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [WORK]: ["read", "create"] });
		const args = {
			calendar_id: WORK_ALIAS,
			subject: "Focus",
			start: "2026-10-05T10:00:00+02:00",
			end: "2026-10-05T11:30:00+02:00",
			body: "Deep work\nNo meetings",
			location: "Home",
		};
		const [created] = await items(run, "outlook_calendar_create_event", args);
		expect(graph.writes).toHaveLength(1);
		const [path, payload] = graph.writes[0] as [string, JsonObject];
		expect(path).toBe(`/me/calendars/${WORK}/events`);
		expect(payload).toEqual({
			subject: "Focus",
			start: { dateTime: "2026-10-05T08:00:00", timeZone: "UTC" },
			end: { dateTime: "2026-10-05T09:30:00", timeZone: "UTC" },
			isAllDay: false,
			attendees: [],
			isOnlineMeeting: false,
			body: { contentType: "text", content: "Deep work\nNo meetings" },
			location: { displayName: "Home" },
		});
		expect(graph.requests.at(-1)?.headers.get("prefer")).toContain('outlook.timezone="UTC"');
		expect([created?.calendar_id, created?.subject]).toEqual([WORK, "Focus"]);
		expect([created?.start, created?.end]).toEqual(["2026-10-05T08:00:00Z", "2026-10-05T09:30:00Z"]);
	});

	test("test_all_day_events_are_created_in_the_owners_zone", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [WORK]: ["read", "create"] });
		const args: JsonObject = { calendar_id: WORK, subject: "Offsite", start: "2026-10-12", end: "2026-10-14", time_zone: "Europe/Berlin" };
		await run.ok("outlook_calendar_create_event", args);
		expect(graph.writes).toHaveLength(1);
		const payload = (graph.writes[0] as [string, JsonObject])[1];
		expect(payload.start).toEqual({ dateTime: "2026-10-12T00:00:00", timeZone: "Europe/Berlin" });
		expect(payload.end).toEqual({ dateTime: "2026-10-14T00:00:00", timeZone: "Europe/Berlin" });
		expect(payload.isAllDay).toBe(true);
		expect("body" in payload).toBe(false);
		expect("location" in payload).toBe(false);

		const changes: JsonObject[] = [
			{ time_zone: null },
			{ time_zone: "Europe/Zurich" },
			{ time_zone: "Mars/Olympus" },
			{ end: "2026-10-12" },
			{ end: "2026-10-14T00:00:00Z" },
			{ start: "2026-10-12T09:00:00Z", end: "2026-10-12T10:00:00Z" },
			{ subject: "Two\nlines" },
			{ subject: "" },
			{ start: "1899-12-31", end: "1900-01-01" },
			{ start: "2026-10-12T09:00:00+24:00", end: "2026-10-12T10:00:00Z", time_zone: null },
			{ start: "2026-10-12T09:00:00.9Z", end: "2026-10-12T09:00:00.1Z", time_zone: null },
		];
		for (const change of changes) {
			const attempt = Object.fromEntries(Object.entries({ ...args, ...change }).filter(([, value]) => value !== null));
			expect(await run.code("outlook_calendar_create_event", attempt)).toBe("INVALID_ARGUMENTS");
		}
		expect(graph.writes).toHaveLength(1);
	});

	test("test_write_outcomes_follow_graphs_status", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [WORK]: ["read", "create"] });
		const event = { calendar_id: WORK, start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z" };
		const answer = (make: () => Response) => {
			graph.hook = (method) => (method === "POST" ? make() : null);
		};
		answer(() => jsonResponse(400, { error: { code: "ErrorInvalidRequest", message: SECRET } }));
		expect(await run.code("outlook_calendar_create_event", { ...event, subject: "a" })).toBe("PROVIDER_REJECTED");
		answer(() => jsonResponse(403, { error: { code: "ErrorAccessDenied", message: SECRET } }));
		expect(await run.code("outlook_calendar_create_event", { ...event, subject: "b" })).toBe("PROVIDER_FORBIDDEN");
		// Created, but the answer cannot be read: the write counts, with nothing more to show.
		answer(() => new Response("<html>", { status: 201 }));
		const applied = await run.ok("outlook_calendar_create_event", { ...event, subject: "c" });
		expect(applied.result.outcome).toBe("applied_without_result");
		expect(applied.result.items).toEqual([]);
		// A server error may follow the write: unknown, and further writes pause.
		answer(() => jsonResponse(500, { error: { code: "x", message: SECRET } }));
		expect(await run.code("outlook_calendar_create_event", { ...event, subject: "d" })).toBe("WRITE_UNCERTAIN");
		graph.hook = null;
		expect(await run.code("outlook_calendar_create_event", { ...event, subject: "e" })).toBe("WRITE_UNCERTAIN");
	});

	test("the write is one POST with a UTF-8 JSON body", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { [WORK]: ["read", "create"] });
		await run.ok("outlook_calendar_create_event", { calendar_id: WORK, subject: "Grüße 😀", start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z" });
		const post = graph.requests.filter((request) => request.method === "POST");
		expect(post).toHaveLength(1);
		expect(post[0]?.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(post[0]?.body).toContain('"subject":"Grüße 😀"');
	});
});
