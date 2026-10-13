// The frontend's calls to the instance routes (frontend/src/lib/instance.ts), its route guard
// (lib/guards.ts requireInstanceAdmin) and the sign-up that carries the operator's setup key
// (lib/auth.ts), run against the Worker through a Browser's cookie jar. They go through the generated API
// client with the interceptors the app installs, so the Origin check, the error shapes and the sentences
// the pages show are the real ones. No page is rendered; the browser walk (test/account) drives those.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Browser, ORIGIN, PASSWORD, installEmailLog, lastCode, signInWithCode, uniqueEmail } from "./accounts-helpers.ts";

installEmailLog();

const KEY = env.MINERVA_SETUP_KEY;

interface Frontend {
	auth: {
		signup(v: { email: string; password: string; setupKey?: string }): Promise<{ kind: string; pending?: string | null }>;
		verifyEmail(v: { code: string }): Promise<{ kind: string }>;
	};
	AuthError: new (...args: never[]) => Error & { fields: Record<string, string> };
	fieldErrors(error: unknown): Record<string, string>;
	setupQuery: { queryFn(context: { signal: AbortSignal }): Promise<{ needed: boolean }> };
	instance: {
		claimSetup(key: string): Promise<void>;
		updateSignupOpen(value: boolean | null): Promise<unknown>;
		addAdmin(email: string): Promise<Array<{ id: string; email: string; name: string }>>;
		removeAdmin(id: string): Promise<void>;
		instanceSettingsQuery: { queryFn(context: { signal: AbortSignal }): Promise<unknown> };
		instanceAdminsQuery: { queryFn(context: { signal: AbortSignal }): Promise<Array<{ id: string; email: string }>> };
	};
	errorMessage(error: unknown): string;
	requireInstanceAdmin(queryClient: unknown): Promise<void>;
	isNotFound(error: unknown): boolean;
	newQueryClient(): unknown;
}

let browser: Browser;
let frontend: Frontend;

class MemoryStorage {
	readonly #items = new Map<string, string>();
	getItem = (key: string) => this.#items.get(key) ?? null;
	setItem = (key: string, value: string) => void this.#items.set(key, value);
	removeItem = (key: string) => void this.#items.delete(key);
}

/** The page as it loads: fresh modules, this browser's cookies behind `fetch`, the interceptors main.tsx installs. */
async function load(next = new Browser()): Promise<void> {
	browser = next;
	vi.stubGlobal("fetch", browser.fetch);
	vi.resetModules();
	const [authModule, authClient, instance, guards, http, generated] = await Promise.all([
		// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
		import("@/lib/auth.ts"),
		// @ts-expect-error As above.
		import("@/lib/auth-client.ts"),
		// @ts-expect-error As above.
		import("@/lib/instance.ts"),
		// @ts-expect-error As above.
		import("@/lib/guards.ts"),
		// @ts-expect-error As above.
		import("@/lib/http.ts"),
		// @ts-expect-error As above.
		import("@/api/client.gen.ts"),
	]);
	// The app's client has an empty base URL (the page's origin); workerd needs an absolute one.
	generated.client.setConfig({ baseUrl: ORIGIN });
	http.installClientInterceptors(() => {});
	frontend = {
		auth: authModule.auth,
		AuthError: authClient.AuthError,
		fieldErrors: authClient.fieldErrors,
		setupQuery: instance.setupQuery,
		instance,
		errorMessage: http.errorMessage,
		requireInstanceAdmin: guards.requireInstanceAdmin,
		isNotFound: (error) => (error as { isNotFound?: unknown } | null)?.isNotFound === true,
		newQueryClient: () => {
			// react-query is the frontend's own package, not this project's; the guard only fetches `/api/me` through it.
			// Like the app's client (staleTime 10 s), this one answers from what it holds unless the call asks for fresh data.
			const held = new Map<string, unknown>();
			return {
				fetchQuery: async (options: { queryFn(context: { signal: AbortSignal; queryKey: unknown; client: unknown }): Promise<unknown>; queryKey: unknown; staleTime?: number }) => {
					const key = JSON.stringify(options.queryKey);
					if ((options.staleTime ?? 10_000) > 0 && held.has(key)) return held.get(key);
					const data = await options.queryFn({ signal: new AbortController().signal, queryKey: options.queryKey, client: undefined });
					held.set(key, data);
					return data;
				},
			};
		},
	};
}

