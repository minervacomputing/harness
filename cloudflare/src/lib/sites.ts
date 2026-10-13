// How web addresses become the Web connector's site resources, and the host names mail domains are checked
// with (`canonicalHost`, `registrable`, `isReserved`, for addresses.ts). A site resource is one host name, canonical: lowercase ASCII (IDNA), no
// trailing dot, no port. Grants use either an exact host (`docs.python.org`) or a domain with everything
// under it (`*.python.org`, which also covers `python.org` itself). A host's ancestors are those `*.`
// patterns from the host itself up to its registrable domain, so no grant can span a public suffix:
// `*.org`, `*.co.uk` and `*.github.io` do not exist, since sites under them belong to unrelated owners.
//
// Only names under a known public suffix are hosts: IP addresses (in any spelling: an odd IPv4 one such as
// `127.1` or `0x7f.1` ends in a numeric label or under no public suffix), single-label names and
// special-use names (`localhost`, `.internal`, `.local`, `.arpa`, `.onion`, ...) are refused before
// anything resolves them. A host is a bare name: lib/idna.ts refuses any ASCII but letters, digits, hyphens
// and dots before the runtime maps it, so a path, user name, port or percent sign never reaches the
// runtime's host parser (which would cut it off). An address is split by lib/urlsplit.ts and shown as split
// (`WebURL.text`); what is requested is the runtime's serialization of that
// (`WebURL.href`), refused unless it names the same scheme and host on the default port.
//
// The Public Suffix List comes from tldts, private domains included: a suffix tldts knows by no rule is
// unknown. A name that is itself the root of a wildcard rule (`kobe.jp` under `*.kobe.jp`) is a public
// suffix, so nothing registers it.

import { parse } from "tldts";
import { OperationError } from "../gateway/connector.ts";
import { IdnaError, idnaEncode } from "./idna.ts";
import { isIpAddress } from "./ipaddress.ts";
import { UrlError, hostnameOf, portOf, quote, urljoin, urlsplitStrict } from "./urlsplit.ts";

export const PATTERN_PREFIX = "*.";
export const MAX_URL = 2000;

/** Grant ids are at most 200 characters, and a pattern adds two. */
export const MAX_HOST = 198;
/** Resolvable only inside some network, or not through public DNS at all. */
const REFUSED_SUFFIXES = ["arpa", "onion"];
/** Reserved for documentation (RFC 2606): nothing there resolves or receives mail. */
const RESERVED_SUFFIX = "example";
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A label no rule names, to ask whether a wildcard rule covers the labels under a name. */
const PROBE = "minerva0probe";

function invalidHost(): OperationError {
	return new OperationError("INVALID_URL", "Use a web address with a public domain name, such as example.com.");
}

const OPTIONS = { allowPrivateDomains: true, extractHostname: false, validateHostname: false, detectIp: false, mixedInputs: false } as const;

function rule(host: string): { suffix: string | null; known: boolean; domain: string | null } {
	const found = parse(host, OPTIONS);
	return { suffix: found.publicSuffix, known: found.isIcann === true || found.isPrivate === true, domain: found.domain };
}

/** publicsuffixlist's implicit root of a wildcard: `*.<host>` is a rule, so the host is public itself. */
function wildcardRoot(host: string): boolean {
	const probe = `${PROBE}.${host}`;
	const found = rule(probe);
	return found.known && found.suffix === probe;
}

/** `_psl().publicsuffix(host) is not None`: some rule covers the host. */
function hasPublicSuffix(host: string): boolean {
	return rule(host).known || wildcardRoot(host);
}

export function isReserved(host: string): boolean {
	return host.endsWith(`.${RESERVED_SUFFIX}`);
}

/** The domain its owner registered (python.org for docs.python.org); null for a public suffix. */
export function registrable(host: string): string | null {
	const name = host.replace(/\.$/, "").toLowerCase();
	if (name.split(".").includes("")) return null;
	// The root of a wildcard rule is public itself, so nothing registers it.
	if (wildcardRoot(name)) return null;
	const found = rule(name);
	return found.known ? (found.domain ?? null) : null;
}

/** The canonical host name, or INVALID_URL. With `reserved`, names under .example are accepted too. */
export function canonicalHost(raw: string, reserved = false): string {
	const text = raw.trim().replace(/\.+$/, "");
	if (!text || text.length > 253) throw invalidHost();
	if (isIpAddress(text.replace(/^[[\]]+|[[\]]+$/g, "")) !== null) throw new OperationError("INVALID_URL", "Use the site's domain name, not an IP address.");
	let host: string;
	try {
		host = idnaEncode(text).toLowerCase();
	} catch (error) {
		if (error instanceof IdnaError) throw invalidHost();
		throw error;
	}
	const labels = host.split(".");
	if (
		host.length > MAX_HOST ||
		labels.length < 2 ||
		!labels.every((label) => LABEL.test(label)) ||
		// Numeric last labels are how odd IPv4 spellings (127.1, 0x7f.1) look.
		/^[0-9]+$/.test(labels[labels.length - 1] as string) ||
		REFUSED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
		(!hasPublicSuffix(host) && !(reserved && isReserved(host)))
	) {
		throw invalidHost();
	}
	return host;
}

