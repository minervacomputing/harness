// Google Calendar. Resources are calendars; what is allowed on a calendar covers its events.

import { z } from "zod";
import {
	type Binding,
	type Connector,
	OperationError,
	type Prepared,
	type ProviderOutput,
	type ScopedRecord,
	defineOperation,
	denied,
} from "../../gateway/connector.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { sliceText } from "../../lib/text.ts";
import { TENANCY, googleTenants, oauth } from "../google/index.ts";
import { type EventTime, type GoogleCalendar, GoogleCalendarClient, type GoogleEvent, calendarName } from "./client.ts";
import { epochMicros, isDate, isTimeZone, parseDate, parseDateTime, parseZonedDateTime } from "../../lib/dates.ts";
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

export const DATE_TIME_MESSAGE = "must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00";
export const DATE_OR_DATE_TIME_MESSAGE = "must be a date such as 2026-10-01, or an RFC 3339 date-time such as 2026-10-01T09:00:00, with or without an offset";
export const LOCAL_TIME_MESSAGE = "must be an RFC 3339 date-time with an offset, or a local date-time with time_zone";

/** Whether an id is more than dots. */
function notDots(value: string): boolean {
	return !/^\.+$/.test(value);
}

const CalendarId = () =>
	z.string().trim().min(1).max(200)
		.regex(/^[A-Za-z0-9._%+#@-]+$/)
		.refine(notDots, { message: "is not a valid id" })
		.describe('A calendar id from list_calendars, or "primary" for the main calendar.');
const EventId = () =>
	z.string().trim().min(1).max(1024)
		.regex(/^[A-Za-z0-9_@.-]+$/)
		.refine(notDots, { message: "is not a valid id" });
const ZonedDateTime = () => z.string().trim().max(40).refine((value) => parseZonedDateTime(value) !== null, DATE_TIME_MESSAGE);
const DateOrDateTime = () => z.string().trim().max(40).refine((value) => isDate(value) || parseDateTime(value) !== null, DATE_OR_DATE_TIME_MESSAGE);

export interface CalendarOptions {
	/** How many pages of the calendar list a call may read (MAX_CALENDAR_PAGES). */
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
		if (!found.nextPageToken) return calendars;
		token = found.nextPageToken;
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
	return value.dateTime || value.date;
}

function eventRecord(binding: Binding, calendarId: string, event: GoogleEvent): ScopedRecord {
	let description = event.description;
	if (description && description.length > MAX_DESCRIPTION) description = `${sliceText(description, 0, MAX_DESCRIPTION)} [truncated]`;
	const attendees = event.attendees.slice(0, MAX_ATTENDEES).map((a) => ({ email: a.email, name: a.displayName, response: a.responseStatus }));
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
			all_day: Boolean(event.start && event.start.date && !event.start.dateTime),
			time_zone: event.start ? event.start.timeZone : null,
			organizer: event.organizer ? event.organizer.email : null,
			attendees,
			// The attendee list is incomplete when Google or Minerva left some out.
			attendees_incomplete: event.attendeesOmitted || event.attendees.length > MAX_ATTENDEES,
			link: event.htmlLink,
			recurring_event_id: event.recurringEventId,
		},
	};
}

const ListCalendars = z.strictObject({});

const ListEvents = z
	.strictObject({
		calendar_id: CalendarId(),
		time_min: ZonedDateTime().nullable().default(null).describe("Only events that end after this time."),
		time_max: ZonedDateTime().nullable().default(null).describe("Only events that start before this time."),
		search: z.string().trim().min(1).max(200).nullable().default(null),
		limit: z.int().min(1).max(50).default(25),
		cursor: z.string().trim().max(300).nullable().default(null),
	})
	.superRefine((data, ctx) => {
		// zod runs this after a field failed too; those values are left to the field's message.
		const [min, max] = [parseZonedDateTime(data.time_min ?? ""), parseZonedDateTime(data.time_max ?? "")];
		if (min === null || max === null) return;
		if (epochMicros(max) <= epochMicros(min)) {
			ctx.addIssue({ code: "custom", message: "time_max must be after time_min", input: data });
		}
	});

const GetEvent = z.strictObject({ calendar_id: CalendarId(), event_id: EventId() });