beforeEach(async () => {
	vi.stubGlobal("window", { location: { origin: ORIGIN } });
	vi.stubGlobal("sessionStorage", new MemoryStorage());
	await env.DB.batch([
		env.DB.prepare("DELETE FROM instance_setup"),
		env.DB.prepare("DELETE FROM instance_settings"),
		env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE role = 'admin'`),
	]);
	await load();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const signal = () => new AbortController().signal;

async function failure(step: Promise<unknown>): Promise<unknown> {
	try {
		await step;
	} catch (error) {
		return error;
	}
	throw new Error("The call did not fail");
}

/** A new account, signed in by email code in this page's browser. */
async function signedInUser(name = "ada"): Promise<string> {
	const email = uniqueEmail(name);
	await signInWithCode(email, {}, browser);
	return email;
}

describe("sign-up with the setup key", () => {
	beforeEach(async () => {
		await env.DB.prepare("INSERT INTO instance_settings (id, signup_open, updated_at) VALUES (1, 0, ?)").bind(Date.now()).run();
	});

	test("sends the key in X-Minerva-Setup-Key; without it, or with a wrong one, sign-up stays closed", async () => {
		expect(await frontend.setupQuery.queryFn({ signal: signal() })).toEqual({ needed: true });
		const email = uniqueEmail("operator");

		const closed = await failure(frontend.auth.signup({ email, password: PASSWORD }));
		expect(closed).toBeInstanceOf(frontend.AuthError);
		expect((closed as Error).message).toBe("Sign-up is not open on this server.");
		expect(frontend.fieldErrors(closed)).toEqual({});

		// A key that does not open it is said to be the problem, on the key's own field.
		const wrong = await failure(frontend.auth.signup({ email, password: PASSWORD, setupKey: "wrong" }));
		expect(frontend.fieldErrors(wrong)).toEqual({ setupKey: expect.stringContaining("setup key does not open it") });
		expect(await env.DB.prepare(`SELECT 1 FROM "user" WHERE email = ?`).bind(email).first()).toBeNull();

		// Only spaces around the key are the page's doing; the key itself is the server's.
		const admitted = await frontend.auth.signup({ email, password: PASSWORD, setupKey: ` ${KEY} ` });
		expect(admitted).toEqual({ kind: "anonymous", pending: "verify-email" });
		expect(await frontend.auth.verifyEmail({ code: lastCode(email) })).toEqual({ kind: "signed-in" });
	});

	test("the key is kept nowhere: not in the stored step and not in any cookie", async () => {
		const email = uniqueEmail("operator");
		await frontend.auth.signup({ email, password: PASSWORD, setupKey: KEY });
		const stored = JSON.stringify(sessionStorage.getItem("minerva.auth.step"));
		expect(stored).not.toContain(KEY);
		expect(JSON.stringify([...browser.cookies])).not.toContain(KEY);
		expect(browser.setCookies.join("\n")).not.toContain(KEY);
	});

	test("claiming the setup after the sign-up makes the account the administrator, once", async () => {
		const email = uniqueEmail("operator");
		await frontend.auth.signup({ email, password: PASSWORD, setupKey: KEY });
		await frontend.auth.verifyEmail({ code: lastCode(email) });

		const wrong = await failure(frontend.instance.claimSetup("not the key"));
		expect(frontend.errorMessage(wrong)).toBe("This setup key is not valid.");
		expect(await frontend.setupQuery.queryFn({ signal: signal() })).toEqual({ needed: true });

		await frontend.instance.claimSetup(KEY);
		expect(await frontend.setupQuery.queryFn({ signal: signal() })).toEqual({ needed: false });
		expect(frontend.errorMessage(await failure(frontend.instance.claimSetup(KEY)))).toBe("This instance is already set up.");
		expect((await browser.call("GET", "/api/me")).body.user.role).toBe("admin");

		// The key admits nobody once the setup is claimed.
		await load();
		const late = await failure(frontend.auth.signup({ email: uniqueEmail("late"), password: PASSWORD, setupKey: KEY }));
		expect(frontend.fieldErrors(late)).toHaveProperty("setupKey");
	});

	test("a visitor without a session cannot claim, and the page is told to sign in", async () => {
		const error = await failure(frontend.instance.claimSetup(KEY));
		expect(frontend.errorMessage(error)).toBe("Unauthorized");
		expect(await env.DB.prepare(`SELECT 1 FROM instance_setup`).first()).toBeNull();
	});
});

describe("the instance page's calls", () => {
	/** A signed-in user who claimed the setup. */
	async function admin(): Promise<string> {
		await env.DB.prepare("DELETE FROM instance_settings").run();
		const email = await signedInUser("admin");
		await frontend.instance.claimSetup(KEY);
		return email;
	}

	test("read and change sign-up, and the server's refusals come back as sentences", async () => {
		await admin();
		const { instance } = frontend;
		expect(await instance.instanceSettingsQuery.queryFn({ signal: signal() })).toEqual({ signup_open: true, signup_open_override: null, signup_open_configured: true });
		expect(await instance.updateSignupOpen(false)).toEqual({ signup_open: false, signup_open_override: false, signup_open_configured: true });
		expect(await instance.updateSignupOpen(null)).toEqual({ signup_open: true, signup_open_override: null, signup_open_configured: true });
		expect(await instance.updateSignupOpen(true)).toMatchObject({ signup_open: true, signup_open_override: true });
	});

	test("list, add and remove administrators; the last one stays", async () => {
		const email = await admin();
		const { instance } = frontend;
		const [self] = await instance.instanceAdminsQuery.queryFn({ signal: signal() });
		expect(self).toMatchObject({ email });

		// A second account, made in another browser; then back to the administrator's.
		const administrator = browser;
		const colleague = uniqueEmail("grace");
		await load();
		await signInWithCode(colleague, {}, browser);
		await load(administrator);

		expect(frontend.errorMessage(await failure(frontend.instance.addAdmin("nobody@example.com")))).toBe("No user has this email address.");
		const added = await frontend.instance.addAdmin(` ${colleague.toUpperCase()} `);
		expect(added.map((entry) => entry.email).sort()).toEqual([email, colleague].sort());

		await frontend.instance.removeAdmin(added.find((entry) => entry.email === colleague)!.id);
		expect((await instance.instanceAdminsQuery.queryFn({ signal: signal() })).map((entry) => entry.email)).toEqual([email]);
		expect(frontend.errorMessage(await failure(frontend.instance.removeAdmin(self!.id)))).toBe("Keep at least one instance admin.");
	});

	test("everyone else is refused by the server, whatever the page shows", async () => {
		await admin();
		await load();
		await signedInUser("grace");
		const refusal = "Only instance admins can do this.";
		expect(frontend.errorMessage(await failure(frontend.instance.instanceSettingsQuery.queryFn({ signal: signal() })))).toBe(refusal);
		expect(frontend.errorMessage(await failure(frontend.instance.instanceAdminsQuery.queryFn({ signal: signal() })))).toBe(refusal);
		expect(frontend.errorMessage(await failure(frontend.instance.updateSignupOpen(false)))).toBe(refusal);
		expect(frontend.errorMessage(await failure(frontend.instance.addAdmin("anyone@example.com")))).toBe(refusal);
	});
});

describe("the route guard", () => {
	test("lets an instance admin through and sends everyone else to page-not-found", async () => {
		await signedInUser("grace");
		const error = await failure(frontend.requireInstanceAdmin(frontend.newQueryClient()));
		expect(frontend.isNotFound(error)).toBe(true);

		await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE email = (SELECT email FROM "user" ORDER BY "createdAt" DESC LIMIT 1)`).run();
		await expect(frontend.requireInstanceAdmin(frontend.newQueryClient())).resolves.toBeUndefined();
	});

	test("reads the role from the server on each call, not from the sign-in", async () => {
		const email = await signedInUser("ada");
		await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE email = ?`).bind(email).run();
		// One client throughout: a role removed within the seconds the app keeps /api/me still turns the visitor away.
		const queryClient = frontend.newQueryClient();
		await expect(frontend.requireInstanceAdmin(queryClient)).resolves.toBeUndefined();
		await env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE email = ?`).bind(email).run();
		expect(frontend.isNotFound(await failure(frontend.requireInstanceAdmin(queryClient)))).toBe(true);
	});

	test("a signed-out visitor gets the 401, not a page", async () => {
		const error = await failure(frontend.requireInstanceAdmin(frontend.newQueryClient()));
		expect(frontend.isNotFound(error)).toBe(false);
	});
});