/** The patterns that cover a host, nearest first: *.docs.python.org, *.python.org. */
export function ancestors(host: string): string[] {
	const base = registrable(host);
	if (base === null) return [];
	const labels = host.split(".");
	const depth = base.split(".").length;
	const patterns: string[] = [];
	for (let i = 0; i < labels.length - depth + 1; i++) patterns.push(PATTERN_PREFIX + labels.slice(i).join("."));
	return patterns;
}

export function isPattern(resourceId: string): boolean {
	return resourceId.startsWith(PATTERN_PREFIX);
}

/** Whether this is a canonical exact host or a pattern at or below a registrable domain. */
export function validId(resourceId: string): boolean {
	const host = isPattern(resourceId) ? resourceId.slice(PATTERN_PREFIX.length) : resourceId;
	let canonical: string;
	try {
		canonical = canonicalHost(host);
	} catch (error) {
		if (error instanceof OperationError) return false;
		throw error;
	}
	if (canonical !== host) return false;
	return !isPattern(resourceId) || registrable(host) !== null;
}

export function name(resourceId: string): string {
	return isPattern(resourceId) ? `${resourceId.slice(PATTERN_PREFIX.length)}, including subdomains` : resourceId;
}

/** What a user can allow for a host: the host alone, then each domain around it, widest last. */
export function choices(host: string): string[] {
	return [host, ...ancestors(host)];
}

const DEFAULT_PORTS: { readonly [scheme: string]: number } = { http: 80, https: 443 };
/** Characters kept as they are in a path or query; everything else is percent-encoded. */
const URL_SAFE = "/?:@!$&'()*+,;=-._~%[]";

/** A web address as Minerva requests it. */
export class WebURL {
	readonly scheme: string;
	readonly host: string;
	/** Path and query, percent-encoded; never empty. */
	readonly target: string;
	/**
	 * What is requested: `text` as the runtime's URL parser serializes it, which is what fetch would make of
	 * `text` itself, checked when it was made to name the same scheme and host, on the default port, with no
	 * user name. The parser may still remove dot segments from the path or encode a quote in the query.
	 */
	readonly href: string;

	constructor(scheme: string, host: string, target: string, href: string) {
		this.scheme = scheme;
		this.host = host;
		this.target = target;
		this.href = href;
	}

	/** The address as the agent is shown it. */
	get text(): string {
		return `${this.scheme}://${this.host}${this.target}`;
	}
}

/** Whitespace (U+FEFF too), control characters (C0, DEL and C1, which holds U+0085) and backslashes. */
const NOT_ALLOWED = /[\s\u0000-\u001f\u007f-\u009f\\]/u;

/**
 * A web address as Minerva will request it, or INVALID_URL. `base` resolves relative redirects. The
 * request is built from the parts checked here, never from the raw text, so what is authorized is what is
 * sent. Where `urljoin` or `urlsplit` throw UrlError (brackets around what is no IPv6 address), so does
 * this, which is no owned error: the call fails generically.
 */
export function parseUrl(raw: string, base: WebURL | null = null): WebURL {
	if (raw.length > MAX_URL || NOT_ALLOWED.test(raw)) throw new OperationError("INVALID_URL", "This web address contains characters that are not allowed.");
	const text = base === null ? raw : urljoin(base.text, raw);
	const parts = urlsplitStrict(text);
	const scheme = parts.scheme.toLowerCase();
	const standard = Object.hasOwn(DEFAULT_PORTS, scheme) ? DEFAULT_PORTS[scheme] : undefined;
	if (standard === undefined) throw new OperationError("INVALID_URL", "Only http and https web addresses can be opened.");
	const netloc = parts.netloc;
	if (!netloc || netloc.includes("@")) throw new OperationError("INVALID_URL", "Web addresses with a user name or password are not allowed.");
	let port: number | null;
	try {
		port = portOf(netloc);
	} catch (error) {
		if (error instanceof UrlError) throw new OperationError("INVALID_URL", "This web address has an invalid port.");
		throw error;
	}
	if (port !== null && port !== standard) throw new OperationError("INVALID_URL", "Only web addresses on the standard ports can be opened.");
	const host = canonicalHost(hostnameOf(netloc) ?? "");
	let path = quote(parts.path || "/", URL_SAFE);
	if (!path.startsWith("/")) path = `/${path}`;
	const target = path + (parts.query ? `?${quote(parts.query, URL_SAFE)}` : "");
	// One serialization: the host authorized is the host of the very text fetch is given.
	const parsed = URL.parse(`${scheme}://${host}${target}`);
	if (parsed === null || parsed.protocol !== `${scheme}:` || parsed.hostname !== host || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
		throw invalidHost();
	}
	return new WebURL(scheme, host, target, parsed.href);
}
