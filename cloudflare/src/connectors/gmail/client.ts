// A thin client for the Gmail API v1, for the connected account (`users/me`).
//
// Responses are validated before use. Full messages and threads are read with a byte limit, since their
// bodies come inline. Gmail reports an account without Gmail as a failed precondition (`UNSUPPORTED_ACCOUNT`);
// rate limits and an API that is not enabled come as Google's usual 403s (see connectors/google).

import { z } from "zod";
import type { OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP, segment } from "../../gateway/http.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { GoogleUser, USERINFO_URL, classify as googleClassify, reasons } from "../google/index.ts";

export const API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Message, thread and label ids. Gmail's message and thread ids are hex; user label ids are `Label_<n>`. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_THREAD_BYTES = 16 * 1024 * 1024;
export const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"] as const;
/** What a reply is addressed and threaded by. */
export const REPLY_HEADERS = ["From", "Sender", "Reply-To", "Subject", "Message-ID", "References"] as const;

export const Label = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string().nullable().default(null),
});
export type Label = z.output<typeof Label>;

const LabelList = z.object({ labels: z.array(Label).default([]) });

const Header = z.object({ name: z.string(), value: z.string() });

const PartBody = z.object({
	size: z.number().int().default(0),
	data: z.string().nullable().default(null),
	attachmentId: z.string().nullable().default(null),
});

export interface Part {
	mimeType: string;
	filename: string;
	headers: { name: string; value: string }[];
	body: { size: number; data: string | null; attachmentId: string | null } | null;
	parts: Part[];
}

export const Part: z.ZodType<Part> = z.object({
	mimeType: z.string().default(""),
	filename: z.string().default(""),
	headers: z.array(Header).default([]),
	body: PartBody.nullable().default(null),
	get parts() {
		return z.array(Part).default([]);
	},
});

export const Message = z.object({
	id: z.string(),
	threadId: z.string(),
	labelIds: z.array(z.string()).default([]),
	snippet: z.string().default(""),
	/** When Gmail received it, in epoch milliseconds, written as a string of digits. */
	internalDate: z.string().regex(/^\d{1,15}$/).transform(Number).nullable().default(null),
	payload: Part.nullable().default(null),
});
export type Message = z.output<typeof Message>;

/** Every value of one top-level header (a header can appear more than once). */
export function headersOf(message: Message, name: string): string[] {
	const folded = name.toLowerCase();
	return (message.payload ? message.payload.headers : []).filter((h) => h.name.toLowerCase() === folded).map((h) => h.value);
}

const MessageRef = z.object({ id: z.string(), threadId: z.string() });
export type MessageRef = z.output<typeof MessageRef>;

const MessageList = z.object({
	messages: z.array(MessageRef).default([]),
	nextPageToken: z.string().nullable().default(null),
});

const Thread = z.object({ id: z.string(), messages: z.array(Message).default([]) });
export type Thread = z.output<typeof Thread>;

const Draft = z.object({ id: z.string(), message: MessageRef });
export type Draft = z.output<typeof Draft>;

const SendAsList = z.object({ sendAs: z.array(z.object({ sendAsEmail: z.string() })).default([]) });

const Profile = z.object({ emailAddress: z.string() });

/** Gmail's own errors first (its wording, "Mail service not enabled", is never shown), then Google's 403s. */
export function classify(provider: string, response: Response, body: string): OperationErrorShape | null {
	if (response.status === 400 && reasons(body).has("failedPrecondition")) {
		return new OperationError("UNSUPPORTED_ACCOUNT", "This Google account does not have Gmail.");
	}
	return googleClassify(provider, response, body);
}

/** A page token Gmail returned, as the next cursor; one Minerva would not accept back is refused. */
export function pageToken(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !PAGE_TOKEN.test(value)) throw new OperationError("PROVIDER_LIMIT", "Gmail returned a page token Minerva does not accept.");
	return value;
}

export type Format = "minimal" | "metadata" | "full";

