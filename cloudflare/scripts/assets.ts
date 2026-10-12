// Assembles the Worker's static assets in .assets/: the frontend's production build (frontend/dist, built
// by `pnpm --dir ../frontend build` first) plus public/_headers, which sets the security headers on every
// asset response (frontend-runtime spec 11.2). The frontend itself stays unchanged.

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { ASSET_MANIFEST_PATH, manifestFor } from "../src/http/asset-manifest.ts";

const root = new URL("../", import.meta.url);
const dist = new URL("../frontend/dist/", root);
const out = new URL(".assets/", root);

if (!existsSync(new URL("index.html", dist))) {
	console.error("frontend/dist/index.html is missing: run `pnpm --dir ../frontend build` first.");
	process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
cpSync(new URL("public/_headers", root), new URL("_headers", out));
// The hashed files, listed for the Worker, which copies them to its archive so that a tab that loaded this
// build keeps its chunks after the next deploy replaces them (src/http/assets.ts).
const files = (readdirSync(out, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
	.filter((entry) => entry.isFile())
	.map((entry) => `${entry.parentPath}/${entry.name}`.slice(out.pathname.length));
const manifest = manifestFor(files, (text) => createHash("sha256").update(text).digest("hex").slice(0, 32));
writeFileSync(new URL(`.${ASSET_MANIFEST_PATH}`, out), `${JSON.stringify(manifest)}\n`);
console.log(`Assets ready in .assets/ (${manifest.files.length} hashed files listed for the archive)`);
