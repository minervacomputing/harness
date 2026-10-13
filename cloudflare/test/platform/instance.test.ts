// The instance's administration (src/accounts/instance.ts, api/accounts.ts): the first-run setup claimed
// once, also by concurrent requests, the instance admin apart from organization and workspace roles (and
// without the admin plugin's endpoints), the admins' list and sign-up setting, and the setup key admitting
// the operator's sign-up by email code on a closed instance until setup is done, and an admin removing a user's two-factor.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { ADMINS_ONLY, ALREADY_SET_UP, INVALID_KEY, LAST_ADMIN, NO_SUCH_USER, OWN_TWO_FACTOR, SETUP_KEY_HEADER, claimSetup } from "../../src/accounts/instance.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { RefusalCode } from "../../src/shared/rpc.ts";
import { type Answer, Browser, PASSWORD, contractError, emailsTo, enableTwoFactor, installEmailLog, lastCode, signedIn, totp, uniqueEmail } from "./accounts-helpers.ts";

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

function expectRefusal(answer: Answer, status: number, code: RefusalCode, message: string): void {
	expect([answer.status, answer.body], JSON.stringify(answer.body)).toEqual([status, contractError(code, message)]);
}

/** Claims the setup with `key` in its header, as the frontend sends it. */
function claim(u: { browser: Browser }, key: string, headers: Record<string, string> = {}): Promise<Answer> {
	return u.browser.call("POST", "/api/setup", undefined, { [SETUP_KEY_HEADER]: key, ...headers });
}

async function isStaff(u: User): Promise<boolean> {
	return (await u.browser.call("GET", "/api/me")).body.user.role === "admin";
}

async function admins(): Promise<string[]> {
	return (await env.DB.prepare(`SELECT id FROM "user" WHERE role = 'admin' ORDER BY id`).all<{ id: string }>()).results.map((row) => row.id);
}

async function setUp(u: User): Promise<void> {
	expect((await claim(u, KEY)).status).toBe(204);
}

