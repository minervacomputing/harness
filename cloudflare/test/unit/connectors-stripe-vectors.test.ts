// The Stripe connector against what today's Python answers, from test/fixtures/connectors/stripe/vectors.json
// (written by generate.py there): the declaration with its descriptions and input schemas, input
// validation, money.py, the client's error names and the records the reads build.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Operation } from "../../src/contracts/connectors.ts";
import { Charge, Customer, Invoice, StripeClient, Subscription, classify } from "../../src/connectors/stripe/client.ts";
import { stripeConnector } from "../../src/connectors/stripe/connector.ts";
import * as money from "../../src/connectors/stripe/money.ts";
import { chargeData, customerData, invoiceData, subscriptionData } from "../../src/connectors/stripe/reads.ts";
import { OperationError, termsOf } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { fromUtf8 } from "../../src/lib/bytes.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";
import { KEY } from "../fixtures/connectors/stripe/fake.ts";
import { changedOnPurpose } from "./changed.ts";

interface Vectors {
	declaration: {
		slug: string;
		name: string;
		kinds: Json[];
		actions: Json[];
		auth: Json;
		manage_link: [string, string];
		operations: {
			name: string;
			title: string;
			description: string;
			needs: [string, string][];
			output_action: string;
			consent: Json;
			revision: number;
			mutates: boolean;
			paginated: boolean;
			schema: Json;
		}[];
	};
	inputs: { op: string; args: Json; data?: Json; message?: string }[];
	money: {
		parse: { value: string; currency: string; minor?: number; error?: string }[];
		major: { minor: number; currency: string; major: string; display: string }[];
		names: { [id: string]: string | null };
		ancestors: { currency: string; minor: number; ancestors: string[] }[];
		choices: { [currency: string]: string[] };
		currency: { [value: string]: string | { error: string } };
	};
	errors: { status: number; hex: string; named: [string, string] | null }[];
	reads: { hex: string; data: Json }[];
	records: { [kind in "customers" | "charges" | "invoices" | "subscriptions"]: { object: Json; record: Json }[] };
}

const vectors = parseJson(readFileSync(new URL("../fixtures/connectors/stripe/vectors.json", import.meta.url).pathname, "utf8")) as unknown as Vectors;
const connector = stripeConnector();

function operation(name: string): Operation<never> {
	const op = connector.operations.find((item) => item.name === name);
	if (op === undefined) throw new Error(`No operation ${name}`);
	return op;
}

/** Pydantic's JSON Schema without the titles it gives every field, which zod has no names for; the model's is kept. */
function untitled(value: Json, root = true): Json {
	if (Array.isArray(value)) return value.map((item) => untitled(item, false));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => root || key !== "title")
			.map(([key, item]) => [key, untitled(item, false)]),
	);
}

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

describe("the declaration is today's", () => {
	const python = vectors.declaration;

	test("kinds, actions, auth and the manage link", () => {
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
		expect(connector.browsable ?? []).toEqual([]);
		expect(connector.manageLink?.()).toEqual(python.manage_link);
	});

	test.each(python.operations.map((op) => [op.name, op] as const))("%s", (name, op) => {
		const declared = operation(name);
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
		}).toEqual({ ...op, schema: undefined });
		// Field order, descriptions, limits, enums, defaults and what is required, as the model sees them.
		const schema = inputSchema(declared);
		expect(schema).toEqual(untitled(op.schema));
		expect(Object.keys(schema.properties as object)).toEqual(Object.keys((op.schema as { properties: object }).properties));
	});

	test("in today's order", () => {
		expect(connector.operations.map((op) => op.name)).toEqual(python.operations.map((op) => op.name));
	});
});

describe("inputs validate as Pydantic validates them", () => {
	test.each(vectors.inputs.map((vector) => [`${vector.op} ${JSON.stringify(vector.args)}`, vector] as const))("%s", async (_, vector) => {
		const result = await validateInput(operation(vector.op).input as never, vector.args);
		if (vector.message !== undefined) expect(result).toMatchObject({ ok: false });
		else expect(result).toEqual({ ok: true, data: vector.data });
	});

	test("a null email is no filter, where Python's single_line raised a TypeError on it", async () => {
		// Deviation: today `{"email": null}` fails the call with the generic error.
		expect(await validateInput(operation("list_customers").input as never, { email: null })).toEqual({ ok: true, data: { email: null, limit: 10, cursor: null } });
	});
});

