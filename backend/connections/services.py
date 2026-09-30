import base64
import hashlib
import logging
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

import httpx
from asgiref.sync import async_to_sync, sync_to_async
from django.db import IntegrityError, transaction
from django.utils import timezone

from connections.models import Connection, OAuthClient
from connectors import registry
from connectors.base import Connector, OperationError
from minerva.config import config

log = logging.getLogger(__name__)
REFRESH_MARGIN_SECONDS = 120
SESSION_KEY = "minerva_oauth"


class ConnectionFlowError(Exception):
    """A user-facing failure while connecting an account."""


@dataclass(frozen=True)
class ClientCredentials:
    client_id: str
    client_secret: str
    redirect_uri: str


def redirect_uri(provider: str) -> str:
    return f"{config().site_url}/api/oauth/{provider}/callback"


def client_credentials(connector: Connector) -> ClientCredentials:
    cfg = config()
    uri = redirect_uri(connector.slug)
    if connector.slug == "todoist" and cfg.todoist_client_id and cfg.todoist_client_secret:
        return ClientCredentials(cfg.todoist_client_id, cfg.todoist_client_secret.get_secret_value(), uri)
    stored = OAuthClient.objects.filter(provider=connector.slug, redirect_uri=uri).first()
    if stored is None:
        stored = _register_client(connector, uri)
    return ClientCredentials(stored.client_id, stored.secret(), uri)


def _register_client(connector: Connector, uri: str) -> OAuthClient:
    if not connector.oauth.registration_url:
        raise ConnectionFlowError(f"{connector.name} is not configured on this instance.")
    response = httpx.post(
        connector.oauth.registration_url,
        json={
            "client_name": "Minerva",
            "redirect_uris": [uri],
            "scope": connector.oauth.scope,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_post",
        },
        timeout=20,
    )
    if response.is_error:
        log.warning("OAuth client registration for %s failed: HTTP %s", connector.slug, response.status_code)
        raise ConnectionFlowError(f"Could not register Minerva with {connector.name}. Try again later.")
    body = response.json()
    client = OAuthClient(provider=connector.slug, redirect_uri=uri, client_id=body["client_id"])
    client.set_secret(body["client_secret"])
    try:
        client.save()
    except IntegrityError:
        return OAuthClient.objects.get(provider=connector.slug, redirect_uri=uri)
    return client


