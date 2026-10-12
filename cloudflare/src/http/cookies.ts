// The CSRF cookie, with Django's name and attributes (web-api spec 3.2): SameSite=Lax, on Path=/, without
// a Domain, and Secure unless debug is on. The session cookie is Better Auth's (accounts/auth-options.ts).

export const CSRF_COOKIE = "csrftoken";
/** 52 weeks. */
export const CSRF_MAX_AGE = 31_449_600;

export interface CookieOptions {
	maxAge: number;
	httpOnly: boolean;
	secure: boolean;
}

/** The cookies a request sent; the last of a repeated name wins, as in Django's `parse_cookie`. */
export function parseCookies(header: string | null): Map<string, string> {
	const cookies = new Map<string, string>();
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const split = part.indexOf("=");
		if (split < 0) continue;
		const name = part.slice(0, split).trim();
		let value = part.slice(split + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		if (name) cookies.set(name, value);
	}
	return cookies;
}

export function readCookie(request: Request, name: string): string | null {
	return parseCookies(request.headers.get("Cookie")).get(name) ?? null;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
	if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(value) && value !== "") {
		throw new TypeError("Cookie values here are tokens of URL-safe characters.");
	}
	const parts = [`${name}=${value}`, `Max-Age=${options.maxAge}`, "Path=/", "SameSite=Lax"];
	if (options.maxAge <= 0) parts.splice(2, 0, "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
	if (options.httpOnly) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

/** `csrftoken`: readable by the page, which echoes it in `X-CSRFToken`, and never cleared during a page's life. */
export function csrfCookie(value: string, { debug }: { debug: boolean }): string {
	return serializeCookie(CSRF_COOKIE, value, { maxAge: CSRF_MAX_AGE, httpOnly: false, secure: !debug });
}
