// Accounts on Better Auth in local workerd over D1 (plan: The web API): sign-up and recoverable
// provisioning, the session our routes read, /api/me, passwords, rate limits, the CSRF boundary between
// Better Auth's routes and ours, tenancy and the seed. Security policy (two-factor across sign-in
// methods, account-scoped limits, revocation) is step 5a3's and tested there.

import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";
import { currentSession, getAuth } from "../../src/accounts/auth.ts";
import { hashPassword } from "../../src/accounts/passwords.ts";
import { provision } from "../../src/accounts/provision.ts";
import { SEED_ACCOUNTS, seed } from "../../src/accounts/seed.ts";
import { workspaceObject } from "../../src/addressing.ts";
import { MAX_JSON_BODY } from "../../src/http/body.ts";
import { createApp } from "../../src/http/router.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { Browser, ORIGIN, PASSWORD, emailsTo, installEmailLog, lastCode, signUp, signedIn, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

const db = env.DB;

async function userId(email: string): Promise<string> {
	const row = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
	if (!row) throw new Error(`No user ${email}`);
	return row.id;
}

/** What provisioning made for the user, counted, and the user's pending state. */
async function provisioned(id: string) {
	const [orgs, members, workspaces, memberships, user] = await db.batch([
		db.prepare(`SELECT id FROM organization WHERE "personalOwner" = ?`).bind(id),
		db.prepare(`SELECT role FROM member m JOIN organization o ON o.id = m."organizationId" WHERE o."personalOwner" = ? AND m."userId" = ?`).bind(id, id),
		db.prepare("SELECT id, organization_id, initialized_at FROM workspaces WHERE personal_owner = ?").bind(id),
		db.prepare("SELECT m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE w.personal_owner = ? AND m.user_id = ?").bind(id, id),
		db.prepare(`SELECT "provisionedAt" AS at FROM "user" WHERE id = ?`).bind(id),
	]);
	const workspace = workspaces!.results[0] as { id: string; organization_id: string; initialized_at: number | null } | undefined;
	return {
		organizations: orgs!.results.length,
		members: members!.results as { role: string }[],
		workspaces: workspaces!.results.length,
		memberships: memberships!.results as { role: string }[],
		organizationOwnsWorkspace: workspace !== undefined && workspace.organization_id === (orgs!.results[0] as { id: string } | undefined)?.id,
		initialized: workspace?.initialized_at != null,
		pending: (user!.results[0] as { at: string | null } | undefined)?.at === null,
		workspaceId: workspace?.id,
	};
}

const COMPLETE = { organizations: 1, members: [{ role: "owner" }], workspaces: 1, memberships: [{ role: "owner" }], organizationOwnsWorkspace: true, initialized: true, pending: false };

/** A user Better Auth knows nothing happened to after: as if the Worker died right after inserting it. */
async function bareUser(email = uniqueEmail()): Promise<string> {
	const id = uuid7();
	const now = new Date().toISOString();
	await db.batch([
		db.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, '', ?, 1, ?, ?)`).bind(id, email, now, now),
		db
			.prepare(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, ?, ?, ?)`)
			.bind(uuid7(), id, id, await hashPassword(PASSWORD), now, now),
	]);
	return id;
}

