// Deploys an instance: the app and its download origin (cloudflare/README.md, Deploy), or code mode's lab.
//
//   node scripts/deploy.ts --instance <name>   the instance's app and download origin (`pnpm run deploy --instance <name>`)
//   node scripts/deploy.ts --test              the test instance's: the only one, or the one --instance names (`pnpm run deploy:test`)
//   … --files-only                             only the download origin, after a deploy whose last step failed
//   node scripts/deploy.ts --lab               the test instance's code mode lab (`pnpm run deploy:cm`), with its cm.env
//
// The instance comes from scripts/instance.ts (`chooseInstance`): --instance, then MINERVA_INSTANCE, then the only
// test instance with --test or --lab; a production instance is never chosen by default. Its kind (instance.json)
// gives the build: mode `faults` for a test instance, `production` for any other. Every command run here gets
// MINERVA_INSTANCE.
//
// A deploy takes the checkout's lock and then the instance's, and every cf command goes to the instance's account
// (`lockOperation` and `pinAccount` in scripts/run.ts; the first deploy records the account). Everything that can
// fail locally runs before anything on the account changes, but for the sandbox's image: once the secrets are
// checked, a full deploy makes sure the account's container registry holds the image of container/ as it is
// (scripts/image.ts), pushing it when it is missing; the registry is shared by the account's instances and
// addressed by content, so a push changes no instance. Then both Workers are built, the app's bundle is checked
// for the test build's code (scripts/bundle.ts) and its startup CPU measured locally (scripts/startup.ts), and the download origin's build is checked against the app's (its name, its buckets, its
// origin). Then, still reading only: the origins must be on the account's own workers.dev subdomain
// (scripts/account.ts), and the instance on the account must be the one its directory describes
// (scripts/identity.ts: D1's identity row, else the live app's bindings, else an empty D1); with --files-only, the
// app actually deployed is checked against the local build and the instance's record of that deploy (its version
// and link key, in its deployed.json). Only then does the account change: the identity row is written when it is
// missing, the resources are checked and D1's migrations applied (scripts/resources.ts), the deployed schema is
// compared with the migrations (scripts/schema-check.ts), and the two checked builds are uploaded, the app first (a
// build that changed since its check stops the deploy). The download origin gets only MINERVA_DOWNLOAD_KEY, through
// an owner-only file in a fresh temporary directory that is removed whatever happens. The lab's deploy checks the
// identity and its own origin the same way. `pnpm assets` (the frontend) runs before this script.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOnAccount, liveVersion } from "./account.ts";
import { buildAccount, buildDigest, builtImage, fileDigest, filesBuildProblems, liveAppProblems, readBuild } from "./builds.ts";
import { ensureImage } from "./image.ts";
import { type Instance, checkFile, chooseInstance, parseInstanceArgs, readInstanceEnv } from "./instance.ts";
import { readDeployed, writeDeployed } from "./instance-files.ts";
import { instanceOrigins, labOrigin } from "./origins.ts";
import { CommandFailed, ROOT, hideOrigin, hideSecrets, lockOperation, pinAccount, run } from "./run.ts";

const USAGE = "Usage: deploy.ts [--instance <name>] [--test] [--files-only | --lab]";
let INSTANCE: Instance;
let FLAGS: string[];
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const unknown = rest.filter((arg) => !["--test", "--files-only", "--lab"].includes(arg));
	if (unknown.length || (rest.includes("--files-only") && rest.includes("--lab"))) {
		console.error(`${unknown.length ? `Unknown arguments: ${unknown.join(" ")}. ` : ""}${USAGE}`);
		process.exit(2);
	}
	FLAGS = rest;
	INSTANCE = chooseInstance({ flag, test: rest.includes("--test") || rest.includes("--lab") });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const FILES_ONLY = FLAGS.includes("--files-only");
const LAB = FLAGS.includes("--lab");
const TEST = INSTANCE.test;
const MODE = TEST ? "faults" : "production";
const { app: APP, download: FILES, lab: LAB_NAME } = INSTANCE.names;
const SECRETS = INSTANCE.files.secrets;
const FILES_DIR = join(ROOT, "files-worker");
const LAB_DIR = join(ROOT, "test", "account", "scripts-worker");
/** How to run this again for the same instance. */
const AGAIN = `node scripts/deploy.ts --instance ${INSTANCE.name}`;
// Every command run below (cf build, the checks) chooses this instance.
process.env.MINERVA_INSTANCE = INSTANCE.name;

function step(message: string): void {
	console.log(`\n== ${message}`);
}

