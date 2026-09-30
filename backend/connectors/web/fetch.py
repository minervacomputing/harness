"""Fetching web pages from the trusted backend, which must never become a way into private networks.

Every hop resolves the host, refuses it unless every address is public, and then connects to the checked
address itself (the Host header and TLS server name stay the site's name, so certificates are verified
against it). A name that resolves differently between the check and the connection cannot redirect the
request. Redirects are followed only within the same host; anything else goes back to the caller, which
authorizes the new host like any other address. No cookies, credentials or proxies are ever used, and
the body is capped before and after decompression.
"""

import asyncio
import codecs
import ipaddress
import re
import socket
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from connectors.base import OperationError
from connectors.web.sites import WebURL, parse_url

Resolver = Callable[[str], Awaitable[list[str]]]
TransportFactory = Callable[[], httpx.AsyncBaseTransport]

USER_AGENT = "Minerva/0.1 (governed AI agent; reads a page when a user's agent asks)"
ACCEPT = (
    "text/html, application/xhtml+xml, text/plain, text/markdown, application/json, application/xml;q=0.9"
)
MAX_BODY = 3 * 1024 * 1024
MAX_REDIRECTS = 5
TOTAL_SECONDS = 25.0
RESOLVE_SECONDS = 5.0
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# Deprecated IPv4-compatible addresses (::a.b.c.d), which some systems still route to the IPv4 address.
_COMPATIBLE = ipaddress.ip_network("::/96")

HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
TEXT_TYPES = frozenset(
    {
        "text/plain",
        "text/markdown",
        "text/x-markdown",
        "text/csv",
        "application/json",
        "application/xml",
        "text/xml",
    }
)


async def system_resolver(host: str) -> list[str]:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError, UnicodeError:
        raise OperationError("SITE_UNREACHABLE", "This site's name could not be found.") from None
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def public_address(text: str) -> bool:
    """Whether an address is on the public internet, including IPv4 addresses carried inside IPv6 ones."""
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        # Scoped IPv6 addresses (fe80::1%en0) and anything else unexpected.
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.teredo is not None or address in _COMPATIBLE:
            return False
        embedded = address.ipv4_mapped or address.sixtofour
        if address in _NAT64:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        if embedded is not None and not public_address(str(embedded)):
            return False
    return address.is_global and not address.is_multicast


@dataclass(frozen=True, slots=True)
class Page:
    url: WebURL
    status: int
    content_type: str
    # "html" or "text"
    form: str
    text: str


@dataclass(frozen=True, slots=True)
class Moved:
    """A redirect to another host (or from https to http), which needs its own authorization."""

    url: WebURL
    target: WebURL


def _unreachable() -> OperationError:
    return OperationError("SITE_UNREACHABLE", "This site could not be reached.")


def _too_large() -> OperationError:
    return OperationError("PAGE_TOO_LARGE", f"This page is larger than Minerva reads ({MAX_BODY} bytes).")


class _Inflater:
    """Bounded decompression: never produces more than it is given room for."""

    def __init__(self, encoding: str | None) -> None:
        self.encoding = encoding
        self.started = False
        if encoding in {"gzip", "x-gzip"}:
            self._obj = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif encoding == "deflate":
            self._obj = zlib.decompressobj()
        elif encoding is not None:
            raise OperationError(
                "UNSUPPORTED_CONTENT", "This site sent its page in an encoding Minerva cannot read."
            )

    def feed(self, data: bytes, room: int) -> bytes:
        if self.encoding is None:
            return data
        try:
            out = self._obj.decompress(data, room)
        except zlib.error:
            # Some servers send raw deflate data without the zlib header.
            if self.encoding != "deflate" or self.started:
                raise OperationError("UNSUPPORTED_CONTENT", "This site sent a damaged page.") from None
            self._obj = zlib.decompressobj(-zlib.MAX_WBITS)
            self.encoding = "raw-deflate"
            return self.feed(data, room)
        self.started = True
        if self._obj.unconsumed_tail:
            raise _too_large()
        return out


async def _body(response: httpx.Response) -> bytes:
    encodings = [
        e.strip().lower() for e in response.headers.get("content-encoding", "").split(",") if e.strip()
    ]
    encodings = [e for e in encodings if e != "identity"]
    if len(encodings) > 1:
        raise OperationError(
            "UNSUPPORTED_CONTENT", "This site sent its page in an encoding Minerva cannot read."
        )
    inflater = _Inflater(encodings[0] if encodings else None)
    body = bytearray()
    received = 0
    async for chunk in response.aiter_raw():
        received += len(chunk)
        if received > MAX_BODY:
            raise _too_large()
        body.extend(inflater.feed(chunk, MAX_BODY - len(body) + 1))
        if len(body) > MAX_BODY:
            raise _too_large()
    return bytes(body)


