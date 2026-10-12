// Hashed build output under /assets/ (frontend-runtime 11, web-api 1.2). The Worker runs first for these
// paths because the assets' single-page-application fallback answers a missing file with index.html, 200,
// which public/_headers would then mark immutable for a year: a tab that asks for a chunk during a deploy
// would keep HTML under that URL. A miss is a 404 here, and only a file that exists is cached for good.
//
// A deploy replaces the assets, and a tab that loaded the previous page asks for that page's chunks, which
// are gone. So the Worker keeps a copy of its own hashed files in the files bucket under static/, made
// from the manifest `pnpm assets` writes (asset-manifest.ts) the first time it serves an asset (once per
// build, recorded by a marker object that is renewed every two weeks), and a miss that the copy answers is
// served from it. The previous builds' files stay until the bucket's lifecycle rule removes them
// (r2-lifecycle.json: 30 days).

import { parseJson } from "../lib/json.ts";
import { ASSET_MANIFEST_PATH, SAFE_PATH, parseManifest } from "./asset-manifest.ts";
import { withSecurityHeaders } from "./headers.ts";

export const ASSETS_PREFIX = "/assets/";

const ARCHIVE_PREFIX = "static";
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The assets binding needs an absolute URL; its host is not looked at. */
const ASSETS_ORIGIN = "https://assets.invalid";
/** Files fetched and stored at a time: each is held in memory while it is written (the largest is under a megabyte). */
const COPY_AT_ONCE = 4;

/** Where a bucket and the request's lifetime are for the copy: the files bucket, and `waitUntil`. */
export interface AssetArchive {
	bucket: R2Bucket;
	waitUntil(promise: Promise<unknown>): void;
}

const archiveKey = (path: string) => `${ARCHIVE_PREFIX}${path}`;
const markerKey = (build: string) => `${ARCHIVE_PREFIX}/.archived/${build}`;

/** How long an isolate trusts its last look at the build's marker before looking again. */
const RECHECK_MS = 60 * 60_000;
/** How long after a copy that failed: a build whose listing names a file it does not serve fails every time. */
const RETRY_MS = 5 * 60_000;
/**
 * A marker older than this is written again together with the files, which renews their age well before the
 * lifecycle rule (30 days) removes them: the build that is live today is the previous build of the next deploy.
 * Renewal needs an asset request to reach the Worker (a build nobody loads for weeks is not renewed).
 */
const REFRESH_AFTER_MS = 14 * 24 * 60 * 60_000;

let copying: Promise<void> | null = null;
let looked = 0;
let lookAgainAfter = RECHECK_MS;
/** Forgets that this isolate copied its build (the tests start each case afresh). */
export function resetAssetArchive(): void {
	copying = null;
	looked = 0;
	lookAgainAfter = RECHECK_MS;
}

/**
 * Copies this build's hashed files to the archive: nothing when the marker for its manifest is there and less
 * than two weeks old, nothing without a manifest (the development server, an older build). The marker is
 * written last, so a copy that failed is tried again, by the next isolate or after five minutes here. An
 * isolate looks at most once an hour, so one that lives for weeks still renews the copy.
 */
export function archiveAssets(assets: Fetcher, bucket: R2Bucket, now: number = Date.now()): Promise<void> {
	if (copying !== null && now - looked < lookAgainAfter) return copying;
	looked = now;
	lookAgainAfter = RECHECK_MS;
	copying = copyAssets(assets, bucket, now).catch((error: unknown) => {
		lookAgainAfter = RETRY_MS;
		console.error(`Archiving the assets failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	return copying;
}

async function readManifest(assets: Fetcher) {
	const response = await assets.fetch(new Request(`${ASSETS_ORIGIN}${ASSET_MANIFEST_PATH}`));
	if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("json")) {
		await response.body?.cancel();
		return null;
	}
	let listed: unknown = null;
	try {
		listed = parseJson(await response.text());
	} catch {
		// Not JSON: no manifest.
	}
	return parseManifest(listed);
}

async function copyAssets(assets: Fetcher, bucket: R2Bucket, now: number): Promise<void> {
	const manifest = await readManifest(assets);
	if (manifest === null) return;
	const marker = await bucket.head(markerKey(manifest.build));
	if (marker !== null && now - marker.uploaded.getTime() < REFRESH_AFTER_MS) return;
	for (let at = 0; at < manifest.files.length; at += COPY_AT_ONCE) {
		await Promise.all(
			manifest.files.slice(at, at + COPY_AT_ONCE).map(async (path) => {
				const response = await assets.fetch(new Request(`${ASSETS_ORIGIN}${path}`));
				const type = response.headers.get("Content-Type") ?? "";
				// The app shell answers a name the build does not hold; it is not a copy of anything.
				if (!response.ok || type.startsWith("text/html")) {
					await response.body?.cancel();
					throw new Error(`${path} is listed but not served (${response.status})`);
				}
				await bucket.put(archiveKey(path), await response.arrayBuffer(), { httpMetadata: { contentType: type } });
			}),
		);
	}
	await bucket.put(markerKey(manifest.build), "", { customMetadata: { files: String(manifest.files.length) } });
}

/** The archived copy of a missed file, as a response, or null. */
async function archived(request: Request, bucket: R2Bucket): Promise<Response | null> {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const path = new URL(request.url).pathname;
	if (!SAFE_PATH.test(path)) return null;
	const object = await bucket.get(archiveKey(path));
	if (object === null) return null;
	const headers = new Headers({
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"Content-Length": String(object.size),
		ETag: object.httpEtag,
		"Cache-Control": IMMUTABLE,
	});
	return withSecurityHeaders(new Response(request.method === "HEAD" ? null : object.body, { headers }));
}

export async function serveAsset(request: Request, assets: Fetcher, archive?: AssetArchive): Promise<Response> {
	if (archive) archive.waitUntil(archiveAssets(assets, archive.bucket));
	const response = await assets.fetch(request);
	// No file under /assets/ is HTML, so HTML is the fallback shell.
	if (response.status === 404 || (response.ok && (response.headers.get("Content-Type") ?? "").startsWith("text/html"))) {
		await response.body?.cancel();
		// A file of an earlier build, which this build's assets no longer hold.
		const kept = archive ? await archived(request, archive.bucket) : null;
		if (kept) return kept;
		return withSecurityHeaders(
			new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }),
		);
	}
	const out = withSecurityHeaders(new Response(response.body, response));
	if (response.ok) out.headers.set("Cache-Control", IMMUTABLE);
	return out;
}
