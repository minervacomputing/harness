// Security headers on every API response. Static
// assets get the same set from public/_headers, which does not apply to responses the Worker makes.
// The Content-Security-Policy is a default: a response with its own keeps it, so downloads keep
// `sandbox`. Cache-Control is `no-store` unless the response says otherwise.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Strict-Transport-Security": "max-age=31536000",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Cross-Origin-Opener-Policy": "same-origin",
};

export const DEFAULT_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

/** The response with the security headers set. A response with immutable headers is copied first. */
export function withSecurityHeaders(response: Response): Response {
	let out = response;
	try {
		apply(out.headers);
	} catch {
		// Headers of a fetched response (from a Durable Object, say) are immutable.
		out = new Response(response.body, response);
		apply(out.headers);
	}
	return out;
}

function apply(headers: Headers): void {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
	if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", DEFAULT_CSP);
	if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
}
