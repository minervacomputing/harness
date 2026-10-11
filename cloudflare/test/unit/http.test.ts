import { describe, expect, test } from "vitest";
import { z } from "zod";
import { serveAsset } from "../../src/http/assets.ts";
import { MAX_JSON_BODY, readJson } from "../../src/http/body.ts";
import { CSRF_COOKIE, clearSessionCookie, csrfCookie, parseCookies, sessionCookie } from "../../src/http/cookies.ts";
import { checkCsrf, newCsrfToken } from "../../src/http/csrf.ts";
import { HttpError, allauth, allauthCsrfFailed, detail, notFound, validationItems } from "../../src/http/errors.ts";
import { DEFAULT_CSP, withSecurityHeaders } from "../../src/http/headers.ts";
import { CHECKED_LATER, UPLOAD_ROUTE, createApp } from "../../src/http/router.ts";
import { settingsEnv } from "./settings.ts";

const SITE = "https://minerva.example";
const TOKEN = "a".repeat(32);

function post(headers: Record<string, string>, url = `${SITE}/api/x`): Request {
	return new Request(url, { method: "POST", headers });
}

describe("CSRF, in Django's order", () => {
	const good = { Origin: SITE, Cookie: `${CSRF_COOKIE}=${TOKEN}`, "X-CSRFToken": TOKEN };

	test("safe methods pass", () => {
		expect(checkCsrf(new Request(`${SITE}/api/x`), SITE)).toBeNull();
	});

	test("a matching header from the site's origin passes", () => {
		expect(checkCsrf(post(good), SITE)).toBeNull();
		expect(checkCsrf(post({ ...good, Origin: "https://other.example" }, "https://other.example/api/x"), SITE)).toBeNull();
	});

	test("a foreign Origin fails even with a valid token", () => {
		expect(checkCsrf(post({ ...good, Origin: "https://evil.example" }), SITE)).toBe("bad_origin");
		expect(checkCsrf(post({ ...good, Origin: "null" }), SITE)).toBe("bad_origin");
	});

	test("over HTTPS without Origin, the Referer must be the site's", () => {
		const { Origin: _, ...noOrigin } = good;
		expect(checkCsrf(post(noOrigin), SITE)).toBe("no_referer");
		expect(checkCsrf(post({ ...noOrigin, Referer: "https://evil.example/page" }), SITE)).toBe("bad_referer");
		expect(checkCsrf(post({ ...noOrigin, Referer: "http://minerva.example/page" }), SITE)).toBe("bad_referer");
		expect(checkCsrf(post({ ...noOrigin, Referer: "https:minerva.example/page" }), SITE)).toBe("bad_referer");
		expect(checkCsrf(post({ ...noOrigin, Referer: "https://user:pass@minerva.example/" }), SITE)).toBe("bad_referer");
		expect(checkCsrf(post({ ...noOrigin, Referer: `${SITE}/w/x/chat` }), SITE)).toBeNull();
		expect(checkCsrf(post(noOrigin, "http://localhost:5173/api/x"), "http://localhost:5173")).toBeNull();
	});

	test("the cookie must be set and well formed, and the header must equal it", () => {
		expect(checkCsrf(post({ Origin: SITE, "X-CSRFToken": TOKEN }), SITE)).toBe("no_cookie");
		expect(checkCsrf(post({ ...good, Cookie: `${CSRF_COOKIE}=short` }), SITE)).toBe("no_cookie");
		expect(checkCsrf(post({ Origin: SITE, Cookie: `${CSRF_COOKIE}=${TOKEN}` }), SITE)).toBe("no_token");
		expect(checkCsrf(post({ ...good, "X-CSRFToken": "b".repeat(32) }), SITE)).toBe("bad_token");
	});

	test("new tokens are 32 letters and digits", () => {
		expect(newCsrfToken()).toMatch(/^[A-Za-z0-9]{32}$/);
	});
});

