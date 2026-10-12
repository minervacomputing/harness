"""Writes vectors.json: what today's Python Stripe connector answers, for connectors-stripe-vectors.test.ts.

The declaration (kinds, actions, auth, operations with their descriptions and input schemas), input
validation (normalized arguments or the executor's message), money.py's conversions and tiers, the client's
error names, and the records the reads build from Stripe objects. The Stripe package and connectors/text.py
are pure: nothing here loads configuration or Django.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/stripe/generate.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.stripe import money, reads  # noqa: E402
from connectors.stripe.client import Charge, Customer, Invoice, Subscription, classify  # noqa: E402
from connectors.stripe.connector import StripeConnector  # noqa: E402


def validation_message(error: ValidationError) -> str:
    """connectors/executor.py `validation_message`, restated: importing the executor loads Django."""
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


def declaration(connector: StripeConnector) -> dict:
    return {
        "slug": connector.slug,
        "name": connector.name,
        "kinds": [
            {
                "id": kind.id,
                "label": kind.label,
                "actions": list(kind.actions),
                "wildcard": kind.wildcard,
                "hierarchical": kind.hierarchical,
                "note": kind.note,
                "listed": kind.listed,
            }
            for kind in connector.kinds
        ],
        "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions],
        "auth": {"type": "api_key", "label": connector.auth.label, "hint": connector.auth.hint},
        "manage_link": list(connector.manage_link()),
        "operations": [
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "output_action": op.output_action,
                "consent": op.consent,
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
                "schema": op.input_model.model_json_schema(),
            }
            for op in connector.operations
        ],
    }


INPUTS = [
    ("list_customers", {}),
    ("list_customers", None),
    ("list_customers", {"email": "  ada@example.com  ", "limit": 25}),
    ("list_customers", {"email": "a\tb@example.com"}),
    ("list_customers", {"email": "ab"}),
    ("list_customers", {"email": "x" * 513}),
    ("list_customers", {"limit": 26}),
    ("list_customers", {"limit": 0}),
    ("list_customers", {"limit": "5"}),
    ("list_customers", {"cursor": "x" * 201}),
    ("list_customers", {"cursor": " tok "}),
    ("list_customers", {"connection_id": "x"}),
    ("list_customers", []),
    ("list_customers", 42),
    ("list_customers", "x"),
    ("refund_payment", []),
    ("get_customer", {"customer": "ada"}),
    ("get_customer", {"customer": "cus_ada"}),
    ("get_customer", {"customer": " cus_ada "}),
    ("get_customer", {"customer": "cus_a-b"}),
    ("get_customer", {"customer": "CUS_ada"}),
    ("get_customer", {"customer": "cus_"}),
    ("get_customer", {"customer": "cus_" + "a" * 107}),
    ("get_customer", {}),
    ("get_customer", {"customer": None}),
    ("list_payments", {"customer": None}),
    ("list_payments", {"customer": "ch_1"}),
    ("list_payments", {"customer": "cus_ada", "limit": 3, "cursor": "tok"}),
    ("list_invoices", {"status": "closed"}),
    ("list_invoices", {"status": " open "}),
    ("list_invoices", {"status": "open", "customer": "cus_ada"}),
    ("list_subscriptions", {"status": "all"}),
    ("list_subscriptions", {"status": "ended"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "50", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": " 50 ", "currency": " USD "}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5.001", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "us"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "u1d"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "usd", "reason": "fraudulent"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "usd", "reason": None}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "usd", "reason": "duplicate"}),
    ("refund_payment", {"payment": "re_1", "amount": "5", "currency": "usd"}),
    ("refund_payment", {"payment": "py_1", "amount": "5", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1.5", "currency": "jpy"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5.5", "currency": "ugx"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1.255", "currency": "kwd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "0", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "0.00", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1e3", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "-1", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1,50", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "NaN", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": ".5", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5.", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "５", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1000000", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "999999.99", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "12.500", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "1.230", "currency": "kwd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5.00", "currency": "jpy"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "99999999", "currency": "jpy"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "100000000", "currency": "jpy"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "12345678901234", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": 5, "currency": "usd"}),
    ("refund_payment", {"payment": "bad", "amount": "5.001", "currency": "usd"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5.001", "currency": "us"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "x" * 17, "currency": "usd"}),
    ("refund_payment", {"amount": "x"}),
    ("refund_payment", {"payment": "ch_ada2", "amount": "5", "currency": "usd", "extra": 1}),
    ("credit_customer", {"customer": "cus_ada", "amount": "20", "currency": "usd", "description": "Sorry"}),
    ("credit_customer", {"customer": "cus_ada", "amount": "1", "currency": "eur", "description": "a\nb"}),
    ("credit_customer", {"customer": "cus_ada", "amount": "1", "currency": "eur", "description": "   "}),
    ("credit_customer", {"customer": "cus_ada", "amount": "1", "currency": "eur", "description": "x" * 351}),
    ("credit_customer", {"customer": "cus_ada", "amount": "0.001", "currency": "eur", "description": "x"}),
    ("credit_customer", {"customer": "cus_ada", "amount": "5000", "currency": "UGX", "description": "x"}),
]


def inputs(connector: StripeConnector) -> list:
    ops = {op.name: op for op in connector.operations}
    out = []
    for name, raw in INPUTS:
        vector = {"op": name, "args": raw}
        try:
            vector["data"] = ops[name].input_model.model_validate(raw if raw is not None else {}).model_dump(mode="json")
        except ValidationError as error:
            vector["message"] = validation_message(error)
        out.append(vector)
    return out


CURRENCIES = ["usd", "eur", "jpy", "krw", "kwd", "bhd", "isk", "ugx"]
VALUES = [
    "0", "1", "01", "1.0", "1.00", "1.000", "1.5", "1.50", "1.05", "1.005", "1.010", "1.230", "12.5", "12.50",
    "12.555", "0.01", "0.001", "0.1", "5", "5000", "5.5", "99", "100", "999999.99", "999999.999", "1000000",
    "99999999", "100000000", "999999999999", "999999999999.999", "1e3", "-1", "+1", "1,50", " 1", "1 ", "",
    ".", "1.", ".5", "1.2345", "NaN", "Infinity", "١", "１",
]
MINORS = [0, 1, 5, 9, 10, 99, 100, 101, 500, 550, 1000, 1250, 1500, 5000, 99999999, -1, -5, -99, -100, -550, -2000, -500000]


def money_vectors() -> dict:
    parsed = []
    for currency in CURRENCIES:
        for value in VALUES:
            try:
                parsed.append({"value": value, "currency": currency, "minor": money.parse(value, currency)})
            except ValueError as error:
                parsed.append({"value": value, "currency": currency, "error": str(error)})
    majors = [
        {"minor": minor, "currency": currency, "major": money.major(minor, currency), "display": money.display(minor, currency)}
        for currency in CURRENCIES
        for minor in MINORS
    ]
    names = {}
    for currency in [*CURRENCIES, "abc"]:
        for tier in money.choices(currency):
            names[tier] = money.name(tier)
    for unnamed in ["usd<=3", "usd=5000", "usd<=050", "USD", "usd<=50 ", "*", "usd>0", "usd<5", "jpy<=50", "jpy<=5000", "us", "usdd", "usd<=1000000000"]:
        names[unnamed] = money.name(unnamed)
    ancestors = [
        {"currency": currency, "minor": minor, "ancestors": list(money.ancestors(currency, minor))}
        for currency in CURRENCIES
        for minor in [1, 99, 100, 101, 4000, 5000, 5001, 1_000_000, 1_000_001, 2_000_000, 99_999_999]
    ]
    currencies = {}
    for value in ["usd", "USD", "Usd", "us", "usdd", "u1d", "KWD", "ǅAB", "ÉUR"]:
        try:
            currencies[value] = money.currency(value)
        except ValueError as error:
            currencies[value] = {"error": str(error)}
    return {
        "parse": parsed,
        "major": majors,
        "names": names,
        "ancestors": ancestors,
        "choices": {currency: money.choices(currency) for currency in CURRENCIES},
        "currency": currencies,
    }


ERRORS = [
    (403, {"error": {"type": "permission_error", "code": None, "message": "SECRET"}}),
    (403, {"error": {"type": "invalid_request_error", "code": "x", "message": "SECRET"}}),
    (401, {"error": {"type": "permission_error"}}),
    (404, {"error": {"type": "invalid_request_error", "code": "resource_missing", "message": "SECRET"}}),
    (404, {}),
    (400, {"error": {"type": "invalid_request_error", "code": "charge_already_refunded", "message": "SECRET"}}),
    (402, {"error": {"type": "card_error", "code": "balance_insufficient"}}),
    (400, {"error": {"type": "invalid_request_error", "code": "parameter_unknown", "message": "SECRET"}}),
    (400, {"error": {"type": "invalid_request_error", "code": "Not A Code<script>", "message": "SECRET"}}),
    (400, {"error": {"type": "invalid_request_error", "code": "a" * 65}}),
    (400, {"error": {"type": "invalid_request_error", "code": 5}}),
    (409, {"error": {"type": "idempotency_error", "code": "idempotency_key_in_use"}}),
    (401, {"error": {"type": "invalid_request_error", "code": None, "message": "SECRET"}}),
    (400, {"error": None}),
    (400, {"error": "charge_already_refunded"}),
    (400, ["charge_already_refunded"]),
    (403, ["x"]),
    (500, {"error": {"type": "api_error", "code": "charge_disputed"}}),
]
RAW_ERRORS = [(400, "not json"), (403, "<html>Forbidden</html>"), (404, ""), (400, "null"), (400, '{"error": {"code": "charge_disputed"}')]


def error_vectors() -> list:
    """Each error body as bytes (hex), as httpx's `response.json()` reads them."""
    bodies = [(status, json.dumps(body).encode()) for status, body in ERRORS]
    bodies += [(status, text.encode()) for status, text in RAW_ERRORS]
    # A byte order mark, which json.loads skips in bytes.
    bodies.append((400, b'\xef\xbb\xbf{"error": {"type": "permission_error"}}'))
    out = []
    for status, body in bodies:
        named = classify("Stripe", httpx.Response(status, content=body))
        out.append({"status": status, "hex": body.hex(), "named": None if named is None else [named.code, str(named)]})
    return out


