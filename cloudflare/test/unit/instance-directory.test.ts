// The instance directory (scripts/instance.ts, scripts/instance-files.ts) and the locks and the account
// (scripts/run.ts): every directory refused, choosing an instance, the mode against the kind, the vars file, the
// origins, the records written there, the account pinned and recorded, the order of the locks, and the files left
// at the repository root. The instances are fixtures (`acme`) in a temporary MINERVA_INSTANCES_DIR.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LOCAL_INSTANCES, chooseInstance, instanceForMode, instanceVars, instancesDir, leftoverProblem, listInstances, parseInstanceArgs, readInstance } from "../../scripts/instance.ts";
import { createInstance, readDeployed, recordAccount, writeDeployed, writeInstanceFile } from "../../scripts/instance-files.ts";
import { originsOf } from "../account/origins.ts";

const SCRIPTS = new URL("../../scripts/", import.meta.url).pathname;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const SUB = "acct7q";

let base: string;
let root: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "instances-"));
	root = join(base, "instances");
	env = { MINERVA_INSTANCES_DIR: root };
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/** A new instance, as `pnpm instances create` makes it. */
function make(name: string, test = false) {
	return createInstance(root, name, test);
}

/** Writes a file into an instance's directory, owner-only unless `mode` says otherwise. */
function put(name: string, file: string, text: string, mode = 0o600): void {
	const path = join(root, name, file);
	writeFileSync(path, text);
	chmodSync(path, mode);
}

function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	return "";
}

/** Holds an instance's lock as this process, as scripts/run.ts would (the file names the holder's pid). */
function holdAs(name: string, pid = process.pid): void {
	writeFileSync(join(root, name, "lock"), String(pid), { mode: 0o600 });
}

describe("where the instances are", () => {
	test("MINERVA_INSTANCES_DIR replaces the whole path; otherwise XDG_CONFIG_HOME or ~/.config", () => {
		expect(instancesDir({ MINERVA_INSTANCES_DIR: "/srv/minerva/instances/" })).toBe("/srv/minerva/instances");
		expect(instancesDir({ XDG_CONFIG_HOME: "/home/ada/.cfg" })).toBe("/home/ada/.cfg/minerva/instances");
		expect(instancesDir({ XDG_CONFIG_HOME: "relative" })).toMatch(/\/\.config\/minerva\/instances$/);
		expect(instancesDir({})).toMatch(/\/\.config\/minerva\/instances$/);
		expect(refusal(() => instancesDir({ MINERVA_INSTANCES_DIR: "instances" }))).toBe("MINERVA_INSTANCES_DIR must be an absolute path.");
	});

	test("a new instance is a directory of mode 700 with an instance.json of mode 600 naming it, and no account yet", () => {
		const instance = make("acme");
		expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(statSync(instance.dir).mode & 0o777).toBe(0o700);
		expect(statSync(instance.files.instance).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(instance.files.instance, "utf8"))).toEqual({ name: "acme", test: false });
		expect(instance).toMatchObject({ name: "acme", test: false, account: null, dir: join(root, "acme") });
		expect(instance.names.download).toBe("acme-files");
		expect(make("acme-test", true).test).toBe(true);
		expect(refusal(() => make("acme"))).toBe(`${join(root, "acme")} already exists.`);
		expect(refusal(() => make("acme-files"))).toMatch(/cannot end in -files/);
		for (const local of Object.values(LOCAL_INSTANCES)) expect(refusal(() => make(local))).toBe(`${local} is the name of the local builds, which reach no instance: an instance cannot have it.`);
		expect(listInstances(root).map((instance) => instance.name)).toEqual(["acme", "acme-test"]);
	});

	test("no directory is no instance; entries starting with a dot are not instances", () => {
		expect(listInstances(root)).toEqual([]);
		make("acme");
		writeFileSync(join(root, ".DS_Store"), "");
		mkdirSync(join(root, ".acme.old"));
		expect(listInstances(root).map((instance) => instance.name)).toEqual(["acme"]);
	});
});

