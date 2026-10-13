// backend/tests/test_google_calendar.py, case by case: the connector against an in-memory Calendar API
// behind an injected `fetch`, and runs through the executor. Input validation and Python's date and time
// messages are compared with vectors from today's Python (test/fixtures/connectors/google/generate.py).

import { describe, expect, test } from "vitest";
import { consentGiven } from "../../src/gateway/connector.ts";
import { googleCalendarConnector, EVENTS_SCOPE, FULL_SCOPE, READ_SCOPE } from "../../src/connectors/google_calendar/connector.ts";
import type { GoogleCalendarClient } from "../../src/connectors/google_calendar/client.ts";
import { checkDateOrDateTime, checkDateTime, nowIso } from "../../src/connectors/google_calendar/times.ts";
import { ZONES } from "../../src/lib/zones.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import type { Json } from "../../src/lib/json.ts";
import { parseJson } from "../../src/lib/json.ts";
import { CONNECTION, ceilingRow, jsonResponse, operation, requestOf, settingsClient, startRun, validationOutcomes } from "../fixtures/connectors/google/runs.ts";
import { vectors } from "../fixtures/connectors/google/vectors.ts";
import { changedOnPurpose, jsonQuoted } from "./changed.ts";

const PRIMARY = "ada@example.com";
const UNIVERSITY = "uni@group.calendar.google.com";
const HOLIDAYS = "de.german#holiday@group.v.calendar.google.com";
const BASE_SCOPES = ["openid", "email", READ_SCOPE];
const READS = { [`calendar:${PRIMARY}`]: ["read"], [`calendar:${UNIVERSITY}`]: ["read"] };

type JsonObject = { [key: string]: Json };

/** Google Calendar API v3 and the OpenID userinfo endpoint (test_google_calendar.py `FakeCalendar`). */
class FakeCalendar {
	calendars: JsonObject[] = [
		{ id: PRIMARY, summary: PRIMARY, primary: true, accessRole: "owner", timeZone: "Europe/Berlin" },
		{ id: UNIVERSITY, summary: "Uni", summaryOverride: "University", accessRole: "owner" },
		{ id: HOLIDAYS, summary: "Holidays in Germany", accessRole: "reader" },
	];
	pageSize = 250;
	sub = "108";
	events: { [calendar: string]: JsonObject[] } = {
		[PRIMARY]: [0, 1, 2].map((i) => ({
			id: `e${i}`,
			summary: `Lecture ${i}`,
			start: { dateTime: `2026-10-0${i + 1}T09:00:00+02:00`, timeZone: "Europe/Berlin" },
			end: { dateTime: `2026-10-0${i + 1}T10:00:00+02:00`, timeZone: "Europe/Berlin" },
		})),
		[UNIVERSITY]: [{ id: "exam", summary: "Exam", start: { date: "2026-10-10" } }],
		[HOLIDAYS]: [{ id: "unity", status: "cancelled" }],
	};
	created: [url: URL, body: JsonObject][] = [];
	requests: Request[] = [];
	error: [number, Json] | null = null;

	readonly fetch: typeof fetch = async (input, init) => {
		const request = requestOf(input, init as RequestInit);
		this.requests.push(request);
		const url = new URL(request.url);
		if (this.error) return jsonResponse(this.error[0], this.error[1]);
		if (url.host === "openidconnect.googleapis.com") return jsonResponse(200, { sub: this.sub, email: PRIMARY, name: "Ada" });
		if (url.pathname === "/calendar/v3/users/me/calendarList") {
			const start = Number(url.searchParams.get("pageToken") || 0);
			const end = start + this.pageSize;
			const page: JsonObject = { kind: "calendar#calendarList", items: this.calendars.slice(start, end) };
			if (end < this.calendars.length) page.nextPageToken = String(end);
			return jsonResponse(200, page);
		}
		// Calendar ids contain `#` and `@`, so segments are compared decoded.
		const parts = url.pathname.split("/").map(decodeURIComponent).slice(3);
		if (parts.length === 4 && parts[0] === "users" && parts[2] === "calendarList") {
			const id = parts[3] as string;
			// Google also accepts other spellings of an id, such as a differently cased address.
			const wanted = this.calendars.find((c) => (c.id as string).toLowerCase() === id.toLowerCase() || (id === "primary" && c.primary));
			if (wanted) return jsonResponse(200, wanted);
		}
		if (parts.length === 3 && parts[0] === "calendars" && parts[2] === "events" && request.method === "GET") {
			const events = this.events[parts[1] as string] ?? [];
			const start = Number((url.searchParams.get("pageToken") || "google-0").replace(/^google-/, ""));
			const end = start + Number(url.searchParams.get("maxResults"));
			const page: JsonObject = { items: events.slice(start, end) };
			if (end < events.length) page.nextPageToken = `google-${end}`;
			return jsonResponse(200, page);
		}
		if (parts.length === 3 && parts[0] === "calendars" && parts[2] === "events" && request.method === "POST") {
			const body = parseJson(await request.text()) as JsonObject;
			this.created.push([url, body]);
			return jsonResponse(200, { ...body, id: `new${this.created.length}`, status: "confirmed" });
		}
		if (parts.length === 4 && parts[0] === "calendars" && parts[2] === "events") {
			const found = (this.events[parts[1] as string] ?? []).find((e) => e.id === parts[3]);
			if (found) return jsonResponse(200, found);
		}
		return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
	};

