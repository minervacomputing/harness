"""Mail addresses as resources: who agents may send mail to.

A recipient resource is one address, canonical: lowercase, ASCII, its domain in IDNA form. Grants use an
exact address (`ada@example.com`) or everyone at one domain (`*@example.com`), which is an address's only
ancestor. A domain pattern never spans a public suffix, and does not cover subdomains: `*@example.com`
does not include `ada@mail.example.com`.

Addresses are lowercased on purpose. Most mail systems ignore case in the local part; a grant that told
`Ada@` from `ada@` would only invite mistakes. Local parts are a strict subset of what RFC 5321 allows: no
quoted strings, comments or non-ASCII characters, which are rare and easy to make look like another
address.

A grant authorizes an address, not a person. Distribution lists, aliases and forwarding rules can deliver
mail sent to one address to other people, and `*@` a shared provider such as gmail.com is everyone with
an account there.
"""

import re

from connectors.base import OperationError
from connectors.web import sites

PATTERN_PREFIX = "*@"
MAX_ADDRESS = 200
MAX_LOCAL = 64
# What a reply would go to when Minerva cannot name it as an address. No grant names it, since it is not an
# address; only allowing every recipient covers it, and then the reply is refused anyway.
UNSUPPORTED = "unsupported"
_LOCAL = re.compile(r"\A[a-z0-9_%+'-]+(\.[a-z0-9_%+'-]+)*\Z")


def _invalid() -> OperationError:
    return OperationError("INVALID_ADDRESS", "Use a mail address such as ada@example.com.")


def _domain(raw: str) -> str:
    try:
        host = sites.canonical_host(raw)
    except OperationError:
        raise _invalid() from None
    if sites.registrable(host) is None:
        raise _invalid()
    return host


def parse(raw: str) -> str:
    """The canonical address, or INVALID_ADDRESS."""
    text = raw.strip().lower()
    if len(text) > MAX_ADDRESS or text.count("@") != 1:
        raise _invalid()
    local, domain = text.split("@")
    if len(local) > MAX_LOCAL or not _LOCAL.match(local):
        raise _invalid()
    address = f"{local}@{_domain(domain)}"
    if len(address) > MAX_ADDRESS:
        raise _invalid()
    return address


def checked(raw: str) -> str:
    """`parse` as a field validator."""
    try:
        return parse(raw)
    except OperationError:
        raise ValueError("must be a mail address such as ada@example.com") from None


def domain_of(address: str) -> str:
    return address.rsplit("@", 1)[1]


def pattern(domain: str) -> str:
    return PATTERN_PREFIX + domain


def ancestors(address: str) -> tuple[str, ...]:
    return (pattern(domain_of(address)),)


def is_pattern(resource_id: str) -> bool:
    return resource_id.startswith(PATTERN_PREFIX)


def valid_id(resource_id: str) -> bool:
    """Whether this is a canonical address or a pattern for a registrable domain or one below it."""
    try:
        if is_pattern(resource_id):
            domain = resource_id.removeprefix(PATTERN_PREFIX)
            return _domain(domain) == domain
        return parse(resource_id) == resource_id
    except OperationError:
        return False


def name(resource_id: str) -> str:
    if is_pattern(resource_id):
        return f"Everyone at {resource_id.removeprefix(PATTERN_PREFIX)}"
    return resource_id


def choices(query: str) -> list[str]:
    """What a user can allow for a pasted address (the address, then its domain) or a domain."""
    text = query.strip().lower()
    if "@" in text and not text.startswith("@") and not is_pattern(text):
        address = parse(text)
        return [address, *ancestors(address)]
    return [pattern(_domain(text.removeprefix(PATTERN_PREFIX).removeprefix("@")))]
