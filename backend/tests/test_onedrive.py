"""OneDrive and SharePoint connector against an in-memory Microsoft Graph, and runs through the executor."""

import io
import json
import tracemalloc
import zipfile

import httpx
import pytest
from connector_runs import ceiling, refusal

from connectors.base import OperationError
from connectors.onedrive import connector as onedrive_module
from connectors.onedrive import office
from connectors.onedrive.client import DriveClient, download_allowed
from connectors.onedrive.connector import OneDriveConnector
from permissions.models import Grant

USER_ID = "00000000-0000-0000-0000-00000000b0b0"
ME, TEAM, OTHER = "b!me", "b!team", "b!other"
PERSONAL = "ABCDEF0123456789"
SITE = "contoso.sharepoint.com,1111,2222"
READ_SCOPES = ["Files.Read.All", "Sites.Read.All", "User.Read", "openid", "profile"]
WRITE_SCOPES = ["Files.ReadWrite.All", "Sites.Read.All", "User.Read", "openid", "profile"]

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _zip(parts: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _rels(*relationships: tuple[str, str, str], external: str | None = None) -> str:
    items = "".join(
        f'<Relationship Id="{i}" Type="{R}/{t}" Target="{target}"/>' for i, t, target in relationships
    )
    if external:
        items += f'<Relationship Id="ext" Type="{R}/hyperlink" Target="{external}" TargetMode="External"/>'
    return f'<Relationships xmlns="{PACKAGE}">{items}</Relationships>'


def _docx(body: str) -> bytes:
    return _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "word/document.xml")),
            "word/document.xml": f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>',
        }
    )


def _slide(text: str) -> str:
    return (
        f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody>'
        f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
    )


def _pptx() -> bytes:
    return _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "ppt/presentation.xml")),
            "ppt/presentation.xml": (
                f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>'
                '<p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'
            ),
            "ppt/_rels/presentation.xml.rels": _rels(
                ("rId2", "slide", "slides/slide1.xml"), ("rId3", "slide", "slides/slide2.xml")
            ),
            "ppt/slides/slide1.xml": _slide("Title"),
            "ppt/slides/slide2.xml": _slide("Agenda"),
        }
    )


def _xlsx() -> bytes:
    return _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "xl/workbook.xml")),
            "xl/workbook.xml": (
                f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Summary" sheetId="2" r:id="rId2"/>'
                '<sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
            ),
            "xl/_rels/workbook.xml.rels": _rels(
                ("rId1", "worksheet", "worksheets/sheet1.xml"),
                ("rId2", "worksheet", "worksheets/sheet2.xml"),
                ("rId3", "sharedStrings", "sharedStrings.xml"),
                external="https://example.com/x",
            ),
            "xl/sharedStrings.xml": (
                f'<sst xmlns="{S}"><si><t>Name</t></si><si><r><t>Ad</t></r><r><t>a</t></r>'
                "<rPh><t>reading</t></rPh></si></sst>"
            ),
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1"><v>9</v></c>'
            "</row></sheetData></worksheet>",
            "xl/worksheets/sheet2.xml": (
                f'<worksheet xmlns="{S}"><sheetData>'
                '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>a,b</t></is></c></row>'
                '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>40+2</f><v>42</v></c>'
                '<c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>'
            ),
        }
    )


def _item(item_id: str, name: str, drive: str, parent: str | None, **extra) -> dict:
    data = {
        "id": item_id,
        "name": name,
        "parentReference": {"driveId": drive},
        "webUrl": f"https://x/{item_id}",
    }
    if parent is not None:
        data["parentReference"]["id"] = parent
    return data | extra


def _folder(item_id: str, name: str, drive: str, parent: str | None) -> dict:
    return _item(item_id, name, drive, parent, folder={"childCount": 0})


def _file(item_id: str, name: str, drive: str, parent: str, mime: str = "text/plain") -> dict:
    return _item(item_id, name, drive, parent, file={"mimeType": mime}, size=10)


