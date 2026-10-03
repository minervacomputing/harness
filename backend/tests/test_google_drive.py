"""Google Drive connector against an in-memory Drive API, and runs through the executor."""

import json
import re
from email import message_from_bytes

import httpx
import pytest
from connector_runs import ceiling

from connectors.base import OperationError
from connectors.google_drive import connector as drive_module
from connectors.google_drive.client import FOLDER, SHORTCUT, GoogleDriveClient, quoted
from connectors.google_drive.connector import FULL_SCOPE, GOOGLE_DOC, READ_SCOPE, GoogleDriveConnector
from permissions.models import Grant

ROOT = "root0"


def _file(file_id, name, mime, parents=None, content=None, **extra):
    data = {"id": file_id, "name": name, "mimeType": mime, **extra}
    if parents is not None:
        data["parents"] = parents
    if content is not None:
        data["size"] = str(len(content.encode()))
    return data


class FakeDrive:
    """Google Drive API v3 and the OpenID userinfo endpoint, served through httpx.MockTransport.

    My Drive: docs/ (drafts/ (essay), notes.txt, shortcut to essay, multi), photo.png, private/ (diary).
    Shared with the account without its folder: shared. In a folder it cannot see: orphan. Shared drive
    "Team": plan.
    """

    def __init__(self) -> None:
        doc = "application/vnd.google-apps.document"
        self.files = {
            f["id"]: f
            for f in [
                _file(ROOT, "My Drive", FOLDER),
                _file("docs", "Docs", FOLDER, [ROOT]),
                _file("drafts", "Drafts", FOLDER, ["docs"]),
                _file("essay", "Essay", doc, ["drafts"]),
                _file("notes", "notes.txt", "text/plain", ["docs"], content="hello notes"),
                _file("short", "Essay shortcut", SHORTCUT, ["docs"], shortcutDetails={"targetId": "essay"}),
                _file("multi", "Twice", doc, ["docs", "private"]),
                _file("photo", "photo.png", "image/png", [ROOT], content="PNG"),
                _file("private", "Private", FOLDER, [ROOT]),
                _file("diary", "Diary", doc, ["private"]),
                _file("shared", "Shared essay", doc),
                _file("orphan", "Orphan essay", doc, ["ghost"]),
                _file("team", "Drive", FOLDER, driveId="team"),
                _file("plan", "Plan", doc, ["team"], driveId="team"),
            ]
        }
        self.contents = {
            "essay": "An essay about essays.",
            "notes": "hello notes",
            "multi": "essay twice",
            "diary": "Dear diary, essay.",
            "shared": "A shared essay.",
            "orphan": "An orphan essay.",
            "plan": "The essay plan.",
        }
        self.drives = [{"id": "team", "name": "Team"}]
        self.uploads: list[httpx.Request] = []
        self.requests: list[httpx.Request] = []
        self.error: tuple[int, dict] | None = None
        self.hook = None

    def _query(self, q: str) -> list[dict]:
        literal = r"'((?:[^'\\]|\\.)*)'"

        def text(match: re.Match, group: int = 1) -> str:
            return re.sub(r"\\(.)", r"\1", match.group(group))

        files = [f for f in self.files.values() if f["id"] not in {ROOT, "team"}]
        if m := re.fullmatch(rf"{literal} in parents and trashed = false", q):
            return [f for f in files if text(m) in f.get("parents", [])]
        if m := re.fullmatch(
            rf"\(name contains {literal} or fullText contains {literal}\) and trashed = false", q
        ):
            needle = text(m).casefold()
            return [
                f
                for f in files
                if needle in f["name"].casefold() or needle in self.contents.get(f["id"], "").casefold()
            ]
        if m := re.fullmatch(rf"mimeType = {literal} and trashed = false", q):
            return [f for f in files if f["mimeType"] == text(m)]
        if m := re.fullmatch(rf"name contains {literal} and trashed = false", q):
            return [f for f in files if text(m).casefold() in f["name"].casefold()]
        raise AssertionError(f"unexpected query {q!r}")

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.hook:
            self.hook(request)
        if self.error:
            return httpx.Response(self.error[0], json=self.error[1])
        if request.url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json={"sub": "108", "email": "ada@example.com"})
        params = request.url.params
        match request.url.path.split("/")[1:]:
            case ["upload", "drive", "v3", "files"]:
                self.uploads.append(request)
                message = message_from_bytes(
                    b"Content-Type: "
                    + request.headers["content-type"].encode()
                    + b"\r\n\r\n"
                    + request.content
                )
                metadata_part, media_part = message.get_payload()
                metadata = json.loads(metadata_part.get_payload(decode=True))
                created = _file(
                    f"new{len(self.uploads)}", metadata["name"], metadata.get("mimeType", "text/plain")
                )
                created["parents"] = metadata["parents"]
                self.files[created["id"]] = created
                self.contents[created["id"]] = media_part.get_payload(decode=True).decode()
                return httpx.Response(200, json=created)
            case ["drive", "v3", "files"]:
                found = self._query(params["q"])
                start = int(params.get("pageToken", "p-0").removeprefix("p-"))
                end = start + int(params["pageSize"])
                page: dict = {
                    "files": found[start:end],
                    "incompleteSearch": params.get("corpora") == "allDrives",
                }
                if end < len(found):
                    page["nextPageToken"] = f"p-{end}"
                return httpx.Response(200, json=page)
            case ["drive", "v3", "files", "root"]:
                return httpx.Response(200, json={"id": ROOT})
            case ["drive", "v3", "files", file_id] if file_id in self.files:
                if params.get("alt") == "media":
                    return httpx.Response(200, content=self.contents[file_id].encode())
                return httpx.Response(200, json=self.files[file_id])
            case ["drive", "v3", "files", file_id, "export"] if file_id in self.files:
                return httpx.Response(200, content=self.contents[file_id].encode())
            case ["drive", "v3", "drives"]:
                return httpx.Response(200, json={"drives": self.drives})
            case ["drive", "v3", "drives", drive_id]:
                return httpx.Response(200, json=next(d for d in self.drives if d["id"] == drive_id))
        return httpx.Response(404, json={"error": {"code": 404, "message": "File not found"}})

    def client(self) -> GoogleDriveClient:
        return GoogleDriveClient("token", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def google() -> FakeDrive:
    return FakeDrive()


def test_query_literals_are_escaped():
    assert quoted("it's") == r"'it\'s'"
    assert quoted("a\\' or name contains '") == r"'a\\\' or name contains \''"


async def test_discovery_offers_my_drive_shared_drives_then_folders(google):
    connector = GoogleDriveConnector()
    client = google.client()
    first = await connector.discover(client, "file", query=None, cursor=None)
    assert [(i.id, i.name) for i in first.items] == [(ROOT, "My Drive"), ("team", "Team (shared drive)")]
    second = await connector.discover(client, "file", query=None, cursor=first.next_cursor)
    assert [i.name for i in second.items] == ["Docs/", "Drafts/", "Private/"]
    assert second.next_cursor is None
    found = await connector.discover(client, "file", query="essay", cursor=None)
    assert {i.id for i in found.items} == {"essay", "short", "shared", "orphan"}
    for cursor in ('{"phase": "elsewhere"}', '{"phase": [], "page": null}', '{"phase": "folders"}', "[]"):
        with pytest.raises(OperationError) as bad:
            await connector.discover(client, "file", query=None, cursor=cursor)
        assert bad.value.code == "INVALID_CURSOR"
    names = await connector.describe(client, "file", [ROOT, "team", "drafts", "gone"])
    assert names == {ROOT: "My Drive", "team": "Team (shared drive)", "drafts": "Drafts/"}


BASE_SCOPES = ["openid", "email", READ_SCOPE]
WRITE_SCOPES = [*BASE_SCOPES, FULL_SCOPE]


@pytest.fixture
def start(connector_run, google, monkeypatch):
    """Starts a run for an agent with the user's Drive connection, holding `scopes` and `grants`."""
    monkeypatch.setattr(GoogleDriveConnector, "client", lambda self, token: google.client())

    def start_(scopes: list[str], grants: dict[str, tuple[str, ...]]):
        files = {("file", fid): actions for fid, actions in grants.items()}
        return connector_run(
            "google_drive", files, scopes=scopes, label="ada@example.com", external_account_id="108"
        )

    return start_


def _ids(outcome) -> list[str]:
    return [item["id"] for item in outcome.result["items"]]


@pytest.mark.django_db(transaction=True)
async def test_a_grant_on_a_folder_covers_everything_inside_it(start, google):
    executor = await start(BASE_SCOPES, {"docs": ("read",)})
    outcome = await executor.invoke("google_drive_list_folder", {"folder_id": "docs"})
    # "Twice" is also in Private, so this listing cannot place it.
    assert _ids(outcome) == ["drafts", "notes", "short"]
    assert outcome.result["items"][1]["parent_id"] == "docs"
    outcome = await executor.invoke("google_drive_list_folder", {"folder_id": "drafts"})
    assert _ids(outcome) == ["essay"]
    outcome = await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert outcome.result["items"][0]["text"] == "An essay about essays."
    for denied in ({"folder_id": "root"}, {"folder_id": "private"}, {"folder_id": "missing"}):
        with pytest.raises(OperationError) as caught:
            await executor.invoke("google_drive_list_folder", denied)
        assert caught.value.code == "POLICY_DENIED"
    assert not [r for r in google.requests if r.url.params.get("q", "").startswith(quoted("private"))]


@pytest.mark.django_db(transaction=True)
async def test_root_names_my_drive_and_a_deny_on_a_subfolder_hides_it(start, google):
    await start(BASE_SCOPES, {})
    await ceiling("google_drive", "file", "drafts", Grant.Effect.DENY)
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    outcome = await executor.invoke("google_drive_list_folder", {"folder_id": "root"})
    assert _ids(outcome) == ["docs", "photo", "private"]
    assert _ids(await executor.invoke("google_drive_list_folder", {"folder_id": "docs"})) == [
        "notes",
        "short",
    ]
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert caught.value.code == "POLICY_DENIED"
    # The shared drive is listed within that drive only.
    await executor.invoke("google_drive_list_folder", {"folder_id": "team"})
    params = google.requests[-1].url.params
    assert (params["corpora"], params["driveId"], params["supportsAllDrives"]) == ("drive", "team", "true")


@pytest.mark.django_db(transaction=True)
async def test_search_results_are_filtered_by_where_they_sit(start, google):
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    outcome = await executor.invoke("google_drive_search_files", {"text": "essay"})
    # Files whose folders cannot be seen are readable under a wildcard; the file in two folders never is.
    assert set(_ids(outcome)) == {"essay", "short", "diary", "shared", "orphan", "plan"}
    assert outcome.result["incomplete"] is True
    assert [r.url.params["corpora"] for r in google.requests if r.url.path.endswith("/files")] == [
        "allDrives"
    ]

    await ceiling("google_drive", "file", "private", Grant.Effect.DENY)
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    outcome = await executor.invoke("google_drive_search_files", {"text": "essay"})
    # With an exact deny somewhere, files with unknown folders might be inside it, so they are left out.
    assert set(_ids(outcome)) == {"essay", "short", "plan"}

    executor = await start(BASE_SCOPES, {"docs": ("read",)})
    outcome = await executor.invoke("google_drive_search_files", {"text": "it's"})
    assert outcome.result["items"] == []
    assert google.requests[-1].url.params["q"] == (
        r"(name contains 'it\'s' or fullText contains 'it\'s') and trashed = false"
    )


@pytest.mark.django_db(transaction=True)
async def test_too_many_folder_lookups_leave_ancestry_partial(start, monkeypatch):
    monkeypatch.setattr(drive_module, "MAX_LOOKUPS", 0)
    executor = await start(BASE_SCOPES, {"docs": ("read",)})
    outcome = await executor.invoke("google_drive_search_files", {"text": "essay"})
    # "short" is directly in docs, which needs no lookup; essay's folder "drafts" is never looked up.
    assert _ids(outcome) == ["short"]


@pytest.mark.django_db(transaction=True)
async def test_nested_grants_on_two_layers_offer_the_tools(start):
    await start(BASE_SCOPES, {})
    await ceiling("google_drive", "file", "docs", Grant.Effect.ALLOW, restricted=True)
    executor = await start(BASE_SCOPES, {"drafts": ("read",)})
    assert "google_drive_search_files" in executor.context.tools
    assert _ids(await executor.invoke("google_drive_list_folder", {"folder_id": "drafts"})) == ["essay"]
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_list_folder", {"folder_id": "docs"})
    assert caught.value.code == "POLICY_DENIED"


@pytest.mark.django_db(transaction=True)
async def test_reading_files(start, google, monkeypatch):
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    notes = await executor.invoke("google_drive_read_file", {"file_id": "notes", "max_chars": 5})
    assert (notes.result["items"][0]["text"], notes.result["items"][0]["truncated"]) == ("hello", True)
    assert google.requests[-1].url.params["alt"] == "media"
    essay = await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert essay.result["items"][0]["truncated"] is False
    assert google.requests[-1].url.path.endswith("/files/essay/export")
    assert google.requests[-1].url.params["mimeType"] == "text/plain"
    for file_id, message in (("photo", "not this type"), ("short", "file id essay")):
        with pytest.raises(OperationError) as caught:
            await executor.invoke("google_drive_read_file", {"file_id": file_id})
        assert caught.value.code == "UNSUPPORTED_FILE"
        assert message in caught.value.message
    google.files["essay"]["capabilities"] = {"canDownload": False}
    with pytest.raises(OperationError) as blocked:
        await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert blocked.value.code == "PROVIDER_FORBIDDEN"
    # Sizes are enforced while streaming, whatever the metadata says.
    monkeypatch.setattr(drive_module, "MAX_EXPORT_BYTES", 8)
    with pytest.raises(OperationError) as large:
        await executor.invoke("google_drive_read_file", {"file_id": "diary"})
    assert large.value.code == "FILE_TOO_LARGE"


@pytest.mark.django_db(transaction=True)
async def test_creating_needs_the_grant_and_full_drive_consent(start, google):
    executor = await start(BASE_SCOPES, {"docs": ("read", "create")})
    assert "google_drive_create_file" not in executor.context.tools
    assert "google_drive_read_file" in executor.context.tools

    executor = await start(WRITE_SCOPES, {"docs": ("read", "create")})
    args = {"folder_id": "drafts", "name": "Idea", "content": "Zażółć\nline two", "as_document": True}
    outcome = await executor.invoke("google_drive_create_file", args)
    [created] = outcome.result["items"]
    assert (created["id"], created["parent_id"], created["type"]) == ("new1", "drafts", "document")
    [upload] = google.uploads
    assert upload.url.params["uploadType"] == "multipart"
    assert upload.url.params["ignoreDefaultVisibility"] == "true"
    assert upload.url.params["supportsAllDrives"] == "true"
    assert google.files["new1"]["mimeType"] == GOOGLE_DOC
    assert google.contents["new1"] == "Zażółć\nline two"

    with pytest.raises(OperationError) as denied:
        await executor.invoke("google_drive_create_file", {**args, "folder_id": "private"})
    assert denied.value.code == "POLICY_DENIED"
    with pytest.raises(OperationError) as not_folder:
        await executor.invoke("google_drive_create_file", {**args, "folder_id": "notes"})
    assert not_folder.value.code == "UNSUPPORTED_FILE"
    assert len(google.uploads) == 1


@pytest.mark.parametrize(
    "args",
    [
        {"folder_id": "docs", "name": "x", "content": "a" * (1024 * 1024 + 1)},
        {"folder_id": "docs", "name": "x", "content": "ż" * (512 * 1024 + 1)},
        {"folder_id": "docs", "name": "bad\nname", "content": "a"},
        {"folder_id": "../docs", "name": "x", "content": "a"},
        {"folder_id": "docs", "name": "", "content": "a"},
    ],
)
@pytest.mark.django_db(transaction=True)
async def test_create_arguments_are_validated(start, google, args):
    executor = await start(WRITE_SCOPES, {"docs": ("read", "create")})
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_create_file", args)
    assert caught.value.code == "INVALID_ARGUMENTS"
    assert google.requests == []


@pytest.mark.django_db(transaction=True)
async def test_a_disabled_drive_api_is_reported(start, google):
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    google.error = (403, {"error": {"code": 403, "errors": [{"reason": "accessNotConfigured"}]}})
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_get_file", {"file_id": "essay"})
    assert caught.value.code == "PROVIDER_NOT_CONFIGURED"


@pytest.mark.django_db(transaction=True)
async def test_malformed_ancestry_is_a_connector_error(start, monkeypatch):
    executor = await start(BASE_SCOPES, {"*": ("read",)})

    async def wildcard_ancestor(self, file):
        return ("*",), False

    monkeypatch.setattr(drive_module.Tree, "place", wildcard_ancestor)
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_get_file", {"file_id": "essay"})
    assert caught.value.code == "CONNECTOR_ERROR"
    outcome = await executor.invoke("google_drive_search_files", {"text": "essay"})
    assert outcome.result["items"] == [], "records with malformed ancestry are dropped"

    async def self_ancestor(self, file):
        return (file.id,), False

    monkeypatch.setattr(drive_module.Tree, "place", self_ancestor)
    assert (await executor.invoke("google_drive_search_files", {"text": "essay"})).result["items"] == []


def _move_on_second_fetch(google, file_id, parent):
    """Moves the file into `parent` just before Drive answers the second request for it."""
    fetches = []

    def hook(request):
        if request.url.path.endswith(f"/files/{file_id}") and "alt" not in request.url.params:
            fetches.append(request)
            if len(fetches) == 2:
                google.files[file_id]["parents"] = [parent]

    google.hook = hook


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("google_drive_read_file", {"file_id": "essay"}),
        ("google_drive_list_folder", {"folder_id": "drafts"}),
        ("google_drive_create_file", {"folder_id": "drafts", "name": "x", "content": "a"}),
    ],
)
async def test_a_file_moved_while_the_call_runs_is_refused(start, google, tool, args):
    await start(WRITE_SCOPES, {})
    await ceiling("google_drive", "file", "private", Grant.Effect.DENY, actions=("read", "create"))
    executor = await start(WRITE_SCOPES, {"*": ("read", "create")})
    moved = args.get("file_id") or args["folder_id"]
    _move_on_second_fetch(google, moved, "private")
    with pytest.raises(OperationError) as caught:
        await executor.invoke(tool, args)
    assert caught.value.code == "FILE_MOVED"
    assert not [
        r for r in google.requests if "alt" in r.url.params or r.url.path.endswith(("/export", "/files"))
    ]
    assert google.uploads == []


