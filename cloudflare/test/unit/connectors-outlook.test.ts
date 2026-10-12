// backend/tests/test_outlook.py, case by case: the Outlook connector against an in-memory Microsoft Graph
// behind an injected `fetch`, and runs through the executor. Addresses, times and input validation are
// compared with vectors from today's Python (test/fixtures/connectors/outlook/generate.py). Graph's paging,
// error classification and consent are tested with the shared base in connectors-microsoft.test.ts.

import { describe, expect, test } from "vitest";
import { type GraphClient } from "../../src/connectors/outlook/client.ts";
import { outlookConnector } from "../../src/connectors/outlook/connector.ts";
import { LIMITS } from "../../src/connectors/outlook/mailbox.ts";
import { OverflowError } from "../../src/lib/pyerrors.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import * as addresses from "../../src/lib/addresses.ts";
import type { Json } from "../../src/lib/json.ts";
import { moment, messageFilter } from "../../src/connectors/outlook/reads.ts";
import { ceilingRow, jsonResponse, operation, received, startRun, vectors, type Received } from "../fixtures/connectors/microsoft/runs.ts";

type JsonObject = { [key: string]: Json };

const SECRET = "SECRET merger";
const [ROOT, INBOX, PROJECTS, PRIVATE, SENT, DRAFTS] = ["ROOTFOLDER00", "INBOXFOLDER0", "PROJECTS0000", "PRIVATEFOLD0", "SENTFOLDER00", "DRAFTSFOLD00"] as const;
// A search folder hangs off a hidden root, outside the tree of folders under msgfolderroot.
const [HIDDEN_ROOT, SEARCH] = ["HIDDENROOT00", "SEARCHFOLD00"] as const;
const WELL_KNOWN: { [name: string]: string } = { msgfolderroot: ROOT, inbox: INBOX, sentitems: SENT, drafts: DRAFTS };
const [FROM_GRACE, FROM_LIST, FROM_PRIVATE, FROM_ME, DRAFT, LEGACY] = ["MSGGRACE0001", "MSGLIST00001", "MSGPRIVATE01", "MSGSENT00001", "MSGDRAFT0001", "MSGLEGACY001"] as const;

function folderOf(id: string, name: string, parent: string | null): JsonObject {
	return { id, displayName: name, parentFolderId: parent, childFolderCount: 0, unreadItemCount: 1, totalItemCount: 2 };
}

function person(address: string, name?: string): JsonObject {
	return { emailAddress: { name: name ?? address, address } };
}

function messageOf(id: string, folder: string, sender: string, fields: JsonObject = {}): JsonObject {
	return {
		id,
		conversationId: `conv-${id}`,
		parentFolderId: folder,
		subject: `About ${id}`,
		from: person(sender),
		toRecipients: [person("me@contoso.com")],
		ccRecipients: [],
		bccRecipients: [],
		replyTo: [],
		receivedDateTime: "2026-09-30T10:00:00Z",
		sentDateTime: "2026-09-30T09:59:00Z",
		isRead: false,
		isDraft: false,
		hasAttachments: false,
		importance: "normal",
		bodyPreview: "Hello",
		categories: [],
		body: { contentType: "text", content: "Hello there" },
		...fields,
	};
}

type Hook = (method: string, path: string, params: { [name: string]: string }) => Response | null;

/**
 * Microsoft Graph's mail API (test_outlook.py `FakeGraph`). Folders: Inbox (with Projects and Private under
 * it), Sent Items and Drafts, under msgfolderroot; and a search folder outside that tree, which collects the
 * mail in Private.
 */
class FakeGraph {
	folders: { [id: string]: JsonObject } = {
		[ROOT]: folderOf(ROOT, "Top of Information Store", HIDDEN_ROOT),
		[HIDDEN_ROOT]: folderOf(HIDDEN_ROOT, "Root", null),
		[INBOX]: { ...folderOf(INBOX, "Inbox", ROOT), childFolderCount: 2 },
		[PROJECTS]: folderOf(PROJECTS, "Projects", INBOX),
		[PRIVATE]: folderOf(PRIVATE, "Private", INBOX),
		[SENT]: folderOf(SENT, "Sent Items", ROOT),
		[DRAFTS]: folderOf(DRAFTS, "Drafts", ROOT),
		[SEARCH]: folderOf(SEARCH, "Everything private", HIDDEN_ROOT),
	};
	messages: { [id: string]: JsonObject } = {
		[FROM_GRACE]: messageOf(FROM_GRACE, INBOX, "Grace@Example.com", { hasAttachments: true }),
		[FROM_LIST]: messageOf(FROM_LIST, PROJECTS, "ada@partner.org", { replyTo: [person("list@partner.org")] }),
		[FROM_PRIVATE]: messageOf(FROM_PRIVATE, PRIVATE, "ada@partner.org", { subject: SECRET }),
		[FROM_ME]: messageOf(FROM_ME, SENT, "me@contoso.com", { toRecipients: [person("grace@example.com")] }),
		[DRAFT]: messageOf(DRAFT, DRAFTS, "grace@example.com", { isDraft: true }),
		[LEGACY]: messageOf(LEGACY, INBOX, "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=ADA"),
	};
	user: JsonObject = {
		id: "00000000-0000-0000-0000-00000000a0a0",
		displayName: "Me",
		mail: "me@contoso.com",
		userPrincipalName: "me@contoso.onmicrosoft.com",
	};
	requests: Received[] = [];
	writes: [string, JsonObject][] = [];
	hook: Hook | null = null;

