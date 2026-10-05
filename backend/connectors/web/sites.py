"""Sites: how web addresses become resources.

A site resource is one host name, canonical: lowercase ASCII (IDNA), no trailing dot, no port. Grants use
either an exact host (`docs.python.org`) or a domain with everything under it (`*.python.org`, which also
covers `python.org` itself). A host's ancestors are those `*.` patterns from the host itself up to its
registrable domain (the Public Suffix List, through `publicsuffixlist`, MPL-2.0), so no grant can span a
public suffix: `*.org`, `*.co.uk` and `*.github.io` do not exist, since sites under them belong to
unrelated owners.

Only names under a known public suffix are sites. IP addresses, single-label names and special-use
names (`localhost`, `.internal`, `.local`, `.arpa`, `.onion`, ...) are refused before anything resolves
them.
"""

import ipaddress
import re
from dataclasses import dataclass
from functools import cache
from urllib.parse import quote, urljoin, urlsplit

import idna
from publicsuffixlist import PublicSuffixList

from connectors.base import OperationError

PATTERN_PREFIX = "*."
# Grant ids are at most 200 characters, and a pattern adds two.
MAX_HOST = 198
MAX_URL = 2000
# Resolvable only inside some network, or not through public DNS at all.
REFUSED_SUFFIXES = ("arpa", "onion")
# Reserved for documentation (RFC 2606): no name under it is delegated, so nothing there resolves or receives mail.
RESERVED_SUFFIX = "example"
DEFAULT_PORTS = {"http": 80, "https": 443}
_LABEL = re.compile(r"\A(?!-)[a-z0-9-]{1,63}(?<!-)\Z")
# Characters kept as they are in a path or query; everything else is percent-encoded.
_URL_SAFE = "/?:@!$&'()*+,;=-._~%[]"


@cache
def _psl() -> PublicSuffixList:
    # Unknown suffixes are refused rather than treated as one-label public suffixes.
    return PublicSuffixList(accept_unknown=False)


def _invalid_host() -> OperationError:
    return OperationError("INVALID_URL", "Use a web address with a public domain name, such as example.com.")


def canonical_host(raw: str, *, reserved: bool = False) -> str:
    """The canonical host name, or INVALID_URL. With `reserved`, names under .example are accepted too."""
    text = raw.strip().rstrip(".")
    if not text or len(text) > 253:
        raise _invalid_host()
    try:
        ipaddress.ip_address(text.strip("[]"))
    except ValueError:
        pass
    else:
        raise OperationError("INVALID_URL", "Use the site's domain name, not an IP address.")
    try:
        host = idna.encode(text, uts46=True).decode("ascii").lower()
    except idna.IDNAError, UnicodeError:
        raise _invalid_host() from None
    labels = host.split(".")
    if (
        len(host) > MAX_HOST
        or len(labels) < 2
        or not all(_LABEL.match(label) for label in labels)
        # Numeric last labels are how odd IPv4 spellings (127.1, 0x7f.1) look.
        or labels[-1].isdigit()
        or any(host == s or host.endswith(f".{s}") for s in REFUSED_SUFFIXES)
        or (_psl().publicsuffix(host) is None and not (reserved and is_reserved(host)))
    ):
        raise _invalid_host()
    return host


def is_reserved(host: str) -> bool:
    return host.endswith(f".{RESERVED_SUFFIX}")


def registrable(host: str) -> str | None:
    """The domain its owner registered (python.org for docs.python.org); None for a public suffix."""
    return _psl().privatesuffix(host)


def ancestors(host: str) -> tuple[str, ...]:
    """The patterns that cover a host, nearest first: *.docs.python.org, *.python.org."""
    base = registrable(host)
    if base is None:
        return ()
    labels = host.split(".")
    depth = len(base.split("."))
    return tuple(PATTERN_PREFIX + ".".join(labels[i:]) for i in range(len(labels) - depth + 1))


def is_pattern(resource_id: str) -> bool:
    return resource_id.startswith(PATTERN_PREFIX)


def valid_id(resource_id: str) -> bool:
    """Whether this is a canonical exact host or a pattern at or below a registrable domain."""
    host = resource_id.removeprefix(PATTERN_PREFIX)
    try:
        canonical = canonical_host(host)
    except OperationError:
        return False
    if canonical != host:
        return False
    return not is_pattern(resource_id) or registrable(host) is not None


def name(resource_id: str) -> str:
    if is_pattern(resource_id):
        return f"{resource_id.removeprefix(PATTERN_PREFIX)}, including subdomains"
    return resource_id


def choices(host: str) -> list[str]:
    """What a user can allow for a host: the host alone, then each domain around it, widest last."""
    return [host, *ancestors(host)]


@dataclass(frozen=True, slots=True)
class WebURL:
    scheme: str
    host: str
    # Path and query, percent-encoded; never empty.
    target: str

    @property
    def text(self) -> str:
        return f"{self.scheme}://{self.host}{self.target}"


def parse_url(raw: str, base: WebURL | None = None) -> WebURL:
    """A web address as Minerva will request it, or INVALID_URL. `base` resolves relative redirects.

    The request is built from the parts checked here, never from the raw text, so what is authorized is
    what is sent."""
    if len(raw) > MAX_URL or any(c.isspace() or ord(c) < 0x20 or ord(c) == 0x7F or c == "\\" for c in raw):
        raise OperationError("INVALID_URL", "This web address contains characters that are not allowed.")
    if base is not None:
        raw = urljoin(base.text, raw)
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        raise OperationError("INVALID_URL", "Only http and https web addresses can be opened.")
    netloc = parts.netloc
    if not netloc or "@" in netloc:
        raise OperationError("INVALID_URL", "Web addresses with a user name or password are not allowed.")
    try:
        port = parts.port
    except ValueError:
        raise OperationError("INVALID_URL", "This web address has an invalid port.") from None
    if port is not None and port != DEFAULT_PORTS[scheme]:
        raise OperationError("INVALID_URL", "Only web addresses on the standard ports can be opened.")
    host = canonical_host(parts.hostname or "")
    path = quote(parts.path or "/", safe=_URL_SAFE)
    if not path.startswith("/"):
        path = "/" + path
    target = path + (f"?{quote(parts.query, safe=_URL_SAFE)}" if parts.query else "")
    return WebURL(scheme, host, target)
