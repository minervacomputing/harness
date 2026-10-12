// Google Calendar, ported from backend/connectors/google_calendar/connector.py. Resources are calendars;
// what is allowed on a calendar covers its events.

import { z } from "zod";
import type { Binding, Connector, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { type Json, parseJson, pythonDumps } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { codePointLength, sliceCodePoints } from "../../lib/text.ts";
import { casefold } from "../../lib/casefold.ts";
import { oauth } from "../google/index.ts";
import { setOwn } from "../google/model.ts";
import { type EventTime, type GoogleCalendar, GoogleCalendarClient, type GoogleEvent, calendarName } from "./client.ts";
import { DATE, TimeError, checkDateOrDateTime, checkDateTime, dateOrdinal, instant, nowIso, parseDate, parseDateTime } from "./times.ts";
import { ZONES } from "../../lib/zones.ts";
import { extend } from "../../lib/arrays.ts";

export const CALENDAR = "calendar";
export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const FULL_SCOPE = "https://www.googleapis.com/auth/calendar";
export const MAX_CALENDAR_PAGES = 10;
export const PRIMARY = "primary";
export const MAX_DESCRIPTION = 4000;
export const MAX_ATTENDEES = 50;

// Every operation resolves its calendar through the calendar list, which the events scopes do not cover.
export const READ_CONSENT = [[READ_SCOPE], [FULL_SCOPE]];
export const WRITE_CONSENT = [[READ_SCOPE, EVENTS_SCOPE], [FULL_SCOPE]];

/** An AfterValidator: `check` throws TimeError (Python's ValueError) with the message the model sees. */
function after(check: (value: string) => unknown) {
	return (value: string, ctx: z.RefinementCtx<string>) => {
		try {
			check(value);
		} catch (error) {
			if (!(error instanceof TimeError)) throw error;
			ctx.addIssue({ code: "custom", message: error.message, input: value });
		}
	};
}

/**
 * Whether a field's value passed its own validator. zod runs an object's refinement even after a field
 * failed a check it may continue past; Pydantic runs a model validator only once every field passed, so
 * the model validators below look at valid values only (the executor drops their issue otherwise anyway).
 */
function passes(check: (value: string) => unknown, value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		check(value);
		return true;
	} catch (error) {
		if (error instanceof TimeError) return false;
		throw error;
	}
}

/** `_not_dots`: an id is not only dots. */
function notDots(value: string): boolean {
	return !/^\.+$/.test(value);
}