describe("every directory that is not an instance's stops the listing and the choice", () => {
	/** Each case breaks the directory of `acme` (or the root) after a valid acme and acme-test exist. */
	const cases: [string, () => void, RegExp][] = [
		["the instances directory as a symbolic link", () => {
			rmSync(root, { recursive: true });
			mkdirSync(join(base, "elsewhere"), { mode: 0o700 });
			symlinkSync(join(base, "elsewhere"), root);
		}, /is a symbolic link/],
		["an instance's directory as a symbolic link", () => {
			rmSync(join(root, "acme"), { recursive: true });
			mkdirSync(join(base, "acme"), { mode: 0o700 });
			writeFileSync(join(base, "acme", "instance.json"), JSON.stringify({ name: "acme", test: false }), { mode: 0o600 });
			symlinkSync(join(base, "acme"), join(root, "acme"));
		}, /is a symbolic link/],
		["instance.json as a symbolic link", () => {
			writeFileSync(join(base, "instance.json"), JSON.stringify({ name: "acme", test: false }), { mode: 0o600 });
			rmSync(join(root, "acme", "instance.json"));
			symlinkSync(join(base, "instance.json"), join(root, "acme", "instance.json"));
		}, /instance\.json is a symbolic link/],
		["secrets.env as a symbolic link", () => {
			writeFileSync(join(base, "secrets"), "", { mode: 0o600 });
			symlinkSync(join(base, "secrets"), join(root, "acme", "secrets.env"));
		}, /secrets\.env is a symbolic link/],
		["vars.env as a directory", () => mkdirSync(join(root, "acme", "vars.env"), { mode: 0o700 }), /vars\.env is not a plain file/],
		["the instances directory open to others", () => chmodSync(root, 0o755), /The instances directory .* must be its owner's alone \(chmod 700\)/],
		["an instance's directory open to its group", () => chmodSync(join(root, "acme"), 0o750), /must be its owner's alone \(chmod 700\)/],
		["instance.json readable by others", () => chmodSync(join(root, "acme", "instance.json"), 0o644), /instance\.json must be its owner's alone \(chmod 600\)/],
		["vars.env readable by its group", () => put("acme", "vars.env", "MINERVA_DEBUG=false\n", 0o640), /vars\.env must be its owner's alone \(chmod 600\)/],
		["instance.json naming another directory", () => put("acme", "instance.json", JSON.stringify({ name: "acme-2", test: false })), /does not name its own directory, acme/],
		["instance.json that is not JSON", () => put("acme", "instance.json", "{name: acme}"), /instance\.json is not JSON/],
		["instance.json that is not an object", () => put("acme", "instance.json", JSON.stringify(["acme", false])), /is not a JSON object/],
		["instance.json without a name", () => put("acme", "instance.json", JSON.stringify({ test: false })), /does not name its own directory/],
		["instance.json with a field instances do not have", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, region: "eu" })), /has fields an instance does not have: only name, test and account\.$/],
		["test as a string", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: "false" })), /test must be true or false/],
		["test missing", () => put("acme", "instance.json", JSON.stringify({ name: "acme" })), /test must be true or false/],
		["test as a number", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: 0 })), /test must be true or false/],
		["an account id in capitals", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, account: ACCOUNT.toUpperCase() })), /account is not a Cloudflare account id/],
		["an account id too short", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, account: ACCOUNT.slice(1) })), /account is not a Cloudflare account id/],
		["an account that is not a string", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, account: 123 })), /account is not a Cloudflare account id/],
		["an account of null", () => put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, account: null })), /account is not a Cloudflare account id/],
		["a directory without instance.json", () => rmSync(join(root, "acme", "instance.json")), /has no instance\.json/],
		["a plain file where an instance's directory would be", () => writeFileSync(join(root, "acme-2"), "", { mode: 0o600 }), /acme-2\) is not a directory/],
		["a directory whose name is not an instance's", () => mkdirSync(join(root, "Other"), { mode: 0o700 }), /Other: An instance name has lowercase letters/],
		["a directory with a local build's name", () => {
			mkdirSync(join(root, LOCAL_INSTANCES.test), { mode: 0o700 });
			put(LOCAL_INSTANCES.test, "instance.json", JSON.stringify({ name: LOCAL_INSTANCES.test, test: true }));
		}, /is the name of the local builds/],
	];

	test.each(cases)("%s", (_case, breakIt, message) => {
		make("acme");
		make("acme-test", true);
		breakIt();
		expect(refusal(() => listInstances(root))).toMatch(message);
		// The only test instance is not chosen around a broken one: the listing stops.
		expect(refusal(() => chooseInstance({ test: true, env }))).toMatch(message);
	});

	test("the named instance is read and checked on its own", () => {
		make("acme");
		make("acme-test", true);
		chmodSync(join(root, "acme", "instance.json"), 0o644);
		expect(refusal(() => chooseInstance({ flag: "acme", env }))).toMatch(/must be its owner's alone/);
		// Another instance's broken file does not stop a command that names its own.
		expect(chooseInstance({ flag: "acme-test", env }).name).toBe("acme-test");
	});

	test("no message repeats what a file says", () => {
		make("acme");
		put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, account: `secret-${SUB}` }));
		expect(refusal(() => listInstances(root))).not.toContain(SUB);
		put("acme", "instance.json", JSON.stringify({ name: "acme", test: false, [`secret-${SUB}`]: true }));
		expect(refusal(() => listInstances(root))).not.toContain(SUB);
		put("acme", "instance.json", `{"name": "acme", "test": false, "account": "${SUB}`);
		expect(refusal(() => listInstances(root))).not.toContain(SUB);
	});

	test("inside a git checkout, the instances directory must be ignored by it", () => {
		const repo = join(base, "repo");
		mkdirSync(repo);
		expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
		root = join(repo, "instances");
		env = { MINERVA_INSTANCES_DIR: root };
		writeFileSync(join(repo, ".gitignore"), "/instances/\n");
		make("acme-test", true);
		expect(chooseInstance({ test: true, env }).name).toBe("acme-test");
		rmSync(join(repo, ".gitignore"));
		expect(refusal(() => chooseInstance({ test: true, env }))).toMatch(/is inside the git checkout .* and not ignored by it/);
		expect(refusal(() => readInstance(root, "acme-test"))).toMatch(/not ignored by it/);
		// Reached through a link from outside the checkout, it is still the checkout's.
		const link = join(base, "linked");
		symlinkSync(repo, link);
		expect(refusal(() => chooseInstance({ test: true, env: { MINERVA_INSTANCES_DIR: join(link, "instances") } }))).toMatch(/is inside the git checkout .* and not ignored by it/);
		writeFileSync(join(repo, ".gitignore"), "/instances/\n");
		expect(chooseInstance({ test: true, env: { MINERVA_INSTANCES_DIR: join(link, "instances") } }).name).toBe("acme-test");
	});
});

