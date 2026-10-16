// The local dev server without an account (`pnpm dev:offline`, README Local development): the Worker in
// local workerd with the fake model, local D1 and R2, and no remote binding. It prepares what the dev
// server reads, then runs `vite --mode offline`:
//
//   .dev.vars          fresh secrets if there are none (`secrets.ts generate --offline`; never printed)
//   .cloudflare/state  the local D1 database, with every migration applied (`cf d1 migrations apply --local`,
//                      which prints its result and then does not exit, so this stops it once the result is whole)
//
// CLOUDFLARE_API_TOKEN is dropped from the environment, so nothing here can reach the account even if one is
// set in the shell. Everything is under cloudflare/ and gitignored.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// The same id as OFFLINE_D1_ID in cloudflare.config.ts, which only names the local database for `cf d1`.
const D1_ID = "00000000-0000-4000-8000-00000000d1d1";
const PORT = process.env.PORT ?? "8787";

const env: NodeJS.ProcessEnv = { ...process.env, MINERVA_DEV_OFFLINE: "1" };
delete env.CLOUDFLARE_API_TOKEN;
delete env.CLOUDFLARE_ACCOUNT_ID;

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`\`${[command, ...args].join(" ")}\` failed (${result.status ?? result.signal}).`);
		process.exit(result.status ?? 1);
	}
}

/** Applies the migrations to the local database. `cf d1 ... --local` keeps running after it prints a JSON array of results. */
function migrate(): Promise<void> {
	const child = spawn("pnpm", ["exec", "cf", "d1", "migrations", "apply", D1_ID, "--local", "--persist-to", ".cloudflare/state", "--mode", "offline"], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	const stop = () => {
		try {
			process.kill(-(child.pid as number), "SIGKILL");
		} catch {
			// Already gone.
		}
	};
	return new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stop();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error("Applying the local migrations took more than two minutes.")), 120_000);
		child.stdout.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			output += chunk.toString();
			const start = output.search(/^\[/m);
			if (start < 0) return;
			let results: { name: string; status: string }[];
			try {
				results = JSON.parse(output.slice(start));
			} catch {
				return; // Not all of it yet.
			}
			const failed = results.filter((result) => result.status !== "\u2705");
			finish(failed.length ? new Error(`Migration ${failed.map((result) => result.name).join(", ")} failed.`) : undefined);
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`\`cf d1 migrations apply\` failed (${code}).`)));
	});
}

if (!existsSync(join(root, ".dev.vars"))) run("node", ["scripts/secrets.ts", "generate", "--offline"]);
await migrate().catch((error: Error) => {
	console.error(error.message);
	process.exit(1);
});

console.log(`\nWorker on http://127.0.0.1:${PORT}.\n`);
const server = spawn("pnpm", ["exec", "vite", "--mode", "offline", "--host", "127.0.0.1", "--port", PORT, "--strictPort"], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
