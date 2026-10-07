"""The Buttondown newsletter, for newsletter.sync_leads. Buttondown takes one address per request.

Demo visitors are added as regular subscribers, without a confirmation email: they are recorded only once signed in,
so the demo has already verified their address (an email code, Google or Apple). An address Buttondown already has is
left as it is, so someone who unsubscribed there, or has not yet confirmed a waitlist sign-up, is never resubscribed
from here.
"""

import logging
from collections.abc import Iterator
from urllib.parse import quote

import httpx

from minerva.config import config

log = logging.getLogger(__name__)

NAME = "buttondown"
API_URL = "https://api.buttondown.com/v1/subscribers"
# The free plan has no tags, so the demo marks its subscribers in metadata.
METADATA = {"demo": True}
# Refusals of a new subscriber that a retry would not change: the address is already there, or Buttondown will never
# take it. Any other refusal could be ours to fix, so it stops the run and the address is tried again.
FINAL = {
    "email_already_exists",
    "subscriber_already_exists",
    "email_invalid",
    "email_blocked",
    "subscriber_blocked",
    "subscriber_suppressed",
}


def configured() -> bool:
    return bool(config().buttondown_api_key)


def _request(method: str, url: str, body: dict | None = None) -> httpx.Response | None:
    try:
        return httpx.request(
            method,
            url,
            headers={
                "Authorization": f"Token {config().buttondown_api_key.get_secret_value()}",
                "User-Agent": "Minerva-demo/1.0",
            },
            json=body,
            timeout=10,
        )
    except httpx.HTTPError as error:
        log.warning("Buttondown request failed: %s", type(error).__name__)
        return None


def _json(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _code(response: httpx.Response) -> str:
    return _json(response).get("code") or f"HTTP {response.status_code}"


def subscribe(emails: list[str]) -> Iterator[str]:
    """Yields each address as it is done with: added, already known to Buttondown, or refused by it for good, so it
    cannot hold up the queue. Stops at the first other error, such as a rate limit."""
    for email in emails:
        body = {"email_address": email, "type": "regular", "metadata": METADATA}
        response = _request("POST", API_URL, body)
        if response is None:
            return
        if response.status_code >= 300:
            code = _code(response)
            if code not in FINAL:
                log.warning("Buttondown rejected a subscription: %s", code)
                return
            log.info("Buttondown did not add a demo visitor: %s", code)
        yield email


def unsubscribe(email: str) -> bool:
    url = f"{API_URL}/{quote(email, safe='')}"
    response = _request("PATCH", url, {"type": "unsubscribed"})
    if response is None:
        return False
    if response.status_code < 300 or response.status_code == 404:
        return True
    code = _code(response)
    if code != "subscriber_type_invalid":
        log.warning("Buttondown rejected an unsubscribe: %s", code)
        return False
    # Only an active subscriber can be unsubscribed. The others get no newsletters (already unsubscribed, or
    # undeliverable) and are left as they are, except one who has not confirmed yet and still could: Buttondown's
    # documentation says to delete those instead.
    response = _request("GET", url)
    if response is None:
        return False
    if response.status_code == 404:
        return True
    if response.status_code >= 300:
        log.warning("Buttondown did not return a subscriber: %s", _code(response))
        return False
    kind = _json(response).get("type")
    if kind == "regular":
        # Confirmed since the update was refused: it can be unsubscribed now, on the next run.
        return False
    if kind != "unactivated":
        log.info("Buttondown did not unsubscribe a demo visitor of type %s", kind)
        return True
    response = _request("DELETE", url)
    if response is None:
        return False
    if response.status_code < 300 or response.status_code == 404:
        return True
    log.warning("Buttondown did not delete an unconfirmed subscriber: %s", _code(response))
    return False
