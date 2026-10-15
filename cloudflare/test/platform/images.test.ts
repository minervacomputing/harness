// Images in local workerd: a file the user attached is copied into the folder by the real start protocol, the
// agent opens it with pi's `read` in the conversation's container (test/platform/sandbox-memory.ts), and the
// model gets it as an image block when it takes images, or pi-ai's placeholder when it does not. An image over
// the model's limits is shrunk by the Images binding, which local workerd emulates.

import type { ImageContent, TranscriptContext } from "@earendil-works/pi-ai";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { conversationObject, filesBucket, workspaceObject } from "../../src/addressing.ts";
import type { RunEvent } from "../../src/conversation/events.ts";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { RunHead } from "../../src/conversation/store.ts";
import type { Conversation, Workspace } from "../../src/faults/index.ts";
import { faultConversationPorts, faultWorkspacePorts } from "../../src/faults/ports.ts";
import { setUpWorkspace } from "../../src/faults/routes.ts";
import { receiveUpload, type UploadRecorder } from "../../src/files/uploads.ts";
import { base64 } from "../../src/lib/bytes.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { fakeUpstream, type FakeTurn } from "../../src/model/fake.ts";
import { TOOL_IMAGE_PLACEHOLDER } from "../../src/model/policy.ts";
import { IMAGE_MAX_BYTES } from "../../src/model/provider.ts";
import type { Caller, RunId, WorkspaceRef } from "../../src/shared/rpc.ts";
import { WORKSPACE_PORTS } from "../../src/workspace/workspace.ts";
import { MemorySandbox } from "./sandbox-memory.ts";

const USER = "0199a000-0000-7000-8000-00000000a1e5";
const CALLER: Caller = { userId: USER, role: "owner" };
const SANDBOXES = new Map<string, MemorySandbox>();
/** The model's requests, by conversation. */
const CONTEXTS = new Map<string, TranscriptContext[]>();
/** The conversations whose model takes text only. */
const TEXT_ONLY = new Set<string>();

type ConversationStub = DurableObjectStub<Conversation>;

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
	WORKSPACE_PORTS.factory = (deps, ctx, workerEnv) => faultWorkspacePorts(deps, ctx, workerEnv);
});

afterEach(() => {
	for (const sandbox of SANDBOXES.values()) sandbox.release();
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

async function world(options: { textOnly?: boolean } = {}) {
	const ref: WorkspaceRef = { id: uuid7(), jurisdiction: null };
	const { agentId } = await setUpWorkspace(env, ref, USER);
	const ws = () => workspaceObject(env, ref) as unknown as DurableObjectStub<Workspace>;
	const created = await ws().createConversation(CALLER, agentId);
	if (!created.ok) throw new Error(created.refusal.detail);
	const conversationId = created.value.id;
	SANDBOXES.set(conversationId, new MemorySandbox(() => filesBucket(env, ref)));
	CONTEXTS.set(conversationId, []);
	if (options.textOnly) TEXT_ONLY.add(conversationId);
	const conversation = () => conversationObject(env, ref, conversationId) as unknown as ConversationStub;
	const recorder: UploadRecorder = {
		reserveUpload: (caller, upload) => ws().reserveUpload(caller, upload),
		completeUpload: (caller, id, stored) => ws().completeUpload(caller, id, stored),
		abandonUpload: (caller, id) => ws().abandonUpload(caller, id),
	};
	return {
		get conversation() {
			return conversation();
		},
		contexts: CONTEXTS.get(conversationId) as TranscriptContext[],
		async upload(name: string, data: Uint8Array): Promise<string> {
			const outcome = await receiveUpload(recorder, filesBucket(env, ref), CALLER, { name, size: data.length, body: new Response(data).body as ReadableStream<Uint8Array> });
			if (!outcome.ok) throw new Error(outcome.refusal.detail);
			return outcome.value.id;
		},
	};
}

type World = Awaited<ReturnType<typeof world>>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settled(w: World, runId: RunId): Promise<RunHead> {
	const started = Date.now();
	for (;;) {
		const run = (await w.conversation.getRun(CALLER, runId)) as RunHead | null;
		if (run && !["queued", "provisioning", "running"].includes(run.status)) return run;
		if (Date.now() - started > 15_000) throw new Error(`Timed out waiting; last: ${JSON.stringify(run)}`);
		await sleep(25);
	}
}

/** Posts `turns` for the fake with `name` attached, and waits for the run to end. */
async function attachAndRead(w: World, name: string, data: Uint8Array): Promise<{ run: RunHead; events: RunEvent[] }> {
	const id = await w.upload(name, data);
	const turns: FakeTurn[] = [{ tools: [{ name: "read", arguments: { path: name } }] }, { text: "A picture." }];
	const posted = await w.conversation.postMessage(CALLER, { content: JSON.stringify({ fake: { turns } }), attachments: [id] });
	if (!posted.ok) throw new Error(posted.refusal.detail);
	const run = await settled(w, posted.value.run.id);
	const events = (await w.conversation.getRunEvents(CALLER, run.id, { after: 0, upTo: 1_000_000, limit: 1000 })) ?? [];
	return { run, events };
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
		const w = await world();
		const image = await png(64, 48);
		const { run, events } = await attachAndRead(w, "photo.png", image);
		expect(run.status).toBe("completed");
		expect(JSON.stringify(w.contexts[0]?.messages)).toContain("[The user attached photo.png to this message, in your folder.]");
		const blocks = readResult(w).content.filter((block) => block.type === "image");
		expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: base64(image) } satisfies ImageContent]);
		expect(cards(events)).toEqual([{ tool: "read", summary: "photo.png", ok: true, excerpt: "[image]" }]);
	});

	test("a model that takes text only gets pi-ai's placeholder instead", async () => {
		const w = await world({ textOnly: true });
		const { run } = await attachAndRead(w, "photo.png", await png(64, 48));
		expect(run.status).toBe("completed");
		const content = readResult(w).content;
		expect(content.some((block) => block.type === "image")).toBe(false);
		expect(content).toContainEqual({ type: "text", text: TOOL_IMAGE_PLACEHOLDER });
	});

	test("one as large as the model takes is kept in the transcript, and the turn goes on", async () => {
		const w = await world();
		// About 1.2 MB, 1.6 MB of base64.
		const image = await png(540, 540, true);
		expect(4 * Math.ceil(image.length / 3)).toBeGreaterThan(IMAGE_MAX_BYTES * 0.9);
		const { run } = await attachAndRead(w, "large.png", image);
		expect(run.status).toBe("completed");
		expect(readResult(w).content.filter((block) => block.type === "image")).toHaveLength(1);
	});

	test("one larger than the model takes is shrunk by Cloudflare Images to fit", async () => {
		const w = await world();
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
