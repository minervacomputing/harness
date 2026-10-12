// The asset archive (src/http/assets.ts): the Worker copies its build's hashed files to the files bucket
// under static/ the first time it serves an asset, and serves a file that a later build no longer holds from
// that copy, so a tab loaded before a deploy keeps its chunks. Over real (local) R2; the assets binding is a
// scripted fetcher that answers as the platform does (the file, or the app shell for a miss).

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { ASSET_MANIFEST_PATH, manifestFor } from "../../src/http/asset-manifest.ts";
import { type AssetArchive, archiveAssets, resetAssetArchive, serveAsset } from "../../src/http/assets.ts";
import worker from "../../src/index.ts";
import { ORIGIN } from "./accounts-helpers.ts";

type Build = Record<string, { body: string; type: string }>;

/** The assets binding of one build: its files, the manifest listing them (unless `manifest` is false), and the app shell for any other path. */
function site(build: Build, manifest: boolean | Build = true): Fetcher & { requested: string[] } {
	const requested: string[] = [];
	return {
		requested,
		fetch: async (request: Request) => {
			const path = new URL(request.url).pathname;
			requested.push(path);
			if (path === ASSET_MANIFEST_PATH && manifest !== false) {
				const listed = manifest === true ? build : manifest;
				return Response.json(manifestFor(Object.keys(listed), (text) => [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7).toString(16).padStart(32, "0")));
			}
			const file = build[path];
			if (file === undefined) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
			return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=0, must-revalidate" } });
		},
	} as unknown as Fetcher & { requested: string[] };
}

const BUILD_A: Build = {
	"/assets/index-AAAA1111.js": { body: "console.log('a')", type: "text/javascript; charset=utf-8" },
	"/assets/route-BBBB2222.js": { body: "export default 'route a'", type: "text/javascript; charset=utf-8" },
	"/assets/style-CCCC3333.css": { body: "body{color:red}", type: "text/css; charset=utf-8" },
};
const BUILD_B: Build = {
	"/assets/index-DDDD4444.js": { body: "console.log('b')", type: "text/javascript; charset=utf-8" },
	"/assets/style-CCCC3333.css": BUILD_A["/assets/style-CCCC3333.css"]!,
};

/** Every promise a test gave `waitUntil`: the next test starts only when no copy of this one is still running. */
const started: Promise<unknown>[] = [];

/** What `waitUntil` was given, so a test can wait for the copy the request started. */
function archive(): AssetArchive & { settle(): Promise<void> } {
	const pending: Promise<unknown>[] = [];
	return {
		bucket: env.FILES,
		waitUntil: (promise) => void [pending, started].forEach((list) => list.push(promise)),
		settle: async () => void (await Promise.all(pending.splice(0))),
	};
}

const get = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);
const keys = async () => (await env.FILES.list({ prefix: "static/" })).objects.map((object) => object.key).sort();

let logged: MockInstance<typeof console.error>;

afterEach(async () => {
	await Promise.all(started.splice(0));
	logged.mockRestore();
});

