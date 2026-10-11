// Rules about the sources that a type cannot express.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
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

/**
 * What a module imports or re-exports, as TypeScript's own pre-processor reads it: `import … from`,
 * `export … from`, a bare `import "…"` (run for its side effects, as src/faults/index.ts is) and
 * `import("…")`, with comments and strings skipped.
 */
function importsOf(text: string): string[] {
	return ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
}

/** The test build's own modules: src/faults/ and the fake model it uses. */
function testBuildOnly(path: string): boolean {
	return path.startsWith(join("src", "faults") + "/") || path === join("src", "model", "fake.ts");
}

test("imports are found in every form, side-effect imports included", () => {
	const sample = [
		'import /* run for its effects */ "./faults/index.ts";',
		'import { a } from "./a.ts";',
		'import type {\n\tb,\n} from "./b.ts";',
		'export * from "./c.ts";',
		'export { d } from "./d.ts";',
		'const e = await import("./e.ts", { with: { type: "json" } });',
		'// import "./commented.ts";',
		'const text = "import \\"./quoted.ts\\"";',
	].join("\n");
	expect(importsOf(sample)).toEqual(["./faults/index.ts", "./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts"]);
});

test("the production entry reaches nothing of the test build", () => {
	// src/faults/ is the test Worker's (minerva-cf-test): fault points, a fake connector, a driver, and the
	// fake model. src/faults/index.ts takes effect when it is loaded, so even a bare import of it from
	// src/index.ts would put its ports in minerva-cf: no module the entry reaches may be one of them.
	const reached = new Set<string>();
	const pending = [join("src", "index.ts")];
	while (pending.length) {
		const path = pending.pop() as string;
		if (reached.has(path)) continue;
		reached.add(path);
		for (const specifier of importsOf(readFileSync(join(ROOT, path), "utf8"))) {
			if (!specifier.startsWith(".")) continue;
			const target = normalize(join(dirname(path), specifier));
			if (existsSync(join(ROOT, target))) pending.push(target);
		}
	}
	expect(reached.size).toBeGreaterThan(20);
	expect([...reached].filter(testBuildOnly)).toEqual([]);
});

test("only the test build imports src/faults/ and the fake model", () => {
	const offenders: string[] = [];
	for (const path of sources("src")) {
		if (testBuildOnly(path)) continue;
		for (const specifier of importsOf(readFileSync(join(ROOT, path), "utf8"))) {
			if (specifier.startsWith(".") && testBuildOnly(normalize(join(dirname(path), specifier)))) offenders.push(`${path}: ${specifier}`);
		}
	}
	expect(offenders).toEqual([]);
});