	#notFound(): Response {
		return jsonResponse(404, { error: { code: "ErrorItemNotFound", message: SECRET } });
	}

	#page(path: string, items: Json[], params: { [name: string]: string }): Response {
		const top = Number(params.$top ?? 10);
		let start = Number(params.$skip ?? 0);
		if ("$skiptoken" in params) start = Number((params.$skiptoken as string).replace(/^p/, ""));
		const body: JsonObject = { value: items.slice(start, start + top) };
		if (start + top < items.length) body["@odata.nextLink"] = `https://graph.microsoft.com/v1.0${path}?$skiptoken=p${start + top}`;
		return jsonResponse(200, body);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const request = await received(input, init);
		this.requests.push(request);
		const path = request.path;
		const hooked = this.hook?.(request.method, path, request.params) ?? null;
		if (hooked !== null) return hooked;
		const parts = path.replace(/^\/+|\/+$/g, "").split("/");
		if (request.method === "POST") {
			this.writes.push([path, JSON.parse(request.body) as JsonObject]);
			if (path === "/me/sendMail" || (parts[0] === "me" && parts[1] === "messages" && parts[3] === "reply" && parts.length === 4)) return new Response(null, { status: 202 });
			throw new Error(path);
		}
		const [a, b, c, d] = parts;
		if (a === "me" && parts.length === 1) return jsonResponse(200, this.user);
		if (a === "me" && b === "mailFolders" && parts.length === 2) {
			return this.#page(path, Object.values(this.folders).filter((f) => f.parentFolderId === ROOT), request.params);
		}
		if (a === "me" && b === "mailFolders" && parts.length === 3) {
			const folder = this.folders[WELL_KNOWN[(c as string).toLowerCase()] ?? (c as string)];
			return folder ? jsonResponse(200, folder) : this.#notFound();
		}
		if (a === "me" && b === "mailFolders" && d === "childFolders" && parts.length === 4) {
			if (!(c as string in this.folders)) return this.#notFound();
			return this.#page(path, Object.values(this.folders).filter((f) => f.parentFolderId === c), request.params);
		}
		if (a === "me" && b === "mailFolders" && d === "messages" && parts.length === 4) {
			if (!(c as string in this.folders)) return this.#notFound();
			const source = c === SEARCH ? PRIVATE : c;
			return this.#page(path, Object.values(this.messages).filter((m) => m.parentFolderId === source), request.params);
		}
		if (a === "me" && b === "messages" && parts.length === 3) {
			const message = this.messages[c as string];
			return message ? jsonResponse(200, message) : this.#notFound();
		}
		if (a === "me" && b === "messages" && d === "attachments" && parts.length === 4) {
			const attachment = { id: "ATT1", name: "plan.pdf", contentType: "application/pdf", size: 10, isInline: false, contentBytes: "U0VDUkVU" };
			return jsonResponse(200, { value: [attachment] });
		}
		throw new Error(path);
	};

	paths(): string[] {
		return this.requests.map((request) => request.path);
	}

	client(): GraphClient {
		return outlookConnector().client("token", settingsIo(this.fetch));
	}
}

const SCOPES = ["Mail.Read", "Mail.Send", "User.Read", "email", "openid", "profile"];

type Grants = { [key: string]: string[] };

function folder(resource: string, actions = ["read"]): Grants {
	return { [`folder:${resource}`]: actions };
}

function recipient(resource: string, actions = ["send"]): Grants {
	return { [`recipient:${resource}`]: actions };
}

function start(graph: FakeGraph, grants: Grants, options: { scopes?: string[]; ceiling?: ReturnType<typeof ceilingRow>[] } = {}) {
	return startRun(outlookConnector(), graph.fetch, { scopes: options.scopes ?? SCOPES, grants, ceiling: options.ceiling ?? [] });
}

type Run = Awaited<ReturnType<typeof start>>;
type Item = { [key: string]: Json };

async function items(run: Run, tool: string, args: Json): Promise<Item[]> {
	return (await run.ok(tool, args)).result.items as Item[];
}

async function ids(run: Run, tool: string, args: Json): Promise<string[]> {
	return (await items(run, tool, args)).map((item) => item.id as string);
}

describe("addresses", () => {
	const canonical: [string, string][] = [
		["Ada@Example.COM", "ada@example.com"],
		[" ada.lovelace+notes@mail.example.com ", "ada.lovelace+notes@mail.example.com"],
		["o'brien@bücher.de", "o'brien@xn--bcher-kva.de"],
		["Giulia@TrattoriaRossa.example", "giulia@trattoriarossa.example"],
	];
	for (const [raw, expected] of canonical) {
		test(`test_addresses_are_canonical: ${JSON.stringify(raw)}`, () => {
			expect(addresses.parse(raw)).toBe(expected);
			expect(addresses.validId(expected)).toBe(true);
		});
	}

	const odd = [
		"ada",
		"ada@",
		"@example.com",
		"ada@@example.com",
		"a@b@example.com",
		'"ada"@example.com',
		"ada lovelace@example.com",
		".ada@example.com",
		"ada.@example.com",
		"a..b@example.com",
		"ada@localhost",
		"ada@127.0.0.1",
		"ada@co.uk",
		"ada@com",
		"ada@example",
		"ada@site.invalid",
		"Ada <ada@example.com>",
		"ädä@example.com",
		"ada@exa\nmple.com",
		`${"a".repeat(65)}@example.com`,
	];
	for (const raw of odd) {
		test(`test_odd_addresses_are_refused: ${JSON.stringify(raw)}`, () => {
			expect(() => addresses.parse(raw)).toThrow(expect.objectContaining({ code: "INVALID_ADDRESS" }));
		});
	}

	test("test_address_patterns_cover_one_domain", () => {
		expect(addresses.ancestors("ada@mail.example.com")).toEqual(["*@mail.example.com"]);
		expect(addresses.choices("Ada@Example.com")).toEqual(["ada@example.com", "*@example.com"]);
		expect(addresses.choices("example.com")).toEqual(["*@example.com"]);
		expect(addresses.choices("@example.com")).toEqual(["*@example.com"]);
		expect(addresses.choices("*@Example.com")).toEqual(["*@example.com"]);
		expect(addresses.choices("giulia@trattoriarossa.example")).toEqual(["giulia@trattoriarossa.example", "*@trattoriarossa.example"]);
		expect(addresses.name("*@example.com")).toBe("Everyone at example.com");
		for (const resource of ["*@co.uk", "*@*.example.com", "*@Example.com", "Ada@example.com", "*", "unsupported"]) {
			expect(addresses.validId(resource)).toBe(false);
		}
		for (const query of ["co.uk", "ada@co.uk", "*.example.com"]) expect(() => addresses.choices(query)).toThrow(OperationError);
	});

	test("parse, valid_id and choices agree with Python on 200 cases", () => {
		const outcome = (call: () => unknown) => {
			try {
				return { value: call() };
			} catch (error) {
				if (error instanceof OperationError) return { error: error.code };
				throw error;
			}
		};
		const { parse, valid_id, choices } = vectors("outlook") as { [name: string]: { [raw: string]: unknown } };
		expect(Object.keys(parse as object).length).toBeGreaterThan(80);
		expect(Object.fromEntries(Object.keys(parse as object).map((raw) => [raw, outcome(() => addresses.parse(raw))]))).toEqual(parse);
		expect(Object.fromEntries(Object.keys(valid_id as object).map((raw) => [raw, addresses.validId(raw)]))).toEqual(valid_id);
		expect(Object.fromEntries(Object.keys(choices as object).map((raw) => [raw, outcome(() => addresses.choices(raw))]))).toEqual(choices);
	});
});

