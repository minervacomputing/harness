"""What Google connectors share: one OAuth app, the OpenID account, and how Google reports errors."""

from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict

from connectors.base import OAuth2, OperationError
from connectors.http import default_forbidden

USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
RATE_LIMITED = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})
# The API is not enabled in the operator's Google Cloud project.
NOT_CONFIGURED = frozenset({"accessNotConfigured", "SERVICE_DISABLED"})
TOO_LARGE = frozenset({"exportSizeLimitExceeded"})


def oauth(*scopes: str) -> OAuth2:
    return OAuth2(
        app="google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",  # noqa: S106
        scopes=("openid", "email", *scopes),
        # Google only issues a refresh token for offline access, and only on the consent screen. Earlier
        # grants are kept when more scopes are requested.
        authorize_params=(
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "true"),
        ),
        login_hint=True,
    )


def _reasons(response: httpx.Response) -> set[str]:
    try:
        error = response.json().get("error", {})
        reasons = {item.get("reason") for item in error.get("errors", [])}
        reasons |= {item.get("reason") for item in error.get("details", [])}
    except ValueError, AttributeError, TypeError:
        return set()
    return {reason for reason in reasons if isinstance(reason, str)}


def forbidden(provider: str, response: httpx.Response) -> OperationError:
    """Google reports rate limits, an API that is not enabled, and some size limits as 403."""
    reasons = _reasons(response)
    if reasons & RATE_LIMITED:
        return OperationError(
            "PROVIDER_RATE_LIMITED", f"{provider} is rate limiting requests. Try again later."
        )
    if reasons & NOT_CONFIGURED:
        return OperationError(
            "PROVIDER_NOT_CONFIGURED",
            f"The {provider} API is not enabled for this Minerva instance's Google Cloud project. "
            "Ask the operator to enable it.",
        )
    if reasons & TOO_LARGE:
        return OperationError("FILE_TOO_LARGE", f"This file is too large for {provider} to export.")
    return default_forbidden(provider, response)


def segment(value: str) -> str:
    """One URL path segment. Calendar ids contain `@` and `#`; `/` never passes input validation."""
    return quote(value, safe="")


class GoogleUser(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sub: str
    email: str | None = None
    name: str | None = None
