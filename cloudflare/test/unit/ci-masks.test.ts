// What CI's instance masks in the public Actions log (scripts/masks.ts, docs/plans/ci-account-suites.md): every
// value of its secrets and settings that a log could show, as GitHub's `::add-mask::` commands.

import { describe, expect, test } from "vitest";
import { ciMaskValues, maskCommands } from "../../scripts/masks.ts";
import { faultsToken } from "../../src/faults/token.ts";

const SECRET_KEY = "s3cr3t-key-of-forty-characters-0123456789";
const SECRETS = [`MINERVA_SECRET_KEY=${SECRET_KEY}`, 'MINERVA_ENCRYPTION_KEYS="v1:fernet-key-0123456789abcdef"', "export MINERVA_SETUP_KEY='setup-key-0123456789'", "SHORT=yes", ""].join("\n");
const VARS = ["MINERVA_SITE_URL=https://ci.acme-sub.workers.dev", "MINERVA_DOWNLOAD_ORIGIN=https://ci-files.acme-sub.workers.dev/", "MINERVA_MODEL_PROVIDER=fake", ""].join("\n");

describe("the values CI masks", () => {
	test("the account, each secret in both readings, the fault token, the origins, their hosts and the subdomain", async () => {
		const values = await ciMaskValues({ account: " 0123456789abcdef0123456789abcdef\n", secrets: SECRETS, vars: VARS });
		expect(values).toEqual(
			expect.arrayContaining([
				"0123456789abcdef0123456789abcdef",
				SECRET_KEY,
				"v1:fernet-key-0123456789abcdef",
				"setup-key-0123456789",
				await faultsToken(SECRET_KEY),
				"https://ci.acme-sub.workers.dev",
				"ci.acme-sub.workers.dev",
				"https://ci-files.acme-sub.workers.dev/",
				"https://ci-files.acme-sub.workers.dev",
				"ci-files.acme-sub.workers.dev",
				"acme-sub",
			]),
		);
		expect(values).not.toContain("yes");
		expect(values).not.toContain("fake");
		expect(new Set(values).size).toBe(values.length);
	});

	test("settings that are not origins add nothing", async () => {
		expect(await ciMaskValues({ account: "id", secrets: "", vars: "MINERVA_SITE_URL=not a url\n" })).toEqual(["id"]);
	});
});

describe("the mask commands", () => {
	test("one per line of each value, escaped, without blank lines or repeats", () => {
		expect(maskCommands(["a%b", "line one\nline two", "x\r", "line one", "  "])).toEqual(["::add-mask::a%25b", "::add-mask::line one", "::add-mask::line two", "::add-mask::x%0D"]);
	});
});
