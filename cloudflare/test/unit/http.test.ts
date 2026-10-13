import { describe, expect, test } from "vitest";
import { z } from "zod";
import { serveAsset } from "../../src/http/assets.ts";
import { MAX_JSON_BODY, readJson } from "../../src/http/body.ts";
import { fromSite } from "../../src/http/csrf.ts";
import { errorAnswer, notFound, refused, unauthorized, validationError, validationItems } from "../../src/http/errors.ts";
import { DEFAULT_CSP, withSecurityHeaders } from "../../src/http/headers.ts";
import { OWN_SIZE_LIMIT, UPLOAD_ROUTE, createApp } from "../../src/http/router.ts";
import { settingsEnv } from "./settings.ts";

const SITE = "https://minerva.example";

function post(headers: Record<string, string>, url = `${SITE}/api/x`, method = "POST"): Request {
	return new Request(url, { method, headers });
}

describe("CSRF", () => {
	test("safe methods pass", () => {
		for (const method of ["GET", "HEAD", "OPTIONS"]) expect(fromSite(post({ Origin: "https://evil.example" }, undefined, method), SITE), method).toBe(true);
	});

	test("an Origin must be the site's exactly, whatever Sec-Fetch-Site says", () => {
		expect(fromSite(post({ Origin: SITE }), SITE)).toBe(true);
		expect(fromSite(post({ Origin: SITE, "Sec-Fetch-Site": "cross-site" }), SITE)).toBe(true);
		for (const origin of ["null", "https://evil.example", "https://app.minerva.example", "http://minerva.example", "https://minerva.example:8443", `${SITE}/`, "", "https://MINERVA.example"]) {
			expect(fromSite(post({ Origin: origin, "Sec-Fetch-Site": "same-origin" }), SITE), origin).toBe(false);
		}
		// The request's own origin is not the site's: only MINERVA_SITE_URL counts.
		expect(fromSite(post({ Origin: "https://other.example" }, "https://other.example/api/x"), SITE)).toBe(false);
	});

	test("without Origin, Sec-Fetch-Site must be same-origin; with neither, refused", () => {
		expect(fromSite(post({ "Sec-Fetch-Site": "same-origin" }), SITE)).toBe(true);
		for (const site of ["same-site", "cross-site", "none", "Same-Origin"]) expect(fromSite(post({ "Sec-Fetch-Site": site }), SITE), site).toBe(false);
		expect(fromSite(post({}), SITE)).toBe(false);
		expect(fromSite(post({ Referer: `${SITE}/w/x/chat` }), SITE)).toBe(false);
		expect(fromSite(post({}, undefined, "PATCH"), SITE)).toBe(false);
		// Same origin as another hostname of the Worker is not the site's.
		expect(fromSite(post({ "Sec-Fetch-Site": "same-origin" }, "https://minerva.workers.example/api/x"), SITE)).toBe(false);
	});
});