class FakeGraph:
    """Microsoft Graph's OneDrive and SharePoint API, and a file host, served through httpx.MockTransport.

    My OneDrive: Docs/ (Projects/ (plan.txt), report.docx, deck.pptx, sheet.xlsx), Private/ (diary.txt) and a
    link to a folder another user shared. That user's folder (Shared/ with notes.txt) sits in a folder the
    account cannot open. The SharePoint site "Sales" the account follows has the library "Documents"
    (Wiki/ with handbook.md). With `personal`, my OneDrive is a personal account's, with a hexadecimal id.
    """

    def __init__(self, personal: bool = False) -> None:
        me = PERSONAL if personal else ME
        self.me = me
        self.drives = {
            me: {"id": me, "name": "OneDrive", "driveType": "personal" if personal else "business"},
            TEAM: {"id": TEAM, "name": "Documents", "driveType": "documentLibrary"},
            OTHER: {"id": OTHER, "name": "OneDrive", "driveType": "business"},
        }
        items = [
            _item("root-me", "root", me, None, root={}, folder={"childCount": 3}),
            _folder("docs", "Docs", me, "root-me"),
            _folder("projects", "Projects", me, "docs"),
            _file("plan", "plan.txt", me, "projects"),
            _file("report", "report.docx", me, "docs", DOCX),
            _file("deck", "deck.pptx", me, "docs", PPTX),
            _file("sheet", "sheet.xlsx", me, "docs", XLSX),
            _folder("private", "Private", me, "root-me"),
            _file("diary", "diary.txt", me, "private"),
            _item(
                "link",
                "Shared",
                me,
                "root-me",
                remoteItem={"id": "shared", "parentReference": {"driveId": OTHER}},
            ),
            _item("root-team", "root", TEAM, None, root={}, folder={"childCount": 1}),
            _folder("wiki", "Wiki", TEAM, "root-team"),
            _file("handbook", "handbook.md", TEAM, "wiki", "application/octet-stream"),
            _folder("shared", "Shared", OTHER, "ghost"),
            _file("notes", "notes.txt", OTHER, "shared"),
        ]
        self.items = {(item["parentReference"]["driveId"].lower(), item["id"]): item for item in items}
        self.forbidden = {(OTHER.lower(), "ghost")}
        self.contents: dict[str, bytes] = {
            "plan": b"\xef\xbb\xbfThe plan.",
            "report": _docx("<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>"),
            "deck": _pptx(),
            "sheet": _xlsx(),
            "diary": b"Dear diary.",
            "handbook": b"# Handbook",
            "notes": b"Shared notes.",
        }
        self.download_host = "contoso.sharepoint.com"
        self.personal = personal
        self.page_size: int | None = None
        self.requests: list[httpx.Request] = []
        self.uploads: list[httpx.Request] = []
        self.searches: list[dict] = []
        self.hook = None

    @staticmethod
    def _error(status: int, code: str) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": code, "message": "Secret item name"}})

    def _find(self, drive: str, item_id: str) -> dict | None:
        return self.items.get((drive.lower(), item_id))

    def _view(self, item: dict, params: dict) -> dict:
        shown = dict(item)
        if "@microsoft.graph.downloadUrl" in params.get("$select", "") and "file" in item:
            shown["@microsoft.graph.downloadUrl"] = (
                f"https://{self.download_host}/download/{item['id']}?tempauth=t"
            )
        return shown

    def _children(self, drive: str, folder: str) -> list[dict]:
        return [
            item
            for (d, _), item in self.items.items()
            if d == drive.lower() and item["parentReference"].get("id") == folder
        ]

    def _page(self, path: str, items: list, params: dict) -> dict:
        top = self.page_size or int(params.get("$top", 10))
        start = int(params.get("$skiptoken", 0))
        body: dict = {"value": items[start : start + top]}
        if start + top < len(items):
            body["@odata.nextLink"] = (
                f"https://graph.microsoft.com/v1.0{path}?$top={top}&$skiptoken={start + top}"
            )
        return body

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.hook is not None and (response := self.hook(request)) is not None:
            return response
        params = dict(request.url.params)
        if request.url.host == self.download_host:
            item_id = request.url.path.rsplit("/", 1)[1]
            return httpx.Response(200, content=self.contents[item_id])
        assert request.url.host == "graph.microsoft.com", request.url
        path = request.url.path.removeprefix("/v1.0")
        parts = path.strip("/").split("/")
        if request.method == "POST":
            assert parts == ["search", "query"]
            return self._search(json.loads(request.content))
        if request.method == "PUT":
            return self._upload(request, parts)
        match parts:
            case ["me"]:
                return httpx.Response(
                    200, json={"id": USER_ID, "mail": "me@contoso.com", "displayName": "Me"}
                )
            case ["me", "drive"]:
                return httpx.Response(200, json=self.drives[self.me])
            case ["me", "drive", "root"]:
                return httpx.Response(200, json=self._view(self.items[(self.me.lower(), "root-me")], params))
            case ["me", "drive", search] if search.startswith("search(q='"):
                text = search.removeprefix("search(q='").removesuffix("')").replace("''", "'")
                found = [i for i in self.items.values() if text.lower() in i["name"].lower()]
                return httpx.Response(200, json=self._page(path, found, params))
            case ["me", "followedSites"]:
                assert not self.personal
                return httpx.Response(
                    200, json={"value": [{"id": SITE, "displayName": "Sales", "name": "sales"}]}
                )
            case ["sites", site, "drives"] if site == SITE:
                lists = {"id": "b!lists", "name": "Lists", "driveType": "other"}
                return httpx.Response(200, json={"value": [self.drives[TEAM], lists]})
            case ["drives", drive] if found := self.drives.get(drive.upper() if self.personal else drive):
                return httpx.Response(200, json=found)
            case ["drives", drive, "root"]:
                return httpx.Response(
                    200, json=self.items[(drive.lower(), f"root-{drive.removeprefix('b!')}")]
                )
            case ["drives", drive, "items", item_id]:
                if (drive.lower(), item_id) in self.forbidden:
                    return self._error(403, "accessDenied")
                found = self._find(drive, item_id)
                return (
                    httpx.Response(200, json=self._view(found, params))
                    if found
                    else self._error(404, "itemNotFound")
                )
            case ["drives", drive, "items", item_id, "children"] if self._find(drive, item_id):
                return httpx.Response(200, json=self._page(path, self._children(drive, item_id), params))
        return self._error(404, "itemNotFound")

    def _search(self, body: dict) -> httpx.Response:
        self.searches.append(body)
        [request] = body["requests"]
        text = request["query"]["queryString"].lower()
        found = [i for i in self.items.values() if text in i["name"].lower() and "root" not in i]
        start, size = request["from"], request["size"]
        # As documented: a driveItem hit's resource has no id, and hitId is the item's id.
        hits = [
            {
                "hitId": i["id"],
                "resource": {"@odata.type": "#microsoft.graph.driveItem"}
                | {k: v for k, v in i.items() if k != "id"},
            }
            for i in found
        ]
        container = {
            "hits": hits[start : start + size],
            "total": len(hits),
            "moreResultsAvailable": start + size < len(hits),
        }
        return httpx.Response(200, json={"value": [{"searchTerms": [text], "hitsContainers": [container]}]})

    def _upload(self, request: httpx.Request, parts: list[str]) -> httpx.Response:
        self.uploads.append(request)
        match parts:
            case ["drives", drive, "items", folder, name, "content"] if folder.endswith(
                ":"
            ) and name.endswith(":"):
                folder, name = folder.removesuffix(":"), name.removesuffix(":")
                if any(c["name"].lower() == name.lower() for c in self._children(drive, folder)):
                    return self._error(409, "nameAlreadyExists")
                created = _file(f"new{len(self.uploads)}", name, self.drives[self.me]["id"], folder)
                self.items[(drive.lower(), created["id"])] = created
                self.contents[created["id"]] = request.content
                return httpx.Response(201, json=created)
        raise AssertionError(parts)

    def item_fetches(self, item_id: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith(f"/items/{item_id}")]

    def client(self) -> DriveClient:
        return DriveClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


