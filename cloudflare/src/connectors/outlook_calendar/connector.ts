// Outlook Calendar through Microsoft Graph.
// Resources are calendars; what is allowed on a calendar covers its events.
//
// Minerva connects through the Entra app the Microsoft connectors share (connectors/microsoft). The base
// scopes are `offline_access User.Read Calendars.Read`; creating events asks for `Calendars.ReadWrite`.
// Microsoft's permission covers every calendar the account lists, including calendars others shared with
// it, so the calendar limits are Minerva's.
//
// A calendar is named by the id Graph lists, or `primary` for the default calendar. Each call looks the
// calendar up first and authorizes the id Graph answers with, so a grant cannot be reached under another
// spelling, and a calendar Graph does not find is refused like one without a grant.
//
// Events are read only through one calendar's view (`calendarView`), which lists that calendar's events.
// There is no tool to read an event by id: Graph resolves event ids across the mailbox, whatever calendar the
// request names, so an id alone does not show which calendar an event is in. Listings return whole events
// instead.
//
// Graph answers all-day events at midnight UTC whatever zone is asked for, and without the zone they were
// made in, so listings give the date of that midnight. For a calendar in a zone ahead of UTC, Graph is
// reported to answer with the day before; the tool description says so rather than guess a correction.
//
// Created events have no attendees, so no invitations are sent, and are not online meetings. Timed events
// are sent in UTC. All-day events need the calendar owner's time zone: Outlook shows an all-day event created
// in another zone across two days to people in the owner's zone. Graph accepts only some IANA zone names
// (zones.ts). Not supported: changing, deleting or answering events, attendees, recurrence, and group
// calendars.

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
import { truncate, TextError } from "../../lib/text.ts";
import { ID, accountLabel, consent, oauth } from "../microsoft/index.ts";
import { after, objectCheck, plainTextOf, singleLineOf } from "../microsoft/inputs.ts";
import { DAY_MICROS, formatUtc, isDate, parseDate, parseInstant, parseZonedDateTime } from "../../lib/dates.ts";
import { type Calendar, CalendarClient, type Event, type Time } from "./client.ts";
import { ZONES } from "./zones.ts";
import { extend } from "../../lib/arrays.ts";

export const CALENDAR = "calendar";
export const PRIMARY = "primary";
export const MAX_CALENDAR_PAGES = 10;
export const MAX_BODY = 4000;
export const MAX_ATTENDEES = 50;
const DEFAULT_WINDOW = 30n * DAY_MICROS;
const MAX_WINDOW = 366n * DAY_MICROS;

export const READ_CONSENT = consent("Calendars.Read", "Calendars.ReadWrite");
export const WRITE_CONSENT = consent("Calendars.ReadWrite");

export const DATE_TIME_MESSAGE = "must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00";
export const DATE_OR_DATE_TIME_MESSAGE = "must be a date such as 2026-10-01, or an RFC 3339 date-time with an offset";
const YEARS_MESSAGE = "must be between the years 1900 and 2999";

function inYears(value: { year: number }): boolean {
	return value.year >= 1900 && value.year <= 2999;
}

export function checkDateTime(value: string): string {
	const parsed = parseZonedDateTime(value);
	if (parsed === null) throw new TextError(DATE_TIME_MESSAGE);
	if (!inYears(parsed)) throw new TextError(YEARS_MESSAGE);
	return value;
}

export function checkDateOrDateTime(value: string): string {
	const parsed = parseDate(value) ?? parseZonedDateTime(value);
	if (parsed === null) throw new TextError(DATE_OR_DATE_TIME_MESSAGE);
	if (!inYears(parsed)) throw new TextError(YEARS_MESSAGE);
	return value;
}

function checkZone(value: string): string {
	if (!ZONES.has(value)) throw new TextError("must be an IANA time zone Microsoft accepts, like Europe/Berlin or America/New_York");
	return value;
}

function checkCalendarRef(value: string): string {
	if (value !== PRIMARY && !ID.test(value)) throw new TextError('must be a calendar id from list_calendars, or "primary"');
	return value;
}

const CalendarRef = () =>
	after(z.string().trim().min(1).max(512).describe('A calendar id from list_calendars, or "primary" for the default calendar.'), checkCalendarRef);