describe("error shapes", () => {
	test("a refusal is its code, with the code's status, and its detail", async () => {
		const response = refused("CONVERSATION_BUSY", "Wait for the current answer to finish, or stop it.");
		expect(response.status).toBe(409);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ code: "CONVERSATION_BUSY", detail: "Wait for the current answer to finish, or stop it." });
		const missing = notFound();
		expect([missing.status, await missing.json()]).toEqual([404, { code: "NOT_FOUND", detail: "Not found." }]);
		const invalid = validationError([{ type: "too_big", loc: ["body", "name"], msg: "Too big" }]);
		expect([invalid.status, await invalid.json()]).toEqual([422, { code: "VALIDATION_FAILED", detail: [{ type: "too_big", loc: ["body", "name"], msg: "Too big" }] }]);
		// The contract's shape, for its routes and what the router answers itself.
		const contract = errorAnswer("KEEP_ONE_AGENT", "Keep at least one agent.");
		expect([contract.status, contract.headers.get("Cache-Control"), await contract.json()]).toEqual([422, "no-store", { defined: true, code: "KEEP_ONE_AGENT", status: 422, message: "Keep at least one agent." }]);
	});

	test("validation errors are zod's issues, located where the value came from", () => {
		const schema = z.object({ name: z.string().min(1).max(3), ids: z.array(z.string()).max(2) });
		const input = { name: "toolong", ids: ["a", "b", "c", 4] };
		expect(validationItems(schema.safeParse(input).error?.issues ?? [], "body")).toEqual([
			{ type: "too_big", loc: ["body", "name"], msg: "Too big: expected string to have <=3 characters" },
			{ type: "invalid_type", loc: ["body", "ids", 3], msg: "Invalid input: expected string, received number" },
			{ type: "too_big", loc: ["body", "ids"], msg: "Too big: expected array to have <=2 items" },
		]);
		expect(validationItems(schema.safeParse({}).error?.issues ?? [], "query")[0]).toEqual({ type: "invalid_type", loc: ["query", "name"], msg: "Invalid input: expected string, received undefined" });
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
	const request = (body: BodyInit, headers: Record<string, string> = { "Content-Type": "application/json" }) => new Request(`${SITE}/api/x`, { method: "POST", body, headers });

	test("parses JSON sent as application/json, with or without parameters; an empty body is undefined", async () => {
		expect(await readJson(request('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
		expect(await readJson(request('{"a":1}', { "Content-Type": "Application/JSON ; charset=utf-8" }))).toEqual({ ok: true, value: { a: 1 } });
		expect(await readJson(request(""))).toEqual({ ok: true, value: undefined });
	});

	test("refuses every other type with 415", async () => {
		for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/problem+json", "application/jsonx", "application/json, text/plain"]) {
			const read = await readJson(request('{"a":1}', type === null ? {} : { "Content-Type": type }));
			expect(read, String(type)).toEqual({ ok: false, refusal: { code: "UNSUPPORTED_MEDIA_TYPE", detail: "Send the body as application/json." } });
		}
	});

	test("refuses what does not parse, or is not UTF-8, with 400", async () => {
		for (const body of ["{nope", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
			expect(await readJson(request(body))).toEqual({ ok: false, refusal: { code: "INVALID_JSON", detail: "The body is not valid JSON." } });
		}
	});

	test("refuses a declared or streamed body over 2.5 MB with 413", async () => {
		const tooLarge = { ok: false, refusal: { code: "PAYLOAD_TOO_LARGE", detail: "The request is too large." } };
		expect(await readJson(request("{}", { "Content-Type": "application/json", "Content-Length": String(MAX_JSON_BODY + 1) }))).toEqual(tooLarge);
		expect(await readJson(request(`"${"x".repeat(MAX_JSON_BODY)}"`))).toEqual(tooLarge);
		expect(await readJson(request(`"${"x".repeat(MAX_JSON_BODY - 2)}"`))).toMatchObject({ ok: true });
	});
});

describe("router", () => {
	// Debug is off here, so the accounts routes need a mailer (src/accounts/emails.ts: checkMailer).
	const env = { ...settingsEnv(), EMAIL: { send: async () => ({ messageId: "m" }) } } as unknown as Env;
	const site = { Origin: SITE };

	test("health", async () => {
		const response = await createApp().request("/api/health", {}, env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("a missing route is 404 NOT_FOUND, with the security headers", async () => {
		for (const path of ["/api/nope", "/api/me/", "/api/workspaces/not-a-uuid/agents", "/api/csrf"]) {
			const response = await createApp().request(path, { method: "POST", headers: site }, env);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
			expect(response.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
		}
	});

	test("every unsafe request fails closed from another site, before any route runs, matched or not", async () => {
		const app = createApp();
		const ran: string[] = [];
		app.post("/api/route", () => (ran.push("route"), unauthorized()));
		// Only POSTs under /api/auth/ are exempt (Better Auth's route answers them all), not every method there.
		app.delete("/api/auth/session", () => (ran.push("auth"), unauthorized()));
		app.use("/api/mounted/*", async () => (ran.push("mounted"), unauthorized()));
		const crossSite = { defined: true, code: "CROSS_SITE", status: 403, message: "Cross-site request refused." };
		for (const [method, path] of [["POST", "/api/route"], ["DELETE", "/api/auth/session"], ["POST", "/api/mounted/x"], ["POST", "/api/nope"], ["PUT", "/api/health"]]) {
			const response = await app.request(path!, { method, headers: { Origin: "https://evil.example" } }, env);
			expect([method, path, response.status, await response.json()]).toEqual([method, path, 403, crossSite]);
			expect(response.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
		}
		expect(ran).toEqual([]);
		expect((await app.request("/api/route", { method: "POST", headers: site }, env)).status).toBe(401);
		expect((await app.request("/api/mounted/x", { method: "POST", headers: site }, env)).status).toBe(401);
		// The upload is checked first too; then its own checks: here the missing Content-Length, and 405 for its other methods.
		const uploads = `/api/workspaces/${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}/uploads`;
		expect((await app.request(uploads, { method: "POST" }, env)).status).toBe(403);
		const upload = await app.request(uploads, { method: "POST", headers: site }, env);
		expect([upload.status, await upload.json()]).toEqual([411, { code: "LENGTH_REQUIRED", detail: "Send a Content-Length." }]);
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			const other = await app.request(uploads, { method, headers: site }, env);
			expect([method, other.status, await other.json()]).toEqual([method, 405, { code: "METHOD_NOT_ALLOWED", detail: "Use POST." }]);
		}
		expect(ran).toEqual(["route", "mounted"]);
		expect([...OWN_SIZE_LIMIT]).toEqual(["POST", "PUT", "PATCH", "DELETE"].map((method) => `${method} ${UPLOAD_ROUTE}`));
	});

	test("a declared body over 2.5 MB is 413 everywhere but the upload", async () => {
		const app = createApp();
		app.post("/api/route", () => unauthorized());
		const big = { ...site, "Content-Length": String(MAX_JSON_BODY + 1) };
		for (const path of ["/api/route", "/api/nope"]) {
			const response = await app.request(path, { method: "POST", headers: big }, env);
			expect(response.status, path).toBe(413);
			expect(await response.json()).toEqual({ defined: true, code: "PAYLOAD_TOO_LARGE", status: 413, message: "The request is too large." });
		}
		// The upload's own limit applies instead (50 MB): this one gets as far as its missing name.
		const upload = await app.request(`/api/workspaces/${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}/uploads`, { method: "POST", headers: big }, env);
		expect([upload.status, await upload.json()]).toEqual([400, { code: "FILE_NAME_MISSING", detail: "Name the file with ?name=." }]);
	});
});

describe("/assets/", () => {
	// The assets binding as the platform answers: the file, or the app shell for a miss (SPA fallback).
	const assets = (files: Record<string, string>) =>
		({
			fetch: async (request: Request) => {
				const body = files[new URL(request.url).pathname];
				if (body === undefined) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
				return new Response(body, { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=0, must-revalidate" } });
			},
		}) as unknown as Fetcher;

	test("a file that exists is immutable, with the security headers", async () => {
		const response = await serveAsset(new Request(`${SITE}/assets/app-1.js`), assets({ "/assets/app-1.js": "ok" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("a missing file is a 404 that nothing caches, not the app shell", async () => {
		const response = await serveAsset(new Request(`${SITE}/assets/gone-2.js`), assets({}));
		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
	});
});
