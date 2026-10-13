// The Sentry connector (src/connectors/sentry/) against today's Python one: the vectors in
// test/fixtures/connectors/sentry/ were written by running backend/connectors/sentry/ itself (its
// declaration, its input models with the query hash page tokens bind to, its response models, account,
// discover, describe and every operation's prepare and execute against scripted Sentry responses through
// httpx.MockTransport, and the pure parts of reads.py and client.py on fixed and seeded random inputs). Here
// the same responses are served through an injected fetch and everything the connector sent and returned is
// compared. Where a JavaScript number cannot hold what Python reads, the difference is named in a test.

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { ProviderOutput, Requirement } from "../../src/contracts/connectors.ts";
import { requestAddress } from "../../src/connectors/sentry/address.ts";
import { Issue, Project, type SentryClient, laxInt, linkCursor, nextCursor } from "../../src/connectors/sentry/client.ts";
import { sentryConnector } from "../../src/connectors/sentry/connector.ts";
import { eventRecord, issueDetail, issueRecord, numberOf, short } from "../../src/connectors/sentry/reads.ts";
import { OperationError, binding, offered, termsOf } from "../../src/gateway/connector.ts";
import { CallIo, settingsIo } from "../../src/gateway/http.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";
import { readVectors } from "../fixtures/connectors/read-vectors.ts";
import { kindsOut } from "../../src/workspace/out.ts";
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
	headers: { [name: string]: string };
}

interface RecordedRequest {
	method: string;
	host: string;
	path: string;
	params: [string, string][];
	authorization: string | null;
	accept: string | null;
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
	output?: { records: { resource: PythonResource; data: { [key: string]: Json } }[]; next_cursor: string | null; incomplete: boolean };
	error?: { code: string; message: string };
}

type Fields = { [key: string]: Json };

interface Vectors {
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
			input_schema: Fields;
		}[];
	};
	inputs: { [operation: string]: ({ raw: Json; ok: true; fields: Fields; query_hash: string } | { raw: Json; ok: false; message: string })[] };
	lax: { json: string; int: { ok: boolean; value?: number }; str: { ok: boolean; value?: string }; id: { ok: boolean; value?: string } }[];
	scenarios: { name: string; call: Call; routes: { [path: string]: ScriptedResponse[] }; requests: RecordedRequest[]; outcome: Outcome }[];
	links: ({ link: string; cursor: string | null } | { link: string; error: string })[];
	numbers: ({ value: Json; number: number | null } | { value: Json; raises: true } | { value: Json; beyond: true })[];
	short: { value: Json; short: string | null; short20: string | null }[];
	issues: ({ issue: Fields; record: Fields; detail: Fields } | { issue: Fields; invalid: true })[];
	events: ({ event: Fields; record: Fields } | { event: Fields; raises: true })[];
}

// Read with parseJson (read-vectors.ts): the vectors hold lone surrogate escapes, which Vite's JSON import refuses.
const VECTORS = readVectors(new URL("../fixtures/connectors/sentry/vectors.json", import.meta.url).pathname) as unknown as Vectors;
const CONNECTION = "0199a000-0000-7000-8000-0000000000e1";
const TOKEN = "test-token";
/** Statuses whose response has no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Serves the scripted responses by path, in order for each path, and records each request as the generator does. */
function scripted(routes: { readonly [path: string]: readonly ScriptedResponse[] }) {
	const queues = new Map(Object.entries(routes).map(([path, responses]) => [path, [...responses]]));
	const requests: RecordedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		requests.push({
			method: request.method,
			host: url.hostname,
			path: url.pathname,
			params: [...url.searchParams],
			authorization: request.headers.get("authorization"),
			accept: request.headers.get("accept"),
		});
		const next = queues.get(url.pathname)?.shift();
		if (next === undefined) throw new Error(`No scripted response left for ${url.pathname}.`);
		return new Response(NULL_BODY.has(next.status) ? null : next.body, { status: next.status, headers: { "content-type": "application/json", ...next.headers } });
	};
	return { fetch, requests, left: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0) };
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
async function replay(call: Call, routes: { readonly [path: string]: readonly ScriptedResponse[] }): Promise<{ requests: RecordedRequest[]; outcome: Outcome; left: number }> {
	const script = scripted(routes);
	const io = new CallIo({ fetch: script.fetch, now: () => performance.now(), admits: () => true });
	const connector = sentryConnector();
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
			outcome.output = outputOut(await prepared.execute());
		}
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		outcome.error = { code: error.code, message: error.message };
	} finally {
		io.close();
		await client.close();
	}
	return { requests: script.requests, outcome, left: script.left() };
}