describe("cookies", () => {
	test("sessionid and csrftoken carry Django's attributes", () => {
		expect(sessionCookie("abc", { debug: false })).toBe("sessionid=abc; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly; Secure");
		expect(sessionCookie("abc", { debug: true })).toBe("sessionid=abc; Max-Age=1209600; Path=/; SameSite=Lax; HttpOnly");
		expect(csrfCookie(TOKEN, { debug: false })).toBe(`csrftoken=${TOKEN}; Max-Age=31449600; Path=/; SameSite=Lax; Secure`);
		expect(clearSessionCookie({ debug: false })).toBe("sessionid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; HttpOnly; Secure");
	});

	test("parsing takes the last of a repeated name and unquotes", () => {
		const cookies = parseCookies('a=1; b="2"; a=3; junk; c=');
		expect([...cookies]).toEqual([
			["a", "3"],
			["b", "2"],
			["c", ""],
		]);
	});
});

describe("error shapes", () => {
	test("Ninja's detail", async () => {
		const response = detail(409, "Wait for the current answer to finish, or stop it.");
		expect(response.status).toBe(409);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ detail: "Wait for the current answer to finish, or stop it." });
		expect(await notFound("no such agent").json()).toEqual({ detail: "Not Found" });
		expect(await notFound("no such agent", true).json()).toEqual({ detail: "Not Found: no such agent" });
	});

	test("allauth's envelope", async () => {
		expect(await allauth(401, { meta: { is_authenticated: false } }).json()).toEqual({ status: 401, meta: { is_authenticated: false } });
		expect(await allauthCsrfFailed().json()).toEqual({ status: 403, errors: [{ message: "CSRF check failed.", code: "csrf" }] });
	});

	test("a wrong type is not a missing field, and a list reports its length, without zod's reportInput", () => {
		const schema = z.object({ name: z.string(), ids: z.array(z.string()).max(2) });
		const input = { name: 123, ids: ["a", "b", "c", "d"] };
		const items = validationItems(schema.safeParse(input).error?.issues ?? [], "body", input);
		expect(items).toContainEqual({ type: "string_type", loc: ["body", "payload", "name"], msg: "Input should be a valid string" });
		expect(items).toContainEqual({
			type: "too_long",
			loc: ["body", "payload", "ids"],
			msg: "List should have at most 2 items after validation, not 4",
			ctx: { field_type: "List", max_length: 2, actual_length: 4 },
		});
		const absent = {};
		expect(validationItems(schema.safeParse(absent).error?.issues ?? [], "body", absent)).toContainEqual({ type: "missing", loc: ["body", "payload", "name"], msg: "Field required" });
	});

	test("validation errors in Pydantic's words", () => {
		const schema = z.object({ name: z.string().min(1).max(120), connection_ids: z.array(z.uuid()).max(2), instructions: z.string() });
		const input = { name: "x".repeat(121), connection_ids: ["a", "b", "c"] };
		const result = schema.safeParse(input);
		expect(result.success).toBe(false);
		const items = validationItems(result.error?.issues ?? [], "body", input);
		expect(items).toContainEqual({ type: "string_too_long", loc: ["body", "payload", "name"], msg: "String should have at most 120 characters", ctx: { max_length: 120 } });
		expect(items).toContainEqual({
			type: "too_long",
			loc: ["body", "payload", "connection_ids"],
			msg: "List should have at most 2 items after validation, not 3",
			ctx: { field_type: "List", max_length: 2, actual_length: 3 },
		});
		expect(items).toContainEqual({ type: "missing", loc: ["body", "payload", "instructions"], msg: "Field required" });
		expect(items).toContainEqual({ type: "uuid_parsing", loc: ["body", "payload", "connection_ids", 0], msg: "Input should be a valid UUID" });
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
	const request = (body: BodyInit, headers: Record<string, string> = {}) => new Request(`${SITE}/api/x`, { method: "POST", body, headers });

	test("parses JSON", async () => {
		expect(await readJson(request('{"a":1}'))).toEqual({ a: 1 });
	});

	test("refuses what does not parse with 400", async () => {
		const error = await readJson(request("{nope")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).response.status).toBe(400);
		expect(await (error as HttpError).response.json()).toEqual({ detail: "Cannot parse request body" });
	});

	test("refuses a declared or streamed body over 2.5 MB with 413", async () => {
		const declared = await readJson(request("{}", { "Content-Length": String(MAX_JSON_BODY + 1) })).catch((e: unknown) => e);
		expect((declared as HttpError).response.status).toBe(413);
		const streamed = await readJson(request(`"${"x".repeat(100)}"`), 50).catch((e: unknown) => e);
		expect(await (streamed as HttpError).response.json()).toEqual({ detail: "The request is too large." });
	});
});

