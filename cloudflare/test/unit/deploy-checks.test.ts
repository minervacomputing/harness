// The checks scripts/deploy.ts and scripts/resources.ts make before anything on the account changes: the
// lifecycle rules a files bucket needs (scripts/lifecycle.ts) and the download origin's build against the
// app's (scripts/builds.ts), which fails closed when a test build would reach production or the other way
// round. The account itself is never asked here.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type BuiltWorker, buildAccount, buildDigest, filesBuildProblems, liveAppProblems, ownContainer } from "../../scripts/builds.ts";
import { namesOf } from "../../scripts/instance.ts";
import { ARCHIVE_MAX_AGE, type LifecycleRule, lifecycleExtras, lifecycleMatches, lifecycleProblems } from "../../scripts/lifecycle.ts";
import { hideSecrets, redact } from "../../scripts/run.ts";

const RULES = JSON.parse(readFileSync(new URL("../../r2-lifecycle.json", import.meta.url), "utf8")) as LifecycleRule[];

describe("the lifecycle rules", () => {
	test("r2-lifecycle.json has both, in the shape cf reports them", () => {
		expect(lifecycleProblems("bucket", RULES)).toEqual([]);
	});

	test("static/ must expire after exactly 30 days, enabled", () => {
		const archive = (change: (rule: LifecycleRule) => LifecycleRule) => RULES.map((rule) => (rule.conditions?.prefix === "static/" ? change(structuredClone(rule)) : rule));
		const sevenDays = archive((rule) => ({ ...rule, deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } } }));
		expect(lifecycleProblems("bucket", sevenDays)).toEqual(["R2 bucket bucket lacks the enabled lifecycle rule that deletes static/ after 30 days (r2-lifecycle.json)."]);
		expect(lifecycleProblems("bucket", archive((rule) => ({ ...rule, enabled: false })))).toHaveLength(1);
		expect(lifecycleProblems("bucket", archive((rule) => ({ ...rule, conditions: { prefix: "" } })))).toHaveLength(1);
		expect(ARCHIVE_MAX_AGE).toBe(2592000);
	});

	test("a reset keeps only the rules exactly as in the file, every field compared, whatever their key order", () => {
		const reordered = RULES.map((rule) => Object.fromEntries(Object.entries(rule).reverse()) as unknown as LifecycleRule);
		expect(lifecycleExtras(RULES, reordered)).toEqual([]);
		expect(lifecycleExtras(RULES, undefined)).toEqual([]);
		const changed = RULES.map((rule) => (rule.conditions?.prefix === "uploads/" ? { ...rule, conditions: { prefix: "" } } : rule));
		expect(lifecycleExtras(RULES, changed)).toEqual(["Expire unattached uploads"]);
		expect(lifecycleExtras(RULES, [...RULES, { id: "Someone else's", enabled: true }])).toEqual(["Someone else's"]);
	});

	test("a recreated bucket must have exactly the file's rules", () => {
		expect(lifecycleMatches(RULES, structuredClone(RULES))).toBe(true);
		expect(lifecycleMatches(RULES, RULES.slice(1))).toBe(false);
		expect(lifecycleMatches(RULES, [...RULES, { id: "More", enabled: true }])).toBe(false);
		expect(lifecycleMatches(RULES, RULES.map((rule) => ({ ...rule, enabled: !rule.enabled })))).toBe(false);
		expect(lifecycleMatches(RULES, undefined)).toBe(false);
	});

	test("a bucket without rules lacks both", () => {
		expect(lifecycleProblems("bucket", undefined)).toHaveLength(2);
		expect(lifecycleProblems("bucket", RULES.filter((rule) => rule.conditions?.prefix !== "uploads/"))).toEqual(["R2 bucket bucket lacks the enabled lifecycle rule that deletes uploads/ after a day (r2-lifecycle.json)."]);
	});
});

const ORIGIN = "https://files.minerva.example";

function app(name: string, buckets: [string, string]): BuiltWorker {
	return {
		name,
		env: {
			DB: { type: "d1", name },
			FILES: { type: "r2", name: buckets[0] },
			FILES_EU: { type: "r2", name: buckets[1], jurisdiction: "eu" },
			MINERVA_DOWNLOAD_ORIGIN: { type: "text", value: ORIGIN },
			MINERVA_DOWNLOAD_KEY: { type: "secret" },
			MINERVA_SECRET_KEY: { type: "secret" },
		},
	};
}

