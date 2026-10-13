// Runs an account suite against an instance (cloudflare/README.md, Checks):
//
//   node scripts/suite.ts faults   [--instance <name>] [vitest arguments…]   the test instance's fault suites (`pnpm test:faults`)
//   node scripts/suite.ts browser  [--instance <name>] [vitest arguments…]   the browser walk (`pnpm test:browser`)
//   node scripts/suite.ts cm       [--instance <name>] [vitest arguments…]   code mode's lab (`pnpm test:cm`)
//   node scripts/suite.ts deployed --instance <name>   [vitest arguments…]   any instance, as deployed (`pnpm test:deployed`)
//
// vitest takes no flag of ours, so the instance chosen here (scripts/instance.ts, `chooseInstance`: --instance,
// then MINERVA_INSTANCE, then for a test instance's suite the only test instance) goes to it in MINERVA_INSTANCE,
// where each suite chooses it again. A test instance's suite refuses a production instance, and `deployed` needs
// the name. The suite runs on the instance's recorded account (scripts/run.ts, pinAccount, which records none),
// in CLOUDFLARE_ACCOUNT_ID, so that any cf command of the suite goes there.

import { spawnSync } from "node:child_process";
import { chooseInstance, parseInstanceArgs } from "./instance.ts";
import { ROOT, pinAccount } from "./run.ts";

const SUITES: Record<string, { config: string; test: boolean }> = {
	faults: { config: "vitest.faults.config.ts", test: true },
	browser: { config: "vitest.browser.config.ts", test: true },
	cm: { config: "vitest.cm.config.ts", test: true },
	deployed: { config: "vitest.deployed.config.ts", test: false },
};

const [name = "", ...args] = process.argv.slice(2);
const suite = SUITES[name];
if (!suite) {
	console.error(`Usage: suite.ts ${Object.keys(SUITES).join(" | ")} [--instance <name>] [vitest arguments…]`);
	process.exit(2);
}
let instance: string;
let rest: string[];
try {
	const parsed = parseInstanceArgs(args);
	rest = parsed.rest;
	const chosen = chooseInstance({ flag: parsed.flag, test: suite.test });
	pinAccount([ROOT], [], chosen, { record: false });
	instance = chosen.name;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", suite.config, ...rest], { cwd: ROOT, stdio: "inherit", env: { ...process.env, MINERVA_INSTANCE: instance } });
process.exit(result.status ?? 1);
