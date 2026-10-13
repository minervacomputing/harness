// The JSON API's routes outside accounts: agents, connectors, connections and
// access, the OAuth callback (flows.ts), conversations, runs and files (conversations.ts), the run event
// stream (stream.ts), the upload (uploads.ts), and the demo's off answers. Every workspace route checks
// membership first (members.ts).

import type { App } from "../http/router.ts";
import { agentRoutes } from "./agents.ts";
import { connectionRoutes } from "./connections.ts";
import { conversationRoutes } from "./conversations.ts";
import { demoRoutes } from "./demo.ts";
import { flowRoutes } from "./flows.ts";
import { streamRoutes } from "./stream.ts";
import { uploadRoutes } from "./uploads.ts";

export function apiRoutes(app: App): void {
	demoRoutes(app);
	agentRoutes(app);
	connectionRoutes(app);
	flowRoutes(app);
	conversationRoutes(app);
	streamRoutes(app);
	uploadRoutes(app);
}
