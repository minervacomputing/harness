// The API's Hono routes outside accounts: connectors, connections and access, the OAuth callback (flows.ts),
// downloads (conversations.ts), the run event stream (stream.ts) and the upload (uploads.ts). Every workspace
// route checks membership first (members.ts). The contract's routes (agents, conversations, runs and the
// uploads' deletion so far) are served by api/orpc.ts, after these.

import type { App } from "../http/router.ts";
import { connectionRoutes } from "./connections.ts";
import { downloadRoutes } from "./conversations.ts";
import { flowRoutes } from "./flows.ts";
import { streamRoutes } from "./stream.ts";
import { uploadRoutes } from "./uploads.ts";

export function apiRoutes(app: App): void {
	connectionRoutes(app);
	flowRoutes(app);
	downloadRoutes(app);
	streamRoutes(app);
	uploadRoutes(app);
}
