// CSRF: an unsafe request (any method but GET, HEAD and OPTIONS) must come from the site's own pages.
//
// - With an `Origin` header, it must be MINERVA_SITE_URL's origin exactly: `null`, sibling subdomains and
//   every other origin are refused, whatever `Sec-Fetch-Site` says.
// - Without `Origin`, it must carry `Sec-Fetch-Site: same-origin` and be addressed to the site's origin
//   (the header is relative to the request's own origin, which another hostname of the Worker is not).
// - With neither, it is refused.
//
// Browsers send `Origin` on every unsafe request, and a page cannot remove it or set `Sec-Fetch-Site`. The
// router checks every unsafe request under /api/, with or without the session cookie, before any route
// runs and whether or not one matches (http/router.ts); this also covers /api/dev/seed, which changes
// accounts without a session. The one exemption is a POST under /api/auth/, which only Better Auth's route
// answers: it checks the origin against its trusted origins itself. A request with a bearer token (a
// desktop client, later) would be exempt only once its token is verified.

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether the request may pass: a safe method, or an unsafe one from the site's origin (above). */
export function fromSite(request: Request, siteUrl: string): boolean {
	if (SAFE.has(request.method)) return true;
	const origin = request.headers.get("Origin");
	const site = new URL(siteUrl).origin;
	if (origin !== null) return origin === site;
	return request.headers.get("Sec-Fetch-Site") === "same-origin" && new URL(request.url).origin === site;
}
