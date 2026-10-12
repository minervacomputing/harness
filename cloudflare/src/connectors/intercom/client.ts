// Intercom's REST API, at a pinned version, so response shapes do not change under Minerva
// (backend/connectors/intercom/client.py).
//
// Requests go to api.intercom.io, which Intercom routes to the workspace's region (US, EU or Australia).
// Responses are validated before use, and read with a byte limit: a conversation carries up to 500 parts.
// Intercom's error messages are never passed on.
//
// Responses are read as Pydantic's models read them (`extra="ignore"`, lax): unknown fields are dropped,
// integers may come as whole floats, booleans or numeric strings, booleans as 0, 1 or words such as "true";
// strings are strings. One deliberate difference: a number beyond 2^53, which JavaScript cannot hold exactly,
// makes the response unexpected (`laxInt`), where Python would, say, place a conversation in a team whose id
// a number would round to another team's.

import { z } from "zod";
import type { OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, parseJson, parseModelJson } from "../../lib/json.ts";
import { stripWhitespace } from "../../lib/schema.ts";

export const API_URL = "https://api.intercom.io";
export const VERSION = "2.16";
/** Conversation, team and admin ids are positive integers; leading zeros are refused, so each has one spelling. */
export const ID = /^[1-9][0-9]{0,19}$/;
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_TEAMS = 500;
/** Intercom's cursors are opaque; they are checked, never followed as addresses. */
const CURSOR = /^[\x21-\x7e]{1,900}$/;

// Pydantic's lax ints and bools.

const INT_TEXT = /^[+-]?[0-9]+(?:_[0-9]+)*(?:\.0+)?$/;
const MAX_INT_TEXT = 4300;
const TRUE_WORDS = /^(?:1|t|true|y|yes|on)$/i;
const FALSE_WORDS = /^(?:0|f|false|n|no|off)$/i;

/**
 * pydantic-core's `strip_leading_zeros`: what follows leading zeros (and underscores among them), keeping a
 * zero before a decimal mark, or the last character when nothing else follows; null when the text does not
 * start with a zero.
 */
function stripLeadingZeros(text: string): string | null {
	if (text[0] !== "0") return null;
	for (let i = 1; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "0" || c === "_") continue;
		if ((c >= "1" && c <= "9") || c === "-" || c === "+") return text.slice(i);
		if (c === ".") return text.slice(i - 1);
		return null;
	}
	return text.slice(-1);
}

/**
 * An int as Pydantic reads one in lax mode: an integer, a float without a fraction, a boolean, or a string of
 * digits (with a sign, underscores between digits, leading zeros and a fraction of zeros) between White_Space.
 * A number beyond 2^53, which JavaScript cannot hold exactly, is refused, where Pydantic reads an integer of
 * any size (and a float up to 2^63).
 */
export function laxInt(): z.ZodType<number, unknown> {
	return z.unknown().transform((value, ctx) => {
		let number: number | null = null;
		if (typeof value === "number" && Number.isInteger(value)) number = value;
		else if (typeof value === "boolean") number = value ? 1 : 0;
		else if (typeof value === "string") {
			const trimmed = stripWhitespace(value);
			// Leading zeros are stripped after the sign.
			const sign = trimmed[0] === "+" || trimmed[0] === "-" ? (trimmed[0] as string) : "";
			const stripped = stripLeadingZeros(trimmed.slice(sign.length));
			const text = stripped === null ? trimmed : sign + stripped;
			// Longer strings are refused, as Python refuses to read them.
			if (text.length <= MAX_INT_TEXT && INT_TEXT.test(text)) number = Number(text.replace(/\.0+$/, "").replaceAll("_", ""));
		}
		if (number !== null && Number.isSafeInteger(number)) return number === 0 ? 0 : number;
		ctx.addIssue({ code: "custom", message: "Input should be a valid integer" });
		return z.NEVER;
	});
}