# Bodies of GET /customers/cus_1, as model_validate_json reads them.
READS = [
    b'{"id":"cus_1"}',
    b'\xef\xbb\xbf{"id":"cus_1"}',
    b' {"id":"cus_1"} ',
    b'{"id":"cus_1","name":"\\ud800"}',
    b'{"id":"cus_1","extra":"\\udc00"}',
    b'{"id":"cus_1","\\ud800":1}',
    b'{"id":"cus_1","nested":[{"x":"\\udfff"}]}',
    b'{"id":"cus_1","name":"\\ud83d\\ude00"}',
    b'{"id":"cus_1","extra":"\xff"}',
    b'{"id":"cus_1","balance":1250.0,"created":1e3}',
    b'{"id":"cus_1","balance":12.5}',
    b'{"id":"cus_2","id":"cus_1"}',
    b'{"id":"cus_1","deleted":null}',
    b'{"id":"cus_1","name":5}',
    b'{"id":"cus_1","balance":null}',
    b'[]',
    b'{"id":"cus_1"',
]


def read_vectors() -> list:
    out = []
    for body in READS:
        vector = {"hex": body.hex()}
        try:
            vector["data"] = Customer.model_validate_json(body).model_dump(mode="json")
        except ValueError:
            vector["data"] = None
        out.append(vector)
    return out


