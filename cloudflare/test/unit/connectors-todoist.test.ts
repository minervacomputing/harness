// The Todoist connector (src/connectors/todoist/) against today's Python one: the vectors in
// test/fixtures/connectors/todoist/ were written by running backend/connectors/todoist/ itself (its
// declaration, its input models with the executor's hashes, its response models, and account, discover,
// describe and every operation's prepare and execute against scripted Todoist responses through
// httpx.MockTransport). Here the same responses are served through an injected fetch and everything the
// connector sent and returned is compared. Also: the registry accepts it, with its fingerprints pinned;
// the settings page's parts of test_api.py; and the OAuth requests its declaration makes.

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { Connector, ProviderOutput, Requirement } from "../../src/contracts/connectors.ts";
import type { GrantRow } from "../../src/contracts/policy.ts";
import { CONNECTORS } from "../../src/connectors/index.ts";
import { type TodoistClient, TodoistTask } from "../../src/connectors/todoist/client.ts";
import { todoistConnector } from "../../src/connectors/todoist/connector.ts";
import { OperationError, binding, offered, termsOf } from "../../src/gateway/connector.ts";
import { CallIo, settingsIo } from "../../src/gateway/http.ts";
import { writeKey } from "../../src/gateway/ledger.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { Registry, inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import { allowedOut, consentNeeded, kindsOut, requestedScopes } from "../../src/workspace/out.ts";
import rawVectors from "../fixtures/connectors/todoist/vectors.json" with { type: "json" };
import { FakeTodoist, TODOIST } from "./executor-fakes.ts";
import { changedOnPurpose } from "./changed.ts";

interface PythonResource {
	connection_id: string;
	kind: string;
	id: string;
	within: string[];
	partial: boolean;
}

type PythonRequirement = { need: PythonResource; action: string } | { enumerate: string; action: string };

interface ScriptedResponse {
	status: number;
	body: string;
	type: string;
	location?: string;
}

interface RecordedRequest {
	method: string;
	url: string;
	path: string;
	params: [string, string][];
	authorization: string | null;
	content_type: string | null;
	body: string | null;
}

type Call =
	| { kind: "account" }
	| { kind: "discover"; query: string | null; cursor: string | null }
	| { kind: "describe"; ids: string[] }
	| { kind: "op"; op: string; args: Json };

interface Outcome {
	account?: { id: string; label: string };
	page?: { items: [string, string, boolean][]; next_cursor: string | null };
	names?: [string, string][];
	requirements?: PythonRequirement[];
	requests_before_execute?: number;
	effect?: string | null;
	output?: { records: { resource: PythonResource; data: { [key: string]: Json } }[]; next_cursor: string | null; incomplete: boolean };
	error?: { code: string; message: string };
}

interface Vectors {
	python: string;
	unicode: string;
	declaration: {
		slug: string;
		name: string;
		kinds: { id: string; label: string; actions: string[]; wildcard: boolean; hierarchical: boolean; note: string | null; listed: boolean }[];
		actions: { id: string; label: string; requires: string | null }[];
		auth: { [key: string]: Json };
		browsable: string[];
		manage_link: [string, string] | null;
		operations: {
			name: string;
			title: string;
			description: string;
			needs: [string, string][];
			output_action: string;
			consent: string[][] | null;
			revision: number;
			mutates: boolean;
			paginated: boolean;
			offered: boolean;
			input_schema: { [key: string]: Json };
		}[];
	};
	inputs: {
		[operation: string]: ({ raw: Json; ok: true; fields: { [key: string]: Json }; query_hash: string; write_key: string | null } | { raw: Json; ok: false; message: string })[];
	};
	scenarios: { name: string; call: Call; responses: ScriptedResponse[]; requests: RecordedRequest[]; outcome: Outcome }[];
}

const VECTORS = rawVectors as unknown as Vectors;
const CONNECTION = TODOIST;
const TOKEN = "test-token";
/** Statuses whose response has no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Serves the scripted responses in order and records each request as the generator does. */
function scripted(responses: readonly ScriptedResponse[]) {
	const queue = [...responses];
	const requests: RecordedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		requests.push({
			method: request.method,
			url: `${url.origin}${url.pathname}`,
			path: url.pathname,
			params: [...url.searchParams],
			authorization: request.headers.get("authorization"),
			content_type: request.headers.get("content-type"),
			body: text === "" ? null : text,
		});
		const next = queue.shift();
		if (next === undefined) throw new Error("No scripted response left.");
		const headers: { [name: string]: string } = { "content-type": next.type };
		if (next.location !== undefined) headers.location = next.location;
		return new Response(NULL_BODY.has(next.status) ? null : next.body, { status: next.status, headers });
	};
	return { fetch, requests, left: () => queue.length };
}