const ZonedDateTime = () => after(z.string().trim().max(40), checkDateTime);
const DateOrDateTime = () => after(z.string().trim().max(40), checkDateOrDateTime);

/** The instant of a date or date-time the input's checks passed. */
function instantOf(value: string): bigint {
	return parseInstant(value) as bigint;
}

/** A checked date-time in UTC, with microseconds only when it has some. */
export function utc(value: string): string {
	return formatUtc(instantOf(value));
}

async function allCalendars(client: CalendarClient): Promise<Calendar[]> {
	const calendars: Calendar[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
		let found: Calendar[];
		[found, cursor] = await client.calendars(cursor);
		extend(calendars, found.filter((calendar) => ID.test(calendar.id)));
		if (cursor === null) return calendars;
	}
	throw new OperationError("PROVIDER_LIMIT", "This Microsoft account has more calendars than Minerva can list.");
}

/**
 * The id Graph gives the calendar. Grants and requests use it, never `primary` or another
 * spelling Graph also accepts; calendars Graph does not find or refuses are refused like calendars without
 * a grant.
 */
async function calendarId(client: CalendarClient, ref: string): Promise<string> {
	let calendar: Calendar;
	try {
		calendar = await client.calendar(ref === PRIMARY ? null : ref);
	} catch (error) {
		if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN")) throw denied();
		throw error;
	}
	if (!ID.test(calendar.id)) throw client.unexpected();
	return calendar.id;
}

/** How an event's start or end is shown. */
export function shownTime(value: Time | null, allDay: boolean): string | null {
	if (value === null) return null;
	const moment = value.dateTime.slice(0, 19);
	// Graph answers all-day events at midnight UTC, whatever zone was asked for (see the module).
	if (allDay) return moment.slice(0, 10);
	if ((value.timeZone || "").toUpperCase() === "UTC") return `${moment}Z`;
	return value.timeZone ? `${moment} ${value.timeZone}` : moment;
}

function eventRecord(binding: Binding, calendar: string, event: Event): ScopedRecord {
	const allDay = Boolean(event.isAllDay);
	const [body, cut] = truncate(event.body ? event.body.content : null, MAX_BODY);
	const attendees = event.attendees.slice(0, MAX_ATTENDEES).map((a) => ({
		email: a.emailAddress ? a.emailAddress.address : null,
		name: a.emailAddress ? a.emailAddress.name : null,
		type: a.type,
		response: a.status ? a.status.response : null,
	}));
	return {
		resource: binding.resource(CALENDAR, calendar),
		data: {
			id: event.id,
			calendar_id: calendar,
			subject: event.subject,
			body,
			body_truncated: cut,
			start: shownTime(event.start, allDay),
			end: shownTime(event.end, allDay),
			all_day: allDay,
			cancelled: Boolean(event.isCancelled),
			show_as: event.showAs,
			sensitivity: event.sensitivity,
			location: event.location ? event.location.displayName : null,
			organizer: event.organizer && event.organizer.emailAddress ? event.organizer.emailAddress.address : null,
			attendees,
			attendees_incomplete: event.attendees.length > MAX_ATTENDEES,
			online_meeting_url: event.onlineMeeting ? event.onlineMeeting.joinUrl : null,
			link: event.webLink,
			type: event.type,
			series_master_id: event.seriesMasterId,
			categories: event.categories,
		},
	};
}

function clientOf(binding: Binding): CalendarClient {
	return binding.client as CalendarClient;
}

export const ListCalendars = z.strictObject({});

const LIST_CALENDARS = defineOperation<z.output<typeof ListCalendars>>({
	name: "list_calendars",
	title: "List calendars",
	description: "List the Outlook calendars you may read.",
	input: ListCalendars,
	needs: [[CALENDAR, "read"]],
	consent: READ_CONSENT,
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: CALENDAR, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const calendars = await allCalendars(clientOf(binding));
				return {
					records: calendars.map((c) => ({
						resource: binding.resource(CALENDAR, c.id),
						data: { id: c.id, name: c.name, default: Boolean(c.isDefaultCalendar), can_edit: c.canEdit, owner: c.owner ? c.owner.address : null },
					})),
				};
			},
		};
	},
});

