// A small HTTPS client for the deployed Workers. Some resolvers fail on *.workers.dev now and then
// (ENOTFOUND), so a failed lookup is retried against 1.1.1.1 directly. Also the Workers' secrets and cf's
// view of the account, for the checks that need them; neither is ever printed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";

const VARS = new URL("../../../.env.cloudflare.vars", import.meta.url);
if (existsSync(VARS)) process.loadEnvFile(VARS);

const SECRETS = new URL("../../../.env.cloudflare", import.meta.url);

/** A secret from ../.env.cloudflare, as scripts/secrets.ts writes it. */
export function secret(name: string): string {
	for (const line of readFileSync(SECRETS, "utf8").split("\n")) {
		const match = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
		if (match?.[1] === name && match[2]) return match[2];
	}
	throw new Error(`${name} is not set in .env.cloudflare.`);
}

/** cf's JSON answer to a read-only command (cf must be signed in). */
export function cf<T>(args: string[]): T {
	return JSON.parse(execFileSync("cf", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as T;
}

export function origin(name: "MINERVA_SITE_URL" | "MINERVA_DOWNLOAD_ORIGIN"): string {
	const value = process.env[name];
	if (!value?.startsWith("https://")) {
		throw new Error(`Set ${name} to the deployed Worker's https origin, in the environment or in .env.cloudflare.vars.`);
	}
	return value.replace(/\/$/, "");
}

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "1.0.0.1"]);

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

export function fetchDeployed(url: string, init: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Reply> {
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
		req.end();
	});
}
