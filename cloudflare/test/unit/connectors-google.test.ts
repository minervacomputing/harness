// What the Google connectors share (backend/connectors/google/__init__.py): how Google's 403s are read, the OAuth
// declaration, and the numeric strings Drive and Gmail send; and that the registry accepts
// the Google connectors' declarations. Cases come from today's Python (test/fixtures/connectors/google/generate.py).

import { describe, expect, test } from "vitest";
import { CONNECTORS, connectorRegistry } from "../../src/connectors/index.ts";
import { digitsOr, jsonInteger } from "../../src/connectors/google/digits.ts";
import { GoogleUser, NOT_CONFIGURED, RATE_LIMITED, TOO_LARGE, classify, oauth, reasons } from "../../src/connectors/google/index.ts";
import { googleCalendarConnector } from "../../src/connectors/google_calendar/connector.ts";
import { googleDriveConnector } from "../../src/connectors/google_drive/connector.ts";
import { Registry, validate } from "../../src/gateway/registry.ts";
import { vectors } from "../fixtures/connectors/google/vectors.ts";

interface ForbiddenCase {
	reasons: string[];
	code: string;
	message: string;
}

const DEFAULT_FORBIDDEN = { code: "PROVIDER_FORBIDDEN", message: "Google Drive refused this request for the connected account." };

describe("Google's 403s", () => {
	const cases = vectors().base.forbidden as { [body: string]: ForbiddenCase };

	test("the reasons are read as _reasons reads them, whatever shape the body has", () => {
		expect(Object.keys(cases).length).toBeGreaterThan(40);
		const actual: { [body: string]: string[] } = {};
		const expected: { [body: string]: string[] } = {};
		for (const [body, item] of Object.entries(cases)) {
			actual[body] = [...reasons(body)].sort();
			expected[body] = item.reasons;
		}
		expect(actual).toEqual(expected);
	});

	test("a rate limit, a disabled API and an export too large are named; anything else is a plain refusal", () => {
		const actual: { [body: string]: { code: string; message: string } } = {};
		const expected: { [body: string]: { code: string; message: string } } = {};
		for (const [body, item] of Object.entries(cases)) {
			const named = classify("Google Drive", new Response(body, { status: 403 }), body);
			actual[body] = named === null ? DEFAULT_FORBIDDEN : { code: named.code, message: named.message };
			// Python's default_forbidden answers where `forbidden` names nothing.
			expected[body] = item.code === "PROVIDER_FORBIDDEN" ? DEFAULT_FORBIDDEN : { code: item.code, message: item.message };
		}
		expect(actual).toEqual(expected);
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
		expect(GoogleUser.parse({ sub: "108", picture: "x" })).toEqual({ sub: "108", email: null, name: null });
		expect(GoogleUser.parse({ sub: "108", email: "ada@example.com", name: "Ada" })).toEqual({ sub: "108", email: "ada@example.com", name: "Ada" });
		expect(GoogleUser.safeParse({ email: "ada@example.com" }).success).toBe(false);
		expect(GoogleUser.safeParse({ sub: 108 }).success).toBe(false);
	});
});

describe("numeric strings", () => {
	test("ASCII digits are read, anything else is the fallback", () => {
		expect(digitsOr("0", null)).toBe(0n);
		expect(digitsOr("1048576", null)).toBe(1048576n);
		expect(digitsOr("", "x")).toBe("x");
		expect(digitsOr(null, "x")).toBe("x");
		expect(digitsOr("12a", "x")).toBe("x");
		expect(digitsOr("-1", "x")).toBe("x");
		expect(digitsOr(" 1", "x")).toBe("x");
		expect(digitsOr("1.5", "x")).toBe("x");
	});

	test("other digits are no number", () => {
		for (const text of ["²", "1³", "①", "١٢", "１２", "½"]) expect(digitsOr(text, null)).toBeNull();
	});

	test("an integer goes into JSON as a number, unless a number cannot hold it exactly", () => {
		expect(jsonInteger(9007199254740991n, "Google Drive")).toBe(9007199254740991);
		expect(() => jsonInteger(9007199254740992n, "Google Drive")).toThrow("Google Drive returned an unexpected response.");
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
