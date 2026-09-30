"""Typed instance configuration, read from the environment (and `.env` in development).

Cloud and self-hosted deployments differ only in these values, never in code paths.
"""

from functools import cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import parse_qsl, unquote, urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Csv = Annotated[list[str], NoDecode]

REPO_ROOT = Path(__file__).resolve().parents[2]


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / "backend" / ".env"),
        env_prefix="MINERVA_",
        extra="ignore",
    )

    debug: bool = False
    secret_key: SecretStr
    allowed_hosts: Csv = ["localhost", "127.0.0.1"]
    # Public URL of the app. The React app and the API (under /api) share this origin.
    site_url: str = "http://localhost:5173"
    csrf_trusted_origins: Csv = ["http://localhost:5173"]
    # Host names under which sandboxed workers reach the gateway role.
    gateway_allowed_hosts: Csv = ["gateway", "localhost", "127.0.0.1"]
    signup_open: bool = True

    database_url: str = "postgres://minerva:minerva@localhost:5432/minerva"
    # Direct (unpooled) connection for LISTEN and migrations. Defaults to `database_url`.
    direct_database_url: str | None = None
    # PgBouncer in transaction mode (PlanetScale port 6432): no server-side cursors or prepared statements.
    database_transaction_pooling: bool = False

    # "version:urlsafe-base64-fernet-key" entries; the first one encrypts, all of them decrypt.
    encryption_keys: Annotated[Csv, Field(min_length=1)]

    email_backend: str = "django.core.mail.backends.console.EmailBackend"
    # Backend options as JSON, e.g. {"host": "smtp.example.com", "port": 587, "use_tls": true, ...}
    email_options: dict = {}
    email_from: str = "Minerva <noreply@localhost>"

    model_base_url: str = "https://api.openai.com/v1"
    model_api_key: SecretStr | None = None
    model_name: str = "gpt-5-mini"
    model_max_output_tokens: int = 8192

    todoist_client_id: str | None = None
    todoist_client_secret: SecretStr | None = None
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None

    sandbox_provider: Literal["container", "local-process"] = "container"
    sandbox_image: str = "minerva-worker:dev"
    sandbox_network: str = "minerva-sandbox"
    # Optional OCI runtime for workers, e.g. "runsc" for gVisor.
    sandbox_runtime: str | None = None
    # The gateway URL as seen from inside a sandbox.
    sandbox_gateway_url: str = "http://gateway:8001"
    sandbox_allow_unisolated: bool = False
    max_concurrent_runs: int = 4

    run_timeout_seconds: int = 300
    run_max_writes: int = 3
    run_max_model_calls: int = 30

    def oauth_client(self, app: str) -> tuple[str, str] | None:
        """The operator's OAuth client for an app (MINERVA_<APP>_CLIENT_ID and _SECRET), if configured."""
        client_id = getattr(self, f"{app}_client_id", None)
        secret = getattr(self, f"{app}_client_secret", None)
        if not client_id or secret is None:
            return None
        return client_id, secret.get_secret_value()

    @field_validator(
        "allowed_hosts", "csrf_trusted_origins", "gateway_allowed_hosts", "encryption_keys", mode="before"
    )
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str) and not value.startswith("["):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


@cache
def config() -> Config:
    return Config()  # type: ignore[call-arg]


def database_settings(url: str, *, transaction_pooling: bool) -> dict:
    parts = urlsplit(url)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise ValueError("Only PostgreSQL database URLs are supported.")
    options: dict[str, object] = dict(parse_qsl(parts.query))
    if transaction_pooling:
        options["prepare_threshold"] = None
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parts.path.lstrip("/")),
        "USER": unquote(parts.username or ""),
        "PASSWORD": unquote(parts.password or ""),
        "HOST": parts.hostname or "",
        "PORT": str(parts.port or 5432),
        "CONN_MAX_AGE": 0,
        "CONN_HEALTH_CHECKS": True,
        "DISABLE_SERVER_SIDE_CURSORS": transaction_pooling,
        "OPTIONS": options,
    }
