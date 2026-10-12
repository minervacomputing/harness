// POSIX paths as pi's NodeExecutionEnv resolves them (`resolvePath`): `~` is the commands' HOME in the
// container (files risk 22: never the Worker's), a `file://` URL is its path, and the rest is Node's
// `path.posix.resolve` against the environment's cwd. Node's normalization is reproduced exactly, so the
// paths pi's tools key their mutation queue by are the ones Node would give.

import { HOME } from "./constants.ts";

const SLASH = 47;
const DOT = 46;

/** Node's normalizeString for POSIX separators. */
function normalizeString(path: string, allowAboveRoot: boolean): string {
	let res = "";
	let lastSegmentLength = 0;
	let lastSlash = -1;
	let dots = 0;
	let code = 0;
	for (let i = 0; i <= path.length; ++i) {
		if (i < path.length) code = path.charCodeAt(i);
		else if (code === SLASH) break;
		else code = SLASH;
		if (code === SLASH) {
			if (lastSlash === i - 1 || dots === 1) {
				// An empty segment or ".".
			} else if (dots === 2) {
				if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
					if (res.length > 2) {
						const lastSlashIndex = res.lastIndexOf("/");
						if (lastSlashIndex === -1) {
							res = "";
							lastSegmentLength = 0;
						} else {
							res = res.slice(0, lastSlashIndex);
							lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
						}
						lastSlash = i;
						dots = 0;
						continue;
					} else if (res.length !== 0) {
						res = "";
						lastSegmentLength = 0;
						lastSlash = i;
						dots = 0;
						continue;
					}
				}
				if (allowAboveRoot) {
					res += res.length > 0 ? "/.." : "..";
					lastSegmentLength = 2;
				}
			} else {
				if (res.length > 0) res += `/${path.slice(lastSlash + 1, i)}`;
				else res = path.slice(lastSlash + 1, i);
				lastSegmentLength = i - lastSlash - 1;
			}
			lastSlash = i;
			dots = 0;
		} else if (code === DOT && dots !== -1) {
			++dots;
		} else {
			dots = -1;
		}
	}
	return res;
}

/** `path.posix.normalize`. */
export function normalize(path: string): string {
	if (path.length === 0) return ".";
	const absolute = path.charCodeAt(0) === SLASH;
	const trailing = path.charCodeAt(path.length - 1) === SLASH;
	let out = normalizeString(path, !absolute);
	if (out.length === 0) {
		if (absolute) return "/";
		return trailing ? "./" : ".";
	}
	if (trailing) out += "/";
	return absolute ? `/${out}` : out;
}

/** `path.posix.join`. */
export function join(...parts: string[]): string {
	const kept = parts.filter((part) => part.length > 0);
	if (kept.length === 0) return ".";
	return normalize(kept.join("/"));
}

/** `path.posix.resolve` from `cwd`, which is absolute. */
export function resolve(cwd: string, ...paths: string[]): string {
	let resolved = "";
	let absolute = false;
	const all = [cwd, ...paths];
	for (let i = all.length - 1; i >= 0 && !absolute; i--) {
		const path = all[i] as string;
		if (path.length === 0) continue;
		resolved = `${path}/${resolved}`;
		absolute = path.charCodeAt(0) === SLASH;
	}
	const normalized = normalizeString(resolved, !absolute);
	if (absolute) return `/${normalized}`;
	return normalized.length > 0 ? normalized : ".";
}

/** Node's `fileURLToPath` on POSIX; throws for what it refuses. */
function fileUrlPath(text: string): string {
	const url = new URL(text);
	if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
	if (url.hostname !== "") throw new TypeError('File URL host must be "localhost" or empty');
	if (/%2f/i.test(url.pathname)) throw new TypeError("File URL path must not include encoded / characters");
	return decodeURIComponent(url.pathname);
}

/** pi's resolvePath with the container's HOME. */
export function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") normalized = HOME;
	else if (normalized.startsWith("~/")) normalized = join(HOME, normalized.slice(2));
	else if (normalized.startsWith("file://")) {
		try {
			normalized = fileUrlPath(normalized);
		} catch {
			// pi keeps a malformed URL as an ordinary path.
		}
	}
	return resolve(cwd, normalized);
}