CUSTOMERS = [
    {"id": "cus_1", "name": "Ada", "email": "ada@example.com", "currency": "usd", "balance": -2000, "created": 1790000000},
    {"id": "cus_2", "currency": None, "balance": 500},
    {"id": "cus_3", "currency": "", "balance": 5},
    {"id": "cus_4", "currency": "JPY", "balance": 1500, "delinquent": True, "description": "\U0001f600" * 501},
    {"id": "cus_5", "currency": "isk", "balance": 50000, "description": "x" * 500},
]
CHARGES = [
    {"id": "ch_1", "amount": 5000, "amount_captured": 5000, "amount_refunded": 1250, "status": "succeeded", "currency": "usd", "customer": "cus_1", "captured": True, "payment_method_details": {"type": "card", "card": {"brand": "visa", "last4": "4242"}}, "billing_details": {"name": "Ada", "email": None}, "description": "Order", "failure_message": "y" * 600},
    {"id": "ch_2", "amount": 4000, "amount_captured": 0, "status": "pending", "currency": "JPY", "customer": None},
    # What is left to refund, past 2^53: exact only if the difference is not taken in floats.
    {"id": "ch_4", "amount": 9007199254740991, "amount_captured": 9007199254740991, "amount_refunded": -2, "status": "succeeded", "currency": "usd", "customer": None},
    {"id": "py_3", "amount": 1250, "amount_captured": 1000, "amount_refunded": 1250, "status": "succeeded", "currency": "kwd", "customer": "cus_1", "payment_method_details": {"type": "sepa_debit"}, "failure_code": "card_declined"},
]
INVOICES = [
    {"id": "in_1", "customer": "cus_1", "status": "open", "currency": "usd", "total": 1250, "amount_due": 1250, "number": "A-1", "due_date": 1791000000},
    {"id": "in_2", "customer": None, "currency": "ugx", "total": 500000, "amount_paid": 550, "description": "z" * 501},
]
SUBSCRIPTIONS = [
    {"id": "sub_1", "customer": "cus_1", "status": "active", "currency": "usd", "cancel_at_period_end": True, "items": {"data": [{"quantity": 2, "current_period_end": 1792000000, "price": {"id": "price_1", "nickname": "Pro", "product": "prod_1", "unit_amount": 900, "currency": "usd", "recurring": {"interval": "month", "interval_count": 1}}}, {"price": None}, {"price": {"id": "price_2", "unit_amount": None, "currency": "jpy"}}]}},
    {"id": "sub_2", "customer": "cus_2", "status": "canceled", "items": {"data": [{"price": {"id": f"price_{i}", "unit_amount": i, "currency": "eur"}} for i in range(25)]}},
    {"id": "sub_3", "customer": None, "status": "trialing"},
]


def record_vectors() -> dict:
    return {
        "customers": [{"object": o, "record": reads.customer_data(Customer.model_validate(o))} for o in CUSTOMERS],
        "charges": [{"object": o, "record": reads._charge(Charge.model_validate(o))} for o in CHARGES],
        "invoices": [{"object": o, "record": reads._invoice(Invoice.model_validate(o))} for o in INVOICES],
        "subscriptions": [{"object": o, "record": reads._subscription(Subscription.model_validate(o))} for o in SUBSCRIPTIONS],
    }


def main() -> None:
    connector = StripeConnector()
    vectors = {
        "declaration": declaration(connector),
        "inputs": inputs(connector),
        "money": money_vectors(),
        "errors": error_vectors(),
        "reads": read_vectors(),
        "records": record_vectors(),
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