def authorization_url(session, *, workspace_id: UUID, provider: str) -> str:
    connector = registry.get(provider)
    creds = client_credentials(connector)
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    session[SESSION_KEY] = {
        "state": state,
        "verifier": verifier,
        "provider": provider,
        "workspace_id": str(workspace_id),
        "issued_at": time.time(),
    }
    query = urlencode(
        {
            "client_id": creds.client_id,
            "scope": connector.oauth.scope,
            "state": state,
            "response_type": "code",
            "redirect_uri": creds.redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{connector.oauth.authorize_url}?{query}"


def pop_flow(session, *, provider: str, state: str | None) -> dict:
    flow = session.pop(SESSION_KEY, None)
    if (
        not flow
        or not state
        or flow["provider"] != provider
        or not secrets.compare_digest(flow["state"], state)
        or time.time() - flow["issued_at"] > 600
    ):
        raise ConnectionFlowError("This connection attempt expired or did not start here. Please try again.")
    return flow


def _token_payload(body: dict) -> dict:
    payload = {"access_token": body["access_token"], "refresh_token": body.get("refresh_token")}
    expires_in = body.get("expires_in")
    # Legacy Todoist tokens report a 10-year expiry; treat anything beyond a year as non-expiring.
    if isinstance(expires_in, int) and expires_in < 365 * 24 * 3600:
        payload["expires_at"] = int(time.time()) + expires_in
    return payload


def exchange_code(connector: Connector, *, code: str, verifier: str) -> dict:
    creds = client_credentials(connector)
    response = httpx.post(
        connector.oauth.token_url,
        data={
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "code": code,
            "redirect_uri": creds.redirect_uri,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
        },
        timeout=20,
    )
    if response.is_error:
        log.warning("OAuth code exchange for %s failed: HTTP %s", connector.slug, response.status_code)
        raise ConnectionFlowError(f"{connector.name} did not accept the authorization. Please try again.")
    return _token_payload(response.json())


def save_connection(*, workspace_id: UUID, owner_id: UUID, provider: str, tokens: dict) -> Connection:
    connector = registry.get(provider)

    async def fetch_account():
        client = connector.client(tokens["access_token"])
        try:
            return await connector.account(client)
        finally:
            await client.aclose()

    try:
        account = async_to_sync(fetch_account)()
    except OperationError as error:
        raise ConnectionFlowError(error.message) from error
    with transaction.atomic():
        connection = (
            Connection.objects.select_for_update()
            .filter(provider=provider, external_account_id=account.id)
            .first()
        )
        if connection is not None and connection.owner_id != owner_id:
            raise ConnectionFlowError("This account is already connected by someone else in this workspace.")
        if connection is None:
            connection = Connection(
                workspace_id=workspace_id,
                provider=provider,
                owner_id=owner_id,
                external_account_id=account.id,
            )
        connection.label = account.label
        connection.status = Connection.Status.ACTIVE
        connection.set_credentials(tokens)
        connection.save()
    return connection


def access_token(connection_id: UUID) -> str:
    """A usable access token, refreshed when close to expiry.

    Refresh tokens rotate on every refresh, so refreshes are serialized with a row lock: a second caller
    waits and then sees the already-refreshed token instead of spending the consumed refresh token.
    """
    connection = Connection.unscoped.get(pk=connection_id)
    if connection.status != Connection.Status.ACTIVE:
        raise _expired()
    tokens = connection.credentials()
    if not _needs_refresh(tokens):
        return tokens["access_token"]
    with transaction.atomic():
        connection = Connection.unscoped.select_for_update().get(pk=connection_id)
        if connection.status != Connection.Status.ACTIVE:
            raise _expired()
        tokens = connection.credentials()
        if not _needs_refresh(tokens):
            return tokens["access_token"]
        refreshed = _refresh(connection, tokens)
        if refreshed is None:
            connection.status = Connection.Status.ERROR
            connection.save(update_fields=["status", "updated_at"])
        else:
            connection.set_credentials(refreshed)
            connection.save(update_fields=["credentials_ciphertext", "credentials_key_version", "updated_at"])
    if refreshed is None:
        raise _expired()
    return refreshed["access_token"]


aaccess_token = sync_to_async(access_token)


@asynccontextmanager
async def open_client(provider: str, connection_id: UUID) -> AsyncIterator[Any]:
    """A provider client for the connection. A token the provider rejects marks the connection for reconnecting."""
    client = registry.get(provider).client(await aaccess_token(connection_id))
    try:
        yield client
    except OperationError as error:
        if error.code == "CONNECTION_UNAUTHORIZED":
            await Connection.unscoped.filter(pk=connection_id, status=Connection.Status.ACTIVE).aupdate(
                status=Connection.Status.ERROR, updated_at=timezone.now()
            )
        raise
    finally:
        await client.aclose()


def _expired() -> OperationError:
    return OperationError("CONNECTION_UNAUTHORIZED", "The connection expired. Reconnect it in Minerva.")


def _needs_refresh(tokens: dict) -> bool:
    expires_at = tokens.get("expires_at")
    return expires_at is not None and expires_at - time.time() < REFRESH_MARGIN_SECONDS


def _refresh(connection: Connection, tokens: dict) -> dict | None:
    """New tokens, or None when the grant is no longer valid."""
    if not tokens.get("refresh_token"):
        return None
    connector = registry.get(connection.provider)
    creds = client_credentials(connector)
    try:
        response = httpx.post(
            connector.oauth.token_url,
            data={
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "grant_type": "refresh_token",
                "refresh_token": tokens["refresh_token"],
            },
            timeout=20,
        )
    except httpx.HTTPError as error:
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not be reached.") from error
    if response.status_code in {400, 401}:
        return None
    if response.is_error:
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not refresh the connection.")
    refreshed = _token_payload(response.json())
    # Providers that do not rotate refresh tokens (such as Google) omit them from the response.
    refreshed["refresh_token"] = refreshed["refresh_token"] or tokens["refresh_token"]
    return refreshed
