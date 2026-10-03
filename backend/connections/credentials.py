"""Runtime access to stored credentials: usable secrets, refreshing OAuth tokens, and provider clients."""

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from asgiref.sync import sync_to_async
from django.db import transaction
from django.utils import timezone

from connections import oauth
from connections.models import Connection
from connectors import registry
from connectors.base import OperationError

log = logging.getLogger(__name__)
REFRESH_MARGIN_SECONDS = 120


@dataclass(frozen=True)
class Secret:
    value: str
    # The provider scopes the credentials carry; None when unknown.
    scopes: frozenset[str] | None
    generation: int


def _secret(connection: Connection, tokens: dict) -> Secret:
    if tokens.get("kind") == "builtin":
        return Secret("", None, connection.credentials_generation)
    if tokens.get("kind") == "api_key":
        return Secret(tokens["key"], None, connection.credentials_generation)
    scopes = tokens.get("scopes")
    return Secret(
        tokens["access_token"],
        frozenset(scopes) if scopes is not None else None,
        connection.credentials_generation,
    )


def access_secret(connection_id: UUID) -> Secret:
    """A usable credential, with OAuth access tokens refreshed when close to expiry.

    Refresh tokens rotate on every refresh, so refreshes are serialized with a row lock: a second caller
    waits and then sees the already-refreshed token instead of spending the consumed refresh token.
    """
    connection = Connection.unscoped.get(pk=connection_id)
    if connection.status != Connection.Status.ACTIVE:
        raise _expired()
    tokens = connection.credentials()
    if not _needs_refresh(tokens):
        return _secret(connection, tokens)
    with transaction.atomic():
        connection = Connection.unscoped.select_for_update().get(pk=connection_id)
        if connection.status != Connection.Status.ACTIVE:
            raise _expired()
        tokens = connection.credentials()
        if not _needs_refresh(tokens):
            return _secret(connection, tokens)
        refreshed = _refresh(connection, tokens)
        if refreshed is None:
            connection.status = Connection.Status.ERROR
            connection.save(update_fields=["status", "updated_at"])
        else:
            connection.set_credentials(refreshed)
            connection.save(
                update_fields=[
                    "credentials_ciphertext",
                    "credentials_key_version",
                    "credentials_generation",
                    "updated_at",
                ]
            )
    if refreshed is None:
        raise _expired()
    return _secret(connection, refreshed)


@dataclass(frozen=True)
class OpenConnection:
    client: Any
    scopes: frozenset[str] | None


def _unauthorized(error: BaseException) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, OperationError) and current.code == "CONNECTION_UNAUTHORIZED":
            return True
        current = current.__cause__
    return False


@asynccontextmanager
async def open_client(provider: str, connection_id: UUID) -> AsyncIterator[OpenConnection]:
    """A provider client for the connection. A token the provider rejects marks the connection for
    reconnecting, unless the connection got new credentials in the meantime."""
    secret = await sync_to_async(access_secret)(connection_id)
    client = registry.get(provider).client(secret.value)
    try:
        yield OpenConnection(client, secret.scopes)
    except Exception as error:
        if _unauthorized(error):
            await Connection.unscoped.filter(
                pk=connection_id,
                status=Connection.Status.ACTIVE,
                credentials_generation=secret.generation,
            ).aupdate(status=Connection.Status.ERROR, updated_at=timezone.now())
        raise
    finally:
        await client.aclose()


def _expired() -> OperationError:
    return OperationError("CONNECTION_UNAUTHORIZED", "The connection expired. Reconnect it in Minerva.")


def _json_field(response: httpx.Response, field: str) -> str | None:
    try:
        value = response.json().get(field)
    except ValueError, AttributeError:
        return None
    return value if isinstance(value, str) else None


def _needs_refresh(tokens: dict) -> bool:
    expires_at = tokens.get("expires_at")
    return expires_at is not None and expires_at - time.time() < REFRESH_MARGIN_SECONDS


def _refresh(connection: Connection, tokens: dict) -> dict | None:
    """New tokens, or None when the grant is no longer valid."""
    if not tokens.get("refresh_token"):
        return None
    connector = registry.get(connection.provider)
    creds = oauth.issuing_client(connector, tokens.get("client_id"))
    if creds is None:
        log.warning("The OAuth client that issued connection %s is no longer configured", connection.pk)
        return None
    # The endpoint that issued the tokens: a connector that later moves its endpoint keeps working
    # for connections made before, and a changed declaration cannot redirect their refresh tokens.
    token_url = tokens.get("token_url") or oauth._oauth(connector).token_url
    try:
        response = oauth._token_request(
            oauth._oauth(connector),
            token_url,
            creds,
            {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
        )
    except httpx.HTTPError as error:
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not be reached.") from error
    if response.status_code in {400, 401}:
        return None
    if response.is_error:
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not refresh the connection.")
    body = oauth._token_body(response)
    if body is None:
        error = _json_field(response, "error")
        # GitHub's and Slack's refusals of a refresh token that expired or was revoked; other refusals
        # (such as a misconfigured client) are the operator's to fix and leave the connection as it is.
        if error in {"bad_refresh_token", "invalid_grant", "invalid_refresh_token"}:
            return None
        log.warning("Refreshing connection %s failed: %s", connection.pk, error or "unexpected response")
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not refresh the connection.")
    refreshed = oauth._token_payload(body)
    # Providers that do not rotate refresh tokens (such as Google) omit them from the response.
    refreshed["refresh_token"] = refreshed["refresh_token"] or tokens["refresh_token"]
    # A refresh that does not mention scopes keeps the ones granted before.
    if refreshed["scopes"] is None:
        refreshed["scopes"] = tokens.get("scopes")
    refreshed["client_id"] = creds.client_id
    refreshed["token_url"] = token_url
    return refreshed
