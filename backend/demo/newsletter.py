"""Adds demo visitors who opted in to the newsletter to its provider, and unsubscribes those who later untick the
box. Visitors who opted out stay only in the database (DemoLead), so a broadcast can never reach them.

The provider is Buttondown when MINERVA_BUTTONDOWN_API_KEY is set, else Bento when its keys are. Each lead records
which provider has the address. After a switch every opted-in lead moves to the new provider, and is unsubscribed from
the old one first while the old one's keys are still set, so a withdrawal only ever needs to reach one provider.
"""

from django.utils import timezone

from demo import bento, buttondown
from demo.models import DemoLead

BATCH = 100
PROVIDERS = (buttondown, bento)


def sync_leads() -> int:
    """Returns the number of leads added or unsubscribed."""
    configured = {provider.NAME: provider for provider in PROVIDERS if provider.configured()}
    if not configured:
        return 0
    changed = 0
    # Withdrawals first, so they never wait behind a long run of additions. Someone who unticks the box while their
    # address is being added is caught on the next run. Each provider has its own queue, so one that keeps failing
    # does not hold up the other's.
    for provider in configured.values():
        withdrawn = DemoLead.objects.filter(newsletter=False, synced_to=provider.NAME).order_by("created_at")
        for lead in withdrawn[:BATCH]:
            if not provider.unsubscribe(lead.email):
                break
            # Cleared even if the box was ticked again meanwhile: the provider no longer sends to the address.
            DemoLead.objects.filter(pk=lead.pk).update(synced_to="", synced_at=None)
            changed += 1
    provider = next(iter(configured.values()))  # Buttondown when both are set
    leads = DemoLead.objects.filter(newsletter=True).exclude(synced_to=provider.NAME).order_by("created_at")
    # An address moving from the other provider leaves it before it is added here, so the two never both send to it.
    # Moves go first, so one that cannot be added yet waits as little as possible with neither; they have their own
    # queue, so an old provider that keeps failing holds up only them. New addresses follow, with those whose old
    # provider's keys are gone.
    ready = []
    for previous in configured.values():
        if previous is provider:
            continue
        for lead in leads.filter(synced_to=previous.NAME)[:BATCH]:
            if not previous.unsubscribe(lead.email):
                break
            ready.append(lead.email)
    ready += leads.exclude(synced_to__in=list(configured)).values_list("email", flat=True)[:BATCH]
    # Each address is marked as soon as the provider has it, so an interrupted run cannot leave one added but unmarked.
    for email in provider.subscribe(ready):
        marked = DemoLead.objects.filter(email=email)
        changed += marked.update(synced_to=provider.NAME, synced_at=timezone.now())
    return changed
