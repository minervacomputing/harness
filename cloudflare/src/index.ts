// The app Worker: the API router, /assets/ and the Durable Object classes. Static assets (the
// frontend's build) answer every other path before this runs.

import { ASSETS_PREFIX, serveAsset } from "./http/assets.ts";
import type { App } from "./http/router.ts";

// The API router, and what only it uses, is loaded on the first request that needs it rather than at the
// Worker's startup, which has a CPU limit (cloudflare/README.md, Startup).
let app: Promise<App> | null = null;

function api(): Promise<App> {
	if (app === null) {
		const loading = import("./http/router.ts").then(({ createApp }) => createApp());
		app = loading;
		// A failed load is not kept, so the next request tries again (a module that failed to load stays failed in this
		// isolate: the import rejects again).
		loading.catch(() => {
			if (app === loading) app = null;
		});
	}
	return app;
}

export default {
	async fetch(request, env, ctx) {
		if (new URL(request.url).pathname.startsWith(ASSETS_PREFIX)) return serveAsset(request, env.ASSETS, { bucket: env.FILES, waitUntil: (promise) => ctx.waitUntil(promise) });
		return (await api()).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { Conversation } from "./conversation/conversation.ts";
export { Sandbox } from "./sandbox/sandbox.ts";
export { Scripts } from "./scripts/scripts.ts";
export { Workspace } from "./workspace/workspace.ts";