@pytest.fixture
def start(connector_run, graph, monkeypatch):
    """Starts a run with the user's OneDrive connection, holding `grants` ({item: actions})."""
    monkeypatch.setattr(OneDriveConnector, "client", lambda self, token: graph.client())

    def start_(grants: dict[str, tuple[str, ...]], scopes: list[str] = READ_SCOPES):
        items = {("item", item_id): actions for item_id, actions in grants.items()}
        return connector_run(
            "onedrive", items, scopes=scopes, label="me@contoso.com", external_account_id=USER_ID
        )

    return start_


def _ids(outcome) -> list[str]:
    return [item["id"] for item in outcome.result["items"]]


async def test_account_discovery_and_names(graph):
    connector = OneDriveConnector()
    client = graph.client()
    account = await connector.account(client)
    assert (account.id, account.label) == (USER_ID, "me@contoso.com")
    page = await connector.discover(client, "item", query=None, cursor=None)
    assert [(i.id, i.name) for i in page.items] == [
        (f"{ME}:root-me", "OneDrive"),
        (f"{TEAM}:root-team", "Sales / Documents"),
    ]
    found = await connector.discover(client, "item", query="plan", cursor=None)
    assert [(i.id, i.name) for i in found.items] == [(f"{ME}:plan", "plan.txt")]
    with pytest.raises(OperationError) as bad:
        await connector.discover(client, "item", query="plan", cursor='{"page": "elsewhere"}')
    assert bad.value.code == "INVALID_CURSOR"
    ids = [
        f"{ME}:root-me",
        f"{TEAM}:root-team",
        f"{ME}:docs",
        f"{ME}:plan",
        f"{ME}:gone",
        f"{OTHER}:ghost",
        "x",
    ]
    assert await connector.describe(client, "item", ids) == {
        f"{ME}:root-me": "OneDrive",
        f"{TEAM}:root-team": "Documents (library)",
        f"{ME}:docs": "Docs/",
        f"{ME}:plan": "plan.txt",
    }


