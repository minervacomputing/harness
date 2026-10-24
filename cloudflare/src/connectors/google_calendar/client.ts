// A thin client for the Google Calendar API v3. Responses are validated before use.

import { z } from "zod";
import type { ProviderClient } from "../../gateway/connector.ts";
import { ProviderHTTP, type ProviderIo, segment } from "../../gateway/http.ts";
import type { Json } from "../../lib/json.ts";
import { GoogleUser, RETRIES, USERINFO_URL, classify } from "../google/index.ts";

export const API_URL = "https://www.googleapis.com/calendar/v3";

export const GoogleCalendar = z.object({
	id: z.string(),
	summary: z.string().default(""),
	summaryOverride: z.string().nullable().default(null),
	primary: z.boolean().default(false),
	accessRole: z.string(),
	timeZone: z.string().nullable().default(null),
});
export type GoogleCalendar = z.output<typeof GoogleCalendar>;

/** A calendar's name: the user's own name for it, else its summary, else its id. */
export function calendarName(calendar: GoogleCalendar): string {
	return calendar.summaryOverride || calendar.summary || calendar.id;
}

const CalendarPage = z.object({
	items: z.array(GoogleCalendar).default([]),
	nextPageToken: z.string().nullable().default(null),
});
export type CalendarPage = z.output<typeof CalendarPage>;

export const EventTime = z.object({
	date: z.string().nullable().default(null),
	dateTime: z.string().nullable().default(null),
	timeZone: z.string().nullable().default(null),
});
export type EventTime = z.output<typeof EventTime>;

const Person = z.object({
	email: z.string().nullable().default(null),
	displayName: z.string().nullable().default(null),
	responseStatus: z.string().nullable().default(null),
	/** Whether this is the calendar the event was read from, which is the user's for their own calendars. */
	self: z.boolean().default(false),
});

/** Cancelled and private events can carry little more than an id. */
export const GoogleEvent = z.object({
	id: z.string(),
	status: z.string().nullable().default(null),
	/** default, focusTime, outOfOffice, fromGmail, workingLocation or birthday. */
	eventType: z.string().default("default"),
	summary: z.string().nullable().default(null),
	description: z.string().nullable().default(null),
	location: z.string().nullable().default(null),
	start: EventTime.nullable().default(null),
	end: EventTime.nullable().default(null),
	organizer: Person.nullable().default(null),
	attendees: z.array(Person).default([]),
	attendeesOmitted: z.boolean().default(false),
	htmlLink: z.string().nullable().default(null),
	recurringEventId: z.string().nullable().default(null),
});
export type GoogleEvent = z.output<typeof GoogleEvent>;

const EventPage = z.object({
	items: z.array(GoogleEvent).default([]),
	nextPageToken: z.string().nullable().default(null),
});
export type EventPage = z.output<typeof EventPage>;

export interface EventQuery {
	timeMin: string | null;
	timeMax: string | null;
	query: string | null;
	limit: number;
	pageToken: string | null;
}

export class GoogleCalendarClient implements ProviderClient {
	readonly http: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, options: { baseUrl?: string } = {}) {
		this.http = new ProviderHTTP(io, {
			provider: "Google Calendar",
			baseUrl: options.baseUrl ?? API_URL,
			headers: { Authorization: `Bearer ${accessToken}` },
			classify,
			retries: RETRIES,
		});
	}

	close(): Promise<void> {
		return this.http.close();
	}

	user(): Promise<GoogleUser> {
		return this.http.parsed({ method: "GET", path: USERINFO_URL }, GoogleUser);
	}

	calendars(pageToken: string | null = null): Promise<CalendarPage> {
		// Calendars shown only as free/busy cannot be read, so they are never offered.
		const query: { [name: string]: string | number } = { minAccessRole: "reader", maxResults: 250 };
		if (pageToken) query.pageToken = pageToken;
		return this.http.parsed({ method: "GET", path: "/users/me/calendarList", query }, CalendarPage);
	}

	calendar(calendarId: string): Promise<GoogleCalendar> {
		return this.http.parsed({ method: "GET", path: `/users/me/calendarList/${segment(calendarId)}` }, GoogleCalendar);
	}

	events(calendarId: string, options: EventQuery): Promise<EventPage> {
		// Recurring events are expanded into instances, so they can be ordered by start time.
		const query: { [name: string]: string | number } = { singleEvents: "true", orderBy: "startTime", maxResults: options.limit };
		if (options.timeMin) query.timeMin = options.timeMin;
		if (options.timeMax) query.timeMax = options.timeMax;
		if (options.query) query.q = options.query;
		if (options.pageToken) query.pageToken = options.pageToken;
		return this.http.parsed({ method: "GET", path: `/calendars/${segment(calendarId)}/events`, query }, EventPage);
	}

	event(calendarId: string, eventId: string): Promise<GoogleEvent> {
		return this.http.parsed({ method: "GET", path: `/calendars/${segment(calendarId)}/events/${segment(eventId)}` }, GoogleEvent);
	}

	createEvent(calendarId: string, body: { [key: string]: Json }): Promise<GoogleEvent> {
		// Never notify anyone: the event has no attendees, and sendUpdates=none keeps it that way.
		return this.http.parsed(
			{ method: "POST", path: `/calendars/${segment(calendarId)}/events`, query: { sendUpdates: "none" }, json: body },
			GoogleEvent,
		);
	}
}