describe("times and tool inputs, as today's Python reads them", () => {
	test("_moment agrees with Python, Python's OverflowError included", () => {
		const cases = vectors("outlook").moment as { [raw: string]: { value?: string; error?: string } };
		expect(Object.keys(cases).length).toBeGreaterThan(100);
		const actual: { [raw: string]: unknown } = {};
		for (const raw of Object.keys(cases)) {
			try {
				actual[raw] = { value: moment(raw) };
			} catch (error) {
				if (error instanceof OverflowError) actual[raw] = { error: "OverflowError" };
				else if (error instanceof Error && error.name === "ValueError") actual[raw] = { error: "ValueError", message: error.message };
				else throw error;
			}
		}
		const expected: { [raw: string]: unknown } = {};
		for (const [raw, outcome] of Object.entries(cases)) expected[raw] = outcome;
		expect(actual).toEqual(expected);
	});

	test("the message filter is Graph's $filter", () => {
		const cases = vectors("outlook").filters as { args: JsonObject; filter: string | null }[];
		expect(cases).toHaveLength(5);
		for (const { args, filter } of cases) {
			expect(messageFilter({ unread_only: (args.unread_only as boolean) ?? false, after: args.after ? moment(args.after as string) : null, before: args.before ? moment(args.before as string) : null })).toBe(filter);
		}
	});

	const tools: [string, string][] = [
		["list_folders", "list_folders"],
		["list_messages", "list_messages"],
		["read_message", "read_message"],
		["send_message", "send_message"],
		["reply", "reply"],
	];
	for (const [key, name] of tools) {
		test(`inputs of ${name}: normalized arguments and Pydantic's messages`, async () => {
			const cases = (vectors("outlook").inputs as { [tool: string]: { args: Json; data?: Json; message?: string; raises?: string }[] })[key] as { args: Json; data?: Json; message?: string; raises?: string }[];
			expect(cases.length).toBeGreaterThan(1);
			const op = operation(outlookConnector(), name);
			const actual = [];
			for (const { args } of cases) {
				try {
					const result = await validateInput(op.input as never, args);
					actual.push(result.ok ? { args, data: result.data } : { args, message: result.message });
				} catch (error) {
					// Pydantic only turns a ValueError into a validation error: Python's OverflowError and TypeError escape it.
					if (error instanceof OverflowError) actual.push({ args, raises: "OverflowError" });
					else if (error instanceof TypeError) actual.push({ args, raises: "TypeError" });
					else throw error;
				}
			}
			expect(actual).toEqual(cases);
		});
	}
});

