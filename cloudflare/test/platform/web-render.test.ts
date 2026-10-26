// The Web connector in Laravel's runs: the test build has no BROWSER binding, so the Conversation's browser port is
// replaced by test/fixtures/connectors/web/fake-browser.ts, counted per run as the port counts the binding.

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env } from "cloudflare:workers";
import type { Fact, StartRun } from "@minerva/contract/internal";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { LaravelView } from "../../src/faults/laravel.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { heldRun } from "../../src/faults/world.ts";
import { RunBrowser } from "../../src/gateway/http.ts";
import { base64 } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { type FakeScript, fakeUpstream } from "../../src/model/fake.ts";
import { FakeBrowser, captured, jpeg, rendered } from "../fixtures/connectors/web/fake-browser.ts";
import { commands, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

let browser = new FakeBrowser();
let contexts: TranscriptContext[] = [];

beforeAll(() => {
	PORTS.factory = () => ({
		...faultConversationPorts(defaultPorts),
		browser: () => new RunBrowser(browser),
		upstream: () => fakeUpstream({ input: ["text", "image"], onCall: (_call, context) => contexts.push(context) }),
	});
});

beforeEach(() => {
	browser = new FakeBrowser();
	contexts = [];
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > 15_000) throw new Error(`Timed out waiting; last: ${JSON.stringify(value)}`);
		await sleep(50);
	}
}

function settled(start: StartRun): Promise<LaravelView> {
	return until(
		() => providerOf(env, start.scope.workspace).laravelState(start.conversation),
		(state) => state.facts.some((fact) => fact.type === "run.settled" && fact.run === start.run),
	);
}

async function started(script: FakeScript, domains: string[]): Promise<StartRun> {
	const within = scope();
	const provider = providerOf(env, within.workspace);
	await provider.reset();
	const connection = uuid7();
	await provider.laravelConnection(connection, { kind: "builtin", secret: "", scopes: null, generation: 1, expiresAt: null, status: "active" });
	const start = startOf(within, {
		message: { id: uuid7(), content: JSON.stringify({ fake: script }), attachments: [] },
		authority: {
			connections: [{ id: connection, provider: "web", owner: "42", status: "active", createdAt: new Date().toISOString(), scopes: null, revision: 1, tenant: null }],
			layers: { ceiling: null, user: { restricted: true, revision: 1, grants: [{ connection, kind: "site", resource: "*", name: "", actions: ["browse"], effect: "allow" }] }, agent: null },
			policy: { revision: 1, connectors: [{ provider: "web", tenants: domains }] },
		},
	});
	await provider.laravelHold(start.run, heldRun(start));
	expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", authorized: [connection] });
	return start;
}

test("a run reads a page of a listed domain through the browser, and is refused one of another domain before anything is sent", async () => {
	browser.answer = rendered("# Owl\n\nOwls are birds.", { title: "Owl" });
	const start = await started(
		{
			turns: [
				{ tools: [{ name: "web_read_page", arguments: { url: "https://en.wikipedia.org/wiki/Owl" } }] },
				{ tools: [{ name: "web_read_page", arguments: { url: "https://example.com/" } }] },
				{ text: "Done." },
			],
		},
		["wikipedia.org"],
	);
	const state = await settled(start);
	expect(state.facts.filter((fact: Fact) => fact.type === "run.tool_call").map((fact) => fact.data)).toEqual([
		expect.objectContaining({ tool: "web_read_page", decision: "allowed", count: 1 }),
		expect.objectContaining({ tool: "web_read_page", decision: "denied", code: "POLICY_DENIED", message: "Your organization does not allow this domain." }),
	]);
	expect(browser.urls()).toEqual(["https://en.wikipedia.org/wiki/Owl"]);
	expect(state.facts.find((fact) => fact.type === "run.finished")).toMatchObject({ data: { status: "completed" } });
});

test("a cancel while the browser renders ends the run", async () => {
	let answer = () => {};
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	browser.answer = async (call) => {
		await answered;
		return rendered("# Late")(call);
	};
	const start = await started({ turns: [{ tools: [{ name: "web_read_page", arguments: { url: "https://en.wikipedia.org/wiki/Owl" } }] }, { text: "Done." }] }, ["wikipedia.org"]);
	await until(() => browser.calls.length, (count) => count === 1);
	expect(await commands.cancelRun({ scope: start.scope, conversation: start.conversation, run: start.run, reason: "cancelled" })).toEqual({ state: "cancelled" });
	const state = await settled(start);
	answer();
	expect(state.facts.find((fact) => fact.type === "run.finished")).toMatchObject({ data: { status: "cancelled" } });
	expect(browser.calls).toHaveLength(1);
});

test("a screenshot as large as the model takes reaches it whole, as an image after the record", async () => {
	const bytes = jpeg(1152 * 1024);
	browser.answer = captured(bytes);
	const start = await started({ turns: [{ tools: [{ name: "web_screenshot_page", arguments: { url: "https://en.wikipedia.org/wiki/Owl" } }] }, { text: "An owl." }] }, ["wikipedia.org"]);
	const state = await settled(start);
	expect(state.facts.find((fact) => fact.type === "run.finished")).toMatchObject({ data: { status: "completed" } });
	const result = contexts
		.at(-1)
		?.messages.filter((message) => message.role === "toolResult")
		.at(-1);
	const record = { url: "https://en.wikipedia.org/wiki/Owl", content_type: "image/jpeg", width: 1280, height: 800 };
	expect(result?.content).toEqual([
		{ type: "text", text: JSON.stringify({ items: [record], count: 1 }) },
		{ type: "image", mimeType: "image/jpeg", data: base64(bytes) },
	]);
});
