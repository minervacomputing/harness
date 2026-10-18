// What the Google connectors share: how Google's 403s are read, the OAuth declaration and the userinfo; and
// that the registry accepts the Calendar and Drive declarations.

import { describe, expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { connectorRegistry } from "../../src/connectors/index.ts";
import { GoogleUser, NOT_CONFIGURED, RATE_LIMITED, TOO_LARGE, classify, googleTenants, oauth, reasons } from "../../src/connectors/google/index.ts";
import { googleCalendarConnector } from "../../src/connectors/google_calendar/connector.ts";
import { googleDriveConnector } from "../../src/connectors/google_drive/connector.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";

const DEFAULT_FORBIDDEN = { code: "PROVIDER_FORBIDDEN", message: "Google Drive refused this request for the connected account." };

function forbidden(body: string): { code: string; message: string } {
	const named = classify("Google Drive", new Response(body, { status: 403 }), body);
	return named === null ? DEFAULT_FORBIDDEN : { code: named.code, message: named.message };
}

describe("Google's 403s", () => {
	test("the string reasons of error.errors[] and error.details[] are read; any other shape has none", () => {
		const body = (error: unknown) => JSON.stringify({ error });
		expect([...reasons(body({ errors: [{ reason: "rateLimitExceeded" }], details: [{ reason: "SERVICE_DISABLED" }] }))].sort()).toEqual(["SERVICE_DISABLED", "rateLimitExceeded"]);
		expect([...reasons(body({ errors: [{ reason: 1 }, "x", null, { reason: "a" }, {}] }))]).toEqual(["a"]);
		for (const text of ["", "not json", "[]", "{}", body("x"), body({ errors: "rateLimitExceeded" }), body({ errors: { reason: "a" } })]) {
			expect([...reasons(text)], text).toEqual([]);
		}
	});

	test("a rate limit, a disabled API and an export too large are named; anything else is a plain refusal", () => {
		const body = (reason: string) => JSON.stringify({ error: { errors: [{ reason }] } });
		expect(forbidden(body("userRateLimitExceeded"))).toEqual({ code: "PROVIDER_RATE_LIMITED", message: "Google Drive is rate limiting requests. Try again later." });
		expect(forbidden(body("accessNotConfigured")).code).toBe("PROVIDER_NOT_CONFIGURED");
		expect(forbidden(JSON.stringify({ error: { details: [{ reason: "SERVICE_DISABLED" }] } })).code).toBe("PROVIDER_NOT_CONFIGURED");
		expect(forbidden(body("exportSizeLimitExceeded"))).toEqual({ code: "FILE_TOO_LARGE", message: "This file is too large for Google Drive to export." });
		expect(forbidden(body("insufficientPermissions"))).toEqual(DEFAULT_FORBIDDEN);
		expect(forbidden("<html>")).toEqual(DEFAULT_FORBIDDEN);
	});

	test("only a 403 is read", () => {
		const body = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } });
		for (const status of [400, 401, 404, 429, 500]) expect(classify("Google Drive", new Response(body, { status }), body)).toBeNull();
		expect(classify("Google Drive", new Response(body, { status: 403 }), body)?.code).toBe("PROVIDER_RATE_LIMITED");
	});

	test("the reasons Google uses", () => {
		expect([...RATE_LIMITED].sort()).toEqual(["rateLimitExceeded", "userRateLimitExceeded"]);
		expect([...NOT_CONFIGURED].sort()).toEqual(["SERVICE_DISABLED", "accessNotConfigured"]);
		expect([...TOO_LARGE]).toEqual(["exportSizeLimitExceeded"]);
	});
});