export interface MessageQuery {
	labelId: string | null;
	query: string | null;
	limit: number;
	cursor: string | null;
	spamTrash: boolean;
}

export class GmailClient implements ProviderClient {
	readonly http: ProviderHTTP;

	constructor(accessToken: string, io: ProviderIo, options: { baseUrl?: string } = {}) {
		this.http = new ProviderHTTP(io, {
			provider: "Gmail",
			baseUrl: options.baseUrl ?? API_URL,
			headers: { Authorization: `Bearer ${accessToken}` },
			classify,
		});
	}

	close(): Promise<void> {
		return this.http.close();
	}

	unexpected(): OperationError {
		return this.http.unexpected();
	}

	user(): Promise<GoogleUser> {
		return this.http.parsed({ method: "GET", path: USERINFO_URL }, GoogleUser);
	}

	/** Every label of the mailbox: Gmail lists them all in one response. */
	async labels(): Promise<Label[]> {
		return (await this.http.parsed({ method: "GET", path: "/labels" }, LabelList)).labels;
	}

	async messages(options: MessageQuery): Promise<[MessageRef[], string | null]> {
		const query: { [name: string]: string | number } = { maxResults: options.limit, includeSpamTrash: String(options.spamTrash) };
		if (options.labelId) query.labelIds = options.labelId;
		if (options.query) query.q = options.query;
		if (options.cursor) {
			if (!PAGE_TOKEN.test(options.cursor)) throw new OperationError("INVALID_CURSOR", "This cursor is not valid.");
			query.pageToken = options.cursor;
		}
		const page = await this.http.parsed({ method: "GET", path: "/messages", query }, MessageList);
		return [page.messages, pageToken(page.nextPageToken)];
	}

	/** A message in `minimal` (labels only), `metadata` (also `headers`) or `full` format. */
	message(messageId: string, format: Format, headers: readonly string[] = SUMMARY_HEADERS): Promise<Message> {
		const params = new URLSearchParams({ format });
		if (format === "metadata") for (const name of headers) params.append("metadataHeaders", name);
		const path = `/messages/${segment(messageId)}?${params}`;
		if (format !== "full") return this.http.parsed({ method: "GET", path }, Message);
		return this.bounded(Message, path, MAX_MESSAGE_BYTES);
	}

	thread(threadId: string): Promise<Thread> {
		return this.bounded(Thread, `/threads/${segment(threadId)}?format=full`, MAX_THREAD_BYTES);
	}

	private async bounded<T>(schema: z.ZodType<T>, path: string, limit: number): Promise<T> {
		const response = await this.http.bounded({ method: "GET", path }, limit, new OperationError("RESPONSE_TOO_LARGE", "Gmail returned more than Minerva reads."));
		const bytes = new Uint8Array(await response.arrayBuffer());
		let data: Json;
		try {
			// Strict UTF-8; the decoder drops a byte order mark, as the other answers' reader does.
			data = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		} catch (error) {
			throw this.http.unexpected(error);
		}
		const result = await schema.safeParseAsync(data);
		if (!result.success) throw this.http.unexpected(result.error);
		return result.data;
	}

	/** The account's address and every address it sends as. */
	async ownAddresses(): Promise<string[]> {
		const profile = await this.http.parsed({ method: "GET", path: "/profile" }, Profile);
		const sendAs = await this.http.parsed({ method: "GET", path: "/settings/sendAs" }, SendAsList);
		return [profile.emailAddress, ...sendAs.sendAs.map((item) => item.sendAsEmail)];
	}

	send(raw: string, threadId: string | null): Promise<MessageRef> {
		const body: { [key: string]: Json } = { raw };
		if (threadId) body.threadId = threadId;
		return this.http.parsed({ method: "POST", path: "/messages/send", json: body }, MessageRef);
	}

	createDraft(raw: string, threadId: string | null): Promise<Draft> {
		const message: { [key: string]: Json } = { raw };
		if (threadId) message.threadId = threadId;
		return this.http.parsed({ method: "POST", path: "/drafts", json: { message } }, Draft);
	}
}
