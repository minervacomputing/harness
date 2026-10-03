"""Saving connections: new and renewed OAuth grants, API keys, and built-in services."""

from uuid import UUID

from asgiref.sync import async_to_sync
from django.db import IntegrityError, transaction

from connections.models import Connection
from connections.oauth import ConnectionFlowError
from connectors import registry
from connectors.base import ApiKey, Builtin, Connector, OperationError


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
        if isinstance(connector.auth, ApiKey):
            raise ConnectionFlowError(
                f"This key is for a different {connector.name} account. Use a key for {connection.label}."
            )
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


def save_api_key(
    *, workspace_id: UUID, owner_id: UUID, provider: str, key: str, connection_id: UUID | None = None
) -> Connection:
    """With `connection_id`, replaces that connection's key with one for the same account."""
    if not isinstance(registry.get(provider).auth, ApiKey):
        raise ConnectionFlowError("This provider does not connect with a key.")
    return save_connection(
        workspace_id=workspace_id,
        owner_id=owner_id,
        provider=provider,
        tokens={"kind": "api_key", "key": key},
        connection_id=connection_id,
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