@pytest.mark.django_db(transaction=True)
async def test_a_grant_on_a_folder_covers_everything_inside_it(start, graph):
    executor = await start({f"{ME}:docs": ("read",)})
    outcome = await executor.invoke("onedrive_list_folder", {"folder_id": f"{ME}:docs"})
    assert _ids(outcome) == [f"{ME}:projects", f"{ME}:report", f"{ME}:deck", f"{ME}:sheet"]
    assert outcome.result["items"][0]["parent_id"] == f"{ME}:docs"
    assert outcome.result["items"][0]["type"] == "folder"
    outcome = await executor.invoke("onedrive_read_file", {"file_id": f"{ME}:plan"})
    assert outcome.result["items"][0]["text"] == "The plan."
    for folder in ("root", f"{ME}:private", f"{ME}:missing", f"{OTHER}:ghost"):
        assert await refusal(executor, "onedrive_list_folder", {"folder_id": folder}) == "POLICY_DENIED"
    assert await refusal(executor, "onedrive_get_file", {"file_id": f"{ME}:diary"}) == "POLICY_DENIED"
    assert not [r for r in graph.requests if r.url.path.endswith("/private/children")]
    assert (await executor.invoke("onedrive_list_libraries", {})).result["items"] == []


@pytest.mark.django_db(transaction=True)
async def test_libraries_and_root_under_a_wildcard_with_a_deny_below(start, graph):
    await start({})
    await ceiling("onedrive", "item", f"{ME}:projects", Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    outcome = await executor.invoke("onedrive_list_libraries", {})
    assert [(i["id"], i["name"], i["type"]) for i in outcome.result["items"]] == [
        (f"{ME}:root-me", "OneDrive", "library"),
        (f"{TEAM}:root-team", "Sales / Documents", "library"),
    ]
    outcome = await executor.invoke("onedrive_list_folder", {"folder_id": "root"})
    assert _ids(outcome) == [f"{ME}:docs", f"{ME}:private", f"{ME}:link"]
    [link] = [i for i in outcome.result["items"] if i["type"] == "shortcut"]
    assert link["target_id"] == f"{OTHER}:shared"
    assert _ids(await executor.invoke("onedrive_list_folder", {"folder_id": f"{ME}:docs"})) == [
        f"{ME}:report",
        f"{ME}:deck",
        f"{ME}:sheet",
    ]
    assert await refusal(executor, "onedrive_read_file", {"file_id": f"{ME}:plan"}) == "POLICY_DENIED"
    outcome = await executor.invoke("onedrive_list_folder", {"folder_id": f"{TEAM}:root-team"})
    assert _ids(outcome) == [f"{TEAM}:wiki"]
    with pytest.raises(OperationError) as caught:
        await executor.invoke("onedrive_list_folder", {"folder_id": f"{ME}:link"})
    assert (caught.value.code, f"{OTHER}:shared" in caught.value.message) == ("UNSUPPORTED_FILE", True)


@pytest.mark.django_db(transaction=True)
async def test_a_library_grant_covers_the_library_only(start, graph):
    executor = await start({f"{TEAM}:root-team": ("read",)})
    outcome = await executor.invoke("onedrive_list_libraries", {})
    assert _ids(outcome) == [f"{TEAM}:root-team"]
    outcome = await executor.invoke("onedrive_read_file", {"file_id": f"{TEAM}:handbook"})
    assert outcome.result["items"][0]["text"] == "# Handbook"
    assert await refusal(executor, "onedrive_get_file", {"file_id": f"{ME}:docs"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_items_shared_from_elsewhere_sit_in_folders_minerva_cannot_see(start, graph):
    executor = await start({f"{OTHER}:shared": ("read",)})
    outcome = await executor.invoke("onedrive_read_file", {"file_id": f"{OTHER}:notes"})
    assert outcome.result["items"][0]["text"] == "Shared notes."
    assert outcome.result["items"][0]["parent_id"] == f"{OTHER}:shared"
    await ceiling("onedrive", "item", f"{ME}:private", Grant.Effect.DENY)
    # Above the shared folder Graph refuses to look, so it might sit inside any denied folder.
    for grants in ({f"{OTHER}:shared": ("read",)}, {"*": ("read",)}):
        executor = await start(grants)
        assert await refusal(executor, "onedrive_read_file", {"file_id": f"{OTHER}:notes"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_children_named_elsewhere_are_dropped_and_pages_follow(start, graph):
    graph.items[(ME, "stray")] = _file("stray", "stray.txt", ME, "private")
    original = graph._children
    graph._children = lambda drive, folder: [*original(drive, folder), graph.items[(ME, "stray")]]
    graph.page_size = 2
    executor = await start({"*": ("read",)})
    first = await executor.invoke("onedrive_list_folder", {"folder_id": f"{ME}:docs", "limit": 2})
    assert _ids(first) == [f"{ME}:projects", f"{ME}:report"]
    cursor = first.result["next_cursor"]
    second = await executor.invoke(
        "onedrive_list_folder", {"folder_id": f"{ME}:docs", "limit": 2, "cursor": cursor}
    )
    assert _ids(second) == [f"{ME}:deck", f"{ME}:sheet"]
    third = await executor.invoke(
        "onedrive_list_folder",
        {"folder_id": f"{ME}:docs", "limit": 2, "cursor": second.result["next_cursor"]},
    )
    assert _ids(third) == []
    assert third.result.get("next_cursor") is None
    assert graph.requests[-1].url.params["$skiptoken"] == "4"


@pytest.mark.django_db(transaction=True)
async def test_search_reads_each_hit_again_and_filters_it(start, graph):
    executor = await start({f"{ME}:docs": ("read",)})
    outcome = await executor.invoke("onedrive_search_files", {"text": "t", "limit": 3})
    assert _ids(outcome) == [f"{ME}:projects", f"{ME}:plan", f"{ME}:report"]
    assert graph.searches[-1]["requests"][0]["from"] == 0
    cursor = outcome.result["next_cursor"]
    outcome = await executor.invoke("onedrive_search_files", {"text": "t", "limit": 3, "cursor": cursor})
    # The third hit of this page, Private, is left out.
    assert _ids(outcome) == [f"{ME}:deck", f"{ME}:sheet"]
    assert graph.searches[-1]["requests"][0]["from"] == 3
    # What the search said about a hit is not trusted: it is read again by id.
    assert graph.item_fetches("private")


@pytest.mark.django_db(transaction=True)
async def test_personal_accounts_search_their_drive_and_ids_are_lower_case(connector_run, monkeypatch):
    graph = FakeGraph(personal=True)
    monkeypatch.setattr(OneDriveConnector, "client", lambda self, token: graph.client())
    mine = PERSONAL.lower()
    executor = await connector_run(
        "onedrive",
        {("item", f"{mine}:docs"): ("read",)},
        scopes=READ_SCOPES,
        label="me@outlook.com",
        external_account_id=USER_ID,
    )
    outcome = await executor.invoke("onedrive_search_files", {"text": "it's plan"})
    assert outcome.result["items"] == []
    assert graph.requests[1].url.raw_path.startswith(b"/v1.0/me/drive/search(q='it%27%27s%20plan')")
    outcome = await executor.invoke("onedrive_search_files", {"text": "plan"})
    assert _ids(outcome) == [f"{mine}:plan"]
    # Another spelling of the drive id names the same file.
    outcome = await executor.invoke("onedrive_get_file", {"file_id": f"{PERSONAL}:plan"})
    assert _ids(outcome) == [f"{mine}:plan"]
    assert not graph.searches
    assert not [r for r in graph.requests if "followedSites" in r.url.path]
    # Only the spelling calls use can be allowed: a deny saved under another would never apply.
    names = await OneDriveConnector().describe(graph.client(), "item", [f"{PERSONAL}:docs", f"{mine}:docs"])
    assert names == {f"{mine}:docs": "Docs/"}


@pytest.mark.django_db(transaction=True)
async def test_reading_office_files(start, graph):
    executor = await start({"*": ("read",)})
    texts = {}
    for name in ("report", "deck", "sheet"):
        outcome = await executor.invoke("onedrive_read_file", {"file_id": f"{ME}:{name}"})
        texts[name] = outcome.result["items"][0]["text"]
    assert texts == {
        "report": "Hello\tworld\n",
        "deck": "Slide 1\nAgenda\n\nSlide 2\nTitle\n",
        "sheet": 'Name,,"a,b"\nAda,42,TRUE\n',
    }
    outcome = await executor.invoke("onedrive_read_file", {"file_id": f"{ME}:deck", "max_chars": 9})
    assert (outcome.result["items"][0]["text"], outcome.result["items"][0]["truncated"]) == (
        "Slide 1\nA",
        True,
    )


@pytest.mark.django_db(transaction=True)
async def test_downloads_send_no_token_and_only_go_to_microsoft(start, graph, monkeypatch):
    executor = await start({"*": ("read",)})
    await executor.invoke("onedrive_read_file", {"file_id": f"{ME}:plan"})
    download = graph.requests[-1]
    assert download.url.host == "contoso.sharepoint.com"
    assert "authorization" not in download.headers
    assert all(
        r.headers["authorization"] == "Bearer token"
        for r in graph.requests
        if r.url.host != download.url.host
    )

    graph.download_host = "contoso.sharepoint.com.evil.example"
    count = len(graph.requests)
    assert await refusal(executor, "onedrive_read_file", {"file_id": f"{ME}:plan"}) == "PROVIDER_FAILED"
    assert all(r.url.host == "graph.microsoft.com" for r in graph.requests[count:])

    graph.download_host = "contoso.sharepoint.com"
    for item_id, code in (("docs", "UNSUPPORTED_FILE"), ("link", "UNSUPPORTED_FILE")):
        assert await refusal(executor, "onedrive_read_file", {"file_id": f"{ME}:{item_id}"}) == code
    graph.items[(ME, "plan")]["file"]["mimeType"] = "application/pdf"
    graph.items[(ME, "plan")]["name"] = "plan.pdf"
    assert await refusal(executor, "onedrive_read_file", {"file_id": f"{ME}:plan"}) == "UNSUPPORTED_FILE"
    monkeypatch.setattr(onedrive_module, "MAX_OFFICE_BYTES", 100)
    assert await refusal(executor, "onedrive_read_file", {"file_id": f"{ME}:report"}) == "FILE_TOO_LARGE"


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1", True),
        ("https://contoso-my.sharepoint.com/personal/x/download", True),
        ("https://public.am.files.1drv.com/y4m", True),
        ("https://my.microsoftpersonalcontent.com/x", True),
        ("http://contoso.sharepoint.com/x", False),
        ("https://sharepoint.com/x", False),
        ("https://evilsharepoint.com/x", False),
        ("https://contoso.sharepoint.com.evil.example/x", False),
        ("https://user@contoso.sharepoint.com/x", False),
        ("https://contoso.sharepoint.com:8443/x", False),
        ("https://contoso.sharepoint.com\\@evil.example/x", False),
        ("https://contoso.sharepoint.com/x y", False),
        ("https://contoso.sharepoint.com/" + "x" * 8000, False),
        ("file:///etc/passwd", False),
    ],
)
def test_download_hosts(url, allowed):
    assert download_allowed(url) is allowed


def _moved_on_second_fetch(graph, item_id, parent):
    def hook(request):
        if request.url.path.endswith(f"/items/{item_id}") and len(graph.item_fetches(item_id)) == 2:
            graph.items[(ME, item_id)]["parentReference"]["id"] = parent

    graph.hook = hook


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("onedrive_read_file", {"file_id": f"{ME}:plan"}),
        ("onedrive_list_folder", {"folder_id": f"{ME}:projects"}),
        ("onedrive_create_file", {"folder_id": f"{ME}:projects", "name": "x.txt", "content": "a"}),
    ],
)
async def test_an_item_moved_while_the_call_runs_is_refused(start, graph, tool, args):
    await start({}, WRITE_SCOPES)
    await ceiling("onedrive", "item", f"{ME}:private", Grant.Effect.DENY, actions=("read", "create"))
    executor = await start({"*": ("read", "create")}, WRITE_SCOPES)
    moved = (args.get("file_id") or args["folder_id"]).split(":")[1]
    _moved_on_second_fetch(graph, moved, "private")
    assert await refusal(executor, tool, args) == "FILE_MOVED"
    assert not [
        r for r in graph.requests if r.url.host != "graph.microsoft.com" or r.url.path.endswith("/children")
    ]
    assert graph.uploads == []


@pytest.mark.django_db(transaction=True)
async def test_cycles_and_lookup_limits_leave_ancestry_partial(start, graph, monkeypatch):
    graph.items[(ME, "loop_a")] = _folder("loop_a", "A", ME, "loop_b")
    graph.items[(ME, "loop_b")] = _folder("loop_b", "B", ME, "loop_a")
    graph.items[(ME, "looped")] = _file("looped", "looped.txt", ME, "loop_a")
    graph.contents["looped"] = b"looped"
    # With no lookups, plan's folders are never resolved and the grant on Docs cannot be shown to cover it.
    monkeypatch.setattr(onedrive_module, "MAX_LOOKUPS", 0)
    executor = await start({f"{ME}:docs": ("read",)})
    assert await refusal(executor, "onedrive_get_file", {"file_id": f"{ME}:plan"}) == "POLICY_DENIED"
    assert _ids(await executor.invoke("onedrive_get_file", {"file_id": f"{ME}:projects"})) == [
        f"{ME}:projects"
    ]
    monkeypatch.setattr(onedrive_module, "MAX_LOOKUPS", 150)
    executor = await start({"*": ("read",)})
    assert _ids(await executor.invoke("onedrive_get_file", {"file_id": f"{ME}:looped"})) == [f"{ME}:looped"]
    await ceiling("onedrive", "item", f"{ME}:elsewhere", Grant.Effect.DENY)
    executor = await start({"*": ("read",)})
    assert await refusal(executor, "onedrive_get_file", {"file_id": f"{ME}:looped"}) == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_creating_needs_the_grant_and_write_consent(start, graph):
    executor = await start({f"{ME}:docs": ("read", "create")})
    assert "onedrive_create_file" not in executor.context.tools
    assert "onedrive_read_file" in executor.context.tools

    executor = await start({f"{ME}:docs": ("read", "create")}, WRITE_SCOPES)
    args = {"folder_id": f"{ME}:projects", "name": "Idea #1.md", "content": "Zażółć\nline two"}
    outcome = await executor.invoke("onedrive_create_file", args)
    [created] = outcome.result["items"]
    assert (created["id"], created["parent_id"], created["type"]) == (f"{ME}:new1", f"{ME}:projects", "file")
    [upload] = graph.uploads
    assert upload.url.raw_path.startswith(b"/v1.0/drives/b%21me/items/projects:/Idea%20%231.md:/content?")
    assert upload.url.params["@microsoft.graph.conflictBehavior"] == "fail"
    assert upload.headers["content-type"] == "text/plain; charset=utf-8"
    assert graph.contents["new1"] == "Zażółć\nline two".encode()

    with pytest.raises(OperationError) as taken:
        await executor.invoke("onedrive_create_file", {**args, "name": "PLAN.txt"})
    assert (taken.value.code, "already exists" in taken.value.message) == ("PROVIDER_REJECTED", True)
    assert "Secret" not in taken.value.message
    for folder in (f"{ME}:private", "root"):
        assert (
            await refusal(executor, "onedrive_create_file", {**args, "folder_id": folder}) == "POLICY_DENIED"
        )
    assert (
        await refusal(executor, "onedrive_create_file", {**args, "folder_id": f"{ME}:plan"})
        == "UNSUPPORTED_FILE"
    )
    assert len(graph.uploads) == 2


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "name",
    [
        "a/b.txt",
        "a:b",
        "what?",
        "trailing.",
        "CON",
        "con.txt",
        "Lpt1.md",
        "desktop.ini",
        "~$lock.docx",
        "x_vti_y",
        "a\nb",
    ],
)
async def test_file_names_onedrive_refuses_are_refused_first(start, graph, name):
    executor = await start({f"{ME}:docs": ("read", "create")}, WRITE_SCOPES)
    args = {"folder_id": f"{ME}:docs", "name": name, "content": "x"}
    assert await refusal(executor, "onedrive_create_file", args) == "INVALID_ARGUMENTS"
    assert graph.uploads == []