function resourceOut(resource: { connectionId: string; kind: string; id: string; within: string[]; partial: boolean }): PythonResource {
	return { connection_id: resource.connectionId, kind: resource.kind, id: resource.id, within: resource.within, partial: resource.partial };
}

function requirementOut(requirement: Requirement): PythonRequirement {
	return "need" in requirement ? { need: resourceOut(requirement.need), action: requirement.action } : { enumerate: requirement.enumerate, action: requirement.action };
}

function outputOut(output: ProviderOutput): NonNullable<Outcome["output"]> {
	return {
		records: output.records.map((record) => ({ resource: resourceOut(record.resource), data: record.data })),
		next_cursor: output.nextCursor ?? null,
		incomplete: output.incomplete ?? false,
	};
}

/** What the generator's `scenario` does, here. */
async function replay(call: Call, responses: readonly ScriptedResponse[]): Promise<{ requests: RecordedRequest[]; outcome: Outcome }> {
	const script = scripted(responses);
	const io = new CallIo({ fetch: script.fetch, now: () => performance.now(), admits: () => true });
	const connector = todoistConnector();
	const client = connector.client(TOKEN, io);
	const outcome: Outcome = {};
	try {
		if (call.kind === "account") {
			outcome.account = await connector.account(client);
		} else if (call.kind === "discover") {
			const page = await connector.discover(client, "project", { query: call.query, cursor: call.cursor });
			outcome.page = { items: page.items.map((item) => [item.id, item.name, item.expandable ?? false]), next_cursor: page.nextCursor ?? null };
		} else if (call.kind === "describe") {
			outcome.names = Object.entries(await connector.describe(client, "project", call.ids));
		} else {
			const op = connector.operations.find((item) => item.name === call.op);
			if (op === undefined) throw new Error(`No operation ${call.op}`);
			const validated = await validateInput(op.input as z.ZodType, call.args);
			if (!validated.ok) throw new Error(validated.message);
			const prepared = await op.prepare(binding(CONNECTION, client), validated.data as never);
			outcome.requirements = prepared.requirements.map(requirementOut);
			outcome.requests_before_execute = script.requests.length;
			let output: ProviderOutput;
			if (termsOf(op).mutates) {
				const attempt = io.openWrite(io.now() + 60_000);
				try {
					output = await prepared.execute();
				} finally {
					outcome.effect = attempt.sent ? attempt.effect : "not_sent";
					attempt.close();
				}
			} else {
				output = await prepared.execute();
			}
			outcome.output = outputOut(output);
		}
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		outcome.error = { code: error.code, message: error.message };
	} finally {
		io.close();
		await client.close();
	}
	expect(script.left(), "every scripted response is used").toBe(0);
	return { requests: script.requests, outcome };
}

describe("the declaration", () => {
	const connector = todoistConnector();
	const python = VECTORS.declaration;

	test("is Python's: kinds, actions, auth and the defaults it relies on", () => {
		expect([connector.slug, connector.name]).toEqual([python.slug, python.name]);
		expect(kindsOut(connector).map(({ browsable: _, ...kind }) => kind)).toEqual(python.kinds);
		expect(connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null }))).toEqual(python.actions);
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Todoist connects through OAuth.");
		expect({
			type: auth.type,
			app: auth.app,
			authorize_url: auth.authorizeUrl,
			token_url: auth.tokenUrl,
			scopes: auth.scopes,
			scope_separator: auth.scopeSeparator ?? " ",
			registration_url: auth.registrationUrl ?? null,
			authorize_params: auth.authorizeParams ?? [],
			login_hint: auth.loginHint ?? false,
			client_auth: auth.clientAuth ?? "post",
			json_body: auth.jsonBody ?? false,
			pkce: auth.pkce ?? true,
		}).toEqual(python.auth);
		expect(connector.browsable ?? []).toEqual(python.browsable);
		expect(connector.manageLink ? connector.manageLink() : null).toEqual(python.manage_link);
		expect(connector.children).toBeUndefined();
	});

	test("its operations are Python's, strings verbatim, and their input schemas are Pydantic's", () => {
		expect(connector.operations.map((op) => op.name)).toEqual(python.operations.map((op) => op.name));
		for (const [index, op] of connector.operations.entries()) {
			const expected = python.operations[index];
			const terms = termsOf(op);
			expect({
				name: op.name,
				title: op.title,
				description: op.description,
				needs: op.needs,
				output_action: terms.outputAction,
				consent: terms.consent,
				revision: terms.revision,
				mutates: terms.mutates,
				paginated: terms.paginated,
				offered: offered(connector, op),
				// Every key and value, field titles included; only the order of keys differs.
				input_schema: inputSchema(op),
			}).toEqual(expected);
		}
	});

	test("the registry accepts it, and its fingerprints are pinned", async () => {
		const registry = await Registry.create([todoistConnector()]);
		const fingerprints = Object.fromEntries(connector.operations.map((op) => [op.name, registry.contract("todoist", op.name)]));
		console.log("todoist fingerprints", fingerprints);
		// A change here changes what running runs' tools mean (OPERATION_CHANGED): bump `revision` when the
		// meaning changed in a way the declaration does not show.
		expect(fingerprints).toEqual({
			list_projects: "71d6b1de44dd465c",
			list_tasks: "518c4a805776bc00",
			get_task: "d3206a8a6cd9f796",
			create_task: "8a8b87188ca92917",
		});
	});

	test("it is registered, and the registered connectors validate together", async () => {
		const registry = await Registry.create(CONNECTORS);
		expect(registry.find("todoist")?.name).toBe("Todoist");
	});
});