	client(options: Parameters<typeof googleCalendarConnector>[0] = {}): GoogleCalendarClient {
		return settingsClient(googleCalendarConnector(options), this.fetch);
	}
}

function googleError(reason: string): Json {
	return { error: { code: 403, message: "no", errors: [{ reason, domain: "usageLimits" }] } };
}

function start(google: FakeCalendar, scopes: string[] | null, grants: { [key: string]: string[] }, ceiling = [] as ReturnType<typeof ceilingRow>[]) {
	return startRun(googleCalendarConnector(), google.fetch, { scopes, grants, ceiling });
}

function calendars(grants: { [id: string]: string[] }): { [key: string]: string[] } {
	return Object.fromEntries(Object.entries(grants).map(([id, actions]) => [`calendar:${id}`, actions]));
}

describe("Python's dates and times", () => {
	test("date-times are checked as datetime.fromisoformat checks them", () => {
		const checks: [string, (value: string) => string][] = [
			["date_time", checkDateTime],
			["date_or_date_time", checkDateOrDateTime],
		];
		for (const [name, check] of checks) {
			const cases = vectors().dates[name] as { [value: string]: { ok?: string; message?: string } };
			const actual: { [value: string]: unknown } = {};
			const expected: { [value: string]: unknown } = {};
			for (const [value, outcome] of Object.entries(cases)) {
				if (changedOnPurpose(value)) continue;
				expected[value] = outcome.message === undefined ? "ok" : jsonQuoted(outcome.message);
				try {
					check(value);
					actual[value] = "ok";
				} catch (error) {
					actual[value] = (error as Error).message;
				}
			}
			expect(Object.keys(cases).length).toBeGreaterThan(200);
			expect(actual).toEqual(expected);
		}
	});

	test("the default lower bound is now, to the second, in UTC", () => {
		expect(nowIso(Date.UTC(2026, 9, 11, 12, 34, 56, 789))).toBe("2026-10-11T12:34:56+00:00");
	});

	test("time zones are zoneinfo's, aliases included", () => {
		expect(ZONES.has("US/Pacific")).toBe(true);
		expect(ZONES.has("Europe/Berlin")).toBe(true);
		expect(ZONES.has("Mars/Olympus")).toBe(false);
		expect(ZONES.size).toBeGreaterThan(590);
	});
});

describe("input validation, as Pydantic words it", () => {
	const connector = googleCalendarConnector();
	for (const name of ["create_event", "list_events", "get_event"]) {
		test(name, async () => {
			const { actual, expected } = await validationOutcomes(operation(connector, name), vectors().calendar[name]);
			expect(actual).toEqual(expected);
		});
	}

	test("test_event_input_is_validated", async () => {
		const event = { calendar_id: UNIVERSITY, summary: "Study group", start: "2026-10-02T14:00:00+02:00", end: "2026-10-02T15:00:00+02:00" };
		const op = operation(connector, "create_event");
		const { validateInput } = await import("../../src/gateway/validation.ts");
		for (const change of [
			{ start: "2026-10-02", end: "2026-10-02T15:00:00+02:00" },
			{ start: "2026-10-02T15:00:00", end: "2026-10-02T16:00:00" },
			{ start: "2026-10-02T15:00:00+02:00", end: "2026-10-02T15:00:00+02:00" },
			{ start: "2026-10-03", end: "2026-10-02" },
			{ start: 1790000000, end: 1790003600 },
			{ start: "2026-02-30", end: "2026-03-02" },
			{ time_zone: "Mars/Olympus" },
			{ calendar_id: "a/b" },
			{ calendar_id: ".." },
			{ summary: "" },
		]) {
			expect((await validateInput(op.input as never, { ...event, ...change } as Json)).ok).toBe(false);
		}
	});

	test("test_event_listing_bounds_are_validated", async () => {
		const op = operation(connector, "list_events");
		const { validateInput } = await import("../../src/gateway/validation.ts");
		expect((await validateInput(op.input as never, { calendar_id: PRIMARY, time_min: "2026-10-02T00:00:00Z", time_max: "2026-10-01T00:00:00Z" })).ok).toBe(false);
		expect((await validateInput(op.input as never, { calendar_id: PRIMARY, time_min: "2026-10-02" })).ok).toBe(false);
	});
});

