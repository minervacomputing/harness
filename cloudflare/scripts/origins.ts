// An instance's origins (cloudflare/README.md, Setup): only workers.dev is configured, so each origin is one of the
// instance's own Workers there, `https://<Worker>.<subdomain>.workers.dev`, on its account's subdomain. The app's origin
// is derived from the Worker's name and the account's subdomain (`workersDevOrigin`), so no setting names it. The lab's
// is configured in its cm.vars.env: the lab's deploy and the account suites check it (`instanceOrigin`) and compare its
// subdomain with the account's own (scripts/account.ts, `checkOnAccount`), so a file copied from another instance, or
// from another account, stops them. The messages never repeat a value: it names the account's subdomain.

import { type Instance, readInstanceEnv } from "./instance.ts";

/** `value` as an origin of the Worker `name`, or an error naming the setting (never its value). */
export function instanceOrigin(value: string | undefined, name: string, setting: string): string {
	let url: URL;
	try {
		url = new URL((value ?? "").trim());
	} catch {
		throw new Error(`${setting} is not a URL.`);
	}
	if (url.protocol !== "https:") throw new Error(`${setting} is not an https origin.`);
	if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error(`${setting} must be an origin alone (no path, port, query or credentials).`);
	const labels = url.hostname.split(".");
	if (labels.length !== 4 || labels[0] !== name || !labels[1] || labels[2] !== "workers" || labels[3] !== "dev") {
		throw new Error(`${setting} is not ${name} on workers.dev: an instance's origins are its own Workers there.`);
	}
	return url.origin;
}

/** The workers.dev subdomain of an origin `instanceOrigin` accepted. */
export function subdomainOf(origin: string): string {
	return new URL(origin).hostname.split(".")[1] ?? "";
}

/** The origin of the Worker `name` on the workers.dev subdomain `subdomain`, as `instanceOrigin` accepts it. */
export function workersDevOrigin(name: string, subdomain: string): string {
	return instanceOrigin(`https://${name}.${subdomain}.workers.dev`, name, `The workers.dev origin of ${name}`);
}

/** The origin of a test instance's code mode lab (`<name>-cm`), from its cm.vars.env, checked by `instanceOrigin`. */
export function labOrigin(instance: Instance): string {
	const vars = readInstanceEnv(instance, "cmVars");
	if (!vars) throw new Error(`The lab's origin is in ${instance.files.cmVars}, which is missing (cloudflare/README.md, Code mode's lab).`);
	return instanceOrigin(vars.CM_ORIGIN, instance.names.lab, `CM_ORIGIN in ${instance.name}'s cm.vars.env`);
}
