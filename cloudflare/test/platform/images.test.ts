// Images in local workerd: a file the user attached, staged by Laravel under `uploads/<workspace>/` in the EU bucket, is
// copied into the folder by Laravel's start (startRun through the internal mount, with the fake Laravel), the agent opens
// it with pi's `read` in the conversation's container (test/platform/sandbox-memory.ts), and the model gets it as an image
// block when it takes images, or pi-ai's placeholder when it does not. An image over the model's limits is shrunk by the
// Images binding, which local workerd emulates.

import type { ImageContent, TranscriptContext } from "@earendil-works/pi-ai";
import type { RunEvent } from "@minerva/contract";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { filesBucket } from "../../src/addressing.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import { FakeLaravel } from "../../src/faults/laravel.ts";
import { faultConversationPorts } from "../../src/faults/ports.ts";
import { base64 } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { fakeUpstream, type FakeTurn } from "../../src/model/fake.ts";
import { TOOL_IMAGE_PLACEHOLDER } from "../../src/model/policy.ts";
import { IMAGE_MAX_BYTES } from "../../src/model/provider.ts";
import { commands, held, objectOf, scope, signedAssertions, startOf, viewOf } from "./internal-support.ts";
import { MemorySandbox } from "./sandbox-memory.ts";

signedAssertions();

const SANDBOXES = new Map<string, MemorySandbox>();
/** The model's requests, by conversation. */
const CONTEXTS = new Map<string, TranscriptContext[]>();
/** The conversations whose model takes text only. */
const TEXT_ONLY = new Set<string>();

let fake: FakeLaravel;
let uninstall: () => void;

beforeAll(() => {
	PORTS.factory = () => ({
		...faultConversationPorts(defaultPorts),
		sandbox: ({ conversationId }) => SANDBOXES.get(conversationId) as MemorySandbox,
		upstream: (_route, { conversationId }) =>
			fakeUpstream({
				input: TEXT_ONLY.has(conversationId) ? ["text"] : ["text", "image"],
				onCall: (_call, context) => CONTEXTS.get(conversationId)?.push(context),
			}),
	});
});

beforeEach(() => {
	fake = new FakeLaravel("test-laravel-token");
	uninstall = fake.install({ withToken: true });
});

afterEach(() => {
	for (const sandbox of SANDBOXES.values()) sandbox.release();
	uninstall();
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** An RGBA PNG of `width` by `height`, of one colour, or of noise, which does not compress. */
async function png(width: number, height: number, noise = false): Promise<Uint8Array> {
	const row = 1 + width * 4;
	const raw = new Uint8Array(row * height);
	if (noise) for (let at = 0; at < raw.length; at += 65_536) crypto.getRandomValues(raw.subarray(at, Math.min(at + 65_536, raw.length)));
	else raw.fill(0x80);
	for (let y = 0; y < height; y++) raw[y * row] = 0;
	const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
	return new Uint8Array(await new Blob(parts).arrayBuffer());
}

function world(options: { textOnly?: boolean } = {}) {
	const within = scope();
	const conversation = uuid7();
	SANDBOXES.set(conversation, new MemorySandbox(() => filesBucket(env, { id: within.workspace, jurisdiction: "eu" })));
	CONTEXTS.set(conversation, []);
	if (options.textOnly) TEXT_ONLY.add(conversation);
	return { within, conversation, contexts: CONTEXTS.get(conversation) as TranscriptContext[] };
}

type World = ReturnType<typeof world>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stages `data` as Laravel's signed PUT does, starts a run that `read`s it, and waits for the run to end. */
async function attachAndRead(w: World, name: string, data: Uint8Array): Promise<{ run: RunHead; events: RunEvent[] }> {
	const upload = `uploads/${w.within.workspace}/${uuid7()}`;
	await env.FILES_EU.put(upload, data);
	const turns: FakeTurn[] = [{ tools: [{ name: "read", arguments: { path: name } }] }, { text: "A picture." }];
	const start = held(
		fake,
		startOf(w.within, {
			conversation: w.conversation,
			message: { id: uuid7(), content: JSON.stringify({ fake: { turns } }), attachments: [{ upload, name, size: data.length, mediaType: "image/png" }] },
		}),
	);
	const answer = await commands.startRun(start);
	if (answer.outcome !== "accepted") throw new Error(`Refused: ${answer.code} ${answer.message}`);
	const stub = objectOf(start);
	const started = Date.now();
	for (;;) {
		const view = await viewOf(stub, start.run);
		if (view.head && !["queued", "provisioning", "running"].includes(view.head.status)) return { run: view.head, events: view.events };
		if (Date.now() - started > 15_000) throw new Error(`Timed out waiting; last: ${JSON.stringify(view.head)}`);
		await sleep(25);
	}
}

/** What the model got back from `read`: the content of the last tool result it was sent. */
function readResult(w: World) {
	const result = w.contexts
		.at(-1)
		?.messages.filter((message) => message.role === "toolResult")
		.at(-1);
	if (!result || result.role !== "toolResult") throw new Error("The model was sent no tool result.");
	return result;
}

function cards(events: RunEvent[]) {
	return events.filter((event) => event.type === "local_tool").map((event) => event.data as { tool: string; ok: boolean; excerpt: string });
}

describe("an attached image", () => {
	test("read by the agent, reaches a model that takes images as an image block", async () => {
		const w = world();
		const image = await png(64, 48);
		const { run, events } = await attachAndRead(w, "photo.png", image);
		expect(run.status).toBe("completed");
		expect(JSON.stringify(w.contexts[0]?.messages)).toContain("[The user attached photo.png to this message, in your folder.]");
		const blocks = readResult(w).content.filter((block) => block.type === "image");
		expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: base64(image) } satisfies ImageContent]);
		expect(cards(events)).toEqual([{ tool: "read", summary: "photo.png", ok: true, excerpt: "[image]" }]);
	});

	test("a model that takes text only gets pi-ai's placeholder instead", async () => {
		const w = world({ textOnly: true });
		const { run } = await attachAndRead(w, "photo.png", await png(64, 48));
		expect(run.status).toBe("completed");
		const content = readResult(w).content;
		expect(content.some((block) => block.type === "image")).toBe(false);
		expect(content).toContainEqual({ type: "text", text: TOOL_IMAGE_PLACEHOLDER });
	});

	test("one as large as the model takes is kept in the transcript, and the turn goes on", async () => {
		const w = world();
		// About 1.2 MB, 1.6 MB of base64.
		const image = await png(540, 540, true);
		expect(4 * Math.ceil(image.length / 3)).toBeGreaterThan(IMAGE_MAX_BYTES * 0.9);
		const { run } = await attachAndRead(w, "large.png", image);
		expect(run.status).toBe("completed");
		expect(readResult(w).content.filter((block) => block.type === "image")).toHaveLength(1);
	});

	test("one larger than the model takes is shrunk by Cloudflare Images to fit", async () => {
		const w = world();
		// About 5.8 MB.
		const { run, events } = await attachAndRead(w, "huge.png", await png(1200, 1200, true));
		expect(run.status).toBe("completed");
		const [block, ...more] = readResult(w).content.filter((part) => part.type === "image");
		expect(more).toEqual([]);
		expect(block).toMatchObject({ type: "image", mimeType: "image/webp" });
		expect((block as ImageContent).data.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
		expect(cards(events)).toMatchObject([{ tool: "read", ok: true }]);
	});
});
