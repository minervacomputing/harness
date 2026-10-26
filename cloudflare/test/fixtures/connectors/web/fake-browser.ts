// Browser Run's Quick Actions for the Web connector's tests (src/connectors/web/render.ts), answering as the binding did
// when it was measured: Markdown in a JSON envelope with the page's `meta`, or an error envelope with Browser Run's status.

import type { BrowserIo } from "../../../../src/gateway/http.ts";

export interface BrowserCall {
	action: "markdown";
	options: BrowserRunMarkdownOptions;
}

export type Answer = (call: BrowserCall) => Response | Promise<Response>;

type Meta = { status?: number; title?: string; headers?: { [name: string]: string }; finalUrl?: string | undefined; redirectChain?: { url: string; status: number }[] };

const BROWSER_MS = { "x-browser-ms-used": "412" };

export function rendered(result: string, meta: Meta = {}): Answer {
	return ({ options }) =>
		Response.json(
			{ success: true, result, meta: { status: 200, title: "", headers: { "content-type": "text/html; charset=utf-8" }, finalUrl: "url" in options ? options.url : undefined, ...meta } },
			{ headers: BROWSER_MS },
		);
}

export function refused(status: number, errors: { message: string; code?: number; detail?: string; path?: string }[]): Answer {
	return () => Response.json({ success: false, errors }, { status, headers: status < 500 ? BROWSER_MS : {} });
}

export const hangs: Answer = () => new Promise<Response>(() => {});

export const stalls: Answer = () =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"success":true,'));
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);

export function sized(bytes: number): Answer {
	return () => {
		const piece = new Uint8Array(64 * 1024).fill(0x20);
		let left = bytes;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (left <= 0) return controller.close();
					const next = piece.subarray(0, Math.min(piece.length, left));
					left -= next.length;
					controller.enqueue(next);
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	};
}

export class FakeBrowser implements BrowserIo {
	readonly calls: BrowserCall[] = [];
	answer: Answer = rendered("");

	async quickAction(action: "markdown", options: BrowserRunMarkdownOptions): Promise<Response> {
		this.calls.push({ action, options });
		return this.answer({ action, options });
	}

	urls(): (string | null)[] {
		return this.calls.map(({ options }) => ("url" in options ? options.url : null));
	}
}