def _media_type(value: str) -> tuple[str, str | None]:
    mime, _, params = value.partition(";")
    match = re.search(r"charset\s*=\s*\"?([A-Za-z0-9._:-]+)", params, re.IGNORECASE)
    return mime.strip().lower(), match.group(1) if match else None


def _form(mime: str, body: bytes) -> str:
    if mime in HTML_TYPES:
        return "html"
    if mime in TEXT_TYPES or mime.endswith(("+json", "+xml")):
        return "text"
    if not mime:
        start = body[:1024].lstrip().lower()
        if start.startswith((b"<!doctype html", b"<html")):
            return "html"
        if b"\x00" not in start:
            return "text"
    raise OperationError("UNSUPPORTED_CONTENT", f"Minerva cannot read {mime or 'this kind of'} pages yet.")


def _charset(body: bytes, declared: str | None, form: str) -> str:
    for bom, name in (
        (codecs.BOM_UTF8, "utf-8-sig"),
        (codecs.BOM_UTF16_LE, "utf-16"),
        (codecs.BOM_UTF16_BE, "utf-16"),
    ):
        if body.startswith(bom):
            return name
    candidates = [declared]
    if form == "html":
        match = re.search(rb"<meta[^>]+charset\s*=\s*[\"']?([A-Za-z0-9._:-]+)", body[:4096], re.IGNORECASE)
        candidates.append(match.group(1).decode("ascii") if match else None)
    for candidate in candidates:
        if candidate:
            try:
                return codecs.lookup(candidate).name
            except LookupError:
                continue
    return "utf-8"


def decode(body: bytes, content_type: str) -> tuple[str, str, str]:
    """(media type, form, text) of a response body."""
    mime, declared = _media_type(content_type)
    form = _form(mime, body)
    return mime, form, body.decode(_charset(body, declared, form), errors="replace")


class Fetcher:
    def __init__(
        self,
        *,
        resolver: Resolver = system_resolver,
        transport: TransportFactory | None = None,
    ) -> None:
        self._resolver = resolver
        self._transport = transport

    async def _address(self, host: str) -> str:
        try:
            async with asyncio.timeout(RESOLVE_SECONDS):
                addresses = await self._resolver(host)
        except TimeoutError:
            raise OperationError("SITE_UNREACHABLE", "This site's name could not be found in time.") from None
        if not addresses:
            raise OperationError("SITE_UNREACHABLE", "This site's name could not be found.")
        if not all(public_address(a) for a in addresses):
            raise OperationError(
                "SITE_NOT_PUBLIC",
                "This site's name points to a private network, which Minerva does not open.",
            )
        return addresses[0]

    async def _hop(self, url: WebURL) -> Page | str:
        """The page at this address, or the Location it redirects to."""
        address = await self._address(url.host)
        target = httpx.URL(url.text).copy_with(host=address)
        headers = {
            "Host": url.host,
            "User-Agent": USER_AGENT,
            "Accept": ACCEPT,
            "Accept-Encoding": "gzip, deflate",
            "Accept-Language": "en;q=0.9, *;q=0.5",
        }
        client = httpx.AsyncClient(
            transport=self._transport() if self._transport else httpx.AsyncHTTPTransport(retries=0),
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(10.0, connect=5.0),
        )
        try:
            async with (
                client,
                client.stream(
                    "GET", target, headers=headers, extensions={"sni_hostname": url.host}
                ) as response,
            ):
                location = response.headers.get("location")
                if response.status_code in REDIRECT_STATUSES and location:
                    return location
                if response.status_code >= 400:
                    raise OperationError("PAGE_ERROR", f"The site answered with HTTP {response.status_code}.")
                if response.status_code != 200:
                    raise OperationError(
                        "PAGE_ERROR",
                        f"The site answered with HTTP {response.status_code}, which has no page.",
                    )
                body = await _body(response)
                mime, form, text = decode(body, response.headers.get("content-type", ""))
                return Page(url, response.status_code, mime, form, text)
        except httpx.HTTPError as error:
            if "CERTIFICATE_VERIFY_FAILED" in str(error):
                raise OperationError(
                    "SITE_UNREACHABLE",
                    "This site's security certificate is not valid, so Minerva did not open it.",
                ) from None
            raise _unreachable() from None

    async def get(self, url: WebURL) -> Page | Moved:
        try:
            async with asyncio.timeout(TOTAL_SECONDS):
                current = url
                for _ in range(MAX_REDIRECTS + 1):
                    outcome = await self._hop(current)
                    if isinstance(outcome, Page):
                        return outcome
                    try:
                        target = parse_url(outcome, base=current)
                    except OperationError:
                        raise OperationError(
                            "PAGE_ERROR", "The site redirected to an address Minerva does not open."
                        ) from None
                    if target.host != current.host or (current.scheme == "https" and target.scheme == "http"):
                        return Moved(url, target)
                    current = target
        except TimeoutError:
            raise OperationError("SITE_TIMEOUT", "This site took too long to answer.") from None
        raise OperationError("PAGE_ERROR", "The site redirected too many times.")
