import time

import httpx

from connections import credentials as connection_credentials


def test_refresh_keeps_the_refresh_token_when_the_provider_omits_it(connection, token_endpoint):
    connection.set_credentials({"access_token": "old", "refresh_token": "r1", "expires_at": int(time.time())})
    connection.save()
    _, responses = token_endpoint
    responses.append(httpx.Response(200, json={"access_token": "new", "expires_in": 3600}))
    assert connection_credentials.access_secret(connection.id).value == "new"
    connection.refresh_from_db()
    assert connection.credentials()["refresh_token"] == "r1"


def test_refresh_stores_a_rotated_refresh_token(connection, token_endpoint):
    connection.set_credentials({"access_token": "old", "refresh_token": "r1", "expires_at": int(time.time())})
    connection.save()
    _, responses = token_endpoint
    responses.append(
        httpx.Response(200, json={"access_token": "new", "refresh_token": "r2", "expires_in": 3600})
    )
    connection_credentials.access_secret(connection.id)
    connection.refresh_from_db()
    assert connection.credentials()["refresh_token"] == "r2"
