// Where the account suites may send requests. The browser walk signs up, claims the setup and writes files; the
// fault suites drive fault points and write data; deployed.test.ts sends the probe's token. So an origin is checked
// before anything is sent (with the driver's token, the setup key or the download key): an https origin, nothing
// else in the URL, whose host is the chosen instance's own workers.dev name, `<Worker>.<subdomain>.workers.dev`
// (both Workers are on workers.dev, README: The test Worker), and the two origins on the same subdomain, one
// account's. A vars file that names another instance (production, or anything else) stops the run instead of
// signing up there. The subdomain itself is the operator's settings file's to name: nothing here can tell it from
// another account's. The messages never repeat the value, which names the account's subdomain. No side effects,
// so the unit tests import it (test/unit/account-origins.test.ts).

import { type Instance, type Names, instanceVars } from "../../scripts/instance.ts";

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
		throw new Error(`${setting} is not ${name} on workers.dev: the account suites run only against the chosen instance's own Workers.`);
	}
	return url.origin;
}

/** The app's and the download origin's of the instance `names`, checked as `instanceOrigin` does and on one subdomain, or an error naming the settings. */
export function instanceOrigins(site: string | undefined, download: string | undefined, settings: { site: string; download: string }, names: Names): { origin: string; downloadOrigin: string } {
	const origin = instanceOrigin(site, names.app, settings.site);
	const downloadOrigin = instanceOrigin(download, names.download, settings.download);
	if (subdomain(origin) !== subdomain(downloadOrigin)) throw new Error(`${settings.site} and ${settings.download} are on different workers.dev subdomains: both must be the instance's.`);
	return { origin, downloadOrigin };
}

/** The instance's app and download origins, from its vars.env, checked by `instanceOrigins`. */
export function originsOf(instance: Instance): { origin: string; downloadOrigin: string } {
	const vars = instanceVars(instance);
	const where = `in ${instance.name}'s vars.env`;
	return instanceOrigins(vars.MINERVA_SITE_URL, vars.MINERVA_DOWNLOAD_ORIGIN, { site: `MINERVA_SITE_URL ${where}`, download: `MINERVA_DOWNLOAD_ORIGIN ${where}` }, instance.names);
}

function subdomain(origin: string): string {
	return new URL(origin).hostname.split(".")[1] ?? "";
}

/**
 * Chrome failing to start, as the walk's error: the first line of the launcher's message, which repeats the
 * arguments (the hosts in the resolver rules among them), with every host replaced. The original error is not
 * kept as the cause, since its message and stack name them too.
 */
export function chromeFailure(error: unknown, hosts: readonly string[]): Error {
	let first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
	for (const host of hosts) if (host) first = first.split(host).join("<host>");
	return new Error(`Google Chrome did not start (the walk needs it installed): ${first}`);
}
