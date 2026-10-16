// The checks scripts/deploy.ts, scripts/reset.ts and scripts/resources.ts make before anything on the account
// changes: the lifecycle rules a files bucket needs (scripts/lifecycle.ts), the app's build against the instance's names
// (scripts/builds.ts), which fails closed when a test build would reach production or the other way round,
// which build a live app's bindings are (scripts/account.ts, for the identity check), the namespaces a build would
// strand and the secrets a deploy deletes (scripts/builds.ts, scripts/retirement.ts), and the order in which a deploy
// and a reset check and change things. The account itself is never asked here (schema-check.test.ts runs
// the identity check against a stand-in for cf).

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bindingsKind } from "../../scripts/account.ts";
import { type BuiltWorker, type LiveBinding, appBuildProblems, buildAccount, buildDigest, declaredSecrets, ownContainer, strayClasses } from "../../scripts/builds.ts";
import { namesOf } from "../../scripts/instance.ts";
import { ARCHIVE_MAX_AGE, type LifecycleRule, lifecycleExtras, lifecycleMatches, lifecycleProblems } from "../../scripts/lifecycle.ts";
import { imageTag } from "../../scripts/image.ts";
import { undeclaredSecrets } from "../../scripts/retirement.ts";
import { SANDBOX_IMAGE_REFERENCE } from "../../scripts/instance.ts";
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

function app(name: string, buckets: [string, string]): BuiltWorker {
	return {
		name,
		env: {
			DB: { type: "d1", name },
			FILES: { type: "r2", name: buckets[0] },
			FILES_EU: { type: "r2", name: buckets[1], jurisdiction: "eu" },
			MINERVA_SECRET_KEY: { type: "secret" },
		},
	};
}

const TEST_NAMES = namesOf("acme-test");
const PRODUCTION_NAMES = namesOf("acme");
const TEST_BUCKETS: [string, string] = [TEST_NAMES.bucket, TEST_NAMES.bucketEu];
const PRODUCTION_BUCKETS: [string, string] = [PRODUCTION_NAMES.bucket, PRODUCTION_NAMES.bucketEu];

