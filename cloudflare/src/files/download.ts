// The download origin's handler, which files-worker/ serves as minerva-cf-files: a GET of a signed link
// (links.ts) on this origin streams the object from the workspace's bucket as an attachment that cannot
// run: `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, `Content-Security-Policy:
// sandbox`, `Cache-Control: private, no-store`, with single byte ranges. Every refusal is the same 404
// `{"detail": "Not Found"}`, except a request without a signature, which is 401 as for a request without
// a session.

import { DOWNLOAD_PATH, contentDisposition, verifyDownload } from "./links.ts";

/** The download Worker's bindings (files-worker/cloudflare.config.ts). */
export interface DownloadEnv {
	FILES: R2Bucket;
	FILES_EU: R2Bucket;
	MINERVA_DOWNLOAD_KEY: string;
	/** The origin links are signed for; a request for any other host is refused. */
	MINERVA_DOWNLOAD_ORIGIN: string;
}

// As the app's (http/headers.ts), with the download's own policy and cache rules.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Strict-Transport-Security": "max-age=31536000",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Content-Security-Policy": "sandbox",
};

function detail(status: number, message: string, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ detail: message }), {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
	});
}

const notFound = () => detail(404, "Not Found");

/** One range of `bytes=`: `a-b`, `a-` or `-n`; anything else, several included, is ignored and the whole file sent. */
export function parseRange(header: string | null): { offset: number; length?: number } | { suffix: number } | null {
	if (header === null) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, start = "", end = ""] = match;
	if (start === "" && end === "") return null;
	if (start === "") return Number(end) > 0 ? { suffix: Number(end) } : null;
	const offset = Number(start);
	if (end === "") return { offset };
	const last = Number(end);
	if (last < offset) return null;
	return { offset, length: last - offset + 1 };
}

/** The bytes a ranged get returned: R2 answers with the range it served, a suffix resolved to an offset, cut at the end. */
export function servedRange(range: R2Range, size: number): { offset: number; length: number } {
	if ("suffix" in range && range.suffix !== undefined) {
		const length = Math.min(range.suffix, size);
		return { offset: size - length, length };
	}
	const offset = "offset" in range && range.offset !== undefined ? range.offset : 0;
	const wanted = "length" in range && range.length !== undefined ? range.length : size - offset;
	return { offset, length: Math.max(0, Math.min(wanted, size - offset)) };
}

export async function serveDownload(request: Request, env: DownloadEnv, now = Date.now()): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "GET" || url.pathname !== DOWNLOAD_PATH || url.origin !== env.MINERVA_DOWNLOAD_ORIGIN) return notFound();
	const verified = await verifyDownload(env.MINERVA_DOWNLOAD_KEY, url, now);
	if (!verified.ok) return verified.reason === "unsigned" ? detail(401, "Unauthorized") : notFound();
	const { link } = verified;
	const bucket = link.jurisdiction === "eu" ? env.FILES_EU : env.FILES;
	const range = parseRange(request.headers.get("range"));
	let object: R2ObjectBody | null;
	try {
		object = await bucket.get(link.key, range ? { range } : {});
	} catch (error) {
		if (!/\b10039\b|range is not satisfiable/i.test(String(error))) throw error;
		const head = await bucket.head(link.key);
		if (head === null) return notFound();
		return detail(416, "Range Not Satisfiable", { "Content-Range": `bytes */${head.size}` });
	}
	if (object === null) return notFound();
	const name = link.path.slice(link.path.lastIndexOf("/") + 1);
	const headers: Record<string, string> = {
		...SECURITY_HEADERS,
		"Content-Type": "application/octet-stream",
		"Content-Disposition": contentDisposition(name),
		"Cache-Control": "private, no-store",
		"Accept-Ranges": "bytes",
	};
	const served = range ? servedRange(object.range ?? range, object.size) : null;
	if (served) {
		headers["Content-Length"] = String(served.length);
		headers["Content-Range"] = `bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`;
		return new Response(object.body, { status: 206, headers });
	}
	headers["Content-Length"] = String(object.size);
	return new Response(object.body, { status: 200, headers });
}