describe("the connector outside a run", () => {
	test("test_account_discovery_and_names", async () => {
		const graph = new FakeGraph();
		const connector = outlookConnector();
		const account = await connector.account(graph.client());
		expect([account.id, account.label]).toEqual([graph.user.id, "me@contoso.com"]);
		let found = await connector.discover(graph.client(), "folder", { query: null, cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([
			[INBOX, "Inbox"],
			[SENT, "Sent Items"],
			[DRAFTS, "Drafts"],
			[PROJECTS, "Inbox/Projects"],
			[PRIVATE, "Inbox/Private"],
		]);
		found = await connector.discover(graph.client(), "folder", { query: "inbox/PRO", cursor: null });
		expect(found.items.map((item) => item.id)).toEqual([PROJECTS]);
		found = await connector.discover(graph.client(), "recipient", { query: "Ada@Partner.org", cursor: null });
		expect(found.items.map((item) => [item.id, item.name])).toEqual([
			["ada@partner.org", "ada@partner.org"],
			["*@partner.org", "Everyone at partner.org"],
		]);
		let names = await connector.describe(graph.client(), "folder", [PROJECTS, INBOX, SEARCH, ROOT, HIDDEN_ROOT, "NOSUCHFOLDER", "inbox", "*"]);
		expect(names).toEqual({ [PROJECTS]: "Inbox/Projects", [INBOX]: "Inbox" });
		names = await connector.describe(graph.client(), "recipient", ["*@partner.org", "Ada@x.com", "*@co.uk"]);
		expect(names).toEqual({ "*@partner.org": "Everyone at partner.org" });
	});

	test("every request asks for immutable ids and carries the token", async () => {
		const graph = new FakeGraph();
		await outlookConnector().account(graph.client());
		await outlookConnector().discover(graph.client(), "folder", { query: null, cursor: null });
		expect(graph.requests.length).toBeGreaterThan(2);
		for (const request of graph.requests) {
			expect(request.headers.get("prefer")).toBe('IdType="ImmutableId"');
			expect(request.headers.get("authorization")).toBe("Bearer token");
			expect(request.host).toBe("graph.microsoft.com");
		}
	});

	test("an account that will not name its aliases is read without them", async () => {
		const graph = new FakeGraph();
		graph.hook = (_method, path, params) => (path === "/me" && (params.$select ?? "").includes("proxyAddresses") ? jsonResponse(400, { error: { code: "BadRequest" } }) : null);
		const user = await graph.client().identities();
		expect([user.mail, user.proxy_addresses]).toEqual(["me@contoso.com", []]);
	});

	test("an on-premises mailbox is named as unsupported", async () => {
		const graph = new FakeGraph();
		graph.hook = () => jsonResponse(404, { error: { code: "MailboxNotSupportedForRESTAPI" } });
		await expect(graph.client().me()).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT" });
	});

	test("discovery follows a few pages of folders and stops at its limits", async () => {
		const graph = new FakeGraph();
		for (let n = 0; n < 130; n++) graph.folders[`EXTRAFOLDER${String(n).padStart(3, "0")}`] = folderOf(`EXTRAFOLDER${String(n).padStart(3, "0")}`, `Extra ${n}`, ROOT);
		const found = await outlookConnector().discover(graph.client(), "folder", { query: "extra 12", cursor: null });
		// 130 folders at 100 a page: two pages; "Extra 12" also matches "Extra 120" to "Extra 129".
		expect(found.items).toHaveLength(11);
		expect(graph.requests.filter((request) => request.path === "/me/mailFolders")).toHaveLength(2);
	});
});

describe("reading", () => {
	test("test_folders_without_a_grant_or_out_of_reach_look_alike", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(PROJECTS));
		const [listed] = await items(run, "outlook_list_messages", { folder: PROJECTS });
		expect(listed?.id).toBe(FROM_LIST);
		expect(listed?.folder_id).toBe(PROJECTS);
		expect(listed?.from).toEqual({ name: "ada@partner.org", address: "ada@partner.org" });

		graph.requests.length = 0;
		for (const name of [INBOX, PRIVATE, "inbox", "Inbox", "sentitems", SEARCH, ROOT, HIDDEN_ROOT, "NOSUCHFOLDER"]) {
			expect(await run.code("outlook_list_messages", { folder: name })).toBe("POLICY_DENIED");
		}
		for (const message of [FROM_GRACE, FROM_PRIVATE, "NOSUCHMESSAGE"]) {
			expect(await run.code("outlook_read_message", { message })).toBe("POLICY_DENIED");
		}
		// Nothing but where the folder or message is was asked for.
		expect(graph.paths().some((path) => path.endsWith("/messages") || path.endsWith("/attachments"))).toBe(false);
		for (const name of ["Projects", "inbox/projects", "../me", "short"]) {
			expect(await run.code("outlook_list_messages", { folder: name })).toBe("INVALID_ARGUMENTS");
		}
	});

	test("test_a_grant_on_a_folder_covers_its_subfolders_and_a_deny_holds", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX), { ceiling: [ceilingRow("folder", PRIVATE, "deny")] });
		expect(await ids(run, "outlook_list_messages", { folder: "inbox" })).toEqual([FROM_GRACE, LEGACY]);
		expect(await ids(run, "outlook_list_messages", { folder: PROJECTS })).toEqual([FROM_LIST]);
		expect(await run.code("outlook_list_messages", { folder: PRIVATE })).toBe("POLICY_DENIED");
		expect(await run.code("outlook_read_message", { message: FROM_PRIVATE })).toBe("POLICY_DENIED");
		const children = await items(run, "outlook_list_folders", { parent: "inbox" });
		expect(children.map((c) => [c.id, c.name, c.parent_id])).toEqual([[PROJECTS, "Projects", INBOX]]);
		expect(await ids(run, "outlook_list_folders", {})).toEqual([INBOX]);
	});

	test("test_folders_outside_the_mailbox_tree_are_refused_even_with_every_folder", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder("*"));
		expect(await ids(run, "outlook_list_folders", {})).toEqual([INBOX, SENT, DRAFTS]);
		for (const name of [SEARCH, ROOT, HIDDEN_ROOT]) {
			expect(await run.code("outlook_list_messages", { folder: name })).toBe("POLICY_DENIED");
			expect(await run.code("outlook_list_folders", { parent: name })).toBe("POLICY_DENIED");
		}
		// A folder whose chain loops never reaches the root.
		(graph.folders[PROJECTS] as JsonObject).parentFolderId = PRIVATE;
		(graph.folders[PRIVATE] as JsonObject).parentFolderId = PROJECTS;
		expect(await run.code("outlook_list_messages", { folder: PROJECTS })).toBe("POLICY_DENIED");
	});

	test("a chain longer than the depth limit, or needing more lookups than allowed, is never a resource", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder("*"));
		let parent: string = INBOX;
		for (let n = 0; n < 5; n++) {
			const id = `DEEPFOLDER${String(n).padStart(2, "0")}`;
			graph.folders[id] = folderOf(id, `Deep ${n}`, parent);
			parent = id;
		}
		const before = { ...LIMITS };
		try {
			LIMITS.maxDepth = 3;
			expect(await run.code("outlook_list_messages", { folder: parent })).toBe("POLICY_DENIED");
			LIMITS.maxDepth = before.maxDepth;
			LIMITS.maxLookups = 2;
			expect(await run.code("outlook_list_messages", { folder: parent })).toBe("POLICY_DENIED");
			LIMITS.maxLookups = before.maxLookups;
			expect(await ids(run, "outlook_list_messages", { folder: parent })).toEqual([]);
		} finally {
			Object.assign(LIMITS, before);
		}
	});

	const SEARCH_IN_INBOX = "INBOXSEARCH0";
	const [HIDDEN, HIDDEN_CHILD, HIDDEN_MAIL] = ["HIDDENFOLD00", "HIDDENCHILD0", "MSGHIDDEN001"] as const;

	test("test_search_and_hidden_folders_are_refused_wherever_they_sit", async () => {
		const graph = new FakeGraph();
		// Graph lets a search folder sit in any folder, and a hidden folder too; both can be reached by id.
		graph.folders[SEARCH_IN_INBOX] = { ...folderOf(SEARCH_IN_INBOX, "Everything private", INBOX), "@odata.type": "#microsoft.graph.mailSearchFolder" };
		graph.folders[HIDDEN] = { ...folderOf(HIDDEN, "Hidden", INBOX), isHidden: true };
		graph.folders[HIDDEN_CHILD] = folderOf(HIDDEN_CHILD, "Below hidden", HIDDEN);
		graph.messages[HIDDEN_MAIL] = messageOf(HIDDEN_MAIL, HIDDEN_CHILD, "grace@example.com", { subject: SECRET });
		(graph.folders[PROJECTS] as JsonObject)["@odata.type"] = "#microsoft.graph.mailFolder";
		const run = await start(graph, folder(INBOX));

		for (const name of [SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD]) {
			expect(await run.code("outlook_list_messages", { folder: name })).toBe("POLICY_DENIED");
			expect(await run.code("outlook_list_folders", { parent: name })).toBe("POLICY_DENIED");
		}
		expect(await run.code("outlook_read_message", { message: HIDDEN_MAIL })).toBe("POLICY_DENIED");
		const children = await items(run, "outlook_list_folders", { parent: INBOX });
		expect(children.map((c) => c.id)).toEqual([PROJECTS, PRIVATE]);
		expect(JSON.stringify(children)).not.toContain(SECRET);

		const connector = outlookConnector();
		const found = await connector.discover(graph.client(), "folder", { query: null, cursor: null });
		const listed = new Set(found.items.map((item) => item.id));
		for (const hidden of [SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD]) expect(listed.has(hidden)).toBe(false);
		const names = await connector.describe(graph.client(), "folder", [SEARCH_IN_INBOX, HIDDEN, HIDDEN_CHILD, PROJECTS]);
		expect(names).toEqual({ [PROJECTS]: "Inbox/Projects" });
	});

	test("test_listings_leave_out_what_lives_elsewhere", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, folder(INBOX));
		graph.hook = (_method, path) => {
			if (path === `/me/mailFolders/${INBOX}/messages`) return jsonResponse(200, { value: [graph.messages[FROM_GRACE] as Json, graph.messages[FROM_PRIVATE] as Json] });
			if (path === `/me/mailFolders/${INBOX}/childFolders`) {
				const stray = folderOf("STRAYFOLDER0", "Stray", SENT);
				return jsonResponse(200, { value: [graph.folders[PROJECTS] as Json, stray] });
			}
			if (path === "/me/mailFolders") return jsonResponse(200, { value: [graph.folders[INBOX] as Json, graph.folders[SEARCH] as Json] });
			return null;
		};
		const messages = await items(run, "outlook_list_messages", { folder: INBOX });
		expect(messages.map((m) => m.id)).toEqual([FROM_GRACE]);
		expect(JSON.stringify(messages)).not.toContain(SECRET);
		expect(await ids(run, "outlook_list_folders", { parent: INBOX })).toEqual([PROJECTS]);
		run = await start(graph, folder("*"));
		expect(await ids(run, "outlook_list_folders", {})).toEqual([INBOX]);
	});

	test("test_filters_and_search", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX));
		const sentParams = () => {
			const found = graph.requests.filter((request) => request.path.endsWith("/messages"));
			expect(found).toHaveLength(1);
			graph.requests.length = 0;
			return (found[0] as Received).params;
		};
		await run.ok("outlook_list_messages", { folder: INBOX, unread_only: true, after: "2026-09-01T02:00:00+02:00", before: "2026-10-01" });
		let params = sentParams();
		expect(params.$filter).toBe("receivedDateTime ge 2026-09-01T00:00:00Z and receivedDateTime lt 2026-10-01T00:00:00Z and isRead eq false");
		expect(params.$orderby).toBe("receivedDateTime desc");
		expect("$search" in params).toBe(false);
		await run.ok("outlook_list_messages", { folder: INBOX, unread_only: true });
		expect(sentParams().$filter).toBe("receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false");
		await run.ok("outlook_list_messages", { folder: INBOX, query: "budget 2026" });
		params = sentParams();
		expect(params.$search).toBe('"budget 2026"');
		expect("$filter" in params).toBe(false);
		expect("$orderby" in params).toBe(false);

		for (const args of [{ query: "budget", unread_only: true }, { query: 'budget" OR from:x' }, { query: "back\\slash" }, { after: "yesterday" }, { after: "2026-09-01T00:00:00Z' or true" }] as JsonObject[]) {
			expect(await run.code("outlook_list_messages", { folder: INBOX, ...args })).toBe("INVALID_ARGUMENTS");
		}
	});

	test("test_pages_follow_graphs_links_only_through_their_parameters", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX));
		const first = await run.ok("outlook_list_messages", { folder: INBOX, limit: 1 });
		expect((first.result.items as Item[]).map((item) => item.id)).toEqual([FROM_GRACE]);
		const cursor = first.result.next_cursor as string;
		expect(cursor).not.toContain("skiptoken");
		expect(cursor).not.toContain("graph");
		graph.requests.length = 0;
		const second = await run.ok("outlook_list_messages", { folder: INBOX, limit: 1, cursor });
		expect((second.result.items as Item[]).map((item) => item.id)).toEqual([LEGACY]);
		const requests = graph.requests.filter((request) => request.path.endsWith("/messages"));
		expect(requests).toHaveLength(1);
		expect(requests[0]?.host).toBe("graph.microsoft.com");
		expect(requests[0]?.params.$skiptoken).toBe("p1");

		graph.hook = (_method, path) =>
			path.endsWith("/messages") ? jsonResponse(200, { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=a%26b%20c" }) : null;
		expect(await run.code("outlook_list_messages", { folder: INBOX })).toBe("PROVIDER_LIMIT");
	});

	test("test_reading_a_message", async () => {
		const graph = new FakeGraph();
		const grace = graph.messages[FROM_GRACE] as JsonObject;
		(grace.body as JsonObject).content = `${"x".repeat(600)}end`;
		grace.replyTo = [person("desk@example.com")];
		const run = await start(graph, folder(INBOX));
		const [message] = await items(run, "outlook_read_message", { message: FROM_GRACE, max_chars: 500 });
		expect(message?.body).toBe("x".repeat(500));
		expect(message?.total_chars).toBe(603);
		expect(message?.next_offset).toBe(500);
		expect(message?.reply_to).toEqual([{ name: "desk@example.com", address: "desk@example.com" }]);
		expect(message?.attachments).toEqual([{ name: "plan.pdf", content_type: "application/pdf", size: 10, inline: false }]);
		const reads = graph.requests.filter((request) => request.path.endsWith(FROM_GRACE) && (request.params.$select ?? "").includes("body"));
		expect(reads).toHaveLength(1);
		expect(reads[0]?.headers.get("prefer")).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
		const [rest] = await items(run, "outlook_read_message", { message: FROM_GRACE, max_chars: 500, offset: 500 });
		expect(rest?.body).toBe(`${"x".repeat(100)}end`);
		expect(rest?.next_offset).toBeNull();
	});

	test("a body is counted and cut in code points", async () => {
		const graph = new FakeGraph();
		(graph.messages[FROM_GRACE] as JsonObject).body = { contentType: "text", content: "😀".repeat(600) };
		const run = await start(graph, folder(INBOX));
		const [message] = await items(run, "outlook_read_message", { message: FROM_GRACE, max_chars: 500 });
		expect(message?.total_chars).toBe(600);
		expect(message?.body).toBe("😀".repeat(500));
		expect(message?.next_offset).toBe(500);
	});

	test("test_mail_moved_while_the_call_runs_is_refused", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX));

		function movedAfterResolving(record: JsonObject, change: JsonObject): void {
			let seen = 0;
			graph.hook = (_method, path) => {
				if (path.slice(path.lastIndexOf("/") + 1) !== record.id) return null;
				seen++;
				return jsonResponse(200, seen === 1 ? record : { ...record, ...change });
			};
		}

		// The message moved to a folder without a grant.
		movedAfterResolving(graph.messages[FROM_GRACE] as JsonObject, { parentFolderId: PRIVATE });
		expect(await run.code("outlook_read_message", { message: FROM_GRACE })).toBe("MAIL_MOVED");
		// The folder moved out from under the granted one.
		movedAfterResolving(graph.folders[PROJECTS] as JsonObject, { parentFolderId: SENT });
		expect(await run.code("outlook_list_messages", { folder: PROJECTS })).toBe("MAIL_MOVED");
		movedAfterResolving(graph.folders[PROJECTS] as JsonObject, { parentFolderId: SENT });
		expect(await run.code("outlook_read_message", { message: FROM_LIST })).toBe("MAIL_MOVED");
		movedAfterResolving(graph.folders[PROJECTS] as JsonObject, { parentFolderId: SENT });
		expect(await run.code("outlook_list_folders", { parent: PROJECTS })).toBe("MAIL_MOVED");
	});

	test("test_reads_with_errors_or_too_much_data_are_refused", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX));
		graph.hook = (_method, path) => (path.endsWith("/messages") ? jsonResponse(200, { value: [{ id: "x".repeat(5 * 1024 * 1024) }] }) : null);
		expect(await run.code("outlook_list_messages", { folder: INBOX })).toBe("RESPONSE_TOO_LARGE");
		graph.hook = () => jsonResponse(404, { error: { code: "MailboxNotEnabledForRESTAPI" } });
		expect(await run.code("outlook_read_message", { message: FROM_GRACE })).toBe("UNSUPPORTED_ACCOUNT");
		graph.hook = () => new Response(null, { status: 503, headers: { "retry-after": "5" } });
		expect(await run.code("outlook_list_messages", { folder: INBOX })).toBe("PROVIDER_RATE_LIMITED");
		// Last: the connection is then marked as needing reconnecting.
		graph.hook = () => jsonResponse(401, { error: { code: "InvalidAuthenticationToken" } });
		expect(await run.code("outlook_list_messages", { folder: INBOX })).toBe("CONNECTION_UNAUTHORIZED");
	});

	test("a response that does not fit is an unexpected one, and Graph's text never reaches the model", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, folder(INBOX));
		graph.hook = (_method, path) => (path.endsWith("/messages") ? jsonResponse(200, { value: [{ id: 5 }] }) : null);
		const failed = await run.error("outlook_list_messages", { folder: INBOX });
		expect(failed.code).toBe("PROVIDER_FAILED");
		expect(failed.message).toBe("Outlook returned an unexpected response.");
		graph.hook = () => jsonResponse(404, { error: { code: "ErrorItemNotFound", message: SECRET } });
		const missing = await run.error("outlook_read_message", { message: FROM_GRACE });
		expect(JSON.stringify(missing)).not.toContain(SECRET);
	});
});