describe("choosing an instance", () => {
	test("a test command takes the only test instance; with none, or two, it stops and names them", () => {
		make("acme");
		expect(refusal(() => chooseInstance({ test: true, env }))).toBe(`There is no test instance: the instances in ${root} are acme.`);
		make("acme-test", true);
		expect(chooseInstance({ test: true, env }).name).toBe("acme-test");
		make("acme-test-2", true);
		expect(refusal(() => chooseInstance({ test: true, env }))).toBe("There are 2 test instances (acme-test, acme-test-2): name one with --instance or MINERVA_INSTANCE.");
		expect(chooseInstance({ test: true, env: { ...env, MINERVA_INSTANCE: "acme-test-2" } }).name).toBe("acme-test-2");
		expect(chooseInstance({ test: true, flag: "acme-test", env }).name).toBe("acme-test");
	});

	test("with no instance at all, it says so", () => {
		expect(refusal(() => chooseInstance({ test: true, env }))).toBe(`There is no test instance: ${root} has no instance.`);
	});

	test("a production instance is never chosen by default, even the only instance", () => {
		make("acme");
		expect(refusal(() => chooseInstance({ env }))).toMatch(/^Name the instance with --instance <name> \(or MINERVA_INSTANCE\): a production instance is never chosen by default/);
		expect(chooseInstance({ flag: "acme", env }).name).toBe("acme");
		expect(chooseInstance({ env: { ...env, MINERVA_INSTANCE: "acme" } }).name).toBe("acme");
	});

	test("a test command refuses a production instance, by flag or by MINERVA_INSTANCE", () => {
		make("acme");
		make("acme-test", true);
		expect(refusal(() => chooseInstance({ test: true, flag: "acme", env }))).toBe("acme is a production instance, and this runs only against a test instance.");
		expect(refusal(() => chooseInstance({ test: true, env: { ...env, MINERVA_INSTANCE: "acme" } }))).toBe("acme is a production instance, and this runs only against a test instance.");
	});

	test("a flag that disagrees with MINERVA_INSTANCE stops the command; one that agrees does not", () => {
		make("acme");
		make("acme-test", true);
		expect(refusal(() => chooseInstance({ flag: "acme-test", env: { ...env, MINERVA_INSTANCE: "acme" } }))).toBe("--instance acme-test and MINERVA_INSTANCE=acme name different instances.");
		expect(refusal(() => chooseInstance({ test: true, flag: "acme", env: { ...env, MINERVA_INSTANCE: "acme-test" } }))).toBe("--instance acme and MINERVA_INSTANCE=acme-test name different instances.");
		expect(chooseInstance({ flag: "acme", env: { ...env, MINERVA_INSTANCE: "acme" } }).name).toBe("acme");
		// An empty MINERVA_INSTANCE names nothing.
		expect(chooseInstance({ flag: "acme", env: { ...env, MINERVA_INSTANCE: "" } }).name).toBe("acme");
	});

	test("a name that is no instance, or no name, stops it", () => {
		make("acme");
		expect(refusal(() => chooseInstance({ flag: "acme-2", env }))).toBe(`There is no instance acme-2: the instances in ${root} are acme.`);
		expect(refusal(() => chooseInstance({ flag: "../acme", env }))).toMatch(/^An instance name has lowercase letters/);
		expect(refusal(() => chooseInstance({ flag: "acme-files", env }))).toMatch(/cannot end in -files/);
	});

	test("--instance is read from a script's arguments", () => {
		expect(parseInstanceArgs(["--test", "--instance", "acme", "--yes"])).toEqual({ flag: "acme", rest: ["--test", "--yes"] });
		expect(parseInstanceArgs(["--instance=acme"])).toEqual({ flag: "acme", rest: [] });
		expect(parseInstanceArgs(["--files-only"])).toEqual({ flag: undefined, rest: ["--files-only"] });
		expect(refusal(() => parseInstanceArgs(["--instance"]))).toBe("--instance needs a name.");
		expect(refusal(() => parseInstanceArgs(["--instance", "--test"]))).toBe("--instance needs a name.");
		expect(refusal(() => parseInstanceArgs(["--instance=", "acme"]))).toBe("--instance needs a name.");
		expect(refusal(() => parseInstanceArgs(["--instance", "acme", "--instance", "acme"]))).toBe("--instance is given twice.");
	});
});

