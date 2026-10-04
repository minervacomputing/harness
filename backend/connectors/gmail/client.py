"""A thin async client for the Gmail API v1, for the connected account (`users/me`).

Responses are validated before use. Full messages and threads are read with a byte limit, since their
bodies come inline. Gmail reports an account without Gmail as a failed precondition (`UNSUPPORTED_ACCOUNT`);
rate limits and an API that is not enabled come as Google's usual 403s (see `connectors.google`).
"""

import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.google import USERINFO_URL, GoogleUser, forbidden, segment
from connectors.http import ProviderHTTP

API_URL = "https://gmail.googleapis.com/gmail/v1/users/me"
# Message, thread and label ids. Gmail's message and thread ids are hex; user label ids are `Label_<n>`.
ID = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
PAGE_TOKEN = re.compile(r"\A[A-Za-z0-9_-]{1,200}\Z")
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_THREAD_BYTES = 16 * 1024 * 1024
SUMMARY_HEADERS = ("From", "To", "Cc", "Subject", "Date")
# What a reply is addressed and threaded by.
REPLY_HEADERS = ("From", "Sender", "Reply-To", "Subject", "Message-ID", "References")


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class Label(Model):
    id: str
    name: str
    type: str | None = None


class LabelList(Model):
    labels: list[Label] = []


class Header(Model):
    name: str
    value: str


class PartBody(Model):
    size: int = 0
    data: str | None = None
    attachment_id: str | None = None


class Part(Model):
    mime_type: str = ""
    filename: str = ""
    headers: list[Header] = []
    body: PartBody | None = None
    parts: list[Part] = []


class Message(Model):
    id: str
    thread_id: str
    label_ids: list[str] = []
    snippet: str = ""
    internal_date: str | None = None
    payload: Part | None = None

    def headers(self, name: str) -> list[str]:
        """Every value of one top-level header (a header can appear more than once)."""
        folded = name.lower()
        return [h.value for h in (self.payload.headers if self.payload else []) if h.name.lower() == folded]


class MessageRef(Model):
    id: str
    thread_id: str


class MessageList(Model):
    messages: list[MessageRef] = []
    next_page_token: str | None = None


class Thread(Model):
    id: str
    messages: list[Message] = []


class Draft(Model):
    id: str
    message: MessageRef


class SendAs(Model):
    send_as_email: str


class SendAsList(Model):
    send_as: list[SendAs] = []


class Profile(Model):
    email_address: str


def _reasons(response: httpx.Response) -> set[str]:
    try:
        error = response.json().get("error", {})
        return {item.get("reason") for item in error.get("errors", []) if isinstance(item, dict)}
    except ValueError, AttributeError, TypeError:
        return set()


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    # Gmail's own wording, "Mail service not enabled", is never shown.
    if response.status_code == 400 and "failedPrecondition" in _reasons(response):
        return OperationError("UNSUPPORTED_ACCOUNT", "This Google account does not have Gmail.")
    return None


def page_token(value: str | None) -> str | None:
    """A page token Gmail returned, as the next cursor; one Minerva would not accept back is refused."""
    if value is None:
        return None
    if not isinstance(value, str) or not PAGE_TOKEN.match(value):
        raise OperationError("PROVIDER_LIMIT", "Gmail returned a page token Minerva does not accept.")
    return value


class GmailClient:
    def __init__(
        self, access_token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._http = ProviderHTTP(
            "Gmail",
            base_url=base_url,
            headers={"Authorization": f"Bearer {access_token}"},
            transport=transport,
            forbidden=forbidden,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def user(self) -> GoogleUser:
        return await self._http.parsed(GoogleUser, "GET", USERINFO_URL)

    async def labels(self) -> list[Label]:
        """Every label of the mailbox: Gmail lists them all in one response."""
        return (await self._http.parsed(LabelList, "GET", "/labels")).labels

    async def messages(
        self, *, label_id: str | None, query: str | None, limit: int, cursor: str | None, spam_trash: bool
    ) -> tuple[list[MessageRef], str | None]:
        params: dict[str, Any] = {"maxResults": limit, "includeSpamTrash": str(spam_trash).lower()}
        if label_id:
            params["labelIds"] = label_id
        if query:
            params["q"] = query
        if cursor:
            if not PAGE_TOKEN.match(cursor):
                raise OperationError("INVALID_CURSOR", "This cursor is not valid.")
            params["pageToken"] = cursor
        page = await self._http.parsed(MessageList, "GET", "/messages", params=params)
        return page.messages, page_token(page.next_page_token)

    async def message(
        self, message_id: str, *, format: str, headers: tuple[str, ...] = SUMMARY_HEADERS
    ) -> Message:
        """A message in `minimal` (labels only), `metadata` (also `headers`) or `full` format."""
        path = f"/messages/{segment(message_id)}"
        params: dict[str, Any] = {"format": format}
        if format == "metadata":
            params["metadataHeaders"] = list(headers)
        if format != "full":
            return await self._http.parsed(Message, "GET", path, params=params)
        return await self._bounded(Message, path, params, MAX_MESSAGE_BYTES)

    async def thread(self, thread_id: str) -> Thread:
        return await self._bounded(
            Thread, f"/threads/{segment(thread_id)}", {"format": "full"}, MAX_THREAD_BYTES
        )

    async def _bounded[M: BaseModel](self, model: type[M], path: str, params: dict, limit: int) -> M:
        response = await self._http.bounded(
            path,
            limit=limit,
            params=params,
            too_large=OperationError("RESPONSE_TOO_LARGE", "Gmail returned more than Minerva reads."),
        )
        try:
            return model.model_validate(response.json())
        except ValueError as error:
            raise self.unexpected() from error

    async def own_addresses(self) -> list[str]:
        """The account's address and every address it sends as."""
        profile = await self._http.parsed(Profile, "GET", "/profile")
        send_as = await self._http.parsed(SendAsList, "GET", "/settings/sendAs")
        return [profile.email_address, *(item.send_as_email for item in send_as.send_as)]

    async def send(self, raw: str, thread_id: str | None) -> MessageRef:
        body: dict[str, Any] = {"raw": raw}
        if thread_id:
            body["threadId"] = thread_id
        return await self._http.parsed(MessageRef, "POST", "/messages/send", json=body)

    async def create_draft(self, raw: str, thread_id: str | None) -> Draft:
        message: dict[str, Any] = {"raw": raw}
        if thread_id:
            message["threadId"] = thread_id
        return await self._http.parsed(Draft, "POST", "/drafts", json={"message": message})
