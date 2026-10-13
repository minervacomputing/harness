// Microsoft Graph for the signed-in user's calendars.
//
// Event reads ask for times in UTC and bodies as text. Graph answers all-day events at midnight UTC whatever
// the requested zone (see the connector for their dates). Creating an event is judged by status: Graph
// answers 201 with the event.

import type { ProviderIo } from "../../contracts/connectors.ts";
import type { Json } from "../../lib/json.ts";
import { API_URL, Graph, IMMUTABLE_IDS, pageParam } from "../microsoft/index.ts";
import { Invalid, bool, list, model, nullable, optional, required, str } from "../microsoft/model.ts";
import { segment } from "../../lib/text.ts";

export const EVENT_READ = `${IMMUTABLE_IDS}, outlook.timezone="UTC", outlook.body-content-type="text"`;
export const CALENDAR_FIELDS = "id,name,isDefaultCalendar,canEdit,owner";
export const EVENT_FIELDS =
	"id,subject,body,start,end,isAllDay,isCancelled,showAs,sensitivity,location,organizer,attendees,onlineMeeting,webLink,type,seriesMasterId,categories";

const EmailAddress = model({ name: optional(nullable(str), null), address: optional(nullable(str), null) });
const Recipient = model({ email_address: optional(nullable(EmailAddress), null) });

export const Calendar = model({
	id: required(str),
	name: optional(str, ""),
	is_default_calendar: optional(nullable(bool), null),
	can_edit: optional(nullable(bool), null),
	owner: optional(nullable(EmailAddress), null),
});
export type Calendar = ReturnType<typeof Calendar>;

const Body = model({ content_type: optional(nullable(str), null), content: optional(str, "") });

export const Time = model({ date_time: required(str), time_zone: optional(nullable(str), null) });
export type Time = ReturnType<typeof Time>;

const Location = model({ display_name: optional(nullable(str), null) });
const Response = model({ response: optional(nullable(str), null) });
const Attendee = model({
	email_address: optional(nullable(EmailAddress), null),
	type: optional(nullable(str), null),
	status: optional(nullable(Response), null),
});
const OnlineMeeting = model({ join_url: optional(nullable(str), null) });

export const Event = model({
	id: required(str),
	subject: optional(nullable(str), null),
	body: optional(nullable(Body), null),
	start: optional(nullable(Time), null),
	end: optional(nullable(Time), null),
	is_all_day: optional(nullable(bool), null),
	is_cancelled: optional(nullable(bool), null),
	show_as: optional(nullable(str), null),
	sensitivity: optional(nullable(str), null),
	location: optional(nullable(Location), null),
	organizer: optional(nullable(Recipient), null),
	attendees: optional(list(Attendee), []),
	online_meeting: optional(nullable(OnlineMeeting), null),
	web_link: optional(nullable(str), null),
	type: optional(nullable(str), null),
	series_master_id: optional(nullable(str), null),
	categories: optional(list(str), []),
});
export type Event = ReturnType<typeof Event>;

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
		try {
			return Event(body);
		} catch (error) {
			if (error instanceof Invalid) throw this.unexpected(error);
			throw error;
		}
	}
}