function sorted<T>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
}

describe("the declaration", () => {
	const connector = sentryConnector();
	const python = VECTORS.declaration;

	test("is Python's: kinds, actions, auth with the defaults it relies on, and the manage link", () => {
		expect([connector.slug, connector.name]).toEqual([python.slug, python.name]);
		expect(kindsOut(connector).map(({ browsable: _, ...kind }) => kind)).toEqual(python.kinds);
		expect(connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null }))).toEqual(python.actions);
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Sentry connects through OAuth.");
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
			// Fields in Python's order, as the model reads them.
			expect(Object.keys(inputSchema(op).properties as object)).toEqual(Object.keys(expected?.input_schema.properties as object));
		}
	});
});

describe("inputs as Python normalizes them", () => {
	const connector = sentryConnector();
	for (const op of connector.operations) {
		const cases = VECTORS.inputs[op.name] ?? [];
		test(`${op.name}: ${cases.length} cases, with the query hash computed from them`, async () => {
			expect(cases.length).toBeGreaterThan(0);
			for (const expected of cases) {
				if (changedOnPurpose(expected.raw)) continue;
				const validated = await validateInput(op.input as z.ZodType, expected.raw === null ? undefined : expected.raw);
				if (!expected.ok) {
					expect(validated, JSON.stringify(expected.raw)).toMatchObject({ ok: false });
					continue;
				}
				expect(validated, JSON.stringify(expected.raw)).toEqual({ ok: true, data: expected.fields });
				if (validated.ok) expect(await queryHash(validated.data)).toBe(await queryHash(expected.fields));
			}
		});
	}
});

describe("responses as Python's models read them", () => {
	test.each(VECTORS.lax.filter((expected) => !changedOnPurpose(parseJson(expected.json))))("$json", (expected) => {
		const value = parseJson(expected.json);
		const read = <T>(schema: z.ZodType<T>, data: Json, pick: (parsed: T) => Json) => {
			const result = schema.safeParse(data);
			return result.success ? { ok: true, value: pick(result.data) } : { ok: false };
		};
		const base = { id: "101", project: { id: "11" } };
		// Python keeps an int beyond 2^53 exactly; it is refused here, never rounded.
		const beyond = typeof expected.int.value === "number" && !Number.isSafeInteger(expected.int.value);
		expect(read(Issue, { ...base, userCount: value }, (issue) => issue.userCount)).toEqual(beyond ? { ok: false } : expected.int);
		expect(read(Issue, { ...base, title: value }, (issue) => issue.title)).toEqual(expected.str);
		expect(read(Project, { id: value, slug: "web" }, (project) => project.id)).toEqual(expected.id);
	});

	test("where a JavaScript number cannot hold what Python reads", () => {
		expect(VECTORS.lax.find((item) => item.json === '"9007199254740993"')?.int).toEqual({ ok: true, value: 9007199254740993 });
		expect(laxInt("9007199254740993")).toBeNull();
		expect(laxInt(parseJson("9007199254740992"))).toBeNull();
		expect(laxInt(parseJson("12.0"))).toBe(12);
	});
});

describe("against scripted Sentry responses, as Python's connector", () => {
	test.each(VECTORS.scenarios.filter((scenario) => !changedOnPurpose(scenario)).map((scenario) => [scenario.name, scenario] as const))("%s", async (_, scenario) => {
		const { requests, outcome, left } = await replay(scenario.call, scenario.routes);
		if (scenario.call.kind === "describe") {
			// Requests run concurrently: compare what was sent, and the names, in any order.
			expect(sorted(requests)).toEqual(sorted(scenario.requests));
			expect({ ...outcome, names: outcome.names && sorted(outcome.names) }).toEqual({
				...scenario.outcome,
				names: scenario.outcome.names && sorted(scenario.outcome.names),
			});
			return;
		}
		expect(requests).toEqual(scenario.requests);
		expect(outcome).toEqual(scenario.outcome);
		expect(left, "every scripted response is used").toBe(0);
	});
});

