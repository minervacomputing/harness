"""Outlook mail, through Microsoft Graph. Folders are read per folder; mail is sent per recipient.

Microsoft's read permission covers the whole mailbox, so the folder limits are Minerva's. A grant on a
folder covers its subfolders. Each call resolves where a folder sits (its chain of parent folders up to
the top of the mailbox's folders) before authorization, and again just before it reads or replies: a
call whose folder moved in between is refused. Folders outside that tree (Exchange's system folders) are
refused, and so are search folders, which collect mail from other folders, and hidden folders, wherever
they sit and for everything below them. A listing leaves out any message that does not live in the folder
listed.

Sending is allowed per recipient address, or per domain (see `addresses`). Every address a message goes
to, Cc and Bcc included, needs a grant. A reply goes to the addresses the original asks replies to go to,
or else to its sender, and needs a grant for each of them and permission to read the original's folder.
Minerva names those addresses itself in the reply, and refuses replies to drafts and to the account's own
messages (sent from any of its addresses, sent by it for someone else, or kept in Sent Items), whose
recipients Graph would work out differently.

Mail is sent as plain text, from the connected account, and saved to Sent Items. Not supported: drafts,
attachments, forwarding, reply-all, moving, deleting or flagging mail, and shared mailboxes.

This module assembles the connector. The operations are in `reads` and `writes`; what they share (Graph
consent, folder and message ids, where folders sit) is in `mailbox`.
"""

import asyncio

from connectors.base import (
    Account,
    ActionSpec,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    OAuth2,
    OperationError,
    ResourceKind,
)
from connectors.outlook import addresses
from connectors.outlook.client import ID, GraphClient
from connectors.outlook.mailbox import CONNECTION_ERRORS, FOLDER, RECIPIENT, ROOT, Tree
from connectors.outlook.reads import LIST_FOLDERS, LIST_MESSAGES, READ_MESSAGE
from connectors.outlook.writes import REPLY, SEND_MESSAGE

DESCRIBE_CONCURRENCY = 5
MAX_DISCOVER = 500
MAX_DISCOVER_REQUESTS = 60


class OutlookConnector(Connector):
    slug = "outlook"
    name = "Outlook"
    kinds = (
        ResourceKind(
            FOLDER,
            "Folder",
            ("read",),
            wildcard=True,
            hierarchical=True,
            note=(
                "Microsoft lets Minerva read the whole mailbox; Minerva limits agents to the folders allowed "
                "here. Access to a folder covers its subfolders."
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
                "still reach others through distribution lists, aliases and forwarding."
            ),
        ),
    )
    actions = (
        ActionSpec("read", "Read mail"),
        ActionSpec("send", "Send mail"),
    )
    # Reading is enough to connect; sending is asked for once the user allows it.
    auth = OAuth2(
        app="microsoft",
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",  # noqa: S106
        scopes=("offline_access", "User.Read", "Mail.Read"),
        authorize_params=(("prompt", "select_account"),),
    )

    operations = (LIST_FOLDERS, LIST_MESSAGES, READ_MESSAGE, SEND_MESSAGE, REPLY)

    def client(self, access_token: str) -> GraphClient:
        return GraphClient(access_token)

    async def account(self, client: GraphClient) -> Account:
        user = await client.me()
        return Account(
            id=user.id, label=user.mail or user.user_principal_name or user.display_name or "Outlook"
        )

    async def discover(
        self, client: GraphClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if kind == RECIPIENT:
            if not query:
                return DiscoveryPage([])
            return DiscoveryPage(
                [DiscoveryItem(item, addresses.name(item)) for item in addresses.choices(query)]
            )
        found = await _all_folders(client)
        folded = query.casefold() if query else None
        return DiscoveryPage(
            [
                DiscoveryItem(folder_id, path)
                for folder_id, path in found
                if not folded or folded in path.casefold()
            ]
        )

    async def describe(self, client: GraphClient, kind: str, ids: list[str]) -> dict[str, str]:
        if kind == RECIPIENT:
            return {
                resource_id: addresses.name(resource_id)
                for resource_id in ids
                if addresses.valid_id(resource_id)
            }
        tree = Tree(client)
        await tree.root()
        limit = asyncio.Semaphore(DESCRIBE_CONCURRENCY)

        async def name(folder_id: str) -> str | None:
            async with limit:
                try:
                    folder = await client.folder(folder_id)
                    within = await tree.place(folder)
                except OperationError as error:
                    if error.code in CONNECTION_ERRORS:
                        raise
                    return None
            if within is None or folder.id != folder_id:
                return None
            return tree.path(folder, within)

        wanted = [folder_id for folder_id in ids if ID.match(folder_id)]
        names = await asyncio.gather(*(name(folder_id) for folder_id in wanted))
        return {folder_id: n for folder_id, n in zip(wanted, names, strict=True) if n is not None}


async def _all_folders(client: GraphClient) -> list[tuple[str, str]]:
    """Folders under the root with their paths, breadth first, as many as a few requests find."""
    root = (await client.folder(ROOT)).id
    found: list[tuple[str, str]] = []
    queue: list[tuple[str | None, str]] = [(None, "")]
    requests = 0
    while queue and requests < MAX_DISCOVER_REQUESTS and len(found) < MAX_DISCOVER:
        parent, prefix = queue.pop(0)
        cursor = None
        while requests < MAX_DISCOVER_REQUESTS:
            requests += 1
            folders, cursor = await client.folders(parent, limit=100, cursor=cursor)
            for folder in folders:
                if (
                    folder.parent_folder_id != (parent or root)
                    or not ID.match(folder.id)
                    or not folder.ordinary
                ):
                    continue
                path = prefix + folder.display_name
                found.append((folder.id, path))
                if folder.child_folder_count:
                    queue.append((folder.id, f"{path}/"))
            if cursor is None:
                break
    return found[:MAX_DISCOVER]
