// The Notion connector's pure parts and inputs against what today's Python computes: ids and links, page
// text redaction, written-text checks, edit planning, property values and filters, rich text, and every
// operation's normalized arguments or validation message. The vectors are written by
// test/fixtures/connectors/notion/generate.py from backend/connectors/notion/, over hand-picked and seeded
// random cases (regenerate: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/notion/generate.py).

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { hasTitledMention, textOf } from "../../src/connectors/notion/client.ts";
import { notionConnector } from "../../src/connectors/notion/connector.ts";
import { planEdits, redact, showsSyncedContent, writtenRefusal } from "../../src/connectors/notion/markdown.ts";
import { canonical, objectId } from "../../src/connectors/notion/pages.ts";
import { checkFilter, mentionsHidden, readable, schema, writable } from "../../src/connectors/notion/properties.ts";
import { OperationError, offered, termsOf } from "../../src/gateway/connector.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { changedOnPurpose, jsonQuoted, showsPythonValues } from "./changed.ts";
import { type Json, type JsonObject } from "../../src/lib/json.ts";
import { readVectors } from "../fixtures/connectors/read-vectors.ts";

/** Long runs of one string were written as {"$repeat": [unit, count]}. */
function unpack(value: Json): Json {
	if (Array.isArray(value)) return value.map(unpack);
	if (typeof value === "object" && value !== null) {
		const repeat = value.$repeat;
		if (Array.isArray(repeat) && Object.keys(value).length === 1) return (repeat[0] as string).repeat(repeat[1] as number);
		return Object.fromEntries(Object.keys(value).map((key) => [key, unpack(value[key] as Json)]));
	}
	return value;
}

// Read with parseJson (read-vectors.ts): the vectors have escaped keys, which JSON.parse (and so a JSON import) can misread.
const V = readVectors(new URL("../fixtures/connectors/notion/vectors.json", import.meta.url).pathname) as { [section: string]: Json };
const cases = <T extends Json[]>(section: string): T[] => V[section] as T[];

type Outcome = { ok: Json } | { error: { code: string; message: string } } | { value_error: string };

/** The same JSON, keys in the same order. */
function same(actual: unknown, expected: Json): void {
	expect(actual).toEqual(expected);
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function failure(run: () => unknown): { code: string; message: string } | null {
	try {
		run();
	} catch (error) {
		if (error instanceof OperationError) return { code: error.code, message: error.message };
		throw error;
	}
	return null;
}

function expectOutcome(run: () => unknown, expected: Outcome): void {
	if ("error" in expected) expect(failure(run)).toEqual({ ...expected.error, message: jsonQuoted(expected.error.message) });
	else if ("ok" in expected) same(run(), expected.ok);
	else throw new Error("unexpected outcome");
}

describe("ids and links", () => {
	test.each(cases<[Json, string | null]>("canonical"))("canonical(%j)", (value, expected) => {
		expect(canonical(value)).toBe(expected);
	});

	// Links are read by the runtime's URL parser, which repairs what Python's urlsplit split differently
	// (backslashes, missing slashes, full-width letters) and refuses brackets and percent signs in a host.
	const repaired = /[[\]\\%\uff00-\uffef]|^https:\/?[^/]/;
	test.each(cases<[string, Outcome]>("object_id").filter(([value]) => !repaired.test(value)))("object id of %j", (value, expected) => {
		expect(objectId(value)).toBe("ok" in expected ? expected.ok : null);
	});

	test("an id is read only from an https link to a Notion host", () => {
		const id = "0000000000000000000000000000000a";
		const canonicalId = "00000000-0000-0000-0000-00000000000a";
		expect(objectId(`https://www.notion.so/Plan-${id}`)).toBe(canonicalId);
		expect(objectId(`https://Acme.Notion.Site/x/${id}/`)).toBe(canonicalId);
		for (const link of [`http://www.notion.so/${id}`, `https://notion.so.evil.example/${id}`, `https://evil.example/www.notion.so/${id}`, `https://[::1]/${id}`]) {
			expect(objectId(link), link).toBeNull();
		}
		// A link the URL parser repairs names the page it repairs to: the id only names a page, and grants are
		// checked on the id.
		for (const link of [`https:www.notion.so/${id}`, `https://www.notion.so\\${id}`, `https://www%2enotion.so/${id}`]) {
			expect(objectId(link), link).toBe(canonicalId);
		}
	});
});

describe("page text", () => {
	test.each(cases<[string, string]>("redact").filter(([text]) => !changedOnPurpose(text)))("redact(%j)", (text, expected) => {
		expect(redact(text)).toBe(expected);
	});

	test.each(cases<[string, Outcome]>("written").filter(([text]) => !changedOnPurpose(text)))("written %j", (text, expected) => {
		expect(writtenRefusal(text)).toBe("value_error" in expected ? expected.value_error : null);
	});

	test.each(cases<[string, boolean]>("synced"))("synced %j", (text, expected) => {
		expect(showsSyncedContent(text)).toBe(expected);
	});

	test.each(cases<[string, [string, string][], Outcome]>("plan_edits"))("edits of %j: %j", (page, edits, expected) => {
		expectOutcome(() => planEdits(page, edits), expected);
	});
});

describe("properties", () => {
	const [shared] = cases<JsonObject[]>("properties") as unknown as [JsonObject];

	test.each(cases<[Json, Json]>("readable").filter(([, expected]) => !showsPythonValues(expected)))("readable(%j)", (properties, expected) => {
		same(readable(properties), expected);
	});

	test.each(cases<[Json, Json]>("schema"))("schema(%j)", (properties, expected) => {
		same(schema(properties), expected);
	});

	test.each(cases<[Json, Json, Outcome]>("writable").map((item) => unpack(item) as [Json, Json, Outcome]).filter(([, values]) => !changedOnPurpose(values)))("writable(%j, %j)", (properties, values, expected) => {
		expectOutcome(() => writable(properties ?? shared, values as JsonObject), expected);
	});

	test.each(cases<[Json, Json, Outcome]>("filters").filter(([, , expected]) => !showsPythonValues(expected)))("filter %#: %j", (properties, value, expected) => {
		expectOutcome(() => [...checkFilter(properties ?? shared, value)].sort(), expected);
	});

	test.each(cases<[Json, boolean]>("mentions"))("mentions hidden: %j", (prop, expected) => {
		expect(mentionsHidden(prop)).toBe(expected);
	});

	test.each(cases<[Json, string, boolean]>("text_of").filter(([, text]) => !showsPythonValues(text)))("text of %j", (items, text, mention) => {
		expect(textOf(items)).toBe(text);
		expect(hasTitledMention(items)).toBe(mention);
	});
});

/**
 * The probes of a filter's or sorts' size limit (a long run of one character): the vectors measured the size
 * as JSON with spaces after "," and ":" and non-ASCII escaped, where it is now JSON.stringify's length.
 */
function sizeProbe(args: Json): boolean {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
	return [args.filter, args.sorts].some((value) => value !== undefined && /(.)\1{999}/u.test(JSON.stringify(value)));
}

describe("operation inputs", () => {
	const connector = notionConnector();
	const inputs = V.inputs as { [operation: string]: Json[] };
	const all = Object.entries(inputs)
		.flatMap(([name, list]) => list.map((item) => [name, ...(unpack(item) as [Json, Json])] as const))
		.filter(([, args]) => !changedOnPurpose(args) && !sizeProbe(args));

	test("every operation has vectors", () => {
		expect(Object.keys(inputs).sort()).toEqual(connector.operations.map((op) => op.name).sort());
	});

	test.each(all)("%s %j", async (name, args, expected) => {
		const op = connector.operations.find((item) => item.name === name);
		const result = await validateInput(op?.input as z.ZodType, args);
		const want = expected as { data: Json } | { message: string };
		if ("message" in want) expect(result).toMatchObject({ ok: false });
		else {
			expect(result.ok).toBe(true);
			same(result.ok ? result.data : null, want.data);
		}
	});
});

/** Every field description inside a JSON Schema value (zod writes nested models inline). */
function descriptions(value: unknown, found: Set<string>): Set<string> {
	if (Array.isArray(value)) for (const item of value) descriptions(item, found);
	else if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) {
			if (key === "description" && typeof item === "string") found.add(item);
			else descriptions(item, found);
		}
	}
	return found;
}

