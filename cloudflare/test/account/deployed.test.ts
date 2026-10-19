import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MIGRATIONS as CONVERSATION_MIGRATIONS } from "../../src/conversation/schema.ts";
import { MIGRATIONS as SCRIPTS_MIGRATIONS } from "../../src/scripts/schema.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { SANDBOX_MIGRATIONS } from "../../src/sandbox/schema.ts";
import { cf, fetchDeployed, instanceSecret, ownOrigin, suiteInstance } from "./client.ts";

/**
 * The instance this suite probes, of either kind, which must be named (`pnpm test:deployed --instance <name>`, or
 * MINERVA_INSTANCE): its app's origin on its account's workers.dev subdomain, and cf's commands on its account.
 */
const INSTANCE = suiteInstance(false);
const NAMES = INSTANCE.names;
const SITE = ownOrigin(INSTANCE);

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
	const site = SITE;

	test("the web API's former paths are 404 NOT_FOUND with the security headers", async () => {
		const requests: [string, Parameters<typeof fetchDeployed>[1]][] = [
			["/api/health", {}],
			["/api/workspaces", {}],
			["/api/auth/sign-in/email", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }],
		];
		for (const [path, init] of requests) {
			const reply = await fetchDeployed(`${site}${path}`, init);
			expect([reply.status, JSON.parse(reply.text)], path).toEqual([404, { defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }]);
			expectSecurityHeaders(reply.headers);
			expect(reply.headers.get("cache-control"), path).toBe("no-store");
		}
	});

	test("a missing API route is 404 NOT_FOUND", async () => {
		const reply = await fetchDeployed(`${site}/api/no-such-route`, { method: "POST", headers: { origin: site } });
		expect(reply.status).toBe(404);
		expect(JSON.parse(reply.text)).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
		expectSecurityHeaders(reply.headers);
	});

	test("/, a former client route and a former asset are 404 NOT_FOUND with the security headers", async () => {
		for (const path of ["/", "/w/0199a000-0000-7000-8000-000000000001/chat", "/assets/index.js"]) {
			const reply = await fetchDeployed(`${site}${path}`);
			expect([reply.status, JSON.parse(reply.text)], path).toEqual([404, { defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }]);
			expectSecurityHeaders(reply.headers);
		}
	});
});

describe(`inside ${NAMES.app} (/api/probe)`, () => {
	const site = SITE;

	test("without its token it is a plain 404", async () => {
		for (const headers of [{}, { [PROBE_HEADER]: "0".repeat(64) }] as Record<string, string>[]) {
			const reply = await fetchDeployed(`${site}/api/probe`, { headers });
			expect(reply.status).toBe(404);
			expect(JSON.parse(reply.text)).toEqual({ defined: true, code: "NOT_FOUND", status: 404, message: "Not found." });
		}
	});

	test("every Durable Object class answers, in the EU jurisdiction too; D1 has every migration; JSON keys", { timeout: 360_000 }, async () => {
		const expected = Object.fromEntries(
			Object.entries({ conversation: CONVERSATION_MIGRATIONS, scripts: SCRIPTS_MIGRATIONS, sandbox: SANDBOX_MIGRATIONS }).map(([kind, steps]) => [kind, steps.map((step) => step.id)]),
		);
		// `cf deploy` returns before the new version settles everywhere. Right after it, an object can still be built
		// by the previous version and answer that build's schema steps, a strict prefix of these (seen in CI, a probe
		// 30 ms after the deploy; the Sandbox class, which has a container, for more than a minute), or the runtime can
		// fail to reach it at all with its own internal error (seen in CI too, no invocation logged). An answer whose
		// every object is this build's, the previous one's or unreached, and some not this build's, is asked again for
		// up to five minutes; any other is checked at once.
		const settling = (objects: Record<string, unknown>) => {
			const answers = Object.entries(expected).flatMap(([kind, migrations]) =>
				([null, "eu"] as const).map((jurisdiction) => {
					const answer = objects[`${kind}:${jurisdiction ?? "default"}`] as { kind?: string; name?: string; jurisdiction?: string | null; migrations?: unknown; error?: unknown } | undefined;
					if (typeof answer?.error === "string" && /^Error: internal error; reference = \w+$/.test(answer.error)) return { known: true, current: false };
					const answered = Array.isArray(answer?.migrations) ? (answer.migrations as unknown[]) : undefined;
					const known = answer?.kind === kind && answer.name === NIL && answer.jurisdiction === jurisdiction && answered !== undefined && answered.length <= migrations.length && answered.every((id, index) => id === migrations[index]);
					return { known, current: known && answered.length === migrations.length };
				}),
			);
			return answers.every((answer) => answer.known) && answers.some((answer) => !answer.current);
		};
		const token = await probeToken(instanceSecret(INSTANCE, "MINERVA_SECRET_KEY"));
		const ask = async () => {
			// Right after a deploy (or a reset) the first probe builds six objects in fresh namespaces, which has
			// taken longer than the 5 s Node's agent waits by default.
			const reply = await fetchDeployed(`${site}/api/probe`, { headers: { [PROBE_HEADER]: token }, timeoutMs: 25_000 });
			expect(reply.status).toBe(200);
			return JSON.parse(reply.text) as {
				objects: Record<string, unknown>;
				d1Migrations: string[];
				json: { native: number[]; parseJson: number[] };
			};
		};
		const deadline = Date.now() + 300_000;
		let body = await ask();
		while (settling(body.objects) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			body = await ask();
		}
		for (const [kind, migrations] of Object.entries(expected)) {
			// Each object applies its schema steps when it is built (src/conversation/schema.ts, src/sandbox/schema.ts).
			expect(body.objects[`${kind}:default`], kind).toEqual({ kind, name: NIL, jurisdiction: null, migrations });
			// The Sandbox is reached through ctx.exports (addressing.ts); its jurisdiction works there too.
			expect(body.objects[`${kind}:eu`], kind).toEqual({ kind, name: NIL, jurisdiction: "eu", migrations });
		}
		const local = readdirSync(new URL("../../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
		expect(body.d1Migrations).toEqual(local);
		// The runtime's escaped-key bug (lib/json.ts) is fixed on the edge (since 2026-10-14), though not in the
		// local workerd (test/platform/worker.test.ts); parseJson reads the key right either way.
		expect(body.json).toEqual({ native: [10], parseJson: [10] });
	});
});

describe("preview URLs", () => {
	interface WorkerInfo {
		subdomain: { enabled: boolean; previews_enabled: boolean };
	}

	test("are off for the app", () => {
		const info = cf<WorkerInfo>(["workers", "get", NAMES.app]);
		expect(info.subdomain.enabled).toBe(true);
		expect(info.subdomain.previews_enabled).toBe(false);
	});
});