describe("the mode a build is in and the instance's kind", () => {
	test("mode faults builds a test instance, mode production a production instance, and each refuses the other", () => {
		make("acme");
		make("acme-test", true);
		expect(instanceForMode("faults", env).name).toBe("acme-test");
		expect(instanceForMode("production", { ...env, MINERVA_INSTANCE: "acme" }).name).toBe("acme");
		expect(refusal(() => instanceForMode("faults", { ...env, MINERVA_INSTANCE: "acme" }))).toBe("acme is a production instance, and this runs only against a test instance.");
		expect(refusal(() => instanceForMode("production", { ...env, MINERVA_INSTANCE: "acme-test" }))).toBe("acme-test is a test instance: it is built in mode faults, not production.");
	});

	test("mode production never takes an instance by default", () => {
		make("acme");
		expect(refusal(() => instanceForMode("production", env))).toMatch(/a production instance is never chosen by default/);
	});
});

describe("an instance's settings", () => {
	test("vars.env must exist and cannot set the gateway, which the build derives", () => {
		const instance = make("acme");
		expect(refusal(() => instanceVars(instance))).toBe(`A deployed build reads its settings from ${instance.files.vars}, which is missing (cloudflare/README.md, The instance directory).`);
		put("acme", "vars.env", `MINERVA_SITE_URL=https://acme.${SUB}.workers.dev\nMINERVA_MODEL_GATEWAY=acme-other\n`);
		expect(refusal(() => instanceVars(instance))).toBe(`MINERVA_MODEL_GATEWAY is not a setting: the build sets it to the instance's name. Remove it from ${instance.files.vars}.`);
		put("acme", "vars.env", `MINERVA_SITE_URL=https://acme.${SUB}.workers.dev\n`);
		expect(instanceVars(instance)).toEqual({ MINERVA_SITE_URL: `https://acme.${SUB}.workers.dev` });
	});

	test("origins that belong to another instance are refused, without repeating them", () => {
		const instance = make("acme");
		const vars = (site: string, download: string) => put("acme", "vars.env", `MINERVA_SITE_URL=${site}\nMINERVA_DOWNLOAD_ORIGIN=${download}\n`);
		vars(`https://acme.${SUB}.workers.dev`, `https://acme-files.${SUB}.workers.dev`);
		expect(originsOf(instance)).toEqual({ origin: `https://acme.${SUB}.workers.dev`, downloadOrigin: `https://acme-files.${SUB}.workers.dev` });
		for (const [site, download, setting] of [
			[`https://acme-test.${SUB}.workers.dev`, `https://acme-files.${SUB}.workers.dev`, "MINERVA_SITE_URL"],
			[`https://acme.${SUB}.workers.dev`, `https://acme-test-files.${SUB}.workers.dev`, "MINERVA_DOWNLOAD_ORIGIN"],
			[`https://acme-files.${SUB}.workers.dev`, `https://acme.${SUB}.workers.dev`, "MINERVA_SITE_URL"],
		] as const) {
			vars(site, download);
			const message = refusal(() => originsOf(instance));
			expect(message).toMatch(new RegExp(`^${setting} in acme's vars.env is not acme`));
			expect(message).not.toContain(SUB);
		}
	});
});

