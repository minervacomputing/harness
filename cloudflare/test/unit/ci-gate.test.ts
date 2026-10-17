import { readFileSync, statSync } from "node:fs";
import { expect, test } from "vitest";
import { ENGINE_PATHS, FAULT_SUITES_STEP } from "../../scripts/ci-gate.ts";

const REPOSITORY = new URL("../../../", import.meta.url);
const workflow = (name: string) => readFileSync(new URL(`.github/workflows/${name}`, REPOSITORY), "utf8");

test("main.yml runs on a push that changes ENGINE_PATHS, a directory's files included", () => {
	const filter = /^ {2}push:\n(?: {4}.+\n)*? {4}paths:\n((?: {6}- .+\n)+)/m.exec(workflow("main.yml"))?.[1] ?? "";
	const globs = filter.trimEnd().split("\n").map((line) => line.replace(/^\s*- /, ""));
	const asGlob = (path: string) => (statSync(new URL(path, REPOSITORY), { throwIfNoEntry: false })?.isDirectory() ? `${path}/**` : path);
	expect(globs).toEqual(ENGINE_PATHS.map(asGlob));
});

test("account.yml's nightly run checks ENGINE_PATHS for the day's changes", () => {
	const fresh = /git log --since=[^\n]* -- ([^)]*)\)/.exec(workflow("account.yml"))?.[1] ?? "";
	expect(fresh.replaceAll("\\\n", " ").trim().split(/\s+/)).toEqual(ENGINE_PATHS);
});

test("account.yml has the step whose conclusion the gate reads", () => {
	expect(workflow("account.yml")).toContain(`      - name: ${FAULT_SUITES_STEP}\n`);
});
