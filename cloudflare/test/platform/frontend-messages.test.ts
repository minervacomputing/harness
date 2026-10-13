// The frontend's send mutation (frontend/src/components/chat/send.ts) against the Worker, run by TanStack
// Query's own MutationObserver: one Idempotency-Key per send, the same on every repeat after a lost answer or
// a restart's answer, never repeated after a refusal, and at most two repeats, at the app's real delays. The
// client goes through the generated API client with the interceptors the app installs; the Worker has the
// fake model of the test build, wired as in chat.test.ts.

import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { CONNECTORS, CONNECTOR_SOURCE } from "../../src/connectors/index.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import { notesConnector } from "../../src/faults/connector.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";
import { Browser, ORIGIN, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

beforeAll(() => {
	CONNECTOR_SOURCE.connectors = () => [...CONNECTORS, notesConnector()];
	PORTS.factory = () => faultConversationPorts(defaultPorts);
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

type Path = { workspace_id: string; conversation_id: string };
type Posted = { run: { id: string } };
interface Send {
	key: string;
}
interface SendModule {
	newSend(path: Path, body: { content: string; attachments: string[] }): Send;
	sendMessage: object;
	SendError: new (...args: never[]) => Error & { status?: number };
}
interface Observer {
	mutate(variables: Send): Promise<Posted>;
}

let frontend: SendModule;
let observer: () => Observer;
/** The message posts the page's `fetch` sent: the key, and what became of each. */
let sent: Array<{ key: string | null; outcome: string }> = [];
/** What to do with the next posts, in order: pass through, lose the answer after the server took it, or answer 502, 503 or 504 without asking. */
let plan: Array<"pass" | "lose" | "502" | "503" | "504"> = [];
let browser: Browser;

/** The page's `fetch`: this browser's, except for the plan's faults on the message posts. */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
	if (!(request.method === "POST" && /\/messages$/.test(new URL(request.url).pathname))) return browser.fetch(request);
	const key = request.headers.get("Idempotency-Key");
	const step = plan.shift() ?? "pass";
	if (step !== "pass" && step !== "lose") {
		sent.push({ key, outcome: step });
		return new Response("<html>restarting</html>", { status: Number(step), headers: { "Content-Type": "text/html" } });
	}
	const response = await browser.fetch(request);
	sent.push({ key, outcome: step === "lose" ? "lost" : String(response.status) });
	if (step === "lose") throw new TypeError("Failed to fetch");
	return response;
}

// The modules load once: the Worker's own modules share this isolate, and resetting the module graph
// would invalidate its Durable Objects. The generated client keeps the `fetch` it finds on load.
beforeAll(async () => {
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("document", {
		get cookie() {
			return [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		},
	});
	vi.stubGlobal("fetch", pageFetch);
	const [send, generated, http, query] = await Promise.all([
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
		import("@/components/chat/send.ts"),
		// @ts-expect-error As above.
		import("@/api/client.gen.ts"),
		// @ts-expect-error As above.
		import("@/lib/http.ts"),
		// The frontend's own copy, the one its modules use.
		// @ts-expect-error As above.
		import("@/../node_modules/@tanstack/react-query"),
	]);
	generated.client.setConfig({ baseUrl: ORIGIN });
	http.installClientInterceptors(() => {});
	frontend = send as SendModule;
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
	await browser.start();
	const ws = (await browser.call("GET", "/api/me")).body.workspaces[0].id as string;
	const agent = (await browser.call("GET", `/api/workspaces/${ws}/agents`)).body[0].id as string;
	const created = await browser.call("POST", `/api/workspaces/${ws}/conversations`, { agent_id: agent });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	return { workspace_id: ws, conversation_id: created.body.id };
}

const say = (script: FakeScript) => JSON.stringify({ fake: script });
const QUICK = say({ turns: [{ text: "Hello." }] });
const runsOf = async (path: Path) => (await browser.call("GET", `/api/workspaces/${path.workspace_id}/conversations/${path.conversation_id}`)).body.runs as Array<{ id: string }>;
const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable("the send succeeded"), (error: unknown) => error as Error & { status?: number });

test("an answer lost after the server took the message is asked again with the same key and is one run", async () => {
	const path = await conversation();
	plan = ["lose"];
	const send = frontend.newSend(path, { content: QUICK, attachments: [] });
	expect(send.key).toMatch(/^[0-9a-f]{32}$/);
	const posted = await observer().mutate(send);
	expect(sent).toEqual([
		{ key: send.key, outcome: "lost" },
		{ key: send.key, outcome: "201" },
	]);
	const runs = await runsOf(path);
	expect(runs).toHaveLength(1);
	expect(posted.run.id).toBe(runs[0]!.id);
});

test("a refusal is not repeated: a message while a run is in progress is 409 once", async () => {
	const path = await conversation();
	const slow = say({ chunkChars: 1, delayMs: 50, turns: [{ text: "y".repeat(400) }] });
	await observer().mutate(frontend.newSend(path, { content: slow, attachments: [] }));
	sent = [];
	const error = await failure(observer().mutate(frontend.newSend(path, { content: QUICK, attachments: [] })));
	expect(error).toBeInstanceOf(frontend.SendError);
	expect(error.status).toBe(409);
	expect(sent).toHaveLength(1);
});

test("a proxy's or a restart's answer is repeated twice with the same key, and then the send fails", async () => {
	const path = await conversation();
	plan = ["502", "503", "504", "pass"];
	const send = frontend.newSend(path, { content: QUICK, attachments: [] });
	const started = Date.now();
	const error = await failure(observer().mutate(send));
	// After 0.4 s and then 1.2 s.
	expect(Date.now() - started).toBeGreaterThanOrEqual(1600);
	expect(error).toBeInstanceOf(frontend.SendError);
	expect(error.status).toBe(504);
	expect(error.message).toBe("Minerva is briefly unavailable, probably restarting. Try again in a moment.");
	expect(sent).toEqual(["502", "503", "504"].map((outcome) => ({ key: send.key, outcome })));
	expect(await runsOf(path)).toHaveLength(0);
});
