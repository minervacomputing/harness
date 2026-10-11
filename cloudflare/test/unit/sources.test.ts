// Rules about the sources that a type cannot express.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

function sources(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".ts"))
		.map((path) => join(dir, path));
}

/** Each line of a source without its comments, with its number. */
function code(path: string): [line: string, number: number][] {
	return readFileSync(join(ROOT, path), "utf8")
		.split("\n")
		.map((line, index): [string, number] => [/^\s*(\*|\/\*)/.test(line) ? "" : line.replace(/\/\/.*$/, ""), index + 1]);
}

test("JSON is read only through lib/json.ts's parseJson", () => {
	// JSON.parse, Response.json() and c.req.json() can return wrong keys on this runtime (lib/json.ts).
	const offenders: string[] = [];
	for (const path of [...sources("src"), ...sources("files-worker/src")]) {
		if (path === join("src", "lib", "json.ts")) continue;
		for (const [line, number] of code(path)) if (/\bJSON\.parse\(|\.json\(\)/.test(line)) offenders.push(`${path}:${number}`);
	}
	expect(offenders).toEqual([]);
});

test("string limits count code points (lib/schema.ts)", () => {
	// zod's .min/.max/.length/.trim on strings count UTF-16 units and strip U+FEFF; Pydantic does neither.
	const offenders: string[] = [];
	for (const path of sources("src")) {
		for (const [line, number] of code(path)) if (/z\.string\(\)[^;]*\.(min|max|length|trim)\(/.test(line)) offenders.push(`${path}:${number}`);
	}
	expect(offenders).toEqual([]);
});
