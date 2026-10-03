"""The Web: searching it and reading pages, with access chosen per site.

Opening an address sends whatever is in it to that site, so the sites an agent may read are also where
it could carry data out. Access is per exact host or per domain with its subdomains, never wider than a
registrable domain unless the user allows every site. Searching sends the query to the search provider,
so it is its own permission on the connection. Search results carry addresses and snippets only; reading
a result is a separate call that needs the site's permission.
"""

import asyncio
from typing import Annotated, Literal

from pydantic import Field, field_validator

from connectors.base import (
    ACCOUNT_KIND,
    Account,
    ActionSpec,
    Binding,
    Builtin,
    Connector,
    DiscoveryItem,
    DiscoveryPage,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    ResourceKind,
    ScopedRecord,
)
from connectors.web import sites
from connectors.web.fetch import Fetcher, Moved
from connectors.web.markdown import html_to_text
from connectors.web.search import MAX_PAGE, BraveSearch, plain
from minerva.config import config

SITE = "site"
MAX_SNIPPET = 600


class WebClient:
    def __init__(self, fetcher: Fetcher, search: BraveSearch | None) -> None:
        self.fetcher = fetcher
        self.search = search

    async def aclose(self) -> None:
        if self.search is not None:
            await self.search.aclose()


def _no_controls(value: str) -> str:
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise ValueError("must not contain control characters")
    return value


def _site(binding: Binding, host: str):
    return binding.resource(SITE, host, within=sites.ancestors(host))


class Search(OperationInput):
    query: Annotated[str, Field(min_length=1, max_length=400)]
    limit: Annotated[int, Field(ge=1, le=20)] = 10
    # Where results should come from, as a two-letter country code (CH, DE, US).
    country: Annotated[str, Field(pattern=r"^[A-Z]{2}$")] | None = None
    freshness: Literal["day", "week", "month", "year"] | None = None
    cursor: Annotated[str, Field(max_length=300)] | None = None

    _plain_query = field_validator("query")(_no_controls)


FRESHNESS = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}


async def _prepare_search(binding: Binding, data: Search) -> Prepared:
    page = int(data.cursor) if data.cursor and data.cursor.isdigit() else 0
    if data.cursor and not 1 <= page <= MAX_PAGE:
        raise OperationError("INVALID_ARGUMENTS", "Invalid arguments. cursor: unknown page")
    account = binding.account()

    async def execute() -> ProviderOutput:
        client: WebClient = binding.client
        if client.search is None:
            raise OperationError("SEARCH_UNAVAILABLE", "Web search is not set up on this Minerva instance.")
        response = await client.search.search(
            data.query,
            count=data.limit,
            page=page,
            country=data.country,
            freshness=FRESHNESS[data.freshness] if data.freshness else None,
        )
        records = []
        for result in response.web.results:
            try:
                url = sites.parse_url(result.url)
            except OperationError:
                continue
            records.append(
                ScopedRecord(
                    account,
                    {
                        "title": plain(result.title),
                        "url": url.text,
                        "site": url.host,
                        "snippet": plain(result.description)[:MAX_SNIPPET],
                        "age": result.age,
                    },
                )
            )
        more = response.query.more_results_available and page < MAX_PAGE
        return ProviderOutput(records, str(page + 1) if more else None)

    return Prepared([Need(account, "search")], execute)


class ReadPage(OperationInput):
    url: Annotated[str, Field(min_length=1, max_length=sites.MAX_URL)]
    max_chars: Annotated[int, Field(ge=500, le=100_000)] = 20_000
    # Where to start in the page's text, to continue a long page.
    offset: Annotated[int, Field(ge=0, le=10_000_000)] = 0


async def _prepare_read_page(binding: Binding, data: ReadPage) -> Prepared:
    # Only parsed here; nothing is resolved or fetched before the site is authorized.
    target = sites.parse_url(data.url)

    async def execute() -> ProviderOutput:
        client: WebClient = binding.client
        outcome = await client.fetcher.get(target)
        if isinstance(outcome, Moved):
            return ProviderOutput(
                [
                    ScopedRecord(
                        _site(binding, target.host),
                        {
                            "url": target.text,
                            "redirect_to": outcome.target.text,
                            "note": (
                                "This page moved to another address. Open redirect_to to follow it; "
                                "that site needs its own permission."
                            ),
                        },
                    )
                ]
            )
        title = None
        text = outcome.text
        if outcome.form == "html":
            text, title = await asyncio.to_thread(html_to_text, outcome.text, outcome.url.text)
        end = data.offset + data.max_chars
        return ProviderOutput(
            [
                ScopedRecord(
                    _site(binding, outcome.url.host),
                    {
                        "url": outcome.url.text,
                        "title": title,
                        "content_type": outcome.content_type,
                        "text": text[data.offset : end],
                        "offset": data.offset,
                        "total_chars": len(text),
                        "next_offset": end if end < len(text) else None,
                    },
                )
            ]
        )

    return Prepared([Need(_site(binding, target.host), "read")], execute)


class WebConnector(Connector):
    slug = "web"
    name = "Web"
    kinds = (
        ResourceKind(
            ACCOUNT_KIND,
            "Web search",
            ("search",),
            note="Searching sends the agent's query to Brave Search.",
        ),
        ResourceKind(
            SITE,
            "Site",
            ("read",),
            wildcard=True,
            hierarchical=True,
            listed=False,
            note=(
                "Search for a domain or paste an address to add it. An agent can send information to any "
                "site it may read, in the addresses it opens, so allow only sites you trust. A block on a "
                "domain wins over access to a wider one."
            ),
        ),
    )
    actions = (
        ActionSpec("search", "Search the web"),
        ActionSpec("read", "Read pages"),
    )
    auth = Builtin()

    operations = (
        Operation(
            name="search",
            title="Search the web",
            description=(
                "Search the web. Returns titles, addresses and short snippets, not page contents. To get "
                "more results, repeat the call with identical arguments plus the returned next_cursor."
            ),
            input_model=Search,
            needs=((ACCOUNT_KIND, "search"),),
            output_action="search",
            prepare=_prepare_search,
            paginated=True,
        ),
        Operation(
            name="read_page",
            title="Read a web page",
            description=(
                "Open a web page (http or https) and read it as text. Only sites you may read can be "
                "opened. A page that moves to another site returns redirect_to instead of content. Long "
                "pages are cut at max_chars; continue with offset set to the returned next_offset."
            ),
            input_model=ReadPage,
            needs=((SITE, "read"),),
            prepare=_prepare_read_page,
        ),
    )

    def offered(self, op: Operation) -> bool:
        return op.name != "search" or config().brave_search_api_key is not None

    def client(self, secret: str) -> WebClient:
        key = config().brave_search_api_key
        return WebClient(Fetcher(), BraveSearch(key.get_secret_value()) if key else None)

    async def account(self, client: WebClient) -> Account:
        return Account(id="web", label="Web")

    async def discover(
        self, client: WebClient, kind: str, *, query: str | None, cursor: str | None
    ) -> DiscoveryPage:
        if not query:
            return DiscoveryPage([])
        text = query.strip()
        # A pasted address, or a host name with or without a path.
        host = sites.parse_url(text).host if "://" in text else sites.canonical_host(text.split("/", 1)[0])
        return DiscoveryPage([DiscoveryItem(item, sites.name(item)) for item in sites.choices(host)])

    async def describe(self, client: WebClient, kind: str, ids: list[str]) -> dict[str, str]:
        return {resource_id: sites.name(resource_id) for resource_id in ids if sites.valid_id(resource_id)}
