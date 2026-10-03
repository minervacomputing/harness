"""HubSpot's read operations: contacts, companies, deal pipelines and deals.

Records carry no associated record ids. What is associated with what is found with a search filter, which
needs Read on both sides: contacts of a company need Read on the contacts and on the company. HubSpot pages
a search before Minerva filters it, so the place of allowed results would tell whether hidden ones match:
a deal search narrowed by anything but a pipeline needs Read on all deals, or names a pipeline. Deal searches
read the deals found again (a batch read), since HubSpot's search index lags behind changes and could still
place a deal in the pipeline it left; the records returned are the fresh ones.
"""

from typing import Annotated, Any

from pydantic import AfterValidator, Field

from connectors.base import (
    Binding,
    Enumerate,
    Need,
    Operation,
    OperationError,
    OperationInput,
    Prepared,
    ProviderOutput,
    Requirement,
    ScopedRecord,
    denied,
)
from connectors.hubspot.client import HubSpotClient, Pipeline, Record
from connectors.hubspot.scope import (
    COMPANIES,
    COMPANY_PROPERTIES,
    CONTACT_PROPERTIES,
    CONTACTS,
    DEAL_PROPERTIES,
    DEALS,
    RECORD,
    CompanyId,
    ContactId,
    Cursor,
    DealId,
    Limit,
    PipelineId,
    Query,
    StageId,
    after,
    collection,
    company,
    contact,
    current_deal,
    deal,
    equals,
    fetch_deal,
    following,
    pipeline,
    pipeline_of,
    record_data,
    search_body,
)
from connectors.text import single_line

PAGE_NOTE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor."
NEEDS_READ = ((RECORD, "read"),)


async def _deal_need(binding: Binding, deal_id: str) -> tuple[Requirement, str, str]:
    """Read on a deal the agent named, with the deal's pipeline and the id HubSpot answered with."""
    found = await fetch_deal(binding.client, deal_id)
    pipeline_id = pipeline_of(binding.client, found)
    return Need(deal(binding, pipeline_id, found.id), "read"), found.id, pipeline_id


async def _fetch(client: HubSpotClient, object_type: str, record_id: str, properties: list[str]) -> Record:
    try:
        return await client.record(object_type, record_id, properties)
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise denied() from None
        raise


class SearchContacts(OperationInput):
    query: Annotated[
        Query | None,
        Field(description="Words to find in names, email addresses, phone numbers and company names."),
    ] = None
    email: Annotated[
        str | None,
        Field(min_length=3, max_length=254, description="Only the contact with exactly this email address."),
        AfterValidator(single_line),
    ] = None
    company_id: Annotated[
        CompanyId | None, Field(description="Only contacts associated with this company.")
    ] = None
    deal_id: Annotated[DealId | None, Field(description="Only contacts associated with this deal.")] = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_search_contacts(binding: Binding, data: SearchContacts) -> Prepared:
    client: HubSpotClient = binding.client
    requirements: list[Requirement] = [Need(collection(binding, CONTACTS), "read")]
    filters = []
    if data.email:
        filters.append(equals("email", data.email))
    if data.company_id:
        requirements.append(Need(company(binding, data.company_id), "read"))
        filters.append(equals("associations.company", data.company_id))
    on_deal = None
    if data.deal_id:
        need, deal_id, pipeline_id = await _deal_need(binding, data.deal_id)
        requirements.append(need)
        filters.append(equals("associations.deal", deal_id))
        on_deal = (deal_id, pipeline_id)

    async def execute() -> ProviderOutput:
        if on_deal:
            await current_deal(client, *on_deal)
        body = search_body(
            query=data.query,
            filters=filters,
            properties=CONTACT_PROPERTIES,
            sort="lastmodifieddate",
            limit=data.limit,
            after=after(data.cursor, data.limit),
        )
        page = await client.search(CONTACTS, body)
        next_cursor, incomplete = following(client, page, data.limit)
        records = [
            ScopedRecord(contact(binding, found.id), record_data(found, CONTACT_PROPERTIES))
            for found in page.results
        ]
        return ProviderOutput(records, next_cursor, incomplete)

    return Prepared(requirements, execute)


SEARCH_CONTACTS = Operation(
    name="search_contacts",
    title="Search contacts",
    description=(
        "Search contacts, most recently changed first: by words, by exact email address, or by the company "
        "or deal they are associated with. HubSpot's search can lag a few seconds behind changes. "
        f"{PAGE_NOTE}"
    ),
    input_model=SearchContacts,
    needs=NEEDS_READ,
    prepare=_prepare_search_contacts,
    paginated=True,
)


