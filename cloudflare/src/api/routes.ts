// The API's Hono routes outside accounts, which the contract names but does not serve: the OAuth callback
// (flows.ts), downloads (conversations.ts), the run event stream (stream.ts) and the upload (uploads.ts). Every
// workspace route checks membership first (members.ts). The contract's routes are served by api/orpc.ts, after
// these.

import type { App } from "../http/router.ts";
import { downloadRoutes } from "./conversations.ts";
import { flowRoutes } from "./flows.ts";
import { streamRoutes } from "./stream.ts";
import { uploadRoutes } from "./uploads.ts";

export function apiRoutes(app: App): void {
	flowRoutes(app);
	downloadRoutes(app);
	streamRoutes(app);
	uploadRoutes(app);
}
