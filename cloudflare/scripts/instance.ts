// Instances (docs/plans/instance-names.md): an instance is a name plus a directory that belongs to its operator.
// Every resource it owns is named from the name by `namesOf`, and the directory (`instancesDir`) holds what the
// operator keeps for it: whether it is a test instance, its account, its secrets and settings, its last deploy.
// The Worker configs, the scripts and the account suites choose an instance here (`chooseInstance`,
// `instanceForMode`) and take every name from it; nothing else builds a name or reads the directory's files.
//
// The Worker configs (cloudflare.config.ts, files-worker/, reset-worker/, the lab's) import this module and are
// type-checked with the Worker's types, which lack Node's, so it has no import: it reaches Node's modules
// through `process.getBuiltinModule`, as the configs do. Writing to the directory (scripts/instance-files.ts)
// and its lock (scripts/run.ts) are the scripts' alone.

/** The longest name: `<name>-files-eu` (9 more characters) must stay within the 63 of a Worker or a bucket. */
export const MAX_NAME_LENGTH = 54;

/**
 * What the derivation appends to a name. A name may not end in one, or the instance `acme-files` would own the
 * download Worker of the instance `acme`.
 */
export const RESERVED_SUFFIXES = ["-files", "-files-eu", "-sandbox", "-cm"] as const;

/** The AI Gateway that Cloudflare creates by itself, with logging on, so an instance cannot use its id. */
const RESERVED_NAMES = ["default"] as const;

/** Lowercase letters, digits and single hyphens, starting with a letter and not ending with a hyphen. */
const SHAPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** What is wrong with a name as an instance's, or null when it is one. */
export function nameProblem(name: unknown): string | null {
	if (typeof name !== "string" || name === "") return "An instance name is empty.";
	if (name.length > MAX_NAME_LENGTH) return `An instance name has at most ${MAX_NAME_LENGTH} characters, so that its longest derived name stays within the 63 of a Worker or a bucket.`;
	if (!SHAPE.test(name)) return "An instance name has lowercase letters, digits and single hyphens, starts with a letter and does not end with a hyphen.";
	const suffix = RESERVED_SUFFIXES.find((candidate) => name.endsWith(candidate));
	if (suffix) return `An instance name cannot end in ${suffix}, which names the instance's own resources.`;
	if ((RESERVED_NAMES as readonly string[]).includes(name)) return `An instance cannot be named ${name}.`;
	return null;
}

/** The name, or an error saying why it is not an instance's. */
export function instanceName(name: string): string {
	const problem = nameProblem(name);
	if (problem) throw new Error(problem);
	return name;
}

/** Every resource name of an instance. */
export interface Names {
	/** The instance's name. */
	name: string;
	/** The app Worker. */
	app: string;
	/** The D1 database. */
	d1: string;
	/** The AI Gateway, which `MINERVA_MODEL_GATEWAY` names in the build. */
	gateway: string;
	/** The download origin's Worker. */
	download: string;
	/** The default bucket. */
	bucket: string;
	/** The bucket in R2's EU jurisdiction. */
	bucketEu: string;
	/** The sandbox's container application. */
	container: string;
	/** Code mode's lab Worker, which only a test instance deploys. */
	lab: string;
}

/** Every resource name of the instance `name`, which must be a valid name. */
export function namesOf(name: string): Names {
	instanceName(name);
	return {
		name,
		app: name,
		d1: name,
		gateway: name,
		download: `${name}-files`,
		bucket: `${name}-files`,
		bucketEu: `${name}-files-eu`,
		container: `${name}-sandbox`,
		lab: `${name}-cm`,
	};
}

/**
 * The names the modes that reach no instance use: `offline` (the dev server) and `test` (the platform tests, run
 * by vitest), the second also for every other local mode (`standalone` for `pnpm build` and `pnpm startup`, and
 * the mode of `cf workers types`, which has none). No instance is needed for them, and no instance has their
 * names (`instanceNameProblem`), so a local build never carries an instance's.
 */
export const LOCAL_INSTANCES = { offline: "minerva-dev", test: "minerva-local" } as const;

/** What is wrong with a name as an instance directory's: an instance's name, and not one of the local names. */
export function instanceNameProblem(name: string): string | null {
	const problem = nameProblem(name);
	if (problem) return problem;
	if ((Object.values(LOCAL_INSTANCES) as string[]).includes(name)) return `${name} is the name of the local builds, which reach no instance: an instance cannot have it.`;
	return null;
}