describe("inputs as Python normalizes them", () => {
	const connector = todoistConnector();
	for (const op of connector.operations) {
		const cases = VECTORS.inputs[op.name] ?? [];
		test(`${op.name}: ${cases.length} cases, with the query hash and write key computed from them`, async () => {
			expect(cases.length).toBeGreaterThan(0);
			for (const expected of cases) {
				if (changedOnPurpose(expected.raw)) continue;
				const validated = await validateInput(op.input as z.ZodType, expected.raw === null ? undefined : expected.raw);
				if (!expected.ok) {
					expect(validated, JSON.stringify(expected.raw)).toMatchObject({ ok: false });
					continue;
				}
				expect(validated, JSON.stringify(expected.raw)).toEqual({ ok: true, data: expected.fields });
				if (!validated.ok) continue;
				// Hashed over the normalized arguments, so a page token and a write key are those of Python's arguments.
				expect(await queryHash(validated.data)).toBe(await queryHash(expected.fields));
				if (termsOf(op).mutates) expect(await writeKey(`todoist_${op.name}`, validated.data)).toBe(await writeKey(`todoist_${op.name}`, expected.fields));
			}
		});
	}
});

describe("Todoist's answers", () => {
	test("fields of another type do not fit", () => {
		const task = { id: "t1", project_id: "work", content: "x" };
		expect(TodoistTask.parse(task)).toEqual({ ...task, description: "", priority: 1, due: null, checked: false });
		for (const odd of [{ priority: "4" }, { priority: 1.5 }, { checked: 1 }, { checked: "true" }, { id: 1 }]) {
			expect(TodoistTask.safeParse({ ...task, ...odd }).success, JSON.stringify(odd)).toBe(false);
		}
	});

	test("the account id is Todoist's string", async () => {
		const connector = todoistConnector();
		const refused = scripted([{ status: 200, body: '{"id": 12, "full_name": "Ada"}', type: "application/json" }]);
		await expect(connector.account(connector.client(TOKEN, settingsIo(refused.fetch)))).rejects.toThrow("Todoist returned an unexpected response.");
		const found = scripted([{ status: 200, body: '{"id": "u1", "full_name": "Ada"}', type: "application/json" }]);
		expect(await connector.account(connector.client(TOKEN, settingsIo(found.fetch)))).toEqual({ id: "u1", label: "Ada" });
	});
});

// Names are matched with toLowerCase rather than casefold, a query is trimmed of JavaScript's whitespace,
// and numbers or words sent for strings, ints and booleans do not fit (Todoist's answers, above).
const CHANGED_SCENARIOS = new Set([
	"discover by a casefolded name",
	"discover by sharp s",
	"discover by final sigma",
	"discover by a ligature",
	"search tasks with Python whitespace",
	"account with a numeric id",
	"account with a fractional id",
	"list tasks with lax numbers and booleans",
]);

describe("against scripted Todoist responses, as Python's connector", () => {
	test.each(VECTORS.scenarios.filter((scenario) => !CHANGED_SCENARIOS.has(scenario.name)).map((scenario) => [scenario.name, scenario] as const))("%s", async (_, scenario) => {
		const { requests, outcome } = await replay(scenario.call, scenario.responses);
		// httpx and URLSearchParams escape a few characters differently ("~" and "*"); the decoded
		// parameters, the path and the host are compared.
		expect(requests).toEqual(scenario.requests.map((request) => ({ ...request, url: request.url.split("?")[0] })));
		expect(outcome).toEqual(scenario.outcome);
	});

	test("a project named after an Object.prototype property is described as a name", async () => {
		const script = scripted([{ status: 200, body: '{"results": [{"id": "__proto__", "name": "Proto"}]}', type: "application/json" }]);
		const connector = todoistConnector();
		const names = await connector.describe(connector.client(TOKEN, settingsIo(script.fetch)), "project", ["__proto__"]);
		expect(Object.getPrototypeOf(names)).toBe(Object.prototype);
		expect(Object.hasOwn(names, "__proto__")).toBe(true);
		expect(names.__proto__).toBe("Proto");
	});

	test("prepare sends no write, and a write outside execute is refused", async () => {
		// The one write is sent from execute(), inside the executor's write attempt; without one, ProviderHTTP
		// refuses it as a connector bug and nothing reaches Todoist.
		const script = scripted([]);
		const connector = todoistConnector();
		const client = connector.client(TOKEN, settingsIo(script.fetch)) as TodoistClient;
		await expect(client.createTask("work", "x")).rejects.toThrow("Provider writes are only allowed in the execute step of a mutating operation.");
		const op = connector.operations.find((item) => item.name === "create_task");
		const prepared = await op?.prepare(binding(CONNECTION, client), { project_id: "work", title: "x" } as never);
		expect(prepared?.requirements.length).toBe(1);
		expect(script.requests).toEqual([]);
	});
});