function files(name: string, buckets: [string, string], origin = ORIGIN): BuiltWorker {
	return {
		name,
		env: {
			FILES: { type: "r2", name: buckets[0] },
			FILES_EU: { type: "r2", name: buckets[1], jurisdiction: "eu" },
			MINERVA_DOWNLOAD_ORIGIN: { type: "text", value: origin },
			MINERVA_DOWNLOAD_KEY: { type: "secret" },
		},
	};
}

const TEST_NAMES = namesOf("acme-test");
const PRODUCTION_NAMES = namesOf("acme");
const TEST_BUCKETS: [string, string] = [TEST_NAMES.bucket, TEST_NAMES.bucketEu];
const PRODUCTION_BUCKETS: [string, string] = [PRODUCTION_NAMES.bucket, PRODUCTION_NAMES.bucketEu];

describe("the download origin's build", () => {
	test("passes when it is the instance's own, for either instance", () => {
		expect(filesBuildProblems(app("acme-test", TEST_BUCKETS), files("acme-test-files", TEST_BUCKETS), "acme-test")).toEqual([]);
		expect(filesBuildProblems(app("acme", PRODUCTION_BUCKETS), files("acme-files", PRODUCTION_BUCKETS), "acme")).toEqual([]);
	});

	test("a test build that would replace production's Worker or read its buckets is refused", () => {
		const testApp = app("acme-test", TEST_BUCKETS);
		expect(filesBuildProblems(testApp, files("acme-files", TEST_BUCKETS), "acme-test")).toEqual(["The download origin's build is acme-files, not acme-test-files."]);
		const reading = filesBuildProblems(testApp, files("acme-test-files", PRODUCTION_BUCKETS), "acme-test");
		expect(reading).toContain("The download origin's build binds buckets that are not acme-test's: acme-files, acme-files-eu.");
		expect(reading.some((line) => line.startsWith("The download origin's buckets"))).toBe(true);
		// Both builds pointing at production's buckets still fail: the buckets must be the test app's own.
		expect(filesBuildProblems(app("acme-test", PRODUCTION_BUCKETS), files("acme-test-files", PRODUCTION_BUCKETS), "acme-test")).toContain("The app's build binds buckets that are not acme-test's: acme-files, acme-files-eu.");
	});

	test("a production build that names the test instance's resources is refused", () => {
		expect(filesBuildProblems(app("acme-test", TEST_BUCKETS), files("acme-files", PRODUCTION_BUCKETS), "acme")).toContain("The app's build is acme-test, not acme.");
		expect(filesBuildProblems(app("acme", PRODUCTION_BUCKETS), files("acme-files", TEST_BUCKETS), "acme")).toContain("The download origin's build binds buckets that are not acme's: acme-test-files, acme-test-files-eu.");
	});

	test("its origin must be the app's, and the link key its only secret", () => {
		const testApp = app("acme-test", TEST_BUCKETS);
		expect(filesBuildProblems(testApp, files("acme-test-files", TEST_BUCKETS, "https://other.minerva.example"), "acme-test")).toEqual(["The download origin's MINERVA_DOWNLOAD_ORIGIN is not the app's."]);
		const extra = files("acme-test-files", TEST_BUCKETS);
		extra.env = { ...extra.env, MINERVA_SECRET_KEY: { type: "secret" } };
		expect(filesBuildProblems(testApp, extra, "acme-test")).toEqual(["The download origin must hold MINERVA_DOWNLOAD_KEY alone, not MINERVA_DOWNLOAD_KEY, MINERVA_SECRET_KEY."]);
		const bound = files("acme-test-files", TEST_BUCKETS);
		bound.env = { ...bound.env, DB: { type: "d1", name: "acme-test" } };
		expect(filesBuildProblems(testApp, bound, "acme-test")).toEqual(["The download origin's build has bindings it should not have: r2, r2, text, secret, d1."]);
	});

	test("one bucket missing is a difference from the app's", () => {
		const single = files("acme-test-files", TEST_BUCKETS);
		delete single.env?.FILES_EU;
		expect(filesBuildProblems(app("acme-test", TEST_BUCKETS), single, "acme-test")).toEqual([
			"The download origin's buckets (FILES=acme-test-files) are not the app's (FILES=acme-test-files, FILES_EU=acme-test-files-eu (eu)).",
		]);
	});

	test("an instance whose name the derivation cannot take is refused before anything is compared", () => {
		expect(() => filesBuildProblems(app("acme", PRODUCTION_BUCKETS), files("acme-files", PRODUCTION_BUCKETS), "acme-files")).toThrow("cannot end in -files");
	});
});