/** The Docker tag of the sandbox image that `pnpm sandbox:image` builds for the Docker tests. */
export const LOCAL_SANDBOX_IMAGE = "minerva-sandbox:local";


// ---------------------------------------------------------------------------------------------------------
// The instance directory (cloudflare/README.md, The instance directory):
//
//   <instancesDir()>/<name>/   mode 700
//     instance.json   {"name": "<name>", "test": false, "account": "<account id>"}: the account is recorded by the
//                     first command that pins one for the instance (scripts/run.ts, pinAccount)
//     secrets.env     the Workers' secrets (scripts/secrets.ts)
//     vars.env        the app's and the download origin's settings
//     deployed.json   the last deploy of the app, for a later --files-only (scripts/instance-files.ts)
//     cm.env          code mode's lab: its driver token (test instances only)
//     cm.vars.env     code mode's lab: its origin
//     lock            held by any command that writes here or changes the instance's account (scripts/run.ts)
//
// Every directory and file is its owner's alone (no access for group or others) and none is a symbolic link,
// checked with lstat and opened with O_NOFOLLOW. Nothing read here is ever printed.

/** The files of an instance's directory, by what they hold. */
export const INSTANCE_FILES = {
	instance: "instance.json",
	secrets: "secrets.env",
	vars: "vars.env",
	deployed: "deployed.json",
	cm: "cm.env",
	cmVars: "cm.vars.env",
	lock: "lock",
} as const;

export type InstanceFile = keyof typeof INSTANCE_FILES;

/** An instance: its name, its kind, its account once recorded, and its directory. */
export interface Instance {
	name: string;
	/** A test instance runs the test build (mode `faults`); any other, the production build. */
	test: boolean;
	/** The Cloudflare account it is on, once a command has pinned one; null before. */
	account: string | null;
	/** Its directory. */
	dir: string;
	names: Names;
	/** Each file's path in the directory. */
	files: Record<InstanceFile, string>;
}

/** What this module needs of Node, reached through `process.getBuiltinModule` (the configs' types lack Node's). */
interface FileStats {
	mode: number;
	uid: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}
interface NodeModules {
	"node:fs": {
		lstatSync(path: string, options: { throwIfNoEntry: false }): FileStats | undefined;
		fstatSync(fd: number): FileStats;
		openSync(path: string, flags: number): number;
		readFileSync(fd: number, encoding: "utf8"): string;
		closeSync(fd: number): void;
		readdirSync(path: string): string[];
		realpathSync(path: string): string;
		constants: { O_RDONLY: number; O_NOFOLLOW: number };
	};
	"node:os": { homedir(): string };
	"node:path": { join(...parts: string[]): string; resolve(...parts: string[]): string; relative(from: string, to: string): string; dirname(path: string): string; basename(path: string): string; isAbsolute(path: string): boolean };
	"node:url": { fileURLToPath(url: string): string };
	"node:util": { parseEnv(text: string): Record<string, string> };
	"node:child_process": { spawnSync(command: string, args: string[], options: { cwd: string; stdio: "ignore" }): { status: number | null } };
}
interface NodeProcess {
	env: Record<string, string | undefined>;
	getuid?: () => number;
	getBuiltinModule<K extends keyof NodeModules>(id: K): NodeModules[K];
}
const nodeProcess = () => (globalThis as unknown as { process: NodeProcess }).process;
const node = <K extends keyof NodeModules>(id: K): NodeModules[K] => nodeProcess().getBuiltinModule(id);

/** The repository root: the checkout whose leftover files `leftoverProblem` looks for. */
const REPOSITORY = () => node("node:url").fileURLToPath(new URL("../../", (import.meta as unknown as { url: string }).url).href);

/** A Cloudflare account id: 32 lowercase hexadecimal characters. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/**
 * The directory that holds every instance's: MINERVA_INSTANCES_DIR (an absolute path) replaces the whole path;
 * otherwise `minerva/instances` in $XDG_CONFIG_HOME (when absolute) or ~/.config.
 */
export function instancesDir(env: Record<string, string | undefined> = nodeProcess().env): string {
	const path = node("node:path");
	const own = env.MINERVA_INSTANCES_DIR;
	if (own) {
		if (!path.isAbsolute(own)) throw new Error("MINERVA_INSTANCES_DIR must be an absolute path.");
		return path.resolve(own);
	}
	const xdg = env.XDG_CONFIG_HOME;
	return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(node("node:os").homedir(), ".config"), "minerva", "instances");
}

