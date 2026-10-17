// The deploy gate (cloudflare/README.md, Deploy): a production build deploys only an engine CI has tested. Each
// workflow of WORKFLOWS needs a green run on main on a commit whose engine (ENGINE_PATHS) is the same as the deployed
// commit's.
//
//   node scripts/ci-gate.ts             HEAD, whose tracked files of the engine the working tree must not change
//   node scripts/ci-gate.ts <commit>    a commit alone

import { join } from "node:path";
import { CommandFailed, ROOT, run } from "./run.ts";

export const ENGINE_PATHS = ["cloudflare", "contract", ".github/workflows", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

export const FAULT_SUITES_STEP = "The fault suites";

const REPOSITORY = join(ROOT, "..");
const RUNS = 20;

type CountsRun = (runId: number) => boolean;

const WORKFLOWS: Record<string, CountsRun> = {
	"main.yml": () => true,
	"account.yml": faultSuitesPassed,
};

export interface GreenRun {
	workflow: string;
	id: number;
	sha: string;
}

function git(args: string[]): number {
	return run("git", args, { cwd: REPOSITORY, allowFailure: true }).status;
}

function gh<T>(args: string[]): T {
	return JSON.parse(run("gh", args, { cwd: REPOSITORY }).stdout) as T;
}

function faultSuitesPassed(runId: number): boolean {
	const { jobs } = gh<{ jobs: { steps: { name: string; conclusion: string }[] }[] }>(["run", "view", String(runId), "--json", "jobs"]);
	return jobs.some((job) => job.steps.some((step) => step.name === FAULT_SUITES_STEP && step.conclusion === "success"));
}

export function checkWorkingTree(): void {
	if (git(["diff", "--quiet", "HEAD", "--", ...ENGINE_PATHS]) !== 0) {
		throw new CommandFailed(`The working tree changes the engine's tracked files since HEAD (git diff HEAD -- ${ENGINE_PATHS.join(" ")}), and the deploy would build them untested: commit and push them, or revert them.`);
	}
	// The image copies container/'s directories whole, and the deploy applies every file of migrations/.
	const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--directory", "--", ...ENGINE_PATHS], { cwd: REPOSITORY }).stdout.split("\n").filter(Boolean);
	if (untracked.length) {
		throw new CommandFailed(`Untracked files under the engine's paths would reach the deploy untested (${untracked.join(", ")}): commit them, or remove or ignore them.`);
	}
}

/** The deploy's gate: the working tree is HEAD's, and CI tested HEAD's engine. Returns HEAD. */
export function gate(): string {
	checkWorkingTree();
	for (const green of greenRuns()) console.log(`${green.workflow}: run ${green.id} on ${green.sha.slice(0, 7)}`);
	return headSha();
}

/** Stops a deploy whose checkout changed since its gate: another commit, or an edit, would reach the account untested. */
export function stillGated(head: string): void {
	if (headSha() !== head) throw new CommandFailed(`HEAD moved from ${head.slice(0, 7)} during the deploy: run it again.`);
	checkWorkingTree();
}

function headSha(): string {
	return run("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY }).stdout.trim();
}

export function greenRuns(commit = "HEAD"): GreenRun[] {
	const sha = run("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: REPOSITORY }).stdout.trim();
	return Object.entries(WORKFLOWS).map(([workflow, counts]) => {
		const runs = gh<{ databaseId: number; headSha: string }[]>(["run", "list", "--workflow", workflow, "--branch", "main", "--status", "success", "--limit", String(RUNS), "--json", "databaseId,headSha"]);
		const green = runs.find((candidate) => git(["cat-file", "-e", `${candidate.headSha}^{commit}`]) === 0 && git(["diff", "--quiet", candidate.headSha, sha, "--", ...ENGINE_PATHS]) === 0 && counts(candidate.databaseId));
		if (!green) {
			throw new CommandFailed(
				`None of ${workflow}'s last ${RUNS} green runs on main tested the engine of ${sha.slice(0, 7)} (${ENGINE_PATHS.join(", ")}). Push the commit to main, run \`gh workflow run ${workflow} --ref main\`, wait for it to pass, and run \`git fetch\` if this checkout lacks the commit it ran on.`,
			);
		}
		return { workflow, id: green.databaseId, sha: green.headSha };
	});
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length > 1 || args[0]?.startsWith("-")) {
		console.error("Usage: ci-gate.ts [<commit>]");
		process.exit(2);
	}
	try {
		if (args[0] === undefined) gate();
		else for (const green of greenRuns(args[0])) console.log(`${green.workflow}: run ${green.id} on ${green.sha.slice(0, 7)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