export const ListEvents = z
	.strictObject({
		calendar_id: CalendarRef(),
		time_min: ZonedDateTime().nullable().default(null).describe("Only events that end after this time."),
		time_max: ZonedDateTime().nullable().default(null).describe("Only events that start before this time."),
		limit: z.int().min(1).max(50).default(25),
		cursor: z.string().trim().max(1000).nullable().default(null),
	})
	.check(
		objectCheck((data: { time_min: string | null; time_max: string | null }) => {
			if (data.time_min && data.time_max) {
				const span = instantOf(data.time_max) - instantOf(data.time_min);
				if (span <= 0n) throw new TextError("time_max must be after time_min");
				if (span > MAX_WINDOW) throw new TextError("time_min and time_max may be at most 366 days apart");
			}
		}),
	);

/** A listing's window in UTC: as given, or 30 days from or to the one bound given, or from now. */
export function windowOf(data: { time_min: string | null; time_max: string | null }, nowMs: number): [string, string] {
	if (data.time_min && data.time_max) return [utc(data.time_min), utc(data.time_max)];
	if (data.time_min) {
		const start = instantOf(data.time_min);
		return [formatUtc(start), formatUtc(start + DEFAULT_WINDOW)];
	}
	if (data.time_max) {
		const end = instantOf(data.time_max);
		return [formatUtc(end - DEFAULT_WINDOW), formatUtc(end)];
	}
	const now = BigInt(nowMs) * 1000n;
	return [formatUtc(now), formatUtc(now + DEFAULT_WINDOW)];
}

/** Minerva's cursor: Graph's page and the window the first page used, for the calendar it was for. */
const PageState = z.strictObject({ calendar: z.string(), page: z.string(), start: z.string(), end: z.string() });
type PageState = z.output<typeof PageState>;

/** The state a cursor holds, refused unless it is one for this calendar. */
export function pageState(cursor: string, calendar: string): PageState {
	let parsed: unknown = null;
	try {
		parsed = parseJson(cursor);
	} catch {
		// Not JSON: refused below.
	}
	const found = PageState.safeParse(parsed);
	if (!found.success || found.data.calendar !== calendar) throw new OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.");
	return found.data;
}

export interface CalendarOptions {
	/** Epoch milliseconds, for a listing's default window ("now"); tests pass their own. */
	now?: () => number;
	/** Graph's base URL, for tests. */
	baseUrl?: string;
}

function listEvents(options: CalendarOptions) {
	return defineOperation<z.output<typeof ListEvents>>({
		name: "list_events",
		title: "List events",
		description:
			"List the events of one calendar you may read that overlap a window of time, ordered by start, " +
			"with recurring events expanded and each event in full. Without time_min or time_max, lists the " +
			"next 30 days; with one of them, 30 days from or to it. The window is at most 366 days. Times are " +
			"returned in UTC; all-day events have dates, the end being the day after the last day, as " +
			"Microsoft reports them: for a calendar in a time zone ahead of UTC they may be a day early. To get " +
			"the next page, repeat the call with identical arguments plus the returned next_cursor.",
		input: ListEvents,
		needs: [[CALENDAR, "read"]],
		consent: READ_CONSENT,
		paginated: true,
		async prepare(binding, data): Promise<Prepared> {
			const client = clientOf(binding);
			const id = await calendarId(client, data.calendar_id);
			const state = data.cursor ? pageState(data.cursor, id) : null;
			const [start, end] = state ? [state.start, state.end] : windowOf(data, (options.now ?? Date.now)());
			return {
				requirements: [{ need: binding.resource(CALENDAR, id), action: "read" }],
				async execute(): Promise<ProviderOutput> {
					const [events, page] = await client.view(id, { start, end, limit: data.limit, cursor: state ? state.page : null });
					let next: string | null = null;
					if (page !== null) {
						next = JSON.stringify({ calendar: id, page, start, end });
						if (next.length > 1000) throw new OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page token that is too long.");
					}
					return { records: events.map((event) => eventRecord(binding, id, event)), nextCursor: next };
				},
			};
		},
	});
}

interface CreateEventData {
	calendar_id: string;
	subject: string;
	start: string;
	end: string;
	time_zone: string | null;
	body: string | null;
	location: string | null;
}

