// The rules every request under /api/ meets before a route reads it (http/router.ts): CSRF by origin
// (http/csrf.ts) on every unsafe request, matched by a route or not, uploads included, with POSTs to
// Better Auth exempt; and the one JSON reader (http/body.ts): application/json only, 2.5 MB, strict
// UTF-8 and parseJson, after the session and membership.

import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { MAX_JSON_BODY, readJson } from "../../src/http/body.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { Browser, ORIGIN, installEmailLog, signedIn } from "./accounts-helpers.ts";

installEmailLog();

const REFUSED = { detail: "Cross-site request refused." };
const EVIL = "https://evil.example";

interface Account {
	browser: Browser;
	ws: string;
}

async function account(name = "ada"): Promise<Account> {
	const { browser } = await signedIn(`${name}-${uuid7().slice(-12)}@example.com`);
	return { browser, ws: (await browser.call("GET", "/api/me")).body.workspaces[0].id };
}

/** A request with exactly these headers (no Origin unless given) and the browser's cookies, if any. */
async function raw(path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit; browser?: Browser } = {}): Promise<{ status: number; body: unknown }> {
	const headers: Record<string, string> = { "CF-Connecting-IP": init.browser?.ip ?? "10.254.0.1", ...init.headers };
	if (init.browser?.cookies.size) headers.Cookie = [...init.browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.body, duplex: "half" } as RequestInit));
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Not JSON: kept as text.
	}
	return { status: response.status, body };
}

const JSON_TYPE = { "Content-Type": "application/json" };

