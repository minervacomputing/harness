"""Helpers shared by the seed scripts: settings from .env.demo, --dry-run, output, and a loopback OAuth flow.

Secrets are read from the process environment and the repository's `.env.demo` (the process wins). They
are never printed: output names a variable and says whether it is set, nothing more.
"""

import argparse
import base64
import contextlib
import hashlib
import html
import http.server
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env.demo"
SEED_DIR = Path(__file__).resolve().parent
REDIRECT_PORT = 8765
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/"


def load_env() -> None:
    """Read KEY=VALUE lines from .env.demo into os.environ, without overriding what is already set."""
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        line = line.removeprefix("export ")
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def env(name: str, required: bool = True) -> str:
    value = os.environ.get(name, "").strip()
    if required and not value:
        die(f"{name} is not set. Add it to {ENV_FILE} (or the environment).")
    return value


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def parser(description: str) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be created, without network calls or credentials",
    )
    return p


class Out:
    """Uniform, greppable output: `create`, `exists`, `would create`, `note`."""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.created = 0
        self.skipped = 0

    def create(self, kind: str, name: str, detail: str = "") -> None:
        self.created += 1
        verb = "would create" if self.dry_run else "created"
        print(f"  {verb:<12} {kind:<14} {name}" + (f"  ({detail})" if detail else ""))

    def exists(self, kind: str, name: str, detail: str = "") -> None:
        self.skipped += 1
        print(f"  {'exists':<12} {kind:<14} {name}" + (f"  ({detail})" if detail else ""))

    def note(self, text: str) -> None:
        print(f"  note: {text}")

    def section(self, title: str) -> None:
        print(f"\n== {title}")

    def done(self) -> None:
        verb = "would create" if self.dry_run else "created"
        print(f"\nDone: {self.created} {verb}, {self.skipped} already there.")


def preview(text: str, width: int = 100) -> str:
    one = " ".join(text.split())
    return one if len(one) <= width else one[: width - 1] + "…"


# --------------------------------------------------------------------------------------------------------
# Loopback OAuth (authorization code, with PKCE and state)
# --------------------------------------------------------------------------------------------------------


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class _IPv6Server(http.server.HTTPServer):
    address_family = socket.AF_INET6


def authorize_in_browser(authorize_url: str, state: str, timeout: float = 300) -> str:
    """Open the provider's consent page and wait for its redirect to http://localhost:8765/.

    Returns the authorization code. Exits with the provider's error (for example `invalid_scope`) if
    consent fails. The redirect URI must be registered on the OAuth client exactly as REDIRECT_URI.
    """
    result: dict[str, str] = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
            if "code" not in query and "error" not in query:
                self.send_response(404)
                self.end_headers()
                return
            result.update(query)
            ok = "code" in query and query.get("state") == state
            message = "Seeding can continue. You can close this tab." if ok else "Authorization failed."
            body = f"<!doctype html><title>Fernhill seed</title><p>{html.escape(message)}</p>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            done.set()

        def log_message(self, *args: object) -> None:  # keep codes out of the terminal
            pass

    # "localhost" may resolve to either address family, so listen on both loopback addresses.
    servers = [http.server.HTTPServer(("127.0.0.1", REDIRECT_PORT), Handler)]
    with contextlib.suppress(OSError):
        servers.append(_IPv6Server(("::1", REDIRECT_PORT), Handler))
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Opening the consent page in your browser. If it does not open, visit:\n  {authorize_url}\n")
    webbrowser.open(authorize_url)
    try:
        if not done.wait(timeout):
            die("timed out waiting for the OAuth redirect")
    finally:
        for server in servers:
            server.shutdown()
    if "error" in result:
        detail = result.get("error_description", "")
        die(f"the provider refused consent: {result['error']} {detail}".strip())
    if result.get("state") != state:
        die("the OAuth state did not match; try again")
    return result["code"]