export const CreateEvent = z
	.strictObject({
		calendar_id: CalendarRef(),
		subject: singleLineOf(z.string().trim().min(1).max(255)),
		start: DateOrDateTime().describe("YYYY-MM-DD for an all-day event, or an RFC 3339 date-time with an offset."),
		end: DateOrDateTime().describe("Same format as start. For all-day events, the day after the last day."),
		time_zone: after(z.string().trim().max(64), checkZone)
			.nullable()
			.default(null)
			.describe("Required for all-day events, and only for them: the calendar owner's IANA time zone, like Europe/Berlin."),
		body: plainTextOf(z.string().trim().max(8000)).nullable().default(null),
		location: singleLineOf(z.string().trim().max(500)).nullable().default(null),
	})
	.check(
		objectCheck((data: CreateEventData) => {
			const allDay = isDate(data.start);
			if (allDay !== isDate(data.end)) throw new TextError("start and end must both be dates or both be date-times");
			if (allDay && data.time_zone === null) throw new TextError("time_zone is required for all-day events");
			if (!allDay && data.time_zone !== null) throw new TextError("time_zone is only for all-day events; give timed events an offset");
			if (instantOf(data.end) <= instantOf(data.start)) throw new TextError("end must be after start");
		}),
	);

/** The event Graph is sent. */
export function eventPayload(data: CreateEventData): { [key: string]: Json } {
	const allDay = isDate(data.start);
	let zone: string | null;
	let start: string;
	let end: string;
	if (allDay) {
		zone = data.time_zone;
		[start, end] = [`${data.start}T00:00:00`, `${data.end}T00:00:00`];
	} else {
		zone = "UTC";
		[start, end] = [utc(data.start).replace(/Z$/, ""), utc(data.end).replace(/Z$/, "")];
	}
	const event: { [key: string]: Json } = {
		subject: data.subject,
		start: { dateTime: start, timeZone: zone },
		end: { dateTime: end, timeZone: zone },
		isAllDay: allDay,
		attendees: [],
		isOnlineMeeting: false,
	};
	if (data.body) event.body = { contentType: "text", content: data.body };
	if (data.location) event.location = { displayName: data.location };
	return event;
}

const CREATE_EVENT = defineOperation<z.output<typeof CreateEvent>>({
	name: "create_event",
	title: "Create an event",
	description:
		"Create one event in a calendar where you have create permission. The event has no attendees, " +
		"so no invitations are sent, but everyone who can see the calendar can see the event. All-day " +
		"events need the calendar owner's time zone.",
	input: CreateEvent,
	needs: [[CALENDAR, "create"]],
	consent: WRITE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const id = await calendarId(client, data.calendar_id);
		return {
			requirements: [{ need: binding.resource(CALENDAR, id), action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const event = await client.create(id, eventPayload(data));
				return { records: [eventRecord(binding, id, event)] };
			},
		};
	},
});

export function outlookCalendarConnector(options: CalendarOptions = {}): Connector<CalendarClient> {
	return {
		slug: "outlook_calendar",
		name: "Outlook Calendar",
		kinds: [
			{
				id: CALENDAR,
				label: "Calendar",
				actions: ["read", "create"],
				wildcard: true,
				note:
					"Microsoft lets Minerva read every calendar of the account, including calendars others " +
					"shared with it; Minerva limits agents to the calendars allowed here.",
			},
		],
		actions: [
			{ id: "read", label: "Read events" },
			{ id: "create", label: "Create events", requires: "read" },
		],
		// Reading is enough to connect; writing is asked for once the user allows an agent to write.
		auth: oauth("Calendars.Read"),
		operations: [LIST_CALENDARS, listEvents(options), CREATE_EVENT],

		client(secret, io) {
			return new CalendarClient(secret, io, options.baseUrl);
		},

		async account(client) {
			const user = await client.me();
			return { id: user.id, label: accountLabel(user, "Outlook") };
		},

		async discover(client, _kind, { query }) {
			let calendars = await allCalendars(client);
			if (query) {
				const text = query.toLowerCase();
				calendars = calendars.filter((c) => c.name.toLowerCase().includes(text));
			}
			return { items: calendars.map((c) => ({ id: c.id, name: c.name })) };
		},

		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			return Object.fromEntries((await allCalendars(client)).filter((c) => wanted.has(c.id)).map((c) => [c.id, c.name]));
		},
	};
}

