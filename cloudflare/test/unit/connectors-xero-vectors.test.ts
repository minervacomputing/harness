// The Xero connector against what today's Python answers, from test/fixtures/connectors/xero/vectors.json
// (written by generate.py there): the declaration with its descriptions and input schemas, input validation
// with the hashes the executor keys on, the client's helpers, exact amounts, the dates calls take, and
// scenarios: account, discovery and every operation run against scripted Xero responses, compared request by
// request and answer by answer.

import { describe, expect, test } from "vitest";
import type { Operation, ProviderOutput } from "../../src/contracts/connectors.ts";
import type { Resource } from "../../src/contracts/policy.ts";
import { casefold } from "../../src/lib/casefold.ts";
import { Message, Pagination, XeroClient, classify, date, invoiceDate, judge, messages, moment, nextPage, page } from "../../src/connectors/xero/client.ts";
import { xeroConnector } from "../../src/connectors/xero/connector.ts";
import { dayProblem, fromIsoFormat } from "../../src/connectors/xero/dates.ts";
import { fromNumber, money, number } from "../../src/connectors/xero/decimal.ts";
import { short } from "../../src/connectors/xero/organisations.ts";
import { invoiceParams, where } from "../../src/connectors/xero/reads.ts";
import { type DraftBill, type DraftInvoice, jsonBody } from "../../src/connectors/xero/writes.ts";
import { OperationError, binding, termsOf } from "../../src/gateway/connector.ts";
import { CallIo } from "../../src/gateway/http.ts";
import { writeKey } from "../../src/gateway/ledger.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { fromHex } from "../../src/lib/bytes.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { readVectors } from "../fixtures/connectors/read-vectors.ts";
import { changedOnPurpose } from "./changed.ts";

const CONNECTION = "0199a000-0000-7000-8000-0000000000e1";
const TOKEN = "test-token";

interface Failure {
	code: string;
	message: string;
}

interface InputVector {
	op: string;
	raw: Json;
	message?: string;
	dump?: JsonObject;
	where?: string | null;
	params?: [string, string][];
	body?: string;
}

interface ServedRequest {
	method: string;
	url: string;
	params: [string, string][];
	authorization: string | null;
	accept: string | null;
	tenant: string | null;
	content_type: string | null;
	body: string | null;
}

interface Scenario {
	name: string;
	call: { kind: "account" } | { kind: "discover"; query: string | null; cursor: string | null } | { kind: "describe"; ids: string[] } | { kind: "op"; op: string; args: Json };
	responses: ({ status: number; text: string } | { status: number; hex: string })[];
	requests: ServedRequest[];
	outcome: JsonObject;
}

interface Vectors {
	python: string;
	unicode: string;
	declaration: JsonObject & { operations: JsonObject[] };
	schemas: [string, JsonObject][];
	inputs: InputVector[];
	amounts: { text: string; money: string; number: string }[];
	dates: {
		moments: [string, string | null][];
		dates: [string, string | null][];
		invoice_dates: [string | null, string | null, string | null][];
		days: ({ value: string; date: [number, number, number] } | { value: string; error: string })[];
	};
	pages: { page: [string | null, number | Failure][]; next: [number | null | "empty", number, number, number, string | null][] };
	classify: { status: number; body: string; named: [string, string] | null }[];
	judge: { status: number; body: string; effect: string | null }[];
	texts: { short: [string | null, string | null][]; short_300: [string | null, string | null][]; messages: [(string | null)[], string[]][] };
	scenarios: Scenario[];
	casefold: string;
}

const vectors = readVectors(new URL("../fixtures/connectors/xero/vectors.json", import.meta.url).pathname) as unknown as Vectors;
const connector = xeroConnector();

function op(name: string): Operation<never> {
	const found = connector.operations.find((item) => item.name === name);
	if (found === undefined) throw new Error(`No operation ${name}`);
	return found;
}

