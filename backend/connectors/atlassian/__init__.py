"""What Atlassian connectors share: OAuth 2.0 (3LO), the sites a token reaches, and a client base.

Atlassian allows one callback URL per OAuth app, so each connector has its own app (`MINERVA_JIRA_*`,
`MINERVA_CONFLUENCE_*`). Every connector asks for `offline_access read:me` and its own scopes. Atlassian
rotates refresh tokens; Minerva stores each new one.

One token can reach several sites (a site is one Atlassian cloud: `example.atlassian.net`), the ones the
user picked on Atlassian's consent screen. `accessible-resources` lists them with the scopes granted on
each; Minerva keeps the sites that granted the connector's base scope, once each, ordered by id, and calls
each site's API through `api.atlassian.com/ex/<product>/<cloud id>`. Atlassian's own error texts never
reach the model.
"""

import re
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from connectors.base import OAuth2, OperationError, denied
from connectors.http import ProviderHTTP

API_URL = "https://api.atlassian.com"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_SITES = 50
# Cloud ids are UUIDs; Minerva keeps them in lower case.
CLOUD_ID = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_SITE_URL = re.compile(r"\Ahttps://[a-z0-9-]+(?:\.[a-z0-9-]+)+\Z")


def oauth(app: str, *scopes: str) -> OAuth2:
    return OAuth2(
        app=app,
        authorize_url="https://auth.atlassian.com/authorize",
        token_url="https://auth.atlassian.com/oauth/token",  # noqa: S106
        scopes=("offline_access", "read:me", *scopes),
        authorize_params=(("audience", "api.atlassian.com"), ("prompt", "consent")),
        json_body=True,
        # Atlassian does not document PKCE for 3LO; the state still binds the flow to the browser.
        pkce=False,
    )


def segment(value: str) -> str:
    return quote(value, safe="")


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", alias_generator=to_camel, populate_by_name=True)


class Me(BaseModel):
    model_config = ConfigDict(extra="ignore")
    account_id: str
    name: str | None = None
    email: str | None = None


class Site(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str | None = None
    url: str | None = None
    scopes: list[str] = []

    @property
    def host(self) -> str | None:
        """The site's host, when Atlassian gave a usable address."""
        url = (self.url or "").lower().rstrip("/")
        return url.removeprefix("https://") if _SITE_URL.match(url) else None

    @property
    def label(self) -> str:
        host = self.host
        name = self.name or host or self.id
        return f"{name} ({host})" if host and host != name else name


class AtlassianClient:
    """Base of the Atlassian clients: authenticated, bounded reads, validated responses."""

    def __init__(
        self,
        provider: str,
        product: str,
        access_token: str,
        *,
        scope: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.provider = provider
        self.product = product
        # The scope a site must have granted for this connector to use it.
        self.scope = scope
        self._sites: list[Site] | None = None
        self._http = ProviderHTTP(
            provider,
            base_url=API_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def unexpected(self) -> OperationError:
        return self._http.unexpected()

    def _parse[M: BaseModel](self, model: type[M], value: Any) -> M:
        try:
            return model.model_validate(value)
        except ValidationError as error:
            raise self.unexpected() from error

    async def get(self, path: str, *, params: dict[str, str] | None = None) -> Any:
        response = await self._http.bounded(
            path,
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError(
                "RESPONSE_TOO_LARGE", f"{self.provider} returned more than Minerva reads."
            ),
            params=params,
        )
        try:
            return response.json()
        except ValueError:
            raise self.unexpected() from None

    async def read_post(self, path: str, body: dict[str, Any]) -> Any:
        """A read Atlassian takes as a POST (bulk fetches); never accounted as a write."""
        response = await self._http.bounded(
            path,
            limit=MAX_RESPONSE_BYTES,
            too_large=OperationError(
                "RESPONSE_TOO_LARGE", f"{self.provider} returned more than Minerva reads."
            ),
            method="POST",
            json=body,
        )
        try:
            return response.json()
        except ValueError:
            raise self.unexpected() from None

    def api(self, cloud_id: str) -> str:
        """The path prefix of a site's API."""
        return f"/ex/{self.product}/{segment(cloud_id)}"

    async def me(self) -> Me:
        return self._parse(Me, await self.get("/me"))

    async def sites(self) -> list[Site]:
        """The sites this connection may use, once each, ordered by cloud id."""
        if self._sites is None:
            body = await self.get("/oauth/token/accessible-resources")
            if not isinstance(body, list):
                raise self.unexpected()
            found: dict[str, Site] = {}
            for item in body:
                site = self._parse(Site, item)
                cloud_id = site.id.lower()
                if CLOUD_ID.match(cloud_id) and self.scope in site.scopes and cloud_id not in found:
                    found[cloud_id] = site.model_copy(update={"id": cloud_id})
            if len(found) > MAX_SITES:
                raise OperationError(
                    "PROVIDER_LIMIT", f"This account reaches more {self.provider} sites than Minerva reads."
                )
            self._sites = [found[key] for key in sorted(found)]
        return self._sites

    async def site(self, cloud_id: str | None) -> Site:
        """The site a call names, or the only one this connection reaches. A site it does not reach is refused
        like one without a grant."""
        sites = await self.sites()
        if cloud_id is None:
            if len(sites) != 1:
                raise OperationError(
                    "INVALID_ARGUMENTS",
                    f"This connection reaches {len(sites)} {self.provider} sites; name one with site_id.",
                )
            return sites[0]
        found = next((site for site in sites if site.id == cloud_id.lower()), None)
        if found is None:
            raise denied()
        return found
