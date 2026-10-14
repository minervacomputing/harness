// The Workers' secrets live in each instance's secrets.env (scripts/instance.ts, The instance directory: mode 600,
// in a directory of mode 700 outside the checkout) and are uploaded with `cf deploy --secrets-file`. The test
// instance has its own, so its fault driver's token and its keys are not production's. The local dev server
// (`pnpm dev:offline`) reads its own in .dev.vars here (`--offline`), gitignored. This script never prints a value.
//
//   node scripts/secrets.ts generate [--instance <name> | --test | --offline]  adds any missing required secret, keeping the others
//   node scripts/secrets.ts check [--instance <name> | --test | --offline]     says which required secrets are set
//   node scripts/secrets.ts subset OUT NAME…                                 writes only these secrets to OUT, for the download Worker
//                                                                            (owner-only; the caller removes it, scripts/deploy.ts does)
//
// The instance comes from scripts/instance.ts (`chooseInstance`): --instance, then MINERVA_INSTANCE (scripts/deploy.ts
// sets it), then with --test the only test instance. Generating takes the instance's lock (scripts/run.ts) and
// replaces the file atomically.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { MIN_SETUP_KEY_LENGTH, OAUTH_APPS, clientSecretNames, connectorClientSecrets } from "../src/config.ts";
import { EncryptionKeys } from "../src/lib/encryption.ts";
import { type Instance, chooseInstance, parseInstanceArgs, readInstanceText } from "./instance.ts";
import { writeInstanceFile } from "./instance-files.ts";
import { lockInstance } from "./run.ts";