describe("first-run setup", () => {
	test("the first signed-in user to present the setup key becomes the instance admin, once", async () => {
		const ada = await user();
		const grace = await user("grace");
		const anonymous = new Browser();
		expect((await anonymous.call("GET", "/api/setup")).body).toEqual({ needed: true });
		expectRefusal(await claim({ browser: anonymous }, KEY), 401, "UNAUTHORIZED", "Unauthorized");
		// The router's CSRF check comes first, as for every unsafe route.
		expect((await claim(ada, KEY, { Origin: "https://evil.example" })).status).toBe(403);
		expectRefusal(await claim(ada, "wrong"), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		expectRefusal(await claim(ada, KEY.slice(0, -1)), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		expectRefusal(await claim(ada, `${KEY}x`), 403, "INVALID_SETUP_KEY", INVALID_KEY);
		// The key goes in its header only: in a body it is not read.
		const inBody = await ada.browser.call("POST", "/api/setup", { key: KEY });
		expect([inBody.status, inBody.body.code, inBody.body.data.issues[0].path]).toEqual([422, "VALIDATION_FAILED", ["headers", "x-minerva-setup-key"]]);
		expect((await ada.browser.call("POST", "/api/setup")).status).toBe(422);
		expect(await admins()).toEqual([]);

		await setUp(ada);
		expect(await isStaff(ada)).toBe(true);
		expect((await anonymous.call("GET", "/api/setup")).body).toEqual({ needed: false });
		expectRefusal(await claim(grace, KEY), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
		expectRefusal(await claim(ada, KEY), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
		expect(await isStaff(grace)).toBe(false);
		expect(await admins()).toEqual([ada.userId]);
		// Setup stays done when its admin is removed or deleted.
		await env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE id = ?`).bind(ada.userId).run();
		expectRefusal(await claim(grace, KEY), 409, "ALREADY_SET_UP", ALREADY_SET_UP);
	});

	test("of concurrent claims, by several users or one, exactly one makes an admin", async () => {
		const users = await Promise.all(["ada", "grace", "alan", "edsger", "barbara"].map((name) => user(name)));
		const statuses = await Promise.all(users.map((u) => claim(u, KEY).then((answer) => answer.status)));
		expect(statuses.filter((status) => status === 204)).toHaveLength(1);
		expect(statuses.filter((status) => status === 409)).toHaveLength(4);
		expect(await admins()).toEqual([users[statuses.indexOf(204)]!.userId]);

		await env.DB.batch([env.DB.prepare("DELETE FROM instance_setup"), env.DB.prepare(`UPDATE "user" SET role = 'user'`)]);
		const ada = users[0]!;
		const same = await Promise.all(Array.from({ length: 4 }, () => claim(ada, KEY).then((answer) => answer.status)));
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
		expect([answer.status, await answer.json()]).toEqual([403, contractError("INSTANCE_ADMINS_ONLY", ADMINS_ONLY)]);
		expect(await admins()).toEqual([grace.userId]);
	});

	test("opens and closes sign-up at run time; null follows MINERVA_SIGNUP_OPEN", async () => {
		const ada = await user();
		const grace = await user("grace");
		expect((await new Browser().call("GET", "/api/instance/settings")).status).toBe(401);
		await setUp(ada);
		expect((await ada.browser.call("GET", "/api/instance/settings")).body).toEqual({ signupOpen: true, signupOpenOverride: null, signupOpenConfigured: true });
		const closed = await ada.browser.call("PATCH", "/api/instance/settings", { signupOpen: false });
		expect(closed.body).toEqual({ signupOpen: false, signupOpenOverride: false, signupOpenConfigured: true });
		const email = uniqueEmail("late");
		expect(await signUp(email)).toBe(400);
		expect(await env.DB.prepare(`SELECT 1 FROM "user" WHERE email = ?`).bind(email).first()).toBeNull();

		expect((await ada.browser.call("PATCH", "/api/instance/settings", { signupOpen: null })).body.signupOpen).toBe(true);
		expect(await signUp(email)).toBe(200);
		expect((await ada.browser.call("PATCH", "/api/instance/settings", { signupOpen: "no" })).status).toBe(422);
		expect((await ada.browser.call("PATCH", "/api/instance/settings", {})).status).toBe(422);
		expectRefusal(await grace.browser.call("PATCH", "/api/instance/settings", { signupOpen: false }), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		expect((await ada.browser.call("GET", "/api/instance/settings")).body.signupOpen).toBe(true);
	});
});

describe("an admin removes a user's two-factor", () => {
	const REMOVE = "/api/instance/users/remove-two-factor";

	/** What the user's two-factor left in D1: authenticators, pending challenges, trusted devices, sessions, and the flag. */
	async function stored(userId: string) {
		const count = async (sql: string) => (await env.DB.prepare(sql).bind(userId).first<{ n: number }>())!.n;
		return {
			authenticators: await count(`SELECT count(*) AS n FROM "twoFactor" WHERE "userId" = ?`),
			challenges: await count(`SELECT count(*) AS n FROM verification WHERE identifier LIKE '2fa-%' AND value = ?`),
			trustedDevices: await count(`SELECT count(*) AS n FROM verification WHERE identifier LIKE 'trust-device-%' AND value = ?`),
			sessions: await count(`SELECT count(*) AS n FROM session WHERE "userId" = ?`),
			enabled: Boolean(await count(`SELECT coalesce("twoFactorEnabled", 0) AS n FROM "user" WHERE id = ?`)),
		};
	}

	/** A first factor by password in a new browser (or the one given): whether the second factor is asked for. */
	async function passwordStep(email: string, browser = new Browser()): Promise<{ browser: Browser; challenged: boolean }> {
		const step = await browser.auth("/sign-in/email", { email, password: PASSWORD });
		expect(step.status, JSON.stringify(step.body)).toBe(200);
		return { browser, challenged: step.body.twoFactorRedirect === true };
	}

	test("removes the authenticator, backup codes, challenges, trusted devices and sessions; the password alone signs in", async () => {
		const ada = await user();
		await setUp(ada);
		const grace = await user("grace");
		const { uri, backupCodes } = await enableTwoFactor(grace.browser);
		const alan = await user("alan");
		await enableTwoFactor(alan.browser);
		// A device trusted for 30 days (Better Auth's `trustDevice`, which our client never sends), and a challenge left open.
		const trusted = await passwordStep(grace.email);
		expect(trusted.challenged).toBe(true);
		expect((await trusted.browser.auth("/two-factor/verify-totp", { code: await totp(uri), trustDevice: true })).status).toBe(200);
		const pending = await passwordStep(grace.email);
		expect(pending.challenged).toBe(true);
		expect(await stored(grace.userId)).toEqual({ authenticators: 1, challenges: 1, trustedDevices: 1, sessions: 2, enabled: true });
		const alanBefore = await stored(alan.userId);

		expect((await ada.browser.call("POST", REMOVE, { email: ` ${grace.email.toUpperCase()} ` })).status).toBe(204);
		expect(await stored(grace.userId)).toEqual({ authenticators: 0, challenges: 0, trustedDevices: 0, sessions: 0, enabled: false });
		for (const browser of [grace.browser, trusted.browser]) expect((await browser.call("GET", "/api/me")).status).toBe(401);
		const refused = await pending.browser.auth("/two-factor/verify-totp", { code: await totp(uri) });
		expect([refused.status, refused.body.code]).toEqual([401, "INVALID_TWO_FACTOR_COOKIE"]);
		// Only Grace's: Alan, the admin and their sessions are as they were.
		expect(await stored(alan.userId)).toEqual(alanBefore);
		expect((await ada.browser.call("GET", "/api/me")).status).toBe(200);

		const again = await passwordStep(grace.email);
		expect(again.challenged).toBe(false);
		expect((await again.browser.call("GET", "/api/me")).status).toBe(200);
		// Set up again, the old device is no longer trusted and the old backup codes are gone.
		const { uri: newUri } = await enableTwoFactor(again.browser);
		const returning = await passwordStep(grace.email, trusted.browser);
		expect(returning.challenged).toBe(true);
		expect((await returning.browser.auth("/two-factor/verify-backup-code", { code: backupCodes[1] })).status).not.toBe(200);
		expect((await returning.browser.auth("/two-factor/verify-totp", { code: await totp(newUri) })).status).toBe(200);

		// For an account without two-factor it only signs out.
		expect((await ada.browser.call("POST", REMOVE, { email: alan.email })).status).toBe(204);
		expect((await ada.browser.call("POST", REMOVE, { email: alan.email })).status).toBe(204);
		expect(await stored(alan.userId)).toEqual({ authenticators: 0, challenges: 0, trustedDevices: 0, sessions: 0, enabled: false });
	});

	test("refuses an unknown address, the caller's own account, a user who is not an admin, and another site", async () => {
		const ada = await user();
		await setUp(ada);
		const grace = await user("grace");
		await enableTwoFactor(grace.browser);
		await enableTwoFactor(ada.browser);
		expectRefusal(await ada.browser.call("POST", REMOVE, { email: "nobody@example.com" }), 404, "NO_SUCH_USER", NO_SUCH_USER);
		expectRefusal(await ada.browser.call("POST", REMOVE, { email: ada.email.toUpperCase() }), 422, "OWN_TWO_FACTOR", OWN_TWO_FACTOR);
		expectRefusal(await grace.browser.call("POST", REMOVE, { email: ada.email }), 403, "INSTANCE_ADMINS_ONLY", ADMINS_ONLY);
		expectRefusal(await new Browser().call("POST", REMOVE, { email: grace.email }), 401, "UNAUTHORIZED", "Unauthorized");
		expectRefusal(await ada.browser.call("POST", REMOVE, { email: grace.email }, { Origin: "https://evil.example" }), 403, "CROSS_SITE", "Cross-site request refused.");
		expect((await ada.browser.call("POST", REMOVE, { email: "" })).status).toBe(422);
		for (const u of [ada, grace]) {
			expect(await stored(u.userId)).toMatchObject({ authenticators: 1, enabled: true, sessions: 1 });
			expect((await u.browser.call("GET", "/api/me")).status).toBe(200);
		}
	});

	test("does nothing once its caller lost the role, even past the role check", async () => {
		const ada = await user();
		await setUp(ada);
		const grace = await user("grace");
		const alan = await user("alan");
		await enableTwoFactor(alan.browser);
		expect((await ada.browser.call("POST", "/api/instance/admins", { email: grace.email })).status).toBe(200);
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await released;
				controller.enqueue(new TextEncoder().encode(JSON.stringify({ email: alan.email })));
				controller.close();
			},
		});
		const headers = { "Content-Type": "application/json" };
		const pending = ada.browser.fetch(REMOVE, { method: "POST", body, headers, duplex: "half" } as RequestInit);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await grace.browser.call("DELETE", `/api/instance/admins/${ada.userId}`)).status).toBe(204);
		release();
		const answer = await pending;
		expect([answer.status, await answer.json()]).toEqual([403, contractError("INSTANCE_ADMINS_ONLY", ADMINS_ONLY)]);
		expect(await stored(alan.userId)).toMatchObject({ authenticators: 1, enabled: true, sessions: 1 });
	});
});