/** What is wrong with an entry's owner and mode: it must be the user's alone. */
function ownerProblem(stats: FileStats, what: string): string | null {
	const uid = nodeProcess().getuid?.();
	if (uid !== undefined && stats.uid !== uid) return `${what} belongs to another user.`;
	if ((stats.mode & 0o077) !== 0) return `${what} must be its owner's alone (chmod ${stats.isDirectory() ? "700" : "600"}).`;
	return null;
}

/** Checks a directory of ours: present, not a symbolic link, the user's alone. */
export function checkDirectory(dir: string, what: string): void {
	const stats = node("node:fs").lstatSync(dir, { throwIfNoEntry: false });
	if (!stats) throw new Error(`${what} (${dir}) does not exist.`);
	if (stats.isSymbolicLink()) throw new Error(`${what} (${dir}) is a symbolic link, which an instance's files never are.`);
	if (!stats.isDirectory()) throw new Error(`${what} (${dir}) is not a directory.`);
	const problem = ownerProblem(stats, `${what} (${dir})`);
	if (problem) throw new Error(problem);
}

/** Checks a file of an instance's that exists: not a symbolic link, a plain file, the user's alone. */
export function checkFile(file: string): void {
	const stats = node("node:fs").lstatSync(file, { throwIfNoEntry: false });
	if (!stats) return;
	if (stats.isSymbolicLink()) throw new Error(`${file} is a symbolic link, which an instance's files never are.`);
	if (!stats.isFile()) throw new Error(`${file} is not a plain file.`);
	const problem = ownerProblem(stats, file);
	if (problem) throw new Error(problem);
}

/**
 * An instance file's text, or null when it does not exist. It is opened without following a symbolic link and
 * checked on the open file, so what is read is what was checked.
 */
function readChecked(file: string): string | null {
	const fs = node("node:fs");
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return null;
		if (code === "ELOOP" || code === "EMLINK") throw new Error(`${file} is a symbolic link, which an instance's files never are.`);
		throw error;
	}
	try {
		const stats = fs.fstatSync(fd);
		if (!stats.isFile()) throw new Error(`${file} is not a plain file.`);
		const problem = ownerProblem(stats, file);
		if (problem) throw new Error(problem);
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The instance whose instance.json says `text`, in the directory `dir`, or an error: it must name its own
 * directory, `test` must be a boolean, and the account, once recorded, an account id. Nothing of the file is
 * repeated in a message.
 */
export function parseInstance(text: string, dir: string): Instance {
	const path = node("node:path");
	const name = path.basename(dir);
	const where = path.join(dir, INSTANCE_FILES.instance);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${where} is not JSON.`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} is not a JSON object.`);
	const fields = value as Record<string, unknown>;
	const unknown = Object.keys(fields).filter((key) => !["name", "test", "account"].includes(key));
	if (unknown.length) throw new Error(`${where} has fields an instance does not have: only name, test and account.`);
	if (fields.name !== name) throw new Error(`${where} does not name its own directory, ${name}.`);
	const problem = instanceNameProblem(name);
	if (problem) throw new Error(`${dir}: ${problem}`);
	if (typeof fields.test !== "boolean") throw new Error(`${where}: test must be true or false.`);
	if (fields.account !== undefined && (typeof fields.account !== "string" || !ACCOUNT_ID.test(fields.account))) throw new Error(`${where}: account is not a Cloudflare account id.`);
	const files = Object.fromEntries(Object.entries(INSTANCE_FILES).map(([key, file]) => [key, path.join(dir, file)])) as Record<InstanceFile, string>;
	return { name, test: fields.test, account: (fields.account as string | undefined) ?? null, dir, names: namesOf(name), files };
}

/**
 * The instances directory, checked: null when it does not exist yet. It must not be a symbolic link, must be
 * the user's alone, and when it is inside a git checkout (CI keeps one in a temporary MINERVA_INSTANCES_DIR),
 * git must ignore it, so that no secret can be committed. The checkout is looked for above where the directory
 * really is, links above it resolved (a link in its path, such as a linked ~/.config, is allowed).
 */
function checkedRoot(root: string): string | null {
	if (!node("node:fs").lstatSync(root, { throwIfNoEntry: false })) return null;
	checkDirectory(root, "The instances directory");
	const path = node("node:path");
	const real = node("node:fs").realpathSync(root);
	for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
		if (node("node:fs").lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) {
			const { status } = node("node:child_process").spawnSync("git", ["check-ignore", "-q", "--", path.relative(dir, real)], { cwd: dir, stdio: "ignore" });
			if (status === 1) throw new Error(`The instances directory (${root}) is inside the git checkout ${dir} and not ignored by it: choose one outside it, or ignore it.`);
			if (status !== 0) throw new Error(`Could not ask git whether the instances directory (${root}) is ignored by the checkout ${dir}.`);
			break;
		}
		if (path.dirname(dir) === dir) break;
	}
	return root;
}

