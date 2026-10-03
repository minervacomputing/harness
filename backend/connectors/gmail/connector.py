"""Gmail, through the Gmail API. Mail is read per label, sent per recipient, and drafted per account.

Minerva connects through the operator's Google app, shared with Google Calendar and Drive (see
`connectors.google`). The base scope is `gmail.readonly`; sending asks for `gmail.send`, and drafts for
`gmail.compose`. Google's read scope covers the whole mailbox, so the label limits are Minerva's.

Labels are one hierarchical kind keyed by label id: the user's labels, and the system labels that say
where mail is (Inbox, Sent, Drafts, Spam, Trash and the five inbox categories). Gmail nests labels by name,
so a grant on `Work` covers `Work/Projects` (see `mailbox`). Marks that say nothing about where mail is
(unread, starred, important) are never used to authorize it, and chats are refused.

A message can carry several labels. It is authorized as its own resource inside every label it carries and
their parents: any of them allowed lets an agent read it, and any of them denied hides it. A message without
such a label (archived mail) is covered only by allowing every label, and a label Minerva does not know
makes it partial, so that any deny on a label hides it. Labels can change at any time; every call works out
where its message sits before authorization, and again from fresh labels just before reading or replying,
and refuses a message that moved in between (`MAIL_MOVED`). A label's name is shown only for labels the
agent may read: messages carry label ids.

Listings and threads hold mail from many labels, so they are filtered per message, after Gmail has searched
the whole mailbox. An agent therefore learns whether mail it may not read matches a search (a page with
hidden results, or a cursor after one), and with Gmail's search language can test what such mail says, as
with Notion and GitHub search; it never sees the mail itself. Label names are given below their parent, so
a label never names a parent the agent may not read.

Sending is allowed per recipient address, or per domain, as for Outlook (`connectors.addresses`). Every
address a message goes to, To, Cc and Bcc, is a need. A reply goes to the original's Reply-To addresses, or
else to its sender, and needs Read on the original and Send on each; Minerva names them itself, copies
nobody else, and refuses replies when a header cannot be read strictly (it never falls back from Reply-To to
From), when the addresses changed since authorization, to drafts, and to the account's own mail (labelled
Sent, or from or sent by the account's address or any address it sends as). Replies are threaded with
In-Reply-To and References when the original's Message-ID is well formed.

Drafts are an account-level action: a draft waits in Drafts until the user sends it, so its recipients need
no send permission. A reply draft also needs Read on the original and is addressed as a reply would be.

Mail is sent as plain text, from the account's default address, and kept in Sent. Not supported: reading
attachments, forwarding, reply-all, labelling, archiving, deleting or sending drafts.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (consent,
ids, labels and where messages sit) is in `mailbox`, and MIME handling is in `mime`.
"""

from connectors import addresses
from connectors.base import (
    ACCOUNT_KIND,
    Account,
    ActionSpec,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    ResourceKind,
)
from connectors.gmail.client import GmailClient
from connectors.gmail.mailbox import LABEL, READONLY_SCOPE, RECIPIENT, Labels
from connectors.gmail.reads import LIST_LABELS, LIST_MESSAGES, READ_MESSAGE, READ_THREAD
from connectors.gmail.writes import CREATE_DRAFT, CREATE_REPLY_DRAFT, REPLY, SEND_MESSAGE
from connectors.google import oauth as google_oauth


class GmailConnector(Connector):
    slug = "gmail"
    name = "Gmail"
    kinds = (
        ResourceKind(
            LABEL,
            "Label",
            ("read",),
            wildcard=True,
            hierarchical=True,
            note=(
                "Google lets Minerva read the whole mailbox; Minerva limits agents to mail with the labels "
                "allowed here. A message with several labels can be read if one of them is allowed, and "
                "is hidden if one of them is denied. Access to a label covers the labels nested under it. "
                "Archived mail without labels is covered only by allowing every label."
            ),
        ),
        ResourceKind(
            RECIPIENT,
            "Recipient",
            ("send",),
            wildcard=True,
            hierarchical=True,
            listed=False,
            note=(
                "Paste an address or a domain to add it. Everyone at a domain means every address there, "
                "which for a provider such as gmail.com is everyone with an account. Mail to an address can "
                "still reach others through mailing lists, aliases and forwarding."
            ),
        ),
        ResourceKind(
            ACCOUNT_KIND,
            "Drafts",
            ("draft",),
            note="Drafts wait in Gmail until you send them, to any recipient, so drafting needs no recipients.",
        ),
    )
    actions = (
        ActionSpec("read", "Read mail"),
        ActionSpec("send", "Send mail"),
        ActionSpec("draft", "Create drafts"),
    )
    # Reading is enough to connect; sending and drafting are asked for once the user allows them.
    auth = google_oauth(READONLY_SCOPE)

    operations = (
        LIST_LABELS,
        LIST_MESSAGES,
        READ_MESSAGE,
        READ_THREAD,
        SEND_MESSAGE,
        REPLY,
        CREATE_DRAFT,
        CREATE_REPLY_DRAFT,
    )

    def client(self, access_token: str) -> GmailClient:
        return GmailClient(access_token)

    async def account(self, client: GmailClient) -> Account:
        user = await client.user()
        return Account(id=user.sub, label=user.email or user.name or "Gmail")

    async def discover(
        self, client: GmailClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if kind == RECIPIENT:
            if not query:
                return DiscoveryPage([])
            return DiscoveryPage(
                [DiscoveryItem(item, addresses.name(item)) for item in addresses.choices(query)]
            )
        labels = await Labels.fetch(client)
        folded = query.casefold() if query else None
        items = [DiscoveryItem(label_id, labels.name(label_id)) for label_id in labels.grantable]
        return DiscoveryPage([item for item in items if not folded or folded in item.name.casefold()])

    async def describe(self, client: GmailClient, kind: str, ids: list[str]) -> dict[str, str]:
        if kind == RECIPIENT:
            return {
                resource_id: addresses.name(resource_id)
                for resource_id in ids
                if addresses.valid_id(resource_id)
            }
        labels = await Labels.fetch(client)
        return {label_id: labels.name(label_id) for label_id in ids if label_id in labels.grantable}
