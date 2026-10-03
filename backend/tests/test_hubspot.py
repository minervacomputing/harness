"""HubSpot connector against an in-memory HubSpot CRM API, runs through the executor, and its tokens."""

import json

import httpx
import pytest
from connector_runs import FLOW, refusal

from connections import oauth as connection_oauth
from connectors import registry
from connectors.base import OperationError
from connectors.hubspot.client import HubSpotClient, classify
from connectors.hubspot.connector import SCOPES, HubSpotConnector
from connectors.hubspot.scope import after
from connectors.hubspot.writes import note_html

TOKEN = "hubspot-token"
SECRET = "SECRET merger"
PREFIX = "/crm/objects/2026-09/"
ADA, GRACE, MERGED = "101", "102", "103"
ACME, INITECH = "201", "202"
BIG, PARTNER, SMALL = "301", "302", "303"
SINGULAR = {"contact": "contacts", "company": "companies", "deal": "deals"}


def _stage(stage_id: str, order: int, archived: bool = False) -> dict:
    return {
        "id": stage_id,
        "label": stage_id.title(),
        "displayOrder": order,
        "archived": archived,
        "metadata": {"probability": "0.5", "isClosed": "true" if stage_id == "closedwon" else "false"},
    }


class FakeHubSpot:
    """HubSpot's CRM for one account, served through httpx.MockTransport.

    Pipelines: Sales ("default"), Partners ("200") and an archived one ("300"). Contacts Ada and Grace (and
    one merged into Ada), companies Acme and Initech, and deals Big and Small in Sales and Partner in
    Partners. Ada works at Acme; Big is associated with both, Partner with Grace.
    """

    def __init__(self) -> None:
        self.pipelines = {
            "default": {
                "id": "default",
                "label": "Sales",
                "displayOrder": 0,
                "archived": False,
                "stages": [_stage("qualified", 1), _stage("closedwon", 2), _stage("retired", 3, True)],
            },
            "200": {
                "id": "200",
                "label": "Partners",
                "displayOrder": 1,
                "archived": False,
                "stages": [_stage("signed", 1)],
            },
            "300": {"id": "300", "label": "Old", "displayOrder": 2, "archived": True, "stages": []},
        }
        self.records: dict[str, dict[str, dict]] = {
            "contacts": {
                ADA: {"email": "ada@example.com", "firstname": "Ada", "lastname": "Lovelace"},
                GRACE: {"email": "grace@example.com", "firstname": "Grace", "jobtitle": SECRET},
            },
            "companies": {
                ACME: {"name": "Acme", "domain": "acme.example", "description": "x" * 3000},
                INITECH: {"name": "Initech", "domain": "initech.example"},
            },
            "deals": {
                BIG: {"dealname": "Big", "pipeline": "default", "dealstage": "qualified", "amount": "9000"},
                PARTNER: {"dealname": SECRET, "pipeline": "200", "dealstage": "signed"},
                SMALL: {"dealname": "Small", "pipeline": "default", "dealstage": "closedwon"},
            },
            "notes": {},
        }
        self.merged = {("contacts", MERGED): ADA}
        self.associations = {
            frozenset({("deals", BIG), ("contacts", ADA)}),
            frozenset({("deals", BIG), ("companies", ACME)}),
            frozenset({("deals", PARTNER), ("contacts", GRACE)}),
            frozenset({("contacts", ADA), ("companies", ACME)}),
        }
        # Where the search index still places a deal, if not where it is.
        self.indexed: dict[str, str] = {}
        # A deal that moves to another pipeline once it has been read.
        self.moves: dict[str, str] = {}
        self.requests: list[httpx.Request] = []
        self.writes: list[tuple[str, str, dict]] = []
        self.hook = None
        self.next_id = 900

    @staticmethod
    def error(status: int, category: str) -> httpx.Response:
        return httpx.Response(status, json={"status": "error", "category": category, "message": SECRET})

    @staticmethod
    def _record(record_id: str, properties: dict, wanted: list[str]) -> dict:
        return {"id": record_id, "properties": {p: properties.get(p) for p in wanted}, "archived": False}

    def _matches(self, object_type: str, record_id: str, properties: dict, body: dict) -> bool:
        query = body.get("query", "").lower()
        if query and not any(query in str(v).lower() for v in properties.values()):
            return False
        for group in body.get("filterGroups", []):
            for f in group["filters"]:
                name, value = f["propertyName"], f["value"]
                if name.startswith("associations."):
                    other = SINGULAR[name.removeprefix("associations.")]
                    if frozenset({(object_type, record_id), (other, value)}) not in self.associations:
                        return False
                elif properties.get(name) != value:
                    return False
        return True

    def _search(self, object_type: str, body: dict) -> dict:
        found = []
        for record_id, properties in self.records[object_type].items():
            seen = dict(properties)
            if object_type == "deals" and record_id in self.indexed:
                seen["pipeline"] = self.indexed[record_id]
            if self._matches(object_type, record_id, seen, body):
                found.append(self._record(record_id, seen, body["properties"]))
        start, size = int(body.get("after", 0)), body["limit"]
        page: dict = {"total": len(found), "results": found[start : start + size]}
        if start + size < len(found):
            page["paging"] = {"next": {"after": str(start + size)}}
        return page

    def _get(self, object_type: str, record_id: str, wanted: list[str]) -> httpx.Response:
        record_id = self.merged.get((object_type, record_id), record_id)
        if record_id not in self.records[object_type]:
            return self.error(404, "OBJECT_NOT_FOUND")
        response = httpx.Response(
            200, json=self._record(record_id, self.records[object_type][record_id], wanted)
        )
        if object_type == "deals" and record_id in self.moves:
            self.records["deals"][record_id]["pipeline"] = self.moves.pop(record_id)
        return response

    def _write(self, method: str, path: str, body: dict) -> httpx.Response:
        self.writes.append((method, path, body))
        parts = path.removeprefix(PREFIX).split("/")
        object_type = parts[0]
        if method == "PATCH":
            record_id = self.merged.get((object_type, parts[1]), parts[1])
            if record_id not in self.records[object_type]:
                return self.error(404, "OBJECT_NOT_FOUND")
            if object_type == "contacts" and self._taken(body["properties"].get("email"), record_id):
                return self.error(409, "CONFLICT")
            self.records[object_type][record_id].update(body["properties"])
        else:
            if object_type == "contacts" and self._taken(body["properties"].get("email"), None):
                return self.error(409, "CONFLICT")
            self.next_id += 1
            record_id = str(self.next_id)
            self.records[object_type][record_id] = dict(body["properties"])
        # HubSpot answers an update with the properties it changed, and a creation with all it set.
        properties = self.records[object_type][record_id]
        return httpx.Response(200, json=self._record(record_id, properties, list(body["properties"])))

    def _taken(self, email: str | None, record_id: str | None) -> bool:
        return email is not None and any(
            c.get("email") == email and i != record_id for i, c in self.records["contacts"].items()
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers["Authorization"] != f"Bearer {TOKEN}":
            return self.error(401, "INVALID_AUTHENTICATION")
        if self.hook is not None and (response := self.hook(request)) is not None:
            return response
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if path == "/account-info/2026-09/details":
            return httpx.Response(200, json={"portalId": 4242, "portalName": "Acme Corp", "uiDomain": "x"})
        if path == "/crm/pipelines/2026-09/deals":
            return httpx.Response(200, json={"results": list(self.pipelines.values())})
        if path.startswith("/crm/pipelines/2026-09/deals/"):
            found = self.pipelines.get(path.rsplit("/", 1)[1])
            return httpx.Response(200, json=found) if found else self.error(404, "OBJECT_NOT_FOUND")
        assert path.startswith(PREFIX), path
        parts = path.removeprefix(PREFIX).split("/")
        match request.method, parts:
            case "POST", [object_type, "search"]:
                return httpx.Response(200, json=self._search(object_type, body))
            case "POST", [object_type, "batch", "read"]:
                found = [
                    self._record(i["id"], self.records[object_type][i["id"]], body["properties"])
                    for i in body["inputs"]
                    if i["id"] in self.records[object_type]
                ]
                return httpx.Response(200, json={"status": "COMPLETE", "results": found})
            case "GET", [object_type, record_id]:
                return self._get(object_type, record_id, request.url.params["properties"].split(","))
            case ("POST", [_]) | ("PATCH", [_, _]):
                return self._write(request.method, path, body)
        raise AssertionError(path)

    def client(self, token: str = TOKEN) -> HubSpotClient:
        return HubSpotClient(token, transport=httpx.MockTransport(self.handler))


@pytest.fixture
def hubspot(monkeypatch) -> FakeHubSpot:
    fake = FakeHubSpot()
    monkeypatch.setattr(HubSpotConnector, "client", lambda self, token: fake.client(token))
    return fake


@pytest.fixture
def start(connector_run, hubspot):
    def start_(grants: dict[tuple[str, str], tuple[str, ...]]):
        return connector_run(
            "hubspot",
            grants,
            scopes=SCOPES,
            access_token=TOKEN,
            label="Acme Corp (4242)",
            external_account_id="4242",
        )

    return start_


def record(resource: str, actions=("read",)) -> dict:
    return {("record", resource): actions}


def _items(outcome) -> list[dict]:
    return outcome.result["items"]


def _ids(outcome) -> list[str]:
    return [item["id"] for item in _items(outcome)]


def _searches(hubspot: FakeHubSpot, object_type: str) -> list[dict]:
    return [json.loads(r.content) for r in hubspot.requests if r.url.path == f"{PREFIX}{object_type}/search"]


# Client and connecting


def test_hubspot_errors_are_named_without_its_wording():
    missing = classify("HubSpot", FakeHubSpot.error(403, "MISSING_SCOPES"))
    assert missing.code == "PROVIDER_FORBIDDEN" and "Reconnect HubSpot" in missing.message
    conflict = classify("HubSpot", FakeHubSpot.error(409, "CONFLICT"))
    assert conflict.code == "PROVIDER_REJECTED"
    assert classify("HubSpot", FakeHubSpot.error(403, "FORBIDDEN")) is None
    assert classify("HubSpot", httpx.Response(409, text="<html>")).code == "PROVIDER_REJECTED"
    for error in (missing, conflict):
        assert SECRET not in error.message


def test_search_offsets_stop_where_hubspot_does():
    assert after(None, 10) is None
    assert after("9990", 10) == "9990"
    for value in ("9991", "010", "-1", "1e3", "abc", "100000"):
        with pytest.raises(OperationError) as caught:
            after(value, 10)
        assert caught.value.code == "INVALID_CURSOR"


def test_notes_only_show_their_text():
    assert (
        note_html('<a href="x">hi</a> & bye\r\nnext')
        == "&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt; &amp; bye<br>next"
    )


async def test_the_connection_is_the_hubspot_account(hubspot):
    connector = HubSpotConnector()
    account = await connector.account(hubspot.client())
    assert (account.id, account.label) == ("4242", "Acme Corp (4242)")
    with pytest.raises(OperationError) as caught:
        await connector.account(hubspot.client("other"))
    assert caught.value.code == "CONNECTION_UNAUTHORIZED"


def test_hubspot_tokens_carry_their_scopes(token_endpoint):
    sent, responses = token_endpoint
    responses.append(
        httpx.Response(
            200,
            json={
                "token_type": "bearer",
                "access_token": "a",
                "refresh_token": "r",
                "expires_in": 1800,
                "hub_id": 4242,
                "scopes": list(SCOPES),
            },
        )
    )
    tokens = connection_oauth.exchange_code(registry.get("hubspot"), code="c", flow=FLOW)
    assert tokens["scopes"] == sorted(SCOPES)
    [request] = sent
    assert request["url"] == "https://api.hubspot.com/oauth/2026-09/token"
    assert request["data"]["client_id"] == "id" and request["data"]["client_secret"] == "secret"


# Discovery


async def test_collections_and_pipelines_are_offered_but_never_single_records(hubspot):
    connector = HubSpotConnector()
    client = hubspot.client()
    page = await connector.discover(client, "record", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        ("contacts", "All contacts"),
        ("companies", "All companies"),
        ("deals", "All deals"),
        ("pipeline:default", "Deals in Sales"),
        ("pipeline:200", "Deals in Partners"),
    ]
    found = await connector.discover(client, "record", query="partn", cursor=None)
    assert [i.id for i in found.items] == ["pipeline:200"]
    described = await connector.describe(
        client, "record", ["deals", "pipeline:300", "pipeline:nope", f"contact:{ADA}", "deal:301", "*"]
    )
    assert described == {"deals": "All deals", "pipeline:300": "Deals in Old"}
    requests = len(hubspot.requests)
    assert await connector.describe(client, "record", ["contacts"]) == {"contacts": "All contacts"}
    assert len(hubspot.requests) == requests


# Reads


@pytest.mark.django_db(transaction=True)
async def test_contacts_and_companies_are_read_as_collections(start, hubspot):
    executor = await start(record("contacts"))
    contacts = _items(await executor.invoke("hubspot_search_contacts", {"query": "example.com"}))
    assert [c["id"] for c in contacts] == [ADA, GRACE]
    assert contacts[0]["email"] == "ada@example.com" and "mobilephone" in contacts[0]
    [search] = _searches(hubspot, "contacts")
    assert search["sorts"] == [{"propertyName": "lastmodifieddate", "direction": "DESCENDING"}]
    assert search["query"] == "example.com" and search["filterGroups"] == []
    by_email = await executor.invoke("hubspot_search_contacts", {"email": "grace@example.com"})
    assert _ids(by_email) == [GRACE]
    # A merged contact answers under the contact it was merged into.
    assert _ids(await executor.invoke("hubspot_get_contact", {"contact_id": MERGED})) == [ADA]
    assert await refusal(executor, "hubspot_get_contact", {"contact_id": "999"}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_get_contact", {"contact_id": "0101"}) == "INVALID_ARGUMENTS"
    assert await refusal(executor, "hubspot_search_companies", {}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_get_company", {"company_id": ACME}) == "POLICY_DENIED"

    executor = await start(record("companies"))
    acme = _items(await executor.invoke("hubspot_get_company", {"company_id": ACME}))[0]
    assert len(acme["description"]) == 2000 and acme["description_truncated"] is True
    assert await refusal(executor, "hubspot_get_contact", {"contact_id": ADA}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_association_filters_need_read_on_both_sides(start, hubspot):
    executor = await start(record("contacts"))
    assert await refusal(executor, "hubspot_search_contacts", {"company_id": ACME}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_search_contacts", {"deal_id": BIG}) == "POLICY_DENIED"
    executor = await start({**record("contacts"), **record("companies"), **record("pipeline:default")})
    assert _ids(await executor.invoke("hubspot_search_contacts", {"company_id": ACME})) == [ADA]
    assert _ids(await executor.invoke("hubspot_search_contacts", {"deal_id": BIG})) == [ADA]
    assert _searches(hubspot, "contacts")[-1]["filterGroups"] == [
        {"filters": [{"propertyName": "associations.deal", "operator": "EQ", "value": BIG}]}
    ]
    assert _ids(await executor.invoke("hubspot_search_companies", {"contact_id": ADA})) == [ACME]
    # A deal in a pipeline that is not allowed is refused like one that does not exist.
    assert await refusal(executor, "hubspot_search_contacts", {"deal_id": PARTNER}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_search_contacts", {"deal_id": "999"}) == "POLICY_DENIED"
    assert _ids(
        await executor.invoke("hubspot_search_deals", {"pipeline": "default", "company_id": ACME})
    ) == [BIG]
    assert _ids(await executor.invoke("hubspot_search_companies", {"deal_id": BIG})) == [ACME]


@pytest.mark.django_db(transaction=True)
async def test_a_pipeline_grant_shows_only_its_deals(start, hubspot):
    executor = await start(record("pipeline:default"))
    listed = _items(await executor.invoke("hubspot_list_pipelines", {}))
    assert [p["id"] for p in listed] == ["default"]
    assert [s["id"] for s in listed[0]["stages"]] == ["qualified", "closedwon"]
    assert listed[0]["stages"][1]["closed"] is True
    assert _ids(await executor.invoke("hubspot_search_deals", {})) == [BIG, SMALL]
    assert _ids(await executor.invoke("hubspot_search_deals", {"pipeline": "default"})) == [BIG, SMALL]
    assert await refusal(executor, "hubspot_search_deals", {"pipeline": "200"}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_get_deal", {"deal_id": PARTNER}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_get_deal", {"deal_id": "999"}) == "POLICY_DENIED"
    big = _items(await executor.invoke("hubspot_get_deal", {"deal_id": BIG}))[0]
    assert big["dealname"] == "Big" and big["amount"] == "9000"
    assert await refusal(executor, "hubspot_search_contacts", {}) == "POLICY_DENIED"
    # Narrowed across pipelines, where allowed deals land would tell whether hidden ones match.
    for narrowed in ({"query": "Big"}, {"stage": "signed"}, {"contact_id": GRACE}):
        assert await refusal(executor, "hubspot_search_deals", narrowed) == "POLICY_DENIED"
    assert _ids(await executor.invoke("hubspot_search_deals", {"pipeline": "default", "query": "Big"})) == [
        BIG
    ]

    # The search index still places Partner in Sales; the deal read again is in Partners.
    hubspot.indexed[PARTNER] = "default"
    assert _ids(await executor.invoke("hubspot_search_deals", {"pipeline": "default"})) == [BIG, SMALL]
    assert SECRET not in json.dumps(_items(await executor.invoke("hubspot_search_deals", {})))


@pytest.mark.django_db(transaction=True)
async def test_deal_searches_page_unless_a_hidden_deal_could_be_hinted_at(start, hubspot):
    executor = await start(record("deals"))
    first = await executor.invoke("hubspot_search_deals", {"pipeline": "default", "limit": 1})
    assert _ids(first) == [BIG]
    cursor = first.result["next_cursor"]
    assert cursor != "1"
    second = await executor.invoke(
        "hubspot_search_deals", {"pipeline": "default", "limit": 1, "cursor": cursor}
    )
    assert _ids(second) == [SMALL] and "next_cursor" not in second.result
    assert [s.get("after") for s in _searches(hubspot, "deals")] == [None, "1"]
    narrowed = await executor.invoke("hubspot_search_deals", {"query": "a", "limit": 1})
    assert len(_ids(narrowed)) == 1 and "next_cursor" in narrowed.result
    assert "next_cursor" in (await executor.invoke("hubspot_search_deals", {"limit": 1})).result

    hubspot.hook = lambda request: (
        httpx.Response(200, json={"total": 20000, "results": [], "paging": {"next": {"after": "9995"}}})
        if request.url.path.endswith("/search")
        else None
    )
    stopped = await executor.invoke("hubspot_search_deals", {"pipeline": "default", "limit": 10})
    assert stopped.result.get("incomplete") is True and "next_cursor" not in stopped.result


# Writes


@pytest.mark.django_db(transaction=True)
async def test_contacts_are_created_and_edited(start, hubspot):
    # Creating deals offers the tool, but not on contacts.
    executor = await start({**record("contacts"), **record("deals", ("read", "create"))})
    assert await refusal(executor, "hubspot_create_contact", {"email": "new@example.com"}) == "POLICY_DENIED"
    executor = await start(record("contacts", ("read", "create", "edit")))
    created = _items(
        await executor.invoke("hubspot_create_contact", {"email": "new@example.com", "firstname": "Nia"})
    )
    assert created[0]["email"] == "new@example.com"
    assert hubspot.writes[-1] == (
        "POST",
        f"{PREFIX}contacts",
        {"properties": {"email": "new@example.com", "firstname": "Nia"}, "associations": []},
    )
    with pytest.raises(OperationError) as caught:
        await executor.invoke("hubspot_create_contact", {"email": "ada@example.com"})
    assert caught.value.code == "PROVIDER_REJECTED" and "already exists" in caught.value.message
    assert await refusal(executor, "hubspot_update_contact", {"contact_id": ADA}) == "INVALID_ARGUMENTS"
    edited = await executor.invoke("hubspot_update_contact", {"contact_id": ADA, "jobtitle": "Analyst"})
    assert _items(edited) == [{"id": ADA, "jobtitle": "Analyst"}]
    assert hubspot.records["contacts"][ADA]["jobtitle"] == "Analyst"
    assert await refusal(executor, "hubspot_update_contact", {"contact_id": "999", "phone": "1"}) == (
        "POLICY_DENIED"
    )


@pytest.mark.django_db(transaction=True)
async def test_deals_are_created_in_an_allowed_pipeline_with_readable_associations(start, hubspot):
    executor = await start({**record("pipeline:default", ("read", "create")), **record("contacts")})
    args = {"pipeline": "default", "stage": "qualified", "name": "New", "amount": "1500.50"}
    assert await refusal(executor, "hubspot_create_deal", {**args, "company_ids": [ACME]}) == "POLICY_DENIED"
    assert await refusal(executor, "hubspot_create_deal", {**args, "pipeline": "200", "stage": "signed"}) == (
        "POLICY_DENIED"
    )
    assert await refusal(executor, "hubspot_create_deal", {**args, "stage": "retired"}) == "INVALID_STAGE"
    assert await refusal(executor, "hubspot_create_deal", {**args, "stage": "signed"}) == "INVALID_STAGE"
    assert await refusal(executor, "hubspot_create_deal", {**args, "amount": "1,500"}) == "INVALID_ARGUMENTS"
    assert await refusal(executor, "hubspot_create_deal", {**args, "close_date": "2026-2-1"}) == (
        "INVALID_ARGUMENTS"
    )
    assert hubspot.writes == []
    created = await executor.invoke(
        "hubspot_create_deal", {**args, "close_date": "2026-12-31", "contact_ids": [ADA, ADA]}
    )
    assert _items(created)[0]["dealname"] == "New"
    [(method, path, body)] = hubspot.writes
    assert (method, path) == ("POST", f"{PREFIX}deals")
    assert body["properties"] == {
        "pipeline": "default",
        "dealstage": "qualified",
        "dealname": "New",
        "amount": "1500.50",
        "closedate": "2026-12-31T00:00:00Z",
    }
    assert body["associations"] == [
        {"to": {"id": ADA}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 3}]}
    ]

    executor = await start({**record("deals", ("read", "create")), **record("companies")})
    await executor.invoke("hubspot_create_deal", {**args, "company_ids": [ACME]})
    assert hubspot.writes[-1][2]["associations"][0]["types"][0]["associationTypeId"] == 341


@pytest.mark.django_db(transaction=True)
async def test_deals_are_edited_within_their_pipeline(start, hubspot):
    executor = await start(record("pipeline:default", ("read", "edit")))
    assert (
        await refusal(executor, "hubspot_update_deal", {"deal_id": PARTNER, "name": "x"}) == "POLICY_DENIED"
    )
    assert (
        await refusal(executor, "hubspot_update_deal", {"deal_id": BIG, "stage": "signed"}) == "INVALID_STAGE"
    )
    assert hubspot.writes == []
    await executor.invoke("hubspot_update_deal", {"deal_id": BIG, "stage": "closedwon", "amount": "10"})
    assert hubspot.writes[-1] == (
        "PATCH",
        f"{PREFIX}deals/{BIG}",
        {"properties": {"dealstage": "closedwon", "amount": "10"}},
    )

    # A workflow moves the deal to Partners as it is changed: it is not returned.
    def workflow(request):
        if request.method == "PATCH":
            hubspot.records["deals"][BIG]["pipeline"] = "200"

    hubspot.hook = workflow
    assert _items(await executor.invoke("hubspot_update_deal", {"deal_id": BIG, "name": "Renamed"})) == []
    hubspot.hook = None
    # The deal moves to Partners after it was authorized in Sales.
    hubspot.moves[SMALL] = "200"
    assert await refusal(executor, "hubspot_update_deal", {"deal_id": SMALL, "name": "x"}) == "DEAL_MOVED"
    assert len(hubspot.writes) == 2


@pytest.mark.django_db(transaction=True)
async def test_notes_are_logged_as_text_on_one_allowed_record(start, hubspot):
    executor = await start(
        {**record("contacts", ("read", "note")), **record("pipeline:default", ("read", "note"))}
    )
    assert await refusal(executor, "hubspot_add_note", {"body": "hi"}) == "INVALID_ARGUMENTS"
    assert await refusal(executor, "hubspot_add_note", {"contact_id": ADA, "deal_id": BIG, "body": "hi"}) == (
        "INVALID_ARGUMENTS"
    )
    assert await refusal(executor, "hubspot_add_note", {"company_id": ACME, "body": "hi"}) == "POLICY_DENIED"
    logged = await executor.invoke("hubspot_add_note", {"contact_id": ADA, "body": "<b>Call</b>\nback"})
    assert _items(logged)[0]["logged_on"] == f"contact:{ADA}"
    method, path, body = hubspot.writes[-1]
    assert (method, path) == ("POST", f"{PREFIX}notes")
    assert body["properties"]["hs_note_body"] == "&lt;b&gt;Call&lt;/b&gt;<br>back"
    assert body["properties"]["hs_timestamp"].endswith("Z")
    assert body["associations"][0]["types"][0]["associationTypeId"] == 202
    await executor.invoke("hubspot_add_note", {"deal_id": BIG, "body": "Signed"})
    assert hubspot.writes[-1][2]["associations"][0] == {
        "to": {"id": BIG},
        "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 214}],
    }
    hubspot.moves[SMALL] = "200"
    assert await refusal(executor, "hubspot_add_note", {"deal_id": SMALL, "body": "x"}) == "DEAL_MOVED"
    assert len(hubspot.writes) == 2
