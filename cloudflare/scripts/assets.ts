// Assembles the Worker's static assets in .assets/: the frontend's production build (frontend/dist, built
// by `pnpm --dir ../frontend build` first) plus public/_headers, which sets the security headers on every
// asset response (frontend-runtime spec 11.2). The frontend itself stays unchanged.

import { cpSync, existsSync, rmSync } from "node:fs";

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
console.log("Assets ready in .assets/");