describe("sign-up and provisioning", () => {
	test("sign-up provisions the organization, workspace and object; the address must be verified before signing in", async () => {
		const { browser, email } = await signUp();
		expect(emailsTo(email).map((sent) => sent.subject)).toEqual(["[Minerva] Please Confirm Your Email Address"]);
		const id = await userId(email);
		const made = await provisioned(id);
		expect(made).toMatchObject(COMPLETE);

		const stub = workspaceObject(env, { id: made.workspaceId!, jurisdiction: null });
		await runInDurableObject(stub, (_, state) => {
			const layers = state.storage.sql.exec("SELECT level, subject, restricted FROM layers ORDER BY level").toArray();
			expect(layers).toEqual([
				{ level: "ceiling", subject: null, restricted: 0 },
				{ level: "user", subject: id, restricted: 1 },
			]);
			const agents = state.storage.sql.exec("SELECT owner_id, name FROM agents").toArray();
			expect(agents).toEqual([{ owner_id: id, name: "Assistant" }]);
		});

		const early = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		expect(early.status).toBe(403);
		expect(early.body.code).toBe("EMAIL_NOT_VERIFIED");
		expect(early.response.headers.getSetCookie()).toEqual([]);

		expect((await browser.auth("/email-otp/verify-email", { email, otp: lastCode(email) })).status).toBe(200);
		const signed = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		expect(signed.status).toBe(200);
		const me = await browser.call("GET", "/api/me");
		expect(me.status).toBe(200);
		expect(me.body).toEqual({
			user: { id, email, name: "", is_staff: false },
			workspaces: [{ id: made.workspaceId, name: "Personal", kind: "personal", role: "owner" }],
			demo: null,
		});
	});

	test("the password is stored in our scrypt format", async () => {
		const { email } = await signUp();
		const row = await db.prepare(`SELECT password FROM account WHERE "userId" = ? AND "providerId" = 'credential'`).bind(await userId(email)).first<{ password: string }>();
		expect(row?.password).toMatch(/^scrypt\$15\$8\$3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
	});

	test("closed sign-up creates nothing", async () => {
		const closed = getAuth({ ...env, MINERVA_SIGNUP_OPEN: "false" });
		const email = uniqueEmail();
		await expect(closed.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } })).rejects.toThrow();
		expect(await db.prepare(`SELECT count(*) AS n FROM "user" WHERE email = ?`).bind(email).first()).toEqual({ n: 0 });
	});

	test("an email code never creates an account", async () => {
		const browser = new Browser();
		const email = uniqueEmail();
		await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" });
		const answer = await browser.auth("/sign-in/email-otp", { email, otp: "000000" });
		expect(answer.status).toBeGreaterThanOrEqual(400);
		expect(await db.prepare(`SELECT count(*) AS n FROM "user" WHERE email = ?`).bind(email).first()).toEqual({ n: 0 });
	});

	test("the admin plugin's createUser is provisioned like a sign-up", async () => {
		const email = uniqueEmail();
		const created = await getAuth(env).api.createUser({ body: { email, password: PASSWORD, name: "", role: "user" } });
		expect(await provisioned(created.user.id)).toMatchObject(COMPLETE);
	});
});

