// Hashed build output under /assets/ (frontend-runtime 11, web-api 1.2). The Worker runs first for these
// paths because the assets' single-page-application fallback answers a missing file with index.html, 200,
// which public/_headers would then mark immutable for a year: a tab that asks for a chunk during a deploy
// would keep HTML under that URL. A miss is a 404 here, and only a file that exists is cached for good.

import { withSecurityHeaders } from "./headers.ts";

export const ASSETS_PREFIX = "/assets/";

export async function serveAsset(request: Request, assets: Fetcher): Promise<Response> {
	const response = await assets.fetch(request);
	// No file under /assets/ is HTML, so HTML is the fallback shell.
	if (response.status === 404 || (response.ok && (response.headers.get("Content-Type") ?? "").startsWith("text/html"))) {
		return withSecurityHeaders(
			new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }),
		);
	}
	const out = withSecurityHeaders(new Response(response.body, response));
	if (response.ok) out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
	return out;
}