describe("the declaration is today's", () => {
	const python = vectors.declaration;

	test("kinds, actions and auth", () => {
		expect([connector.slug, connector.name]).toEqual([python.slug, python.name]);
		expect(
			connector.kinds.map((kind) => ({
				id: kind.id,
				label: kind.label,
				actions: kind.actions,
				wildcard: kind.wildcard ?? false,
				hierarchical: kind.hierarchical ?? false,
				note: kind.note ?? null,
				listed: kind.listed ?? true,
			})),
		).toEqual(python.kinds);
		expect(connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null }))).toEqual(python.actions);
		expect(connector.auth).toEqual(python.auth);
		expect(connector.browsable ?? []).toEqual(python.browsable);
		expect(connector.manageLink?.() ?? null).toEqual(python.manage_link);
		expect(connector.offered).toBeUndefined();
	});

	test.each(python.operations.map((item) => [item.name as string, item] as const))("%s", (name, item) => {
		const declared = op(name);
		const terms = termsOf(declared);
		expect({
			name: declared.name,
			title: declared.title,
			description: declared.description,
			needs: declared.needs,
			output_action: terms.outputAction,
			consent: terms.consent,
			revision: terms.revision,
			mutates: terms.mutates,
			paginated: terms.paginated,
		}).toEqual(item);
	});

	test("in today's order", () => {
		expect(connector.operations.map((item) => item.name)).toEqual(python.operations.map((item) => item.name));
	});

	test("each input's JSON Schema is Pydantic's, nested models in place and without the fields' titles", () => {
		expect(vectors.schemas.map(([name]) => name)).toEqual(connector.operations.map((item) => item.name));
		for (const [name, schema] of vectors.schemas) {
			const ours = inputSchema(op(name));
			expect(ours).toEqual(schema);
			// Field order too: the model reads the schema as text.
			expect(Object.keys(ours.properties as object)).toEqual(Object.keys(schema.properties as object));
		}
	});
});

describe("inputs validate as Pydantic validates them", () => {
	test("the vectors cover every operation", () => {
		expect(new Set(vectors.inputs.map((vector) => vector.op))).toEqual(new Set(connector.operations.map((item) => item.name)));
	});

	test.each(vectors.inputs.flatMap((vector, index) => (changedOnPurpose(vector.raw) ? [] : [[`${index} ${vector.op} ${JSON.stringify(vector.raw).slice(0, 90)}`, vector] as const])))("%s", async (_, vector) => {
		const operation = op(vector.op);
		const result = await validateInput(operation.input as never, vector.raw);
		if (vector.message !== undefined) {
			expect(result).toMatchObject({ ok: false });
			return;
		}
		expect(result).toEqual({ ok: true, data: vector.dump });
		if (!result.ok) return;
		// The executor's keys: a page token is valid only for this query, a write is deduplicated by this key.
		expect(await queryHash(result.data)).toBe(await queryHash(vector.dump as JsonObject));
		if (termsOf(operation).mutates) expect(await writeKey(`xero_${vector.op}`, result.data)).toBe(await writeKey(`xero_${vector.op}`, vector.dump as JsonObject));
		if (vector.op === "search_invoices") {
			const data = result.data as unknown as Parameters<typeof invoiceParams>[0];
			expect(where(data)).toBe(vector.where);
			expect(Object.entries(invoiceParams(data, 1)).map(([key, value]) => [key, String(value)])).toEqual(vector.params);
		}
		if (vector.body !== undefined) {
			const kind = vector.op === "create_draft_invoice" ? "sales" : "bill";
			const text = jsonBody(result.data as unknown as DraftInvoice | DraftBill, kind);
			// Python sends float(…), so 1 is written 1.0 there; the values are the same numbers.
			expect(parseJson(text)).toEqual(parseJson(vector.body));
			// Here each amount is written as its decimal, never through a float.
			const lines = (result.data.lines as JsonObject[]).map((line) => [line.quantity, line.unit_amount, line.discount_rate ?? null]);
			for (const [quantity, unit, discount] of lines) {
				expect(text).toContain(`"Quantity":${quantity as string},"UnitAmount":${unit as string}`);
				if (discount !== null) expect(text).toContain(`"DiscountRate":${discount as string}`);
			}
		}
	});
});

