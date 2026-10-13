// The instance's administration (src/accounts/instance.ts, instance-routes.ts): the first-run setup claimed
// once, also by concurrent requests, the instance admin apart from organization and workspace roles (and
// without the admin plugin's endpoints), the admins' list and sign-up setting, and the setup key admitting
// the operator's sign-up by email code on a closed instance until setup is done.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { ADMINS_ONLY, ALREADY_SET_UP, INVALID_KEY, LAST_ADMIN, NO_SUCH_USER, SETUP_KEY_HEADER, claimSetup } from "../../src/accounts/instance.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { RefusalCode } from "../../src/shared/rpc.ts";
import { type Answer, Browser, emailsTo, installEmailLog, lastCode, signedIn, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

const KEY = env.MINERVA_SETUP_KEY;

/** Signs up by email code as the sign-up page does (the headers on both requests): the code sign-in's status. */
async function signUp(email: string, headers: Record<string, string> = {}, browser = new Browser()): Promise<number> {
	expect((await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" }, headers)).status).toBe(200);
	// While sign-up is closed no code is sent; a guess stands in for it.
	const sent = emailsTo(email).length > 0;
	return (await browser.auth("/sign-in/email-otp", { email, otp: sent ? lastCode(email) : "000000" }, headers)).status;
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM instance_setup"),
		env.DB.prepare("DELETE FROM instance_settings"),
		env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE role = 'admin'`),
	]);
});

interface User {
	browser: Browser;
	userId: string;
	email: string;
}

async function user(name = "ada"): Promise<User> {
	const { browser, userId, email } = await signedIn(uniqueEmail(name));
	return { browser, userId, email };
}

function expectRefusal(answer: Answer, status: number, code: RefusalCode, detail: string): void {
	expect([answer.status, answer.body], JSON.stringify(answer.body)).toEqual([status, { code, detail }]);
}

async function isStaff(u: User): Promise<boolean> {
	return (await u.browser.call("GET", "/api/me")).body.user.role === "admin";
}

async function admins(): Promise<string[]> {
	return (await env.DB.prepare(`SELECT id FROM "user" WHERE role = 'admin' ORDER BY id`).all<{ id: string }>()).results.map((row) => row.id);
}

async function setUp(u: User): Promise<void> {
	expect((await u.browser.call("POST", "/api/setup", { key: KEY })).status).toBe(204);
}

describe("first-run setup", () => {
	test("the first signed-in user to present the setup key becomes the instance admin, once", async () => {
		const ada = await user();
		const grace = await user("grace");
		const anonymous = new Browser();
		expect((await anonymous.call("GET", "/api/setup")).body).toEqual({ needed: true });
		expect((await anonymous.call("POST", "/api/setup", { key: KEY })).status).toBe(401);
		// The router's CSRF check comes first, as for every unsafe route.
		expect((await ada.browser.call("POST", "/api/setup", { key: KEY }, { Origin: "https://evil.example" })).status).toBe(403);
		expectRefusal(await ada.browser.call("POST", "/api/setup", { key: "wrong" }), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		expectRefusal(await ada.browser.call("POST", "/api/setup", { key: KEY.slice(0, -1) }), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		expectRefusal(await ada.browser.call("POST", "/api/setup", { key: `${KEY} ` }), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		expect((await ada.browser.call("POST", "/api/setup")).status).toBe(415);
		expect((await ada.browser.call("POST", "/api/setup", "")).status).toBe(422);
		expect(await admins()).toEqual([]);

		await setUp(ada);
		expect(await isStaff(ada)).toBe(true);
		expect((await anonymous.call("GET", "/api/setup")).body).toEqual({ needed: false });
		expectRefusal(await grace.browser.call("POST", "/api/setup", { key: KEY }), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
		expectRefusal(await ada.browser.call("POST", "/api/setup", { key: KEY }), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
		expect(await isStaff(grace)).toBe(false);
		expect(await admins()).toEqual([ada.userId]);
		// Setup stays done when its admin is removed or deleted.
		await env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE id = ?`).bind(ada.userId).run();
		expectRefusal(await grace.browser.call("POST", "/api/setup", { key: KEY }), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
	});

	test("of concurrent claims, by several users or one, exactly one makes an admin", async () => {
		const users = await Promise.all(["ada", "grace", "alan", "edsger", "barbara"].map((name) => user(name)));
		const statuses = await Promise.all(users.map((u) => u.browser.call("POST", "/api/setup", { key: KEY }).then((answer) => answer.status)));
		expect(statuses.filter((status) => status === 204)).toHaveLength(1);
		expect(statuses.filter((status) => status === 409)).toHaveLength(4);
		expect(await admins()).toEqual([users[statuses.indexOf(204)]!.userId]);

		await env.DB.batch([env.DB.prepare("DELETE FROM instance_setup"), env.DB.prepare(`UPDATE "user" SET role = 'user'`)]);
		const ada = users[0]!;
		const same = await Promise.all(Array.from({ length: 4 }, () => ada.browser.call("POST", "/api/setup", { key: KEY }).then((answer) => answer.status)));
		expect(same.sort()).toEqual([204, 409, 409, 409]);
		// The claim itself, without the HTTP layer around it.
		await env.DB.batch([env.DB.prepare("DELETE FROM instance_setup"), env.DB.prepare(`UPDATE "user" SET role = 'user'`)]);
		const claims = await Promise.all(users.map((u) => claimSetup(env.DB, u.userId)));
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await admins()).toEqual([users[claims.indexOf(true)]!.userId]);
	});

	test("on a closed instance the setup key admits the operator's sign-up until setup is done", async () => {
		await env.DB.prepare("INSERT INTO instance_settings (id, signup_open, updated_at) VALUES (1, 0, ?)").bind(Date.now()).run();
		const email = uniqueEmail("operator");
		expect(await signUp(email)).toBe(400);
		expect(await signUp(email, { [SETUP_KEY_HEADER]: "wrong" })).toBe(400);
		const browser = new Browser();
		expect(await signUp(email, { [SETUP_KEY_HEADER]: KEY }, browser)).toBe(200);
		const operator = { browser, userId: (await browser.call("GET", "/api/me")).body.user.id as string, email };
		await setUp(operator);
		expect(await isStaff(operator)).toBe(true);
		// Setup done: the key admits nobody any more.
		const late = uniqueEmail("late");
		expect(await signUp(late, { [SETUP_KEY_HEADER]: KEY })).toBe(400);
		const created = await env.DB.prepare(`SELECT count(*) AS n FROM "user" WHERE email IN (?, ?)`).bind(email, late).first<{ n: number }>();
		expect(created?.n).toBe(1);
	});
});

