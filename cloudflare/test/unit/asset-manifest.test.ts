// The list of hashed assets that `pnpm assets` writes for the Worker's archive (src/http/asset-manifest.ts).

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SAFE_PATH, manifestFor, parseManifest } from "../../src/http/asset-manifest.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

describe("manifestFor", () => {
	test("lists only /assets/, sorted and rooted, and names the build by its list", () => {
		const manifest = manifestFor(["assets/b-2.js", "index.html", "/assets/a-1.css", "favicon.svg", "assets/fonts/x-3.woff2", "_headers"], digest);
		expect(manifest.files).toEqual(["/assets/a-1.css", "/assets/b-2.js", "/assets/fonts/x-3.woff2"]);
		expect(manifest.build).toMatch(/^[0-9a-f]{32}$/);
		// The same files in any order are the same build; another file is another build.
		expect(manifestFor(["/assets/fonts/x-3.woff2", "/assets/b-2.js", "/assets/a-1.css"], digest).build).toBe(manifest.build);
		expect(manifestFor(["/assets/a-1.css", "/assets/b-2.js"], digest).build).not.toBe(manifest.build);
	});
});

describe("parseManifest", () => {
	const good = { build: "0123456789abcdef0123456789abcdef", files: ["/assets/index-DfJd_3-x.js", "/assets/a/b-1.css"] };

	test("takes what manifestFor writes", () => {
		expect(parseManifest(JSON.parse(JSON.stringify(manifestFor(["assets/index-1.js", "assets/x-2.css"], digest))))).toEqual({
			build: manifestFor(["assets/index-1.js", "assets/x-2.css"], digest).build,
			files: ["/assets/index-1.js", "/assets/x-2.css"],
		});
		expect(parseManifest(good)).toEqual(good);
	});

	test("refuses anything else, so the app shell that answers a missing manifest is not one", () => {
		for (const bad of [null, "<!doctype html>", 7, [], {}, { ...good, build: "xyz" }, { ...good, build: 5 }, { ...good, files: "x" }, { ...good, files: [5] }]) {
			expect(parseManifest(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	test("refuses a list with a path outside /assets/ or with dot segments, spaces, queries or encoded characters", () => {
		for (const path of ["/index.html", "/assets/", "/assets/../x.js", "/assets/.hidden", "/assets/a b.js", "/assets/a.js?x=1", "/assets/%2e%2e/x.js", "/assets//a.js", "assets/a.js", "/other/assets/a.js"]) {
			expect(parseManifest({ ...good, files: [path] }), path).toBeNull();
			expect(SAFE_PATH.test(path), path).toBe(false);
		}
	});
});