describe("the connector outside a run", () => {
	test("test_the_account_is_the_openid_subject", async () => {
		const google = new FakeCalendar();
		const account = await googleCalendarConnector().account(google.client());
		expect(account).toEqual({ id: "108", label: PRIMARY });
		expect(google.requests[0]?.headers.get("authorization")).toBe("Bearer token");
	});

	test("test_discovery_pages_through_readable_calendars_and_filters_by_name", async () => {
		const google = new FakeCalendar();
		google.pageSize = 2;
		const connector = googleCalendarConnector();
		const page = await connector.discover(google.client(), "calendar", { query: null, cursor: null });
		expect(page.items.map((item) => [item.id, item.name])).toEqual([
			[PRIMARY, PRIMARY],
			[UNIVERSITY, "University"],
			[HOLIDAYS, "Holidays in Germany"],
		]);
		expect(google.requests.length).toBe(2);
		expect(new URL(google.requests[0]?.url as string).searchParams.get("minAccessRole")).toBe("reader");
		const found = await connector.discover(google.client(), "calendar", { query: "UNIVERS", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([UNIVERSITY]);
		expect(await connector.describe(google.client(), "calendar", [UNIVERSITY, "gone"])).toEqual({ [UNIVERSITY]: "University" });
	});

	test("names match ignoring case", async () => {
		const google = new FakeCalendar();
		google.calendars.push({ id: "strasse@example.com", summary: "Straße", accessRole: "owner" });
		const found = await googleCalendarConnector().discover(google.client(), "calendar", { query: "STRAßE", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual(["strasse@example.com"]);
	});

	test("test_an_account_with_too_many_calendars_is_refused", async () => {
		const google = new FakeCalendar();
		google.pageSize = 1;
		const connector = googleCalendarConnector({ maxCalendarPages: 2 });
		await expect(connector.discover(google.client(), "calendar", { query: null, cursor: null })).rejects.toMatchObject({ code: "PROVIDER_LIMIT" });
	});

	const errors: [number, Json, string][] = [
		[403, googleError("rateLimitExceeded"), "PROVIDER_RATE_LIMITED"],
		[403, googleError("userRateLimitExceeded"), "PROVIDER_RATE_LIMITED"],
		[403, googleError("insufficientPermissions"), "PROVIDER_FORBIDDEN"],
		[403, { unexpected: true }, "PROVIDER_FORBIDDEN"],
		[200, { items: [{ summary: "no id" }] }, "PROVIDER_FAILED"],
	];
	for (const [status, body, code] of errors) {
		test(`test_provider_errors_are_mapped: ${status} ${JSON.stringify(body)}`, async () => {
			const google = new FakeCalendar();
			google.error = [status, body];
			const caught = await google
				.client()
				.calendars()
				.catch((error: unknown) => error);
			expect(caught).toBeInstanceOf(OperationError);
			expect((caught as OperationError).code).toBe(code);
		});
	}
});

describe("runs through the executor", () => {
	test("test_an_agent_lists_only_the_calendars_it_was_granted", async () => {
		const google = new FakeCalendar();
		const run = await start(google, BASE_SCOPES, READS);
		const outcome = await run.ok("google_calendar_list_calendars", {});
		expect(outcome.result.items.map((item) => item.id)).toEqual([PRIMARY, UNIVERSITY]);
		expect(outcome.result.items[1]?.name).toBe("University");

		// Without consent to calendar access the tool is refused, and no longer offered.
		run.credentials.replace(CONNECTION, { kind: "oauth2", access_token: "t", refresh_token: null, scopes: ["openid", "email"] });
		expect(await run.code("google_calendar_list_calendars", {})).toBe("CONSENT_REQUIRED");
		expect((await start(google, ["openid"], READS)).tools).not.toContain("google_calendar_list_calendars");
	});

	test("test_events_are_listed_only_from_granted_calendars", async () => {
		const google = new FakeCalendar();
		const run = await start(google, BASE_SCOPES, READS);
		const outcome = await run.ok("google_calendar_list_events", { calendar_id: UNIVERSITY });
		expect(outcome.result.items.map((e) => [e.id, e.all_day, e.calendar_id])).toEqual([["exam", true, UNIVERSITY]]);
		const params = new URL(google.requests.at(-1)?.url as string).searchParams;
		expect([params.get("singleEvents"), params.get("orderBy")]).toEqual(["true", "startTime"]);
		// Without bounds, events are listed from now on.
		expect(params.has("timeMin")).toBe(true);
		expect(params.has("timeMax")).toBe(false);
		expect(await run.code("google_calendar_list_events", { calendar_id: HOLIDAYS })).toBe("POLICY_DENIED");
		const eventRequests = google.requests.filter((r) => new URL(r.url).pathname.includes("events"));
		expect(eventRequests.every((r) => !decodeURIComponent(new URL(r.url).pathname).includes(HOLIDAYS))).toBe(true);
	});

	test("test_primary_resolves_to_the_real_calendar_and_its_grant", async () => {
		const google = new FakeCalendar();
		let run = await start(google, BASE_SCOPES, calendars({ [UNIVERSITY]: ["read"] }));
		expect(await run.code("google_calendar_list_events", { calendar_id: "primary" })).toBe("POLICY_DENIED");

		run = await start(google, BASE_SCOPES, calendars({ [PRIMARY]: ["read"] }));
		const outcome = await run.ok("google_calendar_get_event", { calendar_id: "primary", event_id: "e1" });
		const [event] = outcome.result.items;
		expect([event?.calendar_id, event?.summary, event?.time_zone]).toEqual([PRIMARY, "Lecture 1", "Europe/Berlin"]);
		expect(decodeURIComponent(new URL(google.requests.at(-1)?.url as string).pathname).endsWith(`/calendars/${PRIMARY}/events/e1`)).toBe(true);
	});

	test("test_other_spellings_of_a_calendar_id_meet_its_grants", async () => {
		const google = new FakeCalendar();
		const deny = ceilingRow(CONNECTION, "calendar", UNIVERSITY, "deny");
		const run = await start(google, BASE_SCOPES, calendars({ "*": ["read"] }), [deny]);
		for (const spelling of [UNIVERSITY, UNIVERSITY.toUpperCase()]) {
			expect(await run.code("google_calendar_list_events", { calendar_id: spelling })).toBe("POLICY_DENIED");
		}
		// Calendars outside the user's list are refused even under a wildcard grant.
		expect(await run.code("google_calendar_list_events", { calendar_id: "eve@example.com" })).toBe("POLICY_DENIED");
		expect(google.requests.filter((r) => new URL(r.url).pathname.endsWith("/events"))).toEqual([]);
		const outcome = await run.ok("google_calendar_list_events", { calendar_id: PRIMARY.toUpperCase() });
		expect(new Set(outcome.result.items.map((e) => e.calendar_id))).toEqual(new Set([PRIMARY]));
	});

	test("test_later_pages_repeat_the_first_pages_time_bound", async () => {
		const google = new FakeCalendar();
		const run = await start(google, BASE_SCOPES, READS);
		const args = { calendar_id: PRIMARY, limit: 2, search: "Lecture" };
		const first = await run.ok("google_calendar_list_events", args);
		expect(first.result.items.map((e) => e.id)).toEqual(["e0", "e1"]);
		const token = first.result.next_cursor as string;
		expect(token).not.toContain("google-");
		const firstRequest = new URL(google.requests.at(-1)?.url as string).searchParams;
		expect(firstRequest.get("q")).toBe("Lecture");
		const second = await run.ok("google_calendar_list_events", { ...args, cursor: token });
		expect(second.result.items.map((e) => e.id)).toEqual(["e2"]);
		expect("next_cursor" in second.result).toBe(false);
		const params = new URL(google.requests.at(-1)?.url as string).searchParams;
		expect([params.get("pageToken"), params.get("timeMin")]).toEqual(["google-2", firstRequest.get("timeMin")]);
		expect(await run.code("google_calendar_list_events", { ...args, search: "Exam", cursor: token })).toBe("INVALID_CURSOR");
	});

	test("test_creating_an_event_needs_the_create_grant_and_the_events_scope", async () => {
		const google = new FakeCalendar();
		const event = {
			calendar_id: UNIVERSITY,
			summary: "Study group",
			start: "2026-10-02T14:00:00+02:00",
			end: "2026-10-02T15:00:00+02:00",
			time_zone: "Europe/Berlin",
		};
		let run = await start(google, BASE_SCOPES, calendars({ [UNIVERSITY]: ["read", "create"] }));
		// The user allowed it, but Google has not given Minerva write access yet: the tool is not offered.
		expect(run.tools).not.toContain("google_calendar_create_event");
		expect(await run.code("google_calendar_create_event", event)).toBe("UNKNOWN_OPERATION");

		// Creating is allowed on another calendar only.
		run = await start(google, [...BASE_SCOPES, EVENTS_SCOPE], { ...READS, [`calendar:${PRIMARY}`]: ["read", "create"] });
		expect(await run.code("google_calendar_create_event", event)).toBe("POLICY_DENIED");
		expect(google.created).toEqual([]);

		run = await start(google, [...BASE_SCOPES, EVENTS_SCOPE], calendars({ [UNIVERSITY]: ["read", "create"] }));
		const outcome = await run.ok("google_calendar_create_event", event);
		expect(outcome.result.items[0]?.id).toBe("new1");
		const [[url, body]] = google.created as [[URL, JsonObject]];
		expect(url.searchParams.get("sendUpdates")).toBe("none");
		expect(body).toEqual({
			summary: "Study group",
			start: { dateTime: event.start, timeZone: "Europe/Berlin" },
			end: { dateTime: event.end, timeZone: "Europe/Berlin" },
		});
		// Guests cannot be invited: attendees are not an input.
		expect(await run.code("google_calendar_create_event", { ...event, attendees: ["eve@example.com"] })).toBe("INVALID_ARGUMENTS");

		// Full calendar access also covers it.
		run = await start(google, ["openid", "email", FULL_SCOPE], calendars({ "*": ["read", "create"] }));
		await run.ok("google_calendar_create_event", { calendar_id: "primary", summary: "Trip", start: "2026-10-05", end: "2026-10-07" });
		const [lastUrl, lastBody] = google.created.at(-1) as [URL, JsonObject];
		expect(lastBody.start).toEqual({ date: "2026-10-05" });
		expect(decodeURIComponent(lastUrl.pathname).startsWith(`/calendar/v3/calendars/${PRIMARY}/`)).toBe(true);
	});

	test("test_a_disabled_calendar_api_is_explained_and_the_connection_kept", async () => {
		const google = new FakeCalendar();
		const run = await start(google, BASE_SCOPES, READS);
		google.error = [
			403,
			{
				error: {
					code: 403,
					message: "Google Calendar API has not been used in project 1 before or it is disabled.",
					errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
				},
			},
		];
		const error = await run.error("google_calendar_list_events", { calendar_id: UNIVERSITY });
		expect(error.code).toBe("PROVIDER_NOT_CONFIGURED");
		expect(error.message).toContain("not enabled");
		expect(run.credentials.status(CONNECTION)).toBe("active");
	});
});

describe("consent and scopes (the connector's part of the reconnect tests)", () => {
	const connector = googleCalendarConnector();

	test("test_allowed_actions_the_provider_has_not_granted_are_reported", () => {
		expect(consentNeeded(connector, BASE_SCOPES, new Set())).toEqual([]);
		expect(consentNeeded(connector, BASE_SCOPES, new Set(["read", "create"]))).toEqual(["create"]);
		expect(consentNeeded(connector, ["openid", FULL_SCOPE], new Set(["read", "create"]))).toEqual([]);
		// Unknown scopes (the provider did not say what it granted) need nothing: Google will refuse instead.
		expect(consentNeeded(connector, null, new Set(["read", "create"]))).toEqual([]);
	});

	test("test_reconnecting_asks_only_for_what_allowed_actions_lack", () => {
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(BASE_SCOPES);
		expect(requestedScopes(connector, new Set(["read", "create"]))).toEqual([...BASE_SCOPES, EVENTS_SCOPE]);
		// Stored scopes are not trusted: Google forgets a grant the user revoked.
		expect(requestedScopes(connector, new Set(["create"]))).toEqual([...BASE_SCOPES, EVENTS_SCOPE]);
		expect(consentGiven(operation(connector, "create_event").consent, [...BASE_SCOPES, EVENTS_SCOPE])).toBe(true);
	});

	test("Google's authorization asks for offline access, consent and earlier grants, with the account as login hint", () => {
		expect(connector.auth).toEqual({
			type: "oauth2",
			app: "google",
			authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			scopes: BASE_SCOPES,
			authorizeParams: [
				["access_type", "offline"],
				["prompt", "consent"],
				["include_granted_scopes", "true"],
			],
			loginHint: true,
		});
	});
});