const CalendarId = () =>
	strippedStr({ min: 1, max: 200 })
		.regex(/^[A-Za-z0-9._%+#@-]+$/)
		.refine(notDots, { message: "is not a valid id" })
		.describe('A calendar id from list_calendars, or "primary" for the main calendar.');
const EventId = () =>
	strippedStr({ min: 1, max: 1024 })
		.regex(/^[A-Za-z0-9_@.-]+$/)
		.refine(notDots, { message: "is not a valid id" });
const DateTime = () => strippedStr({ max: 40 }).superRefine(after(checkDateTime));
const DateOrDateTime = () => strippedStr({ max: 40 }).superRefine(after(checkDateOrDateTime));

export interface CalendarOptions {
	/** How many pages of the calendar list a call may read (Python's MAX_CALENDAR_PAGES). */
	maxCalendarPages?: number;
	/** The API's base URL, for tests. */
	baseUrl?: string;
	/** Epoch milliseconds, for the default lower bound of a listing ("now"). */
	now?: () => number;
}

async function allCalendars(client: GoogleCalendarClient, maxPages: number): Promise<GoogleCalendar[]> {
	const calendars: GoogleCalendar[] = [];
	let token: string | null = null;
	for (let page = 0; page < maxPages; page++) {
		const found = await client.calendars(token);
		extend(calendars, found.items);
		if (!found.next_page_token) return calendars;
		token = found.next_page_token;
	}
	throw new OperationError("PROVIDER_LIMIT", "This Google account has more calendars than Minerva can list.");
}

/**
 * The id the user's calendar list gives the calendar. Grants and records use it, never `primary` or another
 * spelling Google also accepts, and calendars outside the list (which discovery never offers) are refused
 * like calendars without a grant.
 */
async function calendarIdOf(client: GoogleCalendarClient, calendarId: string): Promise<string> {
	let calendar: GoogleCalendar;
	try {
		calendar = await client.calendar(calendarId);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
	if (calendar.id === PRIMARY) throw new OperationError("PROVIDER_FAILED", "Google Calendar returned an unexpected response.");
	return calendar.id;
}

function timeOf(value: EventTime | null): string | null {
	if (value === null) return null;
	return value.date_time || value.date;
}

function eventRecord(binding: Binding, calendarId: string, event: GoogleEvent): ScopedRecord {
	let description = event.description;
	if (description && codePointLength(description) > MAX_DESCRIPTION) description = `${sliceCodePoints(description, 0, MAX_DESCRIPTION)} [truncated]`;
	const attendees = event.attendees.slice(0, MAX_ATTENDEES).map((a) => ({ email: a.email, name: a.display_name, response: a.response_status }));
	return {
		resource: binding.resource(CALENDAR, calendarId),
		data: {
			id: event.id,
			calendar_id: calendarId,
			status: event.status,
			summary: event.summary,
			description,
			location: event.location,
			start: timeOf(event.start),
			end: timeOf(event.end),
			all_day: Boolean(event.start && event.start.date && !event.start.date_time),
			time_zone: event.start ? event.start.time_zone : null,
			organizer: event.organizer ? event.organizer.email : null,
			attendees,
			// The attendee list is incomplete when Google or Minerva left some out.
			attendees_incomplete: event.attendees_omitted || event.attendees.length > MAX_ATTENDEES,
			link: event.html_link,
			recurring_event_id: event.recurring_event_id,
		},
	};
}

const ListCalendars = z.strictObject({});

const ListEvents = z
	.strictObject({
		calendar_id: CalendarId(),
		time_min: DateTime().nullable().default(null).describe("Only events that end after this time."),
		time_max: DateTime().nullable().default(null).describe("Only events that start before this time."),
		search: strippedStr({ min: 1, max: 200 }).nullable().default(null),
		limit: z.int().min(1).max(50).default(25),
		cursor: strippedStr({ max: 300 }).nullable().default(null),
	})
	.superRefine((data, ctx) => {
		// `_ordered`, a model validator: only once every field passed.
		if (!data.time_min || !data.time_max) return;
		if (!passes(checkDateTime, data.time_min) || !passes(checkDateTime, data.time_max)) return;
		if (instant(parseDateTime(data.time_max)) <= instant(parseDateTime(data.time_min))) {
			ctx.addIssue({ code: "custom", message: "time_max must be after time_min", input: data });
		}
	});

const GetEvent = z.strictObject({ calendar_id: CalendarId(), event_id: EventId() });

const CreateEvent = z
	.strictObject({
		calendar_id: CalendarId(),
		summary: strippedStr({ min: 1, max: 300 }),
		start: DateOrDateTime().describe("YYYY-MM-DD for an all-day event, or an RFC 3339 date-time with an offset."),
		end: DateOrDateTime().describe("Same format as start. For all-day events, the day after the last day."),
		time_zone: strippedStr({ max: 64 })
			.refine((value) => ZONES.has(value), { message: "must be an IANA time zone, like Europe/Berlin" })
			.nullable()
			.default(null),
		description: strippedStr({ max: 8000 }).nullable().default(null),
		location: strippedStr({ max: 500 }).nullable().default(null),
	})
	.superRefine((data, ctx) => {
		// `_consistent`, a model validator.
		if (!passes(checkDateOrDateTime, data.start) || !passes(checkDateOrDateTime, data.end)) return;
		const allDay = DATE.test(data.start);
		if (allDay !== DATE.test(data.end)) {
			ctx.addIssue({ code: "custom", message: "start and end must both be dates or both be date-times", input: data });
			return;
		}
		const ordered = allDay
			? dateOrdinal(parseDate(data.end)) > dateOrdinal(parseDate(data.start))
			: instant(parseDateTime(data.end)) > instant(parseDateTime(data.start));
		if (!ordered) ctx.addIssue({ code: "custom", message: "end must be after start", input: data });
	});

type CreateEventInput = z.output<typeof CreateEvent>;

/** `CreateEvent.body()`: the event Google is sent. */
function eventBody(data: CreateEventInput): { [key: string]: Json } {
	const key = DATE.test(data.start) ? "date" : "dateTime";
	const start: { [key: string]: string } = { [key]: data.start };
	const end: { [key: string]: string } = { [key]: data.end };
	if (data.time_zone) {
		start.timeZone = data.time_zone;
		end.timeZone = data.time_zone;
	}
	const body: { [key: string]: Json } = { summary: data.summary, start, end };
	if (data.description) body.description = data.description;
	if (data.location) body.location = data.location;
	return body;
}

/** `_page_state`: Minerva's own upstream cursor, Google's page token with the first page's time bound. */
function pageState(cursor: string): { [key: string]: Json } {
	let state: Json | null;
	try {
		state = parseJson(cursor);
	} catch {
		state = null;
	}
	if (typeof state !== "object" || state === null || Array.isArray(state) || typeof (Object.hasOwn(state, "page") ? state.page : undefined) !== "string") {
		throw new OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.");
	}
	return state;
}

/** Google Calendar's connector (`GoogleCalendarConnector`). */
export function googleCalendarConnector(options: CalendarOptions = {}): Connector<GoogleCalendarClient> {
	const maxPages = options.maxCalendarPages ?? MAX_CALENDAR_PAGES;
	const now = options.now ?? (() => Date.now());

	const operations = [
		defineOperation<z.output<typeof ListCalendars>>({
			name: "list_calendars",
			title: "List calendars",
			description: "List the Google calendars you may read.",
			input: ListCalendars,
			needs: [[CALENDAR, "read"]],
			consent: READ_CONSENT,
			async prepare(binding): Promise<Prepared> {
				const client = binding.client as GoogleCalendarClient;
				return {
					requirements: [{ enumerate: CALENDAR, action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const calendars = await allCalendars(client, maxPages);
						return {
							records: calendars.map((c) => ({
								resource: binding.resource(CALENDAR, c.id),
								data: { id: c.id, name: calendarName(c), primary: c.primary, access_role: c.access_role, time_zone: c.time_zone },
							})),
						};
					},
				};
			},
		}),
		defineOperation<z.output<typeof ListEvents>>({
			name: "list_events",
			title: "List events",
			description:
				"List events in one calendar you may read, ordered by start time, with recurring events expanded. Without time_min or time_max, lists events from now on. Times are RFC 3339 with an offset. To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
			input: ListEvents,
			needs: [[CALENDAR, "read"]],
			consent: READ_CONSENT,
			paginated: true,
			async prepare(binding, data): Promise<Prepared> {
				const client = binding.client as GoogleCalendarClient;
				const calendarId = await calendarIdOf(client, data.calendar_id);
				// The upstream cursor is Minerva's own: Google's page token plus the time bound the first page used,
				// so later pages repeat the query exactly, even when the default bound ("now") was applied.
				const state = data.cursor ? pageState(data.cursor) : null;
				let timeMin: Json = data.time_min;
				if (state !== null) timeMin = Object.hasOwn(state, "time_min") ? (state.time_min as Json) : null;
				else if (timeMin === null && data.time_max === null) timeMin = nowIso(now());
				return {
					requirements: [{ need: binding.resource(CALENDAR, calendarId), action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const page = await client.events(calendarId, {
							timeMin: typeof timeMin === "string" ? timeMin : null,
							timeMax: data.time_max,
							query: data.search,
							limit: data.limit,
							pageToken: state ? (state.page as string) : null,
						});
						let nextCursor: string | null = null;
						if (page.next_page_token) {
							nextCursor = pythonDumps({ page: page.next_page_token, time_min: timeMin });
							if (codePointLength(nextCursor) > 1000) throw new OperationError("PROVIDER_LIMIT", "Google Calendar returned a page token that is too long.");
						}
						return { records: page.items.map((event) => eventRecord(binding, calendarId, event)), nextCursor };
					},
				};
			},
		}),
		defineOperation<z.output<typeof GetEvent>>({
			name: "get_event",
			title: "Get an event",
			description: "Read one event by calendar and event id.",
			input: GetEvent,
			needs: [[CALENDAR, "read"]],
			consent: READ_CONSENT,
			async prepare(binding, data): Promise<Prepared> {
				const client = binding.client as GoogleCalendarClient;
				const calendarId = await calendarIdOf(client, data.calendar_id);
				return {
					requirements: [{ need: binding.resource(CALENDAR, calendarId), action: "read" }],
					async execute(): Promise<ProviderOutput> {
						return { records: [eventRecord(binding, calendarId, await client.event(calendarId, data.event_id))] };
					},
				};
			},
		}),
		defineOperation<CreateEventInput>({
			name: "create_event",
			title: "Create an event",
			description:
				"Create one event in a calendar where you have create permission. The event has no guests, so no invitations are sent, but everyone who can see the calendar can see the event.",
			input: CreateEvent,
			needs: [[CALENDAR, "create"]],
			consent: WRITE_CONSENT,
			mutates: true,
			async prepare(binding, data): Promise<Prepared> {
				const client = binding.client as GoogleCalendarClient;
				const calendarId = await calendarIdOf(client, data.calendar_id);
				return {
					requirements: [{ need: binding.resource(CALENDAR, calendarId), action: "create" }],
					async execute(): Promise<ProviderOutput> {
						const event = await client.createEvent(calendarId, eventBody(data));
						return { records: [eventRecord(binding, calendarId, event)] };
					},
				};
			},
		}),
	];

	return {
		slug: "google_calendar",
		name: "Google Calendar",
		kinds: [{ id: CALENDAR, label: "Calendar", actions: ["read", "create"], wildcard: true }],
		actions: [
			{ id: "read", label: "Read events" },
			{ id: "create", label: "Create events", requires: "read" },
		],
		// Reading is enough to connect; writing is asked for once the user allows an agent to write.
		auth: oauth(READ_SCOPE),
		operations,
		client: (secret, io) => new GoogleCalendarClient(secret, io, options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		async account(client) {
			// The OpenID subject is stable; the email address can change.
			const user = await client.user();
			return { id: user.sub, label: user.email || user.name || "Google" };
		},
		async discover(client, _kind, { query }) {
			let calendars = await allCalendars(client, maxPages);
			if (query) {
				const text = casefold(query);
				calendars = calendars.filter((c) => casefold(calendarName(c)).includes(text));
			}
			return { items: calendars.filter((c) => codePointLength(c.id) <= 200).map((c) => ({ id: c.id, name: calendarName(c) })) };
		},
		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			const names: { [id: string]: string } = {};
			for (const c of await allCalendars(client, maxPages)) if (wanted.has(c.id)) setOwn(names, c.id, calendarName(c));
			return names;
		},
	};
}
