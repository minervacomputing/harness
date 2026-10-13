// What the Microsoft connectors share (src/connectors/microsoft/): the declarations, Graph's paging, error
// classification, consent spellings and the case folding discovery uses.
// Cases come from today's Python (test/fixtures/connectors/microsoft/generate.py) and from
// backend/tests/test_outlook.py's `test_cursors_come_only_from_checked_paging_parameters`,
// `test_graph_errors_are_named_without_graphs_text` and `test_outlook_scopes_follow_the_allowed_actions`.

import { describe, expect, test } from "vitest";
import { driveClassify } from "../../src/connectors/onedrive/client.ts";
import { onedriveConnector } from "../../src/connectors/onedrive/connector.ts";
import { outlookCalendarConnector } from "../../src/connectors/outlook_calendar/connector.ts";
import { nextCursor as teamsNextCursor, pageParams as teamsPageParams } from "../../src/connectors/teams/client.ts";
import { teamsConnector } from "../../src/connectors/teams/connector.ts";
import { consent, consentAll, classify, nextCursor, pageParam, segment } from "../../src/connectors/microsoft/index.ts";
import { outlookConnector } from "../../src/connectors/outlook/connector.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { utf8 } from "../../src/lib/bytes.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { declarationOf, vectors } from "../fixtures/connectors/microsoft/runs.ts";
import { TextError } from "../../src/lib/text.ts";
import { UrlError } from "../../src/lib/urlsplit.ts";
import { changedOnPurpose, jsonQuoted } from "./changed.ts";

/** generate.py's `outcome`: what a call gives, or the error it raises. */
function outcome(call: () => unknown): { [key: string]: unknown } {
	try {
		return { value: call() };
	} catch (error) {
		if (error instanceof OperationError) return { error: error.code, message: error.message };
		if (error instanceof TextError || error instanceof UrlError) return { error: "ValueError", message: error.message };
		if (error instanceof TypeError) return { error: "TypeError" };
		throw error;
	}
}

/** The vector's outcome without the message of a TypeError, which Python words its own way. */
function expectedOutcome(entry: { [key: string]: unknown }): { [key: string]: unknown } {
	const { link: _link, cursor: _cursor, ...rest } = entry;
	return typeof rest.message === "string" ? { ...rest, message: jsonQuoted(rest.message) } : rest;
}

describe("the declarations", () => {
	const declared = vectors("microsoft").declarations as { slug: string }[];
	for (const [slug, connector] of [
		["outlook", outlookConnector()],
		["outlook_calendar", outlookCalendarConnector()],
		["onedrive", onedriveConnector()],
		["teams", teamsConnector()],
	] as const) {
		test(`${slug} repeats today's kinds, actions, auth, terms and strings`, () => {
			expect(declarationOf(connector)).toEqual(declared.find((item) => item.slug === slug));
		});
	}

	test("the registry accepts them, and their fingerprints are pinned", async () => {
		const registry = await Registry.create([outlookConnector(), outlookCalendarConnector(), onedriveConnector(), teamsConnector()]);
		const fingerprints: { [name: string]: string } = {};
		for (const connector of [outlookConnector(), outlookCalendarConnector(), onedriveConnector(), teamsConnector()]) {
			for (const op of connector.operations) fingerprints[`${connector.slug}_${op.name}`] = registry.contract(connector.slug, op.name);
		}
		expect(fingerprints).toEqual({
			onedrive_create_file: "ace5b1784acf7040",
			onedrive_get_file: "dc97e3cf4b855620",
			onedrive_list_folder: "a9bc01e509202442",
			onedrive_list_libraries: "e7b135cd6ce6d5cb",
			onedrive_read_file: "d82848fab80c26e7",
			onedrive_search_files: "253a8d92b20fa0cb",
			outlook_calendar_create_event: "72bc5dd07a0e7b66",
			outlook_calendar_list_calendars: "50607b185838c112",
			outlook_calendar_list_events: "fda28b2ad5b8541d",
			outlook_list_folders: "e5a516a3454808a1",
			outlook_list_messages: "dd3fa98fd9b33255",
			outlook_read_message: "bdc15accde5f4e5b",
			outlook_reply: "35807430fc0f2828",
			outlook_send_message: "5dd9a5c1db9fe2b5",
			teams_list_channels: "606604a9944dc92a",
			teams_list_teams: "796e73e780c5c66a",
			teams_post_message: "8dd44fdb8a3902b6",
			teams_read_channel: "5bf8b8c376a907dc",
			teams_read_thread: "7f1ebcfa574725b2",
			teams_reply: "79d2194696d17b29",
		});
	});
});