describe("an instance's secrets (scripts/secrets.ts)", () => {
	const SECRETS = `${SCRIPTS}secrets.ts`;
	const secrets = (args: string[]) => {
		const result = spawnSync(process.execPath, [SECRETS, ...args], { encoding: "utf8", env: { ...process.env, MINERVA_INSTANCE: undefined, ...env } as NodeJS.ProcessEnv });
		return { status: result.status, text: result.stdout + result.stderr };
	};
	const KEY = `${"k".repeat(40)}${SUB}`;

	test("are read as cf reads them, and a value they could not be written back as stops the check, unprinted", () => {
		const instance = make("acme");
		expect(secrets(["generate", "--instance", "acme"])).toMatchObject({ status: 0 });
		expect(statSync(instance.files.secrets).mode & 0o777).toBe(0o600);
		expect(existsSync(instance.files.lock)).toBe(false);
		const generated = readFileSync(instance.files.secrets, "utf8");
		expect(secrets(["check", "--instance", "acme"]).status).toBe(0);
		// Single quotes, as dotenv reads them: the key is the text between them.
		put("acme", "secrets.env", generated.replace(/^MINERVA_DOWNLOAD_KEY=.*$/m, `MINERVA_DOWNLOAD_KEY='${KEY}'`));
		expect(secrets(["check", "--instance", "acme"]).status).toBe(0);
		const out = join(base, "subset.env");
		expect(secrets(["subset", out, "MINERVA_DOWNLOAD_KEY", "--instance", "acme"]).status).toBe(0);
		expect(readFileSync(out, "utf8")).toBe(`MINERVA_DOWNLOAD_KEY="${KEY}"\n`);
		put("acme", "secrets.env", generated.replace(/^MINERVA_DOWNLOAD_KEY=.*$/m, `MINERVA_DOWNLOAD_KEY='${KEY}"x'`));
		const refused = secrets(["check", "--instance", "acme"]);
		expect(refused.status).toBe(1);
		expect(refused.text).toContain("MINERVA_DOWNLOAD_KEY in acme's secrets.env has a quote, a backslash or a line break");
		expect(refused.text).not.toContain(SUB);
	});

	test("a test command's secrets are the test instance's; production's are named", () => {
		make("acme");
		make("acme-test", true);
		expect(secrets(["generate", "--test"]).text).toContain("to acme-test's secrets.env");
		expect(secrets(["generate"]).text).toContain("a production instance is never chosen by default");
		expect(existsSync(join(root, "acme", "secrets.env"))).toBe(false);
	});
});

