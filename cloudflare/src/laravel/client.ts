// The engine's client of Laravel (docs/plans/contract.md): oRPC's typed client of the `laravel` half of the internal
// contract, at MINERVA_LARAVEL_URL with the Sanctum token MINERVA_LARAVEL_TOKEN. Its requests are the contract's by
// construction. Leases and fact deliveries (chunk 7) are its first callers.

import { laravel } from "@minerva/contract/internal";
import { ORPCError, createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { settings } from "../config.ts";
import { readBytes } from "../http/body.ts";
import { type Json, parseJsonBytes } from "../lib/json.ts";

export type LaravelClient = JsonifiedClient<ContractRouterClient<typeof laravel>>;

/** A request to Laravel is given up after this long. */
export const LARAVEL_TIMEOUT_MS = 20_000;

/**
 * The network requests to Laravel go out on, the Worker's `fetch`, and the token they carry, MINERVA_LARAVEL_TOKEN. Platform
 * tests route both to the fake Laravel, since the objects' bindings are fixed for the run.
 */
export const LARAVEL_NETWORK: { fetch: (env: Env) => typeof fetch; token: (env: Env) => string | null } = {
	fetch: () => (input, init) => fetch(input, init),
	token: (env) => token(env),
};

/** Laravel did not answer, or answered with something other than the contract: a redirect, a proxy's page, a malformed answer. */
export class LaravelUnreachable extends Error {
	/** Whether trying again can help: not for a redirect or a 4xx, which are a misconfiguration (a wrong URL, a proxy refusing). */
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean, options?: ErrorOptions) {
		super(message, options);
		this.name = "LaravelUnreachable";
		this.retryable = retryable;
	}
}

/**
 * Whether a failed request to Laravel may be tried again (docs/plans/contract.md, Retries): no answer, a timeout or a 5xx, in
 * the contract's shape or not. A 4xx in the contract's shape is a bug or a scope error, and a redirect a misconfiguration.
 */
export function retryable(error: unknown): boolean {
	if (error instanceof LaravelUnreachable) return error.retryable;
	if (error instanceof ORPCError) return error.status >= 500;
	return false;
}

/**
 * A failed request to Laravel as the engine may log it: an error in the contract's shape by its code and status alone, since
 * its message is Laravel's text and could echo what a log must not hold; any other failure by the engine's own message.
 */
export function failureOf(error: unknown): string {
	if (error instanceof ORPCError) return `${error.code} (HTTP ${error.status})`;
	return error instanceof Error ? error.message : "no answer";
}

/** The token MINERVA_LARAVEL_TOKEN, a secret declared only where it is set (cloudflare.config.ts). */
function token(env: Env): string | null {
	const value = (env as unknown as { MINERVA_LARAVEL_TOKEN?: unknown }).MINERVA_LARAVEL_TOKEN;
	return typeof value === "string" && value ? value : null;
}

/** An answer larger than this is not one of Laravel's: the largest is a lease. */
const MAX_ANSWER = 1 << 20;

/**
 * Laravel's answer, read whole here so that whatever breaks while it arrives is classed for retrying: no answer, or one cut
 * off, can be tried again; a redirect, or a body that is not the contract's JSON, cannot unless its status is 5xx. An error's
 * body must name the status it came with, since oRPC's client takes the status from the body.
 */
async function answered(response: Response): Promise<Response> {
	if (response.status >= 300 && response.status < 400) throw new LaravelUnreachable(`Laravel redirected (HTTP ${response.status}).`, false);
	const retry = response.status >= 500;
	if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
		throw new LaravelUnreachable(`Laravel answered HTTP ${response.status} outside the contract.`, retry);
	}
	let bytes: Uint8Array | null;
	try {
		bytes = await readBytes(response, MAX_ANSWER);
	} catch (error) {
		throw new LaravelUnreachable("Laravel's answer was cut off.", true, { cause: error });
	}
	if (bytes === null) throw new LaravelUnreachable(`Laravel's answer is over ${MAX_ANSWER} bytes.`, retry);
	let body: Json;
	try {
		body = parseJsonBytes(bytes);
	} catch {
		throw new LaravelUnreachable(`Laravel answered HTTP ${response.status} with a body that is not JSON.`, retry);
	}
	if (!response.ok && (typeof body !== "object" || body === null || !("status" in body) || body.status !== response.status)) {
		throw new LaravelUnreachable(`Laravel answered HTTP ${response.status} with an error outside the contract.`, retry);
	}
	return new Response(bytes, response);
}

/**
 * The client of this engine's Laravel. Throws when MINERVA_LARAVEL_URL or MINERVA_LARAVEL_TOKEN is not set. Every answer is
 * checked against the operation's output schema, which oRPC's client does not do: a lease or an acknowledgement that is not
 * the contract's is never used (`LaravelUnreachable`, not retryable: a bug to fix, not a moment to wait out).
 */
export function laravelClient(env: Env): LaravelClient {
	const url = settings(env).laravelUrl;
	const bearer = LARAVEL_NETWORK.token(env);
	if (url === null || bearer === null) throw new Error("MINERVA_LARAVEL_URL and MINERVA_LARAVEL_TOKEN must be set for the engine to reach Laravel.");
	const network = LARAVEL_NETWORK.fetch(env);
	const client: LaravelClient = createORPCClient(
		new OpenAPILink(laravel, {
			// The contract's paths carry the version (/internal/v1/…).
			url,
			fetch: async (request, init) => {
				const headers = new Headers(request.headers);
				headers.set("Authorization", `Bearer ${bearer}`);
				headers.set("Accept", "application/json");
				const signal = AbortSignal.any([request.signal, AbortSignal.timeout(LARAVEL_TIMEOUT_MS)]);
				let response: Response;
				try {
					// Never sent on to another place: the request carries the token, and the answer may carry a credential.
					response = await network(new Request(request, { headers, signal, redirect: "manual" }), { ...init, redirect: "manual" });
				} catch (error) {
					throw new LaravelUnreachable("Laravel did not answer.", true, { cause: error });
				}
				return answered(response);
			},
		}),
	);
	const checked = async (name: keyof typeof laravel, input: unknown, options: unknown): Promise<unknown> => {
		const call = client[name] as (input: unknown, options: unknown) => Promise<unknown>;
		const value = await call(input, options);
		const result = await laravel[name]["~orpc"].outputSchema!["~standard"].validate(value);
		if (result.issues) throw new LaravelUnreachable(`Laravel's answer to ${name} is not the contract's.`, false);
		return result.value;
	};
	// The same client, each procedure's answer checked: a cast, since the names and types are the contract's own.
	return Object.fromEntries(Object.keys(laravel).map((name) => [name, (input: unknown, options?: unknown) => checked(name as keyof typeof laravel, input, options)])) as unknown as LaravelClient;
}
