// The checks scripts/deploy.ts and scripts/resources.ts make before anything on the account changes: the
// lifecycle rules a files bucket needs (scripts/lifecycle.ts) and the download origin's build against the
// app's (scripts/builds.ts), which fails closed when a test build would reach production or the other way
// round. The account itself is never asked here.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type BuiltWorker, buildAccount, buildDigest, filesBuildProblems, liveAppProblems, ownContainer } from "../../scripts/builds.ts";
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

const TEST_BUCKETS: [string, string] = ["minerva-cf-test-files", "minerva-cf-test-files-eu"];
const PRODUCTION_BUCKETS: [string, string] = ["minerva-cf-files", "minerva-cf-files-eu"];
const TEST = { app: "minerva-cf-test", files: "minerva-cf-files-test" };
const PRODUCTION = { app: "minerva-cf", files: "minerva-cf-files" };

describe("the download origin's build", () => {
	test("passes when it is the instance's own, for either instance", () => {
		expect(filesBuildProblems(app("minerva-cf-test", TEST_BUCKETS), files("minerva-cf-files-test", TEST_BUCKETS), TEST)).toEqual([]);
		expect(filesBuildProblems(app("minerva-cf", PRODUCTION_BUCKETS), files("minerva-cf-files", PRODUCTION_BUCKETS), PRODUCTION)).toEqual([]);
	});

	test("a test build that would replace production's Worker or read its buckets is refused", () => {
		const testApp = app("minerva-cf-test", TEST_BUCKETS);
		expect(filesBuildProblems(testApp, files("minerva-cf-files", TEST_BUCKETS), TEST)).toEqual(["The download origin's build is minerva-cf-files, not minerva-cf-files-test."]);
		const reading = filesBuildProblems(testApp, files("minerva-cf-files-test", PRODUCTION_BUCKETS), TEST);
		expect(reading).toContain("The download origin's build binds buckets that are not minerva-cf-test's: minerva-cf-files, minerva-cf-files-eu.");
		expect(reading.some((line) => line.startsWith("The download origin's buckets"))).toBe(true);
		// Both builds pointing at production's buckets still fail: the buckets must be the test app's own.
		expect(filesBuildProblems(app("minerva-cf-test", PRODUCTION_BUCKETS), files("minerva-cf-files-test", PRODUCTION_BUCKETS), TEST)).toContain("The app's build binds buckets that are not minerva-cf-test's: minerva-cf-files, minerva-cf-files-eu.");
	});

	test("a production build that names the test instance's resources is refused", () => {
		expect(filesBuildProblems(app("minerva-cf-test", TEST_BUCKETS), files("minerva-cf-files", PRODUCTION_BUCKETS), PRODUCTION)).toContain("The app's build is minerva-cf-test, not minerva-cf.");
		expect(filesBuildProblems(app("minerva-cf", PRODUCTION_BUCKETS), files("minerva-cf-files", TEST_BUCKETS), PRODUCTION)).toContain("The download origin's build binds buckets that are not minerva-cf's: minerva-cf-test-files, minerva-cf-test-files-eu.");
	});

	test("its origin must be the app's, and the link key its only secret", () => {
		const testApp = app("minerva-cf-test", TEST_BUCKETS);
		expect(filesBuildProblems(testApp, files("minerva-cf-files-test", TEST_BUCKETS, "https://other.minerva.example"), TEST)).toEqual(["The download origin's MINERVA_DOWNLOAD_ORIGIN is not the app's."]);
		const extra = files("minerva-cf-files-test", TEST_BUCKETS);
		extra.env = { ...extra.env, MINERVA_SECRET_KEY: { type: "secret" } };
		expect(filesBuildProblems(testApp, extra, TEST)).toEqual(["The download origin must hold MINERVA_DOWNLOAD_KEY alone, not MINERVA_DOWNLOAD_KEY, MINERVA_SECRET_KEY."]);
		const bound = files("minerva-cf-files-test", TEST_BUCKETS);
		bound.env = { ...bound.env, DB: { type: "d1", name: "minerva-cf-test" } };
		expect(filesBuildProblems(testApp, bound, TEST)).toEqual(["The download origin's build has bindings it should not have: r2, r2, text, secret, d1."]);
	});

	test("one bucket missing is a difference from the app's", () => {
		const single = files("minerva-cf-files-test", TEST_BUCKETS);
		delete single.env?.FILES_EU;
		expect(filesBuildProblems(app("minerva-cf-test", TEST_BUCKETS), single, TEST)).toEqual([
			"The download origin's buckets (FILES=minerva-cf-test-files) are not the app's (FILES=minerva-cf-test-files, FILES_EU=minerva-cf-test-files-eu (eu)).",
		]);
	});
});

describe("what a deploy compares with the deployed app", () => {
	const live = {
		FILES: { type: "r2_bucket", bucket_name: "minerva-cf-test-files" },
		FILES_EU: { type: "r2_bucket", bucket_name: "minerva-cf-test-files-eu", jurisdiction: "eu" },
		MINERVA_DOWNLOAD_ORIGIN: { type: "plain_text", text: ORIGIN },
		MINERVA_DOWNLOAD_KEY: { type: "secret_text" },
	};

	test("the same buckets and origin pass", () => {
		expect(liveAppProblems(live, app("minerva-cf-test", TEST_BUCKETS))).toEqual([]);
	});

	test("another origin, other buckets or no deployed bindings fail", () => {
		expect(liveAppProblems({ ...live, MINERVA_DOWNLOAD_ORIGIN: { type: "plain_text", text: "https://other.minerva.example" } }, app("minerva-cf-test", TEST_BUCKETS))).toEqual(["The deployed app's MINERVA_DOWNLOAD_ORIGIN is not its local build's."]);
		expect(liveAppProblems(live, app("minerva-cf-test", PRODUCTION_BUCKETS))).toHaveLength(1);
		expect(liveAppProblems(undefined, app("minerva-cf-test", TEST_BUCKETS))).toHaveLength(2);
	});
});

describe("what a reset accepts as the instance's own", () => {
	test("a container is <instance>-<word>, so the test sandbox is never production's", () => {
		expect(ownContainer("minerva-cf-test", "minerva-cf-test-sandbox")).toBe(true);
		expect(ownContainer("minerva-cf", "minerva-cf-sandbox")).toBe(true);
		expect(ownContainer("minerva-cf", "minerva-cf-test-sandbox")).toBe(false);
		expect(ownContainer("minerva-cf-test", "minerva-cf-sandbox")).toBe(false);
		expect(ownContainer("minerva-cf", "minerva-cf-")).toBe(false);
	});
});

describe("the checked build", () => {
	function withBuild(check: (dir: string, output: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "build-digest-"));
		try {
			const output = join(dir, ".cloudflare", "output", "v0", "workers", "default");
			mkdirSync(output, { recursive: true });
			writeFileSync(join(dir, ".cloudflare", "output", "v0", "config.json"), JSON.stringify({ buildContext: {} }));
			writeFileSync(join(output, "worker.config.json"), JSON.stringify({ name: "minerva-cf-test" }));
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
			writeFileSync(join(output, "worker.config.json"), JSON.stringify({ name: "minerva-cf" }));
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
			expect(redact("key 0123456789abcdef0123456789abcdef and fedcba9876543210fedcba9876543210, true, at https://minerva-cf-test.someone.workers.dev/x")).toBe("key <id> and <id>, true, at https://<workers.dev>/x");
			expect(redact("setup abcdefabcdefabcdefabcdef.")).toBe("setup <id>.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
