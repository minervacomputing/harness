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
from connectors.base import ApiKey, Connector, OAuth2, OperationError
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


def _oauth(connector: Connector) -> OAuth2:
    if not isinstance(connector.auth, OAuth2):
        raise ConnectionFlowError(f"{connector.name} does not connect through OAuth.")
    return connector.auth


def _configured(connector: Connector) -> ClientCredentials | None:
    configured = config().oauth_client(_oauth(connector).app)
    if configured is None:
        return None
    client_id, secret = configured
    return ClientCredentials(client_id, secret, redirect_uri(connector.slug))


def _stored(connector: Connector) -> OAuthClient | None:
    return OAuthClient.objects.filter(
        provider=_oauth(connector).app, redirect_uri=redirect_uri(connector.slug)
    ).first()


def client_credentials(connector: Connector) -> ClientCredentials:
    """The client new authorizations use: the operator's, or one registered dynamically."""
    configured = _configured(connector)
    if configured is not None:
        return configured
    stored = _stored(connector) or _register_client(connector, redirect_uri(connector.slug))
    return ClientCredentials(stored.client_id, stored.secret(), stored.redirect_uri)


def issuing_client(connector: Connector, client_id: str | None) -> ClientCredentials | None:
    """The client that issued a connection's tokens; refresh tokens only work with it.

    Tokens saved before the issuer was recorded (client_id None) are tried with the current client.
    """
    configured = _configured(connector)
    if configured is not None and client_id in (None, configured.client_id):
        return configured
    stored = _stored(connector)
    if stored is not None and client_id in (None, stored.client_id):
        return ClientCredentials(stored.client_id, stored.secret(), stored.redirect_uri)
    return None


def _register_client(connector: Connector, uri: str) -> OAuthClient:
    oauth = _oauth(connector)
    if not oauth.registration_url:
        raise ConnectionFlowError(f"{connector.name} is not configured on this instance.")
    response = httpx.post(
        oauth.registration_url,
        json={
            "client_name": "Minerva",
            "redirect_uris": [uri],
            "scope": " ".join(oauth.scopes),
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
    client = OAuthClient(provider=oauth.app, redirect_uri=uri, client_id=body["client_id"])
    client.set_secret(body["client_secret"])
    try:
        client.save()
    except IntegrityError:
        return OAuthClient.objects.get(provider=oauth.app, redirect_uri=uri)
    return client


def available(connector: Connector) -> bool:
    """Whether this instance can connect accounts of this provider."""
    if not isinstance(connector.auth, OAuth2):
        return True
    return connector.auth.registration_url is not None or _configured(connector) is not None


def authorization_url(session, *, workspace_id: UUID, provider: str) -> str:
    connector = registry.get(provider)
    oauth = _oauth(connector)
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
            "scope": " ".join(oauth.scopes),
            "state": state,
            "response_type": "code",
            "redirect_uri": creds.redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            **dict(oauth.authorize_params),
        }
    )
    return f"{oauth.authorize_url}?{query}"


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


def _scopes(body: dict) -> list[str] | None:
    scope = body.get("scope")
    # RFC 6749 separates scopes with spaces; GitHub uses commas.
    return sorted(set(scope.replace(",", " ").split())) if isinstance(scope, str) else None


def _token_payload(body: dict) -> dict:
    payload = {
        "kind": "oauth2",
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token"),
        "scopes": _scopes(body),
    }
    expires_in = body.get("expires_in")
    # Legacy Todoist tokens report a 10-year expiry; treat anything beyond a year as non-expiring.
    if isinstance(expires_in, int) and expires_in < 365 * 24 * 3600:
        payload["expires_at"] = int(time.time()) + expires_in
    return payload


def exchange_code(connector: Connector, *, code: str, verifier: str) -> dict:
    creds = client_credentials(connector)
    response = httpx.post(
        _oauth(connector).token_url,
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
    return {**_token_payload(response.json()), "client_id": creds.client_id}


def save_connection(*, workspace_id: UUID, owner_id: UUID, provider: str, tokens: dict) -> Connection:
    connector = registry.get(provider)
    secret = tokens["key"] if tokens.get("kind") == "api_key" else tokens["access_token"]

    async def fetch_account():
        client = connector.client(secret)
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
        else:
            tokens = _keep_refresh_token(connection.credentials(), tokens)
        connection.label = account.label
        connection.status = Connection.Status.ACTIVE
        connection.set_credentials(tokens)
        connection.save()
    return connection


def _keep_refresh_token(previous: dict, tokens: dict) -> dict:
    """Providers may omit the refresh token when the account reconnects. The old one still works if the
    same client issued it; when the old issuer was not recorded, it may not have been."""
    if tokens.get("kind") != "oauth2" or tokens.get("refresh_token") or not previous.get("refresh_token"):
        return tokens
    if previous.get("client_id") is None or previous.get("client_id") != tokens.get("client_id"):
        return tokens
    return {**tokens, "refresh_token": previous["refresh_token"]}


def save_api_key(*, workspace_id: UUID, owner_id: UUID, provider: str, key: str) -> Connection:
    if not isinstance(registry.get(provider).auth, ApiKey):
        raise ConnectionFlowError("This provider does not connect with a key.")
    return save_connection(
        workspace_id=workspace_id,
        owner_id=owner_id,
        provider=provider,
        tokens={"kind": "api_key", "key": key},
    )


@dataclass(frozen=True)
class Secret:
    value: str
    # The provider scopes the credentials carry; None when unknown.
    scopes: frozenset[str] | None
    generation: int


def _secret(connection: Connection, tokens: dict) -> Secret:
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


def access_token(connection_id: UUID) -> str:
    return access_secret(connection_id).value


aaccess_secret = sync_to_async(access_secret)


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
    secret = await aaccess_secret(connection_id)
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


def _needs_refresh(tokens: dict) -> bool:
    expires_at = tokens.get("expires_at")
    return expires_at is not None and expires_at - time.time() < REFRESH_MARGIN_SECONDS


def _refresh(connection: Connection, tokens: dict) -> dict | None:
    """New tokens, or None when the grant is no longer valid."""
    if not tokens.get("refresh_token"):
        return None
    connector = registry.get(connection.provider)
    creds = issuing_client(connector, tokens.get("client_id"))
    if creds is None:
        log.warning("The OAuth client that issued connection %s is no longer configured", connection.pk)
        return None
    try:
        response = httpx.post(
            _oauth(connector).token_url,
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
    # A refresh that does not mention scopes keeps the ones granted before.
    if refreshed["scopes"] is None:
        refreshed["scopes"] = tokens.get("scopes")
    refreshed["client_id"] = creds.client_id
    return refreshed
