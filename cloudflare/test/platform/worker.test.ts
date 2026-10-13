import { type D1Migration, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { conversationObject, filesBucket, sandboxObject, scriptsObject, workspaceObject } from "../../src/addressing.ts";
import { MIGRATIONS as CONVERSATION_MIGRATIONS } from "../../src/conversation/schema.ts";
import { SANDBOX_MIGRATIONS } from "../../src/sandbox/store.ts";
import { MIGRATIONS as SCRIPTS_MIGRATIONS } from "../../src/scripts/schema.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { AUTH_ROUTE } from "../../src/accounts/routes.ts";
import { createApp } from "../../src/http/router.ts";
import { saltedHmacHex } from "../../src/lib/hash.ts";
import { DraftInvoice, body, jsonBody } from "../../src/connectors/xero/writes.ts";
import { escapedKeyCheck, type JsonObject } from "../../src/lib/json.ts";
import { appliedMigrations, migrate } from "../../src/lib/sqlite.ts";

const WS = "0199a000-0000-7000-8000-0000000000aa";
const USER = "0199a000-0000-7000-8000-0000000000bb";

describe("the router in workerd", () => {
	test("health answers with the security headers", async () => {
		const response = await exports.default.fetch("http://localhost/api/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	test("an unknown API path is 404 NOT_FOUND", async () => {
		const response = await exports.default.fetch("http://localhost/api/workspaces", { method: "POST", headers: { Origin: "http://localhost" } });
		expect([response.status, await response.json()]).toEqual([404, { defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }]);
	});

	test("every unsafe route refuses a request from another site, or from nowhere", async () => {
		const unsafe = createApp().routes.filter((route) => ["POST", "PUT", "PATCH", "DELETE"].includes(route.method));
		for (const route of unsafe) {
			// Better Auth's own route checks origins itself (test/platform/accounts.test.ts, CSRF).
			if (route.path === AUTH_ROUTE) continue;
			// Each parameter gets a valid id; regex parameters are all UUIDs (router.ts).
			const path = route.path.replace(/:[a-z]+(\{(?:[^{}]|\{[^{}]*\})*\})?/gi, "0199a000-0000-7000-8000-000000000001");
			for (const headers of [{}, { Origin: "https://evil.example" }] as Record<string, string>[]) {
				const response = await exports.default.fetch(`http://localhost${path}`, { method: route.method, headers });
				expect([response.status, await response.json()], `${route.method} ${route.path}`).toEqual([403, { defined: true, code: "CROSS_SITE", status: 403, message: "Cross-site request refused." }]);
			}
		}
	});

	test("the probe is a plain 404 without its token", async () => {
		// Including the token of before 2026-10-12, which Workers Logs kept whole under the header's old name.
		const retired = await saltedHmacHex("minerva.probe", "probe", env.MINERVA_SECRET_KEY, "SHA-256");
		for (const headers of [{}, { [PROBE_HEADER]: "0".repeat(64) }, { [PROBE_HEADER]: retired }, { "X-Minerva-Probe": retired }] as Record<string, string>[]) {
			const response = await exports.default.fetch("http://localhost/api/probe", { headers });
			expect([response.status, await response.json()]).toEqual([404, { defined: true, code: "NOT_FOUND", status: 404, message: "Not found." }]);
		}
	});

	test("the probe reaches every class in both jurisdictions and lists D1's migrations", async () => {
		const headers = { [PROBE_HEADER]: await probeToken(env.MINERVA_SECRET_KEY) };
		const response = await exports.default.fetch("http://localhost/api/probe", { headers });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { objects: Record<string, { kind: string; name: string; jurisdiction: string | null }>; d1Migrations: string[] };
		const nil = "00000000-0000-0000-0000-000000000000";
		for (const kind of ["workspace", "conversation", "scripts", "sandbox"]) {
			// Locally, with debug on, an EU object is the plain namespace's `eu:<name>` (addressing.ts).
			expect(body.objects[`${kind}:default`]).toMatchObject({ kind, name: nil, jurisdiction: null });
			expect(body.objects[`${kind}:eu`]).toMatchObject({ kind, name: `eu:${nil}`, jurisdiction: null });
		}
		const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
		expect(body.d1Migrations).toEqual(TEST_MIGRATIONS.map((migration) => migration.name));
	});
});

describe("the runtime's JSON.parse", () => {
	test("still confuses escaped keys, and parseJson does not", () => {
		// When this fails on `native`, workerd's V8 is fixed: update lib/json.ts (parseJson can then call JSON.parse).
		expect(escapedKeyCheck()).toEqual({ native: [92], parseJson: [10] });
	});
});

describe("the runtime's JSON.rawJSON", () => {
	test("writes a Xero draft's amounts as their decimals", () => {
		const draft = DraftInvoice.parse({
			contact: "0199a000-0000-7000-8000-0000000000cc",
			lines: [{ description: "Consulting", quantity: "123456789.0001", unit_amount: "-9999999999.9999", discount_rate: "12.50" }],
		});
		const sent = body(draft, "sales");
		const line = (sent.LineItems as JsonObject[])[0] as JsonObject;
		const raw = JSON as unknown as { isRawJSON(value: unknown): boolean };
		expect([line.Quantity, line.UnitAmount, line.DiscountRate].map((value) => raw.isRawJSON(value))).toEqual([true, true, true]);
		expect(jsonBody(draft, "sales")).toContain('"Quantity":123456789.0001,"UnitAmount":-9999999999.9999,"DiscountRate":12.5}');
	});
});

describe("jurisdictions", () => {
	const plain = { id: WS, jurisdiction: null };
	const eu = { id: WS, jurisdiction: "eu" as const };

	test("workerd has none, so with debug on an EU object is a separate object of its own name", async () => {
		expect(() => (env.WORKSPACE as DurableObjectNamespace).jurisdiction("eu")).toThrow(/not implemented in workerd/);
		await runInDurableObject(workspaceObject(env, plain), (_, state) => state.storage.kv.put("mark", "plain"));
		await runInDurableObject(workspaceObject(env, eu), (_, state) => {
			expect(state.id.name).toBe(`eu:${WS}`);
			expect(state.storage.kv.get("mark")).toBeUndefined();
		});
		expect(await sandboxObject(env, exports, eu, USER).about()).toMatchObject({ name: `eu:${USER}` });
	});

	test("an EU workspace's files are in a bucket of their own", async () => {
		expect(filesBucket(env, eu)).not.toBe(filesBucket(env, plain));
		await filesBucket(env, eu).put("probe", "eu");
		expect(await filesBucket(env, plain).head("probe")).toBeNull();
		await filesBucket(env, eu).delete("probe");
	});
});

describe("Durable Object stubs with SQLite", () => {
	test("each class answers over RPC, addressed by workspace and conversation", async () => {
		const workspace = { id: WS, jurisdiction: null };
		const named = (kind: string, name: string, migrations: number[] = []) => ({ kind, name, jurisdiction: null, migrations });
		// The Workspace and the Conversation apply their schema steps when they are built
		// (src/workspace/schema.ts, src/conversation/schema.ts).
		expect(await workspaceObject(env, workspace).about()).toEqual(named("workspace", WS, [1, 2]));
		expect(await conversationObject(env, workspace, USER).about()).toEqual(named("conversation", USER, CONVERSATION_MIGRATIONS.map((step) => step.id)));
		expect(await scriptsObject(env, workspace, USER).about()).toEqual(named("scripts", USER, SCRIPTS_MIGRATIONS.map((step) => step.id)));
		expect(await sandboxObject(env, exports, workspace, USER).about()).toEqual(named("sandbox", USER, SANDBOX_MIGRATIONS.map((step) => step.id)));
	});

	test("schema steps apply once, in order, each in a transaction", async () => {
		const stub = workspaceObject(env, { id: "0199a000-0000-7000-8000-0000000000cc", jurisdiction: null });
		await runInDurableObject(stub, (_, state) => {
			// Ids past any class's own steps, which the object applied when it started.
			const own = appliedMigrations(state.storage);
			const steps = [
				{ id: 9002, sql: "ALTER TABLE t ADD COLUMN y TEXT" },
				{ id: 9001, sql: "CREATE TABLE t (x INTEGER); CREATE INDEX t_x ON t (x)" },
			];
			expect(migrate(state.storage, steps)).toEqual([9001, 9002]);
			expect(migrate(state.storage, steps)).toEqual([]);
			expect(appliedMigrations(state.storage)).toEqual([...own, 9001, 9002]);
			state.storage.sql.exec("INSERT INTO t (x, y) VALUES (1, 'a')");
			expect(() => migrate(state.storage, [{ id: 9003, sql: "CREATE TABLE u (a); CREATE TABLE t (b)" }])).toThrow();
			// The failed step left nothing behind.
			expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u'").one().n).toBe(0);
			expect(appliedMigrations(state.storage)).toEqual([...own, 9001, 9002]);
		});
	});
});

describe("D1 enforces the accounts schema's rules", () => {
	const ORG = "0199a000-0000-7000-8000-0000000000c1";
	const SESSION = "0199a000-0000-7000-8000-0000000000c2";
	const NOW = "2026-10-12T00:00:00.000Z";

	// Storage lasts for the whole file, so each test starts from empty tables.
	beforeEach(async () => {
		await env.DB.batch(
			["oauth_flows", "memberships", "workspaces", "member", "organization", "session", "user", "rate_limits", "oauth_clients"].map((table) =>
				env.DB.prepare(`DELETE FROM "${table}"`),
			),
		);
	});

	async function seed() {
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, '', 'ada@example.com', 1, ?, ?)`).bind(USER, NOW, NOW),
			env.DB.prepare(`INSERT INTO organization (id, name, slug, "createdAt", "personalOwner") VALUES (?, 'Personal', ?, ?, ?)`).bind(ORG, ORG, NOW, USER),
			env.DB.prepare("INSERT INTO workspaces (id, organization_id, kind, name, personal_owner, created_at) VALUES (?, ?, 'personal', 'Personal', ?, ?)").bind(WS, ORG, USER, 1),
			env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(WS, USER, 1),
			env.DB.prepare(`INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, 't', ?, ?, ?)`).bind(SESSION, NOW, NOW, NOW, USER),
		]);
	}

	test("workspaces are personal iff owned, one per owner; their owner and organization cannot be deleted under them", async () => {
		await seed();
		await expect(
			env.DB.prepare("INSERT INTO workspaces (id, organization_id, kind, name, created_at) VALUES ('0199a000-0000-7000-8000-0000000000dd', ?, 'personal', 'P', 1)").bind(ORG).run(),
		).rejects.toThrow(/CHECK/);
		await expect(
			env.DB.prepare("INSERT INTO workspaces (id, organization_id, kind, name, personal_owner, created_at) VALUES ('0199a000-0000-7000-8000-0000000000dd', ?, 'personal', 'P', ?, 1)")
				.bind(ORG, USER)
				.run(),
		).rejects.toThrow(/UNIQUE/);
		// Its Durable Object and files need deleting first (plan: Files, Deletion); a cascade would lose them.
		await expect(env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(USER).run()).rejects.toThrow(/FOREIGN KEY/);
		await expect(env.DB.prepare("DELETE FROM organization WHERE id = ?").bind(ORG).run()).rejects.toThrow(/FOREIGN KEY/);
		await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(WS).run();
		expect((await env.DB.prepare("SELECT count(*) AS n FROM memberships").first())?.n).toBe(0);
	});

	test("an OAuth flow is popped once, and ends with its session", async () => {
		await seed();
		const insert = env.DB.prepare(
			"INSERT INTO oauth_flows (session_id, state, verifier, provider, workspace_id, client_id, issued_at, expires_at) VALUES (?, 's', 'v', 'todoist', ?, 'c', 1, 600001)",
		).bind(SESSION, WS);
		await insert.run();
		const pop = env.DB.prepare("DELETE FROM oauth_flows WHERE session_id = ? RETURNING state").bind(SESSION);
		expect((await pop.all()).results).toEqual([{ state: "s" }]);
		expect((await pop.all()).results).toEqual([]);
		await insert.run();
		await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(SESSION).run();
		expect((await env.DB.prepare("SELECT count(*) AS n FROM oauth_flows").first())?.n).toBe(0);
	});
});