describe("money is today's", () => {
	test.each(vectors.money.parse.map((vector) => [`${vector.value} ${vector.currency}`, vector] as const))("parse %s", (_, vector) => {
		if (vector.error !== undefined) expect(() => money.parse(vector.value, vector.currency)).toThrow(new money.MoneyError(vector.error));
		else expect(money.parse(vector.value, vector.currency)).toBe(vector.minor);
	});

	test("major and display", () => {
		for (const vector of vectors.money.major) {
			expect([money.major(vector.minor, vector.currency), money.display(vector.minor, vector.currency)]).toEqual([vector.major, vector.display]);
		}
	});

	test("tier and currency names", () => {
		for (const [id, name] of Object.entries(vectors.money.names)) expect([id, money.name(id)]).toEqual([id, name]);
	});

	test("ancestors and choices", () => {
		for (const vector of vectors.money.ancestors) expect(money.ancestors(vector.currency, vector.minor)).toEqual(vector.ancestors);
		for (const [currency, choices] of Object.entries(vectors.money.choices)) expect(money.choices(currency)).toEqual(choices);
	});

	test("currency codes", () => {
		for (const [value, expected] of Object.entries(vectors.money.currency)) {
			if (typeof expected === "string") expect(money.currency(value)).toBe(expected);
			else expect(() => money.currency(value)).toThrow(new money.MoneyError(expected.error));
		}
	});

	test("an amount in the smallest unit is an integer", () => {
		expect(() => money.major(12.5, "usd")).toThrow(RangeError);
	});
});

describe("Stripe's errors are named as today", () => {
	test.each(vectors.errors.map((vector) => [`${vector.status} ${fromUtf8(bytes(vector.hex))}`, vector] as const))("%s", (_, vector) => {
		// What ProviderHTTP hands classify: the response and its body's text.
		const body = bytes(vector.hex);
		const named = classify("Stripe", new Response(body, { status: vector.status }), fromUtf8(body));
		expect(named === null ? null : [named.code, named.message]).toEqual(vector.named);
	});

	test("through ProviderHTTP, a failed read is named by them first", async () => {
		for (const vector of vectors.errors.filter((item) => item.named !== null)) {
			const client = new StripeClient(KEY, settingsIo(async () => new Response(bytes(vector.hex), { status: vector.status })));
			const error = await client.customer("cus_1").then(
				() => null,
				(caught: unknown) => caught,
			);
			if (!(error instanceof OperationError)) throw error;
			expect([error.code, error.message]).toEqual(vector.named);
		}
	});

	test("an invalid UTF-8 error body is read with U+FFFD, where httpx's json() refused it", () => {
		// Deviation: classify sees ProviderHTTP's lenient text, so the error is still named.
		const encoder = new TextEncoder();
		const body = Uint8Array.from([...encoder.encode('{"error":{"type":"permission_error","message":"'), 0xff, ...encoder.encode('"}}')]);
		expect(classify("Stripe", new Response(body, { status: 400 }), fromUtf8(body))?.code).toBe("PROVIDER_FORBIDDEN");
	});
});

describe("GET responses are read as model_validate_json reads them", () => {
	test.each(vectors.reads.map((vector) => [fromUtf8(bytes(vector.hex)), vector] as const))("%s", async (_, vector) => {
		const client = new StripeClient(KEY, settingsIo(async () => new Response(bytes(vector.hex), { status: 200 })));
		const found = await client.customer("cus_1").then(
			(customer) => customer as unknown as Json,
			(error: unknown) => {
				if (error instanceof OperationError && error.code === "PROVIDER_FAILED") return null;
				throw error;
			},
		);
		expect(found).toEqual(vector.data);
	});
});

describe("records are today's", () => {
	const cases = [
		["customers", (object: Json) => customerData(Customer.parse(object))],
		["charges", (object: Json) => chargeData(Charge.parse(object))],
		["invoices", (object: Json) => invoiceData(Invoice.parse(object))],
		["subscriptions", (object: Json) => subscriptionData(Subscription.parse(object))],
	] as const;

	test.each(cases)("%s", (kind, build) => {
		for (const vector of vectors.records[kind]) {
			if (changedOnPurpose(vector.object)) continue;
			// Key order too: the model reads the record as JSON text.
			expect(JSON.stringify(build(vector.object))).toBe(JSON.stringify(vector.record));
		}
	});
});
