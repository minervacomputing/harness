// The names of an instance (docs/plans/instance-names.md). An instance is a name, and every resource it owns is
// named from it by `namesOf`: the Worker configs, the scripts and the account suites take their names from
// here, and nothing else builds one.
//
// This module has no import and uses no Node module, because the Worker configs (cloudflare.config.ts,
// files-worker/, reset-worker/, the lab's) import it and are type-checked with the Worker's types, which lack
// Node's. What needs Node later (the instance's directory) reaches it as those configs do, through
// `process.getBuiltinModule`.

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
 * The names the modes that reach no account use: `offline` (the dev server) and `test` (the platform tests, run
 * by vitest) with cf's default mode (`pnpm build`, `cf workers types`). No instance is needed for them, and
 * none of ours is named.
 */
export const LOCAL_INSTANCES = { offline: "minerva-dev", test: "minerva-local" } as const;

/** The Docker tag of the sandbox image that `pnpm sandbox:image` builds for the Docker tests. */
export const LOCAL_SANDBOX_IMAGE = "minerva-sandbox:local";

/**
 * The instance today's flags choose: `--test` is the test instance, otherwise production's. Temporary: the next
 * unit (2b) chooses an instance by `--instance` and the instance directory, and this goes.
 */
export function todaysInstance(test: boolean): string {
	return test ? "minerva-cf-test" : "minerva-cf";
}
