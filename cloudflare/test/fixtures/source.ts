// The code of src/, for tests that guard a rule by reading it (no z.coerce, no unlisted normalization, no
// JSON.parse). Comments are removed so that prose never counts; strings stay, so a pattern sees them.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE = fileURLToPath(new URL("../../src/", import.meta.url).href);

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}${entry.name}`;
		return entry.isDirectory() ? files(`${path}/`) : entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** A file's text without its block and line comments (a `//` after a colon is a URL). */
export function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every file of src/ as its path below src/ and its code. */
export function sourceCode(): { path: string; code: string }[] {
	return files(SOURCE).map((path) => ({ path: path.slice(SOURCE.length), code: withoutComments(readFileSync(path, "utf8")) }));
}
