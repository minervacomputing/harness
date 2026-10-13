// How web addresses become the Web connector's site resources, and the host names mail domains are checked
// with (`canonicalHost`, `registrable`, `isReserved`, for addresses.ts). A site resource is one host name,
// canonical: lowercase ASCII (IDNA), no trailing dot, no port. Grants use either an exact host
// (`docs.python.org`) or a domain with everything under it (`*.python.org`, which also covers `python.org`
// itself). A host's ancestors are those `*.` patterns from the host itself up to its registrable domain, so
// no grant can span a public suffix: `*.org`, `*.co.uk` and `*.github.io` do not exist, since sites under
// them belong to unrelated owners.
//
// Only names under a known public suffix are hosts: IP addresses in any spelling, single-label names and
// special-use names (`localhost`, `.internal`, `.local`, `.test`, `.invalid`, `.arpa`, `.onion`, ...) are
// refused before anything resolves them.
//
// The runtime maps and encodes names (`domainToASCII`: UTS #46, non-transitional, then Punycode), and it
// also repairs what it is given: it cuts a name at `/`, `:` or `@`, decodes percent escapes, reads `127.1`
// or `0x7f.1` as an IPv4 address, splits labels at U+3002 or a full-width dot, and drops soft hyphens. So the
// name as written is checked first, and the runtime's answer must be that name modulo case and IDNA mapping:
// as many labels as were written, each ASCII label unchanged but for case, and each other label an A-label.
//
// The Public Suffix List comes from tldts, private domains included: a suffix tldts knows by no rule is
// unknown. A name that is itself the root of a wildcard rule (`kobe.jp` under `*.kobe.jp`) is a public
// suffix, so nothing registers it.

import ipaddr from "ipaddr.js";
import { domainToASCII, domainToUnicode } from "node:url";
import { parse } from "tldts";
import { OperationError } from "../gateway/connector.ts";

export const PATTERN_PREFIX = "*.";
export const MAX_URL = 2000;

/** Grant ids are at most 200 characters, and a pattern adds two. */
export const MAX_HOST = 198;
/** The longest name as written that is encoded at all: a bound on the work. */
const MAX_RAW = 1024;
/** Resolvable only inside some network, or not through public DNS at all. */
const REFUSED_SUFFIXES = ["arpa", "onion"];
/** Reserved for documentation (RFC 2606): nothing there resolves or receives mail. */
const RESERVED_SUFFIX = "example";
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const ASCII_LABEL = /^[A-Za-z0-9-]+$/;
/**
 * A label written in Unicode: letters, marks, digits and hyphens (IDNA 2008's LetterDigits), none of them
 * default-ignorable (joiners, variation selectors, fillers), and a middle dot only between two l's (Catalan
 * `l·l`, in either case). So no symbols, emoji or punctuation, nothing the runtime would drop, and no ASCII it would read
 * as a delimiter.
 */
const U_LABEL = /^(?:(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{M}\p{Nd}-]|[lL]\u00b7[lL])+$/u;
/** The last label of an IPv4 address to the runtime's URL parser: a number, decimal or hexadecimal. */
const NUMERIC = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const A_LABEL = "xn--";
/** A label no rule names, to ask whether a wildcard rule covers the labels under a name. */
const PROBE = "minerva0probe";

function invalidHost(): OperationError {
	return new OperationError("INVALID_URL", "Use a web address with a public domain name, such as example.com.");
}

function ipAddress(): OperationError {
	return new OperationError("INVALID_URL", "Use the site's domain name, not an IP address.");
}

const OPTIONS = { allowPrivateDomains: true, extractHostname: false, validateHostname: false, detectIp: false, mixedInputs: false } as const;

function rule(host: string): { suffix: string | null; known: boolean; domain: string | null } {
	const found = parse(host, OPTIONS);
	return { suffix: found.publicSuffix, known: found.isIcann === true || found.isPrivate === true, domain: found.domain };
}

/** The implicit root of a wildcard rule: `*.<host>` is a rule, so the host is public itself. */
function wildcardRoot(host: string): boolean {
	const probe = `${PROBE}.${host}`;
	const found = rule(probe);
	return found.known && found.suffix === probe;
}

/** Whether some rule of the Public Suffix List covers the host. */
function hasPublicSuffix(host: string): boolean {
	return rule(host).known || wildcardRoot(host);
}

export function isReserved(host: string): boolean {
	return host.endsWith(`.${RESERVED_SUFFIX}`);
}

/** The domain its owner registered (python.org for docs.python.org); null for a public suffix. */
export function registrable(host: string): string | null {
	if (host.split(".").includes("")) return null;
	// The root of a wildcard rule is public itself, so nothing registers it.
	if (wildcardRoot(host)) return null;
	const found = rule(host);
	return found.known ? (found.domain ?? null) : null;
}