describe("the instance admin", () => {
	test("is apart from organization and workspace roles, and reaches none of the admin plugin's endpoints", async () => {
		const ada = await user();
		const grace = await user("grace");
		await setUp(ada);
		// Grace owns her personal workspace and organization: no instance admin for that.
		expectRefusal(await grace.browser.call("GET", "/api/instance/settings"), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		expectRefusal(await grace.browser.call("GET", "/api/instance/admins"), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		// Ada administers the instance, not Grace's workspace.
		const graceWs = (await grace.browser.call("GET", "/api/me")).body.workspaces[0].id;
		expect((await ada.browser.call("GET", `/api/workspaces/${graceWs}/connections`)).status).toBe(401);
		for (const path of ["/admin/set-role", "/admin/impersonate-user", "/admin/remove-user", "/admin/ban-user", "/admin/create-user", "/admin/set-user-password"]) {
			expect((await ada.browser.auth(path, { userId: grace.userId, role: "admin" })).status, path).toBe(404);
		}
		expect((await ada.browser.auth("/admin/list-users")).status).toBe(404);
		// Nobody names themselves admin through sign-up or their profile.
		const email = uniqueEmail("mallory");
		const mallory = new Browser();
		await mallory.auth("/email-otp/send-verification-otp", { email, type: "sign-in" });
		await mallory.auth("/sign-in/email-otp", { email, otp: lastCode(email), role: "admin" });
		const row = await env.DB.prepare(`SELECT role FROM "user" WHERE email = ?`).bind(email).first<{ role: string | null }>();
		expect(row?.role ?? null).not.toBe("admin");
		await grace.browser.auth("/update-user", { role: "admin" });
		expect(await isStaff(grace)).toBe(false);
		expect(await admins()).toEqual([ada.userId]);
	});

	test("names and removes admins; the last one stays, also when two remove each other at once", async () => {
		const ada = await user();
		const grace = await user("grace");
		await setUp(ada);
		const listed = (await ada.browser.call("GET", "/api/instance/admins")).body;
		expect(listed).toEqual([{ id: ada.userId, email: ada.email, name: "" }]);
		const added = await ada.browser.call("POST", "/api/instance/admins", { email: ` ${grace.email.toUpperCase()} ` });
		expect(added.status).toBe(200);
		expect(added.body.map((a: { id: string }) => a.id).sort()).toEqual([ada.userId, grace.userId].sort());
		expect(await isStaff(grace)).toBe(true);
		expectRefusal(await ada.browser.call("POST", "/api/instance/admins", { email: "nobody@example.com" }), 404, "NO_SUCH_USER", NO_SUCH_USER);
		expect((await ada.browser.call("DELETE", `/api/instance/admins/${uuid7()}`)).status).toBe(404);

		expect((await grace.browser.call("DELETE", `/api/instance/admins/${ada.userId}`)).status).toBe(204);
		// The role is read on every request.
		expectRefusal(await ada.browser.call("GET", "/api/instance/admins"), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		expectRefusal(await grace.browser.call("DELETE", `/api/instance/admins/${grace.userId}`), 422, "KEEP_ONE_ADMIN", LAST_ADMIN);

		expect((await grace.browser.call("POST", "/api/instance/admins", { email: ada.email })).status).toBe(200);
		const [one, two] = await Promise.all([
			ada.browser.call("DELETE", `/api/instance/admins/${grace.userId}`),
			grace.browser.call("DELETE", `/api/instance/admins/${ada.userId}`),
		]);
		expect([one.status, two.status].filter((status) => status === 204)).toHaveLength(1);
		expect([one.status, two.status].filter((status) => status === 422 || status === 403)).toHaveLength(1);
		expect(await admins()).toHaveLength(1);
	});

	test("a change already past the role check does nothing once its caller lost the role", async () => {
		const ada = await user();
		const grace = await user("grace");
		await setUp(ada);
		expect((await ada.browser.call("POST", "/api/instance/admins", { email: grace.email })).status).toBe(200);
		// Ada's request to name herself admin again waits for its body, after the route checked her role.
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await released;
				controller.enqueue(new TextEncoder().encode(JSON.stringify({ email: ada.email })));
				controller.close();
			},
		});
		const headers = { "Content-Type": "application/json" };
		const pending = ada.browser.fetch("/api/instance/admins", { method: "POST", body, headers, duplex: "half" } as RequestInit);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await grace.browser.call("DELETE", `/api/instance/admins/${ada.userId}`)).status).toBe(204);
		release();
		const answer = await pending;
		expect([answer.status, await answer.json()]).toEqual([403, { code: "INSTANCE_ADMINS_ONLY", detail: ADMINS_ONLY }]);
		expect(await admins()).toEqual([grace.userId]);
	});

	test("opens and closes sign-up at run time; null follows MINERVA_SIGNUP_OPEN", async () => {
		const ada = await user();
		const grace = await user("grace");
		expect((await new Browser().call("GET", "/api/instance/settings")).status).toBe(401);
		await setUp(ada);
		expect((await ada.browser.call("GET", "/api/instance/settings")).body).toEqual({ signup_open: true, signup_open_override: null, signup_open_configured: true });
		const closed = await ada.browser.call("PATCH", "/api/instance/settings", { signup_open: false });
		expect(closed.body).toEqual({ signup_open: false, signup_open_override: false, signup_open_configured: true });
		const email = uniqueEmail("late");
		expect(await signUp(email)).toBe(400);
		expect(await env.DB.prepare(`SELECT 1 FROM "user" WHERE email = ?`).bind(email).first()).toBeNull();

		expect((await ada.browser.call("PATCH", "/api/instance/settings", { signup_open: null })).body.signup_open).toBe(true);
		expect(await signUp(email)).toBe(200);
		expect((await ada.browser.call("PATCH", "/api/instance/settings", { signup_open: "no" })).status).toBe(422);
		expect((await ada.browser.call("PATCH", "/api/instance/settings", {})).status).toBe(422);
		expectRefusal(await grace.browser.call("PATCH", "/api/instance/settings", { signup_open: false }), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		expect((await ada.browser.call("GET", "/api/instance/settings")).body.signup_open).toBe(true);
	});
});
