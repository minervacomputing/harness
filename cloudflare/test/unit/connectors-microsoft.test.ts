// What the Microsoft connectors share (src/connectors/microsoft/): the declarations, Graph's paging, error
// classification, consent spellings, Python's datetime.fromisoformat and the case folding discovery uses.
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
import { OverflowError, ValueError } from "../../src/lib/pyerrors.ts";
import { dateFromIsoFormat, datetimeFromIsoFormat } from "../../src/connectors/microsoft/isoformat.ts";
import { outlookConnector } from "../../src/connectors/outlook/connector.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { casefold } from "../../src/lib/casefold.ts";
import { utf8 } from "../../src/lib/bytes.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { declarationOf, vectors } from "../fixtures/connectors/microsoft/runs.ts";

/** generate.py's `outcome`: what a call gives, or the error it raises. */
function outcome(call: () => unknown): { [key: string]: unknown } {
	try {
		return { value: call() };
	} catch (error) {
		if (error instanceof OperationError) return { error: error.code, message: error.message };
		if (error instanceof ValueError) return { error: "ValueError", message: error.message };
		if (error instanceof TypeError) return { error: "TypeError" };
		throw error;
	}
}

/** The vector's outcome without the message of a TypeError, which Python words its own way. */
function expectedOutcome(entry: { [key: string]: unknown }): { [key: string]: unknown } {
	const { link: _link, cursor: _cursor, ...rest } = entry;
	return rest;
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
			onedrive_create_file: "243efa398d1a9734",
			onedrive_get_file: "791f286781a12714",
			onedrive_list_folder: "91b321635f0a5140",
			onedrive_list_libraries: "0f09f31af80fcfa3",
			onedrive_read_file: "ac027a0745556a37",
			onedrive_search_files: "ddee839a5ea3848c",
			outlook_calendar_create_event: "ae5958c0dc485158",
			outlook_calendar_list_calendars: "2b661d1ffea8356a",
			outlook_calendar_list_events: "2274a2d4562c43ca",
			outlook_list_folders: "59c2b970200b4249",
			outlook_list_messages: "04bf78167b124346",
			outlook_read_message: "068755ea6f7f2ecd",
			outlook_reply: "539162baa100acb3",
			outlook_send_message: "e6486a493c3f4814",
			teams_list_channels: "8dfad0fa72a6a193",
			teams_list_teams: "985bf2372b919437",
			teams_post_message: "ac4e2dd4dd791a64",
			teams_read_channel: "46ebb01b1d42fc9e",
			teams_read_thread: "6280bda44fe12eb9",
			teams_reply: "94aacc0f014d17eb",
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
		const cases = vectors("microsoft").next_cursor as { link: string | number | null }[];
		expect(cases.length).toBeGreaterThan(250);
		const actual = cases.map((entry) => outcome(() => nextCursor(entry.link)));
		expect(actual.map((item) => (item.error === "TypeError" ? { error: "TypeError" } : item))).toEqual(cases.map((entry) => expectedOutcome(entry)));
	});

	test("page_param agrees with Python on cursors", () => {
		const cases = vectors("microsoft").page_param as { cursor: string }[];
		expect(cases.map((entry) => outcome(() => pageParam(entry.cursor)))).toEqual(cases.map((entry) => expectedOutcome(entry)));
	});

	test("Teams' page cursors and links agree with Python, fuzzed links included", () => {
		const cursors = vectors("microsoft").teams_page_params as { cursor: string }[];
		expect(cursors.map((entry) => outcome(() => teamsPageParams(entry.cursor)))).toEqual(cursors.map((entry) => expectedOutcome(entry)));
		const links = vectors("microsoft").teams_next_cursor as { link: string | number | null }[];
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

describe("Python's datetime.fromisoformat and date.fromisoformat", () => {
	test("agree on the generated texts, with their messages", () => {
		const cases = vectors("microsoft").isoformat as { t: string; dt: unknown; d: unknown }[];
		expect(cases.length).toBeGreaterThanOrEqual(1500);
		const actual = cases.map(({ t }) => {
			let dt: unknown;
			try {
				const value = datetimeFromIsoFormat(t);
				dt = { v: [value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond], o: value.offset };
			} catch (error) {
				if (!(error instanceof ValueError || error instanceof OverflowError)) throw error;
				dt = { e: error.message };
			}
			let d: unknown;
			try {
				const value = dateFromIsoFormat(t);
				d = [value.year, value.month, value.day];
			} catch (error) {
				if (!(error instanceof ValueError)) throw error;
				d = { e: error.message };
			}
			return { t, dt, d };
		});
		expect(actual).toEqual(cases);
	});
});

describe("case folding", () => {
	test("str.casefold() agrees with Python on mixed samples", () => {
		const cases = vectors("microsoft").casefold as [string, string][];
		expect(cases.length).toBeGreaterThan(150);
		expect(cases.map(([text]) => casefold(text))).toEqual(cases.map(([, folded]) => folded));
	});
});
