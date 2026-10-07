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
# The public demo's wall-clock limit on a turn when run_timeout_seconds is unset.
DEMO_RUN_TIMEOUT_SECONDS = 300


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
    # "chat" for OpenAI-compatible servers without the Responses API.
    model_api: Literal["responses", "chat"] = "responses"
    # Responses API only. Empty for models that do not reason.
    model_reasoning_effort: str = "medium"
    # Responses API only: the reasoning summary shown in the chat. Empty asks for none, for providers that refuse
    # it (OpenAI may require a verified organization). Reasoning a server streams unasked is shown either way.
    model_reasoning_summary: Literal["", "auto", "concise", "detailed"] = "auto"

    todoist_client_id: str | None = None
    todoist_client_secret: SecretStr | None = None
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    github_client_id: str | None = None
    github_client_secret: SecretStr | None = None
    # The GitHub App's URL name (github.com/apps/<slug>), for the link that installs it on repositories.
    github_app_slug: str | None = None
    # A Notion public integration. Its capabilities, set in Notion, cap what any agent can do there.
    notion_client_id: str | None = None
    notion_client_secret: SecretStr | None = None
    # A Linear OAuth application. Empty: Linear is not offered.
    linear_client_id: str | None = None
    linear_client_secret: SecretStr | None = None
    # A Slack app (bot scopes, HTTPS redirect URL). Empty: Slack is not offered.
    slack_client_id: str | None = None
    slack_client_secret: SecretStr | None = None
    # A Microsoft Entra app registration (Outlook). Empty: Outlook is not offered.
    microsoft_client_id: str | None = None
    microsoft_client_secret: SecretStr | None = None
    # A HubSpot public app (developer platform). Empty: HubSpot is not offered.
    hubspot_client_id: str | None = None
    hubspot_client_secret: SecretStr | None = None
    # An Atlassian OAuth 2.0 (3LO) app for Jira. Empty: Jira is not offered.
    jira_client_id: str | None = None
    jira_client_secret: SecretStr | None = None
    # An Atlassian OAuth 2.0 (3LO) app for Confluence. Empty: Confluence is not offered.
    confluence_client_id: str | None = None
    confluence_client_secret: SecretStr | None = None
    # An Intercom app with OAuth, from Intercom's Developer Hub. Empty: Intercom is not offered.
    intercom_client_id: str | None = None
    intercom_client_secret: SecretStr | None = None
    # A Xero web app (OAuth 2.0 auth code), from developer.xero.com. Empty: Xero is not offered.
    xero_client_id: str | None = None
    xero_client_secret: SecretStr | None = None
    # A Sentry OAuth application, from sentry.io's account settings. Empty: Sentry is not offered.
    sentry_client_id: str | None = None
    sentry_client_secret: SecretStr | None = None
    # Brave Search API key for the Web connector's search; without it, agents can only open pages.
    brave_search_api_key: SecretStr | None = None

    sandbox_provider: Literal["container", "local-process"] = "container"
    sandbox_image: str = "minerva-worker:dev"
    # The Docker volume holding the gateway socket, the one thing a container worker can reach. The socket relay
    # (compose.yaml) creates it; workers mount it read-only and have no network.
    sandbox_gateway_volume: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")] = (
        "minerva-gateway-socket"
    )
    # Optional OCI runtime for workers. Under gVisor it must allow connecting to host sockets: `runsc install
    # --runtime=runsc-minerva -- --host-uds=open`, then "runsc-minerva" here.
    sandbox_runtime: str | None = None
    sandbox_allow_unisolated: bool = False
    max_concurrent_runs: int = 4

    # Wall-clock limit on one turn. Unset, a turn runs until it ends or is stopped; the public demo, whose
    # visitors chat on the operator's model key, then uses DEMO_RUN_TIMEOUT_SECONDS (see run_time_limit).
    run_timeout_seconds: Annotated[int, Field(gt=0)] | None = None
    # Tool calls of one run that execute at once (per gateway process); the rest wait their turn.
    run_tool_concurrency: Annotated[int, Field(gt=0)] = 4
    # Requests one run token can have in flight at once (per gateway process); more are refused with 429.
    run_max_requests_in_flight: Annotated[int, Field(gt=0)] = 16
    # Run token checks queued or running (per gateway process); a request that would add one is refused with
    # 503. Well above what the concurrent runs can send at once.
    gateway_max_unauthenticated_in_flight: Annotated[int, Field(gt=0)] = 128

    # Public demo: visitors pass a Turnstile check, sign in, and chat in one shared, locked workspace.
    demo: bool = False
    demo_turns_per_day: int = 20
    # Turns across all visitors per UTC day, so cheap identities cannot run up the model bill.
    demo_turns_global_per_day: int = 2000
    # Active runs across the whole instance before visitors are told to wait.
    demo_max_active_runs: int = 12
    # Chats are deleted this long after they were started.
    demo_chat_retention_hours: int = 24
    demo_max_conversations: int = 30
    # How long a passed Turnstile check admits a browser, and how many sign-in attempts it covers.
    demo_gate_minutes: int = 20
    demo_gate_uses: int = 5
    turnstile_site_key: str | None = None
    turnstile_secret_key: SecretStr | None = None
    # Sign in with Google (a separate OAuth client from the Google connector's).
    google_login_client_id: str | None = None
    google_login_client_secret: SecretStr | None = None
    # Sign in with Apple: the Services ID, the team, and the Sign in with Apple key (.p8 file).
    apple_client_id: str | None = None
    apple_team_id: str | None = None
    apple_key_id: str | None = None
    apple_private_key_file: Path | None = None
    # The newsletter that demo visitors who opted in are added to: Buttondown when its key is set, else Bento.
    buttondown_api_key: SecretStr | None = None
    bento_site_uuid: str | None = None
    bento_publishable_key: str | None = None
    bento_secret_key: SecretStr | None = None

    @property
    def run_time_limit(self) -> int | None:
        """Seconds a turn may run, or None for no limit."""
        if self.run_timeout_seconds is None and self.demo:
            return DEMO_RUN_TIMEOUT_SECONDS
        return self.run_timeout_seconds

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
