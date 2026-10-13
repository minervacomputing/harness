/**
 * An event's request address without credentials, query or fragment, as the runtime's URL parser writes it
 * (`{scheme}//{host and port}{path}`); null for what is not a string, not an http or https URL.
 */
export function requestAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const url = URL.parse(value);
	if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
	return `${url.protocol}//${url.host}${url.pathname}`;
}
