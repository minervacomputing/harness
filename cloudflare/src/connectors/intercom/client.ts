// Intercom's REST API, at a pinned version, so response shapes do not change under Minerva.
//
// Requests go to api.intercom.io, which Intercom routes to the workspace's region (US, EU or Australia).
// Responses are validated before use, and read with a byte limit: a conversation carries up to 500 parts.
// Bodies are strict UTF-8 JSON; a byte order mark is dropped.
// Intercom's error messages are never passed on.
//
// Unknown fields in a response are dropped; a field of another type, or an integer beyond 2^53 (which a
// number would round, say, to another team's id), makes the response unexpected.

import { z } from "zod";
import type { OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { type Json, parseJson } from "../../lib/json.ts";

export const API_URL = "https://api.intercom.io";
export const VERSION = "2.16";
/** Conversation, team and admin ids are positive integers; leading zeros are refused, so each has one spelling. */
export const ID = /^[1-9][0-9]{0,19}$/;
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_TEAMS = 500;
/** Intercom's cursors are opaque; they are checked, never followed as addresses. */
const CURSOR = /^[\x21-\x7e]{1,900}$/;

const maybeText = () => z.string().nullable().default(null);
const maybeInt = () => z.int().nullable().default(null);

// The models.

export const App = z.object({ id_code: z.string(), name: maybeText() });

export const Me = z.object({ id: z.string(), name: maybeText(), email: maybeText(), app: App.nullable().default(null) });
export type Me = z.output<typeof Me>;

export const Team = z.object({ id: z.string(), name: maybeText(), admin_ids: z.array(z.int()).default([]) });
export type Team = z.output<typeof Team>;

const Teams = z.object({ teams: z.array(Team).default([]) });

export const Author = z.object({ type: maybeText(), id: maybeText(), name: maybeText(), email: maybeText() });
export type Author = z.output<typeof Author>;

export const Attachment = z.object({ name: maybeText() });
export type Attachment = z.output<typeof Attachment>;

const Source = z.object({
	id: maybeText(),
	delivered_as: maybeText(),
	subject: maybeText(),
	body: maybeText(),
	author: Author.nullable().default(null),
	attachments: z.array(Attachment).default([]),
	redacted: z.boolean().default(false),
});

export const Part = z.object({
	id: z.string(),
	part_type: maybeText(),
	body: maybeText(),
	created_at: maybeInt(),
	author: Author.nullable().default(null),
	attachments: z.array(Attachment).default([]),
	redacted: z.boolean().default(false),
});
export type Part = z.output<typeof Part>;

const Parts = z.object({ conversation_parts: z.array(Part).default([]), total_count: z.int().default(0) });

export const Conversation = z.object({
	id: z.string(),
	title: maybeText(),
	created_at: maybeInt(),
	updated_at: maybeInt(),
	waiting_since: maybeInt(),
	state: maybeText(),
	priority: maybeText(),
	// Required: where a conversation is decides who may see it, so a response without it is not guessed at.
	// Intercom gives 0 for no team.
	team_assignee_id: z.int().nullable(),
	source: Source.nullable().default(null),
	conversation_parts: Parts.nullable().default(null),
});
export type Conversation = z.output<typeof Conversation>;

const Found = z.object({ id: z.string() });
const Next = z.object({ starting_after: maybeText() });
const Pages = z.object({ next: Next.nullable().default(null) });
const SearchPage = z.object({ conversations: z.array(Found).default([]), pages: Pages.nullable().default(null) });

const ErrorBody = z.object({ errors: z.array(z.unknown()) });
const ErrorItem = z.object({ code: z.string() });

/** The string codes of a failed response's `errors`; none for any other shape. */
function errorCodes(body: string): Set<string> {
	let data: Json;
	try {
		data = parseJson(body);
	} catch {
		return new Set();
	}
	const parsed = ErrorBody.safeParse(data);
	if (!parsed.success) return new Set();
	return new Set(parsed.data.errors.flatMap((item) => {
		const found = ErrorItem.safeParse(item);
		return found.success ? [found.data.code] : [];
	}));
}

export function classify(_provider: string, response: Response, body: string): OperationErrorShape | null {
	const codes = errorCodes(body);
	if (response.status === 403 && codes.has("api_plan_restricted")) {
		return new OperationError("PROVIDER_FORBIDDEN", "This Intercom workspace's plan does not include this.");
	}
	if (response.status === 403) {
		return new OperationError(
			"PROVIDER_FORBIDDEN",
			"Intercom refused this request. The Intercom app may lack a permission in Minerva's setup guide, or the teammate may not have access.",
		);
	}
	return null;
}

/** A cursor from a call, checked before it is sent. */
export function cursor(value: string | null): string | null {
	if (value !== null && !CURSOR.test(value)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return value;
}

/** A JSON number written with the exact digits of an id, which a JavaScript number may not hold. */
export function idNumber(id: string): Json {
	if (!ID.test(id)) throw new RangeError("Not an id.");
	return (JSON as unknown as { rawJSON(text: string): Json }).rawJSON(id);
}

export class IntercomClient implements ProviderClient {
	readonly #http: ProviderHTTP;

	constructor(io: ProviderIo, token: string) {
		this.#http = new ProviderHTTP(io, {
			provider: "Intercom",
			baseUrl: API_URL,
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Intercom-Version": VERSION },
			classify,
		});
	}

	async close(): Promise<void> {
		await this.#http.close();
	}

	unexpected(): OperationError {
		return this.#http.unexpected();
	}

	async #read<T>(schema: z.ZodType<T>, path: string, method = "GET", json?: Json): Promise<T> {
		const response = await this.#http.bounded(
			{ method, path, ...(json === undefined ? {} : { json }) },
			MAX_RESPONSE,
			new OperationError("RESPONSE_TOO_LARGE", "Intercom's response was too large to read."),
		);
		let data: Json;
		try {
			data = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await response.arrayBuffer()));
		} catch (error) {
			throw this.#http.unexpected(error);
		}
		const parsed = await schema.safeParseAsync(data);
		if (!parsed.success) throw this.#http.unexpected(parsed.error);
		return parsed.data;
	}

	#checked(conversation: Conversation, conversationId: string | null = null): Conversation {
		if (!ID.test(conversation.id) || (conversationId !== null && conversation.id !== conversationId)) throw this.unexpected();
		if (conversation.team_assignee_id !== null && conversation.team_assignee_id < 0) throw this.unexpected();
		return conversation;
	}

	async me(): Promise<Me> {
		const me = await this.#read(Me, "/me");
		if (!ID.test(me.id)) throw this.unexpected();
		return me;
	}

	async teams(): Promise<Team[]> {
		const found = await this.#read(Teams, "/teams");
		if (found.teams.length > MAX_TEAMS) throw new OperationError("PROVIDER_LIMIT", "This workspace has more teams than Minerva reads.");
		return found.teams.filter((team) => ID.test(team.id));
	}

	async conversation(conversationId: string): Promise<Conversation> {
		const found = await this.#read(Conversation, `/conversations/${conversationId}`);
		return this.#checked(found, conversationId);
	}

	/** The ids of one page of matching conversations, and the cursor of the next page. */
	async search(query: Json, perPage: number, startingAfter: string | null): Promise<[ids: string[], next: string | null]> {
		const pagination: { [key: string]: Json } = { per_page: perPage };
		if (startingAfter !== null) pagination.starting_after = cursor(startingAfter);
		const page = await this.#read(SearchPage, "/conversations/search", "POST", { query, pagination });
		if (page.conversations.some((found) => !ID.test(found.id))) throw this.unexpected();
		const after = page.pages?.next?.starting_after ?? null;
		if (after !== null && !CURSOR.test(after)) throw new OperationError("PROVIDER_LIMIT", "Intercom returned a page token Minerva cannot use.");
		return [page.conversations.map((found) => found.id), after];
	}

	/** A reply or note, as an admin; Intercom answers with the conversation. */
	async reply(conversationId: string, body: { [key: string]: Json }): Promise<Conversation> {
		const found = await this.#http.parsed({ method: "POST", path: `/conversations/${conversationId}/reply`, json: body }, Conversation);
		return this.#checked(found, conversationId);
	}
}
