"""HubSpot's write operations: contacts, deals and notes.

A deal is created in a pipeline the agent names and may be associated with contacts and companies the
agent may read. A deal is edited only within its pipeline: a stage must belong to it, and a deal that moved
since it was authorized is refused. Notes are plain text, escaped into the HTML HubSpot stores, so a note
cannot link, embed or format anything. HubSpot may itself create and associate a company for a new
contact, from the domain of the contact's email address, when the account is set up that way.
"""

import html
import re
from datetime import UTC, date, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, Field, model_validator

from connectors.base import (
    Binding,
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
from connectors.hubspot.client import CONFLICT, HubSpotClient, Pipeline, association
from connectors.hubspot.scope import (
    CONTACT_PROPERTIES,
    CONTACTS,
    DEAL_PROPERTIES,
    DEALS,
    RECORD,
    CompanyId,
    ContactId,
    DealId,
    PipelineId,
    StageId,
    collection,
    company,
    contact,
    current_deal,
    deal,
    fetch_deal,
    pipeline,
    pipeline_of,
    record_data,
)
from connectors.text import plain_text, single_line

WRITE_NOTE = "The number of writes per run is limited."
MAX_ASSOCIATIONS = 10
MAX_NOTE = 5000
# HubSpot's own association types between a new record and an existing one.
DEAL_TO_CONTACT = 3
DEAL_TO_COMPANY = 341
NOTE_TO_CONTACT = 202
NOTE_TO_COMPANY = 190
NOTE_TO_DEAL = 214
_AMOUNT = re.compile(r"^[0-9]{1,13}(\.[0-9]{1,2})?$")


def _text(max_length: int, description: str):
    return Annotated[
        str, Field(min_length=1, max_length=max_length, description=description), AfterValidator(single_line)
    ]


def _amount(value: str) -> str:
    if not _AMOUNT.match(value):
        raise ValueError("must be a number such as 1500 or 1500.50, without a currency or separators")
    return value


def _date(value: str) -> str:
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError("must be a date such as 2026-12-31") from None
    if parsed.isoformat() != value:
        raise ValueError("must be a date such as 2026-12-31")
    return value


Email = _text(254, "An email address.")
Name = _text(100, "A first or last name.")
Phone = _text(50, "A phone number.")
CompanyName = _text(200, "A company name, as text; it does not associate a company record.")
JobTitle = _text(200, "A job title.")
DealName = _text(200, "The deal's name.")
Amount = Annotated[
    str,
    Field(
        max_length=16,
        description=(
            "The amount in the deal's currency (the account's currency for a new deal), such as 1500 "
            "or 1500.50."
        ),
    ),
    AfterValidator(_amount),
]
CloseDate = Annotated[
    str,
    Field(max_length=10, description="The expected close date, such as 2026-12-31."),
    AfterValidator(_date),
]


def _close_date(value: str) -> str:
    return f"{value}T00:00:00Z"


def _conflict(error: OperationError, message: str) -> OperationError:
    return OperationError(error.code, message) if error.message == CONFLICT else error


class ContactFields(OperationInput):
    firstname: Name | None = None
    lastname: Name | None = None
    phone: Phone | None = None
    company: CompanyName | None = None
    jobtitle: JobTitle | None = None

    def properties(self) -> dict[str, str]:
        return {
            name: value
            for name in ("email", "firstname", "lastname", "phone", "company", "jobtitle")
            if (value := getattr(self, name, None)) is not None
        }


class CreateContact(ContactFields):
    email: Email


async def _prepare_create_contact(binding: Binding, data: CreateContact) -> Prepared:
    async def execute() -> ProviderOutput:
        try:
            created = await binding.client.create(CONTACTS, data.properties(), [])
        except OperationError as error:
            raise _conflict(error, "A contact with this email address already exists.") from None
        return ProviderOutput(
            [ScopedRecord(contact(binding, created.id), record_data(created, CONTACT_PROPERTIES))]
        )

    return Prepared([Need(collection(binding, CONTACTS), "create")], execute)


CREATE_CONTACT = Operation(
    name="create_contact",
    title="Create a contact",
    description=(
        "Create a contact. Email addresses are unique: search_contacts finds an existing one. HubSpot may "
        f"also create and associate a company from the email address's domain. {WRITE_NOTE}"
    ),
    input_model=CreateContact,
    needs=((RECORD, "create"),),
    prepare=_prepare_create_contact,
    output_action="create",
    mutates=True,
)


class UpdateContact(ContactFields):
    contact_id: ContactId
    email: Email | None = None

    @model_validator(mode="after")
    def _changes(self) -> UpdateContact:
        if not self.properties():
            raise ValueError("give at least one field to change")
        return self


async def _prepare_update_contact(binding: Binding, data: UpdateContact) -> Prepared:
    async def execute() -> ProviderOutput:
        try:
            updated = await binding.client.update(CONTACTS, data.contact_id, data.properties())
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise _conflict(error, "Another contact already has this email address.") from None
        # HubSpot answers with the properties changed.
        changed = [name for name in CONTACT_PROPERTIES if name in updated.properties]
        return ProviderOutput([ScopedRecord(contact(binding, updated.id), record_data(updated, changed))])

    return Prepared([Need(contact(binding, data.contact_id), "edit")], execute)


UPDATE_CONTACT = Operation(
    name="update_contact",
    title="Update a contact",
    description=f"Change a contact's email address, name, phone, company name or job title. {WRITE_NOTE}",
    input_model=UpdateContact,
    needs=((RECORD, "edit"),),
    prepare=_prepare_update_contact,
    output_action="edit",
    mutates=True,
)


def _stage_in(found: Pipeline, stage_id: str) -> None:
    if not any(stage.id == stage_id and not stage.archived for stage in found.stages):
        raise OperationError("INVALID_STAGE", "This stage is not in the deal's pipeline. See list_pipelines.")


async def _open_pipeline(client: HubSpotClient, pipeline_id: str) -> Pipeline:
    try:
        found = await client.pipeline(pipeline_id)
    except OperationError as error:
        if error.code == "NOT_FOUND":
            raise denied() from None
        raise
    if found.archived:
        raise OperationError("PIPELINE_ARCHIVED", "This pipeline is archived. See list_pipelines.")
    return found


class CreateDeal(OperationInput):
    pipeline: PipelineId
    stage: StageId
    name: DealName
    amount: Amount | None = None
    close_date: CloseDate | None = None
    contact_ids: Annotated[
        list[ContactId],
        Field(max_length=MAX_ASSOCIATIONS, description="Contacts to associate with the deal."),
    ] = []
    company_ids: Annotated[
        list[CompanyId],
        Field(max_length=MAX_ASSOCIATIONS, description="Companies to associate with the deal."),
    ] = []


async def _prepare_create_deal(binding: Binding, data: CreateDeal) -> Prepared:
    client: HubSpotClient = binding.client
    target = pipeline(binding, data.pipeline)
    requirements: list[Requirement] = [Need(target, "read"), Need(target, "create")]
    contact_ids = list(dict.fromkeys(data.contact_ids))
    company_ids = list(dict.fromkeys(data.company_ids))
    requirements += [Need(contact(binding, i), "read") for i in contact_ids]
    requirements += [Need(company(binding, i), "read") for i in company_ids]

    async def execute() -> ProviderOutput:
        _stage_in(await _open_pipeline(client, data.pipeline), data.stage)
        properties = {"pipeline": data.pipeline, "dealstage": data.stage, "dealname": data.name}
        if data.amount is not None:
            properties["amount"] = data.amount
        if data.close_date is not None:
            properties["closedate"] = _close_date(data.close_date)
        associations = [association(DEAL_TO_CONTACT, i) for i in contact_ids]
        associations += [association(DEAL_TO_COMPANY, i) for i in company_ids]
        created = await client.create(DEALS, properties, associations)
        # The deal sits where HubSpot put it, if HubSpot said.
        placed = pipeline_of(client, created) if created.properties.get("pipeline") else data.pipeline
        return ProviderOutput(
            [ScopedRecord(deal(binding, placed, created.id), record_data(created, DEAL_PROPERTIES))]
        )

    return Prepared(requirements, execute)


CREATE_DEAL = Operation(
    name="create_deal",
    title="Create a deal",
    description=(
        "Create a deal in a pipeline and stage from list_pipelines, optionally associated with contacts "
        f"and companies. HubSpot workflows may act on new deals. {WRITE_NOTE}"
    ),
    input_model=CreateDeal,
    needs=((RECORD, "read"), (RECORD, "create")),
    prepare=_prepare_create_deal,
    output_action="create",
    mutates=True,
)


class UpdateDeal(OperationInput):
    deal_id: DealId
    name: DealName | None = None
    stage: Annotated[StageId | None, Field(description="A stage of the deal's own pipeline.")] = None
    amount: Amount | None = None
    close_date: CloseDate | None = None

    @model_validator(mode="after")
    def _changes(self) -> UpdateDeal:
        if self.name is None and self.stage is None and self.amount is None and self.close_date is None:
            raise ValueError("give at least one field to change")
        return self


async def _prepare_update_deal(binding: Binding, data: UpdateDeal) -> Prepared:
    client: HubSpotClient = binding.client
    found = await fetch_deal(client, data.deal_id)
    pipeline_id = pipeline_of(client, found)

    async def execute() -> ProviderOutput:
        await current_deal(client, found.id, pipeline_id)
        if data.stage is not None:
            _stage_in(await _open_pipeline(client, pipeline_id), data.stage)
        properties: dict[str, str] = {}
        if data.name is not None:
            properties["dealname"] = data.name
        if data.stage is not None:
            properties["dealstage"] = data.stage
        if data.amount is not None:
            properties["amount"] = data.amount
        if data.close_date is not None:
            properties["closedate"] = _close_date(data.close_date)
        try:
            updated = await client.update(DEALS, found.id, properties)
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise
        # HubSpot answers with the properties changed, and a workflow may have moved the deal meanwhile:
        # the deal is read again, and returned only if allowed where it now is.
        try:
            fresh = await fetch_deal(client, updated.id, DEAL_PROPERTIES)
        except OperationError:
            return ProviderOutput([])
        return ProviderOutput(
            [
                ScopedRecord(
                    deal(binding, pipeline_of(client, fresh), fresh.id), record_data(fresh, DEAL_PROPERTIES)
                )
            ]
        )

    return Prepared([Need(deal(binding, pipeline_id, found.id), "edit")], execute)


UPDATE_DEAL = Operation(
    name="update_deal",
    title="Update a deal",
    description=(
        "Change a deal's name, stage, amount or close date. The stage must be in the deal's own pipeline; "
        f"deals cannot be moved to another pipeline. HubSpot workflows may act on stage changes. {WRITE_NOTE}"
    ),
    input_model=UpdateDeal,
    needs=((RECORD, "edit"),),
    prepare=_prepare_update_deal,
    output_action="edit",
    mutates=True,
)


class AddNote(OperationInput):
    contact_id: Annotated[ContactId | None, Field(description="The contact to log the note on.")] = None
    company_id: Annotated[CompanyId | None, Field(description="The company to log the note on.")] = None
    deal_id: Annotated[DealId | None, Field(description="The deal to log the note on.")] = None
    body: Annotated[
        str,
        Field(min_length=1, max_length=MAX_NOTE, description="The note, as plain text."),
        AfterValidator(plain_text),
    ]

    @model_validator(mode="after")
    def _one_target(self) -> AddNote:
        if sum(value is not None for value in (self.contact_id, self.company_id, self.deal_id)) != 1:
            raise ValueError("give exactly one of contact_id, company_id and deal_id")
        return self


def note_html(body: str) -> str:
    """The note as HTML that only shows its text: escaped, with its line breaks kept."""
    return html.escape(body.replace("\r\n", "\n")).replace("\n", "<br>")


async def _prepare_add_note(binding: Binding, data: AddNote) -> Prepared:
    client: HubSpotClient = binding.client
    on_deal = None
    if data.contact_id is not None:
        target, link = contact(binding, data.contact_id), association(NOTE_TO_CONTACT, data.contact_id)
    elif data.company_id is not None:
        target, link = company(binding, data.company_id), association(NOTE_TO_COMPANY, data.company_id)
    else:
        assert data.deal_id is not None
        found = await fetch_deal(client, data.deal_id)
        on_deal = (found.id, pipeline_of(client, found))
        target, link = deal(binding, on_deal[1], found.id), association(NOTE_TO_DEAL, found.id)

    async def execute() -> ProviderOutput:
        if on_deal:
            await current_deal(client, *on_deal)
        timestamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            created = await client.create(
                "notes", {"hs_note_body": note_html(data.body), "hs_timestamp": timestamp}, [link]
            )
        except OperationError as error:
            if error.code == "NOT_FOUND":
                raise denied() from None
            raise
        record: dict[str, Any] = {"note_id": created.id, "logged_on": target.id}
        return ProviderOutput([ScopedRecord(target, record)])

    return Prepared([Need(target, "note")], execute)


ADD_NOTE = Operation(
    name="add_note",
    title="Log a note",
    description=(
        "Log a plain-text note on one contact, company or deal; it shows in the record's activity "
        f"timeline. {WRITE_NOTE}"
    ),
    input_model=AddNote,
    needs=((RECORD, "note"),),
    prepare=_prepare_add_note,
    output_action="note",
    mutates=True,
)