describe("provisioning recovers", () => {
	test("a user left without anything is provisioned on their next sign-in", async () => {
		const email = uniqueEmail();
		const id = await bareUser(email);
		expect(await provisioned(id)).toMatchObject({ organizations: 0, workspaces: 0, pending: true });
		const browser = new Browser();
		expect((await browser.auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		expect(await provisioned(id)).toMatchObject(COMPLETE);
		expect((await browser.call("GET", "/api/me")).body.workspaces).toHaveLength(1);
	});

	test("/api/me finishes a pending user: an object never initialized, a lost membership, a lost workspace", async () => {
		const { browser, userId: id } = await signedIn();
		const first = await provisioned(id);

		// The object was never initialized and provisioning was never marked done.
		await db.batch([
			db.prepare("UPDATE workspaces SET initialized_at = NULL WHERE personal_owner = ?").bind(id),
			db.prepare(`UPDATE "user" SET "provisionedAt" = NULL WHERE id = ?`).bind(id),
		]);
		let me = await browser.call("GET", "/api/me");
		expect(me.body.workspaces).toEqual([{ id: first.workspaceId, name: "Personal", kind: "personal", role: "owner" }]);
		expect(await provisioned(id)).toMatchObject(COMPLETE);
		await runInDurableObject(workspaceObject(env, { id: first.workspaceId!, jurisdiction: null }), (_, state) => {
			expect(state.storage.sql.exec("SELECT count(*) AS n FROM agents").one().n).toBe(1);
		});

		// The batch's later rows were lost (a membership, a member): they come back, nothing doubles.
		await db.batch([
			db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(id),
			db.prepare(`DELETE FROM member WHERE "userId" = ?`).bind(id),
			db.prepare(`UPDATE "user" SET "provisionedAt" = NULL WHERE id = ?`).bind(id),
		]);
		me = await browser.call("GET", "/api/me");
		expect(me.body.workspaces.map((ws: { id: string }) => ws.id)).toEqual([first.workspaceId]);
		expect(await provisioned(id)).toMatchObject(COMPLETE);

		// The workspace row itself is missing: a new one is made under the same organization.
		await db.batch([db.prepare("DELETE FROM workspaces WHERE personal_owner = ?").bind(id), db.prepare(`UPDATE "user" SET "provisionedAt" = NULL WHERE id = ?`).bind(id)]);
		me = await browser.call("GET", "/api/me");
		const after = await provisioned(id);
		expect(after).toMatchObject(COMPLETE);
		expect(after.workspaceId).not.toBe(first.workspaceId);
		expect(me.body.workspaces.map((ws: { id: string }) => ws.id)).toEqual([after.workspaceId]);
	});

	test("concurrent provisioning makes one of each", async () => {
		const id = await bareUser();
		const workspaces = await Promise.all(Array.from({ length: 5 }, () => provision(env, id)));
		expect(new Set(workspaces.map((ws) => ws.id)).size).toBe(1);
		expect(await provisioned(id)).toMatchObject(COMPLETE);
	});
});

describe("sessions and /api/me", () => {
	test("/api/me is 401 without a session and after signing out", async () => {
		expect((await new Browser().call("GET", "/api/me")).body).toEqual({ detail: "Unauthorized" });
		const { browser } = await signedIn();
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		expect((await browser.auth("/sign-out", {})).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("the session cookie is host-only, HttpOnly and Lax; a cookie the client chose is never a session", async () => {
		const forged = "attacker-chosen-token";
		const { email } = await signUp();
		await new Browser().auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		const browser = new Browser();
		browser.cookies.set("minerva.session_token", forged);
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		browser.cookies.clear();
		const signed = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		const cookie = signed.response.headers.getSetCookie().find((value) => value.startsWith("minerva.session_token="));
		expect(cookie).toMatch(/; HttpOnly/);
		expect(cookie).toMatch(/; SameSite=Lax/i);
		expect(cookie).not.toMatch(/Domain=/i);
		expect(browser.cookies.get("minerva.session_token")).not.toContain(forged);
	});

	test("a session deleted in D1 ends on the next request (no cookie cache)", async () => {
		const { browser, userId: id } = await signedIn();
		await db.prepare(`DELETE FROM session WHERE "userId" = ?`).bind(id).run();
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
	});

	test("a request whose query never answers holds up no other request's session (a client that left)", async () => {
		const { browser, userId } = await signedIn();
		const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		// One bindings object for both requests, as in an isolate. Better Auth's first query for the first
		// request never answers, as a query of a request cancelled when its client left does not.
		let stalled = false;
		const isolate = { ...env, DB: stallingFirstQuery(env.DB, () => (stalled ? false : (stalled = true))) } as Env;
		const request = () => new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } });
		void currentSession(isolate, request());
		await vi.waitFor(() => expect(stalled).toBe(true));
		const second = await Promise.race([currentSession(isolate, request()), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))]);
		expect(second?.user?.id).toBe(userId);
	}, 20_000);

	test("a session Better Auth extends while our route reads it sends its new cookie with our answer", async () => {
		const { browser, userId: id } = await signedIn();
		// Last extended more than a day ago (`updateAge`): reading it extends it.
		await db.prepare(`UPDATE session SET "expiresAt" = ? WHERE "userId" = ?`).bind(new Date(Date.now() + 86_400_000).toISOString(), id).run();
		const me = await browser.call("GET", "/api/me");
		expect(me.status).toBe(200);
		expect(me.response.headers.getSetCookie().some((cookie) => cookie.startsWith("minerva.session_token="))).toBe(true);
	});
});

