// The download Worker: the download origin (ARCHITECTURE.md: Files, Downloads). It checks that a request came
// to its own origin and carries a link the app signed with MINERVA_DOWNLOAD_KEY (src/files/links.ts), then
// streams the object from the workspace's bucket (FILES, or FILES_EU for an EU workspace) as a sandboxed
// attachment (src/files/download.ts). It holds no other secret and reaches nothing else.

import { serveDownload } from "../../src/files/download.ts";

export default {
	async fetch(request, env): Promise<Response> {
		return serveDownload(request, env);
	},
} satisfies ExportedHandler<Env>;
