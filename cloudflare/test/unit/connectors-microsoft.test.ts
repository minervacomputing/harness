// What the Microsoft connectors share (src/connectors/microsoft/): their contracts, Graph's paging, error
// classification and consent spellings.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Graph, classify, consent, consentAll, nextCursor, pageParam } from "../../src/connectors/microsoft/index.ts";
import { driveClassify } from "../../src/connectors/onedrive/client.ts";
import { onedriveConnector } from "../../src/connectors/onedrive/connector.ts";
import { outlookConnector } from "../../src/connectors/outlook/connector.ts";
import { outlookCalendarConnector } from "../../src/connectors/outlook_calendar/connector.ts";
import { nextCursor as teamsNextCursor, pageParams as teamsPageParams } from "../../src/connectors/teams/client.ts";
import { teamsConnector } from "../../src/connectors/teams/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { utf8 } from "../../src/lib/bytes.ts";
import type { JsonObject } from "../../src/lib/json.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";

const BASE = "https://graph.microsoft.com/v1.0/me/mailFolders/X/messages";
const unusable = expect.objectContaining({ code: "PROVIDER_LIMIT", message: "Microsoft Graph returned a page link Minerva cannot use." });
const invalid = expect.objectContaining({ code: "INVALID_CURSOR", message: "This page token is invalid." });

describe("the declarations", () => {
	test("the registry accepts them, and their fingerprints are pinned", async () => {
		const connectors = [outlookConnector(), outlookCalendarConnector(), onedriveConnector(), teamsConnector()];
		const registry = await Registry.create(connectors);
		const fingerprints: { [name: string]: string } = {};
		for (const connector of connectors) {
			for (const op of connector.operations) fingerprints[`${connector.slug}_${op.name}`] = registry.contract(connector.slug, op.name);
		}
		expect(fingerprints).toEqual({
			onedrive_create_file: "79a98fa3d8ef0517",
			onedrive_get_file: "cef85fed6414fe23",
			onedrive_list_folder: "ee45ad2dcc9fc547",
			onedrive_list_libraries: "72e14dca64cf7190",
			onedrive_read_file: "a22998661ec6ff17",
			onedrive_search_files: "2cb8f8661856d4b1",
			outlook_calendar_create_event: "df28ef987b776f94",
			outlook_calendar_list_calendars: "5631bfc84d488b10",
			outlook_calendar_list_events: "2d48e222bc48db11",
			outlook_list_folders: "df7822004216cc6e",
			outlook_list_messages: "a3268eda3011223f",
			outlook_read_message: "0658c5b8112956f3",
			outlook_reply: "d58f389a60270acf",
			outlook_send_message: "e7700dacc9d117b7",
			teams_list_channels: "46310dc5a8fd8253",
			teams_list_teams: "f72e179088761b0c",
			teams_post_message: "06e3ea095610e782",
			teams_read_channel: "d1df5d1cf0971410",
			teams_read_thread: "9ad5fc7751ebd883",
			teams_reply: "f6f6277c65f52a68",
		});
	});
});

describe("Graph's paging", () => {
	test("a cursor comes only from one checked paging parameter of the next link, which is never requested", () => {
		expect(nextCursor(null)).toBeNull();
		expect(nextCursor(`${BASE}?%24skiptoken=abc%3D%3D&%24top=5`)).toBe("token:abc==");
		expect(nextCursor(`${BASE}?$skiptoken=a%2Bb`)).toBe("token:a+b");
		expect(nextCursor(`${BASE}?$skip=40`)).toBe("skip:40");
		expect(nextCursor(`${BASE}?$skip=4#frag`)).toBe("skip:4");
		expect(nextCursor(`${BASE}?$skiptoken=${"a".repeat(880)}`)).toBe(`token:${"a".repeat(880)}`);
		// Where the link points does not matter: only its parameter is taken.
		expect(nextCursor("https://attacker.example/?$skip=40")).toBe("skip:40");
		expect(nextCursor("?$skip=7")).toBe("skip:7");
		for (const link of [
			`${BASE}?$skip=40&$skiptoken=abc`,
			`${BASE}?$skip=1&$skip=2`,
			`${BASE}?$skiptoken=a&$skiptoken=`,
			`${BASE}?$skip=-1`,
			`${BASE}?$skip=1234567`,
			`${BASE}?$skip=%D9%A3`,
			`${BASE}?$skiptoken=a b`,
			`${BASE}?$skiptoken=a+b`,
			`${BASE}?$skiptoken=`,
			`${BASE}?$skiptoken=${"a".repeat(881)}`,
			`${BASE}?$top=5`,
			`${BASE}#?$skip=4`,
			"https://[::1/?$skip=3",
			BASE,
			"x".repeat(4001),
		]) {
			expect(() => nextCursor(link), link).toThrow(unusable);
		}
	});

	test("a cursor names $skip in ASCII digits or a $skiptoken of URL characters", () => {
		expect(pageParam("skip:40")).toEqual({ $skip: "40" });
		expect(pageParam("skip:123456")).toEqual({ $skip: "123456" });
		expect(pageParam("token:abc==")).toEqual({ $skiptoken: "abc==" });
		expect(pageParam("token:a:b")).toEqual({ $skiptoken: "a:b" });
		expect(pageParam("token:%2F~")).toEqual({ $skiptoken: "%2F~" });
		for (const cursor of ["skip:x", "skip:", "skip:1234567", "skip:\u0663", "skip:1:2", "token:", "token:a&b", `token:${"a".repeat(881)}`, "page:1", "40", "", ":"]) {
			expect(() => pageParam(cursor), cursor).toThrow(invalid);
		}
	});

	test("Teams keeps its own token, which may be JSON, printable ASCII only", () => {
		const token = '{"page":2,"x":"a+b/c"}';
		expect(teamsPageParams(`t:${token}`)).toEqual({ $skiptoken: token });
		expect(teamsPageParams(`t:t:abc`)).toEqual({ $skiptoken: "t:abc" });
		expect(teamsPageParams(null)).toEqual({});
		expect(teamsPageParams(`t:${"a".repeat(990)}`)).toEqual({ $skiptoken: "a".repeat(990) });
		for (const cursor of ["token:abc", "t:", "t:a b", "t:\u00e9", "t:a\tb", `t:${"a".repeat(991)}`, "x"]) {
			expect(() => teamsPageParams(cursor), cursor).toThrow(invalid);
		}
		expect(teamsNextCursor(`${BASE}?$skiptoken=${encodeURIComponent(token)}`)).toBe(`t:${token}`);
		expect(teamsNextCursor(null)).toBeNull();
		for (const link of [`${BASE}?$skip=4`, `${BASE}?$skiptoken=a&$skiptoken=b`, `${BASE}?$skiptoken=a%20b`, `${BASE}?$skiptoken=${"a".repeat(991)}`, "x".repeat(4001)]) {
			expect(() => teamsNextCursor(link), link).toThrow(unusable);
		}
	});

	test("a page that does not fit, its link included, is an unexpected response", () => {
		const graph = new Graph("Microsoft Graph", "t", settingsIo(async () => new Response(null, { status: 500 })));
		const item = z.object({ id: z.string() });
		expect(graph.page(item, { value: [{ id: "a" }] })).toEqual([[{ id: "a" }], null]);
		for (const body of [{ value: [], "@odata.nextLink": 5 }, { value: "x" }, { value: [{ id: 1 }] }, {}] as JsonObject[]) {
			expect(() => graph.page(item, body), JSON.stringify(body)).toThrow(expect.objectContaining({ code: "PROVIDER_FAILED" }));
		}
	});
});

