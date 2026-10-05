import logging
from urllib.parse import urlsplit

import httpx

from minerva.config import config

log = logging.getLogger(__name__)

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
ACTION = "demo"


def verify(token: str, remote_ip: str | None) -> bool:
    """Checks a Turnstile token with Cloudflare. Fails closed, except in development without a secret."""
    cfg = config()
    if cfg.turnstile_secret_key is None:
        return cfg.debug
    data = {"secret": cfg.turnstile_secret_key.get_secret_value(), "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        response = httpx.post(SITEVERIFY_URL, data=data, timeout=10)
        result = response.json()
    except httpx.HTTPError, ValueError:
        log.warning("Turnstile verification failed to complete.")
        return False
    if not result.get("success"):
        return False
    if cfg.debug:
        return True
    return result.get("hostname") == urlsplit(cfg.site_url).hostname and result.get("action") == ACTION
