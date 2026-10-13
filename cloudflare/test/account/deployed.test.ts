import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MIGRATIONS as CONVERSATION_MIGRATIONS } from "../../src/conversation/schema.ts";
import { MIGRATIONS as SCRIPTS_MIGRATIONS } from "../../src/scripts/schema.ts";
import { MIGRATIONS as WORKSPACE_MIGRATIONS } from "../../src/workspace/schema.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { SANDBOX_MIGRATIONS } from "../../src/sandbox/schema.ts";
import { namesOf, todaysInstance } from "../../scripts/instance.ts";
import { cf, fetchDeployed, origin, secret } from "./client.ts";

/** The instance this suite probes: production (`pnpm test:account`). */
const NAMES = namesOf(todaysInstance(false));

const NIL = "00000000-0000-0000-0000-000000000000";

const SECURITY = {
	"strict-transport-security": "max-age=31536000",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"cross-origin-opener-policy": "same-origin",
	"content-security-policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

function expectSecurityHeaders(headers: Headers) {
	for (const [name, value] of Object.entries(SECURITY)) expect(headers.get(name), name).toBe(value);
}

describe(NAMES.app, () => {
	const site = origin("MINERVA_SITE_URL");

	test("/api/health answers with the security headers", async () => {
		const reply = await fetchDeployed(`${site}/api/health`);
		expect(reply.status).toBe(200);
		expect(JSON.parse(reply.text)).toEqual({ ok: true });
		expectSecurityHeaders(reply.headers);
		expect(reply.headers.get("cache-control")).toBe("no-store");
	});

	test("a missing API route is 404 NOT_FOUND", async () => {
		const reply = await fetchDeployed(`${site}/api/no-such-route`, { method: "POST", headers: { origin: site } });
		expect(reply.status).toBe(404);
		expect(JSON.parse(reply.text)).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
		expectSecurityHeaders(reply.headers);
	});

	test("an unsafe request from another site, or from nowhere, is refused before any route", async () => {
		for (const headers of [{}, { origin: "https://evil.example" }] as Record<string, string>[]) {
			const reply = await fetchDeployed(`${site}/api/no-such-route`, { method: "POST", headers });
			expect(reply.status).toBe(403);
			expect(JSON.parse(reply.text)).toEqual({ defined: true, code: "CROSS_SITE", status: 403, message: "Cross-site request refused." });
			expectSecurityHeaders(reply.headers);
		}
	});

	test("/ and client routes serve the SPA shell with the asset headers", async () => {
		for (const path of ["/", "/login", "/w/0199a000-0000-7000-8000-000000000001/chat"]) {
			const reply = await fetchDeployed(`${site}${path}`);
			expect(reply.status, path).toBe(200);
			expect(reply.headers.get("content-type")).toMatch(/^text\/html/);
			expect(reply.text).toContain('<div id="root"></div>');
			expect(reply.text).toContain(`<meta http-equiv="Content-Security-Policy" content="img-src 'self' data: blob:" />`);
			expectSecurityHeaders(reply.headers);
		}
	});

	test("a missing asset is a 404 nothing caches, not the app shell", async () => {
		for (const mode of ["no-cors", "navigate"]) {
			const reply = await fetchDeployed(`${site}/assets/missing-${Date.now()}.js`, { headers: { "Sec-Fetch-Mode": mode } });
			expect(reply.status, mode).toBe(404);
			expect(reply.headers.get("content-type")).toBe("text/plain; charset=utf-8");
			expect(reply.headers.get("cache-control")).toBe("no-store");
			expectSecurityHeaders(reply.headers);
		}
	});

	test("hashed assets are immutable", async () => {
		const shell = await fetchDeployed(`${site}/`);
		const script = /src="(\/assets\/[^"]+\.js)"/.exec(shell.text)?.[1];
		expect(script).toBeDefined();
		const reply = await fetchDeployed(`${site}${script}`);
		expect(reply.status).toBe(200);
		expect(reply.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe(`inside ${NAMES.app} (/api/probe)`, () => {
	const site = origin("MINERVA_SITE_URL");

	test("without its token it is a plain 404", async () => {
		for (const headers of [{}, { [PROBE_HEADER]: "0".repeat(64) }] as Record<string, string>[]) {
			const reply = await fetchDeployed(`${site}/api/probe`, { headers });
			expect(reply.status).toBe(404);
			expect(JSON.parse(reply.text)).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
		}
	});

	test("every Durable Object class answers, in the EU jurisdiction too; D1 has every migration; JSON keys", async () => {
		// Right after a deploy (or a reset) the first probe builds eight objects in fresh namespaces, which has
		// taken longer than the 5 s Node's agent waits by default.
		const reply = await fetchDeployed(`${site}/api/probe`, { headers: { [PROBE_HEADER]: await probeToken(secret("MINERVA_SECRET_KEY")) }, timeoutMs: 25_000 });
		expect(reply.status).toBe(200);
		const body = JSON.parse(reply.text) as {
			objects: Record<string, unknown>;
			d1Migrations: string[];
			json: { native: number[]; parseJson: number[] };
		};
		for (const kind of ["workspace", "conversation", "scripts", "sandbox"]) {
			// Each object applies its schema steps when it is built (src/conversation/schema.ts, src/sandbox/schema.ts).
			const steps = ({ conversation: CONVERSATION_MIGRATIONS, workspace: WORKSPACE_MIGRATIONS, scripts: SCRIPTS_MIGRATIONS, sandbox: SANDBOX_MIGRATIONS } as { [kind: string]: { id: number }[] })[kind] ?? [];
			const migrations = steps.map((step) => step.id);
			expect(body.objects[`${kind}:default`], kind).toEqual({ kind, name: NIL, jurisdiction: null, migrations });
			// The Sandbox is reached through ctx.exports (addressing.ts); its jurisdiction works there too.
			expect(body.objects[`${kind}:eu`], kind).toEqual({ kind, name: NIL, jurisdiction: "eu", migrations });
		}
		const local = readdirSync(new URL("../../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
		expect(body.d1Migrations).toEqual(local);
		// The runtime's escaped-key bug, on the edge too (lib/json.ts). When `native` is [10], it is fixed.
		expect(body.json).toEqual({ native: [92], parseJson: [10] });
	});
});

describe("preview URLs", () => {
	interface WorkerInfo {
		subdomain: { enabled: boolean; previews_enabled: boolean };
	}

	test("are off for both Workers", () => {
		for (const name of [NAMES.app, NAMES.download]) {
			const info = cf<WorkerInfo>(["workers", "get", name]);
			expect(info.subdomain.enabled, name).toBe(true);
			expect(info.subdomain.previews_enabled, name).toBe(false);
		}
	});

	test("no version of the download Worker answers at its preview origin", async () => {
		const host = new URL(origin("MINERVA_DOWNLOAD_ORIGIN")).host;
		const versions = cf<{ id: string; urls?: string[] }[]>(["workers", "versions", "list", "--worker-id", NAMES.download]);
		expect(versions.length).toBeGreaterThan(0);
		for (const version of versions) {
			expect(version.urls ?? []).toEqual([]);
			const reply = await fetchDeployed(`https://${version.id.slice(0, 8)}-${host}/x`, { timeoutMs: 10_000 }).catch(() => null);
			// Cloudflare's own page, or nothing at all: never the Worker, whose answer carries `CSP: sandbox`.
			expect(reply?.headers.get("content-security-policy") ?? null).not.toBe("sandbox");
		}
	});
});

describe(NAMES.download, () => {
	test("answers 404 until downloads are built, as a sandboxed response", async () => {
		const reply = await fetchDeployed(`${origin("MINERVA_DOWNLOAD_ORIGIN")}/anything`);
		expect(reply.status).toBe(404);
		expect(JSON.parse(reply.text)).toEqual({ detail: "Not Found" });
		expect(reply.headers.get("content-security-policy")).toBe("sandbox");
	});
});