describe("writing to an instance's directory", () => {
	test("only while holding its lock, atomically, owner-only, leaving no temporary file", () => {
		const instance = make("acme");
		expect(refusal(() => writeInstanceFile(instance, "secrets", "A=1\n"))).toBe(`Writing to ${instance.dir} needs its lock, which this command does not hold.`);
		holdAs("acme", process.pid + 1);
		expect(refusal(() => writeInstanceFile(instance, "secrets", "A=1\n"))).toMatch(/needs its lock/);
		holdAs("acme");
		put("acme", "secrets.env", "A=0\n");
		writeInstanceFile(instance, "secrets", "A=1\n");
		expect(readFileSync(instance.files.secrets, "utf8")).toBe("A=1\n");
		expect(statSync(instance.files.secrets).mode & 0o777).toBe(0o600);
		expect(readdirSync(instance.dir).sort()).toEqual(["instance.json", "lock", "secrets.env"]);
	});

	test("a link in place of the file, or of the directory, is not written through", () => {
		const instance = make("acme");
		holdAs("acme");
		writeFileSync(join(base, "target"), "kept\n", { mode: 0o600 });
		symlinkSync(join(base, "target"), instance.files.secrets);
		expect(refusal(() => writeInstanceFile(instance, "secrets", "A=1\n"))).toBe(`${instance.files.secrets} is not a plain file: it is not replaced.`);
		expect(readFileSync(join(base, "target"), "utf8")).toBe("kept\n");
		const moved = join(base, "moved");
		spawnSync("mv", [instance.dir, moved]);
		symlinkSync(moved, instance.dir);
		expect(refusal(() => writeInstanceFile(instance, "vars", "A=1\n"))).toMatch(/is a symbolic link/);
		expect(existsSync(join(moved, "vars.env"))).toBe(false);
	});

	test("a write that fails leaves the file as it was and nothing beside it", () => {
		const instance = make("acme");
		holdAs("acme");
		put("acme", "vars.env", "A=0\n");
		chmodSync(instance.dir, 0o500);
		try {
			expect(refusal(() => writeInstanceFile(instance, "vars", "A=1\n"))).toMatch(/EACCES|permission denied/i);
		} finally {
			chmodSync(instance.dir, 0o700);
		}
		expect(readFileSync(instance.files.vars, "utf8")).toBe("A=0\n");
		expect(readdirSync(instance.dir).sort()).toEqual(["instance.json", "lock", "vars.env"]);
	});

	test("deployed.json: none is no record; one that does not parse, or is not a record, stops the command", () => {
		const instance = make("acme");
		expect(readDeployed(instance)).toBeNull();
		holdAs("acme");
		const record = { version: "11111111-2222-4333-8444-555555555555", key: "a".repeat(64) };
		writeDeployed(instance, record);
		expect(readDeployed(instance)).toEqual(record);
		expect(statSync(instance.files.deployed).mode & 0o777).toBe(0o600);
		for (const text of ["", "{", "null", "[]", JSON.stringify({ version: record.version }), JSON.stringify({ ...record, key: "short" }), JSON.stringify({ ...record, app: "acme" }), JSON.stringify({ [instance.name]: record })]) {
			put("acme", "deployed.json", text);
			expect(refusal(() => readDeployed(instance)), text).toMatch(/is not (JSON|a deploy's record): remove it/);
		}
		chmodSync(instance.files.deployed, 0o644);
		expect(refusal(() => readDeployed(instance))).toMatch(/must be its owner's alone/);
	});

	test("the account is recorded once, as an account id", () => {
		const instance = make("acme");
		holdAs("acme");
		expect(refusal(() => recordAccount(instance, "not-an-account"))).toMatch(/account is not a Cloudflare account id/);
		const recorded = recordAccount(instance, ACCOUNT);
		expect(recorded.account).toBe(ACCOUNT);
		expect(readInstance(root, "acme").account).toBe(ACCOUNT);
		expect(JSON.parse(readFileSync(instance.files.instance, "utf8"))).toEqual({ name: "acme", test: false, account: ACCOUNT });
		expect(refusal(() => recordAccount(recorded, OTHER))).toBe("acme is already recorded on an account.");
		// A stale copy of the instance, from before the record, does not record a second account.
		expect(refusal(() => recordAccount(instance, OTHER))).toMatch(/changed while it was read/);
		expect(readInstance(root, "acme").account).toBe(ACCOUNT);
	});
});

/** Runs a module script in a child Node with `env`, PATH first through `bin` if given; its stdout and stderr. */
function node(source: string, extra: Record<string, string | undefined>, bin?: string) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		encoding: "utf8",
		env: { ...process.env, MINERVA_INSTANCE: undefined, CLOUDFLARE_ACCOUNT_ID: undefined, ...env, ...extra, ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) } as NodeJS.ProcessEnv,
	});
	return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("pinning the account (scripts/run.ts, pinAccount)", () => {
	/** A stand-in for cf that answers `cf auth whoami` with the accounts in FAKE_ACCOUNTS. */
	function fakeCf(): string {
		const bin = join(base, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "cf"),
			`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "whoami") console.log(JSON.stringify({ authenticated: true, accounts: (process.env.FAKE_ACCOUNTS || "").split(",").filter(Boolean).map((id) => ({ id })) }));
else { console.error("unexpected: " + args.join(" ")); process.exit(2); }
`,
			{ mode: 0o755 },
		);
		return bin;
	}

	const pin = (record: boolean) => `
import { readInstance } from "${SCRIPTS}instance.ts";
import { lockInstance, pinAccount } from "${SCRIPTS}run.ts";
const instance = readInstance(process.env.MINERVA_INSTANCES_DIR, "acme");
lockInstance(instance);
try {
	const id = pinAccount([], [], instance, { record: ${record} });
	console.log(JSON.stringify({ pinned: process.env.CLOUDFLARE_ACCOUNT_ID === id && id === readInstance(process.env.MINERVA_INSTANCES_DIR, "acme").account }));
} catch (error) {
	console.log(JSON.stringify({ error: error.message }));
}`;
	const answer = (out: string) => JSON.parse(out.trim()) as { pinned?: boolean; error?: string };

	test("an instance's first pin records the account cf reaches, before anything changes, and prints no id", () => {
		const bin = fakeCf();
		make("acme");
		const first = node(pin(true), { FAKE_ACCOUNTS: ACCOUNT }, bin);
		expect(answer(first.out)).toEqual({ pinned: true });
		expect(readInstance(root, "acme").account).toBe(ACCOUNT);
		expect(first.out + first.err).not.toContain(ACCOUNT);
		// The lock is gone with the process.
		expect(existsSync(join(root, "acme", "lock"))).toBe(false);
		// From then on, that account and no other.
		expect(answer(node(pin(true), { FAKE_ACCOUNTS: `${OTHER},${ACCOUNT}` }, bin).out)).toEqual({ pinned: true });
		const elsewhere = node(pin(true), { FAKE_ACCOUNTS: `${ACCOUNT},${OTHER}`, CLOUDFLARE_ACCOUNT_ID: OTHER }, bin);
		expect(answer(elsewhere.out).error).toBe(`CLOUDFLARE_ACCOUNT_ID is not the account acme is on (${join(root, "acme", "instance.json")}).`);
		const unreachable = node(pin(true), { FAKE_ACCOUNTS: OTHER }, bin);
		expect(answer(unreachable.out).error).toMatch(/^cf cannot reach the account acme is on/);
		for (const run of [elsewhere, unreachable]) {
			expect(run.out + run.err).not.toContain(ACCOUNT);
			expect(run.out + run.err).not.toContain(OTHER);
		}
		expect(readInstance(root, "acme").account).toBe(ACCOUNT);
	});

	test("before an account is recorded: CLOUDFLARE_ACCOUNT_ID's, or the only one, and a suite does not record it", () => {
		const bin = fakeCf();
		make("acme");
		expect(answer(node(pin(true), { FAKE_ACCOUNTS: `${ACCOUNT},${OTHER}` }, bin).out).error).toBe("cf reaches 2 accounts: set CLOUDFLARE_ACCOUNT_ID to the instance's.");
		expect(answer(node(pin(false), { FAKE_ACCOUNTS: ACCOUNT }, bin).out).error).toBe(`acme has no account recorded yet (${join(root, "acme", "instance.json")}): its first deploy records it.`);
		expect(readInstance(root, "acme").account).toBeNull();
		expect(answer(node(pin(true), { FAKE_ACCOUNTS: `${ACCOUNT},${OTHER}`, CLOUDFLARE_ACCOUNT_ID: OTHER }, bin).out)).toEqual({ pinned: true });
		expect(readInstance(root, "acme").account).toBe(OTHER);
	});
});