/** The instance `name` in `root`, every file of its directory checked; an error when it is missing or malformed. */
export function readInstance(root: string, name: string): Instance {
	if (!checkedRoot(root)) throw new Error(`There is no instance ${name}: the instances directory ${root} does not exist (cloudflare/README.md, The instance directory).`);
	return readEntry(root, name);
}

/** `readInstance` in a root already checked. */
function readEntry(root: string, name: string): Instance {
	const problem = instanceNameProblem(name);
	if (problem) throw new Error(`${node("node:path").join(root, name)}: ${problem}`);
	const dir = node("node:path").join(root, name);
	if (!node("node:fs").lstatSync(dir, { throwIfNoEntry: false })) throw new Error(`There is no instance ${name} in ${root}.`);
	checkDirectory(dir, `The directory of ${name}`);
	const text = readChecked(node("node:path").join(dir, INSTANCE_FILES.instance));
	if (text === null) throw new Error(`${dir} has no ${INSTANCE_FILES.instance}.`);
	const instance = parseInstance(text, dir);
	for (const file of Object.values(instance.files)) checkFile(file);
	return instance;
}

/**
 * Every instance in `root`, by name; none when the directory does not exist. A malformed one stops the listing,
 * rather than vanishing from it and leaving another as the only one. Entries starting with a dot are not
 * instances (no name does).
 */
export function listInstances(root: string): Instance[] {
	if (!checkedRoot(root)) return [];
	return node("node:fs")
		.readdirSync(root)
		.filter((entry) => !entry.startsWith("."))
		.sort()
		.map((entry) => readEntry(root, entry));
}

/** The operator files that lived at the repository root before the instance directory, by what each became. */
const LEFTOVERS: Record<string, { file: string; instance: string }> = {
	".env.cloudflare": { file: INSTANCE_FILES.secrets, instance: "<instance>" },
	".env.cloudflare.vars": { file: INSTANCE_FILES.vars, instance: "<instance>" },
	".env.cloudflare-test": { file: INSTANCE_FILES.secrets, instance: "<test-instance>" },
	".env.cloudflare-test.vars": { file: INSTANCE_FILES.vars, instance: "<test-instance>" },
	".env.cloudflare-cm": { file: INSTANCE_FILES.cm, instance: "<test-instance>" },
	".env.cloudflare-cm.vars": { file: INSTANCE_FILES.cmVars, instance: "<test-instance>" },
};

/**
 * What to do about operator files still at the repository root `repo`, which nothing reads any more: null when
 * there are none. Every command that chooses an instance stops on them, so that no one edits a file that is not
 * read. (This check goes at the merge into main.)
 */
export function leftoverProblem(repo: string, root: string): string | null {
	const path = node("node:path");
	const found = node("node:fs")
		.readdirSync(repo)
		.filter((entry) => entry.startsWith(".env.cloudflare"))
		.sort();
	if (!found.length) return null;
	const lines = found.map((entry) => {
		const target = LEFTOVERS[entry];
		return target ? `  mv ${path.join(repo, entry)} ${path.join(root, target.instance, target.file)}` : `  ${path.join(repo, entry)} is no instance's file: move it away or remove it`;
	});
	return `Operator files at the repository root are no longer read: each instance keeps its own in ${root}/<name>/ (cloudflare/README.md, The instance directory). Move them there, which keeps their modes:\n${lines.join("\n")}`;
}

export interface Choice {
	/** The name given with `--instance`. */
	flag?: string | undefined;
	/**
	 * A command that runs only against a test instance: the only test instance is its default, and a production
	 * instance stops it.
	 */
	test?: boolean;
	/** The environment, for MINERVA_INSTANCE and the instances directory: the process's by default. */
	env?: Record<string, string | undefined>;
}

/**
 * The instance a command runs against: `--instance`, then MINERVA_INSTANCE (the scripts set it for every command
 * they run), then, for a test command only, the only test instance. A flag that disagrees with MINERVA_INSTANCE
 * stops the command, and a production instance is never chosen by default.
 */
