import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from asgiref.sync import sync_to_async
from django.db import connection
from django.test import AsyncClient

from accounts.models import User
from agents.models import Agent
from connections.crypto import CredentialKeyError
from conversations.models import Conversation
from runs import journal, services
from runs.models import Run, RunCommit
from workspaces.tenancy import workspace_scope

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.usefixtures("gateway_urls")]

FORMAT = "pi-durable@1.0.3/1"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def commit(*writes) -> bytes:
    return json.dumps({"format": FORMAT, "writes": list(writes or [{"type": "w"}])}).encode()


async def put(token: str, seq: int, body: bytes):
    return await AsyncClient().put(
        f"/journal/{seq}", data=body, content_type="application/octet-stream", headers=auth(token)
    )


async def last(token: str):
    return await AsyncClient().get("/journal", headers=auth(token))


async def get(token: str, seq: int):
    return await AsyncClient().get(f"/journal/{seq}", headers=auth(token))


async def test_commits_are_stored_encrypted_and_read_back_unchanged(claimed):
    run, token = claimed
    first, second = commit({"type": "a", "text": "marker-one"}), commit({"type": "b", "n": 1.5})
    assert (await put(token, 1, first)).json() == {"seq": 1}
    assert (await put(token, 2, second)).status_code == 200
    assert (await last(token)).json() == {"seq": 2}
    for seq, body in ((1, first), (2, second)):
        response = await get(token, seq)
        assert response.status_code == 200
        assert response.content == body
    rows = [row async for row in RunCommit.unscoped.filter(run=run).order_by("seq")]
    assert [(row.seq, row.attempt, row.size) for row in rows] == [(1, 1, len(first)), (2, 1, len(second))]
    assert b"marker-one" not in bytes(rows[0].data)
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.journal_seq, stored.journal_bytes) == (2, len(first) + len(second))


async def test_a_commit_is_opaque(claimed):
    _, token = claimed
    body = b'\xff\x00{"format": NaN, ]'
    assert (await put(token, 1, body)).status_code == 200
    assert (await get(token, 1)).content == body


async def test_an_empty_journal_has_no_commits(claimed):
    _, token = claimed
    assert (await last(token)).json() == {"seq": 0}
    assert (await get(token, 1)).status_code == 404


async def test_an_empty_commit_is_refused(claimed):
    run, token = claimed
    assert (await put(token, 1, b"")).status_code == 400
    assert (await Run.unscoped.aget(pk=run.id)).journal_seq == 0


async def test_state_that_cannot_be_decrypted_fails_the_run(claimed):
    run, token = claimed
    assert (await put(token, 1, commit())).status_code == 200
    await RunCommit.unscoped.filter(run=run).aupdate(key_version="v-removed")
    assert (await get(token, 1)).status_code == 401
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.status, stored.error_code) == (Run.Status.FAILED, "state_unreadable")


async def test_state_an_earlier_attempt_cannot_decrypt_does_not_fail_the_run(claimed, monkeypatch):
    run, token = claimed
    assert (await put(token, 1, commit())).status_code == 200

    def replaced_meanwhile(*args):
        Run.unscoped.filter(pk=run.id).update(attempt=2)
        raise CredentialKeyError("removed")

    monkeypatch.setattr(journal, "decrypt_bytes", replaced_meanwhile)
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.read)(run.id, 1, 1)
    assert (await Run.unscoped.aget(pk=run.id)).status == Run.Status.PROVISIONING


async def test_a_deleted_run_is_inactive(claimed):
    run, _ = claimed
    await Run.unscoped.filter(pk=run.id).adelete()
    for call in (
        journal.last,
        lambda *args: journal.read(*args, 1),
        lambda *args: journal.append(*args, 1, b"x"),
    ):
        with pytest.raises(journal.Inactive):
            await sync_to_async(call)(run.id, 1)


async def test_a_retried_commit_is_accepted_once(claimed):
    run, token = claimed
    body = commit()
    assert (await put(token, 1, body)).status_code == 200
    assert (await put(token, 1, body)).status_code == 200
    assert await RunCommit.unscoped.filter(run=run).acount() == 1


async def test_commits_must_follow_the_saved_state(claimed):
    run, token = claimed
    assert (await put(token, 2, commit())).status_code == 409
    assert (await put(token, 0, commit())).status_code == 409
    assert (await put(token, 1, commit({"type": "a"}))).status_code == 200
    assert (await put(token, 1, commit({"type": "b"}))).status_code == 409
    assert (await put(token, 3, commit())).status_code == 409
    assert (await put(token, 2**40, commit())).status_code == 409
    assert await RunCommit.unscoped.filter(run=run).acount() == 1
    assert (await get(token, 0)).status_code == 404
    assert (await get(token, 2)).status_code == 404
    assert (await Run.unscoped.aget(pk=run.id)).status == Run.Status.PROVISIONING