const CreateEvent = z
	.strictObject({
		calendar_id: CalendarId(),
		summary: z.string().trim().min(1).max(300),
		start: DateOrDateTime().describe(
			"YYYY-MM-DD for an all-day event, or an RFC 3339 date-time: local, like 2026-10-01T09:00:00, with time_zone, which Google then places (daylight saving time included), or with an offset.",
		),
		end: DateOrDateTime().describe("Same format as start. For all-day events, the day after the last day."),
		time_zone: z.string().trim().max(64)
			.refine(isTimeZone, "must be an IANA time zone, like Europe/Berlin")
			.nullable()
			.default(null)
			.describe("The IANA time zone of the event, like Europe/Zurich; needed for local start and end times."),
		description: z.string().trim().max(8000).nullable().default(null),
		location: z.string().trim().max(500).nullable().default(null),
	})
	.superRefine((data, ctx) => {
		const [start, end] = [parseDate(data.start) ?? parseDateTime(data.start), parseDate(data.end) ?? parseDateTime(data.end)];
		if (start === null || end === null) return;
		if ("hour" in start !== "hour" in end) {
			ctx.addIssue({ code: "custom", message: "start and end must both be dates or both be date-times", input: data });
			return;
		}
		const [startTime, endTime] = [parseDateTime(data.start), parseDateTime(data.end)];
		if (startTime !== null && endTime !== null) {
			if ((startTime.offset === null) !== (endTime.offset === null)) {
				ctx.addIssue({ code: "custom", message: "start and end must both have an offset, or neither", input: data });
				return;
			}
			if (startTime.offset === null && data.time_zone === null) {
				for (const key of ["start", "end"] as const) ctx.addIssue({ code: "custom", message: LOCAL_TIME_MESSAGE, path: [key], input: data[key] });
				return;
			}
		}
		// Local times compare as wall-clock times in the one zone.
		if (epochMicros(end) <= epochMicros(start)) ctx.addIssue({ code: "custom", message: "end must be after start", input: data });
	});

type CreateEventInput = z.output<typeof CreateEvent>;

/** The event Google is sent. */
function eventBody(data: CreateEventInput): { [key: string]: Json } {
	const key = isDate(data.start) ? "date" : "dateTime";
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

/** Minerva's own upstream cursor: Google's page token with the first page's lower time bound. */
const PageState = z.object({ page: z.string(), time_min: z.string().nullable() });

function pageState(cursor: string): z.output<typeof PageState> {
	let data: unknown;
	try {
		data = parseJson(cursor);
	} catch {
		data = null;
	}
	const parsed = PageState.safeParse(data);
	if (!parsed.success) throw new OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.");
	return parsed.data;
}

/** Google Calendar's connector. */
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
								data: { id: c.id, name: calendarName(c), primary: c.primary, access_role: c.accessRole, time_zone: c.timeZone },
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
				const timeMin = state ? state.time_min : (data.time_min ?? (data.time_max === null ? new Date(now()).toISOString() : null));
				return {
					requirements: [{ need: binding.resource(CALENDAR, calendarId), action: "read" }],
					async execute(): Promise<ProviderOutput> {
						const page = await client.events(calendarId, {
							timeMin,
							timeMax: data.time_max,
							query: data.search,
							limit: data.limit,
							pageToken: state ? state.page : null,
						});
						let nextCursor: string | null = null;
						if (page.nextPageToken) {
							nextCursor = JSON.stringify({ page: page.nextPageToken, time_min: timeMin });
							if (nextCursor.length > 1000) throw new OperationError("PROVIDER_LIMIT", "Google Calendar returned a page token that is too long.");
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
		tenancy: TENANCY,
		operations,
		client: (secret, io) => new GoogleCalendarClient(secret, io, options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		async account(client) {
			// The OpenID subject is stable; the email address can change.
			const user = await client.user();
			return { id: user.sub, label: user.email || user.name || "Google", tenants: googleTenants(user) };
		},
		async discover(client, _kind, { query }) {
			let calendars = await allCalendars(client, maxPages);
			if (query) {
				const text = query.toLowerCase();
				calendars = calendars.filter((c) => calendarName(c).toLowerCase().includes(text));
			}
			return { items: calendars.filter((c) => c.id.length <= 200).map((c) => ({ id: c.id, name: calendarName(c) })) };
		},
		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			// Object.fromEntries defines own properties, even for an id such as "__proto__".
			return Object.fromEntries((await allCalendars(client, maxPages)).filter((c) => wanted.has(c.id)).map((c) => [c.id, calendarName(c)]));
		},
	};
}
