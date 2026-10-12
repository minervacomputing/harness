// The minerva-cf Worker: the API router, /assets/ and the Durable Object classes. Static assets (the
// frontend's build) answer every other path before this runs.

import { ASSETS_PREFIX, serveAsset } from "./http/assets.ts";
import { createApp } from "./http/router.ts";

const app = createApp();

export default {
	fetch(request, env, ctx) {
		if (new URL(request.url).pathname.startsWith(ASSETS_PREFIX)) return serveAsset(request, env.ASSETS);
		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

export { Conversation } from "./conversation/conversation.ts";
export { Sandbox } from "./sandbox/sandbox.ts";
export { Scripts } from "./scripts/scripts.ts";
export { Workspace } from "./workspace/workspace.ts";