class GetContact(OperationInput):
    contact_id: ContactId


async def _prepare_get_contact(binding: Binding, data: GetContact) -> Prepared:
    async def execute() -> ProviderOutput:
        found = await _fetch(binding.client, CONTACTS, data.contact_id, CONTACT_PROPERTIES)
        return ProviderOutput(
            [ScopedRecord(contact(binding, found.id), record_data(found, CONTACT_PROPERTIES))]
        )

    return Prepared([Need(contact(binding, data.contact_id), "read")], execute)


GET_CONTACT = Operation(
    name="get_contact",
    title="Get a contact",
    description=(
        "Get one contact. A contact merged into another is answered with the other, under its own id."
    ),
    input_model=GetContact,
    needs=NEEDS_READ,
    prepare=_prepare_get_contact,
)


class SearchCompanies(OperationInput):
    query: Annotated[
        Query | None, Field(description="Words to find in names, domains, websites and phone numbers.")
    ] = None
    domain: Annotated[
        str | None,
        Field(
            min_length=3,
            max_length=253,
            description="Only companies with exactly this domain, such as example.com.",
        ),
        AfterValidator(single_line),
    ] = None
    contact_id: Annotated[
        ContactId | None, Field(description="Only companies associated with this contact.")
    ] = None
    deal_id: Annotated[DealId | None, Field(description="Only companies associated with this deal.")] = None
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_search_companies(binding: Binding, data: SearchCompanies) -> Prepared:
    client: HubSpotClient = binding.client
    requirements: list[Requirement] = [Need(collection(binding, COMPANIES), "read")]
    filters = []
    if data.domain:
        filters.append(equals("domain", data.domain))
    if data.contact_id:
        requirements.append(Need(contact(binding, data.contact_id), "read"))
        filters.append(equals("associations.contact", data.contact_id))
    on_deal = None
    if data.deal_id:
        need, deal_id, pipeline_id = await _deal_need(binding, data.deal_id)
        requirements.append(need)
        filters.append(equals("associations.deal", deal_id))
        on_deal = (deal_id, pipeline_id)

    async def execute() -> ProviderOutput:
        if on_deal:
            await current_deal(client, *on_deal)
        body = search_body(
            query=data.query,
            filters=filters,
            properties=COMPANY_PROPERTIES,
            sort="hs_lastmodifieddate",
            limit=data.limit,
            after=after(data.cursor, data.limit),
        )
        page = await client.search(COMPANIES, body)
        next_cursor, incomplete = following(client, page, data.limit)
        records = [
            ScopedRecord(company(binding, found.id), record_data(found, COMPANY_PROPERTIES))
            for found in page.results
        ]
        return ProviderOutput(records, next_cursor, incomplete)

    return Prepared(requirements, execute)


SEARCH_COMPANIES = Operation(
    name="search_companies",
    title="Search companies",
    description=(
        "Search companies, most recently changed first: by words, by exact domain, or by the contact or "
        f"deal they are associated with. HubSpot's search can lag a few seconds behind changes. {PAGE_NOTE}"
    ),
    input_model=SearchCompanies,
    needs=NEEDS_READ,
    prepare=_prepare_search_companies,
    paginated=True,
)


class GetCompany(OperationInput):
    company_id: CompanyId


async def _prepare_get_company(binding: Binding, data: GetCompany) -> Prepared:
    async def execute() -> ProviderOutput:
        found = await _fetch(binding.client, COMPANIES, data.company_id, COMPANY_PROPERTIES)
        return ProviderOutput(
            [ScopedRecord(company(binding, found.id), record_data(found, COMPANY_PROPERTIES))]
        )

    return Prepared([Need(company(binding, data.company_id), "read")], execute)


GET_COMPANY = Operation(
    name="get_company",
    title="Get a company",
    description=(
        "Get one company. A company merged into another is answered with the other, under its own id."
    ),
    input_model=GetCompany,
    needs=NEEDS_READ,
    prepare=_prepare_get_company,
)


def pipeline_data(found: Pipeline) -> dict[str, Any]:
    stages = sorted((s for s in found.stages if not s.archived), key=lambda s: s.display_order)
    return {
        "id": found.id,
        "label": found.label,
        "stages": [
            {
                "id": stage.id,
                "label": stage.label,
                "probability": stage.metadata.get("probability"),
                "closed": stage.metadata.get("isClosed") == "true",
            }
            for stage in stages
        ],
    }


class ListPipelines(OperationInput):
    pass


