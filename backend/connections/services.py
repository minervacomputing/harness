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
from connectors.base import ApiKey, Builtin, Connector, OAuth2, OperationError, consent_given
from minerva.config import config
from permissions.models import Grant, PermissionLayer

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
            "scope": oauth.scope_separator.join(oauth.scopes),
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


def authorization_url(
    session,
    *,
    workspace_id: UUID,
    provider: str,
    connection: Connection | None = None,
    scopes: list[str] | None = None,
) -> str:
    """Where the user grants access. With `connection`, the flow renews or extends that connection's
    grant and must end with the same provider account."""
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
        "connection_id": str(connection.pk) if connection is not None else None,
        "client_id": creds.client_id,
        "issued_at": time.time(),
    }
    params = {
        **dict(oauth.authorize_params),
        "client_id": creds.client_id,
        "state": state,
        "response_type": "code",
        "redirect_uri": creds.redirect_uri,
    }
    # Providers without scopes (Notion) let the user choose what to share on their own consent screen.
    if scope := oauth.scope_separator.join(scopes or oauth.scopes):
        params["scope"] = scope
    if oauth.pkce:
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
    if connection is not None and oauth.login_hint:
        params["login_hint"] = connection.external_account_id
    return f"{oauth.authorize_url}?{urlencode(params)}"


def granted_scopes(connection: Connection) -> frozenset[str] | None:
    """The provider scopes the connection's credentials carry; None when unknown."""
    scopes = connection.credentials().get("scopes")
    return frozenset(scopes) if scopes is not None else None


def allowed_actions(connection: Connection, user_id: UUID | None) -> set[str]:
    """Every action the user (or, with None, any user) allows on some resource of the connection."""
    grants = Grant.objects.filter(
        layer__level=PermissionLayer.Level.USER, connection=connection, effect=Grant.Effect.ALLOW
    )
    if user_id is not None:
        grants = grants.filter(layer__user_id=user_id)
    grants = grants.values_list("actions", flat=True)
    return {action for actions in grants for action in actions}


def _lacking(connector: Connector, scopes: frozenset[str], actions: set[str]):
    for op in connector.operations:
        if op.consent and not consent_given(op.consent, scopes):
            used = {action for _, action in op.needs} & actions
            if used:
                yield op, used


def consent_needed(connector: Connector, scopes: frozenset[str] | None, actions: set[str]) -> list[str]:
    """Allowed actions some operation cannot perform yet because the provider did not grant its scopes.
    Unknown scopes need nothing: the provider is then the one to refuse."""
    if scopes is None or not isinstance(connector.auth, OAuth2):
        return []
    missing = {action for _, used in _lacking(connector, scopes, actions) for action in used}
    return [a.id for a in connector.actions if a.id in missing]


def requested_scopes(connector: Connector, actions: set[str]) -> list[str]:
    """The connector's base scopes, plus what the operations behind `actions` need. Stored scopes are not
    trusted to be current: the user may have revoked access at the provider since."""
    requested = list(_oauth(connector).scopes)
    extra: set[str] = set()
    for op, _ in _lacking(connector, frozenset(), actions):
        extra |= op.consent[0]
    return requested + sorted(extra - set(requested))


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
    # RFC 6749 separates scopes with spaces; GitHub uses commas. Older Linear apps return a list.
    if isinstance(scope, list) and all(isinstance(item, str) for item in scope):
        scope = " ".join(scope)
    return sorted(set(scope.replace(",", " ").split())) if isinstance(scope, str) else None


# GitHub answers token requests form-encoded unless asked for JSON.
TOKEN_HEADERS = {"Accept": "application/json"}


def _token_body(response: httpx.Response) -> dict | None:
    """The token response, or None when the provider refused. GitHub reports refusals as HTTP 200 with
    an `error` field."""
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict) or "error" in body or not isinstance(body.get("access_token"), str):
        return None
    return body


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


def _token_request(
    oauth: OAuth2, token_url: str, creds: ClientCredentials, fields: dict[str, str]
) -> httpx.Response:
    """A request to the token endpoint, with the client authenticated the way the provider expects."""
    auth = None
    if oauth.client_auth == "basic":
        auth = httpx.BasicAuth(creds.client_id, creds.client_secret)
    else:
        fields = {"client_id": creds.client_id, "client_secret": creds.client_secret, **fields}
    body: dict[str, Any] = {"json": fields} if oauth.json_body else {"data": fields}
    return httpx.post(token_url, **body, auth=auth, headers=TOKEN_HEADERS, timeout=20)


def exchange_code(connector: Connector, *, code: str, flow: dict) -> dict:
    """Tokens for an authorization code, redeemed by the client that `flow` sent the user to."""
    creds = issuing_client(connector, flow.get("client_id"))
    if creds is None:
        raise ConnectionFlowError(
            f"{connector.name} was reconfigured during the authorization. Please try again."
        )
    oauth = _oauth(connector)
    token_url = oauth.token_url
    fields = {"code": code, "redirect_uri": creds.redirect_uri, "grant_type": "authorization_code"}
    if oauth.pkce:
        fields["code_verifier"] = flow["verifier"]
    response = _token_request(oauth, token_url, creds, fields)
    body = None if response.is_error else _token_body(response)
    if body is None:
        log.warning("OAuth code exchange for %s failed: HTTP %s", connector.slug, response.status_code)
        raise ConnectionFlowError(f"{connector.name} did not accept the authorization. Please try again.")
    return {**_token_payload(body), "client_id": creds.client_id, "token_url": token_url}


