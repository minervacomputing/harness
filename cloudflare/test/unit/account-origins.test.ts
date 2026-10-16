// An instance's origins (scripts/origins.ts): the app's, derived from its Worker's name and the account's workers.dev
// subdomain, and the check of a configured one (the lab's), which the lab's deploy and the account suites make before
// anything is sent there: only the chosen instance's own Workers on workers.dev, and never a message that repeats the
// configured value.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { namesOf } from "../../scripts/instance.ts";
import { instanceOrigin, subdomainOf, workersDevOrigin } from "../../scripts/origins.ts";

/** A subdomain no message may contain. */
const SUB = "acct7q";
/** A test instance and a production one, as a fixture: nothing here names ours. */
const TEST = namesOf("acme-test");
const TEST_APP = TEST.app;
const TEST_FILES = TEST.download;
const APP = `https://${TEST_APP}.${SUB}.workers.dev`;
const FILES = `https://${TEST_FILES}.${SUB}.workers.dev`;

function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	return "";
}

describe("the test instance's origins", () => {
	test("the test Workers' workers.dev origins are accepted, as origins", () => {
		expect(instanceOrigin(APP, TEST_APP, "SETTING")).toBe(APP);
		expect(instanceOrigin(`${APP}/`, TEST_APP, "SETTING")).toBe(APP);
		expect(instanceOrigin(` ${FILES}\n`, TEST_FILES, "SETTING")).toBe(FILES);
		expect(instanceOrigin(APP.toUpperCase().replace("HTTPS", "https"), TEST_APP, "SETTING")).toBe(APP);
	});

	test.each([
		["production's app", `https://acme.${SUB}.workers.dev`, TEST_APP],
		["production's download origin", `https://acme-files.${SUB}.workers.dev`, TEST_FILES],
		["the app where the download origin belongs", APP, TEST_FILES],
		["a longer name", `https://acme-test-2.${SUB}.workers.dev`, TEST_APP],
		["the name lower in the host", `https://www.acme-test.${SUB}.workers.dev`, TEST_APP],
		["the name on another domain", `https://acme-test.${SUB}.example`, TEST_APP],
		["the name on a lookalike of workers.dev", `https://acme-test.${SUB}.workers.dev.example`, TEST_APP],
		["a deeper workers.dev host", `https://acme-test.x.${SUB}.workers.dev`, TEST_APP],
		["no subdomain", "https://acme-test.workers.dev", TEST_APP],
		["a trailing dot", `https://acme-test.${SUB}.workers.dev.`, TEST_APP],
		["the bare name", "https://acme-test", TEST_APP],
		["http", `http://acme-test.${SUB}.workers.dev`, TEST_APP],
		["a path", `${APP}/api`, TEST_APP],
		["a port", `https://acme-test.${SUB}.workers.dev:8443`, TEST_APP],
		["a query", `${APP}/?x=1`, TEST_APP],
		["credentials", `https://user@acme-test.${SUB}.workers.dev`, TEST_APP],
		["nothing", undefined, TEST_APP],
		["not a URL", `acme-test.${SUB}.workers.dev`, TEST_APP],
	] as const)("%s is refused, without repeating the value", (_case, value, name) => {
		const message = refusal(() => instanceOrigin(value, name, "SETTING"));
		expect(message).toMatch(/^SETTING /);
		expect(message).not.toContain(SUB);
		expect(message).not.toContain("acme-test.");
	});

	test("the app's origin is its Worker on the account's subdomain, which it gives back", () => {
		expect(workersDevOrigin(TEST_APP, SUB)).toBe(APP);
		expect(subdomainOf(workersDevOrigin(TEST_APP, SUB))).toBe(SUB);
		for (const subdomain of ["", "a.b", "a/b"]) {
			expect(refusal(() => workersDevOrigin(TEST_APP, subdomain)), subdomain).toMatch(/^The workers\.dev origin of acme-test /);
		}
	});

	test("the suites take the subdomain from the account's Workers, and in GitHub Actions mask it first", () => {
		const bin = mkdtempSync(join(tmpdir(), "account-subdomain-"));
		try {
			const workers = [
				{ id: "w1", name: TEST_APP, subdomain: { url: `${APP}/` } },
				{ id: "w2", name: "other", subdomain: { url: `https://other.${SUB}.workers.dev` } },
				{ id: "w3", name: "unrouted" },
			];
			writeFileSync(
				join(bin, "cf"),
				`#!/usr/bin/env node\nif (process.argv.slice(2, 4).join(" ") === "workers list") console.log(${JSON.stringify(JSON.stringify(workers))});\nelse process.exit(2);\n`,
				{ mode: 0o755 },
			);
			const derive = (actions: string | undefined) =>
				spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`import { accountSubdomain } from "${new URL("../../scripts/account.ts", import.meta.url).pathname}";
import { workersDevOrigin } from "${new URL("../../scripts/origins.ts", import.meta.url).pathname}";
console.log(workersDevOrigin(${JSON.stringify(TEST_APP)}, accountSubdomain()));`,
					],
					{ encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: actions } as NodeJS.ProcessEnv },
				);
			expect(derive("true")).toMatchObject({ status: 0, stdout: `::add-mask::${SUB}\n${APP}\n` });
			expect(derive(undefined)).toMatchObject({ status: 0, stdout: `${APP}\n` });
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
});