describe("the locks: the checkout's first, then the instance's", () => {
	const holder = (files: string[]) => `
import { holdLocks } from "${SCRIPTS}run.ts";
holdLocks(${JSON.stringify(files)});
console.log("held");
setTimeout(() => {}, 30_000);`;
	const contend = (files: string[]) => `
import { holdLocks } from "${SCRIPTS}run.ts";
try {
	holdLocks(${JSON.stringify(files)});
	console.log("held");
} catch (error) {
	console.log(error.message);
}`;

	/** Starts a process that holds `files` until it is killed. */
	async function hold(files: string[]): Promise<ChildProcess> {
		const child = spawn(process.execPath, ["--input-type=module", "-e", holder(files)], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise<void>((resolve, reject) => {
			child.stdout?.on("data", (chunk: Buffer) => chunk.toString().includes("held") && resolve());
			child.on("exit", () => reject(new Error("The holder exited.")));
		});
		return child;
	}

	async function stop(child: ChildProcess): Promise<void> {
		const exited = new Promise((resolve) => child.on("exit", resolve));
		child.kill("SIGTERM");
		await exited;
	}

	test("a held checkout lock stops a command before it touches the instance's", async () => {
		const checkout = join(base, "operations.lock");
		const instance = join(base, "instance.lock");
		const first = await hold([checkout, instance]);
		try {
			const second = node(contend([checkout, instance]), {});
			expect(second.out.trim()).toBe(`Another command holds ${checkout} (process ${first.pid}): wait for it to finish.`);
			expect(readFileSync(instance, "utf8")).toBe(String(first.pid));
		} finally {
			await stop(first);
		}
		// Released on its way out, signal included.
		expect(existsSync(checkout) || existsSync(instance)).toBe(false);
	});

	test("a held instance lock stops a command that holds the checkout's, which it then releases", async () => {
		const checkout = join(base, "operations.lock");
		const instance = join(base, "instance.lock");
		const other = await hold([instance]);
		try {
			const second = node(contend([checkout, instance]), {});
			expect(second.out.trim()).toBe(`Another command holds ${instance} (process ${other.pid}): wait for it to finish.`);
			expect(existsSync(checkout)).toBe(false);
			expect(readFileSync(instance, "utf8")).toBe(String(other.pid));
		} finally {
			await stop(other);
		}
		expect(node(contend([checkout, instance]), {}).out.trim()).toBe("held");
		expect(existsSync(checkout) || existsSync(instance)).toBe(false);
	});

	test("a script run by a command that holds the locks runs under them; run alone, or by another, it takes them", async () => {
		const checkout = join(base, "operations.lock");
		const instance = join(base, "instance.lock");
		const child = `
import { holdLocksUnlessParentHolds } from "${SCRIPTS}run.ts";
try {
	holdLocksUnlessParentHolds(${JSON.stringify([checkout, instance])});
	console.log("ran");
} catch (error) {
	console.log(error.message);
}`;
		const parent = `
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { holdLocks } from "${SCRIPTS}run.ts";
holdLocks(${JSON.stringify([checkout, instance])});
const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { encoding: "utf8" });
const still = [${JSON.stringify(checkout)}, ${JSON.stringify(instance)}].every((file) => readFileSync(file, "utf8") === String(process.pid));
console.log(JSON.stringify({ child: child.stdout.trim(), still }));`;
		expect(JSON.parse(node(parent, {}).out.trim())).toEqual({ child: "ran", still: true });
		expect(existsSync(checkout) || existsSync(instance)).toBe(false);
		// Alone, it takes both and releases them.
		expect(node(child, {}).out.trim()).toBe("ran");
		expect(existsSync(checkout) || existsSync(instance)).toBe(false);
		// Another command's locks stop it.
		const other = await hold([checkout, instance]);
		try {
			expect(node(child, {}).out.trim()).toBe(`Another command holds ${checkout} (process ${other.pid}): wait for it to finish.`);
		} finally {
			await stop(other);
		}
	});

	test("a lock is made from a fresh file, never through a link left beside it under a name it could guess", () => {
		const instance = join(base, "instance.lock");
		const target = join(base, "target");
		writeFileSync(target, "kept\n", { mode: 0o600 });
		const run = node(
			`
import { symlinkSync } from "node:fs";
import { holdLocks } from "${SCRIPTS}run.ts";
symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(instance)} + "." + process.pid);
holdLocks([${JSON.stringify(instance)}]);
console.log("held");`,
			{},
		);
		expect(run.out.trim()).toBe("held");
		expect(readFileSync(target, "utf8")).toBe("kept\n");
		expect(readdirSync(base).filter((entry) => entry.startsWith("instance.lock"))).toHaveLength(1);
	});

	test("a lock left by a process that died is never taken over: the message names the file", () => {
		const instance = join(base, "instance.lock");
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(instance, String(dead), { mode: 0o600 });
		expect(node(contend([instance]), {}).out.trim()).toBe(`A command (process ${dead}) stopped without removing its lock: if none is running, remove ${instance} and run this again.`);
		expect(readFileSync(instance, "utf8")).toBe(String(dead));
	});

	test("every command that changes an instance takes both, in that order, before it pins the account; generating secrets takes the instance's", () => {
		const source = (file: string) => readFileSync(join(SCRIPTS, file), "utf8");
		expect(source("run.ts")).toContain("return [CHECKOUT_LOCK, instance.files.lock];");
		expect(source("resources.ts")).toMatch(/if \(!rest\.includes\("--check"\)\) lockOperationUnlessParentHolds\(instance\);\n\tpinAccount\(/);
		for (const file of ["deploy.ts", "reset.ts"]) {
			const text = source(file);
			expect(text.indexOf("lockOperation(INSTANCE);"), file).toBeGreaterThan(0);
			expect(text.indexOf("lockOperation(INSTANCE);"), file).toBeLessThan(text.indexOf("pinAccount("));
			expect(text, file).not.toMatch(/holdLocks\(|lockInstance\(/);
		}
		const secrets = source("secrets.ts");
		expect(secrets.indexOf("if (INSTANCE) lockInstance(INSTANCE);")).toBeGreaterThan(0);
		expect(secrets.indexOf("if (INSTANCE) lockInstance(INSTANCE);")).toBeLessThan(secrets.indexOf("writeInstanceFile(INSTANCE"));
	});
});

describe("operator files left at the repository root", () => {
	test("each is named with the command that moves it into an instance's directory", () => {
		const repo = join(base, "repo");
		mkdirSync(repo);
		expect(leftoverProblem(repo, root)).toBeNull();
		for (const file of [".env", ".env.example", ".env.staging"]) writeFileSync(join(repo, file), "");
		expect(leftoverProblem(repo, root)).toBeNull();
		for (const file of [".env.cloudflare", ".env.cloudflare-test.vars", ".env.cloudflare-cm", ".env.cloudflare.old"]) writeFileSync(join(repo, file), "");
		expect(leftoverProblem(repo, root)?.split("\n")).toEqual([
			`Operator files at the repository root are no longer read: each instance keeps its own in ${root}/<name>/ (cloudflare/README.md, The instance directory). Move them there, which keeps their modes:`,
			`  mv ${join(repo, ".env.cloudflare")} ${join(root, "<instance>", "secrets.env")}`,
			`  mv ${join(repo, ".env.cloudflare-cm")} ${join(root, "<test-instance>", "cm.env")}`,
			`  mv ${join(repo, ".env.cloudflare-test.vars")} ${join(root, "<test-instance>", "vars.env")}`,
			`  ${join(repo, ".env.cloudflare.old")} is no instance's file: move it away or remove it`,
		]);
	});
});
