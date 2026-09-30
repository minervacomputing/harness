import time

import httpx
import pytest

from connections import services
from connections.services import ClientCredentials


@pytest.fixture
def token_endpoint(monkeypatch):
    responses: list[dict] = []
    creds = ClientCredentials("id", "secret", "https://x/cb")
    monkeypatch.setattr(services, "client_credentials", lambda connector: creds)
    monkeypatch.setattr(
        services, "issuing_client", lambda connector, client_id: creds if client_id in (None, "id") else None
    )
    monkeypatch.setattr(
        services.httpx, "post", lambda *args, **kwargs: httpx.Response(200, json=responses.pop(0))
    )
    return responses


def test_refresh_keeps_the_refresh_token_when_the_provider_omits_it(connection, token_endpoint):
    connection.set_credentials({"access_token": "old", "refresh_token": "r1", "expires_at": int(time.time())})
    connection.save()
    token_endpoint.append({"access_token": "new", "expires_in": 3600})
    assert services.access_token(connection.id) == "new"
    connection.refresh_from_db()
    assert connection.credentials()["refresh_token"] == "r1"


def test_refresh_stores_a_rotated_refresh_token(connection, token_endpoint):
    connection.set_credentials({"access_token": "old", "refresh_token": "r1", "expires_at": int(time.time())})
    connection.save()
    token_endpoint.append({"access_token": "new", "refresh_token": "r2", "expires_in": 3600})
    services.access_token(connection.id)
    connection.refresh_from_db()
    assert connection.credentials()["refresh_token"] == "r2"
