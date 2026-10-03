"""What Microsoft connectors share: one Entra app, Graph consent, and a Graph client base.

Minerva connects with delegated permissions through one Entra app for work, school and personal accounts
(the `common` endpoint). Every connector asks for `offline_access User.Read` and its own scopes, and each
has its own callback URL on the app.

Graph pages with an `@odata.nextLink` URL. Minerva never requests that URL: it takes only the paging
parameter out of it (`$skip` or `$skiptoken`), checks it, and rebuilds the request itself. Graph's own
error texts never reach the model.
"""

import re
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from connectors.base import OAuth2, OperationError
from connectors.http import ProviderHTTP, default_forbidden

GRAPH = "https://graph.microsoft.com"
API_URL = f"{GRAPH}/v1.0"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
IMMUTABLE_IDS = 'IdType="ImmutableId"'
# Graph's ids are URL-safe base64.
ID = re.compile(r"^[A-Za-z0-9=_-]{10,512}$")
_SKIP = re.compile(r"^\d{1,6}$")
_SKIPTOKEN = re.compile(r"^[A-Za-z0-9._~=+/%:-]{1,880}$")
# The mailbox exists but Graph cannot reach it: on-premises Exchange, or an inactive account.
UNSUPPORTED_MAILBOX = frozenset({"MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI"})


def oauth(*scopes: str) -> OAuth2:
    return OAuth2(
        app="microsoft",
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",  # noqa: S106
        scopes=("offline_access", "User.Read", *scopes),
        authorize_params=(("prompt", "select_account"),),
    )


def consent(*scopes: str) -> tuple[frozenset[str], ...]:
    """Any of these Graph scopes, the first as requested. Microsoft reports granted scopes in their short
    form, or prefixed with Graph's URL, and not always in the case they were requested in."""
    spellings = [form for scope in scopes for form in (scope, f"{GRAPH}/{scope}")]
    spellings += [form.lower() for form in spellings]
    return tuple(frozenset({form}) for form in dict.fromkeys(spellings))


def consent_all(*scopes: str) -> tuple[frozenset[str], ...]:
    """All of these Graph scopes together, each in any of the spellings `consent` accepts."""
    options = [frozenset()]
    for scope in scopes:
        options = [option | spelling for option in options for spelling in consent(scope)]
    return tuple(options)


def segment(value: str) -> str:
    return quote(value, safe="")


def error_code(response: httpx.Response) -> str | None:
    try:
        code = response.json().get("error", {}).get("code")
    except ValueError, AttributeError:
        return None
    return code if isinstance(code, str) else None


def classify(provider: str, response: httpx.Response) -> OperationError | None:
    if error_code(response) in UNSUPPORTED_MAILBOX:
        return OperationError(
            "UNSUPPORTED_ACCOUNT",
            f"This account has no mailbox {provider} lets Minerva use (for example, it is hosted on an "
            "on-premises Exchange server).",
        )
    if response.status_code == 503:
        # Graph throttles with 503 as well as 429.
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    return None


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class User(Model):
    id: str
    display_name: str | None = None
    mail: str | None = None
    user_principal_name: str | None = None
    proxy_addresses: list[str] = []


def page_param(cursor: str) -> dict[str, str]:
    """The query parameter a cursor stands for, or INVALID_CURSOR."""
    kind, _, value = cursor.partition(":")
    if kind == "skip" and _SKIP.match(value):
        return {"$skip": value}
    if kind == "token" and _SKIPTOKEN.match(value):
        return {"$skiptoken": value}
    raise OperationError("INVALID_CURSOR", "This page token is invalid.")


def next_cursor(next_link: Any) -> str | None:
    """The cursor for Graph's next page, taken out of its nextLink; the link itself is never requested."""
    if next_link is None:
        return None
    unusable = OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.")
    if not isinstance(next_link, str) or len(next_link) > 4000:
        raise unusable
    query = parse_qs(urlsplit(next_link).query)
    token = query.get("$skiptoken")
    skip = query.get("$skip")
    if token and len(token) == 1 and not skip and _SKIPTOKEN.match(token[0]):
        return f"token:{token[0]}"
    if skip and len(skip) == 1 and not token and _SKIP.match(skip[0]):
        return f"skip:{skip[0]}"
    raise unusable


class Graph:
    """Base of the Graph clients: authenticated, bounded reads, validated responses."""

    def __init__(
        self,
        provider: str,
        access_token: str,
        *,
        base_url: str = API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        classify: Callable[[str, httpx.Response], OperationError | None] = classify,
    ):
        self.provider = provider
        self._http = ProviderHTTP(
            provider,
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "Prefer": IMMUTABLE_IDS,
            },
            transport=transport,
            forbidden=default_forbidden,
            classify=classify,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    async def get(
        self, path: str, *, params: dict[str, str] | None = None, prefer: str = IMMUTABLE_IDS
    ) -> dict[str, Any]:
        response = await self._http.bounded(
            path,
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError(
                "RESPONSE_TOO_LARGE", f"{self.provider} returned more than Minerva reads."
            ),
            params=params,
            headers={"Prefer": prefer},
        )
        try:
            body = response.json()
        except ValueError:
            raise self.unexpected() from None
        if not isinstance(body, dict):
            raise self.unexpected()
        return body

    def _parse[M: BaseModel](self, model: type[M], value: Any) -> M:
        try:
            return model.model_validate(value)
        except ValidationError as error:
            raise self.unexpected() from error

    def _page[M: BaseModel](self, model: type[M], body: dict[str, Any]) -> tuple[list[M], str | None]:
        items = body.get("value")
        if not isinstance(items, list):
            raise self.unexpected()
        return [self._parse(model, item) for item in items], next_cursor(body.get("@odata.nextLink"))

    async def me(self) -> User:
        return self._parse(
            User, await self.get("/me", params={"$select": "id,displayName,mail,userPrincipalName"})
        )