async def _prepare_list_pipelines(binding: Binding, data: ListPipelines) -> Prepared:
    async def execute() -> ProviderOutput:
        found = await binding.client.pipelines()
        ordered = sorted((p for p in found if not p.archived), key=lambda p: p.display_order)
        return ProviderOutput([ScopedRecord(pipeline(binding, p.id), pipeline_data(p)) for p in ordered])

    return Prepared([Enumerate(RECORD, "read")], execute)


LIST_PIPELINES = Operation(
    name="list_pipelines",
    title="List deal pipelines",
    description="List the deal pipelines you may see, with their stages in order.",
    input_model=ListPipelines,
    needs=NEEDS_READ,
    prepare=_prepare_list_pipelines,
)


class SearchDeals(OperationInput):
    pipeline: Annotated[
        PipelineId | None,
        Field(
            description=(
                "Only deals in this pipeline. Searching by stage, words, contact or company needs a "
                "pipeline unless all deals may be read."
            )
        ),
    ] = None
    stage: Annotated[StageId | None, Field(description="Only deals in this stage.")] = None
    query: Annotated[
        Query | None, Field(description="Words to find in deal names, descriptions, stages and types.")
    ] = None
    contact_id: Annotated[ContactId | None, Field(description="Only deals associated with this contact.")] = (
        None
    )
    company_id: Annotated[CompanyId | None, Field(description="Only deals associated with this company.")] = (
        None
    )
    limit: Limit = 10
    cursor: Cursor | None = None


async def _prepare_search_deals(binding: Binding, data: SearchDeals) -> Prepared:
    client: HubSpotClient = binding.client
    filters = []
    requirements: list[Requirement] = []
    if data.pipeline:
        requirements.append(Need(pipeline(binding, data.pipeline), "read"))
        filters.append(equals("pipeline", data.pipeline))
    elif data.stage or data.query or data.contact_id or data.company_id:
        # HubSpot pages before Minerva filters, so which allowed deals come back where would tell whether
        # hidden deals match too. Across pipelines, a narrowed search needs Read on all deals.
        requirements.append(Need(collection(binding, DEALS), "read"))
    else:
        requirements.append(Enumerate(RECORD, "read"))
    if data.stage:
        filters.append(equals("dealstage", data.stage))
    if data.contact_id:
        requirements.append(Need(contact(binding, data.contact_id), "read"))
        filters.append(equals("associations.contact", data.contact_id))
    if data.company_id:
        requirements.append(Need(company(binding, data.company_id), "read"))
        filters.append(equals("associations.company", data.company_id))

    async def execute() -> ProviderOutput:
        body = search_body(
            query=data.query,
            filters=filters,
            properties=["pipeline"],
            sort="hs_lastmodifieddate",
            limit=data.limit,
            after=after(data.cursor, data.limit),
        )
        page = await client.search(DEALS, body)
        next_cursor, incomplete = following(client, page, data.limit)
        fresh = {d.id: d for d in await client.batch(DEALS, [d.id for d in page.results], DEAL_PROPERTIES)}
        records = [
            ScopedRecord(
                deal(binding, pipeline_of(client, fresh[found.id]), found.id),
                record_data(fresh[found.id], DEAL_PROPERTIES),
            )
            for found in page.results
            if found.id in fresh and not fresh[found.id].archived
        ]
        return ProviderOutput(records, next_cursor, incomplete)

    return Prepared(requirements, execute)


SEARCH_DEALS = Operation(
    name="search_deals",
    title="Search deals",
    description=(
        "Search deals, most recently changed first: by pipeline, stage, words, or the contact or company "
        "they are associated with. Stages are ids from list_pipelines. Without a pipeline, only a search "
        "with no other filter covers deals in single allowed pipelines. HubSpot's search can lag a few "
        f"seconds behind changes. {PAGE_NOTE}"
    ),
    input_model=SearchDeals,
    needs=NEEDS_READ,
    prepare=_prepare_search_deals,
    paginated=True,
)


class GetDeal(OperationInput):
    deal_id: DealId


async def _prepare_get_deal(binding: Binding, data: GetDeal) -> Prepared:
    need, deal_id, pipeline_id = await _deal_need(binding, data.deal_id)

    async def execute() -> ProviderOutput:
        found = await current_deal(binding.client, deal_id, pipeline_id, DEAL_PROPERTIES)
        return ProviderOutput(
            [ScopedRecord(deal(binding, pipeline_id, found.id), record_data(found, DEAL_PROPERTIES))]
        )

    return Prepared([need], execute)


GET_DEAL = Operation(
    name="get_deal",
    title="Get a deal",
    description="Get one deal: its pipeline, stage, amount, close date and description.",
    input_model=GetDeal,
    needs=NEEDS_READ,
    prepare=_prepare_get_deal,
)