describe("amounts are exact", () => {
	test.each(vectors.amounts.map((vector) => [vector.text, vector] as const))("%s", (text, vector) => {
		const value = fromNumber(parseJson(text) as number);
		if (text === "-0") {
			// Deviation: Python reads the integer -0 as 0, and the float -0.0 as Decimal('-0'); parsed here,
			// both are the same number, read as the float.
			expect([money(value), number(value)]).toEqual(["-0.00", "0"]);
			return;
		}
		expect([money(value), number(value)]).toEqual([vector.money, vector.number]);
	});

	test("an integer JSON parsing may have rounded is refused, as are what JSON numbers cannot be", () => {
		for (const value of [2 ** 53, -(2 ** 53), 1e16, 1e300, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN]) expect(fromNumber(value)).toBeNull();
		expect(number(fromNumber(2 ** 53 - 1))).toBe("9007199254740991");
		expect([money(fromNumber(4503599627370495.5)), number(fromNumber(4503599627370495.5))]).toEqual(["4503599627370495.50", "4503599627370495.5"]);
	});
});

describe("dates are read as today", () => {
	test("Xero's dates", () => {
		for (const [value, expected] of vectors.dates.moments) expect([value, moment(value)]).toEqual([value, expected]);
		for (const [value, expected] of vectors.dates.dates) expect([value, date(value)]).toEqual([value, expected]);
		for (const [text, raw, expected] of vectors.dates.invoice_dates) expect([text, raw, invoiceDate(text, raw)]).toEqual([text, raw, expected]);
	});

	test.each(vectors.dates.days.map((vector) => [vector.value, vector] as const))("the date %j", (value, vector) => {
		if ("error" in vector) expect(dayProblem(value)).toBe(vector.error);
		else {
			expect(dayProblem(value)).toBeNull();
			expect(fromIsoFormat(value)).toEqual(vector.date);
		}
	});
});

describe("pages are today's", () => {
	test("a cursor names a page", () => {
		for (const [cursor, expected] of vectors.pages.page) {
			if (typeof expected === "number") expect(page(cursor)).toBe(expected);
			else {
				const error = (() => {
					try {
						page(cursor);
					} catch (caught) {
						return caught;
					}
					return null;
				})();
				expect(error).toBeInstanceOf(OperationError);
				expect([(error as OperationError).code, (error as OperationError).message]).toEqual([expected.code, expected.message]);
			}
		}
	});

	test("the next page", () => {
		for (const [known, current, count, size, expected] of vectors.pages.next) {
			const pagination: Pagination | null = known === null ? null : Pagination.parse(known === "empty" ? {} : { pageCount: known });
			expect([known, current, count, size, nextPage(pagination, current, count, size)]).toEqual([known, current, count, size, expected]);
		}
	});
});

describe("Xero's errors are named as today", () => {
	test.each(vectors.classify.map((vector, index) => [`${index} ${vector.status} ${vector.body.slice(0, 60)}`, vector] as const))("%s", (_, vector) => {
		const named = classify("Xero", new Response(vector.body, { status: vector.status }), vector.body, new TextEncoder().encode(vector.body));
		expect(named === null ? null : [named.code, named.message]).toEqual(vector.named);
	});

	test.each(vectors.judge.map((vector, index) => [`${index} ${vector.status} ${vector.body.slice(0, 80)}`, vector] as const))("judge %s", (_, vector) => {
		const response = () => new Response(vector.body, { status: vector.status });
		if (vector.effect === "raises") expect(() => judge(response(), vector.body)).toThrow(TypeError);
		else expect(judge(response(), vector.body)).toBe(vector.effect);
	});
});

describe("texts are shown as today", () => {
	test("short", () => {
		for (const [value, expected] of vectors.texts.short) expect([value, short(value)]).toEqual([value, expected]);
		for (const [value, expected] of vectors.texts.short_300) expect([value, short(value, 300)]).toEqual([value, expected]);
	});

	test("Xero's messages", () => {
		for (const [found, expected] of vectors.texts.messages) expect(messages(found.map((text) => Message.parse({ Message: text })))).toEqual(expected);
	});

	test("casefold is Python's for every code point it changes, and only for those", () => {
		const changed = new Map<number, string>();
		for (const entry of vectors.casefold.split(" ")) {
			const [point, folded] = entry.split(":") as [string, string];
			changed.set(Number.parseInt(point, 16), String.fromCodePoint(...folded.split(".").map((hex) => Number.parseInt(hex, 16))));
		}
		for (let point = 0; point < 0x110000; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const char = String.fromCodePoint(point);
			const expected = changed.get(point) ?? char;
			if (casefold(char) !== expected) expect([point.toString(16), casefold(char)]).toEqual([point.toString(16), expected]);
		}
		expect(casefold("Straße ΣΑΣ \ud800")).toBe("strasse σασ \ud800");
	});
});

