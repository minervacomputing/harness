// Makes CI's instance directory from the workflow's secrets:
//
//   node scripts/ci-instance.ts --instance <name>
//
// The directory exists only in GitHub's secrets (the `ci-instance` environment), so each run makes it afresh in
// MINERVA_INSTANCES_DIR, which must be absolute and must not exist yet. It reads CLOUDFLARE_ACCOUNT_ID,
// MINERVA_CI_SECRETS_ENV and MINERVA_CI_VARS_ENV from the environment, and before it writes anything prints an
// `::add-mask::` command for every value a later step's log could show (scripts/masks.ts). It prints nothing else
// of them. The instance is a test instance, recorded on that account, with those secrets and settings.

import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { instancesDir, parseInstanceArgs } from "./instance.ts";
import { createInstance, recordAccount, writeInstanceFile } from "./instance-files.ts";
import { ciMaskValues, maskCommands } from "./masks.ts";
import { lockInstance } from "./run.ts";

try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	if (flag === undefined || rest.length) {
		console.error("Usage: ci-instance.ts --instance <name>");
		process.exit(2);
	}
	const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
	const secrets = process.env.MINERVA_CI_SECRETS_ENV ?? "";
	const vars = process.env.MINERVA_CI_VARS_ENV ?? "";
	const missing = Object.entries({ CLOUDFLARE_ACCOUNT_ID: account, MINERVA_CI_SECRETS_ENV: secrets, MINERVA_CI_VARS_ENV: vars })
		.filter(([, value]) => value.trim() === "")
		.map(([name]) => name);
	if (missing.length) throw new Error(`Not set: ${missing.join(", ")} (the ci-instance environment's secrets).`);
	for (const line of maskCommands(await ciMaskValues({ account, secrets }))) console.log(line);

	const own = process.env.MINERVA_INSTANCES_DIR;
	if (!own || !isAbsolute(own)) throw new Error("MINERVA_INSTANCES_DIR must be set to an absolute path.");
	if (lstatSync(own, { throwIfNoEntry: false })) throw new Error("MINERVA_INSTANCES_DIR already exists: CI makes its instance directory afresh.");
	const created = createInstance(instancesDir(), flag, true);
	lockInstance(created);
	const instance = recordAccount(created, account.trim());
	writeInstanceFile(instance, "secrets", secrets.endsWith("\n") ? secrets : `${secrets}\n`);
	writeInstanceFile(instance, "vars", vars.endsWith("\n") ? vars : `${vars}\n`);
	console.log(`Made the test instance ${instance.name}'s directory.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