def test_office_files_that_declare_a_doctype_are_refused():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
        f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>'
    )
    data = _zip(
        {"_rels/.rels": _rels(("rId1", "officeDocument", "word/document.xml")), "word/document.xml": bomb}
    )
    with pytest.raises(OperationError) as caught:
        office.extract("docx", data, 1000)
    assert caught.value.code == "UNSUPPORTED_FILE"


def test_office_archives_are_bounded():
    padding = " " * (office.MAX_EXPANDED + 1)
    expanding = _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "word/document.xml")),
            "word/document.xml": f'<w:document xmlns:w="{W}">{padding}</w:document>',
        }
    )
    assert len(expanding) < 1024 * 1024
    with pytest.raises(OperationError) as caught:
        office.extract("docx", expanding, 1000)
    assert caught.value.code == "FILE_TOO_LARGE"

    crowded = _zip({f"part{i}.xml": "" for i in range(office.MAX_ENTRIES + 1)})
    with pytest.raises(OperationError) as caught:
        office.extract("docx", crowded, 1000)
    assert caught.value.code == "UNSUPPORTED_FILE"

    for data in (b"not a zip", _zip({"word/document.xml": "<x/>"})):
        with pytest.raises(OperationError) as caught:
            office.extract("docx", data, 1000)
        assert caught.value.code == "UNSUPPORTED_FILE"

    # Reading stops at the limit, however much text the file holds.
    long = _docx("<w:p><w:r><w:t>" + "word " * 100_000 + "</w:t></w:r></w:p>")
    assert office.extract("docx", long, 12) == "word word wo"


