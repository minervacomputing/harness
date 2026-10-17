// What a unit of work runs before its commit (`pnpm check`, cloudflare/README.md, Checks): the checks main.yml runs, then
// the account test files the unit changed, on the test instance after a deploy of the test build. Changed means against
// the merge base with origin/main, committed or not, untracked files included. The steps run in order and stop at the
// first failure, which prints the end of its output.
//
//   pnpm check [--instance <name>]   the test instance: --instance, then MINERVA_INSTANCE, then the only test instance

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chooseInstance, parseInstanceArgs } from "./instance.ts";
import { ROOT, redact, run } from "./run.ts";

interface Step {
	name: string;
	command: string;
	args: string[];
	cwd: string;
}

const REPOSITORY = join(ROOT, "..");
const CONTRACT = join(REPOSITORY, "contract");
const ACCOUNT = "test/account/";
const PERF = ["perf.test.ts", "retention-measure.test.ts", "retention-perf.test.ts"];
const TAIL = 80;

type Check = "skip-probe" | "skip-lab" | "deployed" | "faults-file" | "helper";

function checkOf(file: string): Check {
	const name = file.slice(ACCOUNT.length);
	if (PERF.includes(name)) return "skip-probe";
	if (name === "scripts.test.ts" || name.startsWith("scripts-worker/")) return "skip-lab";
	if (name === "deployed.test.ts") return "deployed";
	return name.endsWith(".test.ts") ? "faults-file" : "helper";
}

function changedAccountFiles(): string[] {
	const git = (...args: string[]) => run("git", args, { cwd: REPOSITORY }).stdout.split("\n").filter(Boolean);
	const [base] = git("merge-base", "HEAD", "origin/main");
	// Deleted and renamed files count, by their old names too: a helper's deletion still runs the suites.
	const paths = new Set([...git("diff", "--name-only", "--no-renames", base), ...git("ls-files", "--others", "--exclude-standard")]);
	return [...paths]
		.filter((path) => path.startsWith(`cloudflare/${ACCOUNT}`))
		.map((path) => path.slice("cloudflare/".length))
		.sort();
}

function execute(step: Step): Promise<{ status: number; output: string }> {
	return new Promise((resolve) => {
		// MINERVA_PERF=1 would make test:faults run only the probes.
		const { MINERVA_PERF: _, ...env } = process.env;
		const child = spawn(step.command, step.args, { cwd: step.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("error", (error) => resolve({ status: 127, output: String(error) }));
		child.on("close", (code) => resolve({ status: code ?? 1, output }));
	});
}

const steps: Step[] = [
	{ name: "contract types", command: "pnpm", args: ["typecheck"], cwd: CONTRACT },
	{ name: "contract OpenAPI documents", command: "pnpm", args: ["openapi:check"], cwd: CONTRACT },
	{ name: "engine types", command: "pnpm", args: ["typecheck"], cwd: ROOT },
	{ name: "unit tests", command: "pnpm", args: ["test:unit"], cwd: ROOT },
	{ name: "platform tests", command: "pnpm", args: ["test:platform"], cwd: ROOT },
];
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	if (rest.length) {
		console.error(`Unknown arguments: ${rest.join(" ")}. Usage: check.ts [--instance <name>]`);
		process.exit(2);
	}
	const changed = Map.groupBy(changedAccountFiles(), checkOf);
	const probes = changed.get("skip-probe") ?? [];
	const lab = changed.get("skip-lab") ?? [];
	if (probes.length) console.log(`Not run: ${probes.join(", ")}. Run a probe by hand with MINERVA_PERF=1 (cloudflare/README.md, The test Worker).`);
	if (lab.length) console.log(`Not run: ${lab.join(", ")}. Code mode's rows need its lab: pnpm run deploy:cm, then pnpm test:cm.`);
	const exists = (file: string) => existsSync(join(ROOT, file));
	const whole = changed.has("helper");
	const files = whole ? [] : (changed.get("faults-file") ?? []).filter(exists);
	const faults = whole || files.length > 0;
	const deployed = whole || (changed.get("deployed") ?? []).some(exists);
	if (deployed || faults) {
		const on = ["--instance", chooseInstance({ flag, test: true }).name];
		steps.push({ name: `deploy:test ${on.join(" ")}`, command: "pnpm", args: ["run", "deploy:test", ...on], cwd: ROOT });
		if (deployed) steps.push({ name: "test:deployed", command: "pnpm", args: ["test:deployed", ...on], cwd: ROOT });
		if (faults) steps.push({ name: ["test:faults", ...files].join(" "), command: "pnpm", args: ["test:faults", ...on, ...files], cwd: ROOT });
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

for (const step of steps) {
	process.stdout.write(`${step.name} … `);
	const started = performance.now();
	const { status, output } = await execute(step);
	const seconds = Math.round((performance.now() - started) / 1000);
	if (status !== 0) {
		console.log(`failed after ${seconds} s (exit ${status}). The last ${TAIL} lines of its output:`);
		console.log(redact(output.trimEnd().split("\n").slice(-TAIL).join("\n")));
		process.exit(1);
	}
	console.log(`${seconds} s`);
}
console.log("The full account suites run once per chunk, in account.yml, before a deploy (gh workflow run account.yml --ref main).");
