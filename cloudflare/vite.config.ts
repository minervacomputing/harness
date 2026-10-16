import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

// `vite` (mode development) runs the Worker with the account's Workers AI and AI Gateway as remote
// bindings, so it needs CLOUDFLARE_API_TOKEN and a test instance, whose gateway it uses (MINERVA_INSTANCE, or the
// only test instance: cloudflare.config.ts). `vite --mode offline` (pnpm dev:offline) needs no account: the
// Worker's mode `offline` (cloudflare.config.ts) has no AI binding and runs the fake model, and remote
// bindings are off. Only the dev server marks the process for that mode, so a build in it stops there.

/**
 * The plugin (2.0.0-beta) adds every file cloudflare.config.ts imports to the dev server's deny list, so
 * that the config is not served to a browser. One of them, src/config.ts (the settings parser), is Worker
 * code too, and the Worker's module runner then fails to load it ("Failed to load url /src/config.ts"). The
 * Worker's sources are not secrets: this lets the dev server load everything under src/ and keeps every other
 * denial (.dev.vars, .env, the config itself, .git).
 */
function workerSources(): Plugin {
	return {
		name: "minerva:worker-sources",
		apply: "serve",
		configResolved(config) {
			const resolved = config as unknown as { fsDenyGlob: (file: string) => boolean };
			const denied = resolved.fsDenyGlob;
			const sources = `${config.root}/src/`;
			resolved.fsDenyGlob = (file) => !file.startsWith(sources) && denied(file);
		},
	};
}

export default defineConfig(({ command, mode }) => {
	const offline = mode === "offline";
	// The mark is set here for a serve and for nothing else; a build in this mode stops even if the shell already
	// has the mark.
	if (offline && command !== "serve") throw new Error("Mode offline is the dev server's (pnpm dev:offline); it cannot be built or deployed.");
	if (offline) process.env.MINERVA_DEV_OFFLINE = "1";
	return {
		plugins: [cloudflare(offline ? { remoteBindings: false } : {}), workerSources()],
	};
});
