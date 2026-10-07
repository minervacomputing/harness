"""The Bento newsletter list, for newsletter.sync_leads. Bento takes a batch of addresses in one request."""

import logging
from collections.abc import Iterator

import httpx

from minerva.config import config

log = logging.getLogger(__name__)

NAME = "bento"
API_URL = "https://api.bentonow.com/v1/batch/subscribers"
COMMANDS_URL = "https://api.bentonow.com/v1/fetch/commands"
TAGS = "minerva-demo,newsletter"


def configured() -> bool:
    cfg = config()
    return bool(cfg.bento_site_uuid and cfg.bento_publishable_key and cfg.bento_secret_key)


def _post(url: str, body: dict) -> bool:
    cfg = config()
    try:
        response = httpx.post(
            url,
            params={"site_uuid": cfg.bento_site_uuid},
            auth=(cfg.bento_publishable_key, cfg.bento_secret_key.get_secret_value()),
            headers={"User-Agent": "Minerva-demo/1.0"},
            json=body,
            timeout=30,
        )
    except httpx.HTTPError as error:
        log.warning("Bento request failed: %s", type(error).__name__)
        return False
    if response.status_code >= 400:
        log.warning("Bento rejected %s: HTTP %s", url, response.status_code)
        return False
    return True


def subscribe(emails: list[str]) -> Iterator[str]:
    """Yields the addresses Bento accepted: all of them or none."""
    if emails and _post(API_URL, {"subscribers": [{"email": email, "tags": TAGS} for email in emails]}):
        yield from emails


def unsubscribe(email: str) -> bool:
    return _post(COMMANDS_URL, {"command": [{"command": "unsubscribe", "email": email}]})