describe("Graph's errors", () => {
	const named = (status: number, body: string) => classify("Outlook", new Response(body, { status }), body, utf8(body));
	const drive = (status: number, body: string) => driveClassify("OneDrive", new Response(body, { status }), body, utf8(body));

	test("a mailbox Graph cannot reach is an unsupported account, whatever the status, and 503 is rate limiting", () => {
		const unsupported = {
			code: "UNSUPPORTED_ACCOUNT",
			message: "This account has no mailbox Outlook lets Minerva use (for example, it is hosted on an on-premises Exchange server).",
		};
		expect(named(404, JSON.stringify({ error: { code: "MailboxNotEnabledForRESTAPI" } }))).toMatchObject(unsupported);
		expect(named(500, JSON.stringify({ error: { code: "MailboxNotSupportedForRESTAPI", message: "x" } }))).toMatchObject(unsupported);
		expect(named(503, JSON.stringify({ error: { code: "MailboxNotEnabledForRESTAPI" } }))).toMatchObject(unsupported);
		expect(named(503, "")).toMatchObject({ code: "PROVIDER_RATE_LIMITED", message: "Outlook is rate limiting requests. Try again later." });
	});

	test("other answers are left to the shared mapping, and Graph's text is never used", () => {
		for (const body of [JSON.stringify({ error: { code: "ErrorItemNotFound" } }), "<html>", '["error"]', '{"error": "MailboxNotEnabledForRESTAPI"}', '{"error": {"code": 5}}', '{"error": null}', "null"]) {
			expect(named(400, body), body).toBeNull();
		}
		// A body that is not UTF-8 names nothing.
		const bytes = Uint8Array.from([...utf8('{"error": {"code": "MailboxNotEnabledForRESTAPI", "message": "'), 0xff, ...utf8('"}}')]);
		expect(classify("Outlook", new Response(bytes, { status: 404 }), new TextDecoder().decode(bytes), bytes)).toBeNull();
	});

	test("OneDrive names a name that is taken as a rejection", () => {
		expect(drive(409, JSON.stringify({ error: { code: "nameAlreadyExists", message: "SECRET" } }))).toMatchObject({
			code: "PROVIDER_REJECTED",
			message: "A file or folder with this name already exists in this folder.",
		});
		expect(named(409, JSON.stringify({ error: { code: "nameAlreadyExists" } }))).toBeNull();
		expect(drive(409, JSON.stringify({ error: { code: "conflict" } }))).toBeNull();
		expect(drive(503, "")).toMatchObject({ code: "PROVIDER_RATE_LIMITED", message: "OneDrive is rate limiting requests. Try again later." });
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

	test("Outlook's scopes follow the allowed actions", () => {
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
		for (const connector of [outlookConnector(), outlookCalendarConnector(), onedriveConnector(), teamsConnector()]) {
			expect(connector.auth).toMatchObject({
				type: "oauth2",
				app: "microsoft",
				authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
				tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
				authorizeParams: [["prompt", "select_account"]],
			});
			expect(connector.auth.type === "oauth2" && (connector.auth.pkce ?? true), connector.slug).toBe(true);
		}
		expect(outlookConnector().auth.type === "oauth2" && outlookConnector().auth).toMatchObject({ scopes: ["offline_access", "User.Read", "Mail.Read"] });
	});
});