/** A bool as Pydantic reads one in lax mode. */
export function laxBool(): z.ZodType<boolean, unknown> {
	return z.unknown().transform((value, ctx) => {
		if (typeof value === "boolean") return value;
		if (value === 0 || value === 1) return value === 1;
		if (typeof value === "string" && TRUE_WORDS.test(value)) return true;
		if (typeof value === "string" && FALSE_WORDS.test(value)) return false;
		ctx.addIssue({ code: "custom", message: "Input should be a valid boolean" });
		return z.NEVER;
	});
}

/** `str | None = None`. */
const maybeText = () => z.string().nullable().default(null);
/** `int | None = None`. */
const maybeInt = () => laxInt().nullable().default(null);

// The models.

export const App = z.object({ id_code: z.string(), name: maybeText() });

export const Me = z.object({ id: z.string(), name: maybeText(), email: maybeText(), app: App.nullable().default(null) });
export type Me = z.output<typeof Me>;

export const Team = z.object({ id: z.string(), name: maybeText(), admin_ids: z.array(laxInt()).default([]) });
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
	redacted: laxBool().default(false),
});

export const Part = z.object({
	id: z.string(),
	part_type: maybeText(),
	body: maybeText(),
	created_at: maybeInt(),
	author: Author.nullable().default(null),
	attachments: z.array(Attachment).default([]),
	redacted: laxBool().default(false),
});
export type Part = z.output<typeof Part>;

const Parts = z.object({ conversation_parts: z.array(Part).default([]), total_count: laxInt().default(0) });

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
	team_assignee_id: z.custom<unknown>((value) => value !== undefined, { message: "Field required" }).pipe(laxInt().nullable()),
	source: Source.nullable().default(null),
	conversation_parts: Parts.nullable().default(null),
});
export type Conversation = z.output<typeof Conversation>;

const Found = z.object({ id: z.string() });
const Next = z.object({ starting_after: maybeText() });
const Pages = z.object({ next: Next.nullable().default(null) });
const SearchPage = z.object({ conversations: z.array(Found).default([]), pages: Pages.nullable().default(null) });

/** The codes of a failed response's `errors`, as Python reads them: a value it cannot hash raises TypeError. */
function errorCodes(body: string): Set<Json> {
	let data: Json;
	try {
		// json.loads of the body's bytes skips a byte order mark.
		data = parseJson(body.startsWith("﻿") ? body.slice(1) : body);
	} catch {
		return new Set();
	}
	// `response.json().get("errors") or []`: anything but an object has no `.get`.
	if (typeof data !== "object" || data === null || Array.isArray(data)) return new Set();
	const errors = Object.hasOwn(data, "errors") ? data.errors : null;
	// An empty or false value is no errors; a number or `true` cannot be iterated.
	if (!errors || (typeof errors === "object" && !Array.isArray(errors) && Object.keys(errors).length === 0)) return new Set();
	if (typeof errors === "number" || errors === true) throw new TypeError("The errors of Intercom's response are not iterable.");
	// A string iterates characters and an object its keys: neither yields dicts.
	if (!Array.isArray(errors)) return new Set();
	const codes = new Set<Json>();
	for (const item of errors) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const code = Object.hasOwn(item, "code") ? (item.code as Json) : null;
		if (typeof code === "object" && code !== null) throw new TypeError("An error code of Intercom's response cannot be hashed.");
		codes.add(code);
	}
	return codes;
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
		const bytes = new Uint8Array(await response.arrayBuffer());
		let data: Json;
		try {
			// Pydantic's JSON parser refuses an escaped lone surrogate anywhere in the document.
			data = parseModelJson(fromUtf8Strict(bytes));
		} catch (error) {
			throw this.#http.unexpected(error);
		}
		const parsed = await schema.safeParseAsync(data);
		if (!parsed.success) throw this.#http.unexpected(parsed.error);
		return parsed.data;
	}

	#checked(conversation: Conversation, conversationId: string | null = null): Conversation {
		if (!ID.test(conversation.id) || (conversationId !== null && conversation.id !== conversationId)) throw this.unexpected();
		// laxInt refused a team id beyond 2^53, which a number would have rounded to another team's.
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
