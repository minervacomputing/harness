// gateway/http.ts: ProviderHTTP over an injected fetch (backend/connectors/http.py; connectors 7.6). The
// write accounting cases of test_contract.py that need no executor, the effect table, error mapping,
// redirects, body caps and per-phase timeouts, and the call's binding (CallIo).

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { Effect } from "../../src/contracts/connectors.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import {
	CallIo,
	MAX_ERROR_BODY,
	MAX_RESPONSE_BODY,
	NotSent,
	ProgrammingError,
	ProviderHTTP,
	REFUSED_STATUSES,
	platformRefusal,
} from "../../src/gateway/http.ts";
import { refusalPage } from "../fixtures/connectors/web/fake.ts";
import { Gate, jsonResponse } from "./executor-fakes.ts";

interface Sent {
	url: string;
	method: string;
	headers: Headers;
	body: string;
	redirect: string | undefined;
	signal: AbortSignal | null | undefined;
}

/** A fetch that records what it was sent and answers with `respond`. */
function recorder(respond: (sent: Sent) => Response | Promise<Response> = () => jsonResponse(200, { ok: true })) {
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const record: Sent = { url: request.url, method: request.method, headers: request.headers, body: await request.text(), redirect: init?.redirect, signal: init?.signal };
		sent.push(record);
		return respond(record);
	};
	return { sent, fetch };
}

let clock = 1_000_000;

function setup(respond?: (sent: Sent) => Response | Promise<Response>, options: Partial<ConstructorParameters<typeof ProviderHTTP>[1]> = {}, admits = () => true) {
	const { sent, fetch } = recorder(respond);
	const io = new CallIo({ fetch, now: () => clock, admits });
	const http = new ProviderHTTP(io, { provider: "Fake", baseUrl: "https://api.fake.example/v1", headers: { Authorization: "Bearer t" }, ...options });
	return { sent, io, http };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

async function code(promise: Promise<unknown>): Promise<string> {
	const error = await caught(promise);
	if (!(error instanceof OperationError)) throw error;
	return error.code;
}

/** A body that sends `chunks`, waiting `gap` ms before each. */
function slowBody(chunks: string[], gap: number): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			await new Promise((resolve) => setTimeout(resolve, gap));
			if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
			else controller.close();
		},
	});
}