describe("the client's pure parts", () => {
	test.each(VECTORS.links.filter((vector) => !changedOnPurpose(vector.link)).map((vector) => [JSON.stringify(vector.link), vector] as const))("Link %s", (_, vector) => {
		const read = () => {
			try {
				return { link: vector.link, cursor: linkCursor(vector.link) };
			} catch (error) {
				if (!(error instanceof OperationError)) throw error;
				return { link: vector.link, error: error.code };
			}
		};
		expect(read()).toEqual(vector);
	});

	test("the Link header is read from the response", () => {
		const header = '<https://elsewhere.example.com/x>; rel="next"; results="true"; cursor="1727:100:0"';
		expect(nextCursor(new Response(null, { headers: { link: header } }))).toBe("1727:100:0");
		expect(nextCursor(new Response(null))).toBeNull();
	});
});

describe("reads.py's pure parts", () => {
	test("a request's address keeps no credentials, query or fragment", () => {
		expect(requestAddress("https://user:secret@Shop.Example.com:8443/cart/../pay?token=t#x")).toBe("https://shop.example.com:8443/pay");
		expect(requestAddress("http://[::1]:80/a b")).toBe("http://[::1]/a%20b");
		for (const value of ["ftp://example.com/", "/relative", "https://exa mple.com/", "https://example.com:99999/", 42, null]) {
			expect(requestAddress(value), JSON.stringify(value)).toBeNull();
		}
	});

	test("_number", () => {
		for (const vector of VECTORS.numbers) {
			// Only ASCII digits are read; an int beyond 2^53 is null.
			if (changedOnPurpose(vector.value)) {
				expect(numberOf(vector.value), JSON.stringify(vector)).toBeNull();
				continue;
			}
			const expected = "number" in vector ? vector.number : null;
			expect(numberOf(vector.value), JSON.stringify(vector)).toBe(expected);
		}
	});

	test("short", () => {
		for (const vector of VECTORS.short) {
			if (changedOnPurpose(vector.value)) continue;
			expect([short(vector.value), short(vector.value, 20)], JSON.stringify(vector.value)).toEqual([vector.short, vector.short20]);
		}
	});

	test("_issue and _issue_detail, key order included", () => {
		for (const vector of VECTORS.issues) {
			if (changedOnPurpose(vector.issue)) continue;
			const parsed = Issue.safeParse(vector.issue);
			if ("invalid" in vector) {
				expect(parsed.success, JSON.stringify(vector.issue)).toBe(false);
				continue;
			}
			if (!parsed.success) throw parsed.error;
			expect(JSON.stringify(issueRecord(parsed.data))).toBe(JSON.stringify(vector.record));
			expect(JSON.stringify(issueDetail(parsed.data))).toBe(JSON.stringify(vector.detail));
		}
	});

	test(`_event on ${VECTORS.events.length} fixed and random events, key order included`, () => {
		expect(VECTORS.events.some((vector) => "raises" in vector)).toBe(false);
		for (const vector of VECTORS.events) {
			if ("raises" in vector) continue;
			expect(JSON.stringify(eventRecord(vector.event)), JSON.stringify(vector.event).slice(0, 200)).toBe(JSON.stringify(vector.record));
		}
	});
});

describe("the settings page", () => {
	test("the kind as the page shows it", () => {
		expect(kindsOut(sentryConnector())).toEqual([
			{
				id: "project",
				label: "Project",
				actions: ["read"],
				wildcard: true,
				hierarchical: false,
				note: "Agents read issues and events: stack traces, the source lines around them, and tags.",
				listed: true,
				browsable: false,
			},
		]);
	});

	test("discovery's cursor is the provider's, checked before it is sent", async () => {
		const script = scripted({});
		const connector = sentryConnector();
		const client: SentryClient = connector.client(TOKEN, settingsIo(script.fetch));
		await expect(connector.discover(client, "project", { query: null, cursor: "../x" })).rejects.toThrow("This page token is invalid.");
		expect(script.requests).toEqual([]);
	});
});
