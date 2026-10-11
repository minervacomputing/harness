import { type D1Migration, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { conversationObject, filesBucket, sandboxObject, scriptsObject, workspaceObject } from "../../src/addressing.ts";
import { MIGRATIONS as CONVERSATION_MIGRATIONS } from "../../src/conversation/schema.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { CHECKED_LATER, createApp } from "../../src/http/router.ts";
import { escapedKeyCheck } from "../../src/lib/json.ts";
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

	test("an unknown API path is 404 {detail}", async () => {
		const response = await exports.default.fetch("http://localhost/api/workspaces", { method: "POST" });
		expect(response.status).toBe(404);
		const body = (await response.json()) as { detail: string };
		// Debug is on in these tests, so the reason is appended as Django does.
		expect(body.detail).toMatch(/^Not Found/);
	});

	test("csrf sets a readable cookie, insecure in debug", async () => {
		const response = await exports.default.fetch("http://localhost/api/csrf");
		expect(response.status).toBe(204);
		const cookie = response.headers.get("Set-Cookie") ?? "";
		expect(cookie).toMatch(/^csrftoken=[A-Za-z0-9]{32}; Max-Age=31449600; Path=\/; SameSite=Lax$/);
	});

	test("every unsafe route refuses a request without a CSRF token", async () => {
		const unsafe = createApp().routes.filter((route) => ["POST", "PUT", "PATCH", "DELETE"].includes(route.method));
		for (const route of unsafe) {
			if (CHECKED_LATER.has(`${route.method} ${route.path}`)) continue;
			// Each parameter gets a valid id; regex parameters are all UUIDs (router.ts).
			const path = route.path.replace(/:[a-z]+(\{[^}]*\})?/gi, "0199a000-0000-7000-8000-000000000001");
			const response = await exports.default.fetch(`http://localhost${path}`, { method: route.method });
			expect(response.status, `${route.method} ${route.path}`).toBe(403);
		}
	});

	test("the probe is a plain 404 without its token", async () => {
		for (const headers of [{}, { [PROBE_HEADER]: "0".repeat(64) }] as Record<string, string>[]) {
			const response = await exports.default.fetch("http://localhost/api/probe", { headers });
			expect(response.status).toBe(404);
			expect(((await response.json()) as { detail: string }).detail).toMatch(/^Not Found/);
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
		expect(await workspaceObject(env, workspace).about()).toEqual(named("workspace", WS, [1]));
		expect(await conversationObject(env, workspace, USER).about()).toEqual(named("conversation", USER, CONVERSATION_MIGRATIONS.map((step) => step.id)));
		expect(await scriptsObject(env, workspace, USER).about()).toEqual(named("scripts", USER));
		expect(await sandboxObject(env, exports, workspace, USER).about()).toEqual(named("sandbox", USER));
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
	const session = "0".repeat(64);

	// Storage lasts for the whole file, so each test starts from empty tables.
	beforeEach(async () => {
		await env.DB.batch(
			["sessions", "workspaces", "users", "rate_limits", "oauth_clients"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
		);
	});

	async function seed() {
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (id, date_joined) VALUES (?, ?)").bind(USER, 1),
			env.DB.prepare("INSERT INTO emails (email, user_id, created_at) VALUES (?, ?, ?)").bind("ada@example.com", USER, 1),
			env.DB.prepare("INSERT INTO workspaces (id, kind, name, personal_owner, created_at) VALUES (?, 'personal', 'Personal', ?, ?)").bind(WS, USER, 1),
			env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(WS, USER, 1),
			env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(session, 1, 9e12),
		]);
	}

	test("a code allows three attempts and is used once", async () => {
		await seed();
		await env.DB.prepare(
			"INSERT INTO auth_flows (session_hash, kind, user_id, email, code_hash, created_at, expires_at) VALUES (?, 'email_verification', ?, ?, 'right', 1, ?)",
		)
			.bind(session, USER, "ada@example.com", 9e12)
			.run();
		const wrong = env.DB.prepare(
			"UPDATE auth_flows SET attempts = attempts + 1 WHERE session_hash = ? AND kind = 'email_verification' AND attempts < 3 AND expires_at > ? RETURNING attempts",
		).bind(session, Date.now());
		const consume = env.DB.prepare(
			"DELETE FROM auth_flows WHERE session_hash = ? AND kind = 'email_verification' AND code_hash = ? AND attempts < 3 AND expires_at > ? RETURNING email",
		).bind(session, "right", Date.now());
		expect((await wrong.all()).results).toEqual([{ attempts: 1 }]);
		expect((await consume.all()).results).toEqual([{ email: "ada@example.com" }]);
		expect((await consume.all()).results).toEqual([]);
	});

	test("the third wrong code ends the process", async () => {
		await seed();
		await env.DB.prepare(
			"INSERT INTO auth_flows (session_hash, kind, code_hash, created_at, expires_at) VALUES (?, 'password_reset', 'right', 1, ?)",
		)
			.bind(session, 9e12)
			.run();
		const wrong = env.DB.prepare(
			"UPDATE auth_flows SET attempts = attempts + 1 WHERE session_hash = ? AND kind = 'password_reset' AND attempts < 3 RETURNING attempts",
		).bind(session);
		for (const expected of [1, 2, 3]) expect((await wrong.all()).results).toEqual([{ attempts: expected }]);
		expect((await wrong.all()).results).toEqual([]);
		const right = await env.DB.prepare(
			"DELETE FROM auth_flows WHERE session_hash = ? AND kind = 'password_reset' AND code_hash = 'right' AND attempts < 3 RETURNING kind",
		)
			.bind(session)
			.all();
		expect(right.results).toEqual([]);
	});

	test("emails are unique and lowercased, workspaces personal iff owned, deletes cascade", async () => {
		await seed();
		await expect(env.DB.prepare("INSERT INTO emails (email, user_id, created_at) VALUES ('ada@example.com', ?, 1)").bind(USER).run()).rejects.toThrow(/UNIQUE/);
		await expect(env.DB.prepare("INSERT INTO emails (email, user_id, created_at) VALUES ('Ada@Example.com', ?, 1)").bind(USER).run()).rejects.toThrow(/CHECK/);
		await expect(
			env.DB.prepare("INSERT INTO workspaces (id, kind, name, created_at) VALUES ('0199a000-0000-7000-8000-0000000000dd', 'personal', 'P', 1)").run(),
		).rejects.toThrow(/CHECK/);
		await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(USER).run();
		const left = await env.DB.batch([
			env.DB.prepare("SELECT count(*) AS n FROM emails"),
			env.DB.prepare("SELECT count(*) AS n FROM memberships"),
			env.DB.prepare("SELECT count(*) AS n FROM workspaces"),
		]);
		expect(left.map((result) => (result.results[0] as { n: number }).n)).toEqual([0, 0, 0]);
	});

	test("an OAuth flow is popped once", async () => {
		await seed();
		await env.DB.prepare(
			"INSERT INTO oauth_flows (session_hash, state, verifier, provider, workspace_id, client_id, issued_at, expires_at) VALUES (?, 's', 'v', 'todoist', ?, 'c', 1, 600001)",
		)
			.bind(session, WS)
			.run();
		const pop = env.DB.prepare("DELETE FROM oauth_flows WHERE session_hash = ? RETURNING state").bind(session);
		expect((await pop.all()).results).toEqual([{ state: "s" }]);
		expect((await pop.all()).results).toEqual([]);
	});
});