beforeEach(async () => {
	resetAssetArchive();
	const listed = await env.FILES.list({ prefix: "static/" });
	await Promise.all(listed.objects.map((object) => env.FILES.delete(object.key)));
	logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("copying a build", () => {
	test("the first asset served starts a copy of every listed file, with its type, and a marker written last", async () => {
		const a = archive();
		const response = await serveAsset(get("/assets/index-AAAA1111.js"), site(BUILD_A), a);
		expect([response.status, await response.text()]).toEqual([200, "console.log('a')"]);
		await a.settle();
		const stored = await keys();
		expect(stored.filter((key) => key.startsWith("static/assets/"))).toEqual(Object.keys(BUILD_A).map((path) => `static${path}`).sort());
		expect(stored.filter((key) => key.startsWith("static/.archived/"))).toHaveLength(1);
		const css = await env.FILES.get("static/assets/style-CCCC3333.css");
		expect([css?.httpMetadata?.contentType, await css?.text()]).toEqual(["text/css; charset=utf-8", "body{color:red}"]);
	});

	test("a build is copied once per isolate, and an isolate that finds its marker copies nothing", async () => {
		const first = site(BUILD_A);
		const a = archive();
		await serveAsset(get("/assets/index-AAAA1111.js"), first, a);
		await serveAsset(get("/assets/route-BBBB2222.js"), first, a);
		await a.settle();
		expect(first.requested.filter((path) => path === "/assets/style-CCCC3333.css")).toHaveLength(1);

		resetAssetArchive();
		const next = site(BUILD_A);
		const b = archive();
		await serveAsset(get("/assets/index-AAAA1111.js"), next, b);
		await b.settle();
		// The manifest, and the file being served: no copy of the others.
		expect(next.requested).toEqual([ASSET_MANIFEST_PATH, "/assets/index-AAAA1111.js"]);
	});

	test("an isolate that lives on looks at the marker again after an hour, and copies again once the lifecycle rule has taken the build's objects", async () => {
		const t0 = Date.now();
		const assets = site(BUILD_A);
		await archiveAssets(assets, env.FILES, t0);
		expect((await keys()).length).toBe(Object.keys(BUILD_A).length + 1);

		// The bucket loses everything (the rule ran). Within the hour the isolate does not look.
		await Promise.all((await keys()).map((key) => env.FILES.delete(key)));
		await archiveAssets(assets, env.FILES, t0 + 10 * 60_000);
		expect(await keys()).toEqual([]);

		// After the hour it looks, finds no marker and copies.
		await archiveAssets(assets, env.FILES, t0 + 61 * 60_000);
		expect((await keys()).length).toBe(Object.keys(BUILD_A).length + 1);
	});

	test("a marker more than two weeks old is written again with the files, a younger one is trusted", async () => {
		const t0 = Date.now();
		const assets = site(BUILD_A);
		await archiveAssets(assets, env.FILES, t0);
		const day = 24 * 60 * 60_000;

		// 13 days on, a file is missing but the marker is young: nothing is copied.
		await env.FILES.delete("static/assets/style-CCCC3333.css");
		await archiveAssets(assets, env.FILES, t0 + 13 * day);
		expect(await env.FILES.head("static/assets/style-CCCC3333.css")).toBeNull();

		// 15 days on, the marker is old: the files are written again, which renews their age.
		await archiveAssets(assets, env.FILES, t0 + 15 * day);
		expect(await env.FILES.head("static/assets/style-CCCC3333.css")).not.toBeNull();
	});

	test("a copy that failed is tried again after five minutes, not by every request in between", async () => {
		const listing = { ...BUILD_A, "/assets/lost-EEEE5555.js": { body: "", type: "text/javascript" } };
		const t0 = Date.now();
		const broken = site(BUILD_A, listing);
		await archiveAssets(broken, env.FILES, t0);
		expect(logged).toHaveBeenCalledTimes(1);
		const requests = broken.requested.length;
		await archiveAssets(broken, env.FILES, t0 + 1_000);
		await archiveAssets(broken, env.FILES, t0 + 4 * 60_000);
		expect(broken.requested).toHaveLength(requests);
		expect(logged).toHaveBeenCalledTimes(1);

		// The build is fixed (a new deploy lists what it serves): the next look after the wait completes the copy.
		await archiveAssets(site(listing), env.FILES, t0 + 6 * 60_000);
		expect((await keys()).filter((key) => key.startsWith("static/.archived/"))).toHaveLength(1);
	});

	test("a listed file the build does not serve leaves no marker, and the next isolate tries again", async () => {
		const broken = { ...BUILD_A };
		const listing = { ...BUILD_A, "/assets/lost-EEEE5555.js": { body: "", type: "text/javascript" } };
		const a = archive();
		const response = await serveAsset(get("/assets/index-AAAA1111.js"), site(broken, listing), a);
		expect(response.status).toBe(200);
		await a.settle();
		expect((await keys()).filter((key) => key.startsWith("static/.archived/"))).toEqual([]);
		expect(logged).toHaveBeenCalledWith(expect.stringContaining("/assets/lost-EEEE5555.js is listed but not served"));

		resetAssetArchive();
		const b = archive();
		await serveAsset(get("/assets/index-AAAA1111.js"), site(listing), b);
		await b.settle();
		expect((await keys()).filter((key) => key.startsWith("static/.archived/"))).toHaveLength(1);
	});

	test("a build without a manifest (the development server, an older build) copies nothing", async () => {
		const a = archive();
		const response = await serveAsset(get("/assets/index-AAAA1111.js"), site(BUILD_A, false), a);
		expect(response.status).toBe(200);
		await a.settle();
		expect(await keys()).toEqual([]);
		expect(logged).not.toHaveBeenCalled();
	});
});

describe("after a deploy", () => {
	/** Build A served and copied, then build B in place of it. */
	async function deployed(): Promise<AssetArchive & { settle(): Promise<void> }> {
		const a = archive();
		await serveAsset(get("/assets/index-AAAA1111.js"), site(BUILD_A), a);
		await a.settle();
		resetAssetArchive();
		return a;
	}

	test("a file of the previous build is served from the archive, immutable, with its type and the security headers", async () => {
		const a = await deployed();
		const response = await serveAsset(get("/assets/route-BBBB2222.js"), site(BUILD_B), a);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("export default 'route a'");
		expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Length")).toBe(String("export default 'route a'".length));
		const head = await serveAsset(get("/assets/route-BBBB2222.js", { method: "HEAD" }), site(BUILD_B), a);
		expect([head.status, await head.text(), head.headers.get("Content-Type")]).toEqual([200, "", "text/javascript; charset=utf-8"]);
	});

	test("the new build's own files are served by the assets, and a name no build had is still a 404 that nothing caches", async () => {
		const a = await deployed();
		const own = await serveAsset(get("/assets/index-DDDD4444.js"), site(BUILD_B), a);
		expect([own.status, await own.text()]).toEqual([200, "console.log('b')"]);
		const missing = await serveAsset(get("/assets/never-FFFF6666.js"), site(BUILD_B), a);
		expect([missing.status, missing.headers.get("Cache-Control"), missing.headers.get("Content-Type")]).toEqual([404, "no-store", "text/plain; charset=utf-8"]);
		await a.settle();
		// Both builds are in the archive now: a tab on either keeps its files.
		expect(await keys()).toEqual(expect.arrayContaining(["static/assets/index-AAAA1111.js", "static/assets/index-DDDD4444.js", "static/assets/route-BBBB2222.js"]));
	});

	test("only GET and HEAD read the archive, and only names a build could hold", async () => {
		const a = await deployed();
		await env.FILES.put("uploads/secret.txt", "private");
		await env.FILES.put("static/other.js", "not an asset");
		// Objects under keys no build produces, which a request must not reach.
		for (const key of ["static/assets/.hidden.js", "static/assets/a%20b.js", "static/assets//route-BBBB2222.js", "static/assets/"]) await env.FILES.put(key, "stray");
		const post = await serveAsset(get("/assets/route-BBBB2222.js", { method: "POST", body: "x" }), site(BUILD_B), a);
		expect(post.status).toBe(404);
		for (const path of ["/assets/..%2Fuploads/secret.txt", "/assets/%2e%2e/static/other.js", "/assets/.hidden.js", "/assets/a b.js", "/assets//route-BBBB2222.js", "/assets/"]) {
			const response = await serveAsset(get(path), site(BUILD_B), a);
			expect([path, response.status, await response.text()]).toEqual([path, 404, "Not Found"]);
		}
	});

	test("through the Worker's entry: its files bucket answers a miss, and the copy starts in waitUntil", async () => {
		await env.FILES.put("static/assets/kept-GGGG7777.js", "kept", { httpMetadata: { contentType: "text/javascript" } });
		const pending: Promise<unknown>[] = [];
		const ctx = { waitUntil: (promise: Promise<unknown>) => void [pending, started].forEach((list) => list.push(promise)), passThroughOnException() {} } as unknown as ExecutionContext;
		const run = (path: string) => worker.fetch!(get(path) as never, { ...env, ASSETS: site(BUILD_B) } as Env, ctx);
		const response = await run("/assets/kept-GGGG7777.js");
		expect([response.status, await response.text(), response.headers.get("Cache-Control")]).toEqual([200, "kept", "public, max-age=31536000, immutable"]);
		const missing = await run("/assets/not-there-HHHH8888.js");
		expect([missing.status, missing.headers.get("Cache-Control")]).toEqual([404, "no-store"]);
		await Promise.all(pending);
		expect(await keys()).toContain("static/assets/index-DDDD4444.js");
	});
});
