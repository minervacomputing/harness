// Microsoft Graph, for the signed-in user's mailbox. What
// Microsoft connectors share is in connectors/microsoft.
//
// Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a message keeps its id when it
// moves within the mailbox and a move shows only as a new parent folder. Writes are judged by status: Graph
// accepts mail with 202, refuses before sending with 4xx, and leaves the outcome unknown otherwise. A 202
// means accepted, not delivered: delivery is asynchronous, and a bounce arrives later as mail.

import type { ProviderIo } from "../../contracts/connectors.ts";
import { type Json } from "../../lib/json.ts";
import { OperationError } from "../../gateway/connector.ts";
import { API_URL, Graph, IMMUTABLE_IDS, User, pageParam, segment } from "../microsoft/index.ts";
import { bool, int, list, model, nullable, optional, required, str } from "../microsoft/model.ts";

export const TEXT_BODY = `${IMMUTABLE_IDS}, outlook.body-content-type="text"`;

export const FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden";
export const MAIL_FOLDER = "#microsoft.graph.mailFolder";
export const SUMMARY_FIELDS =
	"id,conversationId,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,hasAttachments,importance,bodyPreview,categories";
export const REPLY_FIELDS = "id,parentFolderId,from,sender,replyTo,isDraft";
export const FULL_FIELDS = `${SUMMARY_FIELDS},replyTo,bccRecipients,body`;

export const Folder = model({
	id: required(str),
	display_name: optional(str, ""),
	parent_folder_id: optional(nullable(str), null),
	child_folder_count: optional(nullable(int), null),
	unread_item_count: optional(nullable(int), null),
	total_item_count: optional(nullable(int), null),
	is_hidden: optional(nullable(bool), null),
	// Graph names the type only of folders that are not plain mail folders, such as search folders.
	odata_type: optional(nullable(str), null, "@odata.type"),
});
export type Folder = ReturnType<typeof Folder>;

/**
 * A mail folder that holds its own mail and that Outlook shows: not a search folder, which collects mail from
 * other folders wherever it sits, and not hidden.
 */
export function ordinary(folder: Folder): boolean {
	return folder.is_hidden !== true && (folder.odata_type === null || folder.odata_type === MAIL_FOLDER);
}

export const EmailAddress = model({ name: optional(nullable(str), null), address: optional(nullable(str), null) });
export const Recipient = model({ email_address: optional(nullable(EmailAddress), null) });
export type Recipient = ReturnType<typeof Recipient>;
const Body = model({ content_type: optional(nullable(str), null), content: optional(str, "") });

export const Message = model({
	id: required(str),
	conversation_id: optional(nullable(str), null),
	parent_folder_id: optional(nullable(str), null),
	subject: optional(nullable(str), null),
	from_: optional(nullable(Recipient), null, "from"),
	sender: optional(nullable(Recipient), null),
	to_recipients: optional(list(Recipient), []),
	cc_recipients: optional(list(Recipient), []),
	bcc_recipients: optional(list(Recipient), []),
	reply_to: optional(list(Recipient), []),
	received_date_time: optional(nullable(str), null),
	sent_date_time: optional(nullable(str), null),
	is_read: optional(nullable(bool), null),
	is_draft: optional(nullable(bool), null),
	has_attachments: optional(nullable(bool), null),
	importance: optional(nullable(str), null),
	body_preview: optional(nullable(str), null),
	categories: optional(list(str), []),
	body: optional(nullable(Body), null),
});
export type Message = ReturnType<typeof Message>;

export const Attachment = model({
	id: optional(nullable(str), null),
	name: optional(nullable(str), null),
	content_type: optional(nullable(str), null),
	size: optional(nullable(int), null),
	is_inline: optional(nullable(bool), null),
});
export type Attachment = ReturnType<typeof Attachment>;

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
