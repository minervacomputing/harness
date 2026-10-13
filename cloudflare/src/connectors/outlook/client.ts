// Microsoft Graph, for the signed-in user's mailbox. What
// Microsoft connectors share is in connectors/microsoft.
//
// Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a message keeps its id when it
// moves within the mailbox and a move shows only as a new parent folder. Writes are judged by status: Graph
// accepts mail with 202, refuses before sending with 4xx, and leaves the outcome unknown otherwise. A 202
// means accepted, not delivered: delivery is asynchronous, and a bounce arrives later as mail.

import { z } from "zod";
import { type Json } from "../../lib/json.ts";
import { OperationError } from "../../gateway/connector.ts";
import { API_URL, Graph, IMMUTABLE_IDS, User, pageParam } from "../microsoft/index.ts";
import { type ProviderIo, segment } from "../../gateway/http.ts";

export const TEXT_BODY = `${IMMUTABLE_IDS}, outlook.body-content-type="text"`;

export const FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden";
export const MAIL_FOLDER = "#microsoft.graph.mailFolder";
export const SUMMARY_FIELDS =
	"id,conversationId,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,importance,bodyPreview,categories";
export const REPLY_FIELDS = "id,parentFolderId,from,sender,replyTo,isDraft";
export const FULL_FIELDS = `${SUMMARY_FIELDS},replyTo,bccRecipients,body`;

export const Folder = z.object({
	id: z.string(),
	displayName: z.string().default(""),
	parentFolderId: z.string().nullable().default(null),
	childFolderCount: z.number().int().nullable().default(null),
	unreadItemCount: z.number().int().nullable().default(null),
	totalItemCount: z.number().int().nullable().default(null),
	isHidden: z.boolean().nullable().default(null),
	// Graph names the type only of folders that are not plain mail folders, such as search folders.
	"@odata.type": z.string().nullable().default(null),
});
export type Folder = z.output<typeof Folder>;

/**
 * A mail folder that holds its own mail and that Outlook shows: not a search folder, which collects mail from
 * other folders wherever it sits, and not hidden.
 */
export function ordinary(folder: Folder): boolean {
	const type = folder["@odata.type"];
	return folder.isHidden !== true && (type === null || type === MAIL_FOLDER);
}

export const EmailAddress = z.object({ name: z.string().nullable().default(null), address: z.string().nullable().default(null) });
export const Recipient = z.object({ emailAddress: EmailAddress.nullable().default(null) });
export type Recipient = z.output<typeof Recipient>;
const Body = z.object({ contentType: z.string().nullable().default(null), content: z.string().default("") });

export const Message = z.object({
	id: z.string(),
	conversationId: z.string().nullable().default(null),
	parentFolderId: z.string().nullable().default(null),
	subject: z.string().nullable().default(null),
	from: Recipient.nullable().default(null),
	sender: Recipient.nullable().default(null),
	toRecipients: z.array(Recipient).default([]),
	ccRecipients: z.array(Recipient).default([]),
	bccRecipients: z.array(Recipient).default([]),
	replyTo: z.array(Recipient).default([]),
	receivedDateTime: z.string().nullable().default(null),
	sentDateTime: z.string().nullable().default(null),
	isRead: z.boolean().nullable().default(null),
	isDraft: z.boolean().nullable().default(null),
	hasAttachments: z.boolean().nullable().default(null),
	importance: z.string().nullable().default(null),
	bodyPreview: z.string().nullable().default(null),
	categories: z.array(z.string()).default([]),
	body: Body.nullable().default(null),
});
export type Message = z.output<typeof Message>;

export const Attachment = z.object({
	id: z.string().nullable().default(null),
	name: z.string().nullable().default(null),
	contentType: z.string().nullable().default(null),
	size: z.number().int().nullable().default(null),
	isInline: z.boolean().nullable().default(null),
});
export type Attachment = z.output<typeof Attachment>;

/** Thin client for the parts of Microsoft Graph Outlook uses. Responses are validated. */
export class GraphClient extends Graph {
	constructor(accessToken: string, io: ProviderIo, baseUrl: string = API_URL) {
		super("Outlook", accessToken, io, { baseUrl });
	}

	/**
	 * The account with its other addresses (aliases), where the account has them. Accounts that do not keep
	 * them in Graph, such as personal Microsoft accounts, may refuse to name them.
	 */
	async identities(): Promise<User> {
		let body: { [key: string]: Json };
		try {
			body = await this.get("/me", { params: { $select: "id,displayName,mail,userPrincipalName,proxyAddresses" } });
		} catch (error) {
			if (!(error instanceof OperationError) || error.code !== "PROVIDER_REJECTED") throw error;
			return await this.me();
		}
		return this.parse(User, body);
	}

	/** A folder by id or well-known name. */
	async folder(folder: string): Promise<Folder> {
		return this.parse(Folder, await this.get(`/me/mailFolders/${segment(folder)}`, { params: { $select: FOLDER_FIELDS } }));
	}

	/** The top-level folders, or a folder's subfolders. Graph leaves out hidden folders. */
	async folders(parent: string | null, limit: number, cursor: string | null): Promise<[Folder[], string | null]> {
		const path = parent ? `/me/mailFolders/${segment(parent)}/childFolders` : "/me/mailFolders";
		const params = { $select: FOLDER_FIELDS, $top: String(limit), ...(cursor ? pageParam(cursor) : {}) };
		return this.page(Folder, await this.get(path, { params }));
	}

	async messages(
		folderId: string,
		options: { limit: number; cursor: string | null; filter: string | null; search: string | null },
	): Promise<[Message[], string | null]> {
		const params: { [name: string]: string } = { $select: SUMMARY_FIELDS, $top: String(options.limit) };
		if (options.search !== null) {
			// $search cannot be combined with $filter or $orderby; Graph orders by relevance and date.
			params.$search = `"${options.search}"`;
		} else {
			params.$orderby = "receivedDateTime desc";
			if (options.filter !== null) params.$filter = options.filter;
		}
		if (options.cursor) Object.assign(params, pageParam(options.cursor));
		return this.page(Message, await this.get(`/me/mailFolders/${segment(folderId)}/messages`, { params }));
	}

	async message(messageId: string, fields: string, textBody = false): Promise<Message> {
		const body = await this.get(`/me/messages/${segment(messageId)}`, { params: { $select: fields }, prefer: textBody ? TEXT_BODY : IMMUTABLE_IDS });
		return this.parse(Message, body);
	}

	async attachments(messageId: string, limit: number): Promise<Attachment[]> {
		const body = await this.get(`/me/messages/${segment(messageId)}/attachments`, {
			params: { $select: "id,name,contentType,size,isInline", $top: String(limit) },
		});
		const [items] = this.page(Attachment, body);
		return items;
	}

	/** The one write of an operation; Graph answers 202 with no body. */
	async #post(path: string, payload: { [key: string]: Json }): Promise<void> {
		await this.http.request({
			method: "POST",
			path,
			mutating: true,
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	}

	async send(message: { [key: string]: Json }): Promise<void> {
		await this.#post("/me/sendMail", { message, saveToSentItems: true });
	}

	async reply(messageId: string, message: { [key: string]: Json }): Promise<void> {
		await this.#post(`/me/messages/${segment(messageId)}/reply`, { message });
	}
}
