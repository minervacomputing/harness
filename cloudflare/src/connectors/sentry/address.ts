// What reads.py's `_address` needs of Python 3.14's `urllib.parse`: `urlsplit` and the result's host and
// port (lib/urlsplit.ts, moved there from here), so an event's request address is cut where Python cuts it.

import { hostinfo, rpartition, urlsplit } from "../../lib/urlsplit.ts";

/**
 * reads.py `_address`, before `short`: a request's address without credentials, query or fragment, as
 * `{scheme}://{netloc after its last "@"}{path}`; null for what is not a string, does not split, has a
 * malformed port, is neither http nor https, or has no host. The host and port are as written, so an IPv6
 * address keeps its brackets.
 */
export function requestAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const parts = urlsplit(value);
	if (parts === null) return null;
	const [hostname, port] = hostinfo(parts.netloc);
	// `parts.port` raises unless the port is ASCII digits for 0 to 65535.
	if (port !== null && !(/^[0-9]+$/.test(port) && Number(port) <= 65535)) return null;
	// `parts.hostname` is None for an empty host.
	if ((parts.scheme !== "http" && parts.scheme !== "https") || hostname === "") return null;
	return `${parts.scheme}://${rpartition(parts.netloc, "@")[2]}${parts.path}`;
}
