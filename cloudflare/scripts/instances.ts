// The instances on this machine (cloudflare/README.md, The instance directory):
//
//   node scripts/instances.ts list                     each instance's name and kind, and the directory that holds them
//   node scripts/instances.ts create <name> [--test]   makes a new instance's directory (mode 700) with its instance.json
//
// `pnpm instances …` runs it. The account is recorded by the instance's first deploy, and its secrets by
// `pnpm secrets --instance <name>`. Nothing secret is printed.

import { instancesDir, listInstances } from "./instance.ts";
import { createInstance } from "./instance-files.ts";

const [command, ...args] = process.argv.slice(2);
try {
	const root = instancesDir();
	if (command === "list" && args.length === 0) {
		const instances = listInstances(root);
		console.log(instances.length ? instances.map((instance) => `${instance.name}${instance.test ? " (test)" : ""}${instance.account ? "" : ", no account recorded yet"}`).join("\n") : "No instance yet.");
		console.log(`(in ${root})`);
	} else if (command === "create" && args.length >= 1 && args.slice(1).every((arg) => arg === "--test") && !args[0]?.startsWith("-")) {
		const instance = createInstance(root, args[0] as string, args.includes("--test"));
		console.log(`Created ${instance.dir} for the ${instance.test ? "test" : "production"} instance ${instance.name}. Next: \`pnpm secrets --instance ${instance.name}\`, and its settings in ${instance.files.vars}.`);
	} else {
		console.error("Usage: instances.ts list | create <name> [--test]");
		process.exit(2);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