/** The name in ASCII, if the runtime encodes exactly what was written; null where it would repair it. */
function encode(raw: string): string | null {
	const written = raw.split(".");
	for (const label of written) {
		if (!label) return null;
		if (ASCII_LABEL.test(label)) {
			// Reserved for encodings like Punycode's, which has its own prefix.
			if (label.slice(2, 4) === "--" && !label.toLowerCase().startsWith(A_LABEL)) return null;
		} else if (!U_LABEL.test(label)) {
			return null;
		}
	}
	const encoded = domainToASCII(raw);
	const labels = encoded.split(".");
	if (!encoded || labels.length !== written.length) return null;
	const same = labels.every((label, i) => {
		const before = written[i] as string;
		if (label.startsWith(A_LABEL) && !isALabel(label)) return false;
		return ASCII_LABEL.test(before) ? label === before.toLowerCase() : label.startsWith(A_LABEL);
	});
	return same ? encoded : null;
}

/**
 * Whether the label is the encoding of a label in Unicode that may be written (U_LABEL) and encodes back to
 * it. workerd's encoder passes any `xn--` label through.
 */
function isALabel(label: string): boolean {
	const decoded = domainToUnicode(label);
	return /[^\x00-\x7f]/.test(decoded) && U_LABEL.test(decoded) && domainToASCII(decoded) === label;
}

/** The canonical host name, or INVALID_URL. With `reserved`, names under .example are accepted too. */
export function canonicalHost(raw: string, reserved = false): string {
	if (raw.length > MAX_RAW) throw invalidHost();
	if (ipaddr.isValid(raw.replace(/^\[(.*)\]$/, "$1"))) throw ipAddress();
	const host = encode(raw);
	if (host === null) throw invalidHost();
	const labels = host.split(".");
	if (
		host.length > MAX_HOST ||
		labels.length < 2 ||
		!labels.every((label) => LABEL.test(label)) ||
		NUMERIC.test(labels[labels.length - 1] as string) ||
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

/** A web address as Minerva requests it, and as the agent is shown it. */
export class WebURL {
	readonly scheme: string;
	readonly host: string;
	/** The runtime's serialization of the address, without a fragment: exactly what is requested. */
	readonly href: string;

	constructor(scheme: string, host: string, href: string) {
		this.scheme = scheme;
		this.host = host;
		this.href = href;
	}
}

/** Whitespace (U+FEFF too), control characters (C0, DEL and C1, which holds U+0085) and backslashes. */
const NOT_ALLOWED = /[\s\u0000-\u001f\u007f-\u009f\\]/u;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * A web address as Minerva will request it, or INVALID_URL. `base` resolves relative redirects. The scheme,
 * user name, host and port are read from the text as written, before the runtime's URL parser (which would
 * repair `https:example.com`, `https:///example.com`, a backslash, or a percent-encoded host), and the
 * parser's answer must name that same scheme and canonical host on the default port. What is requested is
 * that answer's serialization, so what is authorized is what is sent.
 */
export function parseUrl(raw: string, base: WebURL | null = null): WebURL {
	if (raw.length > MAX_URL || NOT_ALLOWED.test(raw)) throw new OperationError("INVALID_URL", "This web address contains characters that are not allowed.");
	const written = SCHEME.exec(raw);
	let scheme: string;
	let rest: string;
	if (written !== null) {
		scheme = (written[1] as string).toLowerCase();
		rest = raw.slice(written[0].length);
		if (!Object.hasOwn(DEFAULT_PORTS, scheme)) throw new OperationError("INVALID_URL", "Only http and https web addresses can be opened.");
		if (!rest.startsWith("//")) throw invalidHost();
	} else if (base !== null) {
		scheme = base.scheme;
		rest = raw;
	} else {
		throw new OperationError("INVALID_URL", "Only http and https web addresses can be opened.");
	}
	let host: string;
	if (rest.startsWith("//")) {
		const authority = rest.slice(2).split(/[/?#]/, 1)[0] as string;
		if (authority.includes("@")) throw new OperationError("INVALID_URL", "Web addresses with a user name or password are not allowed.");
		if (authority.startsWith("[")) throw ipAddress();
		const colon = authority.indexOf(":");
		const port = colon < 0 ? "" : authority.slice(colon + 1);
		if (!/^[0-9]{0,5}$/.test(port) || Number(port) > 65535) throw new OperationError("INVALID_URL", "This web address has an invalid port.");
		if (port !== "" && Number(port) !== DEFAULT_PORTS[scheme]) throw new OperationError("INVALID_URL", "Only web addresses on the standard ports can be opened.");
		host = canonicalHost(colon < 0 ? authority : authority.slice(0, colon));
	} else {
		host = (base as WebURL).host;
	}
	const url = URL.parse(raw, base?.href);
	if (url === null || url.protocol !== `${scheme}:` || url.hostname !== host || url.port !== "" || url.username !== "" || url.password !== "") {
		throw invalidHost();
	}
	url.hash = "";
	return new WebURL(scheme, host, url.href);
}
