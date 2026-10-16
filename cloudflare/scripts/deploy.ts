// Deploys an instance's app (cloudflare/README.md, Deploy), or code mode's lab.
//
//   node scripts/deploy.ts --instance <name>   the instance's app (`pnpm run deploy --instance <name>`)
//   node scripts/deploy.ts --test              the test instance's: the only one, or the one --instance names (`pnpm run deploy:test`)
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
// checked, the deploy makes sure the account's container registry holds the image of container/ as it is
// (scripts/image.ts), pushing it when it is missing; the registry is shared by the account's instances and
// addressed by content, so a push changes no instance. Then the app is built, its bundle checked for the test
// build's code (scripts/bundle.ts), its startup CPU measured locally (scripts/startup.ts), and the build checked to
// be the instance's (its name and its buckets); the secrets it declares, and only those, are copied from the
// instance's secrets.env to an owner-only file in a fresh temporary directory, removed when the deploy ends, fails
// or is interrupted. Then, still reading only: the account's workers.dev subdomain is read, so that cf's output never
// shows it (scripts/account.ts), the app Worker must have no Durable Object namespace of a class the build exports
// neither live nor deleted (`strayClasses` in scripts/builds.ts), and the instance on the account must be the one its
// directory describes (scripts/identity.ts: D1's identity row, else the live app's bindings, else an empty D1). Only
// then does the account change: the identity row is written when it is missing, the resources are checked and D1's
// migrations applied (scripts/resources.ts), the deployed schema is compared with the migrations
// (scripts/schema-check.ts), and the checked build is uploaded with that file as its secrets (a build or a secrets
// file that changed since its check stops the deploy). The lab's deploy checks the identity and its own origin the
// same way.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSubdomain, checkOnAccount, ownNamespaces } from "./account.ts";
import { appBuildProblems, buildAccount, buildDigest, builtImage, declaredSecrets, fileDigest, readBuild, strayClasses } from "./builds.ts";
import { ensureImage } from "./image.ts";
import { type Instance, checkFile, chooseInstance, parseInstanceArgs, readInstanceEnv } from "./instance.ts";
import { labOrigin } from "./origins.ts";
import { CommandFailed, ROOT, hideOrigin, hideSecrets, lockOperation, pinAccount, run } from "./run.ts";

const USAGE = "Usage: deploy.ts [--instance <name>] [--test | --lab]";
let INSTANCE: Instance;
let FLAGS: string[];
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const unknown = rest.filter((arg) => !["--test", "--lab"].includes(arg));
	if (unknown.length) {
		console.error(`Unknown arguments: ${unknown.join(" ")}. ${USAGE}`);
		process.exit(2);
	}
	FLAGS = rest;
	INSTANCE = chooseInstance({ flag, test: rest.includes("--test") || rest.includes("--lab") });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const LAB = FLAGS.includes("--lab");
const TEST = INSTANCE.test;
const MODE = TEST ? "faults" : "production";
const { app: APP, lab: LAB_NAME } = INSTANCE.names;
const SECRETS = INSTANCE.files.secrets;
const LAB_DIR = join(ROOT, "test", "account", "scripts-worker");
// Every command run below (cf build, the checks) chooses this instance.
process.env.MINERVA_INSTANCE = INSTANCE.name;

function step(message: string): void {
	console.log(`\n== ${message}`);
}

/**
 * Checks the instance on the account before anything there changes: its identity (scripts/identity.ts, which with
 * `record` then writes the identity row when it is missing, the first change on the account).
 */