export function chooseInstance(choice: Choice = {}): Instance {
	const env = choice.env ?? nodeProcess().env;
	const root = instancesDir(env);
	const leftover = leftoverProblem(REPOSITORY(), root);
	if (leftover) throw new Error(leftover);
	const fromEnv = env.MINERVA_INSTANCE || undefined;
	if (choice.flag !== undefined && fromEnv !== undefined && choice.flag !== fromEnv) throw new Error(`--instance ${choice.flag} and MINERVA_INSTANCE=${fromEnv} name different instances.`);
	const named = choice.flag ?? fromEnv;
	const listed = () => {
		try {
			const names = listInstances(root).map((instance) => `${instance.name}${instance.test ? " (test)" : ""}`);
			return names.length ? `the instances in ${root} are ${names.join(", ")}` : `${root} has no instance`;
		} catch (error) {
			return `listing ${root} failed: ${(error as Error).message}`;
		}
	};
	let instance: Instance;
	if (named !== undefined) {
		const problem = instanceNameProblem(named);
		if (problem) throw new Error(problem);
		if (!node("node:fs").lstatSync(node("node:path").join(root, named), { throwIfNoEntry: false })) throw new Error(`There is no instance ${named}: ${listed()}.`);
		instance = readInstance(root, named);
	} else if (choice.test) {
		const tests = listInstances(root).filter((candidate) => candidate.test);
		const only = tests[0];
		if (tests.length !== 1 || !only) {
			throw new Error(tests.length ? `There are ${tests.length} test instances (${tests.map((candidate) => candidate.name).join(", ")}): name one with --instance or MINERVA_INSTANCE.` : `There is no test instance: ${listed()}.`);
		}
		instance = only;
	} else {
		throw new Error(`Name the instance with --instance <name> (or MINERVA_INSTANCE): a production instance is never chosen by default; ${listed()}.`);
	}
	if (choice.test && !instance.test) throw new Error(`${instance.name} is a production instance, and this runs only against a test instance.`);
	return instance;
}

/**
 * The instance a build in `mode` is for: mode `production` builds a production instance, named (never a default);
 * mode `faults` a test instance, the only one by default. A mode that disagrees with the instance's kind stops.
 */
export function instanceForMode(mode: "production" | "faults", env?: Record<string, string | undefined>): Instance {
	const instance = chooseInstance({ test: mode === "faults", env });
	if (mode === "production" && instance.test) throw new Error(`${instance.name} is a test instance: it is built in mode faults, not production.`);
	return instance;
}

/** An instance's file as text, or null when it does not exist; a file that is not the user's alone, or a link, throws. */
export function readInstanceText(instance: Instance, file: InstanceFile): string | null {
	checkDirectory(instance.dir, `The directory of ${instance.name}`);
	return readChecked(instance.files[file]);
}

/** An instance's env file (dotenv's rules, as cf reads it), or null when it does not exist. */
export function readInstanceEnv(instance: Instance, file: "secrets" | "vars" | "cm" | "cmVars"): Record<string, string> | null {
	const text = readInstanceText(instance, file);
	return text === null ? null : node("node:util").parseEnv(text);
}

/**
 * A deployed build's settings: the instance's vars.env, which must exist. It cannot set MINERVA_MODEL_GATEWAY,
 * which the build sets to the instance's name: a vars file that sets it would send the model's requests through
 * another gateway.
 */
export function instanceVars(instance: Instance): Record<string, string> {
	const vars = readInstanceEnv(instance, "vars");
	if (!vars) throw new Error(`A deployed build reads its settings from ${instance.files.vars}, which is missing (cloudflare/README.md, The instance directory).`);
	if (vars.MINERVA_MODEL_GATEWAY !== undefined) throw new Error(`MINERVA_MODEL_GATEWAY is not a setting: the build sets it to the instance's name. Remove it from ${instance.files.vars}.`);
	return vars;
}

/**
 * A script's arguments without `--instance <name>` (or `--instance=<name>`), and the name; an `--instance`
 * without a name, or given twice, throws.
 */
export function parseInstanceArgs(args: string[]): { flag: string | undefined; rest: string[] } {
	let flag: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		let value: string | undefined;
		if (arg === "--instance") value = args[++i];
		else if (arg.startsWith("--instance=")) value = arg.slice("--instance=".length);
		else {
			rest.push(arg);
			continue;
		}
		if (!value || value.startsWith("-")) throw new Error("--instance needs a name.");
		if (flag !== undefined) throw new Error("--instance is given twice.");
		flag = value;
	}
	return { flag, rest };
}
