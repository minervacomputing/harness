// An instance's origins (cloudflare/README.md, Setup): only workers.dev is configured, so each origin is one of the
// instance's own Workers there, `https://<Worker>.<subdomain>.workers.dev`, and an instance's origins share one
// subdomain, its account's. A deployed build checks its two origins this way (cloudflare.config.ts), the account
// suites check every origin before they send anything there, and the deploy and the suites then compare the
// subdomain with the account's own (scripts/account.ts, `checkOnAccount`), so a vars file copied from another
// instance, or from another account, stops them. The messages never repeat a value: it names the account's
// subdomain.
//
// The Worker configs import this module and are type-checked with the Worker's types, so it imports nothing of
// Node's (scripts/instance.ts reaches the files).

import { type Instance, type Names, instanceVars, readInstanceEnv } from "./instance.ts";

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

/** The app's and the download origin's of the instance `names`, checked as `instanceOrigin` does and on one subdomain, or an error naming the settings. */
export function instanceOrigins(site: string | undefined, download: string | undefined, settings: { site: string; download: string }, names: Names): { origin: string; downloadOrigin: string } {
	const origin = instanceOrigin(site, names.app, settings.site);
	const downloadOrigin = instanceOrigin(download, names.download, settings.download);
	if (subdomainOf(origin) !== subdomainOf(downloadOrigin)) throw new Error(`${settings.site} and ${settings.download} are on different workers.dev subdomains: both must be the instance's.`);
	return { origin, downloadOrigin };
}

/** The instance's app and download origins, from its vars.env, checked by `instanceOrigins`. */
export function originsOf(instance: Instance): { origin: string; downloadOrigin: string } {
	const vars = instanceVars(instance);
	const where = `in ${instance.name}'s vars.env`;
	return instanceOrigins(vars.MINERVA_SITE_URL, vars.MINERVA_DOWNLOAD_ORIGIN, { site: `MINERVA_SITE_URL ${where}`, download: `MINERVA_DOWNLOAD_ORIGIN ${where}` }, instance.names);
}

/** The origin of a test instance's code mode lab (`<name>-cm`), from its cm.vars.env, checked by `instanceOrigin`. */
export function labOrigin(instance: Instance): string {
	const vars = readInstanceEnv(instance, "cmVars");
	if (!vars) throw new Error(`The lab's origin is in ${instance.files.cmVars}, which is missing (cloudflare/README.md, Code mode's lab).`);
	return instanceOrigin(vars.CM_ORIGIN, instance.names.lab, `CM_ORIGIN in ${instance.name}'s cm.vars.env`);
}
