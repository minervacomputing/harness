// The minerva-cf-files Worker. Step 5 builds the signed download: verify the link's HMAC over the
// download origin, workspace, conversation, version, path, user and expiry (five minutes), and that the
// request's host is the download origin's, then stream the object from the workspace's bucket (FILES, or
// FILES_EU for an EU workspace) with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
// `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store` (files 11.2). Until then
// every request is 404.

export default {
	async fetch(): Promise<Response> {
		return new Response(JSON.stringify({ detail: "Not Found" }), {
			status: 404,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
			},
		});
	},
} satisfies ExportedHandler<Env>;