describe("declarations", () => {
	const connector = notionConnector();
	const declared = V.declarations as { connector: JsonObject[]; operations: JsonObject[] };

	test("the connector, its kinds, actions and auth, word for word", () => {
		const auth = connector.auth;
		if (auth.type !== "oauth2") throw new Error("Notion connects through OAuth");
		same(
			{
				slug: connector.slug,
				name: connector.name,
				kinds: connector.kinds.map((kind) => ({
					id: kind.id,
					label: kind.label,
					actions: kind.actions,
					wildcard: kind.wildcard ?? false,
					hierarchical: kind.hierarchical ?? false,
					note: kind.note ?? null,
					listed: kind.listed ?? true,
				})),
				actions: connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null })),
				auth: {
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
				},
				browsable: [...(connector.browsable ?? [])].sort(),
				manage_link: connector.manageLink?.() ?? null,
			},
			declared.connector[0] as JsonObject,
		);
	});

	test.each(declared.operations.map((op) => [op.name as string, op] as const))("%s, word for word", (name, expected) => {
		const op = connector.operations.find((item) => item.name === name);
		if (op === undefined) throw new Error(`no operation ${name}`);
		const terms = termsOf(op);
		const schema = inputSchema(op) as { properties: { [field: string]: Json }; required?: string[] };
		same(
			{
				name: op.name,
				title: op.title,
				description: op.description,
				needs: op.needs,
				output_action: terms.outputAction,
				consent: terms.consent,
				revision: terms.revision,
				mutates: terms.mutates,
				paginated: terms.paginated,
				fields: Object.keys(schema.properties),
				required: [...(schema.required ?? [])].sort(),
				defaults: Object.fromEntries(
					Object.entries(schema.properties).flatMap(([field, value]) =>
						typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "default") ? [[field, value.default as Json]] : [],
					),
				),
				descriptions: Object.fromEntries(Object.entries(schema.properties).map(([field, value]) => [field, [...descriptions(value, new Set())].sort()])),
				offered: offered(connector, op),
			},
			expected,
		);
	});

	test("in the same order", () => {
		expect(connector.operations.map((op) => op.name)).toEqual(declared.operations.map((op) => op.name));
	});
});