/** The app's version serving all of its traffic: its id and its bindings. */
function liveApp(): ReturnType<typeof liveVersion> {
	try {
		return liveVersion(APP);
	} catch (error) {
		throw new CommandFailed(`${error instanceof Error ? error.message : String(error)} Deploy both.`);
	}
}

/**
 * Checks the instance on the account before anything there changes: its identity (scripts/identity.ts, which with
 * `record` then writes the identity row when it is missing, the first change on the account).
 */
function checkIdentity(record: boolean): void {
	run(process.execPath, ["scripts/identity.ts", ...(record ? ["--record"] : [])], { print: true });
}

/** A digest of the link key the app is deployed with, which cannot be read back from the account. */
function keyDigest(): string {
	const key = readInstanceEnv(INSTANCE, "secrets")?.MINERVA_DOWNLOAD_KEY;
	if (!key) throw new CommandFailed(`${SECRETS} has no MINERVA_DOWNLOAD_KEY.`);
	return createHash("sha256").update(`minerva download key\0${key}`).digest("hex");
}

/** Builds and deploys code mode's lab (`<name>-cm`) with the instance's cm.env, its token. */
function deployLab(account: string): void {
	checkFile(INSTANCE.files.cm);
	if (!readInstanceEnv(INSTANCE, "cm")?.CM_TOKEN) throw new CommandFailed(`${INSTANCE.files.cm} must set CM_TOKEN, the lab's driver token (cloudflare/README.md, Code mode's lab).`);
	hideSecrets(INSTANCE.files.cm);
	const token = fileDigest(INSTANCE.files.cm);
	step(`Checking ${INSTANCE.name} on the account: the lab's origin and the instance's identity`);
	const origin = labOrigin(INSTANCE);
	hideOrigin(origin);
	checkOnAccount([{ origin, setting: `CM_ORIGIN in ${INSTANCE.files.cmVars}` }]);
	checkIdentity(false);
	step(`Building ${LAB_NAME}`);
	run("cf", ["build"], { cwd: LAB_DIR, print: false });
	const digest = buildDigest(LAB_DIR);
	const named = buildAccount(LAB_DIR);
	if (named !== undefined && named !== account) throw new CommandFailed("The lab's build names an account other than the one this deploy is pinned to.");
	const lab = readBuild(LAB_DIR);
	if (lab.name !== LAB_NAME) throw new CommandFailed(`The lab's build is ${lab.name ?? "unnamed"}, not ${LAB_NAME}.`);
	step(`Deploying ${LAB_NAME}`);
	if (buildDigest(LAB_DIR) !== digest) throw new CommandFailed(`The build in ${LAB_DIR} changed after it was made: run the deploy again.`);
	if (fileDigest(INSTANCE.files.cm) !== token) throw new CommandFailed(`${INSTANCE.files.cm} changed during the deploy: run it again.`);
	run("cf", ["deploy", "--prebuilt", "--secrets-file", INSTANCE.files.cm], { cwd: LAB_DIR, print: true });
	console.log(`\nDeployed ${LAB_NAME}. Delete it once its tests have run: cf workers delete ${LAB_NAME} --force (read the output: an aborted delete exits 0).`);
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
	lockOperation(INSTANCE);
	if (LAB) {
		deployLab(pinAccount([LAB_DIR], ["production"], INSTANCE, { record: true }));
		process.exit(0);
	}
	const account = pinAccount([ROOT, FILES_DIR], [MODE], INSTANCE, { record: true });
	// A record that does not parse stops the deploy before anything changes (a full deploy replaces it).
	const record = readDeployed(INSTANCE);
	checkFile(SECRETS);
	hideSecrets(SECRETS);
	step(`Checking ${INSTANCE.name}'s secrets`);
	run(process.execPath, ["scripts/secrets.ts", "check"], { print: true });
	const secrets = fileDigest(SECRETS);
	/** Stops when the secrets file changed after its check, so that both Workers get the same link key. */
	const sameSecrets = () => {
		if (fileDigest(SECRETS) !== secrets) throw new CommandFailed(`${SECRETS} changed during the deploy: run it again.`);
	};

	// The sandbox's image, in the account's registry (scripts/image.ts): pushed only when container/ changed, and
	// passed to the app's build by its digest. A push changes no instance: nothing runs the image until a deploy
	// names it.
	let image: string | undefined;
	if (!FILES_ONLY) {
		step("The sandbox image");
		image = await ensureImage(account);
		process.env.MINERVA_SANDBOX_IMAGE = image;
	}

	step(`Building ${APP} and ${FILES}`);
	// Each build's digest is taken right after it, checked again once the build is checked, and again right
	// before its upload: only the build that was checked goes up.
	run("cf", ["build", "--mode", MODE], { print: false });
	const built = { app: buildDigest(ROOT), files: "" };
	run(process.execPath, ["scripts/bundle.ts"], { print: true });
	run(process.execPath, ["scripts/startup.ts"], { print: true });
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
	if (image && builtImage(ROOT, INSTANCE.names.container)?.reference !== image) throw new CommandFailed(`The build of ${APP} does not run the sandbox image ${image}.`);
	const app = readBuild(ROOT);
	hideOrigin(app.env?.MINERVA_SITE_URL?.value);
	hideOrigin(app.env?.MINERVA_DOWNLOAD_ORIGIN?.value);
	const problems = filesBuildProblems(app, readBuild(FILES_DIR), INSTANCE.name);
	if (problems.length) throw new CommandFailed(problems.join("\n"));
	unchanged(ROOT, built.app);
	unchanged(FILES_DIR, built.files);
	console.log(`Both builds are ${INSTANCE.name}'s (${TEST ? "the test build" : "the production build"}), with the same buckets and download origin.`);

	step(`Checking ${INSTANCE.name} on the account: its origins and its identity${FILES_ONLY ? "" : " (then recording it, the first change on the account)"}`);
	// The build checked that both origins are the instance's Workers on one workers.dev subdomain (cloudflare.config.ts);
	// that subdomain must be the account's own.
	const text = (name: string) => {
		const value = app.env?.[name]?.value;
		return typeof value === "string" ? value : undefined;
	};
	const settings = { site: `MINERVA_SITE_URL in ${INSTANCE.files.vars}`, download: `MINERVA_DOWNLOAD_ORIGIN in ${INSTANCE.files.vars}` };
	const origins = instanceOrigins(text("MINERVA_SITE_URL"), text("MINERVA_DOWNLOAD_ORIGIN"), settings, INSTANCE.names);
	checkOnAccount([
		{ origin: origins.origin, setting: settings.site },
		{ origin: origins.downloadOrigin, setting: settings.download },
	]);
	console.log("Both origins are the instance's Workers on the account's workers.dev subdomain.");
	checkIdentity(!FILES_ONLY);

	// cf deploy would create a missing database or bucket with default settings when it resolves the bindings'
	// names to ids. `--no-provision` turns that off, but it also skips the resolution of D1's name to its id that
	// cloudflare.config.ts relies on (it names the database, not its id), so the resources are checked right before
	// instead.
	if (FILES_ONLY) {
		step("Checking the resources");
		run(process.execPath, ["scripts/resources.ts", "--check"], { print: true });
		step(`Checking ${APP} as deployed against the local build and the record of its last deploy`);
		const live = liveApp();
		const differences = liveAppProblems(live.env, app);
		if (!record || record.version !== live.version) differences.push(`${APP}'s deployed version is not the one ${INSTANCE.files.deployed} records.`);
		else if (record.key !== keyDigest()) differences.push(`MINERVA_DOWNLOAD_KEY in ${SECRETS} is not the key ${APP} was deployed with.`);
		if (differences.length) throw new CommandFailed(`${differences.join("\n")}\nDeploy both (\`${AGAIN}\`) rather than the download origin alone.`);
		console.log(`It shares its buckets, download origin and link key with ${FILES}'s build.`);
	} else {
		step("Checking the resources and applying D1's migrations");
		run(process.execPath, ["scripts/resources.ts"], { print: true });
		run(process.execPath, ["scripts/schema-check.ts"], { print: true });
		step(`Deploying ${APP}`);
		unchanged(ROOT, built.app);
		sameSecrets();
		const key = keyDigest();
		run("cf", ["deploy", "--prebuilt", "--secrets-file", SECRETS], { print: true });
		try {
			writeDeployed(INSTANCE, { version: liveApp().version, key });
		} catch (error) {
			console.error(`Could not record the deploy in ${INSTANCE.files.deployed}, so a later --files-only will refuse: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	step(`Deploying ${FILES}`);
	sameSecrets();
	secretsDir = mkdtempSync(join(tmpdir(), "minerva-files-"));
	const subset = join(secretsDir, "files.env");
	run(process.execPath, ["scripts/secrets.ts", "subset", subset, "MINERVA_DOWNLOAD_KEY"], { print: true });
	try {
		sameSecrets();
		unchanged(FILES_DIR, built.files);
		run("cf", ["deploy", "--prebuilt", "--secrets-file", subset], { cwd: FILES_DIR, print: true });
	} catch (error) {
		if (!FILES_ONLY) console.error(`\n${APP} is deployed, ${FILES} is not: run \`${AGAIN} --files-only\` (cloudflare/README.md, Deploy).`);
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