describe("Graph's paging", () => {
	test("test_cursors_come_only_from_checked_paging_parameters", () => {
		const base = "https://graph.microsoft.com/v1.0/me/mailFolders/X/messages";
		expect(nextCursor(null)).toBeNull();
		expect(nextCursor(`${base}?%24skiptoken=abc%3D%3D&%24top=5`)).toBe("token:abc==");
		expect(nextCursor(`${base}?$skip=40`)).toBe("skip:40");
		// Where the link points does not matter: it is never requested.
		expect(nextCursor("https://attacker.example/?$skip=40")).toBe("skip:40");
		for (const link of [
			`${base}?$skip=40&$skiptoken=abc`,
			`${base}?$skip=1&$skip=2`,
			`${base}?$skip=-1`,
			`${base}?$skiptoken=a b`,
			`${base}?$skiptoken=${"a".repeat(881)}`,
			`${base}?$top=5`,
			base,
			42,
			"x".repeat(4001),
		]) {
			expect(() => nextCursor(link)).toThrow(expect.objectContaining({ code: "PROVIDER_LIMIT" }));
		}
		expect(pageParam("skip:40")).toEqual({ $skip: "40" });
		expect(pageParam("token:abc==")).toEqual({ $skiptoken: "abc==" });
		for (const cursor of ["skip:x", "token:", "token:a&b", "page:1", "40"]) {
			expect(() => pageParam(cursor)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
		}
	});

	test("next_cursor agrees with Python on links, fuzzed ones included", () => {
		const all = vectors("microsoft").next_cursor as { link: string | number | null }[];
		expect(all.length).toBeGreaterThan(250);
		const cases = all.filter((entry) => !changedOnPurpose(entry));
		const actual = cases.map((entry) => outcome(() => nextCursor(entry.link)));
		expect(actual.map((item) => (item.error === "TypeError" ? { error: "TypeError" } : item))).toEqual(cases.map((entry) => expectedOutcome(entry)));
	});

	test("page_param agrees with Python on cursors", () => {
		const cases = (vectors("microsoft").page_param as { cursor: string }[]).filter((entry) => !changedOnPurpose(entry.cursor));
		expect(cases.map((entry) => outcome(() => pageParam(entry.cursor)))).toEqual(cases.map((entry) => expectedOutcome(entry)));
	});

	test("Teams' page cursors and links agree with Python, fuzzed links included", () => {
		const cursors = (vectors("microsoft").teams_page_params as { cursor: string }[]).filter((entry) => !changedOnPurpose(entry.cursor));
		expect(cursors.map((entry) => outcome(() => teamsPageParams(entry.cursor)))).toEqual(cursors.map((entry) => expectedOutcome(entry)));
		const links = (vectors("microsoft").teams_next_cursor as { link: string | number | null }[]).filter((entry) => !changedOnPurpose(entry));
		expect(links.length).toBeGreaterThan(100);
		expect(links.map((entry) => outcome(() => teamsNextCursor(entry.link)))).toEqual(links.map((entry) => expectedOutcome(entry)));
	});

	test("path segments are quoted as urllib.parse.quote(safe='') quotes them", () => {
		expect(segment("AAMk/ad=")).toBe("AAMk%2Fad%3D");
		expect(segment("a b~c.d_e-f")).toBe("a%20b~c.d_e-f");
		expect(segment("!'()*")).toBe("%21%27%28%29%2A");
		expect(segment("é")).toBe("%C3%A9");
	});
});

describe("Graph's errors", () => {
	test("test_graph_errors_are_named_without_graphs_text", () => {
		const named = (status: number, body: string) => classify("Outlook", new Response(body, { status }), body, utf8(body));
		expect(named(404, JSON.stringify({ error: { code: "MailboxNotEnabledForRESTAPI" } }))).toMatchObject({ code: "UNSUPPORTED_ACCOUNT" });
		expect(named(503, "")).toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
		expect(named(404, JSON.stringify({ error: { code: "ErrorItemNotFound" } }))).toBeNull();
		expect(named(400, "<html>")).toBeNull();
	});

	test("classify agrees with Python on error answers", () => {
		const cases = vectors("microsoft").classify as { status: number; body: string; outlook: { code: string; message: string } | null }[];
		for (const { status, body, outlook } of cases) {
			const found = classify("Outlook", new Response(body, { status }), body, utf8(body));
			expect(found === null ? null : { code: found.code, message: found.message }).toEqual(outlook);
		}
	});

	test("classify agrees with Python on error answers as OneDrive names them", () => {
		const cases = vectors("microsoft").classify as { status: number; body: string; onedrive: { code: string; message: string } | null }[];
		expect(cases.some((entry) => entry.onedrive?.code === "PROVIDER_REJECTED")).toBe(true);
		for (const { status, body, onedrive } of cases) {
			const found = driveClassify("OneDrive", new Response(body, { status }), body, utf8(body));
			expect(found === null ? null : { code: found.code, message: found.message }).toEqual(onedrive);
		}
	});

	test("a body that is not UTF-8 names nothing, as response.json() refuses it", () => {
		const bytes = Uint8Array.from([...utf8('{"error": {"code": "MailboxNotEnabledForRESTAPI", "message": "'), 0xff, ...utf8('"}}')]);
		expect(classify("Outlook", new Response(bytes, { status: 404 }), new TextDecoder().decode(bytes), bytes)).toBeNull();
	});
});

describe("consent", () => {
	test("a scope is accepted in Graph's short form, with its URL, and in lower case", () => {
		expect(consent("Mail.Read", "Mail.ReadWrite")).toEqual([
			["Mail.Read"],
			["https://graph.microsoft.com/Mail.Read"],
			["Mail.ReadWrite"],
			["https://graph.microsoft.com/Mail.ReadWrite"],
			["mail.read"],
			["https://graph.microsoft.com/mail.read"],
			["mail.readwrite"],
			["https://graph.microsoft.com/mail.readwrite"],
		]);
		expect(consentAll("A", "B")).toHaveLength(16);
		expect(consentAll("A", "B")[0]).toEqual(["A", "B"]);
	});

	test("test_outlook_scopes_follow_the_allowed_actions", () => {
		const connector = outlookConnector();
		const base = ["offline_access", "User.Read", "Mail.Read"];
		expect(requestedScopes(connector, new Set(["read"]))).toEqual(base);
		expect(requestedScopes(connector, new Set(["read", "send"]))).toEqual([...base, "Mail.Send"]);
		expect(consentNeeded(connector, ["User.Read", "Mail.Read"], new Set(["read", "send"]))).toEqual(["send"]);
		// Microsoft may report scopes with Graph's URL in front, and in lowercase.
		const granted = ["https://graph.microsoft.com/mail.read", "https://graph.microsoft.com/Mail.Send"];
		expect(consentNeeded(connector, granted, new Set(["read", "send"]))).toEqual([]);
		expect(consentNeeded(connector, ["mail.readwrite", "mail.send"], new Set(["read", "send"]))).toEqual([]);
		expect(consentNeeded(connector, ["Mail.ReadBasic"], new Set(["read"]))).toEqual(["read"]);
	});

	test("the OAuth declaration is the shared Entra app's, with PKCE and an account picker", () => {
		const auth = outlookConnector().auth;
		expect(auth).toMatchObject({
			type: "oauth2",
			app: "microsoft",
			authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
			scopes: ["offline_access", "User.Read", "Mail.Read"],
			authorizeParams: [["prompt", "select_account"]],
		});
	});
});
