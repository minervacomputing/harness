// The frontend's way of sending a message (frontend/src/lib/messages.ts) against the Worker: one
// Idempotency-Key per send, reused when the same send is repeated after an answer was lost or a restart
// answered, and never repeated after a refusal. The client goes through the generated API client with
// the interceptors the app installs; the Worker has the fake model of the test build, wired as in chat.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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

type Result = { error?: unknown; response?: Response; data?: { run: { id: string; status: string }; message: { id: string } } };
interface Messages {
	newSendKey(): string;
	sendMessage(options: { path: { workspace_id: string; conversation_id: string }; body: { content: string; attachments?: string[] }; key: string }): Promise<Result>;
	SEND_RETRY: { delaysMs: number[] };
}

let messages: Messages;
/** What sign-out calls once the server has ended the session. */
let endSession: () => void;
/** The message posts the page's `fetch` sent: the key, and what became of each. */
let sent: Array<{ key: string | null; outcome: string }> = [];
/** What to do with the next posts, in order: pass through, lose the answer after the server took it, or answer 502 or 503 without asking. */
let plan: Array<"pass" | "lose" | "503" | "502"> = [];
let browser: Browser;

/** The page's `fetch`: this browser's, except for the plan's faults on the message posts. */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
	if (!(request.method === "POST" && /\/messages$/.test(new URL(request.url).pathname))) return browser.fetch(request);
	const key = request.headers.get("Idempotency-Key");
	const step = plan.shift() ?? "pass";
	if (step === "503" || step === "502") {
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
	// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
	const [lib, generated, http, session] = await Promise.all([import("@/lib/messages.ts"), import("@/api/client.gen.ts"), import("@/lib/http.ts"), import("@/lib/session.ts")]);
	generated.client.setConfig({ baseUrl: ORIGIN });
	http.installClientInterceptors(() => {});
	messages = lib as Messages;
	endSession = session.noteSessionEnded;
});

afterAll(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	sent = [];
	plan = [];
	messages.SEND_RETRY.delaysMs = [5, 5];
});

interface Account {
	browser: Browser;
	ws: string;
	conversation: string;
}

async function account(): Promise<Account> {
	const signed = await signedIn(`ada-${uuid7().slice(-12)}@example.com`);
	browser = signed.browser;
	await browser.start();
	const ws = (await browser.call("GET", "/api/me")).body.workspaces[0].id as string;
	const agent = (await browser.call("GET", `/api/workspaces/${ws}/agents`)).body[0].id as string;
	const created = await browser.call("POST", `/api/workspaces/${ws}/conversations`, { agent_id: agent });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	return { browser, ws, conversation: created.body.id };
}

const say = (script: FakeScript) => JSON.stringify({ fake: script });
const QUICK = say({ turns: [{ text: "Hello." }] });
const path = (a: Account) => ({ workspace_id: a.ws, conversation_id: a.conversation });
const runsOf = async (a: Account) => (await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${a.conversation}`)).body.runs as Array<{ id: string }>;

describe("the key", () => {
	test("is a fresh valid key for every send, and is on the request", async () => {
		const keys = new Set(Array.from({ length: 50 }, () => messages.newSendKey()));
		expect(keys.size).toBe(50);
		for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);

		const a = await account();
		const key = messages.newSendKey();
		const sentOnce = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key });
		expect(sentOnce.response?.status, JSON.stringify(sentOnce.error)).toBe(201);
		expect(sent).toEqual([{ key, outcome: "201" }]);
	});
});

describe("repeating a send", () => {
	test("an answer lost after the server took the message is asked again with the same key and is one run", async () => {
		const a = await account();
		plan = ["lose"];
		const key = messages.newSendKey();
		const result = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key });
		expect(result.response?.status, JSON.stringify(result.error)).toBe(201);
		expect(sent).toEqual([
			{ key, outcome: "lost" },
			{ key, outcome: "201" },
		]);
		const runs = await runsOf(a);
		expect(runs).toHaveLength(1);
		expect(result.data?.run.id).toBe(runs[0]!.id);
	});

	test("a restart's 503 or a proxy's 502 is repeated with the same key", async () => {
		const a = await account();
		plan = ["503", "502"];
		const key = messages.newSendKey();
		const result = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key });
		expect(result.response?.status).toBe(201);
		expect(sent.map((entry) => [entry.key, entry.outcome])).toEqual([
			[key, "503"],
			[key, "502"],
			[key, "201"],
		]);
		expect(await runsOf(a)).toHaveLength(1);
	});

	test("gives up after the delays and answers with the last failure", async () => {
		const a = await account();
		plan = ["503", "503", "503", "503"];
		const result = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key: messages.newSendKey() });
		expect(result.response?.status).toBe(503);
		expect(sent).toHaveLength(3);
		expect(await runsOf(a)).toHaveLength(0);
	});

	test("a send waiting to be repeated is dropped when the user signs out meanwhile", async () => {
		const a = await account();
		plan = ["503", "pass"];
		messages.SEND_RETRY.delaysMs = [60, 60];
		const pending = messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key: messages.newSendKey() });
		for (let waited = 0; sent.length < 1 && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(sent.map((entry) => entry.outcome)).toEqual(["503"]);
		endSession();
		const result = await pending;
		// Not sent again, under no session or the next user's: the caller gets the failure it had.
		expect(result.response?.status).toBe(503);
		expect(sent).toHaveLength(1);
		expect(await runsOf(a)).toHaveLength(0);
	});

	test("a refusal is not repeated: a message while a run is in progress is 409 once", async () => {
		const a = await account();
		const slow = say({ chunkChars: 1, delayMs: 50, turns: [{ text: "y".repeat(400) }] });
		const first = await messages.sendMessage({ path: path(a), body: { content: slow, attachments: [] }, key: messages.newSendKey() });
		expect(first.response?.status).toBe(201);
		sent = [];
		const busy = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key: messages.newSendKey() });
		expect(busy.response?.status).toBe(409);
		expect(sent).toHaveLength(1);
	});

	test("another send is another key, so the same words sent twice are two runs", async () => {
		const a = await account();
		const one = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key: messages.newSendKey() });
		expect(one.response?.status).toBe(201);
		// The first run must finish before the next message is taken.
		for (let waited = 0; waited < 100 && (await runsOf(a)).length === 1 && !(await settled(a)); waited++) await new Promise((resolve) => setTimeout(resolve, 100));
		const two = await messages.sendMessage({ path: path(a), body: { content: QUICK, attachments: [] }, key: messages.newSendKey() });
		expect(two.response?.status).toBe(201);
		expect(new Set(sent.map((entry) => entry.key)).size).toBe(2);
		expect(two.data?.run.id).not.toBe(one.data?.run.id);
	});
});

async function settled(a: Account): Promise<boolean> {
	const runs = (await a.browser.call("GET", `/api/workspaces/${a.ws}/conversations/${a.conversation}`)).body.runs as Array<{ status: string }>;
	return runs.every((run) => !["queued", "provisioning", "running"].includes(run.status));
}
