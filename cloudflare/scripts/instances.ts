// The instances on this machine (cloudflare/README.md, The instance directory):
//
//   node scripts/instances.ts list                     each instance's name and kind, and the directory that holds them
//   node scripts/instances.ts create <name> [--test]   makes a new instance's directory (mode 700) with its instance.json
//   node scripts/instances.ts prune <name>             drops what nothing reads any more from an instance's directory
//
// `pnpm instances …` runs it. The account is recorded by the instance's first deploy, and its secrets by
// `pnpm secrets --instance <name>`. Nothing secret is printed.

import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { SETTING_NAMES } from "./build-settings.ts";
import { INSTANCE_SECRETS, type Instance, instancesDir, listInstances, readInstance, readInstanceText } from "./instance.ts";
import { createInstance, writeInstanceFile } from "./instance-files.ts";
import { lockInstance } from "./run.ts";

/** What each env file keeps: the secrets scripts/secrets.ts knows, and the settings a build reads. */
const KEPT = {
	secrets: new Set<string>([...INSTANCE_SECRETS.required, ...INSTANCE_SECRETS.optional]),
	vars: new Set(SETTING_NAMES),
};

/** The file the deploys wrote before D1's identity row replaced it. */
const DEPLOYED_JSON = "deployed.json";

/** `NAME=…` or `export NAME=…`, commented out or not. */
const ASSIGNMENT = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

interface Pruned {
	text: string;
	/** The names whose assignments were dropped. */
	dropped: string[];
	/** The names dropped only from lines commented out, which held no value. */
	commented: string[];
}

/**
 * `text` without the lines that assign a name `keep` lacks, commented out or not; every other line stays as it is.
 * It works line by line, so it stops before judging any line when a value has a line break (as every value across
 * lines has), an assignment does not read alone as the whole file reads it (a name given twice, or one the parser
 * names otherwise), or a line it takes for a comment the parser reads as more, alone or in the file: no line of a
 * value is kept, dropped or named on its own.
 */
function pruneEnv(text: string, keep: ReadonlySet<string>, file: string): Pruned {
	const whole = parseEnv(text) as Record<string, string>;
	const unreadable = new Error(`${file} has a line that does not read on its own (a value across lines, say): edit it by hand.`);
	if (Object.values(whole).some((value) => value.includes("\n"))) throw unreadable;
	const assigned = new Set<string>();
	const lines = text.split("\n").map((line) => {
		const alone = Object.entries(parseEnv(line) as Record<string, string>);
		const assignment = ASSIGNMENT.exec(line);
		if (!assignment || assignment[1] !== undefined) {
			// A blank line or a comment, as the parser reads it too.
			if (alone.length || !(line.trim() === "" || line.trimStart().startsWith("#"))) throw unreadable;
			return assignment ? { line, name: assignment[2] as string, commented: true } : { line };
		}
		const name = assignment[2] as string;
		if (assigned.has(name) || alone.length !== 1 || alone[0]?.[0] !== name || alone[0][1] !== whole[name]) throw unreadable;
		assigned.add(name);
		return { line, name, commented: false };
	});
	// The parser reads some lines differently in the whole file than alone: a name only the whole file has stops it too.
	if (Object.keys(whole).some((name) => !assigned.has(name))) throw unreadable;
	const dropped = new Set<string>();
	const commented = new Set<string>();
	const kept = lines.filter((entry) => {
		if (entry.name === undefined || keep.has(entry.name)) return true;
		(entry.commented ? commented : dropped).add(entry.name);
		return false;
	});
	const pruned = kept.map((entry) => entry.line).join("\n");
	// And without the dropped lines, the file must read as the kept part of what it read before.
	const after = Object.entries(parseEnv(pruned) as Record<string, string>);
	if (after.length !== kept.filter((entry) => entry.name !== undefined && !entry.commented).length || after.some(([name, value]) => !keep.has(name) || whole[name] !== value)) throw unreadable;
	return { text: pruned, dropped: [...dropped].sort(), commented: [...commented].filter((name) => !dropped.has(name)).sort() };
}

/**
 * Drops from the instance's secrets.env and vars.env every line of a name nothing reads any more (13b's retired
 * secrets, the connectors' clients, the old origins and sign-up settings), and a leftover deployed.json. Both files
 * are checked before either is written; each write is atomic, under the instance's lock, and running it again changes
 * nothing. Only names are printed.
 */
function prune(instance: Instance): void {
	lockInstance(instance);
	const changes = (["secrets", "vars"] as const).flatMap((file) => {
		const text = readInstanceText(instance, file);
		if (text === null) return [];
		const pruned = pruneEnv(text, KEPT[file], instance.files[file]);
		return pruned.dropped.length || pruned.commented.length ? [{ file, ...pruned }] : [];
	});
	const deployed = join(instance.dir, DEPLOYED_JSON);
	const stats = lstatSync(deployed, { throwIfNoEntry: false });
	if (stats?.isDirectory()) throw new Error(`${deployed} is a directory: nothing was changed.`);
	for (const change of changes) writeInstanceFile(instance, change.file, change.text);
	if (stats) rmSync(deployed);

	const report = changes.map(({ file, dropped, commented }) => {
		const names = [...(dropped.length ? [dropped.join(", ")] : []), ...(commented.length ? [`commented out, ${commented.join(", ")}`] : [])];
		return `Dropped from ${instance.files[file]}: ${names.join("; ")}.`;
	});
	if (stats) report.push(`Removed ${deployed}.`);
	console.log(report.length ? report.join("\n") : `${instance.name}'s directory has nothing to prune.`);
}

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
	} else if (command === "prune" && args.length === 1 && !args[0]?.startsWith("-")) {
		prune(readInstance(root, args[0] as string));
	} else {
		console.error("Usage: instances.ts list | create <name> [--test] | prune <name>");
		process.exit(2);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
