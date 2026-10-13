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
//
// Times are Python's datetime (lib/isoformat.ts), which decides what is accepted, refused and sent.

import { z } from "zod";
import type { Binding, Connector, Prepared, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { DIGIT_CLASS } from "../../lib/digits.ts";
import { sliceCodePoints, truncate } from "../../lib/text.ts";
import { casefold } from "../../lib/casefold.ts";
import { ID, accountLabel, consent, oauth } from "../microsoft/index.ts";
import { after, modelValidator, plainTextOf, singleLineOf, valueError } from "../microsoft/inputs.ts";
import {
	MICROS_PER_DAY,
	type PyDateTime,
	dateFromIsoFormat,
	dateOrdinal,
	datetimeFromIsoFormat,
	instant,
	isoformat,
	nowUtc,
	plus,
	toUtc,
} from "../../lib/isoformat.ts";
import { type Calendar, CalendarClient, type Event, type Time } from "./client.ts";
import { ZONES } from "./zones.ts";
import { extend } from "../../lib/arrays.ts";

export const CALENDAR = "calendar";
export const PRIMARY = "primary";
export const MAX_CALENDAR_PAGES = 10;
export const MAX_BODY = 4000;
export const MAX_ATTENDEES = 50;
const DEFAULT_WINDOW = 30n * MICROS_PER_DAY;
const MAX_WINDOW = 366n * MICROS_PER_DAY;

export const READ_CONSENT = consent("Calendars.Read", "Calendars.ReadWrite");
export const WRITE_CONSENT = consent("Calendars.ReadWrite");

/** Python's `\d` is any decimal digit (Unicode 16's Nd, as lib/digits.ts pins it), as these are. */
const D = DIGIT_CLASS;
export const DATE = new RegExp(`^${D}{4}-${D}{2}-${D}{2}$`, "u");
export const DATE_TIME = new RegExp(`^${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}(:${D}{2}(\\.${D}{1,6})?)?(Z|[+-]([01]${D}|2[0-3]):[0-5]${D})$`, "u");
// Times are converted and windows widened here, so years stay well inside what Python's dates hold.
const FIRST_YEAR = 1900;
const LAST_YEAR = 2999;

function inYears(year: number): boolean {
	return year >= FIRST_YEAR && year <= LAST_YEAR;
}

/** `_date_time`. Python's own ValueErrors (an invalid date, say) are reported as they are. */
export function checkDateTime(value: string): string {
	if (!DATE_TIME.test(value)) throw valueError("must be an RFC 3339 date-time with an offset, like 2026-10-01T09:00:00+02:00");
	if (!inYears(datetimeFromIsoFormat(value).year)) throw valueError("must be between the years 1900 and 2999");
	return value;
}

/** `_date_or_date_time`. */
export function checkDateOrDateTime(value: string): string {
	if (DATE.test(value)) {
		if (!inYears(dateFromIsoFormat(value).year)) throw valueError("must be between the years 1900 and 2999");
		return value;
	}
	return checkDateTime(value);
}

function checkZone(value: string): string {
	if (!ZONES.has(value)) throw valueError("must be an IANA time zone Microsoft accepts, like Europe/Berlin or America/New_York");
	return value;
}

function checkCalendarRef(value: string): string {
	if (value !== PRIMARY && !ID.test(value)) throw valueError('must be a calendar id from list_calendars, or "primary"');
	return value;
}

const CalendarRef = () =>
	after(z.string().trim().min(1).max(512).describe('A calendar id from list_calendars, or "primary" for the default calendar.'), checkCalendarRef);
const DateTime = () => after(z.string().trim().max(40), checkDateTime);
const DateOrDateTime = () => after(z.string().trim().max(40), checkDateOrDateTime);

/** The time in UTC without its offset, as `astimezone(UTC).replace(tzinfo=None)` gives it. */
function naiveUtc(value: PyDateTime): PyDateTime {
	return { ...toUtc(value), offset: null };
}

/** `_utc`: an aware time in UTC, with microseconds only when it has some. */
export function utc(value: string): string {
	const moment = naiveUtc(datetimeFromIsoFormat(value));
	return `${isoformat(moment, moment.microsecond ? "microseconds" : "seconds")}Z`;
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
 * `_calendar_id`: the id Graph gives the calendar. Grants and requests use it, never `primary` or another
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

/** `_time`: how an event's start or end is shown. */
export function shownTime(value: Time | null, allDay: boolean): string | null {
	if (value === null) return null;
	const moment = sliceCodePoints(value.date_time, 0, 19);
	// Graph answers all-day events at midnight UTC, whatever zone was asked for (see the module).
	if (allDay) return sliceCodePoints(moment, 0, 10);
	if ((value.time_zone || "").toUpperCase() === "UTC") return `${moment}Z`;
	return `${moment} ${value.time_zone === null ? "None" : value.time_zone}`;
}

function eventRecord(binding: Binding, calendar: string, event: Event): ScopedRecord {
	const allDay = Boolean(event.is_all_day);
	const [body, cut] = truncate(event.body ? event.body.content : null, MAX_BODY);
	const attendees = event.attendees.slice(0, MAX_ATTENDEES).map((a) => ({
		email: a.email_address ? a.email_address.address : null,
		name: a.email_address ? a.email_address.name : null,
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
			cancelled: Boolean(event.is_cancelled),
			show_as: event.show_as,
			sensitivity: event.sensitivity,
			location: event.location ? event.location.display_name : null,
			organizer: event.organizer && event.organizer.email_address ? event.organizer.email_address.address : null,
			attendees,
			attendees_incomplete: event.attendees.length > MAX_ATTENDEES,
			online_meeting_url: event.online_meeting ? event.online_meeting.join_url : null,
			link: event.web_link,
			type: event.type,
			series_master_id: event.series_master_id,
			categories: event.categories,
		},
	};
}

function clientOf(binding: Binding): CalendarClient {
	return binding.client as CalendarClient;
}

export const ListCalendars = z.strictObject({}).meta({ title: "ListCalendars" });

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
						data: { id: c.id, name: c.name, default: Boolean(c.is_default_calendar), can_edit: c.can_edit, owner: c.owner ? c.owner.address : null },
					})),
				};
			},
		};
	},
});