describe("the settings page (test_api.py)", () => {
	test("access settings: the kind as the page shows it, discovery, and names of seen projects only", async () => {
		const connector = todoistConnector();
		expect(kindsOut(connector)).toEqual([
			{ id: "project", label: "Project", actions: ["read", "create"], wildcard: true, hierarchical: false, note: null, listed: true, browsable: false },
		]);
		const todoist = new FakeTodoist();
		const client = connector.client(TOKEN, settingsIo(todoist.fetch));
		expect(todoist.calls).toEqual([]);
		const page = await connector.discover(client, "project", { query: null, cursor: null });
		expect(page.items[0]).toEqual({ id: "work", name: "Work" });
		expect(page.items[0]?.expandable ?? false).toBe(false);
		// Projects do not nest, so there is nothing to browse into.
		expect(connector.browsable ?? []).toEqual([]);
		// A grant on a project the account cannot see is refused: describe leaves it out.
		expect(await connector.describe(client, "project", ["work", "elsewhere"])).toEqual({ work: "Work" });
	});

	test("connections summarize what the user allows", () => {
		const row = (resourceId: string, resourceName: string, actions: string[]): GrantRow => ({
			layer: "user",
			subject: "user",
			connectionId: CONNECTION,
			kind: "project",
			resourceId,
			resourceName,
			actions,
			effect: "allow",
		});
		expect(allowedOut(todoistConnector(), [row("*", "", ["read"]), row("work", "Work", ["create", "read"])])).toEqual([
			{ kind: "project", kind_label: "Project", action: "read", action_label: "Read tasks", all: true, count: 1, names: ["Work"] },
			{ kind: "project", kind_label: "Project", action: "create", action_label: "Create tasks", all: false, count: 1, names: ["Work"] },
		]);
	});
});

describe("OAuth with the declaration's endpoints", () => {
	const connector: Connector = todoistConnector();
	const auth = connector.auth as Extract<Connector["auth"], { type: "oauth2" }>;

	test("its one scope is requested whatever is allowed, and no consent is ever missing", () => {
		expect(requestedScopes(connector, new Set(["read", "create"]))).toEqual(["data:read_write"]);
		expect(consentNeeded(connector, [], new Set(["read", "create"]))).toEqual([]);
		// What the registration request asks for (oauth.py `_register_client`): the scopes joined by the separator.
		expect(auth.scopes.join(auth.scopeSeparator ?? " ")).toBe("data:read_write");
	});

	test("token requests are forms with the client first in the body", async () => {
		const init = tokenRequest(auth, { clientId: "id", clientSecret: "secret", redirectUri: "https://minerva.example/api/oauth/todoist/callback" }, [
			["grant_type", "authorization_code"],
			["code", "c"],
		]);
		expect(init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
		expect(init.body).toBe("client_id=id&client_secret=secret&grant_type=authorization_code&code=c");
		expect(init.redirect).toBe("manual");
	});

	test("Todoist's token answers: no scopes, and the legacy ten-year expiry is no expiry", () => {
		const now = Date.UTC(2026, 9, 11);
		expect(tokenPayload({ access_token: "a", token_type: "Bearer" }, now)).toEqual({ kind: "oauth2", access_token: "a", refresh_token: null, scopes: null });
		expect(tokenPayload({ access_token: "a", token_type: "Bearer", expires_in: 315_360_000 }, now)).toEqual({
			kind: "oauth2",
			access_token: "a",
			refresh_token: null,
			scopes: null,
		});
		expect(tokenPayload({ access_token: "a", expires_in: 3600, scope: "data:read_write" }, now)).toEqual({
			kind: "oauth2",
			access_token: "a",
			refresh_token: null,
			scopes: ["data:read_write"],
			expires_at: now / 1000 + 3600,
		});
	});
});
