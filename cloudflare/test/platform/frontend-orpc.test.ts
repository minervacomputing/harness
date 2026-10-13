// The frontend's client of the contract (frontend/src/lib/orpc.ts) against the Worker: what the page gets
// for an answer, a declared refusal, a 401, a proxy's error page and a lost connection, and what it says and
// retries for each (frontend/src/lib/http.ts).

import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { uuid7 } from "../../src/lib/random.ts";
import { Browser, ORIGIN, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

interface Agent {
	id: string;
	name: string;
}
interface Call<I, O> {
	call(input: I): Promise<O>;
}
interface Frontend {
	orpc: {
		agents: {
			list: Call<{ workspaceId: string }, Agent[]>;
			delete: Call<{ workspaceId: string; agentId: string }, void>;
		};
	};
	onUnauthorized(handler: () => void): void;
	errorMessage(error: unknown): string;
	retryQuery(count: number, error: unknown): boolean;
	NetworkError: new (...args: never[]) => Error;
}

let frontend: Frontend;
let browser: Browser;
let unauthorized = 0;
/** What the page's next request meets: the Worker, a proxy's error page (HTML, or JSON cut short), no network, or a success cut short. */
let next: "worker" | "proxy" | "cut" | "network" | "lost" = "worker";

// The modules load once, as in frontend-messages.test.ts: resetting the module graph would invalidate the
// Worker's Durable Objects.
beforeAll(async () => {
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const step = next;
		next = "worker";
		if (step === "network") throw new TypeError("fetch failed");
		if (step === "lost") {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("[{"));
					controller.error(new TypeError("network error"));
				},
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
		}
		if (step === "proxy") return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
		if (step === "cut") return new Response('{"error":', { status: 503, headers: { "Content-Type": "application/json" } });
		return browser.fetch(input, init);
	});
	const [orpc, http] = await Promise.all([
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
		import("@/lib/orpc.ts"),
		// @ts-expect-error As above.
		import("@/lib/http.ts"),
	]);
	frontend = { ...orpc, ...http } as Frontend;
	frontend.onUnauthorized(() => unauthorized++);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	unauthorized = 0;
	next = "worker";
});

async function account(): Promise<{ userId: string; workspaceId: string }> {
	const signed = await signedIn(`ada-${uuid7().slice(-12)}@example.com`);
	browser = signed.browser;
	return { userId: signed.userId, workspaceId: (await browser.call("GET", "/api/me")).body.workspaces[0].id };
}

const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable("the call succeeded"), (error: unknown) => error);

test("an answer, and a declared refusal with the server's sentence that is not retried", async () => {
	const { workspaceId } = await account();
	const [agent] = await frontend.orpc.agents.list.call({ workspaceId });
	expect(agent?.name).toBe("Assistant");
	const refused = await failure(frontend.orpc.agents.delete.call({ workspaceId, agentId: agent!.id }));
	expect([frontend.errorMessage(refused), frontend.retryQuery(0, refused)]).toEqual(["Keep at least one agent.", false]);
	expect(unauthorized).toBe(0);
});

test("a 401 tells the app the session ended", async () => {
	const { userId, workspaceId } = await account();
	await env.DB.prepare(`DELETE FROM session WHERE "userId" = ?`).bind(userId).run();
	const refused = await failure(frontend.orpc.agents.list.call({ workspaceId }));
	expect([unauthorized, frontend.errorMessage(refused), frontend.retryQuery(0, refused)]).toEqual([1, "Unauthorized", false]);
});

test("a proxy's error page, readable or not, keeps its status and is told as the server's, and is retried", async () => {
	const { workspaceId } = await account();
	next = "proxy";
	const failed = await failure(frontend.orpc.agents.list.call({ workspaceId }));
	expect(failed).toMatchObject({ defined: false, status: 502 });
	expect([frontend.errorMessage(failed), frontend.retryQuery(0, failed), frontend.retryQuery(2, failed)]).toEqual([
		"Minerva is briefly unavailable, probably restarting. Try again in a moment.",
		true,
		false,
	]);
	next = "cut";
	const cut = await failure(frontend.orpc.agents.list.call({ workspaceId }));
	expect(cut).toMatchObject({ defined: false, status: 503 });
	expect(frontend.errorMessage(cut)).toBe("Minerva is briefly unavailable, probably restarting. Try again in a moment.");
});

test("a lost connection, before the answer or during it, is marked as fetch's own failure, and is retried", async () => {
	const { workspaceId } = await account();
	for (const step of ["network", "lost"] as const) {
		next = step;
		const failed = await failure(frontend.orpc.agents.list.call({ workspaceId }));
		expect([step, failed]).toEqual([step, expect.any(frontend.NetworkError)]);
		expect([frontend.errorMessage(failed), frontend.retryQuery(0, failed)]).toEqual(["The server could not be reached.", true]);
	}
	// A success with no body (a delete's 204) is read as one.
	const created = await browser.call("POST", `/api/workspaces/${workspaceId}/agents`, { name: "Second" });
	await expect(frontend.orpc.agents.delete.call({ workspaceId, agentId: created.body.id })).resolves.toBeUndefined();
});
