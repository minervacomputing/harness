"""Adds demo visitors who opted in to the newsletter to Bento, and unsubscribes those who later untick the
box. Visitors who opted out stay only in the database (DemoLead), so a Bento broadcast can never reach them."""

import logging

import httpx
from django.utils import timezone

from demo.models import DemoLead
from minerva.config import config

log = logging.getLogger(__name__)

API_URL = "https://api.bentonow.com/v1/batch/subscribers"
COMMANDS_URL = "https://api.bentonow.com/v1/fetch/commands"
TAGS = "minerva-demo,newsletter"
BATCH = 500


def _post(url: str, body: dict) -> bool:
    cfg = config()
    response = httpx.post(
        url,
        params={"site_uuid": cfg.bento_site_uuid},
        auth=(cfg.bento_publishable_key, cfg.bento_secret_key.get_secret_value()),
        headers={"User-Agent": "Minerva-demo/1.0"},
        json=body,
        timeout=30,
    )
    if response.status_code >= 400:
        log.warning("Bento rejected %s: HTTP %s", url, response.status_code)
        return False
    return True


def sync_leads() -> int:
    """Returns the number of leads added or unsubscribed."""
    cfg = config()
    if not (cfg.bento_site_uuid and cfg.bento_publishable_key and cfg.bento_secret_key):
        return 0
    changed = 0
    leads = list(DemoLead.objects.filter(newsletter=True, synced_to_bento_at__isnull=True)[:BATCH])
    if leads and _post(API_URL, {"subscribers": [{"email": lead.email, "tags": TAGS} for lead in leads]}):
        DemoLead.objects.filter(pk__in=[lead.pk for lead in leads]).update(synced_to_bento_at=timezone.now())
        changed += len(leads)
    # After the additions, so someone who unticked the box while their address was being sent is caught here
    # or on the next run.
    for lead in DemoLead.objects.filter(newsletter=False, synced_to_bento_at__isnull=False)[:BATCH]:
        if not _post(COMMANDS_URL, {"command": [{"command": "unsubscribe", "email": lead.email}]}):
            break
        DemoLead.objects.filter(pk=lead.pk, newsletter=False).update(synced_to_bento_at=None)
        changed += 1
    return changed
