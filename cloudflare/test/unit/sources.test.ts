// Rules about the sources that a type cannot express.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { REFUSALS } from "../../src/shared/rpc.ts";
import { sourceCode } from "../fixtures/source.ts";

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

test("no schema coerces: tool inputs are the types they name", () => {
	// zod's coercion reads "0x10" as 16 and any non-empty string as true.
	const users = sourceCode().filter(({ code }) => /\bz\s*\.\s*coerce\b|\bcoerce\s*\.\s*(number|string|boolean|bigint|date)\b/.test(code));
	expect(users.map(({ path }) => path)).toEqual([]);
});

// NFKC folds look-alikes (fullwidth letters, ligatures, "①") into other characters. It is used to redact,
// never to match: `decoded` finds an address hidden in an encoded link. Host names are mapped by the
// runtime's IDNA only where the result is the name as written (lib/sites.ts). Identities, grants, names and
// searches are compared as typed.
test("compatibility normalization decides who or what something is nowhere", () => {
	const compatibility = sourceCode().filter(({ code }) => /["'`]NFK[CD]["'`]/.test(code));
	expect(compatibility.map(({ path }) => path).sort()).toEqual(["lib/text.ts"]);
	// Whatever its argument: a form held in a variable normalizes as well, and the default is NFC. NFC is for
	// file names and manifest paths (the scan's names among them), NFKC above; nothing else normalizes.
	const normalizing = sourceCode().filter(({ code }) => /\.normalize\s*\(/.test(code));
	expect(normalizing.map(({ path }) => path).sort()).toEqual(["files/manifest.ts", "files/names.ts", "lib/text.ts", "sandbox/scan.ts"]);
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

test("mode offline (the dev server without an account) is never built or deployed", () => {
	// Mode offline has the test build's entry, the fake model and debug on (cloudflare.config.ts). It exists
	// only under `vite --mode offline`, whose config marks the process with MINERVA_DEV_OFFLINE for a serve and
	// never for a build; the config refuses the mode without the mark; and nothing that deploys names it.
	const config = readFileSync(join(ROOT, "cloudflare.config.ts"), "utf8");
	const gate = config.slice(config.indexOf('if (mode === "offline")'));
	expect(gate.slice(0, gate.indexOf("return"))).toMatch(/MINERVA_DEV_OFFLINE !== "1"\)\s*throw/);

	const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
	// A build in the mode stops before the mark is set, even when the shell already has it.
	expect(vite).toMatch(/offline && command !== "serve"\) throw new Error/);
	expect(vite.indexOf('command !== "serve"')).toBeLessThan(vite.indexOf('process.env.MINERVA_DEV_OFFLINE = "1"'));

	// Only the vite config and the dev script set the mark.
	const setters: string[] = [];
	for (const path of [...sources("src"), ...sources("scripts"), "vite.config.ts", "cloudflare.config.ts", "package.json", "files-worker/package.json"]) {
		if (!existsSync(join(ROOT, path))) continue;
		for (const [line, number] of code(path)) if (/MINERVA_DEV_OFFLINE\s*(=|:)[^=]/.test(line) || /MINERVA_DEV_OFFLINE=/.test(line)) setters.push(`${path}:${number}`);
	}
	expect(setters.map((setter) => setter.split(":")[0])).toEqual(["scripts/dev-offline.ts", "vite.config.ts"]);

	// No script that deploys or builds for the account passes the mode.
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
	for (const [name, command] of Object.entries(pkg.scripts)) {
		if (name === "dev:offline" || name === "secrets:offline") continue;
		expect(command, name).not.toMatch(/offline/);
	}
	// And no Worker source reads the mark (it would be a way to switch behaviour at run time).
	for (const path of sources("src")) for (const [line, number] of code(path)) expect(line, `${path}:${number}`).not.toMatch(/MINERVA_DEV_OFFLINE/);
});

test("the account suites never skip a whole suite", () => {
	// A skipped required check looks like a pass (plan: Step 7): missing settings, misdirected origins and a
	// Chrome that does not start fail the run instead. A step may still skip itself after an earlier one failed,
	// or the Workers AI turn when the model never calls the tools (ctx.skip, reported).
	const offenders: string[] = [];
	for (const path of sources("test/account")) {
		if (!path.endsWith(".test.ts")) continue;
		for (const [line, number] of code(path)) if (/\b(describe|test|it)\.(skip|skipIf|runIf|todo)\b/.test(line)) offenders.push(`${path}:${number}`);
	}
	expect(offenders).toEqual([]);
});

test("every refusal code is sent somewhere", () => {
	// The list is the API's error map (shared/rpc.ts): a code nothing sends would be declared for nothing.
	// The connectors and the gateway have codes of their own, some with the same names, so they do not count.
	const used = new Set<string>();
	for (const path of sources("src")) {
		if (path === join("src", "shared", "rpc.ts") || path.startsWith(join("src", "connectors")) || path.startsWith(join("src", "gateway"))) continue;
		for (const [line] of code(path)) for (const match of line.matchAll(/"([A-Z][A-Z_]+)"/g)) used.add(match[1]!);
	}
	expect(Object.keys(REFUSALS).filter((code) => !used.has(code))).toEqual([]);
});