describe("the app's build", () => {
	test("passes when it is the instance's own, for either instance", () => {
		expect(appBuildProblems(app("acme-test", TEST_BUCKETS), "acme-test")).toEqual([]);
		expect(appBuildProblems(app("acme", PRODUCTION_BUCKETS), "acme")).toEqual([]);
	});

	test("a test build that would read production's buckets is refused", () => {
		expect(appBuildProblems(app("acme-test", PRODUCTION_BUCKETS), "acme-test")).toEqual(["The app's build binds buckets that are not acme-test's: acme-files, acme-files-eu."]);
	});

	test("a production build that names the test instance's Worker or buckets is refused", () => {
		expect(appBuildProblems(app("acme-test", PRODUCTION_BUCKETS), "acme")).toEqual(["The app's build is acme-test, not acme."]);
		expect(appBuildProblems(app("acme", TEST_BUCKETS), "acme")).toEqual(["The app's build binds buckets that are not acme's: acme-test-files, acme-test-files-eu."]);
	});

	test("an instance whose name the derivation cannot take is refused before anything is compared", () => {
		expect(() => appBuildProblems(app("acme", PRODUCTION_BUCKETS), "acme-files")).toThrow("cannot end in -files");
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

describe("the namespaces a build would strand (strayClasses), which stop a deploy and a reset", () => {
	const build = (exports: BuiltWorker["exports"]): BuiltWorker => ({ name: "acme-test", exports });
	const live = { type: "durable-object", storage: "sqlite" };
	const deleted = { type: "durable-object", state: "deleted" };
	const namespaces = (...classes: string[]) => classes.map((name) => ({ class: name }));

	test("a class the build exports, live or as a tombstone, is no stray", () => {
		const tombstoned = build({ Conversation: live, Sandbox: live, Workspace: deleted, FaultMailbox: deleted });
		expect(strayClasses(namespaces("Conversation", "Sandbox", "Workspace", "FaultMailbox"), tombstoned)).toEqual([]);
		expect(strayClasses(namespaces(), tombstoned)).toEqual([]);
	});

	test("a class the build dropped while its namespace exists is one, named once and in order", () => {
		const dropped = build({ Conversation: live, Sandbox: live });
		expect(strayClasses(namespaces("Workspace", "Conversation", "FaultMailbox", "Workspace"), dropped)).toEqual(["FaultMailbox", "Workspace"]);
		expect(strayClasses(namespaces("Workspace"), build(undefined))).toEqual(["Workspace"]);
	});

	test("an export that is not a Durable Object does not cover a namespace", () => {
		expect(strayClasses(namespaces("Workspace"), build({ Workspace: { type: "worker" } }))).toEqual(["Workspace"]);
	});
});

describe("the secrets a deploy deletes from the app Worker (undeclaredSecrets)", () => {
	const app: BuiltWorker = {
		name: "acme",
		env: {
			MINERVA_SECRET_KEY: { type: "secret" },
			MINERVA_STREAM_KEYS: { type: "secret" },
			MINERVA_ACCESS_CLIENTS: { type: "plain_text", value: "client.access" },
			MINERVA_GITHUB_CLIENT_ID: { type: "plain_text", value: "not a secret" },
		},
	};

	test("the build declares only its secret bindings", () => {
		expect(declaredSecrets(app)).toEqual(["MINERVA_SECRET_KEY", "MINERVA_STREAM_KEYS"]);
	});

	test("a declared secret stays, the retired ones go, and any other undeclared one is only named", () => {
		// A Worker that was quiesced by a reset and deployed again keeps every secret it ever had.
		const onWorker = ["MINERVA_SECRET_KEY", "MINERVA_STREAM_KEYS", "MINERVA_LARAVEL_TOKEN", "MINERVA_SETUP_KEY", "MINERVA_ENCRYPTION_KEYS", "MINERVA_DOWNLOAD_KEY", "MINERVA_SLACK_CLIENT_SECRET", "MINERVA_GOOGLE_DRIVE_CLIENT_ID", "MINERVA_MODEL_API_KEY", "SOMEONE_ELSES"];
		expect(undeclaredSecrets(onWorker, app)).toEqual({
			retired: ["MINERVA_DOWNLOAD_KEY", "MINERVA_ENCRYPTION_KEYS", "MINERVA_GOOGLE_DRIVE_CLIENT_ID", "MINERVA_SETUP_KEY", "MINERVA_SLACK_CLIENT_SECRET"],
			other: ["MINERVA_LARAVEL_TOKEN", "MINERVA_MODEL_API_KEY", "SOMEONE_ELSES"],
		});
	});

	test("a retired name the build declares again stays", () => {
		const declaring: BuiltWorker = { env: { MINERVA_SETUP_KEY: { type: "secret" }, MINERVA_GITHUB_CLIENT_SECRET: { type: "secret" } } };
		expect(undeclaredSecrets(["MINERVA_SETUP_KEY", "MINERVA_GITHUB_CLIENT_SECRET", "MINERVA_GITHUB_CLIENT_ID"], declaring)).toEqual({ retired: ["MINERVA_GITHUB_CLIENT_ID"], other: [] });
	});

	test("names that only resemble a client pair are not retired", () => {
		expect(undeclaredSecrets(["MINERVA_ACCESS_CLIENTS", "MINERVA_CLIENT_ID", "MINERVA_GITHUB_CLIENT_IDS", "OTHER_GITHUB_CLIENT_ID"], app)).toEqual({
			retired: [],
			other: ["MINERVA_ACCESS_CLIENTS", "MINERVA_CLIENT_ID", "MINERVA_GITHUB_CLIENT_IDS", "OTHER_GITHUB_CLIENT_ID"],
		});
	});
});

const ORIGIN = "https://site.minerva.example";

describe("which build a live app is, from its bindings (the identity check without a row)", () => {
	const object = (className: string): LiveBinding => ({ type: "durable_object_namespace", class_name: className });
	const APP: Record<string, LiveBinding> = {
		DB: { type: "d1" },
		CONVERSATION: object("Conversation"),
		FILES: { type: "r2_bucket", bucket_name: "acme-files" },
		MINERVA_SITE_URL: { type: "plain_text", text: ORIGIN },
	};
	const PRODUCTION = APP;
	const TEST = { ...APP, FAULT_PROVIDER: object("FaultProvider") };

	test("both builds bind the Conversation; the test build binds FaultProvider too, the production build not at all", () => {
		expect(bindingsKind(TEST)).toBe("test");
		expect(bindingsKind(PRODUCTION)).toBe("production");
	});

	test("a build from before 13b, with the mailbox or Email Sending, is recognised too", () => {
		expect(bindingsKind({ ...TEST, FAULT_MAILBOX: object("FaultMailbox") })).toBe("test");
		expect(bindingsKind({ ...PRODUCTION, EMAIL: { type: "send_email" } })).toBe("production");
	});

	test("the quiesced instance of a reset has the app's secrets alone, which its versions inherit, or nothing", () => {
		const secret: LiveBinding = { type: "secret_text" };
		expect(bindingsKind({ MINERVA_SECRET_KEY: secret, MINERVA_ENCRYPTION_KEYS: secret, MINERVA_DOWNLOAD_KEY: secret, MINERVA_SETUP_KEY: secret })).toBe("quiesced");
		expect(bindingsKind({})).toBe("quiesced");
		expect(bindingsKind(undefined)).toBe("quiesced");
		expect(bindingsKind({ MINERVA_SECRET_KEY: secret, MINERVA_SITE_URL: { type: "plain_text", text: ORIGIN } })).toBe("unknown");
		expect(bindingsKind({ MINERVA_SECRET_KEY: secret, DB: { type: "d1" } })).toBe("unknown");
	});

	test("any other shape is unknown: FaultProvider of another type, no Conversation object, neither", () => {
		const { CONVERSATION: _conversation, ...noConversation } = APP;
		for (const env of [
			{ ...noConversation, FAULT_PROVIDER: object("FaultProvider") },
			{ ...PRODUCTION, FAULT_PROVIDER: { type: "service" } },
			{ ...PRODUCTION, FAULT_PROVIDER: { type: "plain_text", text: "x" } },
			{ ...APP, CONVERSATION: { type: "service" } },
			noConversation,
			{ ...noConversation, EMAIL: { type: "send_email" } },
		]) {
			expect(bindingsKind(env), JSON.stringify(env)).toBe("unknown");
		}
	});
});

describe("the order of a reset's checks and changes (scripts/reset.ts)", () => {
	const reset = readFileSync(new URL("../../scripts/reset.ts", import.meta.url), "utf8");
	const positions = (markers: string[]) => markers.map((marker) => [marker, reset.indexOf(marker)] as const);

	test("the identity is checked before the dry run's listing, with the flag's kind; it is recorded with --yes only", () => {
		expect(reset).toContain('run(process.execPath, ["scripts/identity.ts", "--instance", INSTANCE.name, TEST ? "--test" : "--production", ...(YES ? ["--record"] : [])], { print: true });');
		const order = positions(['const account = pinAccount(', '"scripts/identity.ts", "--instance"', "workerExists(NAME)", "accountSubdomain();", '"scripts/schema-check.ts"', 'step("What the reset deletes")', "if (!YES) {"]);
		for (const [marker, index] of order) expect(index, marker).toBeGreaterThan(0);
		expect(order.map(([, index]) => index)).toEqual(order.map(([, index]) => index).sort((a, b) => a - b));
	});

	test("the quiescing comes after the identity's record, and D1, which holds the row, is deleted last", () => {
		const order = positions(['"scripts/identity.ts", "--instance"', "if (!YES) {", 'run("cf", ["deploy", "--prebuilt", "--no-provision"]', '"containers", "applications", "delete"', '"r2", "objects", "bulk-delete"', '"r2", "buckets", "delete"', 'run("cf", ["d1", "delete"']);
		for (const [marker, index] of order) expect(index, marker).toBeGreaterThan(0);
		expect(order.map(([, index]) => index)).toEqual(order.map(([, index]) => index).sort((a, b) => a - b));
		// Nothing is deleted after it.
		expect(reset.slice(0, reset.lastIndexOf('"delete"')).endsWith('run("cf", ["d1", ')).toBe(true);
	});
});

describe("the order of the lab's deploy (scripts/deploy.ts --lab)", () => {
	test("its origin and the instance's identity are checked before it is built and deployed", () => {
		const deploy = readFileSync(new URL("../../scripts/deploy.ts", import.meta.url), "utf8");
		const lab = deploy.slice(deploy.indexOf("function deployLab("));
		const order = ["const origin = labOrigin(INSTANCE);", "checkOnAccount([{ origin, setting:", "checkIdentity(false);", 'run("cf", ["build"], { cwd: LAB_DIR', 'run("cf", ["deploy", "--prebuilt", "--secrets-file", INSTANCE.files.cm]'].map((marker) => lab.indexOf(marker));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

describe("the sandbox image's tag (scripts/image.ts)", () => {
	function withContext(check: (dir: string) => void) {
		const dir = mkdtempSync(join(tmpdir(), "image-tag-"));
		try {
			mkdirSync(join(dir, "minerva"));
			writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
			writeFileSync(join(dir, "minerva", "probe"), "#!/bin/sh\n");
			chmodSync(join(dir, "minerva", "probe"), 0o755);
			check(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("the same context gives the same tag, in the repository the references name", () => {
		withContext((dir) => {
			const tag = imageTag(dir);
			expect(tag).toMatch(/^minerva-sandbox:[0-9a-f]{24}$/);
			expect(imageTag(dir)).toBe(tag);
			expect(SANDBOX_IMAGE_REFERENCE.test(`${tag}@sha256:${"a".repeat(64)}`)).toBe(true);
			expect(SANDBOX_IMAGE_REFERENCE.test(tag)).toBe(false);
		});
	});

	test("a file's content, its executable bit, a name or an empty directory changes it", () => {
		withContext((dir) => {
			const tag = imageTag(dir);
			const changes: [() => void, () => void][] = [
				[() => writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n\n"), () => writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n")],
				[() => chmodSync(join(dir, "minerva", "probe"), 0o644), () => chmodSync(join(dir, "minerva", "probe"), 0o755)],
				[() => writeFileSync(join(dir, "minerva", "other"), ""), () => rmSync(join(dir, "minerva", "other"))],
				[() => mkdirSync(join(dir, "empty")), () => rmSync(join(dir, "empty"), { recursive: true })],
			];
			for (const [change, undo] of changes) {
				change();
				expect(imageTag(dir)).not.toBe(tag);
				undo();
				expect(imageTag(dir)).toBe(tag);
			}
		});
	});

	test("permission bits other than the executable one do not", () => {
		withContext((dir) => {
			const tag = imageTag(dir);
			chmodSync(join(dir, "Dockerfile"), 0o664);
			chmodSync(join(dir, "minerva"), 0o775);
			expect(imageTag(dir)).toBe(tag);
		});
	});

	test("a symbolic link stops it", () => {
		withContext((dir) => {
			symlinkSync("Dockerfile", join(dir, "link"));
			expect(() => imageTag(dir)).toThrow(/not a plain file or directory/);
		});
	});

	test("a deploy has the image before the app's build, which must run it", () => {
		const deploy = readFileSync(new URL("../../scripts/deploy.ts", import.meta.url), "utf8");
		const order = ["const account = pinAccount(", "image = await ensureImage(account);", "process.env.MINERVA_SANDBOX_IMAGE = image;", 'run("cf", ["build", "--mode", MODE], { print: false });', "builtImage(ROOT, INSTANCE.names.container)?.reference !== image", 'run("cf", ["deploy", "--prebuilt", "--secrets-file", upload]'].map((marker) => deploy.indexOf(marker));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
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
