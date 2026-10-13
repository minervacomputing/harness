import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { chooseInstance } from "../../../scripts/instance.ts";

// The code-mode lab (test/account/scripts.test.ts): code mode's real objects (src/scripts/) behind a
// stand-in conversation with fake tools, deployed as a test instance's lab (`<name>-cm`, scripts/instance.ts:
// MINERVA_INSTANCE, which scripts/deploy.ts --lab sets, or the only test instance) only while its account tests
// run, then deleted (cloudflare/README.md, Code mode's lab). It holds no data and no secret but its own driver
// token (CM_TOKEN, in the instance's cm.env).
export default defineConfig(() => ({
	worker: {
		name: chooseInstance({ test: true }).names.lab,
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
}));