def test_concurrent_appends_store_one_commit(claimed):
    run, _ = claimed
    barrier = threading.Barrier(4)

    def append(n: int) -> journal.Appended:
        try:
            barrier.wait()
            return journal.append(run.id, 1, 1, commit({"n": n}))
        finally:
            connection.close()

    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(append, range(4)))
    assert sorted(result.value for result in results) == ["conflict"] * 3 + ["stored"]
    assert RunCommit.unscoped.filter(run=run).count() == 1


@pytest.mark.parametrize("limit", ["commit", "run", "count"])
async def test_state_up_to_a_limit_is_stored(claimed, monkeypatch, limit):
    run, token = claimed
    body = commit({"text": "x" * 100})
    match limit:
        case "commit":
            monkeypatch.setattr(journal, "COMMIT_BYTES", len(body))
        case "run":
            monkeypatch.setattr(journal, "RUN_BYTES", 2 * len(body))
        case "count":
            monkeypatch.setattr(journal, "RUN_COMMITS", 2)
    assert (await put(token, 1, body)).status_code == 200
    assert (await put(token, 2, body)).status_code == 200
    assert (await Run.unscoped.aget(pk=run.id)).journal_seq == 2


@pytest.mark.parametrize("limit", ["commit", "run", "count"])
async def test_state_over_a_limit_fails_the_run(claimed, monkeypatch, limit):
    run, token = claimed
    body = commit({"text": "x" * 100})
    assert (await put(token, 1, body)).status_code == 200
    match limit:
        case "commit":
            monkeypatch.setattr(journal, "COMMIT_BYTES", len(body) - 1)
        case "run":
            monkeypatch.setattr(journal, "RUN_BYTES", 2 * len(body) - 1)
        case "count":
            monkeypatch.setattr(journal, "RUN_COMMITS", 1)
    response = await put(token, 2, body)
    assert response.status_code == 413
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.status, stored.error_code) == (Run.Status.FAILED, "state_too_large")
    assert await RunCommit.unscoped.filter(run=run).acount() == 0
    assert (await last(token)).status_code == 401


async def test_an_earlier_attempt_can_neither_append_nor_read(claimed, monkeypatch):
    run, token = claimed
    assert (await put(token, 1, commit())).status_code == 200
    # Attempt 1's worker authenticated, then the run moved on to a new attempt before its request was handled.
    await Run.unscoped.filter(pk=run.id).aupdate(attempt=2)
    for body in (commit(), b""):
        with pytest.raises(journal.Inactive):
            await sync_to_async(journal.append)(run.id, 1, 2, body)
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.read)(run.id, 1, 1)
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.last)(run.id, 1)
    # Even a commit over the limits does not fail the run for the attempt that replaced it.
    monkeypatch.setattr(journal, "COMMIT_BYTES", 1)
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.append)(run.id, 1, 2, commit())
    stored = await Run.unscoped.aget(pk=run.id)
    assert (stored.status, stored.journal_seq) == (Run.Status.PROVISIONING, 1)


async def test_ending_the_run_drops_its_saved_state(claimed):
    run, token = claimed
    assert (await put(token, 1, commit())).status_code == 200
    await sync_to_async(services.cancel)(run)
    assert await RunCommit.unscoped.filter(run=run).acount() == 0
    assert (await put(token, 2, commit())).status_code == 401
    assert (await get(token, 1)).status_code == 401
    # The token was valid when this append was authenticated; the run had ended by the time it was handled.
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.append)(run.id, 1, 2, commit())
    assert await RunCommit.unscoped.filter(run=run).acount() == 0


async def test_a_run_past_its_deadline_cannot_append(claimed):
    run, _ = claimed
    await Run.unscoped.filter(pk=run.id).aupdate(deadline=run.deadline.replace(year=2000))
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.append)(run.id, 1, 1, commit())
    with pytest.raises(journal.Inactive):
        await sync_to_async(journal.last)(run.id, 1)


async def test_a_token_reads_only_its_own_runs_state(claimed, user, agent, make_user):
    run, token = claimed
    assert (await put(token, 1, commit({"run": "first"}))).status_code == 200

    def second_run(owner: User, owner_agent: Agent, workspace_id) -> str:
        with workspace_scope(workspace_id):
            conversation = Conversation.objects.create(agent=owner_agent, user=owner)
            services.start_run(conversation=conversation, user_id=owner.id, content="Hi")
            [(_, other_token)] = services.claim_queued(1)
        return other_token

    same_workspace = await sync_to_async(second_run)(user, agent, run.workspace_id)

    def other_workspace() -> str:
        stranger = make_user("stranger@example.com")
        workspace = stranger.personal_workspace
        with workspace_scope(workspace.id):
            stranger_agent = Agent.objects.get()
        return second_run(stranger, stranger_agent, workspace.id)

    elsewhere = await sync_to_async(other_workspace)()
    for other in (same_workspace, elsewhere):
        assert (await last(other)).json() == {"seq": 0}
        assert (await get(other, 1)).status_code == 404
        assert (await put(other, 1, commit({"run": "other"}))).status_code == 200
    assert (await get(token, 1)).content == commit({"run": "first"})