export const ListEvents = z
	.strictObject({
		calendar_id: CalendarRef(),
		time_min: DateTime().nullable().default(null).describe("Only events that end after this time."),
		time_max: DateTime().nullable().default(null).describe("Only events that start before this time."),
		limit: z.int().min(1).max(50).default(25),
		cursor: z.string().trim().max(1000).nullable().default(null),
	})
	.check(
		modelValidator((data: { time_min: string | null; time_max: string | null }) => {
			if (data.time_min && data.time_max) {
				const span = instant(datetimeFromIsoFormat(data.time_max)) - instant(datetimeFromIsoFormat(data.time_min));
				if (span <= 0n) throw valueError("time_max must be after time_min");
				if (span > MAX_WINDOW) throw valueError("time_min and time_max may be at most 366 days apart");
			}
		}),
	)
	.meta({ title: "ListEvents" });

/** `ListEvents.window()`: in UTC, as given, or 30 days from or to the one bound given, or from now. */
export function windowOf(data: { time_min: string | null; time_max: string | null }, nowMs: number): [string, string] {
	if (data.time_min && data.time_max) return [utc(data.time_min), utc(data.time_max)];
	if (data.time_min) {
		const start = datetimeFromIsoFormat(data.time_min);
		return [utc(data.time_min), utc(isoformat(plus(start, DEFAULT_WINDOW)))];
	}
	if (data.time_max) {
		const end = datetimeFromIsoFormat(data.time_max);
		return [utc(isoformat(plus(end, -DEFAULT_WINDOW))), utc(data.time_max)];
	}
	const now = nowUtc(nowMs);
	return [utc(isoformat(now)), utc(isoformat(plus(now, DEFAULT_WINDOW)))];
}

const PAGE_KEYS = ["calendar", "page", "start", "end"];

/** `_page_state`: Minerva's cursor, Graph's page and the window the first page used, for the calendar it was for. */
export function pageState(cursor: string, calendar: string): { calendar: string; page: string; start: string; end: string } {
	let state: Json = null;
	try {
		state = parseJson(cursor);
	} catch {
		state = null;
	}
	const valid =
		typeof state === "object" &&
		state !== null &&
		!Array.isArray(state) &&
		Object.keys(state).length === PAGE_KEYS.length &&
		PAGE_KEYS.every((key) => Object.hasOwn(state as object, key) && typeof (state as { [key: string]: Json })[key] === "string") &&
		(state as { calendar: string }).calendar === calendar;
	if (!valid) throw new OperationError("INVALID_CURSOR", "This page token is invalid or belongs to another request.");
	const { page, start, end } = state as { [key: string]: string };
	return { calendar, page: page as string, start: start as string, end: end as string };
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
		modelValidator((data: CreateEventData) => {
			const allDay = DATE.test(data.start);
			if (allDay !== DATE.test(data.end)) throw valueError("start and end must both be dates or both be date-times");
			let ordered: boolean;
			if (allDay) {
				ordered = dateOrdinal(dateFromIsoFormat(data.end)) > dateOrdinal(dateFromIsoFormat(data.start));
				if (data.time_zone === null) throw valueError("time_zone is required for all-day events");
			} else {
				ordered = instant(datetimeFromIsoFormat(data.end)) > instant(datetimeFromIsoFormat(data.start));
				if (data.time_zone !== null) throw valueError("time_zone is only for all-day events; give timed events an offset");
			}
			if (!ordered) throw valueError("end must be after start");
		}),
	)
	.meta({ title: "CreateEvent" });

/** `CreateEvent.payload()`: the event Graph is sent. */
export function eventPayload(data: CreateEventData): { [key: string]: Json } {
	const allDay = DATE.test(data.start);
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

function named(entries: [string, string][]): { [id: string]: string } {
	const names: { [id: string]: string } = {};
	for (const [id, name] of entries) Object.defineProperty(names, id, { value: name, enumerable: true, writable: true, configurable: true });
	return names;
}

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
				const text = casefold(query);
				calendars = calendars.filter((c) => casefold(c.name).includes(text));
			}
			return { items: calendars.map((c) => ({ id: c.id, name: c.name })) };
		},

		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			return named((await allCalendars(client)).filter((c) => wanted.has(c.id)).map((c) => [c.id, c.name]));
		},
	};
}