describe("sending", () => {
	test("test_sending_needs_every_recipient", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { ...recipient("*@example.com"), ...recipient("ada@partner.org") });
		const [sent] = await items(run, "outlook_send_message", { to: ["Grace@Example.com"], cc: ["ada@partner.org"], subject: "Plans", body: "Hi <b>Grace</b>\r\n\tthanks" });
		expect(sent).toEqual({ sent: true, to: ["grace@example.com"], cc: ["ada@partner.org"], bcc: [], subject: "Plans" });
		expect(graph.writes).toHaveLength(1);
		const [path, payload] = graph.writes[0] as [string, JsonObject];
		expect(path).toBe("/me/sendMail");
		expect(payload.saveToSentItems).toBe(true);
		expect(payload.message).toEqual({
			subject: "Plans",
			body: { contentType: "Text", content: "Hi <b>Grace</b>\r\n\tthanks" },
			toRecipients: [{ emailAddress: { address: "grace@example.com" } }],
			ccRecipients: [{ emailAddress: { address: "ada@partner.org" } }],
			bccRecipients: [],
		});

		const send = { to: ["grace@example.com"], subject: "x", body: "x" };
		for (const change of [{ bcc: ["bob@partner.org"] }, { cc: ["grace@mail.example.com"] }, { to: ["grace@example.com.evil.org"] }] as JsonObject[]) {
			expect(await run.code("outlook_send_message", { ...send, ...change })).toBe("POLICY_DENIED");
		}
		const invalid: JsonObject[] = [
			{ cc: ["Grace@example.com"] },
			{ to: [] },
			{ to: ["Grace <grace@example.com>"] },
			{ to: Array.from({ length: 6 }, (_, n) => `p${n}@example.com`), cc: Array.from({ length: 5 }, (_, n) => `q${n}@example.com`) },
			{ subject: "a\r\nBcc: x@evil.org" },
			{ body: "bell\x07" },
			{ from: "ceo@example.com" },
		];
		for (const change of invalid) expect(await run.code("outlook_send_message", { ...send, ...change })).toBe("INVALID_ARGUMENTS");
		expect(graph.writes).toHaveLength(1);
	});

	test("the write is one POST with an ASCII JSON body, as json.dumps writes it", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, recipient("*@example.com"));
		await run.ok("outlook_send_message", { to: ["grace@example.com"], subject: "Grüße 😀", body: "x" });
		const post = graph.requests.filter((request) => request.method === "POST");
		expect(post).toHaveLength(1);
		expect(post[0]?.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(post[0]?.body).toContain('"subject": "Gr\\u00fc\\u00dfe \\ud83d\\ude00"');
		expect(post[0]?.body).toContain('"saveToSentItems": true');
	});

	test("test_write_outcomes_follow_graphs_status", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, recipient("*@example.com"));
		const send = { to: ["grace@example.com"], subject: "x", body: "x" };
		const answer = (status: number) => {
			graph.hook = (method) => (method === "POST" ? jsonResponse(status, { error: { code: "x", message: SECRET } }) : null);
		};
		answer(400);
		expect(await run.code("outlook_send_message", send)).toBe("PROVIDER_REJECTED");
		answer(403);
		expect(await run.code("outlook_send_message", { ...send, body: "y" })).toBe("PROVIDER_FORBIDDEN");
		// A refusal before sending leaves writes open; an error that may follow a send pauses them.
		answer(500);
		expect(await run.code("outlook_send_message", { ...send, body: "z" })).toBe("WRITE_UNCERTAIN");
		graph.hook = null;
		expect(await run.code("outlook_send_message", { ...send, body: "w" })).toBe("WRITE_UNCERTAIN");
	});
});

