// Microsoft Graph for the signed-in user's calendars.
//
// Event reads ask for times in UTC and bodies as text. Graph answers all-day events at midnight UTC whatever
// the requested zone (see the connector for their dates). Creating an event is judged by status: Graph
// answers 201 with the event.

import { z } from "zod";
import type { Json } from "../../lib/json.ts";
import { API_URL, Graph, IMMUTABLE_IDS, pageParam } from "../microsoft/index.ts";
import { type ProviderIo, segment } from "../../gateway/http.ts";

export const EVENT_READ = `${IMMUTABLE_IDS}, outlook.timezone="UTC", outlook.body-content-type="text"`;
export const CALENDAR_FIELDS = "id,name,isDefaultCalendar,canEdit,owner";
export const EVENT_FIELDS =
	"id,subject,body,start,end,isAllDay,isCancelled,showAs,sensitivity,location,organizer,attendees,onlineMeeting,webLink,type,seriesMasterId,categories";

const EmailAddress = z.object({ name: z.string().nullable().default(null), address: z.string().nullable().default(null) });
const Recipient = z.object({ emailAddress: EmailAddress.nullable().default(null) });

export const Calendar = z.object({
	id: z.string(),
	name: z.string().default(""),
	isDefaultCalendar: z.boolean().nullable().default(null),
	canEdit: z.boolean().nullable().default(null),
	owner: EmailAddress.nullable().default(null),
});
export type Calendar = z.output<typeof Calendar>;

const Body = z.object({ contentType: z.string().nullable().default(null), content: z.string().default("") });

export const Time = z.object({ dateTime: z.string(), timeZone: z.string().nullable().default(null) });
export type Time = z.output<typeof Time>;

const Location = z.object({ displayName: z.string().nullable().default(null) });
const Response = z.object({ response: z.string().nullable().default(null) });
const Attendee = z.object({
	emailAddress: EmailAddress.nullable().default(null),
	type: z.string().nullable().default(null),
	status: Response.nullable().default(null),
});
const OnlineMeeting = z.object({ joinUrl: z.string().nullable().default(null) });

export const Event = z.object({
	id: z.string(),
	subject: z.string().nullable().default(null),
	body: Body.nullable().default(null),
	start: Time.nullable().default(null),
	end: Time.nullable().default(null),
	isAllDay: z.boolean().nullable().default(null),
	isCancelled: z.boolean().nullable().default(null),
	showAs: z.string().nullable().default(null),
	sensitivity: z.string().nullable().default(null),
	location: Location.nullable().default(null),
	organizer: Recipient.nullable().default(null),
	attendees: z.array(Attendee).default([]),
	onlineMeeting: OnlineMeeting.nullable().default(null),
	webLink: z.string().nullable().default(null),
	type: z.string().nullable().default(null),
	seriesMasterId: z.string().nullable().default(null),
	categories: z.array(z.string()).default([]),
});
export type Event = z.output<typeof Event>;

/** Thin client for the parts of Microsoft Graph Outlook Calendar uses. Responses are validated. */
export class CalendarClient extends Graph {
	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		super("Outlook Calendar", accessToken, io, { baseUrl });
	}

	async calendars(cursor: string | null): Promise<[Calendar[], string | null]> {
		const params = { $select: CALENDAR_FIELDS, $top: "100", ...(cursor ? pageParam(cursor) : {}) };
		return this.page(Calendar, await this.get("/me/calendars", { params }));
	}

	/** A calendar by id, or the default calendar. */
	async calendar(calendarId: string | null): Promise<Calendar> {
		const path = calendarId ? `/me/calendars/${segment(calendarId)}` : "/me/calendar";
		return this.parse(Calendar, await this.get(path, { params: { $select: CALENDAR_FIELDS } }));
	}

	/** The events of one calendar that overlap the window, recurring events expanded. */
	async view(calendarId: string, options: { start: string; end: string; limit: number; cursor: string | null }): Promise<[Event[], string | null]> {
		const params = {
			startDateTime: options.start,
			endDateTime: options.end,
			$select: EVENT_FIELDS,
			$orderby: "start/dateTime",
			$top: String(options.limit),
			...(options.cursor ? pageParam(options.cursor) : {}),
		};
		return this.page(Event, await this.get(`/me/calendars/${segment(calendarId)}/calendarView`, { params, prefer: EVENT_READ }));
	}

	/** The one write of an operation. */
	async create(calendarId: string, event: { [key: string]: Json }): Promise<Event> {
		const body = await this.http.json({
			method: "POST",
			path: `/me/calendars/${segment(calendarId)}/events`,
			body: JSON.stringify(event),
			headers: { "Content-Type": "application/json; charset=utf-8", Prefer: EVENT_READ },
		});
		return this.parse(Event, body);
	}
}
