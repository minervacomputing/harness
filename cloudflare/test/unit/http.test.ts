import { describe, expect, test } from "vitest";
import { readJson } from "../../src/http/body.ts";
import { errorAnswer, noRoute, unauthorized } from "../../src/http/errors.ts";
import { DEFAULT_CSP, withSecurityHeaders } from "../../src/http/headers.ts";
import { createApp } from "../../src/http/router.ts";
import { settingsEnv } from "./settings.ts";

const SITE = "https://minerva.example";

describe("error shapes", () => {
	test("a refusal is the contract's: declared, its code with the code's status, and a sentence", async () => {
		const response = errorAnswer("CONVERSATION_BUSY", "Wait for the current answer to finish, or stop it.");
		expect([response.status, response.headers.get("Cache-Control"), await response.json()]).toEqual([
			409,
			"no-store",
			{ defined: true, code: "CONVERSATION_BUSY", status: 409, message: "Wait for the current answer to finish, or stop it." },
		]);
		const missing = noRoute();
		expect([missing.status, await missing.json()]).toEqual([404, { defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }]);
		const anonymous = unauthorized();
		expect([anonymous.status, await anonymous.json()]).toEqual([401, { defined: true, code: "UNAUTHORIZED", status: 401, message: "Unauthorized" }]);
	});
});

describe("security headers", () => {
	test("set on API responses, with the CSP only as a default", () => {
		const plain = withSecurityHeaders(new Response("x"));
		expect(plain.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
		expect(plain.headers.get("X-Frame-Options")).toBe("DENY");
		expect(plain.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
		expect(plain.headers.get("Cache-Control")).toBe("no-store");
		const download = withSecurityHeaders(
			new Response("x", { headers: { "Content-Security-Policy": "sandbox", "Cache-Control": "private, no-store" } }),
		);
		expect(download.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(download.headers.get("Cache-Control")).toBe("private, no-store");
	});

	test("copies a response whose headers are immutable", () => {
		const fetched = Response.redirect("https://minerva.example/", 302);
		const out = withSecurityHeaders(fetched);
		expect(out.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(out.status).toBe(302);
	});
});

describe("JSON bodies", () => {
	const LIMIT = 4096;
	const request = (body: BodyInit, headers: Record<string, string> = { "Content-Type": "application/json" }) => new Request(`${SITE}/api/x`, { method: "POST", body, headers });

	test("parses JSON sent as application/json, with or without parameters; an empty body is undefined", async () => {
		expect(await readJson(request('{"a":1}'), LIMIT)).toEqual({ ok: true, value: { a: 1 } });
		expect(await readJson(request('{"a":1}', { "Content-Type": "Application/JSON ; charset=utf-8" }), LIMIT)).toEqual({ ok: true, value: { a: 1 } });
		expect(await readJson(request(""), LIMIT)).toEqual({ ok: true, value: undefined });
	});

	test("refuses every other type with 415", async () => {
		for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/problem+json", "application/jsonx", "application/json, text/plain"]) {
			const read = await readJson(request('{"a":1}', type === null ? {} : { "Content-Type": type }), LIMIT);
			expect(read, String(type)).toEqual({ ok: false, refusal: { code: "UNSUPPORTED_MEDIA_TYPE", detail: "Send the body as application/json." } });
		}
	});

	test("refuses what does not parse, or is not UTF-8, with 400", async () => {
		for (const body of ["{nope", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
			expect(await readJson(request(body), LIMIT)).toEqual({ ok: false, refusal: { code: "INVALID_JSON", detail: "The body is not valid JSON." } });
		}
	});

	test("refuses a declared or streamed body over the limit with 413", async () => {
		const tooLarge = { ok: false, refusal: { code: "PAYLOAD_TOO_LARGE", detail: "The request is too large." } };
		expect(await readJson(request("{}", { "Content-Type": "application/json", "Content-Length": String(LIMIT + 1) }), LIMIT)).toEqual(tooLarge);
		expect(await readJson(request(`"${"x".repeat(LIMIT)}"`), LIMIT)).toEqual(tooLarge);
		expect(await readJson(request(`"${"x".repeat(LIMIT - 2)}"`), LIMIT)).toMatchObject({ ok: true });
	});
});

describe("router", () => {
	const env = settingsEnv() as unknown as Env;

	test("a missing route is 404 NOT_FOUND, with the security headers", async () => {
		for (const path of ["/api/nope", "/api/me/", "/api/workspaces/not-a-uuid/agents", "/api/csrf"]) {
			const response = await createApp().request(path, { method: "POST", headers: { Origin: SITE } }, env);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
			expect(response.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
		}
	});
});