describe("replying", () => {
	test("test_replying_goes_to_exactly_the_authorized_addresses", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, { ...folder(INBOX), ...recipient("grace@example.com") });
		const [replied] = await items(run, "outlook_reply", { message: FROM_GRACE, body: "Thanks" });
		expect(replied).toEqual({ replied: true, message: FROM_GRACE, to: ["grace@example.com"] });
		expect(graph.writes).toHaveLength(1);
		const [path, payload] = graph.writes[0] as [string, JsonObject];
		expect(path).toBe(`/me/messages/${FROM_GRACE}/reply`);
		expect(payload).toEqual({
			message: {
				toRecipients: [{ emailAddress: { address: "grace@example.com" } }],
				ccRecipients: [],
				bccRecipients: [],
				body: { contentType: "Text", content: "Thanks" },
			},
		});
		// Replies go to the reply-to address, not the sender.
		expect(await run.code("outlook_reply", { message: FROM_LIST, body: "x" })).toBe("POLICY_DENIED");

		graph.writes.length = 0;
		run = await start(graph, { ...folder(PROJECTS), ...recipient("ada@partner.org") });
		expect(await run.code("outlook_reply", { message: FROM_LIST, body: "x" })).toBe("POLICY_DENIED");
		run = await start(graph, { ...folder(PROJECTS), ...recipient("*@partner.org") });
		const [again] = await items(run, "outlook_reply", { message: FROM_LIST, body: "x" });
		expect(again?.to).toEqual(["list@partner.org"]);
		// Sending alone does not let an agent reply to mail it may not read.
		run = await start(graph, { ...folder(SENT), ...recipient("*") });
		for (const message of [FROM_GRACE, FROM_PRIVATE, "NOSUCHMESSAGE"]) {
			expect(await run.code("outlook_reply", { message, body: "x" })).toBe("POLICY_DENIED");
		}
		expect(graph.writes).toHaveLength(1);
	});

	test("test_replies_whose_recipients_are_unclear_are_refused", async () => {
		const graph = new FakeGraph();
		let run = await start(graph, { ...folder("*"), ...recipient("grace@example.com"), ...recipient("*@contoso.com") });
		// An address Minerva cannot read is refused like one without a grant...
		expect(await run.code("outlook_reply", { message: LEGACY, body: "x" })).toBe("POLICY_DENIED");
		run = await start(graph, { ...folder("*"), ...recipient("*") });
		// ...and, with every recipient allowed, refused for what it is.
		expect(await run.code("outlook_reply", { message: LEGACY, body: "x" })).toBe("UNSUPPORTED_RECIPIENT");
		expect(await run.code("outlook_reply", { message: DRAFT, body: "x" })).toBe("UNSUPPORTED_MESSAGE");
		expect(await run.code("outlook_reply", { message: FROM_ME, body: "x" })).toBe("UNSUPPORTED_MESSAGE");
		graph.messages[FROM_ME] = { ...(graph.messages[FROM_ME] as JsonObject), from: person("ME@contoso.onmicrosoft.com") };
		expect(await run.code("outlook_reply", { message: FROM_ME, body: "x" })).toBe("UNSUPPORTED_MESSAGE");

		function changedAfterResolving(change: JsonObject): void {
			let seen = 0;
			graph.hook = (_method, path) => {
				if (!path.endsWith(FROM_GRACE)) return null;
				seen++;
				const message = graph.messages[FROM_GRACE] as JsonObject;
				return jsonResponse(200, seen === 1 ? message : { ...message, ...change });
			};
		}

		changedAfterResolving({ replyTo: [person("attacker@evil.org")] });
		expect(await run.code("outlook_reply", { message: FROM_GRACE, body: "x" })).toBe("MESSAGE_CHANGED");
		changedAfterResolving({ isDraft: true });
		expect(await run.code("outlook_reply", { message: FROM_GRACE, body: "x" })).toBe("UNSUPPORTED_MESSAGE");
		expect(graph.writes).toEqual([]);
	});

	test("test_replies_to_the_accounts_own_mail_are_refused_however_it_was_sent", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { ...folder("*"), ...recipient("*") });
		const refusedReply = (change: JsonObject): Promise<string> => {
			graph.messages[FROM_GRACE] = { ...(graph.messages[FROM_GRACE] as JsonObject), ...change };
			return run.code("outlook_reply", { message: FROM_GRACE, body: "x" });
		};
		const original = graph.messages[FROM_GRACE] as JsonObject;
		// From one of the account's aliases.
		graph.user.proxyAddresses = ["SMTP:me@contoso.com", "smtp:Alias@Contoso.com", "X500:/o=contoso/cn=me"];
		expect(await refusedReply({ from: person("alias@contoso.com") })).toBe("UNSUPPORTED_MESSAGE");
		// Sent by the account on behalf of someone else.
		expect(await refusedReply({ from: person("boss@contoso.com"), sender: person("alias@contoso.com") })).toBe("UNSUPPORTED_MESSAGE");
		// Kept in Sent Items, whoever it names as its sender.
		graph.messages[FROM_GRACE] = original;
		(graph.messages[FROM_GRACE] as JsonObject).parentFolderId = SENT;
		expect(await refusedReply({})).toBe("UNSUPPORTED_MESSAGE");

		// An account that will not name its aliases is still checked against its own addresses.
		graph.messages[FROM_GRACE] = { ...original, from: person("me@contoso.com") };
		graph.hook = (_method, path, params) => (path === "/me" && (params.$select ?? "").includes("proxyAddresses") ? jsonResponse(400, { error: { code: "BadRequest" } }) : null);
		expect(await refusedReply({})).toBe("UNSUPPORTED_MESSAGE");
		expect(graph.writes).toEqual([]);
	});

	test("test_a_reply_confirms_its_message_last_before_writing", async () => {
		const graph = new FakeGraph();
		const run = await start(graph, { ...folder(INBOX), ...recipient("grace@example.com") });
		graph.hook = (_method, path) => {
			// The message moves out of the granted folder while Minerva looks up the account.
			if (path === "/me") (graph.messages[FROM_GRACE] as JsonObject).parentFolderId = SENT;
			return null;
		};
		expect(await run.code("outlook_reply", { message: FROM_GRACE, body: "x" })).toBe("MAIL_MOVED");
		expect(graph.writes).toEqual([]);
	});

	test("a reply goes to several reply-to addresses, each needing a grant, and never to more than ten", async () => {
		const graph = new FakeGraph();
		(graph.messages[FROM_GRACE] as JsonObject).replyTo = [person("a@example.com"), person("B@Example.com"), person("a@example.com")];
		let run = await start(graph, { ...folder(INBOX), ...recipient("*@example.com") });
		const [replied] = await items(run, "outlook_reply", { message: FROM_GRACE, body: "x" });
		expect(replied?.to).toEqual(["a@example.com", "b@example.com"]);
		(graph.messages[FROM_GRACE] as JsonObject).replyTo = Array.from({ length: 11 }, (_, n) => person(`p${n}@example.com`));
		run = await start(graph, { ...folder(INBOX), ...recipient("*") });
		expect(await run.code("outlook_reply", { message: FROM_GRACE, body: "x" })).toBe("UNSUPPORTED_RECIPIENT");
	});
});
