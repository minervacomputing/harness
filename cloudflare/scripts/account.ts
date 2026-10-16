// What the scripts read of an instance on its account, changing nothing: whether a Worker exists, a Worker's Durable
// Object namespaces, the bindings of the version serving all of a Worker's traffic, which build those bindings are
// (`bindingsKind`), and the account's workers.dev subdomain, which the instance's origins are on (`accountSubdomain`,
// `checkOnAccount`). Every cf call goes through scripts/run.ts, so one that fails throws: nothing here reads a failure
// as "absent". Ids and the subdomain are hidden from everything run.ts prints, and no message here names them.

import type { LiveBinding } from "./builds.ts";
import { subdomainOf } from "./origins.ts";
import { CommandFailed, cfJson, hide } from "./run.ts";

/** The most results a listing here asks for in one page; a full page stops, rather than miss what is on the next. */
const PAGE = 100;

/**
 * Whether the account has a Worker named `name`: an exact match among the Workers whose names contain it
 * (`cf workers scripts search`), rather than in a listing of every Worker, which comes in pages (ten by default).
 */
export function workerExists(name: string): boolean {
	const found = cfJson<{ id?: string; script_name?: string }[]>(["workers", "scripts", "search", "--name", name, `--per-page=${PAGE}`]);
	if (!Array.isArray(found)) throw new CommandFailed("`cf workers scripts search` did not answer a list.");
	for (const worker of found) hide(worker.id);
	if (found.length >= PAGE) throw new CommandFailed(`${PAGE} Workers or more have names containing ${name}, more than one page: look for it by hand.`);
	return found.some((worker) => worker.script_name === name);
}

interface Namespace {
	id: string;
	name: string;
	script: string;
	class: string;
}

/** The Durable Object namespaces of the Worker `name`, from one listing of the account's; a full page stops. */
export function ownNamespaces(name: string): Namespace[] {
	const namespaces = cfJson<Namespace[]>(["durable-objects", "namespaces", "list", "--per-page", "1000"]);
	if (!Array.isArray(namespaces)) throw new CommandFailed("`cf durable-objects namespaces list` did not answer a list.");
	if (namespaces.length >= 1000) throw new CommandFailed("The account has 1,000 Durable Object namespaces or more, more than one page: list them by hand.");
	for (const namespace of namespaces) hide(namespace.id);
	return namespaces.filter((namespace) => namespace.script === name);
}

/** The bindings of the version of the Worker `name` serving all of its traffic; a Worker served otherwise throws. */
export function liveBindings(name: string): Record<string, LiveBinding> | undefined {
	const { deployments = [] } = cfJson<{ deployments?: { versions?: { version_id: string; percentage: number }[] }[] }>(["workers", "deployments", "list", "--worker", name]);
	const versions = deployments[0]?.versions ?? [];
	const version = versions[0];
	if (versions.length !== 1 || !version || version.percentage !== 100) throw new CommandFailed(`${name} is not deployed as one version serving all traffic.`);
	hide(version.version_id);
	return cfJson<{ env?: Record<string, LiveBinding> }>(["workers", "versions", "get", version.version_id, "--worker-id", name]).env;
}

/**
 * Which build a version's bindings are: both builds bind CONVERSATION as a Durable Object, and the test build binds
 * FAULT_PROVIDER as one too, which the production build does not bind at all. EMAIL and FAULT_MAILBOX, which builds before
 * 13b also bound, do not count, so those builds are recognised too. The quiesced instance of a reset (reset-worker/) binds
 * nothing of its own, but keeps the app's secrets, which every version of a Worker inherits, so it has secrets alone (or
 * nothing). Any other shape is unknown.
 */
export function bindingsKind(env: Record<string, LiveBinding> | undefined): "test" | "production" | "quiesced" | "unknown" {
	const bindings = env ?? {};
	if (Object.values(bindings).every((binding) => binding.type === "secret_text")) return "quiesced";
	const object = (name: string) => bindings[name]?.type === "durable_object_namespace";
	if (!object("CONVERSATION")) return "unknown";
	if (object("FAULT_PROVIDER")) return "test";
	return Object.hasOwn(bindings, "FAULT_PROVIDER") ? "unknown" : "production";
}

/**
 * The account's workers.dev subdomain, as its Workers' own URLs show it (`<Worker>.<subdomain>.workers.dev`, one
 * subdomain per account). An account with no Worker shows none, and that stops the caller: its origins are unknown.
 * The subdomain is hidden from all output, and in GitHub Actions masked in the log from here on, since a suite prints
 * the origins it derives from it in its errors.
 */
export function accountSubdomain(): string {
	const workers = cfJson<{ id?: string; name?: string; subdomain?: { url?: string } }[]>(["workers", "list", `--per-page=${PAGE}`]);
	if (!Array.isArray(workers)) throw new CommandFailed("`cf workers list` did not answer a list.");
	const found = new Set<string>();
	for (const worker of workers) {
		hide(worker.id);
		let labels: string[];
		try {
			labels = new URL(worker.subdomain?.url ?? "").hostname.split(".");
		} catch {
			continue;
		}
		if (labels.length === 4 && labels[0] === worker.name && labels[1] && labels[2] === "workers" && labels[3] === "dev") found.add(labels[1]);
	}
	for (const subdomain of found) {
		hide(subdomain);
		// A hostname's label, so the workflow command needs no escaping (scripts/masks.ts, maskCommands).
		if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${subdomain}`);
	}
	const [subdomain] = found;
	if (found.size > 1) throw new CommandFailed("The account's Workers show more than one workers.dev subdomain.");
	if (!subdomain) throw new CommandFailed("No Worker on the account shows its workers.dev subdomain, so the instance's origins are unknown: deploy a Worker on workers.dev first.");
	return subdomain;
}

/**
 * Stops unless every origin (each checked by scripts/origins.ts first) is on the account's own workers.dev
 * subdomain. Each origin's setting names it in the message, which never names the subdomain.
 */
export function checkOnAccount(origins: { origin: string; setting: string }[]): void {
	const subdomain = accountSubdomain();
	const elsewhere = origins.filter((entry) => subdomainOf(entry.origin) !== subdomain);
	if (elsewhere.length) throw new CommandFailed(`${elsewhere.map((entry) => entry.setting).join(" and ")} ${elsewhere.length > 1 ? "are" : "is"} not on the account's workers.dev subdomain: the settings are another account's, or another instance's.`);
}