describe("router", () => {
	const env = settingsEnv() as unknown as Env;

	test("health", async () => {
		const response = await createApp().request("/api/health", {}, env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("csrf sets the cookie and renews a valid one", async () => {
		const fresh = await createApp().request("/api/csrf", {}, env);
		expect(fresh.status).toBe(204);
		expect(fresh.headers.get("Set-Cookie")).toMatch(/^csrftoken=[A-Za-z0-9]{32}; Max-Age=31449600; Path=\/; SameSite=Lax; Secure$/);
		const renewed = await createApp().request("/api/csrf", { headers: { Cookie: `csrftoken=${TOKEN}` } }, env);
		expect(renewed.headers.get("Set-Cookie")).toContain(`csrftoken=${TOKEN};`);
	});

	test("a missing route is 404 Not Found, with the security headers", async () => {
		for (const path of ["/api/nope", "/api/me/", "/api/workspaces/not-a-uuid/agents"]) {
			const response = await createApp().request(path, { method: "POST" }, env);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ detail: "Not Found" });
			expect(response.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
		}
	});

	test("every unsafe route fails closed without a CSRF token, in its shape, before the route runs", async () => {
		const app = createApp();
		const ran: string[] = [];
		app.post("/api/ninja", () => (ran.push("ninja"), detail(401, "Unauthorized")));
		app.delete("/api/auth/session", () => (ran.push("allauth"), allauth(401)));
		app.post(UPLOAD_ROUTE, () => (ran.push("upload"), detail(401, "Unauthorized")));
		const ninja = await app.request("/api/ninja", { method: "POST" }, env);
		expect(ninja.status).toBe(403);
		expect(await ninja.json()).toEqual({ detail: "CSRF check Failed" });
		const auth = await app.request("/api/auth/session", { method: "DELETE", headers: { Origin: "https://evil.example" } }, env);
		expect(await auth.json()).toEqual({ status: 403, errors: [{ message: "CSRF check failed.", code: "csrf" }] });
		expect(ran).toEqual([]);
		const good = { Origin: SITE, Cookie: `csrftoken=${TOKEN}`, "X-CSRFToken": TOKEN };
		expect((await app.request(`${SITE}/api/ninja`, { method: "POST", headers: good }, env)).status).toBe(401);
		// The upload checks CSRF itself, after the session.
		const upload = await app.request(`/api/workspaces/${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}/uploads`, { method: "POST" }, env);
		expect(upload.status).toBe(401);
		expect(ran).toEqual(["ninja", "upload"]);
		expect([...CHECKED_LATER]).toEqual([`POST ${UPLOAD_ROUTE}`]);
	});

	test("a declared body over 2.5 MB is 413 everywhere but the upload", async () => {
		const app = createApp();
		app.post("/api/ninja", () => detail(401, "Unauthorized"));
		app.post(UPLOAD_ROUTE, () => detail(401, "Unauthorized"));
		const big = { "Content-Length": String(MAX_JSON_BODY + 1) };
		for (const path of ["/api/ninja", "/api/nope"]) {
			const response = await app.request(path, { method: "POST", headers: big }, env);
			expect(response.status, path).toBe(413);
			expect(await response.json()).toEqual({ detail: "The request is too large." });
		}
		const upload = await app.request(`/api/workspaces/${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}/uploads`, { method: "POST", headers: big }, env);
		expect(upload.status).toBe(401);
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
