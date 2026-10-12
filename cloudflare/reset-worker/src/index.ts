// The quiesced instance (scripts/reset.ts): what an instance's Worker serves while its data is reset. It
// exports no Durable Object class and has no binding, so nothing of the instance runs or writes; every
// request answers 503 until the next deploy puts the app back.

export default {
	fetch(): Response {
		return new Response("This instance is being reset. Try again in a few minutes.\n", {
			status: 503,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "600" },
		});
	},
};
