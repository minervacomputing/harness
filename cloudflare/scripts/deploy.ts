// Deploys an instance: the app and its download origin (cloudflare/README.md, Deploy).
//
//   node scripts/deploy.ts                 production's app and download origin (`pnpm run deploy`)
//   node scripts/deploy.ts --test          the test instance's (`pnpm run deploy:test`)
//   … --files-only                         only the download origin, after a deploy whose last step failed
//
// One deploy or reset runs at a time from a checkout, and every cf command goes to one account (`lock` and
// `pinAccount` in scripts/run.ts). Everything that can fail locally runs before anything on the account
// changes: the secrets are checked, both Workers are built, the app's bundle is checked for the test build's
// code (scripts/bundle.ts) and its startup CPU measured locally (scripts/startup.ts), and the download origin's build is checked against the app's (its name, its
// buckets, its origin); with --files-only, against the app actually deployed as well, and against this
// checkout's record of that deploy (its version and link key, in .cloudflare/deployed.json). Only then are the
// resources checked and D1's migrations applied (scripts/resources.ts), the deployed schema compared with the
// migrations (scripts/schema-check.ts) and the two checked builds uploaded, the app first (a build that
// changed since its check stops the deploy). The download origin gets only MINERVA_DOWNLOAD_KEY, through an
// owner-only file in a fresh temporary directory that is removed whatever happens. `pnpm assets` (the
// frontend) runs before this script.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LiveBinding, buildAccount, buildDigest, fileDigest, filesBuildProblems, liveAppProblems, readBuild } from "./builds.ts";
import { namesOf, todaysInstance } from "./instance.ts";
import { CommandFailed, ROOT, cfJson, hide, hideOrigin, hideSecrets, lock, pinAccount, readEnv, run } from "./run.ts";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--test" && arg !== "--files-only");
if (unknown.length) {
	console.error(`Unknown arguments: ${unknown.join(" ")}. Usage: deploy.ts [--test] [--files-only]`);
	process.exit(2);
}
const TEST = args.includes("--test");
const FILES_ONLY = args.includes("--files-only");
const MODE = TEST ? "faults" : "production";
const INSTANCE = todaysInstance(TEST);
const { app: APP, download: FILES } = namesOf(INSTANCE);
const SECRETS = join(ROOT, "..", TEST ? ".env.cloudflare-test" : ".env.cloudflare");
const FLAG = TEST ? ["--test"] : [];
const FILES_DIR = join(ROOT, "files-worker");

function step(message: string): void {
	console.log(`\n== ${message}`);
}

/** The app's version serving all of its traffic: its id and its bindings. */
function liveApp(): { version: string; env: Record<string, LiveBinding> | undefined } {
	const { deployments = [] } = cfJson<{ deployments?: { versions?: { version_id: string; percentage: number }[] }[] }>(["workers", "deployments", "list", "--worker", APP]);
	const versions = deployments[0]?.versions ?? [];
	const version = versions[0];
	if (versions.length !== 1 || !version || version.percentage !== 100) throw new CommandFailed(`${APP} is not deployed as one version serving all traffic: deploy both.`);
	hide(version.version_id);
	return { version: version.version_id, env: cfJson<{ env?: Record<string, LiveBinding> }>(["workers", "versions", "get", version.version_id, "--worker-id", APP]).env };
}

/**
 * What a deploy of the app records for a later --files-only from the same checkout, in .cloudflare/ (ignored by
 * git): the version it made and a digest of the link key it uploaded, which cannot be read back from the
 * account. The download origin alone is deployed only when both still hold.
 */
const RECORD = join(ROOT, ".cloudflare", "deployed.json");
type Deployed = Record<string, { version: string; key: string }>;

function keyDigest(): string {
	const key = readEnv(SECRETS).MINERVA_DOWNLOAD_KEY;
	if (!key) throw new CommandFailed(`${SECRETS} has no MINERVA_DOWNLOAD_KEY.`);
	return createHash("sha256").update(`minerva download key\0${key}`).digest("hex");
}

function deployed(): Deployed {
	try {
		return JSON.parse(readFileSync(RECORD, "utf8")) as Deployed;
	} catch {
		return {};
	}
}

let secretsDir: string | null = null;
function removeSecrets(): void {
	if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
	secretsDir = null;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		removeSecrets();
		process.exit(130);
	});
}

