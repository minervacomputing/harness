// The Outlook Calendar connector against an in-memory Microsoft Graph behind an injected `fetch`, and runs
// through the executor.

import { describe, expect, test } from "vitest";
import { Time } from "../../src/connectors/outlook_calendar/client.ts";
import {
	type CalendarOptions,
	eventPayload,
	outlookCalendarConnector,
	pageState,
	shownTime,
	windowOf,
} from "../../src/connectors/outlook_calendar/connector.ts";
import { ZONES } from "../../src/connectors/outlook_calendar/zones.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { type Received, received } from "../fixtures/connectors/microsoft/fake.ts";
import { ceilingRow, startRun, validated } from "./connector-runs.ts";
import { askedScopes, catalogEntry, uncovered } from "./catalog-support.ts";
import { jsonResponse } from "./executor-fakes.ts";

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
 * Microsoft Graph's calendar API. Calendars: the default one, Work, a
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

describe("connecting and discovery", () => {
	test("account discovery and names", async () => {
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

	test("calendar pages are followed up to a cap", async () => {
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

	test("the catalog asks for the calendar read scope, and read-write to create", async () => {
		const connector = outlookCalendarConnector();
		const base = ["offline_access", "User.Read", "Calendars.Read"];
		expect(connector.auth).toMatchObject({
			type: "oauth2",
			app: "microsoft",
			authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			scopes: base,
		});
		const entry = await catalogEntry(connector);
		expect(entry.auth).toMatchObject({ scopes: base });
		expect(askedScopes(entry)).toEqual({ list_calendars: ["Calendars.Read"], list_events: ["Calendars.Read"], create_event: ["Calendars.ReadWrite"] });
		expect(uncovered(entry, ["User.Read", "Calendars.Read"])).toEqual(["create_event"]);
		// Read-write covers reading, in any of the spellings Microsoft reports.
		expect(uncovered(entry, ["https://graph.microsoft.com/calendars.readwrite"])).toEqual([]);
		expect(uncovered(entry, ["calendars.read"])).toEqual(["create_event"]);
		expect(uncovered(entry, ["Calendars.ReadBasic"])).toEqual(["list_calendars", "list_events", "create_event"]);
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
	test("only documented zones are offered", () => {
		for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"]) expect(ZONES.has(zone)).toBe(true);
		for (const zone of ["Europe/Zurich", "US/Eastern", "CET", "Local"]) expect(ZONES.has(zone)).toBe(false);
	});
});

describe("page state", () => {
	test("cursors belong to their calendar", () => {
		const state = { calendar: WORK, page: "skip:2", start: "a", end: "b" };
		expect(pageState(JSON.stringify(state), WORK)).toEqual(state);
		const { end: _end, ...partial } = state;
		const refused: [string, string][] = [
			[JSON.stringify(state), DEFAULT],
			[JSON.stringify({ ...state, extra: "x" }), WORK],
			[JSON.stringify({ ...state, page: 2 }), WORK],
			[JSON.stringify(partial), WORK],
			[JSON.stringify([state]), WORK],
			["null", WORK],
			["skip:2", WORK],
		];
		for (const [cursor, calendar] of refused) expect(() => pageState(cursor, calendar)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
	});
});

describe("times and tool inputs", () => {
	test("event times are shown to the second, in UTC with a Z, else with Graph's zone, and all-day ones as dates", () => {
		const shown = (time: Json, allDay = false) => shownTime(Time.parse(time), allDay);
		expect(shown({ dateTime: "2026-10-05T07:00:00.0000000", timeZone: "UTC" })).toBe("2026-10-05T07:00:00Z");
		expect(shown({ dateTime: "2026-10-05T07:00:00.0000000", timeZone: "utc" })).toBe("2026-10-05T07:00:00Z");
		expect(shown({ dateTime: "2026-10-05T07:00", timeZone: "UTC" })).toBe("2026-10-05T07:00Z");
		expect(shown({ dateTime: "2026-10-06T00:00:00.0000000", timeZone: "UTC" }, true)).toBe("2026-10-06");
		expect(shown({ dateTime: "2026-10-05", timeZone: "UTC" }, true)).toBe("2026-10-05");
		expect(shown({ dateTime: "2026-10-05T07:00:00.0000000", timeZone: "Pacific Standard Time" })).toBe("2026-10-05T07:00:00 Pacific Standard Time");
		// Without a zone the moment is shown as Graph gave it.
		expect(shown({ dateTime: "2026-10-05T07:00:00.0000000", timeZone: null })).toBe("2026-10-05T07:00:00");
		expect(shown({ dateTime: "2026-10-05T07:00:00.0000000" })).toBe("2026-10-05T07:00:00");
		expect(shownTime(null, false)).toBeNull();
	});

	/** What list_events makes of its arguments: the window it asks Graph for, or the field it refuses. */
	async function listed(args: { [key: string]: Json }): Promise<[string, string] | string> {
		const result = await validated(outlookCalendarConnector(), "list_events", { calendar_id: WORK, ...args });
		if ("refused" in result) return result.refused;
		return windowOf(result.ok as { time_min: string | null; time_max: string | null }, Date.parse("2026-10-01T00:00:00Z"));
	}

	test("list_events: its defaults, and the window it asks for", async () => {
		expect(await validated(outlookCalendarConnector(), "list_events", { calendar_id: "primary" })).toEqual({
			ok: { calendar_id: "primary", time_min: null, time_max: null, limit: 25, cursor: null },
		});
		const windows: [{ [key: string]: Json }, [string, string]][] = [
			[{}, ["2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"]],
			[{ time_min: "2026-10-01T09:00:00+02:00" }, ["2026-10-01T07:00:00Z", "2026-10-31T07:00:00Z"]],
			[{ time_max: "2026-10-31T00:00:00Z" }, ["2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z"]],
			[{ time_min: "2026-01-01T00:00:00Z", time_max: "2027-01-02T00:00:00Z" }, ["2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z"]],
			[{ time_min: "2026-10-01T02:00:00+02:00", time_max: "2026-10-01T00:00:00.000001Z" }, ["2026-10-01T00:00:00Z", "2026-10-01T00:00:00.000001Z"]],
			[{ time_min: "2026-10-01T00:00:00.5+02:00", time_max: "2026-10-01T00:00:00.75+02:00" }, ["2026-09-30T22:00:00.500000Z", "2026-09-30T22:00:00.750000Z"]],
			[{ time_min: "2026-03-29T01:30:00+01:00", time_max: "2026-03-29T03:30:00+02:00" }, ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"]],
			[{ time_min: "1900-01-01T00:00:00+05:00" }, ["1899-12-31T19:00:00Z", "1900-01-30T19:00:00Z"]],
			[{ time_max: "2999-12-31T23:00:00-05:00" }, ["2999-12-02T04:00:00Z", "3000-01-01T04:00:00Z"]],
			[{ time_min: "2026-10-01T09:00Z" }, ["2026-10-01T09:00:00Z", "2026-10-31T09:00:00Z"]],
			[{ time_min: "2026-10-01T09:00:00-23:59" }, ["2026-10-02T08:59:00Z", "2026-11-01T08:59:00Z"]],
			[{ time_min: "2026-10-01T09:00:00Z\n" }, ["2026-10-01T09:00:00Z", "2026-10-31T09:00:00Z"]],
		];
		for (const [args, window] of windows) expect(await listed(args), JSON.stringify(args)).toEqual(window);
	});

	test("list_events refuses odd calendars, limits, and times outside RFC 3339 or the years 1900 to 2999", async () => {
		const refused: [{ [key: string]: Json }, string][] = [
			[{ calendar_id: "Work" }, "calendar_id"],
			[{ calendar_id: "../me" }, "calendar_id"],
			[{ calendar_id: "AAMk/CAL/WORK" }, "calendar_id"],
			[{ limit: 0 }, "limit"],
			[{ limit: 51 }, "limit"],
			[{ cursor: "x".repeat(4097) }, "cursor"],
			[{ time_min: "2026-10-02T00:00:00Z", time_max: "2026-10-01T00:00:00Z" }, "time_max must be after time_min"],
			[{ time_min: "2026-10-01T00:00:00Z", time_max: "2026-10-01T00:00:00Z" }, "time_max must be after time_min"],
			[{ time_min: "2026-01-01T00:00:00Z", time_max: "2027-01-03T00:00:00Z" }, "366 days"],
			[{ time_min: "2026-01-01T00:00:00Z", time_max: "2027-01-02T00:00:00.000001Z" }, "366 days"],
			...[
				"",
				"2026-10-01",
				"2026-10-01T09:00:00",
				"2026-W40-1T09:00:00Z",
				"2026-10-01T09:00:00+00:99",
				"2026-10-01T09:00:00+24:00",
				"2026-10-01T09:00:00.1234567Z",
				"2026-10-01T09:00:00,5Z",
				"2026-10-01t09:00:00z",
				"2026-10-01 09:00:00Z",
				"2026-10-01T09:00:00Ｚ",
				"２０２６-10-01T09:00:00Z",
				"2026-10-01T0٩:00:00Z",
				"2026-02-30T09:00:00Z",
				"2026-13-01T09:00:00Z",
				"2026-10-00T09:00:00Z",
				"2026-10-01T24:00:00Z",
				"2026-10-01T25:00:00Z",
				"2026-10-01T23:60:00Z",
				"2026-10-01T23:59:60Z",
				"1899-12-31T23:59:59Z",
				"3000-01-01T00:00:00Z",
				"0000-10-01T09:00:00Z",
			].map((time_min): [{ [key: string]: Json }, string] => [{ time_min }, "time_min"]),
		];
		for (const [args, named] of refused) expect(await listed(args), JSON.stringify(args)).toEqual(expect.stringContaining(named));
	});

	/** What create_event sends Graph for its arguments, or the field it refuses. */
	async function created(args: { [key: string]: Json }): Promise<Json | string> {
		const result = await validated(outlookCalendarConnector(), "create_event", { calendar_id: WORK, ...args });
		return "refused" in result ? result.refused : eventPayload(result.ok as never);
	}

	test("create_event sends timed events in UTC and all-day ones in their zone, without attendees", async () => {
		const timedAt = (start: string, end: string, extra: { [key: string]: Json } = {}) => ({
			subject: "Focus",
			start: { dateTime: start, timeZone: "UTC" },
			end: { dateTime: end, timeZone: "UTC" },
			isAllDay: false,
			attendees: [],
			isOnlineMeeting: false,
			...extra,
		});
		const offsite = (zone: string) => ({
			subject: "Offsite",
			start: { dateTime: "2026-10-12T00:00:00", timeZone: zone },
			end: { dateTime: "2026-10-14T00:00:00", timeZone: zone },
			isAllDay: true,
			attendees: [],
			isOnlineMeeting: false,
		});
		const FOCUS = { subject: "Focus", start: "2026-10-05T10:00:00+02:00", end: "2026-10-05T11:30:00+02:00" };
		const OFFSITE = { subject: "Offsite", start: "2026-10-12", end: "2026-10-14" };
		expect(await created(FOCUS)).toEqual(timedAt("2026-10-05T08:00:00", "2026-10-05T09:30:00"));
		expect(await created({ ...FOCUS, body: "Deep work\nNo meetings", location: "Home" })).toEqual(
			timedAt("2026-10-05T08:00:00", "2026-10-05T09:30:00", { body: { contentType: "text", content: "Deep work\nNo meetings" }, location: { displayName: "Home" } }),
		);
		expect(await created({ ...FOCUS, body: "", location: "" })).toEqual(timedAt("2026-10-05T08:00:00", "2026-10-05T09:30:00"));
		expect(await created({ ...FOCUS, start: "2026-10-05T10:00:00.5+02:00", end: "2026-10-05T11:30:00.250001+02:00" })).toEqual(
			timedAt("2026-10-05T08:00:00.500000", "2026-10-05T09:30:00.250001"),
		);
		expect(await created({ ...FOCUS, start: "2026-10-12T09:00:00Z", end: "2026-10-12T09:00:00.000001Z" })).toEqual(timedAt("2026-10-12T09:00:00", "2026-10-12T09:00:00.000001"));
		for (const zone of ["Europe/Berlin", "UTC", "Etc/GMT+12"]) expect(await created({ ...OFFSITE, time_zone: zone })).toEqual(offsite(zone));
		expect(await created({ ...OFFSITE, time_zone: " Europe/Berlin " })).toEqual(offsite("Europe/Berlin"));
	});

	test("create_event refuses mixed, reversed or unzoned times, unknown zones and odd text", async () => {
		const FOCUS = { subject: "Focus", start: "2026-10-05T10:00:00+02:00", end: "2026-10-05T11:30:00+02:00" };
		const OFFSITE = { subject: "Offsite", start: "2026-10-12", end: "2026-10-14", time_zone: "Europe/Berlin" };
		const refused: [{ [key: string]: Json }, string][] = [
			[{ ...OFFSITE, time_zone: null }, "time_zone is required for all-day events"],
			[{ ...OFFSITE, time_zone: "Europe/Zurich" }, "time_zone"],
			[{ ...OFFSITE, time_zone: "Mars/Olympus" }, "time_zone"],
			[{ ...OFFSITE, time_zone: "US/Eastern" }, "time_zone"],
			[{ ...OFFSITE, time_zone: "x".repeat(65) }, "time_zone"],
			[{ ...OFFSITE, end: "2026-10-12" }, "end must be after start"],
			[{ ...OFFSITE, end: "2026-10-11" }, "end must be after start"],
			[{ ...OFFSITE, end: "2026-10-14T00:00:00Z" }, "both be dates or both be date-times"],
			[{ ...FOCUS, start: "2026-10-12" }, "both be dates or both be date-times"],
			[{ ...FOCUS, start: "2026-10-12T09:00:00Z", end: "2026-10-12T10:00:00Z", time_zone: "Europe/Berlin" }, "time_zone is only for all-day events"],
			[{ ...FOCUS, end: FOCUS.start }, "end must be after start"],
			[{ ...FOCUS, start: "2026-10-12T09:00:00.9Z", end: "2026-10-12T09:00:00.1Z" }, "end must be after start"],
			[{ ...FOCUS, start: "2026-10-12T09:00:00+24:00", end: "2026-10-12T10:00:00Z" }, "start"],
			[{ ...FOCUS, start: "2026-10-12T24:00:00Z", end: "2026-10-13T01:00:00Z" }, "start"],
			[{ ...FOCUS, start: "2026-02-30T09:00:00Z" }, "start"],
			[{ ...OFFSITE, start: "2026-02-30" }, "start"],
			[{ ...OFFSITE, start: "２０２６-10-12" }, "start"],
			[{ ...OFFSITE, start: "1899-12-31", end: "1900-01-01" }, "start"],
			[{ ...OFFSITE, start: "2999-12-31", end: "3000-01-01" }, "end"],
			[{ ...OFFSITE, subject: "Two\nlines" }, "subject"],
			[{ ...OFFSITE, subject: "" }, "subject"],
			[{ ...OFFSITE, subject: "x".repeat(256) }, "subject"],
			[{ ...FOCUS, body: "bell\u0007" }, "body"],
			[{ ...FOCUS, location: "a\tb" }, "location"],
			[{ subject: "x", start: "2026-10-12" }, "end"],
			[{ ...FOCUS, attendees: [] }, "attendees"],
		];
		for (const [args, named] of refused) expect(await created(args), JSON.stringify(args)).toEqual(expect.stringContaining(named));
	});
});

describe("reading", () => {
	test("calendars without a grant or unknown look alike", async () => {
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

	test("a deny holds under every id graph accepts", async () => {
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

	test("events are read in UTC and in full", async () => {
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

	test("the window defaults to thirty days", async () => {
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

	test("later pages repeat the first pages window", async () => {
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
	test("creating needs the create grant and read write consent", async () => {
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

	test("timed events are sent in UTC without attendees", async () => {
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

	test("all-day events are created in the owner's zone", async () => {
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

	test("write outcomes follow Graph's status", async () => {
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
