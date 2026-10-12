// The Workers' secrets live in ../.env.cloudflare at the repository root (gitignored, mode 600) and are
// uploaded with `cf deploy --secrets-file`. The test Worker (minerva-cf-test) has its own, in
// ../.env.cloudflare-test (`--test`), so its fault driver's token and its keys are not production's. The
// local dev server (`pnpm dev:offline`) reads its own in .dev.vars here (`--offline`), gitignored like the
// others. This script never prints a value.
//
//   node scripts/secrets.ts generate [--test|--offline]  adds any missing required secret, keeping the others
//   node scripts/secrets.ts check [--test|--offline]     says which required secrets are set
//   node scripts/secrets.ts subset OUT NAME…           writes only these secrets to OUT, for the download Worker

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OAUTH_APPS, clientSecretNames, connectorClientSecrets } from "../src/config.ts";
import { EncryptionKeys } from "../src/lib/encryption.ts";

const TEST = process.argv.includes("--test");
const OFFLINE = process.argv.includes("--offline");
if (TEST && OFFLINE) throw new Error("--test and --offline are different targets.");
const NAME = OFFLINE ? ".dev.vars" : TEST ? ".env.cloudflare-test" : ".env.cloudflare";
// The dev server reads .dev.vars from the project (cloudflare/); the deployed Workers' files are at the repository root.
const FILE = fileURLToPath(new URL(OFFLINE ? `../${NAME}` : `../../${NAME}`, import.meta.url));

const REQUIRED: Record<string, () => string> = {
	// Signs and keys our own values (as Django's SECRET_KEY: secrets.token_urlsafe(50)).
	MINERVA_SECRET_KEY: () => urlsafe(50),
	// Keys for encryption at rest (src/lib/encryption.ts): `id:secret` entries, comma separated, a secret
	// being 32 random bytes in URL-safe base64; the first encrypts. A key written before step 6b (Fernet,
	// `v1:<44 characters ending in =>`) is still a valid secret, but data encrypted with Fernet is not read.
	MINERVA_ENCRYPTION_KEYS: () => `v1:${urlsafe(32)}`,
	// Signs download links; the download Worker holds it too.
	MINERVA_DOWNLOAD_KEY: () => urlsafe(32),
	// Makes its holder the instance's first admin, once (plan: Configuration; POST /api/setup). The operator
	// reads it from this file; once claimed it opens nothing.
	MINERVA_SETUP_KEY: () => urlsafe(32),
};

// Model keys are uploaded once the steps that use them declare them in cloudflare.config.ts. A connector
// client (both names set) is declared and uploaded as soon as it is set; unset, its connectors are hidden.
const PLACEHOLDERS = [
	"MINERVA_MODEL_API_KEY",
	"MINERVA_BRAVE_SEARCH_API_KEY",
	...OAUTH_APPS.flatMap((app) => clientSecretNames(app)),
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
		`# Secrets of the ${OFFLINE ? "local dev server (pnpm dev:offline)" : TEST ? "minerva-cf-test Worker" : "minerva-cf Workers"} (cloudflare/). Never commit or print them.`,
		...[...values].map(([name, value]) => `${name}="${value}"`),
		"",
		"# Optional: model keys (uploaded once declared) and connector clients (set both names of an app):",
		...PLACEHOLDERS.filter((name) => !values.has(name)).map((name) => `# ${name}=`),
	];
	write(FILE, lines);
	console.log(added.length ? `Added ${added.join(", ")} to ${NAME}.` : "All required secrets were already set.");
}

async function check(): Promise<void> {
	if (!existsSync(FILE)) {
		console.error(`${NAME} is missing: run \`pnpm secrets${OFFLINE ? ":offline" : TEST ? ":test" : ""}\`.`);
		process.exit(1);
	}
	if ((statSync(FILE).mode & 0o077) !== 0) {
		console.error(`${NAME} must be readable by its owner only (chmod 600).`);
		process.exit(1);
	}
	const values = read(FILE);
	const missing = Object.keys(REQUIRED).filter((name) => !values.get(name));
	for (const name of Object.keys(REQUIRED)) console.log(`${name}: ${values.get(name) ? "set" : "missing"}`);
	// A key list the Worker would refuse (a JSON list, a duplicate id, a short secret) stops a deploy here,
	// with the Worker's own message, which never holds a secret.
	const keys = values.get("MINERVA_ENCRYPTION_KEYS");
	if (keys) {
		try {
			await EncryptionKeys.parse(keys);
		} catch (error) {
			console.error((error as Error).message);
			process.exit(1);
		}
	}
	let clients: string[] = [];
	try {
		clients = connectorClientSecrets(Object.fromEntries(values));
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
	const apps = OAUTH_APPS.filter((app) => clients.includes(clientSecretNames(app)[0]));
	console.log(`Connector clients: ${apps.length ? apps.join(", ") : "none"}`);
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

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--test" && arg !== "--offline");
if (command === "generate") generate();
else if (command === "check") await check();
else if (command === "subset" && rest.length >= 2) subset(rest[0] as string, rest.slice(1));
else {
	console.error("Usage: secrets.ts generate | check | subset OUT NAME...");
	process.exit(2);
}
