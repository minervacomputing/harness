// Mail addresses as resources: who agents may send mail to.
//
// A recipient resource is one address, canonical: lowercase, ASCII, its domain in IDNA form. Grants use an
// exact address (`ada@example.com`) or everyone at one domain (`*@example.com`), which is an address's only
// ancestor. A domain pattern never spans a public suffix, and does not cover subdomains: `*@example.com`
// does not include `ada@mail.example.com`.
//
// Addresses under `.example`, which RFC 2606 reserves for documentation, are accepted too: mail to them can
// never be delivered, and tests and the demo's story use them for people the agent writes to.
//
// Addresses are lowercased on purpose. Most mail systems ignore case in the local part; a grant that told
// `Ada@` from `ada@` would only invite mistakes. Local parts are a strict subset of what RFC 5321 allows: no
// quoted strings, comments or non-ASCII characters, which are rare and easy to make look like another
// address.
//
// A grant authorizes an address, not a person. Distribution lists, aliases and forwarding rules can deliver
// mail sent to one address to other people, and `*@` a shared provider such as gmail.com is everyone with
// an account there.
//
// Gmail and Outlook share these rules, so they share this module.

import { OperationError } from "../gateway/connector.ts";
import { canonicalHost, isReserved, registrable } from "./sites.ts";

export const PATTERN_PREFIX = "*@";
export const MAX_ADDRESS = 200;
export const MAX_LOCAL = 64;
/**
 * What a reply would go to when Minerva cannot name it as an address. No grant names it, since it is not an
 * address; only allowing every recipient covers it, and then the reply is refused anyway.
 */
export const UNSUPPORTED = "unsupported";
/** A local part as written: ASCII only, so lowercasing it never maps a look-alike (the Kelvin sign) to a letter. */
const LOCAL = /^[A-Za-z0-9_%+'-]+(\.[A-Za-z0-9_%+'-]+)*$/;
export const CHECKED_MESSAGE = "must be a mail address such as ada@example.com";

function invalid(): OperationError {
	return new OperationError("INVALID_ADDRESS", "Use a mail address such as ada@example.com.");
}

function domainOf(raw: string): string {
	let host: string;
	try {
		host = canonicalHost(raw, true);
	} catch (error) {
		if (error instanceof OperationError) throw invalid();
		throw error;
	}
	if (registrable(host) === null && !isReserved(host)) throw invalid();
	return host;
}

/** The canonical address, or INVALID_ADDRESS. The domain is checked as written; canonicalHost lowercases it. */
export function parse(raw: string): string {
	const text = raw.trim();
	if (text.length > MAX_ADDRESS || text.split("@").length !== 2) throw invalid();
	const [local, domain] = text.split("@") as [string, string];
	if (local.length > MAX_LOCAL || !LOCAL.test(local)) throw invalid();
	const address = `${local.toLowerCase()}@${domainOf(domain)}`;
	if (address.length > MAX_ADDRESS) throw invalid();
	return address;
}

/** `checked` as a field validator's check: the canonical address, or the message the field shows. */
export function checked(raw: string): { ok: true; address: string } | { ok: false; message: string } {
	try {
		return { ok: true, address: parse(raw) };
	} catch (error) {
		if (error instanceof OperationError) return { ok: false, message: CHECKED_MESSAGE };
		throw error;
	}
}

export function addressDomain(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

export function pattern(domain: string): string {
	return PATTERN_PREFIX + domain;
}

export function ancestors(address: string): string[] {
	return [pattern(addressDomain(address))];
}

export function isPattern(resourceId: string): boolean {
	return resourceId.startsWith(PATTERN_PREFIX);
}

/** Whether this is a canonical address or a pattern for a registrable domain or one below it. */
export function validId(resourceId: string): boolean {
	try {
		if (isPattern(resourceId)) {
			const domain = resourceId.slice(PATTERN_PREFIX.length);
			return domainOf(domain) === domain;
		}
		return parse(resourceId) === resourceId;
	} catch (error) {
		if (error instanceof OperationError) return false;
		throw error;
	}
}

export function name(resourceId: string): string {
	if (isPattern(resourceId)) return `Everyone at ${resourceId.slice(PATTERN_PREFIX.length)}`;
	return resourceId;
}

/** What a user can allow for a pasted address (the address, then its domain) or a domain. */
export function choices(query: string): string[] {
	const text = query.trim();
	if (text.includes("@") && !text.startsWith("@") && !isPattern(text)) {
		const address = parse(text);
		return [address, ...ancestors(address)];
	}
	let domain = text.startsWith(PATTERN_PREFIX) ? text.slice(PATTERN_PREFIX.length) : text;
	if (domain.startsWith("@")) domain = domain.slice(1);
	return [pattern(domainOf(domain))];
}
