// The account suites' check of where they send requests (test/account/origins.ts): only the test instance's
// own Workers on workers.dev, both on one subdomain, and never a message that repeats the configured value.

import { describe, expect, test } from "vitest";
import { namesOf } from "../../scripts/instance.ts";
import { chromeFailure, testOrigin, testOrigins } from "../account/origins.ts";

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
		expect(testOrigin(APP, TEST_APP, "MINERVA_SITE_URL")).toBe(APP);
		expect(testOrigin(`${APP}/`, TEST_APP, "MINERVA_SITE_URL")).toBe(APP);
		expect(testOrigin(` ${FILES}\n`, TEST_FILES, "MINERVA_DOWNLOAD_ORIGIN")).toBe(FILES);
		expect(testOrigin(APP.toUpperCase().replace("HTTPS", "https"), TEST_APP, "MINERVA_SITE_URL")).toBe(APP);
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
		const message = refusal(() => testOrigin(value, name, "SETTING"));
		expect(message).toMatch(/^SETTING /);
		expect(message).not.toContain(SUB);
		expect(message).not.toContain("acme-test.");
	});

	test("the two origins must be on one subdomain", () => {
		const names = { site: "SITE", download: "DOWNLOAD" };
		expect(testOrigins(APP, FILES, names, TEST)).toEqual({ origin: APP, downloadOrigin: FILES });
		const message = refusal(() => testOrigins(APP, "https://acme-test-files.other7q.workers.dev", names, TEST));
		expect(message).toMatch(/^SITE and DOWNLOAD /);
		expect(message).not.toContain(SUB);
		expect(message).not.toContain("other7q");
		expect(refusal(() => testOrigins(APP, `https://acme-files.${SUB}.workers.dev`, names, TEST))).toMatch(/^DOWNLOAD /);
		expect(refusal(() => testOrigins(`https://acme.${SUB}.workers.dev`, FILES, names, TEST))).toMatch(/^SITE /);
	});

	test("Chrome failing to start names neither host", () => {
		const hosts = [`${TEST_APP}.${SUB}.workers.dev`, `${TEST_FILES}.${SUB}.workers.dev`];
		const launcher = new Error(`browserType.launch: Chrome exited (--host-resolver-rules=MAP ${hosts[0]} 192.0.2.1,MAP ${hosts[1]} 192.0.2.2)\nCall log:\n  - ${hosts[0]}`);
		const failure = chromeFailure(launcher, hosts);
		expect(failure.message).toMatch(/^Google Chrome did not start .*: browserType\.launch: Chrome exited \(--host-resolver-rules=MAP <host> 192\.0\.2\.1,MAP <host> 192\.0\.2\.2\)$/);
		expect(failure.cause).toBeUndefined();
		for (const text of [failure.message, failure.stack ?? ""]) expect(text).not.toContain(SUB);
		expect(chromeFailure(`not an Error, ${hosts[1]}`, hosts).message).not.toContain(SUB);
	});
});
