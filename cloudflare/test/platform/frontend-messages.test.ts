// The frontend's send mutation (frontend/src/components/chat/send.ts) against the Worker, run by TanStack
// Query's own MutationObserver through the contract's client (frontend/src/lib/orpc.ts): one Idempotency-Key
// per send, the same on every repeat after a lost answer or a proxy's answer, never repeated after one of our
// refusals (START_FAILED included), and at most two repeats, at the app's real delays. The Worker has the fake
// model of the test build, wired as in chat.test.ts.

import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";
import { Browser, ORIGIN, contractError, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

beforeAll(() => {
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

type Path = { workspaceId: string; conversationId: string };
type Posted = { run: { id: string } };
interface Send {
	headers: { "idempotency-key": string };
}
interface SendModule {
	newSend(path: Path, body: { content: string; attachments: string[] }): Send;
	sendMessage: object;
	refused(error: unknown): boolean;
}
interface Observer {
	mutate(variables: Send): Promise<Posted>;
}

let frontend: SendModule & { errorMessage(error: unknown): string };
let observer: () => Observer;
/** The message posts the page's `fetch` sent: the key, and what became of each. */
let sent: Array<{ key: string | null; outcome: string }> = [];
/**
 * What to do with the next posts, in order: pass through, lose the answer after the server took it, answer 502, 503 or 504 as a
 * proxy would without asking, or answer our server's declared START_FAILED without asking.
 */
let plan: Array<"pass" | "lose" | "502" | "503" | "504" | "start-failed"> = [];
let browser: Browser;

/** The page's `fetch`: this browser's, except for the plan's faults on the message posts. */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	// The link sends a Request; one made from it here would take its body.
	const request = input instanceof Request ? input : new Request(input, init);
	if (!(request.method === "POST" && /\/messages$/.test(new URL(request.url).pathname))) return browser.fetch(request, init);
	const key = request.headers.get("Idempotency-Key");
	const step = plan.shift() ?? "pass";
	if (step === "start-failed") {
		sent.push({ key, outcome: step });
		return Response.json(contractError("START_FAILED", "The agent could not finish this run. Try again."), { status: 503 });
	}
	if (step !== "pass" && step !== "lose") {
		sent.push({ key, outcome: step });
		return new Response("<html>restarting</html>", { status: Number(step), headers: { "Content-Type": "text/html" } });
	}
	const response = await browser.fetch(request, init);
	sent.push({ key, outcome: step === "lose" ? "lost" : String(response.status) });
	if (step === "lose") throw new TypeError("Failed to fetch");
	return response;
}

// The modules load once: the Worker's own modules share this isolate, and resetting the module graph
// would invalidate its Durable Objects. The link calls the global `fetch` on each request.
beforeAll(async () => {
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("fetch", pageFetch);
	const [send, http, query] = await Promise.all([
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
		import("@/components/chat/send.ts"),
		// @ts-expect-error As above.
		import("@/lib/http.ts"),
		// The frontend's own copy, the one its modules use.
		// @ts-expect-error As above.
		import("@/../node_modules/@tanstack/react-query"),
	]);
	frontend = { ...(send as SendModule), errorMessage: http.errorMessage };
	observer = () => new query.MutationObserver(new query.QueryClient(), frontend.sendMessage);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	sent = [];
	plan = [];
});

async function conversation(): Promise<Path> {
	const signed = await signedIn(`ada-${uuid7().slice(-12)}@example.com`);
	browser = signed.browser;
	const workspaceId = (await browser.call("GET", "/api/me")).body.workspaces[0].id as string;
	const agentId = (await browser.call("GET", `/api/workspaces/${workspaceId}/agents`)).body[0].id as string;
	const created = await browser.call("POST", `/api/workspaces/${workspaceId}/conversations`, { agentId });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	return { workspaceId, conversationId: created.body.id };
}

const say = (script: FakeScript) => JSON.stringify({ fake: script });
const QUICK = say({ turns: [{ text: "Hello." }] });
const runsOf = async ({ workspaceId, conversationId }: Path) =>
	(await browser.call("GET", `/api/workspaces/${workspaceId}/conversations/${conversationId}`)).body.runs as Array<{ id: string }>;
const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable("the send succeeded"), (error: unknown) => error);

test("an answer lost after the server took the message is asked again with the same key and is one run", async () => {
	const path = await conversation();
	plan = ["lose"];
	const send = frontend.newSend(path, { content: QUICK, attachments: [] });
	const key = send.headers["idempotency-key"];
	expect(key).toMatch(/^[0-9a-f]{32}$/);
	const posted = await observer().mutate(send);
	expect(sent).toEqual([
		{ key, outcome: "lost" },
		{ key, outcome: "201" },
	]);
	const runs = await runsOf(path);
	expect(runs).toHaveLength(1);
	expect(posted.run.id).toBe(runs[0]!.id);
});

test("our refusal is not repeated, and gives the message back: a message while a run is in progress is 409 once", async () => {
	const path = await conversation();
	const slow = say({ chunkChars: 1, delayMs: 50, turns: [{ text: "y".repeat(400) }] });
	await observer().mutate(frontend.newSend(path, { content: slow, attachments: [] }));
	sent = [];
	const error = await failure(observer().mutate(frontend.newSend(path, { content: QUICK, attachments: [] })));
	expect(error).toMatchObject({ defined: true, code: "CONVERSATION_BUSY", status: 409 });
	expect([frontend.refused(error), sent.length]).toEqual([true, 1]);
});

test("a declared START_FAILED is not repeated either, and gives the message back", async () => {
	const path = await conversation();
	plan = ["start-failed"];
	const error = await failure(observer().mutate(frontend.newSend(path, { content: QUICK, attachments: [] })));
	expect([frontend.refused(error), frontend.errorMessage(error), sent.length]).toEqual([true, "The agent could not finish this run. Try again.", 1]);
});

test("a proxy's or a restart's answer is repeated twice with the same key, and then the send fails", async () => {
	const path = await conversation();
	plan = ["502", "503", "504", "pass"];
	const send = frontend.newSend(path, { content: QUICK, attachments: [] });
	const started = Date.now();
	const error = await failure(observer().mutate(send));
	// After 0.4 s and then 1.2 s.
	expect(Date.now() - started).toBeGreaterThanOrEqual(1600);
	expect(error).toMatchObject({ defined: false, status: 504 });
	// Not given back: the server may have started the run.
	expect(frontend.refused(error)).toBe(false);
	expect(frontend.errorMessage(error)).toBe("Minerva is briefly unavailable, probably restarting. Try again in a moment.");
	expect(sent).toEqual(["502", "503", "504"].map((outcome) => ({ key: send.headers["idempotency-key"], outcome })));
	expect(await runsOf(path)).toHaveLength(0);
});
