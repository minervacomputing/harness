"""Microsoft Graph, for the signed-in user's mailbox.

Every request asks for immutable ids, so a message keeps its id when it moves within the mailbox and a
move shows only as a new parent folder. Writes are judged by status: Graph accepts mail with 202, refuses
before sending with 4xx, and leaves the outcome unknown otherwise. A 202 means accepted, not delivered:
delivery is asynchronous, and a bounce arrives later as mail. Graph's own error texts never reach the
model.

Graph pages with an `@odata.nextLink` URL. Minerva never requests that URL: it takes only the paging
parameter out of it (`$skip` or `$skiptoken`), checks it, and rebuilds the request itself.
"""

import json
import re
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.http import ProviderHTTP, default_forbidden

API_URL = "https://graph.microsoft.com/v1.0"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
IMMUTABLE_IDS = 'IdType="ImmutableId"'
TEXT_BODY = f'{IMMUTABLE_IDS}, outlook.body-content-type="text"'
# Graph's ids are URL-safe base64.
ID = re.compile(r"^[A-Za-z0-9=_-]{10,512}$")
_SKIP = re.compile(r"^\d{1,6}$")
_SKIPTOKEN = re.compile(r"^[A-Za-z0-9._~=+/%:-]{1,880}$")
# The mailbox exists but Graph cannot reach it: on-premises Exchange, or an inactive account.
UNSUPPORTED_MAILBOX = frozenset({"MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI"})

FOLDER_FIELDS = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden"
MAIL_FOLDER = "#microsoft.graph.mailFolder"
SUMMARY_FIELDS = (
    "id,conversationId,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,"
    "sentDateTime,isRead,isDraft,hasAttachments,importance,bodyPreview,categories"
)
REPLY_FIELDS = "id,parentFolderId,from,sender,replyTo,isDraft"
FULL_FIELDS = f"{SUMMARY_FIELDS},replyTo,bccRecipients,body"


def segment(value: str) -> str:
    return quote(value, safe="")


def _code(response: httpx.Response) -> str | None:
    try:
        code = response.json().get("error", {}).get("code")
    except ValueError, AttributeError:
        return None
    return code if isinstance(code, str) else None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    if _code(response) in UNSUPPORTED_MAILBOX:
        return OperationError(
            "UNSUPPORTED_ACCOUNT",
            f"This account has no mailbox {provider} lets Minerva use (for example, it is hosted on an "
            "on-premises Exchange server).",
        )
    if response.status_code == 503:
        # Graph throttles with 503 as well as 429.
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    return None


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class User(Model):
    id: str
    display_name: str | None = None
    mail: str | None = None
    user_principal_name: str | None = None
    proxy_addresses: list[str] = []


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


def page_param(cursor: str) -> dict[str, str]:
    """The query parameter a cursor stands for, or INVALID_CURSOR."""
    kind, _, value = cursor.partition(":")
    if kind == "skip" and _SKIP.match(value):
        return {"$skip": value}
    if kind == "token" and _SKIPTOKEN.match(value):
        return {"$skiptoken": value}
    raise OperationError("INVALID_CURSOR", "This page token is invalid.")


def next_cursor(next_link: Any) -> str | None:
    """The cursor for Graph's next page, taken out of its nextLink; the link itself is never requested."""
    if next_link is None:
        return None
    unusable = OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.")
    if not isinstance(next_link, str) or len(next_link) > 4000:
        raise unusable
    query = parse_qs(urlsplit(next_link).query)
    token = query.get("$skiptoken")
    skip = query.get("$skip")
    if token and len(token) == 1 and not skip and _SKIPTOKEN.match(token[0]):
        return f"token:{token[0]}"
    if skip and len(skip) == 1 and not token and _SKIP.match(skip[0]):
        return f"skip:{skip[0]}"
    raise unusable


class GraphClient:
    """Thin async client for the parts of Microsoft Graph Outlook uses. Responses are validated."""

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._http = ProviderHTTP(
            "Outlook",
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "Prefer": IMMUTABLE_IDS,
            },
            transport=transport,
            forbidden=default_forbidden,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def get(
        self, path: str, *, params: dict[str, str] | None = None, prefer: str = IMMUTABLE_IDS
    ) -> dict[str, Any]:
        response = await self._http.bounded(
            path,
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Outlook returned more than Minerva reads."),
            params=params,
            headers={"Prefer": prefer},
        )
        try:
            body = response.json()
        except ValueError:
            raise self.unexpected() from None
        if not isinstance(body, dict):
            raise self.unexpected()
        return body

    def _parse[M: BaseModel](self, model: type[M], value: Any) -> M:
        try:
            return model.model_validate(value)
        except ValidationError as error:
            raise self.unexpected() from error

    def _page[M: BaseModel](self, model: type[M], body: dict[str, Any]) -> tuple[list[M], str | None]:
        items = body.get("value")
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(model, item) for item in items], next_cursor(body.get("@odata.nextLink"))

    async def me(self) -> User:
        return self._parse(
            User, await self.get("/me", params={"$select": "id,displayName,mail,userPrincipalName"})
        )

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
