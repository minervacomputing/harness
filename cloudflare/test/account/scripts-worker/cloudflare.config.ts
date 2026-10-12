import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The code-mode lab (test/account/scripts.test.ts): code mode's real objects (src/scripts/) behind a
// stand-in conversation with fake tools, deployed as minerva-cf-cm only while its account tests run, then
// deleted (cloudflare/README.md, Code mode). It holds no data and no secret but its own driver token
// (CM_TOKEN, in ../.env.cloudflare-cm at the repository root, which is gitignored).
export default defineConfig({
	worker: {
		name: "minerva-cf-cm",
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		workersDev: true,
		previewUrls: false,
		observability: { enabled: true },
		env: {
			LOADER: bindings.workerLoader(),
			CM_TOKEN: bindings.secret(),
		},
		exports: {
			Lab: exports.durableObject({ storage: "sqlite" }),
			Scripts: exports.durableObject({ storage: "sqlite" }),
			ScriptsKeep: exports.durableObject({ storage: "sqlite" }),
			ScriptsViaHost: exports.durableObject({ storage: "sqlite" }),
			ScriptsViaHostKeep: exports.durableObject({ storage: "sqlite" }),
			ScriptHost: exports.worker(),
			// An earlier lab's class, retired.
			ScriptsDirect: exports.durableObject({ state: "deleted" }),
		},
	},
});
