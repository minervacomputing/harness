"""OAuth client configuration, the authorization flow, consent, and redeeming authorization codes."""

import base64
import hashlib
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

import httpx
from django.db import IntegrityError

from connections.models import Connection, OAuthClient
from connectors import registry
from connectors.base import Connector, OAuth2, consent_given
from minerva.config import config

log = logging.getLogger(__name__)
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


def _lacking(connector: Connector, scopes: frozenset[str], actions: set[str]):
    """Operations the allowed actions make usable (as for offering tools: every action they need is
    allowed) but the scopes do not cover, each with the actions to blame. An operation that needs several
    actions is blamed on those no covered operation already performs, when there are any."""
    usable = [op for op in connector.operations if {a for _, a in op.needs} <= actions]
    covered = [op for op in usable if not op.consent or consent_given(op.consent, scopes)]
    served = {action for op in covered for _, action in op.needs}
    for op in usable:
        if op not in covered:
            used = {action for _, action in op.needs}
            yield op, (used - served) or used


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
    # HubSpot names the field `scopes`.
    scope = body.get("scope", body.get("scopes"))
    # RFC 6749 separates scopes with spaces; GitHub uses commas. Older Linear apps and HubSpot return a list.
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
