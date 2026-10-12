// The list of the frontend's hashed files that `pnpm assets` (scripts/assets.ts) writes next to the build as
// /asset-manifest.json, so the running Worker can find out which files its own static assets hold and copy
// them to the archive (assets.ts). Only /assets/ is listed: those names carry a content hash.

export const ASSET_MANIFEST_PATH = "/asset-manifest.json";

export interface AssetManifest {
	/** Names this build: a hash of its file list. The archive records which builds it has copied. */
	build: string;
	/** Paths from the site root, such as "/assets/index-3f9a.js". */
	files: string[];
}

/** The manifest for `files` (paths under the build's root, with or without a leading slash) and the hash `digest` made of the sorted list. */
export function manifestFor(files: string[], digest: (text: string) => string): AssetManifest {
	const paths = files
		.map((file) => (file.startsWith("/") ? file : `/${file}`))
		.filter((path) => path.startsWith("/assets/"))
		.sort();
	return { build: digest(paths.join("\n")), files: paths };
}

/** A manifest read from JSON, or null for anything else (the assets' app-shell fallback answers a missing file with HTML). */
export function parseManifest(value: unknown): AssetManifest | null {
	if (typeof value !== "object" || value === null) return null;
	const { build, files } = value as Partial<AssetManifest>;
	if (typeof build !== "string" || !/^[0-9a-f]{16,64}$/.test(build) || !Array.isArray(files)) return null;
	if (!files.every((file) => typeof file === "string" && SAFE_PATH.test(file))) return null;
	return { build, files };
}

/** A hashed asset's path: under /assets/, plain characters, no dot segments. */
export const SAFE_PATH = /^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