describe("what a deploy compares with the deployed app", () => {
	const live = {
		FILES: { type: "r2_bucket", bucket_name: "acme-test-files" },
		FILES_EU: { type: "r2_bucket", bucket_name: "acme-test-files-eu", jurisdiction: "eu" },
		MINERVA_DOWNLOAD_ORIGIN: { type: "plain_text", text: ORIGIN },
		MINERVA_DOWNLOAD_KEY: { type: "secret_text" },
	};

	test("the same buckets and origin pass", () => {
		expect(liveAppProblems(live, app("acme-test", TEST_BUCKETS))).toEqual([]);
	});

	test("another origin, other buckets or no deployed bindings fail", () => {
		expect(liveAppProblems({ ...live, MINERVA_DOWNLOAD_ORIGIN: { type: "plain_text", text: "https://other.minerva.example" } }, app("acme-test", TEST_BUCKETS))).toEqual(["The deployed app's MINERVA_DOWNLOAD_ORIGIN is not its local build's."]);
		expect(liveAppProblems(live, app("acme-test", PRODUCTION_BUCKETS))).toHaveLength(1);
		expect(liveAppProblems(undefined, app("acme-test", TEST_BUCKETS))).toHaveLength(2);
	});
});

describe("what a reset accepts as the instance's own", () => {
	test("a container is exactly <instance>-sandbox, so the test sandbox is never production's", () => {
		expect(ownContainer("acme-test", "acme-test-sandbox")).toBe(true);
		expect(ownContainer("acme", "acme-sandbox")).toBe(true);
		expect(ownContainer("acme", "acme-test-sandbox")).toBe(false);
		expect(ownContainer("acme-test", "acme-sandbox")).toBe(false);
		expect(ownContainer("acme", "acme-")).toBe(false);
	});

	test("a container that is any other word, or only starts with the instance's name, is not its own", () => {
		expect(ownContainer("acme", "acme-worker")).toBe(false);
		expect(ownContainer("acme", "acme-sandbox-2")).toBe(false);
		expect(ownContainer("acme", "acme-sandboxes")).toBe(false);
		expect(ownContainer("acme", "acme")).toBe(false);
	});
});

describe("the checked build", () => {
	function withBuild(check: (dir: string, output: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "build-digest-"));
		try {
			const output = join(dir, ".cloudflare", "output", "v0", "workers", "default");
			mkdirSync(output, { recursive: true });
			writeFileSync(join(dir, ".cloudflare", "output", "v0", "config.json"), JSON.stringify({ buildContext: {} }));
			writeFileSync(join(output, "worker.config.json"), JSON.stringify({ name: "acme-test" }));
			writeFileSync(join(output, "index.js"), "export default {}");
			check(dir, output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("its digest changes with any file of the build output, and only then", () => {
		withBuild((dir, output) => {
			const checked = buildDigest(dir);
			expect(buildDigest(dir)).toBe(checked);
			writeFileSync(join(output, "worker.config.json"), JSON.stringify({ name: "acme" }));
			expect(buildDigest(dir)).not.toBe(checked);
		});
	});

	test("a symbolic link in the output, whose target could change unseen, is refused", () => {
		withBuild((dir, output) => {
			symlinkSync(join(dir, "elsewhere.js"), join(output, "chunk.js"));
			expect(() => buildDigest(dir)).toThrow("not plain files: chunk.js");
		});
	});

	test("it names no account unless the configuration sets one", () => {
		withBuild((dir) => {
			expect(buildAccount(dir)).toBeUndefined();
			writeFileSync(join(dir, ".cloudflare", "output", "v0", "config.json"), JSON.stringify({ accountId: "another-account" }));
			expect(buildAccount(dir)).toBe("another-account");
		});
	});
});

describe("what the scripts print", () => {
	test("secrets and workers.dev hosts are replaced; short values are left alone", () => {
		const dir = mkdtempSync(join(tmpdir(), "hide-secrets-"));
		try {
			const file = join(dir, "secrets.env");
			writeFileSync(file, 'MINERVA_SECRET_KEY="0123456789abcdef0123456789abcdef"\nexport MINERVA_DOWNLOAD_KEY=fedcba9876543210fedcba9876543210\nMINERVA_SETUP_KEY="abcdefabcdefabcdefabcdef" # as dotenv reads it\nMINERVA_DEBUG=true\n');
			hideSecrets(file);
			hideSecrets(join(dir, "missing.env"));
			expect(redact("key 0123456789abcdef0123456789abcdef and fedcba9876543210fedcba9876543210, true, at https://acme-test.someone.workers.dev/x")).toBe("key <id> and <id>, true, at https://<workers.dev>/x");
			expect(redact("setup abcdefabcdefabcdefabcdef.")).toBe("setup <id>.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