let INSTANCE: Instance | null = null;
let ARGS: string[];
try {
	const { flag, rest } = parseInstanceArgs(process.argv.slice(2));
	const TEST = rest.includes("--test");
	const OFFLINE = rest.includes("--offline");
	if (OFFLINE && (TEST || flag !== undefined)) throw new Error("--offline is the dev server's .dev.vars, not an instance's.");
	ARGS = rest.filter((arg) => arg !== "--test" && arg !== "--offline");
	// `subset` runs under scripts/deploy.ts, which names the instance in MINERVA_INSTANCE.
	if (!OFFLINE) INSTANCE = chooseInstance({ flag, test: TEST });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
// The dev server reads .dev.vars from the project (cloudflare/).
const DEV_VARS = fileURLToPath(new URL("../.dev.vars", import.meta.url));
const FILE = INSTANCE ? INSTANCE.files.secrets : DEV_VARS;
const NAME = INSTANCE ? `${INSTANCE.name}'s secrets.env` : ".dev.vars";
/** The command that generates the missing secrets. */
const GENERATE = INSTANCE ? `pnpm secrets --instance ${INSTANCE.name}` : "pnpm secrets:offline";

const REQUIRED: Record<string, () => string> = {
	// Signs and keys our own values: 50 random bytes in URL-safe base64.
	MINERVA_SECRET_KEY: () => urlsafe(50),
	// Keys for encryption at rest (src/lib/encryption.ts): `id:secret` entries, comma separated, a secret
	// being 32 random bytes in URL-safe base64; the first encrypts. A key written before step 6b (Fernet,
	// `v1:<44 characters ending in =>`) is still a valid secret, but data encrypted with Fernet is not read.
	MINERVA_ENCRYPTION_KEYS: () => `v1:${urlsafe(32)}`,
	// Signs download links; the download Worker holds it too.
	MINERVA_DOWNLOAD_KEY: () => urlsafe(32),
	// Makes its holder the instance's first admin, once (ARCHITECTURE.md: Configuration; POST /api/setup). The operator
	// reads it from this file; once claimed it opens nothing.
	MINERVA_SETUP_KEY: () => urlsafe(32),
};

// Model keys are uploaded once the steps that use them declare them in cloudflare.config.ts. A connector
// client (both names set) is declared and uploaded as soon as it is set; unset, its connectors are hidden.
// MINERVA_LARAVEL_TOKEN, the Sanctum token Laravel issues for this engine (`php artisan minerva:engine-token`), is
// declared and uploaded once set.
const PLACEHOLDERS = [
	"MINERVA_MODEL_API_KEY",
	"MINERVA_BRAVE_SEARCH_API_KEY",
	"MINERVA_LARAVEL_TOKEN",
	...OAUTH_APPS.flatMap((app) => clientSecretNames(app)),
];

function urlsafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

/** The file's values as cf reads them (dotenv's rules), so that what is checked and copied is what is uploaded. */
function parse(text: string): Map<string, string> {
	return new Map(Object.entries(parseEnv(text) as Record<string, string>));
}

/** `NAME="value"`, which reads back as the same value; a value it would change stops the write, unprinted. */
function line(name: string, value: string): string {
	if (/["\\\n\r]/.test(value)) throw new Error(`${name} in ${NAME} has a quote, a backslash or a line break, which this script does not write back: edit the file by hand.`);
	return `${name}="${value}"`;
}

/** The secrets file's text, or null when there is none; an instance's is read only if it is owner-only and no link. */
function readFile(): string | null {
	if (INSTANCE) return readInstanceText(INSTANCE, "secrets");
	return existsSync(FILE) ? readFileSync(FILE, "utf8") : null;
}

/** An owner-only file outside an instance's directory: .dev.vars, or the download Worker's subset. */
function write(path: string, lines: string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	// The mode applies only to a new file, so an existing one is narrowed first, before the secrets go in.
	if (existsSync(path)) chmodSync(path, 0o600);
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function generate(): void {
	if (INSTANCE) lockInstance(INSTANCE);
	const values = parse(readFile() ?? "");
	const added = Object.keys(REQUIRED).filter((name) => !values.get(name));
	for (const name of added) values.set(name, (REQUIRED[name] as () => string)());
	const lines = [
		`# Secrets of ${INSTANCE ? `the instance ${INSTANCE.name}` : "the local dev server (pnpm dev:offline)"} (cloudflare/). Never commit or print them.`,
		...[...values].map(([name, value]) => line(name, value)),
		"",
		"# Optional: model keys (uploaded once declared), Laravel's token and connector clients (set both names of an app):",
		...PLACEHOLDERS.filter((name) => !values.has(name)).map((name) => `# ${name}=`),
	];
	if (INSTANCE) writeInstanceFile(INSTANCE, "secrets", `${lines.join("\n")}\n`);
	else write(FILE, lines);
	console.log(added.length ? `Added ${added.join(", ")} to ${NAME}.` : "All required secrets were already set.");
}

async function check(): Promise<void> {
	const text = readFile();
	if (text === null) {
		console.error(`${NAME} is missing: run \`${GENERATE}\`.`);
		process.exit(1);
	}
	if (!INSTANCE && (statSync(FILE).mode & 0o077) !== 0) {
		console.error(`${NAME} must be readable by its owner only (chmod 600).`);
		process.exit(1);
	}
	const values = parse(text);
	const missing = Object.keys(REQUIRED).filter((name) => !values.get(name));
	for (const name of Object.keys(REQUIRED)) console.log(`${name}: ${values.get(name) ? "set" : "missing"}`);
	// A value `subset` (the download Worker's key) or `generate` could not write back stops a deploy here, before
	// anything on the account changes, rather than after the app's upload.
	try {
		for (const name of Object.keys(REQUIRED)) line(name, values.get(name) ?? "");
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
	// A setup key the Worker would never accept (src/accounts/instance.ts) is diagnosed, not regenerated:
	// `generate` fills only missing values, so a short one is replaced by hand (or deleted, then generated).
	const setupKey = values.get("MINERVA_SETUP_KEY");
	if (setupKey && setupKey.length < MIN_SETUP_KEY_LENGTH) {
		console.error(`MINERVA_SETUP_KEY in ${NAME} is shorter than ${MIN_SETUP_KEY_LENGTH} characters, so it could never claim setup: delete the line and run \`${GENERATE}\`.`);
		process.exit(1);
	}
	// A key list the Worker would refuse (a malformed entry, a duplicate id, a short secret) stops a deploy here,
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
	const values = parse(readFile() ?? "");
	const missing = names.filter((name) => !values.get(name));
	if (missing.length) {
		console.error(`Not set in ${NAME}: ${missing.join(", ")}.`);
		process.exit(1);
	}
	write(out, names.map((name) => line(name, values.get(name) as string)));
}

const [command, ...rest] = ARGS;
try {
	if (command === "generate") generate();
	else if (command === "check") await check();
	else if (command === "subset" && rest.length >= 2) subset(rest[0] as string, rest.slice(1));
	else {
		console.error("Usage: secrets.ts generate | check | subset OUT NAME... [--instance <name> | --test | --offline]");
		process.exit(2);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