describe("passwords and rate limits", () => {
	test("an unknown address answers as a wrong password and costs a hash", async () => {
		const { email } = await signedIn();
		const time = async (address: string) => {
			const started = performance.now();
			const answer = await new Browser().auth("/sign-in/email", { email: address, password: "not the passphrase" });
			return { answer, ms: performance.now() - started };
		};
		const wrong = await time(email);
		const unknown = await time(uniqueEmail());
		expect(unknown.answer.status).toBe(wrong.answer.status);
		expect(unknown.answer.body).toEqual(wrong.answer.body);
		// scrypt takes tens of milliseconds; skipping it would take one or two.
		expect(unknown.ms).toBeGreaterThan(wrong.ms / 3);
	});

	test("a hash with older scrypt parameters is replaced when it verifies; sessions stay", async () => {
		const { browser: before, email, userId: id } = await signedIn();
		const old = await hashPassword(PASSWORD, { logN: 14, r: 8, p: 1 });
		await db.prepare(`UPDATE account SET password = ? WHERE "userId" = ?`).bind(old, id).run();
		// Writing a hash is a password change as far as sessions go: the session made before it ends.
		expect((await before.call("GET", "/api/me")).status).toBe(401);
		// A session made while the old hash is stored (by an email code, which checks no password)...
		const browser = new Browser();
		expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
		expect((await browser.auth("/sign-in/email-otp", { email, otp: lastCode(email) })).status).toBe(200);
		const stored = async () => (await db.prepare(`SELECT password FROM account WHERE "userId" = ?`).bind(id).first<{ password: string }>())?.password;
		expect((await new Browser().auth("/sign-in/email", { email, password: "wrong passphrase" })).status).toBe(401);
		expect(await stored()).toBe(old);
		expect((await new Browser().auth("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
		expect(await stored()).toMatch(/^scrypt\$15\$8\$3\$/);
		// ...keeps working after the rehash: its stamp moved to the new hash with it.
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
	});

	test("sign-in attempts are limited per IP and counted in D1", async () => {
		const browser = new Browser();
		const statuses = [];
		for (let i = 0; i < 4; i++) statuses.push((await browser.auth("/sign-in/email", { email: uniqueEmail(), password: "wrong passphrase" })).status);
		expect(statuses).toEqual([401, 401, 401, 429]);
		const rows = await db.prepare(`SELECT count(*) AS n FROM "rateLimit" WHERE key LIKE ?`).bind(`%${browser.ip}%`).first<{ n: number }>();
		expect(rows?.n).toBeGreaterThan(0);
	});
});

describe("CSRF: Better Auth's origins on its routes, our token on ours", () => {
	test("Better Auth's routes need the site's Origin, not our token", async () => {
		const { email } = await signUp();
		await new Browser().auth("/email-otp/verify-email", { email, otp: lastCode(email) });
		const answer = await new Browser().auth("/sign-in/email", { email, password: PASSWORD });
		expect(answer.status).toBe(200);
	});

	test("hostile, missing and null origins, cross-site form posts and foreign callbacks are refused", async () => {
		const { browser } = await signedIn();
		const evil = "https://evil.example";
		for (const headers of [{ Origin: evil }, { Origin: "null" }]) {
			const answer = await browser.auth("/sign-out", {}, headers);
			expect(answer.status, JSON.stringify(headers)).toBe(403);
		}
		// No Origin at all, with the session cookie.
		const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		const bare = await exports.default.fetch(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": browser.ip }, body: "{}" }));
		expect(bare.status).toBe(403);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);

		const stranger = new Browser();
		expect((await stranger.auth("/sign-in/email", { email: uniqueEmail(), password: PASSWORD }, { Origin: evil })).status).toBe(403);
		const form = await stranger.call("POST", "/api/auth/sign-in/email", `email=${encodeURIComponent(uniqueEmail())}&password=x`, {
			Origin: evil,
			"Content-Type": "application/x-www-form-urlencoded",
			"Sec-Fetch-Site": "cross-site",
			"Sec-Fetch-Mode": "navigate",
		});
		expect(form.status).toBe(403);
		const callback = await stranger.auth("/sign-in/email", { email: uniqueEmail(), password: PASSWORD, callbackURL: `${evil}/next` });
		expect(callback.status).toBe(403);
	});

	test("our routes still need the token, even signed in", async () => {
		const { browser } = await signedIn();
		const answer = await browser.call("POST", "/api/dev/seed");
		expect(answer.status).toBe(403);
		expect(answer.body).toEqual({ detail: "CSRF check Failed" });
	});

	test("Better Auth's JSON is read as parseJson reads it: escaped keys are read right, keys needing escapes are refused", async () => {
		const { email } = await signedIn();
		const escaped = `{"\\u0065mail": ${JSON.stringify(email)}, "password": ${JSON.stringify(PASSWORD)}}`;
		expect((await new Browser().auth("/sign-in/email", escaped)).status).toBe(200);
		const refused = await new Browser().auth("/sign-in/email", `{"\\\\": 1, "email": ${JSON.stringify(email)}, "password": ${JSON.stringify(PASSWORD)}}`);
		expect(refused.status).toBe(400);
		expect(refused.body).toEqual({ detail: "Cannot parse request body" });
		// Better Auth parses every media type naming JSON, so each is read the same way.
		for (const type of ["application/problem+json", "application/jsonx", "Application/JSON; charset=utf-8"]) {
			const other = await new Browser().auth("/sign-in/email", `{"\\\\": 1}`, { "Content-Type": type });
			expect(other.status, type).toBe(400);
			expect(other.body, type).toEqual({ detail: "Cannot parse request body" });
		}
	});

	test("bodies over 2.5 MB are 413 on Better Auth's routes, declared or streamed", async () => {
		const declared = await new Browser().auth("/sign-in/email", "x", { "Content-Length": String(MAX_JSON_BODY + 1) });
		expect(declared.status).toBe(413);
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ < 3) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const streamed = await exports.default.fetch(
			new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit),
		);
		expect(streamed.status).toBe(413);
		expect(await streamed.json()).toEqual({ detail: "The request is too large." });
	});
});

describe("tenancy (test_tenancy)", () => {
	test("two users' workspaces see only their own agent", async () => {
		const agents = [];
		for (const name of ["ada", "grace"]) {
			const { email } = await signUp(uniqueEmail(name));
			const id = await userId(email);
			const { workspaceId } = await provisioned(id);
			const listed = await workspaceObject(env, { id: workspaceId!, jurisdiction: null }).listAgents({ userId: id, role: "owner" });
			expect(listed).toHaveLength(1);
			agents.push(listed[0]!.id);
		}
		expect(new Set(agents).size).toBe(2);
		// An object refusing another workspace's identity is test/unit/workspace-tenancy.test.ts.
	});
});

describe("seed (test_seed)", () => {
	test("with debug, seeding twice is idempotent, removes two-factor and signs the accounts out", async () => {
		expect(await seed(env)).toEqual(["created  ada@example.com", "created  grace@example.com", "Password for all seed accounts: password"]);
		const ada = await userId("ada@example.com");
		// Signed in before two-factor is on (after it, a password stops at the second factor).
		const browser = new Browser();
		expect((await browser.auth("/sign-in/email", { email: "ada@example.com", password: "password" })).status).toBe(200);
		expect((await browser.call("GET", "/api/me")).status).toBe(200);
		await db.batch([
			db.prepare(`INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId") VALUES (?, 's', 'b', ?)`).bind(uuid7(), ada),
			db.prepare(`UPDATE "user" SET "twoFactorEnabled" = 1 WHERE id = ?`).bind(ada),
		]);
		expect(await seed(env)).toEqual(["reset  ada@example.com", "reset  grace@example.com", "Password for all seed accounts: password"]);
		expect(await db.prepare(`SELECT count(*) AS n FROM "twoFactor" WHERE "userId" = ?`).bind(ada).first()).toEqual({ n: 0 });
		for (const [email, name] of SEED_ACCOUNTS) {
			const row = await db.prepare(`SELECT id, name, "emailVerified" AS verified, "twoFactorEnabled" AS tfa FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
			expect(row).toMatchObject({ name, verified: 1, tfa: 0 });
			expect(await provisioned(row!.id)).toMatchObject(COMPLETE);
		}
		// Reseeding signed the earlier session out; the password still works.
		expect((await browser.call("GET", "/api/me")).status).toBe(401);
		expect((await new Browser().auth("/sign-in/email", { email: "grace@example.com", password: "password" })).status).toBe(200);
	});

	test("without debug, seeding errors and creates no users", async () => {
		const before = await db.prepare(`SELECT count(*) AS n FROM "user"`).first();
		await expect(seed({ ...env, MINERVA_DEBUG: "false" })).rejects.toThrow("Seed accounts have a known password; this only runs with MINERVA_DEBUG=true.");
		expect(await db.prepare(`SELECT count(*) AS n FROM "user"`).first()).toEqual(before);
		const app = createApp();
		const deployed = { ...env, MINERVA_DEBUG: "false", EMAIL: { send: async () => ({ messageId: "m" }) } as unknown as SendEmail };
		const browser = await new Browser((request) => Promise.resolve(app.fetch(request, deployed, createExecutionContext()))).start();
		expect((await browser.call("POST", "/api/dev/seed")).status).toBe(404);
	});
});

/** D1 whose Better Auth query (Kysely writes lowercase SQL) never answers while `stall()` says so. */
function stallingFirstQuery(db: D1Database, stall: () => boolean): D1Database {
	const statement = (prepared: D1PreparedStatement, sql: string): D1PreparedStatement =>
		new Proxy(prepared, {
			get(target, property) {
				if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql);
				if (property === "all" && sql.startsWith("select ") && stall()) return () => new Promise(() => {});
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	return new Proxy(db, {
		get(target, property) {
			if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
