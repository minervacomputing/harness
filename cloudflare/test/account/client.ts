// A small HTTPS client for the deployed Workers. Some resolvers fail on *.workers.dev now and then
// (ENOTFOUND; 1.1.1.1 itself answers SERVFAIL at times), so a failed lookup is retried against public
// resolvers directly, Google's first. Also the instance a suite runs against, with its secrets and settings, and
// cf's view of its account, for the checks that need them; neither is ever printed.

import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { type Instance, chooseInstance, readInstanceEnv } from "../../scripts/instance.ts";
import { ROOT, cfJson, pinAccount } from "../../scripts/run.ts";
import { instanceOrigin } from "./origins.ts";

/**
 * The instance an account suite runs against (scripts/instance.ts, `chooseInstance`): MINERVA_INSTANCE, which
 * scripts/suite.ts sets from --instance, or for a test instance's suite the only test instance. A test
 * instance's suite refuses a production instance.
 */
export function suiteInstance(test: boolean): Instance {
	return chooseInstance({ test });
}

/** A secret of the instance's secrets.env, never printed; a missing one throws. */
export function instanceSecret(instance: Instance, name: string): string {
	const value = readInstanceEnv(instance, "secrets")?.[name];
	if (!value) throw new Error(`${name} is not set in ${instance.files.secrets}.`);
	return value;
}

/**
 * The test instance's app Worker: its origin from its vars.env, checked to be its own before any request is
 * sent (origins.ts), and its secret key.
 */
export function testWorker(): { instance: Instance; origin: string; secretKey: string } {
	const instance = suiteInstance(true);
	const vars = readInstanceEnv(instance, "vars");
	if (!vars) throw new Error(`The test instance's settings are in ${instance.files.vars} (cloudflare/README.md, The test Worker).`);
	const origin = instanceOrigin(vars.MINERVA_SITE_URL, instance.names.app, `MINERVA_SITE_URL in ${instance.name}'s vars.env`);
	return { instance, origin, secretKey: instanceSecret(instance, "MINERVA_SECRET_KEY") };
}

/**
 * Pins the cf commands of this suite to the instance's account, as the deploy does (scripts/run.ts, pinAccount):
 * the one its instance.json records, which its first deploy wrote.
 */
export function pinSuite(instance: Instance): void {
	pinAccount([ROOT], [], instance, { record: false });
	pinned = true;
}
let pinned = false;

/** cf's JSON answer to a read-only command, on the account `pinSuite` pinned. */
export function cf<T>(args: string[]): T {
	if (!pinned) throw new Error("The suite's cf commands are pinned to its instance's account first (pinSuite).");
	return cfJson<T>(args);
}

/** The resolvers a failed lookup is retried against, in order (c-ares moves on after a server's failure). */
export const FALLBACK_RESOLVERS = ["8.8.8.8", "1.1.1.1", "8.8.4.4", "1.0.0.1"];

const resolver = new Resolver({ tries: 2 });
resolver.setServers(FALLBACK_RESOLVERS);

type Callback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function lookup(hostname: string, options: { all?: boolean }, callback: Callback): void {
	const answer = (addresses: LookupAddress[]) => {
		const [first] = addresses;
		if (options.all) callback(null, addresses);
		else if (first) callback(null, first.address, first.family);
	};
	systemLookup(hostname, { all: true }, (error, addresses) => {
		if (!error && addresses.length) return answer(addresses);
		resolver.resolve4(hostname).then(
			(found) => answer(found.map((address) => ({ address, family: 4 }))),
			() => callback(error ?? Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), []),
		);
	});
}

export interface Reply {
	status: number;
	headers: Headers;
	text: string;
}

export function fetchDeployed(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method: init.method ?? "GET", headers: init.headers, lookup: lookup as never, timeout: init.timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(res.headers)) {
					for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
				}
				resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8") });
			});
		});
		req.on("timeout", () => req.destroy(Object.assign(new Error(`No answer from ${url}`), { code: "ETIMEDOUT" })));
		req.on("error", reject);
		req.end(init.body);
	});
}
