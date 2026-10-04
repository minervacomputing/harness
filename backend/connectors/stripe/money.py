"""Amounts as Stripe carries them, and the amount kind that caps refunds and credits.

Stripe gives amounts in a currency's smallest unit: cents for USD, yen for JPY (a zero-decimal currency),
and thousandths for the three-decimal currencies, whose amounts Stripe wants divisible by ten. ISK and UGX
have no fractions, but Stripe still carries them in hundredths that are always 00 (5 UGX is 500). Agents give
amounts in major units, as a decimal string ("12.50"), and Minerva converts them exactly.

Users cap amounts with the hierarchical `amount` kind. An amount, `usd=1250`, is never granted itself. It
sits inside every tier that covers it and inside its currency:

- `usd<=50`, "Up to 50 USD", for every tier at or above the amount, smallest first;
- `usd>20`, "More than 20 USD", for every tier below the amount, largest first;
- `usd`, any amount in USD.

So allowing `usd<=50` allows amounts up to 50 USD, and a workspace ceiling that denies `usd>100` blocks
anything larger, whatever the users below it allow. Tiers come from one fixed ladder per currency (scaled up
for zero-decimal currencies, whose units are small), since an amount's ancestors must name every tier a
grant could use.
"""

import re
from decimal import Decimal, InvalidOperation

from connectors.base import OperationError

AMOUNT = "amount"
# Stripe's zero-decimal currencies (https://docs.stripe.com/currencies#zero-decimal).
ZERO_DECIMAL = frozenset(
    {
        "bif",
        "clp",
        "djf",
        "gnf",
        "jpy",
        "kmf",
        "krw",
        "mga",
        "pyg",
        "rwf",
        "vnd",
        "vuv",
        "xaf",
        "xof",
        "xpf",
    }
)
# Whole-unit currencies Stripe carries as two-decimal (https://docs.stripe.com/currencies#special-cases).
WHOLE_UNIT = frozenset({"isk", "ugx"})
# Three-decimal currencies; Stripe takes their amounts only in multiples of ten.
THREE_DECIMAL = frozenset({"bhd", "jod", "kwd", "omr", "tnd"})
LADDER = (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000)
# Stripe's largest amount: eight digits in the smallest unit.
MAX_MINOR = 99_999_999
CURRENCY = re.compile(r"\A[a-z]{3}\Z")
_TIER = re.compile(r"\A([a-z]{3})(<=|>)([1-9][0-9]{0,8})\Z")
_DECIMAL = re.compile(r"\A[0-9]{1,12}(\.[0-9]{1,3})?\Z")


def exponent(currency: str) -> int:
    if currency in ZERO_DECIMAL:
        return 0
    if currency in THREE_DECIMAL:
        return 3
    return 2


def tiers(currency: str) -> tuple[int, ...]:
    """The currency's tiers in major units."""
    scale = 100 if currency in ZERO_DECIMAL or currency in WHOLE_UNIT else 1
    return tuple(step * scale for step in LADDER)


def _minor(major: int, currency: str) -> int:
    return major * 10 ** exponent(currency)


def parse(value: str, currency: str) -> int:
    """A decimal amount in major units, in the smallest unit; refused unless Stripe can take it exactly."""
    if not _DECIMAL.match(value):
        raise ValueError("must be a positive decimal amount such as 12.50")
    try:
        decimal = Decimal(value)
    except InvalidOperation:
        raise ValueError("must be a positive decimal amount such as 12.50") from None
    scaled = decimal * 10 ** exponent(currency)
    if scaled != scaled.to_integral_value():
        raise ValueError(f"has more decimals than {currency.upper()} has")
    minor = int(scaled)
    if currency in WHOLE_UNIT and minor % 100:
        raise ValueError(f"must be a whole number of {currency.upper()}")
    if currency in THREE_DECIMAL and minor % 10:
        raise ValueError(f"must be a multiple of 0.01 {currency.upper()}")
    if not 0 < minor <= MAX_MINOR:
        raise ValueError("must be more than zero and at most Stripe's largest amount")
    return minor


def major(minor: int, currency: str) -> str:
    """An amount in the smallest unit as a decimal string in major units: 1250 cents is "12.50"."""
    places = exponent(currency)
    shown = 0 if currency in WHOLE_UNIT and minor % 100 == 0 else places
    return f"{Decimal(minor).scaleb(-places):.{shown}f}"


def display(minor: int, currency: str) -> str:
    return f"{major(minor, currency)} {currency.upper()}"


def amount_id(currency: str, minor: int) -> str:
    return f"{currency}={minor}"


def ancestors(currency: str, minor: int) -> tuple[str, ...]:
    steps = tiers(currency)
    up_to = [f"{currency}<={step}" for step in steps if _minor(step, currency) >= minor]
    above = [f"{currency}>{step}" for step in reversed(steps) if _minor(step, currency) < minor]
    return (*up_to, *above, currency)


def name(resource_id: str) -> str | None:
    """The name of a tier or currency users can choose; None for anything else (an amount itself)."""
    if CURRENCY.match(resource_id):
        return f"Any amount in {resource_id.upper()}"
    match = _TIER.match(resource_id)
    if match is None:
        return None
    currency, relation, value = match.group(1), match.group(2), int(match.group(3))
    if value not in tiers(currency):
        return None
    shown = display(_minor(value, currency), currency)
    return f"Up to {shown}" if relation == "<=" else f"More than {shown}"


def choices(currency: str) -> list[str]:
    """What users choose from for one currency: the currency, then each tier."""
    steps = tiers(currency)
    return [
        currency,
        *(f"{currency}<={step}" for step in steps),
        *(f"{currency}>{step}" for step in steps),
    ]


def currency(value: str) -> str:
    value = value.lower()
    if not CURRENCY.match(value):
        raise ValueError("must be a three-letter currency code such as usd")
    return value


def mismatch(expected: str) -> OperationError:
    return OperationError(
        "CURRENCY_MISMATCH",
        f"This is in {expected.upper()}. Give the amount and currency in {expected.upper()}.",
    )