@pytest.mark.django_db(transaction=True)
async def test_cycles_and_deep_trees_are_partial(start, google, monkeypatch):
    google.files["loop_a"] = _file("loop_a", "A", FOLDER, ["loop_b"])
    google.files["loop_b"] = _file("loop_b", "B", FOLDER, ["loop_a"])
    google.files["looped"] = _file("looped", "Looped essay", "text/plain", ["loop_a"], content="essay")
    google.contents["looped"] = "essay"
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    assert "looped" in _ids(await executor.invoke("google_drive_search_files", {"text": "looped"}))
    await ceiling("google_drive", "file", "elsewhere", Grant.Effect.DENY)
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    # The loop never reaches My Drive, so any exact deny might be above it.
    assert _ids(await executor.invoke("google_drive_search_files", {"text": "looped"})) == []
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_read_file", {"file_id": "looped"})
    assert caught.value.code == "POLICY_DENIED"

    monkeypatch.setattr(drive_module, "MAX_DEPTH", 1)
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    # essay sits two folders below My Drive.
    assert _ids(await executor.invoke("google_drive_search_files", {"text": "An essay about"})) == []


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    ("mime", "export"),
    [
        ("application/vnd.google-apps.spreadsheet", "text/csv"),
        ("application/vnd.google-apps.presentation", "text/plain"),
    ],
)
async def test_sheets_and_slides_are_exported_as_text(start, google, mime, export):
    google.files["essay"]["mimeType"] = mime
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    outcome = await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert outcome.result["items"][0]["text"] == "An essay about essays."
    assert google.requests[-1].url.params["mimeType"] == export


@pytest.mark.django_db(transaction=True)
async def test_a_failed_download_is_reported_without_reading_it_all(start, google):
    executor = await start(BASE_SCOPES, {"*": ("read",)})
    original = google.handler

    def failing(request):
        if request.url.path.endswith("/export"):
            return httpx.Response(
                403,
                json={"error": {"code": 403, "errors": [{"reason": "exportSizeLimitExceeded"}]}},
                headers={"x-extra": "y"},
            )
        return original(request)

    google.handler = failing
    with pytest.raises(OperationError) as caught:
        await executor.invoke("google_drive_read_file", {"file_id": "essay"})
    assert caught.value.code == "FILE_TOO_LARGE"
