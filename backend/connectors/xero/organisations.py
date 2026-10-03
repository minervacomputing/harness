"""What Xero's operations share: organisations, how calls name them, and how records show money."""

from decimal import Decimal
from typing import Annotated

from pydantic import AfterValidator, Field

from connectors.base import Binding, OperationError, Resource, denied
from connectors.text import truncate
from connectors.xero.client import UUID, Connection, XeroClient, uuid

ORGANISATION = "organisation"
MAX_SHORT = 500


def _uuid(value: str) -> str:
    lowered = value.lower()
    if not UUID.match(lowered):
        raise ValueError("must be an id from Xero, such as 4f2a3c1e-0b6d-4e8a-9c1f-2a7b5d3e6f80")
    return lowered


OrganisationId = Annotated[
    str,
    Field(
        min_length=36,
        max_length=36,
        description="An organisation's id, from list_organisations. Optional when the connection reaches one.",
    ),
    AfterValidator(_uuid),
]
ContactId = Annotated[
    str,
    Field(min_length=36, max_length=36, description="A contact's id, from search_contacts."),
    AfterValidator(_uuid),
]
InvoiceId = Annotated[
    str,
    Field(min_length=36, max_length=36, description="An invoice's or bill's id, from search_invoices."),
    AfterValidator(_uuid),
]


def label(organisation: Connection) -> str:
    return short(organisation.tenantName) or f"Organisation {organisation.tenantId[:8]}"


def organisation_resource(binding: Binding, tenant: str) -> Resource:
    if uuid(tenant) != tenant:
        raise binding.client.unexpected()
    return binding.resource(ORGANISATION, tenant)


async def resolve_organisation(binding: Binding, tenant: str | None) -> tuple[Resource, str]:
    """The organisation a call names, or the only one the connection reaches. One it does not reach is refused
    like one without a grant. Nothing is read from an organisation before the executor authorizes it."""
    client: XeroClient = binding.client
    organisations = await client.organisations()
    if tenant is None:
        if len(organisations) != 1:
            raise OperationError(
                "INVALID_ARGUMENTS",
                f"This connection reaches {len(organisations)} Xero organisations; name one with organisation.",
            )
        tenant = organisations[0].tenantId
    elif tenant not in {organisation.tenantId for organisation in organisations}:
        raise denied()
    return organisation_resource(binding, tenant), tenant


def short(value: str | None, limit: int = MAX_SHORT) -> str | None:
    shown, _ = truncate(" ".join(value.split()) if value else None, limit)
    return shown or None


def money(value: Decimal | None) -> str | None:
    """An amount as a decimal string, as precise as Xero gave it, with at least two places."""
    if value is None or not value.is_finite():
        return None
    return f"{value:.2f}" if value == value.quantize(Decimal("0.01")) else f"{value.normalize():f}"


def number(value: Decimal | None) -> str | None:
    """A quantity or rate as a decimal string, without trailing zeros."""
    if value is None or not value.is_finite():
        return None
    shown = f"{value.normalize():f}"
    return "0" if shown in {"-0", "0"} else shown
