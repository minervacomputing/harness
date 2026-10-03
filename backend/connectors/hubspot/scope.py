"""What HubSpot's operations share: the kind, where records sit, ids, and deals checked again.

Records are one hierarchical kind. Contacts sit inside `contacts`, companies inside `companies`, and deals
inside their pipeline, inside `deals`. Users choose among the collections and the pipelines, never single
contacts or companies: HubSpot answers for a merged record under the id of the record it was merged into,
so a grant on one contact could reach another, while every contact stays inside `contacts`. A deal can
move between pipelines, so its pipeline is read again just before a deal is read or written, and a deal
that moved is refused (`DEAL_MOVED`).
"""

from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError, denied
from connectors.hubspot.client import (
    MAX_SEARCH_RESULTS,
    PIPELINE_ID,
    RECORD_ID,
    SEARCH_AFTER,
    HubSpotClient,
    Record,
    SearchPage,
)
from connectors.text import single_line, truncate
from permissions.policy import Resource

RECORD = "record"
CONTACTS = "contacts"
COMPANIES = "companies"
DEALS = "deals"
COLLECTIONS = {CONTACTS: "All contacts", COMPANIES: "All companies", DEALS: "All deals"}
PIPELINE_PREFIX = "pipeline:"

CONTACT_PROPERTIES = [
    "email",
    "firstname",
    "lastname",
    "phone",
    "mobilephone",
    "company",
    "jobtitle",
    "city",
    "country",
    "lifecyclestage",
    "createdate",
    "lastmodifieddate",
]
COMPANY_PROPERTIES = [
    "name",
    "domain",
    "industry",
    "phone",
    "city",
    "country",
    "numberofemployees",
    "annualrevenue",
    "lifecyclestage",
    "description",
    "createdate",
    "hs_lastmodifieddate",
]
DEAL_PROPERTIES = [
    "dealname",
    "pipeline",
    "dealstage",
    "amount",
    "deal_currency_code",
    "closedate",
    "dealtype",
    "description",
    "hs_is_closed",
    "hs_is_closed_won",
    "createdate",
    "hs_lastmodifieddate",
]
MAX_TEXT = 500
MAX_DESCRIPTION = 2000


def _matching(pattern, message: str):
    def check(value: str) -> str:
        if not pattern.match(value):
            raise ValueError(message)
        return value

    return check


def _record_id(what: str, source: str):
    return Annotated[
        str,
        Field(min_length=1, max_length=20, description=f"A {what} id from {source}, such as 1234."),
        AfterValidator(_matching(RECORD_ID, f"must be a {what} id from {source}")),
    ]


ContactId = _record_id("contact", "search_contacts")
CompanyId = _record_id("company", "search_companies")
DealId = _record_id("deal", "search_deals")
PipelineId = Annotated[
    str,
    Field(min_length=1, max_length=100, description="A deal pipeline id from list_pipelines."),
    AfterValidator(_matching(PIPELINE_ID, "must be a pipeline id from list_pipelines")),
]
StageId = Annotated[
    str,
    Field(min_length=1, max_length=100, description="A deal stage id from list_pipelines."),
    AfterValidator(_matching(PIPELINE_ID, "must be a stage id from list_pipelines")),
]
Query = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(single_line)]
Limit = Annotated[int, Field(ge=1, le=50)]
# The run's own page token; the executor swaps it for HubSpot's before the call is prepared.
Cursor = Annotated[str, Field(max_length=200)]


def collection(binding: Binding, name: str) -> Resource:
    return binding.resource(RECORD, name)


def contact(binding: Binding, contact_id: str) -> Resource:
    return binding.resource(RECORD, f"contact:{contact_id}", (CONTACTS,))


def company(binding: Binding, company_id: str) -> Resource:
    return binding.resource(RECORD, f"company:{company_id}", (COMPANIES,))


def pipeline(binding: Binding, pipeline_id: str) -> Resource:
    return binding.resource(RECORD, f"{PIPELINE_PREFIX}{pipeline_id}", (DEALS,))


def deal(binding: Binding, pipeline_id: str, deal_id: str) -> Resource:
    return binding.resource(RECORD, f"deal:{deal_id}", (f"{PIPELINE_PREFIX}{pipeline_id}", DEALS))


def pipeline_of(client: HubSpotClient, found: Record) -> str:
    value = found.properties.get("pipeline")
    if not value or not PIPELINE_ID.match(value):
        raise client.unexpected()
    return value


async def fetch_deal(client: HubSpotClient, deal_id: str, properties: list[str] | None = None) -> Record:
    """A deal named by the agent; one HubSpot does not have is refused like one not allowed."""
    try:
        return await client.record(DEALS, deal_id, properties or ["pipeline"])
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise denied() from None
        raise


async def current_deal(
    client: HubSpotClient, deal_id: str, pipeline_id: str, properties: list[str] | None = None
) -> Record:
    """The deal again, refused if it moved to another pipeline since it was authorized."""
    found = await fetch_deal(client, deal_id, properties)
    if found.id != deal_id or pipeline_of(client, found) != pipeline_id:
        raise OperationError(
            "DEAL_MOVED", "The deal moved to another pipeline while this was being checked. Try again."
        )
    return found


def record_data(found: Record, properties: list[str]) -> dict[str, Any]:
    data: dict[str, Any] = {"id": found.id}
    for name in properties:
        limit = MAX_DESCRIPTION if name == "description" else MAX_TEXT
        data[name], cut = truncate(found.properties.get(name), limit)
        if cut:
            data[f"{name}_truncated"] = True
    return data


def after(value: str | None, limit: int) -> str | None:
    """HubSpot's offset for the next search page, from a page token the executor resolved."""
    if value is None:
        return None
    if not SEARCH_AFTER.match(value) or int(value) + limit > MAX_SEARCH_RESULTS:
        raise OperationError("INVALID_CURSOR", "This cursor is not valid.")
    return value


def following(client: HubSpotClient, page: SearchPage, limit: int) -> tuple[str | None, bool]:
    """The next page's offset, and whether results were left out because a search stops at 10,000."""
    offset = page.paging.next.after if page.paging and page.paging.next else None
    if offset is None:
        return None, False
    if not SEARCH_AFTER.match(offset):
        raise client.unexpected()
    if int(offset) + limit > MAX_SEARCH_RESULTS:
        return None, True
    return offset, False


def search_body(
    *,
    query: str | None,
    filters: list[dict[str, str]],
    properties: list[str],
    sort: str,
    limit: int,
    after: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "limit": limit,
        "properties": properties,
        "sorts": [{"propertyName": sort, "direction": "DESCENDING"}],
        "filterGroups": [{"filters": filters}] if filters else [],
    }
    if query:
        body["query"] = query
    if after:
        body["after"] = after
    return body


def equals(name: str, value: str) -> dict[str, str]:
    return {"propertyName": name, "operator": "EQ", "value": value}