function checkIdentity(record: boolean): void {
	run(process.execPath, ["scripts/identity.ts", ...(record ? ["--record"] : [])], { print: true });
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
	const account = pinAccount([ROOT], [MODE], INSTANCE, { record: true });
	checkFile(SECRETS);
	hideSecrets(SECRETS);
	step(`Checking ${INSTANCE.name}'s secrets`);
	run(process.execPath, ["scripts/secrets.ts", "check"], { print: true });
	const secrets = fileDigest(SECRETS);
	/** Stops when the secrets file changed after its check, which the build and the upload read. */
	const sameSecrets = () => {
		if (fileDigest(SECRETS) !== secrets) throw new CommandFailed(`${SECRETS} changed during the deploy: run it again.`);
	};

	// The sandbox's image, in the account's registry (scripts/image.ts): pushed only when container/ changed, and
	// passed to the app's build by its digest. A push changes no instance: nothing runs the image until a deploy
	// names it.
	step("The sandbox image");
	const image = await ensureImage(account);
	process.env.MINERVA_SANDBOX_IMAGE = image;

	step(`Building ${APP}`);
	// The build's digest is taken right after it, checked again once the build is checked, and again right before
	// its upload: only the build that was checked goes up.
	run("cf", ["build", "--mode", MODE], { print: false });
	const built = buildDigest(ROOT);
	run(process.execPath, ["scripts/bundle.ts"], { print: true });
	run(process.execPath, ["scripts/startup.ts"], { print: true });
	/** Stops when the build changed since it was built (another `cf build` in this checkout). */
	const unchanged = () => {
		if (buildDigest(ROOT) !== built) throw new CommandFailed(`The build in ${ROOT} changed after it was made: run the deploy again.`);
	};
	const named = buildAccount(ROOT);
	if (named !== undefined && named !== account) throw new CommandFailed(`The build in ${ROOT} names an account other than the one this deploy is pinned to.`);
	if (builtImage(ROOT, INSTANCE.names.container)?.reference !== image) throw new CommandFailed(`The build of ${APP} does not run the sandbox image ${image}.`);
	const app = readBuild(ROOT);
	const problems = appBuildProblems(app, INSTANCE.name);
	if (problems.length) throw new CommandFailed(problems.join("\n"));
	unchanged();
	console.log(`The build is ${INSTANCE.name}'s (${TEST ? "the test build" : "the production build"}), with its own buckets.`);
	// Only the secrets the build declares go up: a line of secrets.env it does not declare (a retired secret, say)
	// never reaches cf.
	const declared = declaredSecrets(app);
	secretsDir = mkdtempSync(join(tmpdir(), "minerva-secrets-"));
	const upload = join(secretsDir, "secrets.env");
	run(process.execPath, ["scripts/secrets.ts", "subset", upload, ...declared], { print: true });
	sameSecrets();
	const uploadDigest = fileDigest(upload);

	step(`Checking ${INSTANCE.name} on the account: its namespaces and its identity (then recording it, the first change on the account)`);
	// Hides the account's workers.dev subdomain from what follows: cf deploy names the Worker's URL, at times cut short.
	accountSubdomain();
	const strays = strayClasses(ownNamespaces(APP), app);
	if (strays.length) throw new CommandFailed(`${APP} has Durable Object namespaces of classes its build exports neither live nor deleted (${strays.join(", ")}): the deploy would strand their objects. Deploy a build that retires them first.`);
	checkIdentity(true);

	// cf deploy would create a missing database or bucket with default settings when it resolves the bindings'
	// names to ids. `--no-provision` turns that off, but it also skips the resolution of D1's name to its id that
	// cloudflare.config.ts relies on (it names the database, not its id), so the resources are checked right before
	// instead.
	step("Checking the resources and applying D1's migrations");
	run(process.execPath, ["scripts/resources.ts"], { print: true });
	run(process.execPath, ["scripts/schema-check.ts"], { print: true });
	step(`Deploying ${APP}`);
	unchanged();
	sameSecrets();
	if (fileDigest(upload) !== uploadDigest) throw new CommandFailed(`${upload} changed during the deploy: run it again.`);
	run("cf", ["deploy", "--prebuilt", "--secrets-file", upload], { print: true });
	removeSecrets();
	console.log(`\nDeployed ${APP}.`);
} catch (error) {
	removeSecrets();
	console.error(`\n${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
