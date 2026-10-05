"""Seed the Fernhill Labs Stripe account (test mode only).

Creates the Tably products and GBP prices and a customer and subscription per restaurant: card customers
get a test card, invoiced ones (The Copper Pot) get invoices to pay by bank transfer. Then Trattoria Rossa's
duplicate charge (two succeeded PaymentIntents for one checkout session), Saffron & Salt's failed payment
(an open invoice whose card charge was declined) and Juniper & Rye's unpaid onboarding invoice.

    uv run --with httpx python deploy/demo/seed/seed_stripe.py [--dry-run]

Needs SEED_STRIPE_SECRET_KEY (an sk_test_ key; anything else is refused). Re-running skips what exists:
products by id, prices by lookup key, customers by email, and the rest by `metadata.seed_key`.
"""

import calendar
import sys
from datetime import UTC, datetime
from urllib.parse import urlencode

import _common as c
import story

API = "https://api.stripe.com/v1"
# Pinned so request and response shapes do not depend on the account's default version.
STRIPE_VERSION = "2024-06-20"


def form(params: dict, prefix: str = "") -> list[tuple[str, str]]:
    """Stripe's form encoding: nested dicts as a[b]=c, lists as a[0]=x (or a[0][b]=x)."""
    out: list[tuple[str, str]] = []
    for key, value in params.items():
        name = f"{prefix}[{key}]" if prefix else key
        if value is None:
            continue
        if isinstance(value, dict):
            out += form(value, name)
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    out += form(item, f"{name}[{i}]")
                else:
                    out.append((f"{name}[{i}]", str(item)))
        elif isinstance(value, bool):
            out.append((name, "true" if value else "false"))
        else:
            out.append((name, str(value)))
    return out


class StripeError(Exception):
    def __init__(self, status: int, error: dict) -> None:
        self.status = status
        self.error = error
        super().__init__(f"{status} {error.get('type')}: {error.get('code') or ''} {error.get('message')}")


class Stripe:
    def __init__(self, key: str) -> None:
        import httpx

        self.http = httpx.Client(
            base_url=API,
            auth=(key, ""),
            headers={"Stripe-Version": STRIPE_VERSION},
            timeout=30,
        )

    def request(self, method: str, path: str, params: dict | None = None, idempotency: str = "") -> dict:
        headers = {"Idempotency-Key": idempotency} if idempotency else {}
        if method == "GET":
            r = self.http.get(path, params=form(params or {}))
        else:
            # httpx's data= takes a dict only; a list of pairs has to be encoded by hand.
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urlencode(form(params or {}))
            r = self.http.request(method, path, content=body, headers=headers)
        body = r.json()
        if r.status_code >= 400:
            raise StripeError(r.status_code, body.get("error", {}))
        return body

    def get(self, path: str, **params: object) -> dict:
        return self.request("GET", path, params)

    def post(self, path: str, params: dict | None = None, idempotency: str = "") -> dict:
        return self.request("POST", path, params, idempotency)

    def list_all(self, path: str, **params: object) -> list[dict]:
        items: list[dict] = []
        params = {"limit": 100, **params}
        while True:
            page = self.get(path, **params)
            items += page["data"]
            if not page.get("has_more") or not page["data"]:
                return items
            params["starting_after"] = page["data"][-1]["id"]


def first_of_next_month_utc(now: datetime) -> int:
    year, month = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return calendar.timegm((year, month, 1, 6, 0, 0))


def meta(key: str, **extra: str) -> dict:
    return {"seed": story.SEED_TAG, "seed_key": key, **extra}


def customer_params(cust: story.Customer, ctx: dict[str, str]) -> dict:
    plan = story.PLANS[cust.plan]
    return {
        "name": cust.name,
        "email": cust.email,
        "phone": cust.phone,
        "description": f"{plan.nickname} · {cust.contact} · customer since {cust.since}",
        "address": {"line1": cust.address, "city": cust.city, "postal_code": cust.postcode, "country": "GB"},
        "preferred_locales": ["en-GB"],
        "metadata": meta(
            cust.key,
            owner=cust.contact,
            plan=cust.plan,
            status=cust.status,
            notes=story.fill(cust.notes, **ctx)[:500],
        ),
    }