def save_connection(
    *,
    workspace_id: UUID,
    owner_id: UUID,
    provider: str,
    tokens: dict,
    connection_id: UUID | None = None,
) -> Connection:
    """Stores the credentials. With `connection_id`, only that connection is updated, and only with
    credentials for the same provider account."""
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
        if connection_id is not None:
            connection = _target(connector, connection_id, account.id)
        else:
            connection = (
                Connection.objects.select_for_update()
                .filter(provider=provider, external_account_id=account.id)
                .first()
            )
        # A shared connection (no owner) is only renewed through its own flow, which admins start.
        shared = connection is not None and connection.owner_id is None and connection_id is not None
        if connection is not None and connection.owner_id != owner_id and not shared:
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


def _target(connector: Connector, connection_id: UUID, account_id: str) -> Connection:
    connection = Connection.objects.select_for_update().filter(pk=connection_id).first()
    if connection is None or connection.provider != connector.slug:
        raise ConnectionFlowError(f"This {connector.name} connection was removed. Connect it again.")
    if connection.external_account_id != account_id:
        raise ConnectionFlowError(
            f"You signed in to a different {connector.name} account. Sign in as {connection.label}."
        )
    return connection


def _keep_refresh_token(previous: dict, tokens: dict) -> dict:
    """Providers may omit the refresh token when the account reconnects. The old one still works if the
    same client issued it; when the old issuer was not recorded, it may not have been. It is only ever
    sent back to the endpoint that issued it."""
    if tokens.get("kind") != "oauth2" or tokens.get("refresh_token") or not previous.get("refresh_token"):
        return tokens
    if previous.get("client_id") is None or previous.get("client_id") != tokens.get("client_id"):
        return tokens
    return {**tokens, "refresh_token": previous["refresh_token"], "token_url": previous.get("token_url")}


def save_api_key(*, workspace_id: UUID, owner_id: UUID, provider: str, key: str) -> Connection:
    if not isinstance(registry.get(provider).auth, ApiKey):
        raise ConnectionFlowError("This provider does not connect with a key.")
    return save_connection(
        workspace_id=workspace_id,
        owner_id=owner_id,
        provider=provider,
        tokens={"kind": "api_key", "key": key},
    )


def enable_builtin(*, workspace_id: UUID, owner_id: UUID, provider: str) -> Connection:
    """Adds a built-in service to the user's connections, once per user. Nothing is allowed on it yet."""
    connector = registry.get(provider)
    if not isinstance(connector.auth, Builtin):
        raise ConnectionFlowError(f"{connector.name} is connected through its own sign-in.")
    lookup = {"workspace_id": workspace_id, "provider": provider, "external_account_id": str(owner_id)}
    existing = Connection.objects.filter(**lookup).first()
    if existing is not None:
        return existing
    connection = Connection(**lookup, owner_id=owner_id, label=connector.name)
    connection.set_credentials({"kind": "builtin"})
    try:
        with transaction.atomic():
            connection.save()
    except IntegrityError:
        return Connection.objects.get(**lookup)
    return connection


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
    creds = issuing_client(connector, tokens.get("client_id"))
    if creds is None:
        log.warning("The OAuth client that issued connection %s is no longer configured", connection.pk)
        return None
    # The endpoint that issued the tokens: a connector that later moves its endpoint keeps working
    # for connections made before, and a changed declaration cannot redirect their refresh tokens.
    token_url = tokens.get("token_url") or _oauth(connector).token_url
    try:
        response = _token_request(
            _oauth(connector),
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
    body = _token_body(response)
    if body is None:
        error = _json_field(response, "error")
        # GitHub's and Slack's refusals of a refresh token that expired or was revoked; other refusals
        # (such as a misconfigured client) are the operator's to fix and leave the connection as it is.
        if error in {"bad_refresh_token", "invalid_grant", "invalid_refresh_token"}:
            return None
        log.warning("Refreshing connection %s failed: %s", connection.pk, error or "unexpected response")
        raise OperationError("PROVIDER_UNAVAILABLE", f"{connector.name} could not refresh the connection.")
    refreshed = _token_payload(body)
    # Providers that do not rotate refresh tokens (such as Google) omit them from the response.
    refreshed["refresh_token"] = refreshed["refresh_token"] or tokens["refresh_token"]
    # A refresh that does not mention scopes keeps the ones granted before.
    if refreshed["scopes"] is None:
        refreshed["scopes"] = tokens.get("scopes")
    refreshed["client_id"] = creds.client_id
    refreshed["token_url"] = token_url
    return refreshed
