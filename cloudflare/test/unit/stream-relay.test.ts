// The relay's end at a stream token's expiry: what the client has not
// taken is dropped when the grant ends, also once the run's end was relayed.

import { describe, expect, test } from "vitest";
import { Relay } from "../../src/stream/relay.ts";

/** The object's socket as the relay reads it. */
class Socket extends EventTarget {
	accept(): void {}
	close(): void {}
	frame(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readAll(relay: Relay): Promise<string> {
	const reader = relay.readable.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text;
		text += value;
	}
}

describe("a relay with a grant", () => {
	test("before its expiry, relays the run to its end", async () => {
		const relay = new Relay(0, async () => null, Date.now() + 5000);
		const socket = new Socket();
		relay.attach(socket as unknown as WebSocket);
		socket.frame({ type: "delta", seq: 1, data: { text: "Hi" } });
		socket.frame({ type: "end" });
		expect(await readAll(relay)).toBe('id: 1\nevent: delta\ndata: {"text":"Hi"}\n\nevent: end\ndata: {}\n\n');
	});

	test("drops what the client has not taken when it expires, also after the run's end", async () => {
		const relay = new Relay(0, async () => null, Date.now() + 50);
		const socket = new Socket();
		relay.attach(socket as unknown as WebSocket);
		socket.frame({ type: "delta", seq: 1, data: { text: "not yet taken" } });
		socket.frame({ type: "end" });
		await sleep(80);
		expect(await readAll(relay)).toBe("");
	});

	test("an expired grant relays nothing", async () => {
		const relay = new Relay(0, async () => null, Date.now() - 1);
		const socket = new Socket();
		relay.attach(socket as unknown as WebSocket);
		socket.frame({ type: "delta", seq: 1, data: { text: "late" } });
		expect(await readAll(relay)).toBe("");
	});
});