def main() -> None:
    args = c.parser(__doc__.splitlines()[0]).parse_args()
    c.load_env()
    out = c.Out(args.dry_run)
    now = datetime.now(story.LONDON)
    ctx = story.context(alex="alex@example.com", now=now)

    if args.dry_run:
        dry_run(out, ctx)
        out.done()
        return

    key = c.env("SEED_STRIPE_SECRET_KEY")
    if not key.startswith("sk_test_"):
        c.die(
            "SEED_STRIPE_SECRET_KEY must be a test-mode secret key (sk_test_...). Refusing to touch live data."
        )
    s = Stripe(key)
    account = s.get("/account")
    print(f"Stripe account {account.get('id')} (test mode), API version {STRIPE_VERSION}")

    out.section("Products and prices")
    for product_id, description in story.PRODUCTS.items():
        name = next(p.product_name for p in story.PLANS.values() if p.product_id == product_id)
        try:
            s.get(f"/products/{product_id}")
            out.exists("product", name, product_id)
        except StripeError as e:
            if e.status != 404:
                raise
            s.post(
                "/products",
                {"id": product_id, "name": name, "description": description, "metadata": meta(product_id)},
            )
            out.create("product", name, product_id)

    found = s.get("/prices", lookup_keys=[p.key for p in story.PLANS.values()], limit=10)["data"]
    prices = {p["lookup_key"]: p["id"] for p in found}
    for plan in story.PLANS.values():
        if plan.key in prices:
            out.exists("price", plan.nickname, plan.key)
            continue
        price = s.post(
            "/prices",
            {
                "product": plan.product_id,
                "currency": "gbp",
                "unit_amount": plan.amount_pence,
                "recurring": {"interval": plan.interval},
                "lookup_key": plan.key,
                "nickname": plan.nickname,
                "metadata": meta(plan.key),
            },
        )
        prices[plan.key] = price["id"]
        out.create("price", plan.nickname, f"£{plan.amount_pence / 100:.2f}/{plan.interval}")

    out.section("Customers, payment methods and subscriptions")
    ids: dict[str, str] = {}
    cards: dict[str, str] = {}
    anchor = first_of_next_month_utc(now.astimezone(UTC))
    for cust in story.CUSTOMERS:
        existing = [
            x
            for x in s.get("/customers", email=cust.email, limit=10)["data"]
            if x.get("metadata", {}).get("seed_key") == cust.key
        ]
        if existing:
            obj = existing[0]
            out.exists("customer", cust.name, obj["id"])
        else:
            obj = s.post("/customers", customer_params(cust, ctx))
            out.create("customer", cust.name, obj["id"])
        ids[cust.key] = obj["id"]

        pm = (obj.get("invoice_settings") or {}).get("default_payment_method")
        if not pm and cust.billing == "card":
            pm = s.post(f"/payment_methods/{cust.stripe_pm}/attach", {"customer": obj["id"]})["id"]
            s.post(f"/customers/{obj['id']}", {"invoice_settings": {"default_payment_method": pm}})
            out.create("card", cust.name, cust.stripe_pm)
        cards[cust.key] = pm

        subs = [
            x
            for x in s.list_all("/subscriptions", customer=obj["id"], status="all")
            if x.get("metadata", {}).get("seed_key") == cust.key
            and x["status"] not in ("canceled", "incomplete_expired")
        ]
        plan = story.PLANS[cust.plan]
        if subs:
            out.exists("subscription", cust.name, f"{plan.nickname}, {subs[0]['status']}")
            continue
        params: dict = {
            "customer": obj["id"],
            "items": [{"price": prices[plan.key], "quantity": cust.sites}],
            "metadata": meta(cust.key, plan=cust.plan),
        }
        if cust.billing == "invoice":
            # Invoiced now, paid by bank transfer: the first invoice stays open until Alex marks it paid.
            params |= {"collection_method": "send_invoice", "days_until_due": story.INVOICE_DAYS_UNTIL_DUE}
        else:
            params |= {"default_payment_method": pm, "off_session": True}
        if cust.stripe_deferred:
            # Paid up to the end of this month by other means: the period starts on the 1st, nothing is
            # charged now. (Trattoria's and Saffron's charges this month are created separately below.)
            params |= {"billing_cycle_anchor": anchor, "proration_behavior": "none"}
        sub = s.post("/subscriptions", params)
        out.create("subscription", cust.name, f"{plan.nickname} x {cust.sites}, {sub['status']}")
        latest = s.get(f"/invoices/{sub['latest_invoice']}") if sub.get("latest_invoice") else None
        if latest and latest["status"] == "draft":
            s.post(f"/invoices/{latest['id']}/finalize", {"auto_advance": False})

    out.section("Trattoria Rossa: duplicate charge")
    dup = story.DUPLICATE_CHARGE
    cust_id = ids[dup["customer"]]
    description = story.fill(dup["description"], **ctx)
    made = [
        pi
        for pi in s.list_all("/payment_intents", customer=cust_id)
        if pi.get("metadata", {}).get("seed_key") == "duplicate-charge" and pi["status"] == "succeeded"
    ]
    for attempt in range(len(made) + 1, dup["attempts"] + 1):
        pi = s.post(
            "/payment_intents",
            {
                "amount": dup["amount_pence"],
                "currency": "gbp",
                "customer": cust_id,
                "payment_method": cards[dup["customer"]],
                "payment_method_types": ["card"],
                "confirm": True,
                "off_session": True,
                "description": description,
                "metadata": meta(
                    "duplicate-charge", checkout_session=dup["checkout_session"], attempt=str(attempt)
                ),
            },
        )
        out.create("payment", f"{description} (attempt {attempt})", f"{pi['id']}, {pi['status']}")
    for pi in made:
        out.exists("payment", description, f"{pi['id']}, attempt {pi['metadata'].get('attempt')}")

    out.section("Saffron & Salt: failed payment")
    fail = story.FAILED_INVOICE
    cust_id = ids[fail["customer"]]
    description = story.fill(fail["description"], **ctx)
    invoices = [
        inv
        for inv in s.list_all("/invoices", customer=cust_id)
        if inv.get("metadata", {}).get("seed_key") == "failed-payment" and inv["status"] in ("draft", "open")
    ]
    if invoices:
        inv = invoices[0]
        out.exists(
            "invoice", description, f"{inv['id']}, {inv['status']}, attempts {inv.get('attempt_count')}"
        )
    else:
        inv = s.post(
            "/invoices",
            {
                "customer": cust_id,
                "collection_method": "charge_automatically",
                "auto_advance": False,  # no automatic retries or emails: the story stays as seeded
                "currency": "gbp",
                "description": description,
                "metadata": meta("failed-payment"),
            },
        )
        s.post(
            "/invoiceitems",
            {
                "customer": cust_id,
                "invoice": inv["id"],
                "amount": fail["amount_pence"],
                "currency": "gbp",
                "description": description,
            },
        )
        out.create("invoice", description, inv["id"])
    if inv["status"] == "draft":
        inv = s.post(f"/invoices/{inv['id']}/finalize", {"auto_advance": False})
    if not inv.get("attempt_count"):
        try:
            s.post(f"/invoices/{inv['id']}/pay")
            out.note("the payment unexpectedly succeeded; check the customer's card")
        except StripeError as e:
            if e.error.get("type") != "card_error":
                raise
            out.create(
                "failed charge", description, e.error.get("decline_code") or e.error.get("code") or "declined"
            )

    out.section("Juniper & Rye: unpaid onboarding invoice")
    onb = story.ONBOARDING_INVOICE
    cust_id = ids[onb["customer"]]
    invoices = [
        inv
        for inv in s.list_all("/invoices", customer=cust_id)
        if inv.get("metadata", {}).get("seed_key") == "onboarding-invoice"
        and inv["status"] in ("draft", "open")
    ]
    if invoices:
        inv = invoices[0]
        out.exists("invoice", onb["description"], f"{inv['id']}, {inv['status']}")
    else:
        inv = s.post(
            "/invoices",
            {
                "customer": cust_id,
                "collection_method": "send_invoice",
                "days_until_due": story.INVOICE_DAYS_UNTIL_DUE,
                "auto_advance": False,
                "currency": "gbp",
                "description": onb["description"],
                "metadata": meta("onboarding-invoice"),
            },
        )
        s.post(
            "/invoiceitems",
            {
                "customer": cust_id,
                "invoice": inv["id"],
                "amount": onb["amount_pence"],
                "currency": "gbp",
                "description": onb["description"],
            },
        )
        out.create("invoice", onb["description"], inv["id"])
    if inv["status"] == "draft":
        s.post(f"/invoices/{inv['id']}/finalize", {"auto_advance": False})

    out.done()


