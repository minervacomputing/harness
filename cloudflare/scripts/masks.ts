// What CI's instance must not show in a public Actions log (docs/plans/ci-account-suites.md, The job), as GitHub
// Actions `::add-mask::` commands: GitHub then replaces each value with *** in every later step's output. Pure
// apart from the fault token's HMAC, so that a unit test checks it (test/unit/ci-masks.test.ts).

import { parseEnv } from "node:util";
import { faultsToken } from "../src/faults/token.ts";
import { envValues } from "./run.ts";

/** The instance's values that a log could show, as the workflow's secrets give them. */
export interface CiValues {
	/** CLOUDFLARE_ACCOUNT_ID. */
	account: string;
	/** The text of the instance's secrets.env. */
	secrets: string;
	/** The text of the instance's vars.env. */
	vars: string;
}

/**
 * Every value to mask: the account id; each secret, in both of `envValues`'s readings; the fault driver's token
 * that the suites derive from MINERVA_SECRET_KEY and send; and the two origins, their hosts and the workers.dev
 * subdomain. Shorter secrets than 8 characters are none of ours and would only mask unrelated output.
 */
export async function ciMaskValues(values: CiValues): Promise<string[]> {
	const found = [values.account.trim()];
	found.push(...envValues(values.secrets).filter((value) => value.length >= 8));
	const secretKey = (parseEnv(values.secrets) as Record<string, string>).MINERVA_SECRET_KEY;
	if (secretKey) found.push(await faultsToken(secretKey));
	const vars = parseEnv(values.vars) as Record<string, string>;
	for (const origin of [vars.MINERVA_SITE_URL, vars.MINERVA_DOWNLOAD_ORIGIN]) {
		const url = URL.parse(origin ?? "");
		if (!url) continue;
		found.push(origin as string, url.origin, url.hostname);
		const labels = url.hostname.split(".");
		if (labels.length >= 4 && url.hostname.endsWith(".workers.dev")) found.push(labels[labels.length - 3] as string);
	}
	return [...new Set(found.filter((value) => value !== ""))];
}

/**
 * The `::add-mask::` commands for these values. A command is one line, so a value is masked line by line, with
 * the workflow command escapes for `%`, CR and LF (none remains once split, but a lone CR may).
 */
export function maskCommands(values: string[]): string[] {
	const lines = values.flatMap((value) => value.split("\n")).filter((line) => line.trim() !== "");
	return [...new Set(lines)].map((line) => `::add-mask::${line.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
}