try {
	lock();
	const account = pinAccount([ROOT, FILES_DIR], [MODE]);
	hideSecrets(SECRETS);
	step(`Checking ${TEST ? "the test Worker's" : "the"} secrets`);
	run("node", ["scripts/secrets.ts", "check", ...FLAG], { print: true });
	const secrets = fileDigest(SECRETS);
	/** Stops when the secrets file changed after its check, so that both Workers get the same link key. */
	const sameSecrets = () => {
		if (fileDigest(SECRETS) !== secrets) throw new CommandFailed(`${SECRETS} changed during the deploy: run it again.`);
	};

	step(`Building ${APP} and ${FILES}`);
	// Each build's digest is taken right after it, checked again once the build is checked, and again right
	// before its upload: only the build that was checked goes up.
	run("cf", ["build", "--mode", MODE], { print: false });
	const built = { app: buildDigest(ROOT), files: "" };
	run("node", ["scripts/bundle.ts", ...FLAG], { print: true });
	run("node", ["scripts/startup.ts"], { print: true });
	run("cf", ["build", "--mode", MODE], { cwd: FILES_DIR, print: false });
	built.files = buildDigest(FILES_DIR);
	/** Stops when a build changed since it was built (another `cf build` in the same directory). */
	const unchanged = (dir: string, digest: string) => {
		if (buildDigest(dir) !== digest) throw new CommandFailed(`The build in ${dir} changed after it was made: run the deploy again.`);
	};
	for (const dir of [ROOT, FILES_DIR]) {
		const named = buildAccount(dir);
		if (named !== undefined && named !== account) throw new CommandFailed(`The build in ${dir} names an account other than the one this deploy is pinned to.`);
	}
	const app = readBuild(ROOT);
	hideOrigin(app.env?.MINERVA_SITE_URL?.value);
	hideOrigin(app.env?.MINERVA_DOWNLOAD_ORIGIN?.value);
	const problems = filesBuildProblems(app, readBuild(FILES_DIR), INSTANCE);
	if (problems.length) throw new CommandFailed(problems.join("\n"));
	unchanged(ROOT, built.app);
	unchanged(FILES_DIR, built.files);
	console.log(`Both builds are ${TEST ? "the test instance's" : "production's"}, with the same buckets and download origin.`);

	// cf deploy would create a missing database or bucket with default settings (it resolves the bindings'
	// names to ids that way, so it cannot be turned off), hence the check of the resources right before.
	if (FILES_ONLY) {
		step("Checking the resources");
		run("node", ["scripts/resources.ts", "--check", ...FLAG], { print: true });
		step(`Checking ${APP} as deployed against the local build and this checkout's record of its deploy`);
		const live = liveApp();
		const differences = liveAppProblems(live.env, app);
		const record = deployed()[APP];
		if (!record || record.version !== live.version) differences.push(`${APP}'s deployed version is not the one this checkout last deployed.`);
		else if (record.key !== keyDigest()) differences.push(`MINERVA_DOWNLOAD_KEY in ${SECRETS} is not the key ${APP} was deployed with.`);
		if (differences.length) throw new CommandFailed(`${differences.join("\n")}\nDeploy both (\`node scripts/deploy.ts${TEST ? " --test" : ""}\`) rather than the download origin alone.`);
		console.log(`It shares its buckets, download origin and link key with ${FILES}'s build.`);
	} else {
		step("Checking the resources and applying D1's migrations (the first change on the account)");
		run("node", ["scripts/resources.ts", ...FLAG], { print: true });
		run("node", ["scripts/schema-check.ts", ...FLAG], { print: true });
		step(`Deploying ${APP}`);
		unchanged(ROOT, built.app);
		sameSecrets();
		const key = keyDigest();
		run("cf", ["deploy", "--prebuilt", "--secrets-file", SECRETS], { print: true });
		try {
			writeFileSync(RECORD, JSON.stringify({ ...deployed(), [APP]: { version: liveApp().version, key } }, null, "\t"), { mode: 0o600 });
		} catch (error) {
			console.error(`Could not record the deploy in ${RECORD}, so a later --files-only will refuse: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	step(`Deploying ${FILES}`);
	sameSecrets();
	secretsDir = mkdtempSync(join(tmpdir(), "minerva-files-"));
	const subset = join(secretsDir, "files.env");
	run("node", ["scripts/secrets.ts", "subset", subset, "MINERVA_DOWNLOAD_KEY", ...FLAG], { print: true });
	try {
		sameSecrets();
		unchanged(FILES_DIR, built.files);
		run("cf", ["deploy", "--prebuilt", "--secrets-file", subset], { cwd: FILES_DIR, print: true });
	} catch (error) {
		if (!FILES_ONLY) console.error(`\n${APP} is deployed, ${FILES} is not: run \`node scripts/deploy.ts ${TEST ? "--test " : ""}--files-only\` (cloudflare/README.md, Deploy).`);
		throw error;
	} finally {
		removeSecrets();
	}
	console.log(`\nDeployed ${FILES_ONLY ? FILES : `${APP} and ${FILES}`}.`);
} catch (error) {
	removeSecrets();
	console.error(`\n${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