describe("requests", () => {
	test("paths join the base URL as httpx merges them, and redirects are never followed", async () => {
		const { sent, http } = setup();
		await http.request({ method: "GET", path: "/tasks", query: { project_id: "work", limit: 30, done: false, empty: null, skipped: undefined } });
		await http.request({ method: "get", path: "tasks/t1?x=1", query: { y: true } });
		await http.request({ method: "GET", path: "https://other.example/abs" });
		expect(sent.map((item) => item.url)).toEqual([
			"https://api.fake.example/v1/tasks?project_id=work&limit=30&done=false&empty=",
			"https://api.fake.example/v1/tasks/t1?x=1&y=true",
			"https://other.example/abs",
		]);
		expect(sent.map((item) => [item.method, item.redirect])).toEqual([
			["GET", "manual"],
			["GET", "manual"],
			["GET", "manual"],
		]);
		expect(sent[0]?.headers.get("authorization")).toBe("Bearer t");
	});

	test("bodies: JSON compact with non-ASCII as is, forms encoded, a set Content-Type wins", async () => {
		const { sent, http, io } = setup();
		io.openWrite(clock + 60_000);
		await http.request({ method: "POST", path: "/a", json: { name: "zażółć", n: 1 } });
		await http.request({ method: "POST", path: "/b", form: { a: "1 2", b: "&" }, mutating: false });
		await http.request({ method: "POST", path: "/c", json: {}, headers: { "Content-Type": "application/vnd.fake+json" }, mutating: false });
		expect(sent.map((item) => [item.body, item.headers.get("content-type")])).toEqual([
			['{"name":"zażółć","n":1}', "application/json"],
			["a=1+2&b=%26", "application/x-www-form-urlencoded"],
			["{}", "application/vnd.fake+json"],
		]);
		await expect(http.request({ method: "POST", path: "/d", json: {}, form: {}, mutating: false })).rejects.toThrow(ProgrammingError);
	});

	test("a redirect is an error unless asked for, and a write is never redirected", async () => {
		const { http } = setup(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
		expect(await code(http.request({ method: "GET", path: "/repo" }))).toBe("PROVIDER_FAILED");
		const redirected = await http.request({ method: "GET", path: "/repo", redirects: true });
		expect([redirected.status, redirected.headers.get("location")]).toEqual([302, "https://elsewhere.example/"]);
		await expect(http.request({ method: "POST", path: "/repo", redirects: true })).rejects.toThrow("A write is never redirected.");
		// Every 3xx is returned when asked for, with a Location or not, as httpx 0.28's `is_redirect` counts
		// them (a 304, a 300); without asking, each is an error.
		for (const status of [301, 300, 304]) {
			const bare = setup(() => new Response(null, { status }));
			expect((await bare.http.request({ method: "GET", path: "/repo", redirects: true })).status).toBe(status);
			expect(await code(bare.http.request({ method: "GET", path: "/repo" }))).toBe("PROVIDER_FAILED");
		}
	});

	test("the body comes back decoded, without the headers that described its encoding", async () => {
		const { http } = setup(() => new Response("hello", { status: 200, headers: { "content-type": "text/plain", "x-trace": "1" } }));
		const response = await http.request({ method: "GET", path: "/x" });
		expect(await response.text()).toBe("hello");
		expect([response.headers.get("content-type"), response.headers.get("x-trace"), response.headers.get("content-length")]).toEqual(["text/plain", "1", null]);
	});
});

describe("write accounting", () => {
	test("writes are only allowed in the execute step, once, with time to finish", async () => {
		const { sent, http, io } = setup();
		await expect(http.request({ method: "POST", path: "/w" })).rejects.toThrow("Provider writes are only allowed in the execute step of a mutating operation.");
		// A read sent with POST says so, and is not accounted.
		await http.request({ method: "POST", path: "/graphql", mutating: false });
		const attempt = io.openWrite(clock + 60_000);
		await http.request({ method: "PATCH", path: "/w" });
		expect([attempt.sent, attempt.effect]).toEqual([true, "applied"]);
		await expect(http.request({ method: "DELETE", path: "/w" })).rejects.toThrow("An operation may send only one provider write.");
		expect(attempt.outcome()).toBe("applied");
		expect(sent.map((item) => item.method)).toEqual(["POST", "PATCH"]);

		const late = setup();
		const short = late.io.openWrite(clock + 1999);
		const timedOut = await caught(late.http.request({ method: "PUT", path: "/w" }));
		expect(timedOut).toMatchObject({ code: "TIMED_OUT", message: "The write was not sent because its time ran out." });
		expect([short.sent, short.outcome(), late.sent.length]).toEqual([false, "not_applied", 0]);
	});

	test("a write cannot be sent after its attempt was judged", async () => {
		// test_contract.py: a task the connector left running tries to write after outcome().
		const { sent, http, io } = setup();
		const gate = new Gate();
		const attempt = io.openWrite(clock + 60_000);
		const lateWrite = gate.promise.then(() => http.request({ method: "POST", path: "/copies", json: {} }));
		expect(attempt.outcome()).toBe("not_applied");
		gate.resolve();
		await expect(lateWrite).rejects.toThrow(ProgrammingError);
		expect(sent).toEqual([]);
	});

	const statuses: [number, Effect][] = [
		[200, "applied"],
		[201, "applied"],
		[204, "applied"],
		...[...REFUSED_STATUSES].map((status): [number, Effect] => [status, "not_applied"]),
		[405, "unknown"],
		[418, "unknown"],
		[500, "unknown"],
		[502, "unknown"],
		[503, "unknown"],
		[301, "unknown"],
		[304, "unknown"],
	];

	test.each(statuses)("a write answered %i is %s", async (status, effect) => {
		const { http, io } = setup(() => new Response(status === 204 || status === 304 ? null : "{}", { status }));
		const attempt = io.openWrite(clock + 60_000);
		await http.request({ method: "POST", path: "/w" }).catch(() => {});
		expect(attempt.outcome()).toBe(effect);
	});

	test("every transport error on a write is unknown: fetch cannot tell whether anything was sent", async () => {
		for (const error of [new TypeError("fetch failed"), new TypeError("Network connection lost."), new DOMException("The operation was aborted.", "AbortError")]) {
			const { http, io } = setup(() => {
				throw error;
			});
			const attempt = io.openWrite(clock + 60_000);
			const failure = await caught(http.request({ method: "POST", path: "/w" }));
			expect(failure).toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "Fake could not be reached." });
			expect((failure as Error).cause).toBe(error);
			expect(attempt.outcome()).toBe("unknown");
		}
	});

	test("the judge is asked before the status, with the body; null goes by the status; a judge that throws leaves it unknown", async () => {
		const graphql = (body: string, status = 200) => () => new Response(body, { status });
		const judge = (_: Response, body: string): Effect | null => (body.includes("errors") ? "not_applied" : body.includes("weird") ? "unknown" : null);
		const cases: [string, number, Effect][] = [
			['{"data":{}}', 200, "applied"],
			['{"errors":[{}]}', 200, "not_applied"],
			['{"weird":1}', 200, "unknown"],
			['{"errors":[{}]}', 500, "not_applied"],
			["{}", 409, "not_applied"],
		];
		for (const [body, status, effect] of cases) {
			const { http, io } = setup(graphql(body, status), { judge });
			const attempt = io.openWrite(clock + 60_000);
			await http.request({ method: "POST", path: "/graphql" }).catch(() => {});
			expect(attempt.outcome(), `${status} ${body}`).toBe(effect);
		}
		const thrown = setup(graphql("{}"), {
			judge: () => {
				throw new Error("cannot judge");
			},
		});
		const attempt = thrown.io.openWrite(clock + 60_000);
		await expect(thrown.http.request({ method: "POST", path: "/graphql" })).rejects.toThrow("cannot judge");
		expect(attempt.outcome()).toBe("unknown");
	});

	test("a request refused before it was sent changes nothing: RUN_ENDED, and the write is not applied", async () => {
		let admit = true;
		const { sent, http, io } = setup(undefined, {}, () => admit);
		admit = false;
		expect(await caught(http.request({ method: "GET", path: "/r" }))).toBeInstanceOf(NotSent);
		const attempt = io.openWrite(clock + 60_000);
		expect(await caught(http.request({ method: "POST", path: "/w" }))).toMatchObject({ code: "RUN_ENDED", message: "This run is no longer active." });
		expect([attempt.sent, attempt.outcome()]).toEqual([true, "not_applied"]);
		await expect(http.bounded({ method: "GET", path: "/b" }, 10, new OperationError("FILE_TOO_LARGE", "x"))).rejects.toBeInstanceOf(NotSent);
		expect(sent).toEqual([]);
	});

	test("a closed call refuses every request; abort() cuts the ones in flight", async () => {
		const { sent, http, io } = setup(
			(item) =>
				new Promise<Response>((_, reject) => {
					item.signal?.addEventListener("abort", () => reject(item.signal?.reason), { once: true });
				}),
		);
		const attempt = io.openWrite(clock + 60_000);
		const inFlight = caught(http.request({ method: "POST", path: "/w" }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		io.abort();
		expect(await inFlight).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		expect(attempt.outcome()).toBe("unknown");
		io.close();
		await expect(http.request({ method: "GET", path: "/r" })).rejects.toThrow("Cannot send a request, as the client has been closed.");
		await http.close();
		await expect(http.json({ method: "GET", path: "/r" })).rejects.toThrow(ProgrammingError);
		expect(sent).toHaveLength(1);
	});
});

describe("errors", () => {
	test.each([
		[401, "CONNECTION_UNAUTHORIZED", "The Fake connection is no longer authorized."],
		[403, "PROVIDER_FORBIDDEN", "Fake refused this request for the connected account."],
		[404, "NOT_FOUND", "Fake did not find this object."],
		[429, "PROVIDER_RATE_LIMITED", "Fake is rate limiting requests. Try again later."],
		[400, "PROVIDER_REJECTED", "Fake rejected this request."],
		[422, "PROVIDER_REJECTED", "Fake rejected this request."],
		[418, "PROVIDER_REJECTED", "Fake rejected this request."],
		[500, "PROVIDER_FAILED", "Fake could not complete this request."],
		[503, "PROVIDER_FAILED", "Fake could not complete this request."],
		[302, "PROVIDER_FAILED", "Fake could not complete this request."],
	])("%i is %s", async (status, errorCode, message) => {
		const { http } = setup(() => new Response("{}", { status }));
		expect(await caught(http.request({ method: "GET", path: "/x" }))).toMatchObject({ code: errorCode, message });
	});

	test("classify names an error first, with the body; null keeps the status; forbidden words a 403", async () => {
		const classify = (provider: string, response: Response, body: string) =>
			body.includes("archived") ? new OperationError("CHANNEL_ARCHIVED", `${provider}: archived (${response.status})`) : null;
		const archived = setup(() => new Response('{"error":"archived"}', { status: 400 }), { classify });
		expect(await caught(archived.http.request({ method: "GET", path: "/x" }))).toMatchObject({ code: "CHANNEL_ARCHIVED", message: "Fake: archived (400)" });
		const other = setup(() => new Response('{"error":"other"}', { status: 404 }), { classify });
		expect(await code(other.http.request({ method: "GET", path: "/x" }))).toBe("NOT_FOUND");
		const forbidden = setup(() => new Response("{}", { status: 403 }), {
			forbidden: (provider) => ({ code: "NOT_IN_CHANNEL", message: `${provider} needs an invitation.` }),
		});
		expect(await caught(forbidden.http.request({ method: "GET", path: "/x" }))).toMatchObject({ code: "NOT_IN_CHANNEL", message: "Fake needs an invitation." });
	});

	test("the platform's own refusal of a fetch is recognisable", () => {
		const blocked = new Response("error code: 1003 ", { status: 403, headers: { server: "cloudflare" } });
		expect(platformRefusal(blocked, "error code: 1003 ")).toBe(1003);
		expect(platformRefusal(blocked, "error code: 1102")).toBe(1102);
		expect(platformRefusal(new Response("", { status: 403, headers: { server: "nginx" } }), "error code: 1003")).toBeNull();
		expect(platformRefusal(blocked, "<html>Forbidden</html>")).toBeNull();
		// The error page a request with an Accept header gets (measured on the account), only as HTML from Cloudflare.
		const page = refusalPage(1002, "name.example");
		const html = (headers: Record<string, string>) => new Response(page, { status: 403, headers });
		expect(platformRefusal(html({ server: "cloudflare", "content-type": "text/html; charset=UTF-8" }), page)).toBe(1002);
		expect(platformRefusal(html({ server: "cloudflare", "content-type": "text/plain" }), page)).toBeNull();
		expect(platformRefusal(html({ server: "nginx", "content-type": "text/html" }), page)).toBeNull();
		expect(platformRefusal(html({ server: "cloudflare", "content-type": "text/html" }), "<h1><span>Error</span> <span>1002</span></h1>")).toBeNull();
	});
});

describe("bodies", () => {
	test("json() reads with parseJson; a body that does not parse is an unexpected response", async () => {
		// After "\\" was parsed, the runtime's JSON.parse names an escaped key wrongly (lib/json.ts).
		JSON.parse('{"\\\\":1}');
		const escaped = setup(() => new Response('{"\\n":1}'));
		expect(Object.keys((await escaped.http.json({ method: "GET", path: "/x" })) as object)).toEqual(["\n"]);
		const bom = setup(() => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])));
		expect(await bom.http.json({ method: "GET", path: "/x" })).toEqual({});
		for (const body of ["<html>", "", "NaN", new Uint8Array([0x22, 0xff, 0x22])]) {
			const { http } = setup(() => new Response(body));
			expect(await caught(http.json({ method: "GET", path: "/x" }))).toMatchObject({ code: "PROVIDER_FAILED", message: "Fake returned an unexpected response." });
		}
	});

	test("parsed() refuses a body that does not fit its schema", async () => {
		const { http } = setup(() => jsonResponse(200, { id: 5 }));
		expect(await code(http.parsed({ method: "GET", path: "/x" }, z.object({ id: z.string() })))).toBe("PROVIDER_FAILED");
		const good = setup(() => jsonResponse(200, { id: "a", extra: 1 }));
		expect(await good.http.parsed({ method: "GET", path: "/x" }, z.object({ id: z.string() }))).toEqual({ id: "a" });
	});

	test("bounded() reads up to its limit; an error keeps 64 KiB and only the type and rate limit headers", async () => {
		const tooLarge = new OperationError("PAGE_TOO_LARGE", "Too large.");
		const exact = setup(() => new Response("x".repeat(10), { headers: { "content-encoding": "gzip", "content-type": "text/plain" } }));
		const response = await exact.http.bounded({ method: "GET", path: "/f" }, 10, tooLarge);
		expect([await response.text(), response.headers.get("content-encoding"), response.headers.get("content-type")]).toEqual(["x".repeat(10), null, "text/plain"]);
		const over = setup(() => new Response("x".repeat(11)));
		expect(await caught(over.http.bounded({ method: "GET", path: "/f" }, 10, tooLarge))).toBe(tooLarge);
		let seen = "";
		const failed = setup(
			() =>
				new Response("e".repeat(MAX_ERROR_BODY + 100), {
					status: 429,
					headers: { "retry-after": "30", "x-ratelimit-reset": "9", "x-secret": "no", "content-type": "text/plain" },
				}),
			{
				classify: (_, errorResponse, body) => {
					seen = `${body.length} ${[...errorResponse.headers.keys()].sort().join(",")}`;
					return null;
				},
			},
		);
		expect(await code(failed.http.bounded({ method: "GET", path: "/f" }, 10, tooLarge))).toBe("PROVIDER_RATE_LIMITED");
		expect(seen).toBe(`${MAX_ERROR_BODY} content-type,retry-after,x-ratelimit-reset`);
	});

	test("bounded() is never accounted as a write", async () => {
		const { sent, http } = setup();
		await http.bounded({ method: "POST", path: "/graphql", json: { query: "{ me }" } }, 1000, new OperationError("PAGE_TOO_LARGE", "x"));
		expect(sent.map((item) => item.method)).toEqual(["POST"]);
	});

	test("a body read in two hundred thousand chunks is joined", async () => {
		// Before: the chunks were spread into concat(), and that many arguments overflow the stack.
		const { http } = setup(() => {
			let left = 200_000;
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (left-- > 0) controller.enqueue(Uint8Array.of(0x61));
						else controller.close();
					},
				}),
			);
		});
		const body = await http.download({ method: "GET", path: "/f" }, 1_000_000);
		expect((await body.arrayBuffer()).byteLength).toBe(200_000);
	});

	test("download() says how much Minerva reads", async () => {
		const { http } = setup(() => new Response("x".repeat(101)));
		expect(await caught(http.download({ method: "GET", path: "/f" }, 100))).toMatchObject({ code: "FILE_TOO_LARGE", message: "This file is larger than Minerva reads (100 bytes)." });
	});

	test("request() caps a successful body; a write over the cap counts as applied unless a judge must read it", async () => {
		const huge = () => {
			const chunk = new Uint8Array(1024 * 1024);
			let sentBytes = 0;
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (sentBytes > MAX_RESPONSE_BODY) controller.close();
						else {
							controller.enqueue(chunk);
							sentBytes += chunk.byteLength;
						}
					},
				}),
			);
		};
		const plain = setup(huge);
		const attempt = plain.io.openWrite(clock + 60_000);
		expect(await code(plain.http.request({ method: "POST", path: "/w" }))).toBe("PROVIDER_FAILED");
		expect(attempt.outcome()).toBe("applied");
		const judged = setup(huge, { judge: () => "applied" });
		const unjudged = judged.io.openWrite(clock + 60_000);
		expect(await code(judged.http.request({ method: "POST", path: "/w" }))).toBe("PROVIDER_FAILED");
		expect(unjudged.outcome()).toBe("unknown");
	});
});