function resourceOf(resource: Resource): JsonObject {
	return { connection_id: resource.connectionId, kind: resource.kind, id: resource.id, within: resource.within, partial: resource.partial };
}

async function replay(scenario: Scenario): Promise<{ requests: ServedRequest[]; outcome: JsonObject }> {
	const responses = [...scenario.responses];
	const requests: ServedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = new URL(request.url);
		const text = await request.text();
		requests.push({
			method: request.method,
			url: `${url.protocol}//${url.host}${url.pathname}`,
			params: [...url.searchParams.entries()],
			authorization: request.headers.get("authorization"),
			accept: request.headers.get("accept"),
			tenant: request.headers.get("xero-tenant-id"),
			content_type: request.headers.get("content-type"),
			body: text === "" ? null : text,
		});
		const response = responses.shift();
		if (response === undefined) throw new Error("No scripted response left.");
		const body = "hex" in response ? fromHex(response.hex) : response.text;
		return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
	};
	const io = new CallIo({ fetch, now: () => performance.now(), admits: () => true });
	const client = new XeroClient(TOKEN, io);
	const outcome: JsonObject = {};
	const call = scenario.call;
	try {
		if (call.kind === "account") {
			const account = await connector.account(client);
			outcome.account = { id: account.id, label: account.label };
		} else if (call.kind === "discover") {
			const found = await connector.discover(client, "organisation", { query: call.query, cursor: call.cursor });
			outcome.page = { items: found.items.map((item) => [item.id, item.name, item.expandable ?? false]), next_cursor: found.nextCursor ?? null };
		} else if (call.kind === "describe") {
			outcome.names = Object.entries(await connector.describe(client, "organisation", call.ids));
		} else {
			const operation = op(call.op);
			const validated = await validateInput(operation.input as never, call.args);
			if (!validated.ok) throw new Error(validated.message);
			const prepared = await operation.prepare(binding(CONNECTION, client), validated.data as never);
			outcome.requirements = prepared.requirements.map(
				(requirement): JsonObject =>
					"need" in requirement ? { need: resourceOf(requirement.need), action: requirement.action } : { enumerate: requirement.enumerate, action: requirement.action },
			);
			outcome.requests_before_execute = requests.length;
			let output: ProviderOutput;
			if (termsOf(operation).mutates) {
				const attempt = io.openWrite(performance.now() + 60_000);
				try {
					output = await prepared.execute();
				} finally {
					outcome.effect = attempt.sent ? attempt.effect : "not_sent";
					attempt.close();
				}
			} else output = await prepared.execute();
			outcome.output = {
				records: output.records.map((record) => ({ resource: resourceOf(record.resource), data: record.data })),
				next_cursor: output.nextCursor ?? null,
				incomplete: output.incomplete ?? false,
			};
		}
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		outcome.error = { code: error.code, message: error.message };
	} finally {
		io.close();
		await client.close();
	}
	expect(responses).toEqual([]);
	return { requests, outcome };
}

describe("scenarios run as today", () => {
	test.each(vectors.scenarios.map((scenario) => [scenario.name, scenario] as const))("%s", async (_, scenario) => {
		const { requests, outcome } = await replay(scenario);
		// The records' key order too: the model reads them as JSON text.
		expect(JSON.stringify(outcome)).toBe(JSON.stringify(scenario.outcome));
		expect(requests.map((request) => ({ ...request, body: null }))).toEqual(scenario.requests.map((request) => ({ ...request, body: null })));
		// Python writes the draft's amounts as floats (1.0); here they are the decimals (1), the same numbers.
		expect(requests.map((request) => (request.body === null ? null : parseJson(request.body)))).toEqual(
			scenario.requests.map((request) => (request.body === null ? null : parseJson(request.body))),
		);
	});
});