def test_excel_rows_are_cut_before_they_are_built():
    # One long shared string in every cell of a row would make a row hundreds of megabytes long.
    long = "x" * (3 * 1024 * 1024)
    cells = '<c t="s"><v>0</v></c>' * 200
    data = _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "xl/workbook.xml")),
            "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet r:id="rId1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": _rels(
                ("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "sharedStrings", "sharedStrings.xml")
            ),
            "xl/sharedStrings.xml": f'<sst xmlns="{S}"><si><t>{long}</t></si></sst>',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1">{cells}</row>'
            f'<row r="2">{cells}</row></sheetData></worksheet>',
        }
    )
    tracemalloc.start()
    try:
        text = office.extract("xlsx", data, 1000)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert text == "x" * 1000
    assert peak < 64 * 1024 * 1024

    # A row cut short still ends the text at the limit, so the caller sees it was truncated.
    short = _zip(
        {
            "_rels/.rels": _rels(("rId1", "officeDocument", "xl/workbook.xml")),
            "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet r:id="rId1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": _rels(("rId1", "worksheet", "worksheets/sheet1.xml")),
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1">'
            '<c r="A1"><v>12345</v></c><c r="B1"><v>67890</v></c></row></sheetData></worksheet>',
        }
    )
    assert office.extract("xlsx", short, 8) == "12345,67"
    assert office.extract("xlsx", short, 100) == "12345,67890\n"