describe("CSRF by origin", () => {
	test("a JSON route with the session cookie: only the site's origin, or same-origin without one, passes", async () => {
		const a = await account();
		const agents = `/api/workspaces/${a.ws}/agents`;
		const create = (headers: Record<string, string>) => raw(agents, { browser: a.browser, headers: { ...JSON_TYPE, ...headers }, body: JSON.stringify({ name: "A" }) });
		const refusals: [string, Record<string, string>][] = [
			["no Origin, no Sec-Fetch-Site", {}],
			["no Origin, same-site", { "Sec-Fetch-Site": "same-site" }],
			["no Origin, cross-site", { "Sec-Fetch-Site": "cross-site" }],
			["Origin null", { Origin: "null" }],
			["Origin null, same-origin", { Origin: "null", "Sec-Fetch-Site": "same-origin" }],
			["sibling origin", { Origin: "http://app.localhost", "Sec-Fetch-Site": "same-site" }],
			["other port", { Origin: "http://localhost:8787" }],
			["hostile origin", { Origin: EVIL }],
			["hostile origin, same-origin", { Origin: EVIL, "Sec-Fetch-Site": "same-origin" }],
		];
		for (const [name, headers] of refusals) expect([name, await create(headers)]).toEqual([name, { status: 403, body: REFUSED }]);
		expect((await a.browser.call("GET", agents)).body).toHaveLength(1);
		expect((await create({ Origin: ORIGIN })).status).toBe(201);
		expect((await create({ "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
		expect((await a.browser.call("GET", agents)).body).toHaveLength(3);
	});

	test("without the session cookie too: refused from another site, 401 from the site", async () => {
		const a = await account();
		const agents = `/api/workspaces/${a.ws}/agents`;
		const body = JSON.stringify({ name: "A" });
		expect(await raw(agents, { headers: { ...JSON_TYPE, Origin: EVIL }, body })).toEqual({ status: 403, body: REFUSED });
		expect(await raw(agents, { headers: JSON_TYPE, body })).toEqual({ status: 403, body: REFUSED });
		expect(await raw(agents, { headers: { ...JSON_TYPE, Origin: ORIGIN }, body })).toEqual({ status: 401, body: { detail: "Unauthorized" } });
	});

	test("a path no route matches is checked before its 404", async () => {
		const a = await account();
		for (const path of ["/api/nope", `/api/workspaces/${a.ws}/nothing/here`, "/api/csrf", "/api/workspaces/not-a-uuid/agents"]) {
			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				expect([method, path, await raw(path, { method, browser: a.browser, headers: { Origin: EVIL } })]).toEqual([method, path, { status: 403, body: REFUSED }]);
				expect([method, path, (await raw(path, { method, browser: a.browser, headers: { Origin: ORIGIN } })).status]).toEqual([method, path, 404]);
			}
		}
	});

	test("uploads are checked before the session and before the body is read, and store nothing", async () => {
		const a = await account();
		const uploads = `/api/workspaces/${a.ws}/uploads?name=a.txt`;
		const send = (headers: Record<string, string>) => raw(uploads, { browser: a.browser, headers: { "Content-Type": "application/octet-stream", ...headers }, body: "hello" });
		for (const headers of [{}, { Origin: EVIL }, { Origin: "null" }, { Origin: EVIL, "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
			expect([headers, await send(headers)]).toEqual([headers, { status: 403, body: REFUSED }]);
		}
		expect((await env.FILES.list({ prefix: `uploads/${a.ws}/` })).objects).toEqual([]);
		const sent = await send({ Origin: ORIGIN });
		expect(sent.status).toBe(201);
		const id = (sent.body as { id: string }).id;
		const remove = `/api/workspaces/${a.ws}/uploads/${id}`;
		expect(await raw(remove, { method: "DELETE", browser: a.browser, headers: { Origin: EVIL } })).toEqual({ status: 403, body: REFUSED });
		expect((await raw(remove, { method: "DELETE", browser: a.browser, headers: { Origin: ORIGIN } })).status).toBe(204);
	});

	test("POSTs to Better Auth are left to its own origin check; its other methods are ours", async () => {
		const email = `ada-${uuid7().slice(-12)}@example.com`;
		const signIn = await raw("/api/auth/sign-in/email", { headers: { ...JSON_TYPE, Origin: EVIL }, body: JSON.stringify({ email, password: "a long enough passphrase" }) });
		// Better Auth's refusal, not ours.
		expect(signIn.status).toBe(403);
		expect(signIn.body).not.toEqual(REFUSED);
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			expect([method, await raw("/api/auth/sign-out", { method, headers: { Origin: EVIL } })]).toEqual([method, { status: 403, body: REFUSED }]);
		}
	});
});

describe("JSON bodies", () => {
	test("only application/json, after membership", async () => {
		const a = await account();
		const grace = await account("grace");
		const agents = `/api/workspaces/${a.ws}/agents`;
		const body = JSON.stringify({ name: "A" });
		const cases: [string | null, number][] = [
			[null, 415],
			["text/plain", 415],
			["text/plain; charset=utf-8", 415],
			["application/x-www-form-urlencoded", 415],
			["multipart/form-data; boundary=x", 415],
			["application/problem+json", 415],
			["application/json; charset=utf-8", 201],
			["APPLICATION/JSON", 201],
		];
		for (const [type, status] of cases) {
			const headers: Record<string, string> = { Origin: ORIGIN, ...(type === null ? {} : { "Content-Type": type }) };
			const answer = await raw(agents, { browser: a.browser, headers, body });
			expect([type, answer.status], JSON.stringify(answer.body)).toEqual([type, status]);
			if (status === 415) expect(answer.body).toEqual({ detail: "Send the body as application/json." });
			// Not a member: 401 before the body's type is looked at.
			expect([type, (await raw(agents, { browser: grace.browser, headers, body })).status]).toEqual([type, 401]);
		}
	});

	test("at most 2.5 MB, declared or streamed; strict UTF-8; escaped keys read right", async () => {
		const a = await account();
		const agents = `/api/workspaces/${a.ws}/agents`;
		const headers = { ...JSON_TYPE, Origin: ORIGIN };
		const tooLarge = { status: 413, body: { detail: "The request is too large." } };
		expect(await raw(agents, { browser: a.browser, headers: { ...headers, "Content-Length": String(MAX_JSON_BODY + 1) }, body: "{}" })).toEqual(tooLarge);
		const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
		let sent = 0;
		const streamed = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ < 3) controller.enqueue(chunk);
				else controller.close();
			},
		});
		expect(await raw(agents, { browser: a.browser, headers, body: streamed })).toEqual(tooLarge);
		const unparseable = { status: 400, body: { detail: "Cannot parse request body" } };
		expect(await raw(agents, { browser: a.browser, headers, body: new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) })).toEqual(unparseable);
		expect(await raw(agents, { browser: a.browser, headers, body: '{"name":' })).toEqual(unparseable);
		const escaped = await raw(agents, { browser: a.browser, headers, body: '{"n\\u0061me": "Escaped"}' });
		expect([escaped.status, (escaped.body as { name: string }).name]).toEqual([201, "Escaped"]);
		expect(await raw(agents, { browser: a.browser, headers, body: "" })).toMatchObject({ status: 422 });
	});

	test("the reader is not misled by the runtime's escaped-key bug", async () => {
		// The runtime's JSON.parse, once it has read "\\" as a key, reads a later "\n" in the same place as "\\" (lib/json.ts).
		const shape = `probe${crypto.randomUUID().replaceAll("-", "")}`;
		JSON.parse(`{"${shape}":0,"\\\\":1}`);
		expect(Object.keys(JSON.parse(`{"${shape}":0,"\\n":1}`))[1]).toBe("\\");
		const read = await readJson(new Request(`${ORIGIN}/api/x`, { method: "POST", headers: JSON_TYPE, body: `{"${shape}":0,"\\n":1}` }));
		expect(read.ok && Object.keys(read.value as object)[1]).toBe("\n");
	});
});