describe("the OAuth app", () => {
	test("openid and email come first, then the connector's scopes; offline access is asked for at consent", () => {
		expect(oauth("https://www.googleapis.com/auth/drive.readonly")).toEqual({
			type: "oauth2",
			app: "google",
			authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"],
			authorizeParams: [
				["access_type", "offline"],
				["prompt", "consent"],
				["include_granted_scopes", "true"],
			],
			loginHint: true,
		});
	});

	test("the userinfo ignores what it does not use, and a name or an email may be missing", () => {
		expect(GoogleUser.parse({ sub: "108", picture: "x" })).toEqual({ sub: "108", email: null, name: null, hd: null });
		expect(GoogleUser.parse({ sub: "108", email: "ada@example.com", name: "Ada" })).toEqual({ sub: "108", email: "ada@example.com", name: "Ada", hd: null });
		expect(GoogleUser.safeParse({ email: "ada@example.com" }).success).toBe(false);
		expect(GoogleUser.safeParse({ sub: 108 }).success).toBe(false);
		expect(GoogleUser.safeParse({ sub: "108", email: 1 }).success).toBe(false);
	});

	test("an account's tenant is its Workspace's domain, in lower case; a personal account has none", () => {
		expect(googleTenants(GoogleUser.parse({ sub: "108", hd: "Example.COM" }))).toEqual([{ id: "example.com", name: "example.com" }]);
		expect(googleTenants(GoogleUser.parse({ sub: "108", email: "ada@gmail.example" }))).toEqual([]);
		expect(googleTenants(GoogleUser.parse({ sub: "108", hd: " " }))).toEqual([]);
	});
});

describe("the declarations", () => {
	test("the registry accepts them, and their fingerprints are pinned", async () => {
		const connectors = [googleCalendarConnector(), googleDriveConnector()];
		expect(() => validate(connectors)).not.toThrow();
		const registry = await Registry.create(connectors);
		const fingerprints = Object.fromEntries(
			connectors.flatMap((connector) => connector.operations.map((op) => [`${connector.slug}.${op.name}`, registry.contract(connector.slug, op.name)])),
		);
		// A change here is a change of what a tool means: running runs fail its calls with OPERATION_CHANGED.
		// Bump `revision` when the meaning changed in a way the declaration does not show.
		expect(fingerprints).toEqual({
			"google_calendar.list_calendars": "e94743d67c44c4c1",
			"google_calendar.list_events": "0067aff7c6455171",
			"google_calendar.get_event": "a3813759a0b6fb2e",
			"google_calendar.create_event": "a9eb92c43f394971",
			"google_drive.list_folder": "3c015eac4245360a",
			"google_drive.search_files": "82467db04682a722",
			"google_drive.get_file": "7d23844bd59d8ab5",
			"google_drive.read_file": "23f9e0ecbf050334",
			"google_drive.create_file": "7c21d8bcc6928b4b",
		});
	});

	test("the Worker's registry serves both, with the contracts the connectors declare", async () => {
		const slugs = CONNECTORS.map((connector) => connector.slug);
		expect(slugs).toContain("google_calendar");
		expect(slugs).toContain("google_drive");
		const served = await connectorRegistry();
		const own = await Registry.create([googleCalendarConnector(), googleDriveConnector()]);
		for (const slug of ["google_calendar", "google_drive"]) {
			for (const op of served.get(slug).operations) expect(served.contract(slug, op.name)).toBe(own.contract(slug, op.name));
		}
	});

	test("both connect with openid and email and ask for read access first; creating asks for more once allowed", () => {
		for (const [connector, read] of [
			[googleCalendarConnector(), "https://www.googleapis.com/auth/calendar.readonly"],
			[googleDriveConnector(), "https://www.googleapis.com/auth/drive.readonly"],
		] as const) {
			if (connector.auth.type !== "oauth2") throw new Error("Google connects through OAuth.");
			expect(connector.auth.app).toBe("google");
			expect(connector.auth.scopes).toEqual(["openid", "email", read]);
			expect(connector.operations.filter((op) => op.mutates).map((op) => op.name)).toEqual([connector.slug === "google_drive" ? "create_file" : "create_event"]);
		}
	});
});
