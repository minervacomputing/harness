// The Workers' secrets live in ../.env.cloudflare at the repository root (gitignored, mode 600) and are
// uploaded with `cf deploy --secrets-file`. The test Worker (minerva-cf-test) has its own, in
// ../.env.cloudflare-test (`--test`), so its fault driver's token and its keys are not production's. This
// script never prints a value.
//
//   node scripts/secrets.ts generate [--test]          adds any missing required secret, keeping the others
//   node scripts/secrets.ts check [--test]             says which required secrets are set
//   node scripts/secrets.ts subset OUT NAME…           writes only these secrets to OUT, for the download Worker

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST = process.argv.includes("--test");
const NAME = TEST ? ".env.cloudflare-test" : ".env.cloudflare";
const FILE = fileURLToPath(new URL(`../../${NAME}`, import.meta.url));

const REQUIRED: Record<string, () => string> = {
	// Signs and keys our own values (as Django's SECRET_KEY: secrets.token_urlsafe(50)).
	MINERVA_SECRET_KEY: () => urlsafe(50),
	// Fernet keys for credentials at rest, `version:key`, comma separated; the first encrypts.
	MINERVA_ENCRYPTION_KEYS: () => `v1:${randomBytes(32).toString("base64url")}=`,
	// Signs download links; the download Worker holds it too.
	MINERVA_DOWNLOAD_KEY: () => urlsafe(32),
};

// Uploaded once the steps that use them declare them in cloudflare.config.ts.
const PLACEHOLDERS = [
	"MINERVA_MODEL_API_KEY",
	"MINERVA_BRAVE_SEARCH_API_KEY",
	...["TODOIST", "GOOGLE", "GITHUB", "NOTION", "LINEAR", "SLACK", "MICROSOFT", "HUBSPOT", "JIRA", "CONFLUENCE", "INTERCOM", "XERO", "SENTRY"].flatMap(
		(app) => [`MINERVA_${app}_CLIENT_ID`, `MINERVA_${app}_CLIENT_SECRET`],
	),
];

function urlsafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function read(path: string): Map<string, string> {
	const values = new Map<string, string>();
	if (!existsSync(path)) return values;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, name = "", raw = ""] = match;
		values.set(name, raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
	}
	return values;
}

function write(path: string, lines: string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function generate(): void {
	const values = read(FILE);
	const added = Object.keys(REQUIRED).filter((name) => !values.get(name));
	for (const name of added) values.set(name, (REQUIRED[name] as () => string)());
	const lines = [
		`# Secrets of the ${TEST ? "minerva-cf-test Worker" : "minerva-cf Workers"} (cloudflare/). Never commit or print them.`,
		...[...values].map(([name, value]) => `${name}="${value}"`),
		"",
		"# Placeholders, uploaded once the steps that use them declare them:",
		...PLACEHOLDERS.filter((name) => !values.has(name)).map((name) => `# ${name}=`),
	];
	write(FILE, lines);
	console.log(added.length ? `Added ${added.join(", ")} to ${NAME}.` : "All required secrets were already set.");
}

function check(): void {
	if (!existsSync(FILE)) {
		console.error(`${NAME} is missing: run \`pnpm secrets${TEST ? ":test" : ""}\`.`);
		process.exit(1);
	}
	if ((statSync(FILE).mode & 0o077) !== 0) {
		console.error(`${NAME} must be readable by its owner only (chmod 600).`);
		process.exit(1);
	}
	const values = read(FILE);
	const missing = Object.keys(REQUIRED).filter((name) => !values.get(name));
	for (const name of Object.keys(REQUIRED)) console.log(`${name}: ${values.get(name) ? "set" : "missing"}`);
	if (missing.length) process.exit(1);
}

function subset(out: string, names: string[]): void {
	const values = read(FILE);
	const missing = names.filter((name) => !values.get(name));
	if (missing.length) {
		console.error(`Not set in ${NAME}: ${missing.join(", ")}.`);
		process.exit(1);
	}
	write(out, names.map((name) => `${name}="${values.get(name)}"`));
}

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--test");
if (command === "generate") generate();
else if (command === "check") check();
else if (command === "subset" && rest.length >= 2) subset(rest[0] as string, rest.slice(1));
else {
	console.error("Usage: secrets.ts generate | check | subset OUT NAME...");
	process.exit(2);
}
