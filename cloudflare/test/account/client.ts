// A small HTTPS client for the deployed Workers. Some resolvers fail on *.workers.dev now and then
// (ENOTFOUND; 1.1.1.1 itself answers SERVFAIL at times), so a failed lookup is retried against public
// resolvers directly, Google's first. Also the instance a suite runs against, with its secrets and settings, its
// origins checked to be its own Workers on its account's workers.dev subdomain before anything is sent there, and
// cf's view of its account, for the checks that need them; none of it is ever printed.

import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { checkOnAccount } from "../../scripts/account.ts";
import { type Instance, chooseInstance, readInstanceEnv } from "../../scripts/instance.ts";
import { labOrigin, originsOf } from "../../scripts/origins.ts";
import { ROOT, cfJson, pinAccount } from "../../scripts/run.ts";

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
 * The instance's app and download origins, from its vars.env: its own Workers on one workers.dev subdomain
 * (scripts/origins.ts), which must be its account's (scripts/account.ts). Pins the suite's cf commands to that
 * account first (`pinSuite`). Nothing is sent to an origin before this.
 */
export function ownOrigins(instance: Instance): { origin: string; downloadOrigin: string } {
	const origins = originsOf(instance);
	pinSuite(instance);
	checkOnAccount([
		{ origin: origins.origin, setting: `MINERVA_SITE_URL in ${instance.name}'s vars.env` },
		{ origin: origins.downloadOrigin, setting: `MINERVA_DOWNLOAD_ORIGIN in ${instance.name}'s vars.env` },
	]);
	return origins;
}

/** The test instance's code mode lab: its origin from its cm.vars.env, checked as `ownOrigins` checks the app's. */
export function ownLabOrigin(instance: Instance): string {
	const origin = labOrigin(instance);
	pinSuite(instance);
	checkOnAccount([{ origin, setting: `CM_ORIGIN in ${instance.name}'s cm.vars.env` }]);
	return origin;
}

/**
 * The test instance's app Worker: its origins (`ownOrigins`), checked before any request is sent, and its secret
 * key.
 */
export function testWorker(): { instance: Instance; origin: string; downloadOrigin: string; secretKey: string } {
	const instance = suiteInstance(true);
	if (!readInstanceEnv(instance, "vars")) throw new Error(`The test instance's settings are in ${instance.files.vars} (cloudflare/README.md, The test Worker).`);
	return { instance, ...ownOrigins(instance), secretKey: instanceSecret(instance, "MINERVA_SECRET_KEY") };
}

/**
 * Pins the cf commands of this suite to the instance's account, as the deploy does (scripts/run.ts, pinAccount):
 * the one its instance.json records, which its first deploy wrote.
 */
export function pinSuite(instance: Instance): void {
	if (pinned === instance.name) return;
	pinAccount([ROOT], [], instance, { record: false });
	pinned = instance.name;
}
let pinned: string | null = null;

/** cf's JSON answer to a read-only command, on the account `pinSuite` pinned. */
export function cf<T>(args: string[]): T {
	if (pinned === null) throw new Error("The suite's cf commands are pinned to its instance's account first (pinSuite).");
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

/**
 * One request. A request sent on a kept-alive socket the other end had just closed fails with ECONNRESET
 * before the Worker sees it (an account run's `post` did, 2026-10-15), so that one is sent again on a new
 * socket, as Node's documentation advises (`request.reusedSocket`); any other failure is the caller's.
 */
export function fetchDeployed(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<Reply> {
	return send(url, init).catch((error: unknown) => {
		if (error instanceof StaleSocket) return send(url, init);
		throw error;
	});
}

class StaleSocket extends Error {}

function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<Reply> {
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
		req.on("error", (error: NodeJS.ErrnoException) => reject(req.reusedSocket && error.code === "ECONNRESET" ? new StaleSocket(error.message, { cause: error }) : error));
		req.end(init.body);
	});
}