describe("timeouts", () => {
	test("each phase must arrive within the timeout: a steady slow body is fine, a stalled one is not", async () => {
		const steady = setup(() => new Response(slowBody(["a", "b", "c", "d"], 20)), { timeout: 0.05 });
		expect(await (await steady.http.request({ method: "GET", path: "/s" })).text()).toBe("abcd");
		const stalled = setup(() => new Response(slowBody(["a", "b"], 80)), { timeout: 0.05 });
		expect(await caught(stalled.http.request({ method: "GET", path: "/s" }))).toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "Fake could not be reached." });
		const silent = setup((item) => new Promise<Response>((_, reject) => item.signal?.addEventListener("abort", () => reject(item.signal?.reason))), { timeout: 0.05 });
		expect(await code(silent.http.request({ method: "GET", path: "/s" }))).toBe("PROVIDER_UNAVAILABLE");
	});

	test("a write's phases are limited by the time it has left", async () => {
		let signal: AbortSignal | null | undefined;
		const { http, io } = setup((item) => {
			signal = item.signal;
			return new Promise<Response>((_, reject) => item.signal?.addEventListener("abort", () => reject(item.signal?.reason)));
		});
		// 20 s by default, but this write has 2.05 s left: cut well before 20 s.
		const attempt = io.openWrite(clock + 2050);
		const started = performance.now();
		expect(await code(http.request({ method: "POST", path: "/w" }))).toBe("PROVIDER_UNAVAILABLE");
		expect(performance.now() - started).toBeLessThan(5000);
		expect(signal?.aborted).toBe(true);
		expect(attempt.outcome()).toBe("unknown");
	}, 10_000);
});
