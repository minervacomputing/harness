"""Microsoft Graph, for the signed-in user's mailbox. What Microsoft connectors share is in
`connectors.microsoft`.

Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a message keeps its id when it
moves within the mailbox and a move shows only as a new parent folder. Writes are judged by status: Graph
accepts mail with 202, refuses before sending with 4xx, and leaves the outcome unknown otherwise. A 202
means accepted, not delivered: delivery is asynchronous, and a bounce arrives later as mail.
"""

import json
from typing import Any

import httpx
from pydantic import Field

from connectors.base import OperationError
from connectors.microsoft import (
    API_URL,
    IMMUTABLE_IDS,
    Graph,
    Model,
    User,
    page_param,
    segment,
)

TEXT_BODY = f'{IMMUTABLE_IDS}, outlook.body-content-type="text"'

FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden"
MAIL_FOLDER = "#microsoft.graph.mailFolder"
SUMMARY_FIELDS = (
    "id,conversationId,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,"
    "sentDateTime,isRead,isDraft,hasAttachments,importance,bodyPreview,categories"
)
REPLY_FIELDS = "id,parentFolderId,from,sender,replyTo,isDraft"
FULL_FIELDS = f"{SUMMARY_FIELDS},replyTo,bccRecipients,body"


class Folder(Model):
    id: str
    display_name: str = ""
    parent_folder_id: str | None = None
    child_folder_count: int | None = None
    unread_item_count: int | None = None
    total_item_count: int | None = None
    is_hidden: bool | None = None
    # Graph names the type only of folders that are not plain mail folders, such as search folders.
    odata_type: str | None = Field(default=None, alias="@odata.type")

    @property
    def ordinary(self) -> bool:
        """A mail folder that holds its own mail and that Outlook shows: not a search folder, which
        collects mail from other folders wherever it sits, and not hidden."""
        return self.is_hidden is not True and self.odata_type in (None, MAIL_FOLDER)


class EmailAddress(Model):
    name: str | None = None
    address: str | None = None


class Recipient(Model):
    email_address: EmailAddress | None = None


class Body(Model):
    content_type: str | None = None
    content: str = ""


class Message(Model):
    id: str
    conversation_id: str | None = None
    parent_folder_id: str | None = None
    subject: str | None = None
    from_: Recipient | None = Field(default=None, alias="from")
    sender: Recipient | None = None
    to_recipients: list[Recipient] = []
    cc_recipients: list[Recipient] = []
    bcc_recipients: list[Recipient] = []
    reply_to: list[Recipient] = []
    received_date_time: str | None = None
    sent_date_time: str | None = None
    is_read: bool | None = None
    is_draft: bool | None = None
    has_attachments: bool | None = None
    importance: str | None = None
    body_preview: str | None = None
    categories: list[str] = []
    body: Body | None = None


class Attachment(Model):
    id: str | None = None
    name: str | None = None
    content_type: str | None = None
    size: int | None = None
    is_inline: bool | None = None


class GraphClient(Graph):
    """Thin async client for the parts of Microsoft Graph Outlook uses. Responses are validated."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        super().__init__("Outlook", access_token, base_url=base_url, transport=transport)

    async def identities(self) -> User:
        """The account with its other addresses (aliases), where the account has them. Accounts that do not
        keep them in Graph, such as personal Microsoft accounts, may refuse to name them."""
        try:
            body = await self.get(
                "/me", params={"$select": "id,displayName,mail,userPrincipalName,proxyAddresses"}
            )
        except OperationError as error:
            if error.code != "PROVIDER_REJECTED":
                raise
            return await self.me()
        return self._parse(User, body)

    async def folder(self, folder: str) -> Folder:
        """A folder by id or well-known name."""
        return self._parse(
            Folder, await self.get(f"/me/mailFolders/{segment(folder)}", params={"$select": FOLDER_FIELDS})
        )

    async def folders(
        self, parent: str | None, *, limit: int, cursor: str | None
    ) -> tuple[list[Folder], str | None]:
        """The top-level folders, or a folder's subfolders. Graph leaves out hidden folders."""
        path = f"/me/mailFolders/{segment(parent)}/childFolders" if parent else "/me/mailFolders"
        params = {"$select": FOLDER_FIELDS, "$top": str(limit), **(page_param(cursor) if cursor else {})}
        return self._page(Folder, await self.get(path, params=params))

    async def messages(
        self,
        folder_id: str,
        *,
        limit: int,
        cursor: str | None,
        filter: str | None,
        search: str | None,
    ) -> tuple[list[Message], str | None]:
        params = {"$select": SUMMARY_FIELDS, "$top": str(limit)}
        if search is not None:
            # $search cannot be combined with $filter or $orderby; Graph orders by relevance and date.
            params["$search"] = f'"{search}"'
        else:
            params["$orderby"] = "receivedDateTime desc"
            if filter is not None:
                params["$filter"] = filter
        if cursor:
            params.update(page_param(cursor))
        body = await self.get(f"/me/mailFolders/{segment(folder_id)}/messages", params=params)
        return self._page(Message, body)

    async def message(self, message_id: str, *, fields: str, text_body: bool = False) -> Message:
        body = await self.get(
            f"/me/messages/{segment(message_id)}",
            params={"$select": fields},
            prefer=TEXT_BODY if text_body else IMMUTABLE_IDS,
        )
        return self._parse(Message, body)

    async def attachments(self, message_id: str, *, limit: int) -> list[Attachment]:
        body = await self.get(
            f"/me/messages/{segment(message_id)}/attachments",
            params={"$select": "id,name,contentType,size,isInline", "$top": str(limit)},
        )
        items, _ = self._page(Attachment, body)
        return items

    async def _post(self, path: str, payload: dict[str, Any]) -> None:
        """The one write of an operation; Graph answers 202 with no body."""
        await self._http.request(
            "POST",
            path,
            mutating=True,
            content=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )

    async def send(self, message: dict[str, Any]) -> None:
        await self._post("/me/sendMail", {"message": message, "saveToSentItems": True})

    async def reply(self, message_id: str, message: dict[str, Any]) -> None:
        await self._post(f"/me/messages/{segment(message_id)}/reply", {"message": message})
