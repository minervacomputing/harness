"""HubSpot's CRM API, at a pinned date version, so response shapes do not change under Minerva.

Responses are validated before use. HubSpot's errors carry a category: a token without a scope is
`MISSING_SCOPES` (403), and a write that would duplicate a unique value (a contact's email address) is a
conflict (409). HubSpot's own messages are never passed on, since they can quote record data.
"""

import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from connectors.base import OperationError
from connectors.http import ProviderHTTP

API_URL = "https://api.hubapi.com"
VERSION = "2026-09"
OBJECTS = f"/crm/objects/{VERSION}"
PIPELINES = f"/crm/pipelines/{VERSION}/deals"
# Record ids are positive integers; leading zeros are refused, so one record has one spelling.
RECORD_ID = re.compile(r"^[1-9][0-9]{0,19}$")
# Pipeline and stage ids: "default", built-in names such as "closedwon", or numbers.
PIPELINE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
# Search pages are numbered by offset; HubSpot returns at most 10,000 results for a search.
SEARCH_AFTER = re.compile(r"^(0|[1-9][0-9]{0,4})$")
MAX_SEARCH_RESULTS = 10_000
MAX_RESPONSE = 4 * 1024 * 1024
MAX_PIPELINES = 100
CONFLICT = "HubSpot refused this because it conflicts with an existing record."


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class Details(Model):
    portal_id: int
    portal_name: str | None = None
    ui_domain: str | None = None


class Record(Model):
    id: str
    properties: dict[str, str | None] = {}
    archived: bool = False


class Next(Model):
    after: str


class Paging(Model):
    next: Next | None = None


class SearchPage(Model):
    total: int = 0
    results: list[Record] = []
    paging: Paging | None = None


class Batch(Model):
    results: list[Record] = []


class Stage(Model):
    id: str
    label: str
    display_order: int = 0
    archived: bool = False
    metadata: dict[str, str | None] = {}


class Pipeline(Model):
    id: str
    label: str
    display_order: int = 0
    archived: bool = False
    stages: list[Stage] = []


class Pipelines(Model):
    results: list[Pipeline] = []


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    try:
        category = response.json().get("category")
    except ValueError, AttributeError:
        category = None
    if response.status_code == 403 and category == "MISSING_SCOPES":
        return OperationError(
            "PROVIDER_FORBIDDEN",
            "HubSpot did not give Minerva the access this needs. Reconnect HubSpot; if that does not help, "
            "the HubSpot app needs the scopes in Minerva's setup guide.",
        )
    if response.status_code == 409:
        return OperationError("PROVIDER_REJECTED", CONFLICT)
    return None


class HubSpotClient:
    def __init__(
        self, token: str, *, base_url: str = API_URL, transport: httpx.AsyncBaseTransport | None = None
    ):
        self._http = ProviderHTTP(
            "HubSpot",
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            transport=transport,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def _read[M: BaseModel](
        self, model: type[M], path: str, *, method: str = "GET", **kwargs: Any
    ) -> M:
        response = await self._http.bounded(
            path,
            method=method,
            limit=MAX_RESPONSE,
            too_large=OperationError("RESPONSE_TOO_LARGE", "HubSpot's response was too large to read."),
            **kwargs,
        )
        try:
            return model.model_validate_json(response.content)
        except ValueError as error:
            raise self.unexpected() from error

    def _checked(self, record: Record) -> Record:
        if not RECORD_ID.match(record.id):
            raise self.unexpected()
        return record

    async def details(self) -> Details:
        return await self._read(Details, f"/account-info/{VERSION}/details")

    async def record(self, object_type: str, record_id: str, properties: list[str]) -> Record:
        """One record. HubSpot answers for a record merged into another with the other, so the id
        returned can differ from the one asked for."""
        found = await self._read(
            Record, f"{OBJECTS}/{object_type}/{record_id}", params={"properties": ",".join(properties)}
        )
        return self._checked(found)

    async def search(self, object_type: str, body: dict[str, Any]) -> SearchPage:
        page = await self._read(SearchPage, f"{OBJECTS}/{object_type}/search", method="POST", json=body)
        for record in page.results:
            self._checked(record)
        return page

    async def batch(self, object_type: str, ids: list[str], properties: list[str]) -> list[Record]:
        """The records with these ids that exist; a read, though HubSpot takes it as a POST."""
        if not ids:
            return []
        found = await self._read(
            Batch,
            f"{OBJECTS}/{object_type}/batch/read",
            method="POST",
            json={"properties": properties, "inputs": [{"id": i} for i in ids]},
        )
        return [self._checked(record) for record in found.results]

    async def pipelines(self) -> list[Pipeline]:
        found = await self._read(Pipelines, PIPELINES)
        if len(found.results) > MAX_PIPELINES:
            raise OperationError("PROVIDER_LIMIT", "There are more deal pipelines than Minerva reads.")
        return [p for p in found.results if PIPELINE_ID.match(p.id)]

    async def pipeline(self, pipeline_id: str) -> Pipeline:
        found = await self._read(Pipeline, f"{PIPELINES}/{pipeline_id}")
        if found.id != pipeline_id:
            raise self.unexpected()
        return found

    async def create(
        self, object_type: str, properties: dict[str, str], associations: list[dict[str, Any]]
    ) -> Record:
        created = await self._http.parsed(
            Record,
            "POST",
            f"{OBJECTS}/{object_type}",
            json={"properties": properties, "associations": associations},
        )
        return self._checked(created)

    async def update(self, object_type: str, record_id: str, properties: dict[str, str]) -> Record:
        updated = await self._http.parsed(
            Record, "PATCH", f"{OBJECTS}/{object_type}/{record_id}", json={"properties": properties}
        )
        return self._checked(updated)


def association(type_id: int, record_id: str) -> dict[str, Any]:
    """An association made with a new record, of one of HubSpot's own types."""
    return {
        "to": {"id": record_id},
        "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": type_id}],
    }