def dry_run(out: c.Out, ctx: dict[str, str]) -> None:
    print(f"Stripe (test mode), API version {STRIPE_VERSION}. Nothing is sent.")
    out.section("Products and prices")
    for product_id in story.PRODUCTS:
        out.create("product", product_id)
    for plan in story.PLANS.values():
        out.create("price", plan.nickname, f"{plan.key}: £{plan.amount_pence / 100:.2f}/{plan.interval}")
    out.section("Customers, payment methods and subscriptions")
    for cust in story.CUSTOMERS:
        out.create("customer", cust.name, f"{cust.email}, {cust.contact}")
        plan = f"{story.PLANS[cust.plan].nickname} x {cust.sites}"
        if cust.billing == "invoice":
            due = f"open invoice due in {story.INVOICE_DAYS_UNTIL_DUE} days"
            out.create("subscription", cust.name, f"{plan}, invoiced now, {due}")
            continue
        out.create("card", cust.name, cust.stripe_pm)
        start = "from the 1st of next month, nothing charged now" if cust.stripe_deferred else "charged now"
        out.create("subscription", cust.name, f"{plan}, {start}")
    dup = story.DUPLICATE_CHARGE
    out.section("Trattoria Rossa: duplicate charge")
    for attempt in range(1, dup["attempts"] + 1):
        out.create(
            "payment",
            story.fill(dup["description"], **ctx),
            f"£{dup['amount_pence'] / 100:.2f}, succeeded, checkout_session={dup['checkout_session']}, attempt {attempt}",
        )
    fail = story.FAILED_INVOICE
    out.section("Saffron & Salt: failed payment")
    out.create("invoice", story.fill(fail["description"], **ctx), f"£{fail['amount_pence'] / 100:.2f}, open")
    out.create(
        "failed charge", story.fill(fail["description"], **ctx), "card declined (pm_card_chargeCustomerFail)"
    )
    onb = story.ONBOARDING_INVOICE
    out.section("Juniper & Rye: unpaid onboarding invoice")
    out.create(
        "invoice",
        onb["description"],
        f"£{onb['amount_pence'] / 100:.2f}, open, due in {story.INVOICE_DAYS_UNTIL_DUE} days",
    )


if __name__ == "__main__":
    try:
        main()
    except StripeError as e:
        sys.exit(f"Stripe error: {e}")
