// Chrome's failure to start, as the browser walk reports it (browser.test.ts): without the hosts of the instance's
// Workers, which name its account's workers.dev subdomain. No side effects, so the unit tests import it
// (test/unit/account-origins.test.ts).

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
