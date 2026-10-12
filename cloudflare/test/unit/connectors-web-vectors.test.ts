// The Web connector (src/connectors/web/, lib/sites.ts, lib/urlsplit.ts, lib/markdown.ts) against today's
// Python one: the vectors in test/fixtures/connectors/web/ were written by running backend/connectors/web/
// itself (its declaration with and without a Brave key, its input models with the query hash page tokens
// bind to, the search cursors it accepts, canonical_host, the site ids and patterns, parse_url with and
// without a base, urljoin, html_to_text, plain, decode, and `_body` over httpx responses split into chunks
// at every byte, damaged, cut short, with second members, trailing data and bombs).

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { SEARCH, webConnector } from "../../src/connectors/web/connector.ts";
import { Body, decode } from "../../src/connectors/web/fetch.ts";
import { plain } from "../../src/connectors/web/search.ts";
import { OperationError, binding, offered, termsOf } from "../../src/gateway/connector.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { type Json } from "../../src/lib/json.ts";
import { readVectors } from "../fixtures/connectors/read-vectors.ts";
import { htmlToText } from "../../src/lib/markdown.ts";
import { PythonError } from "../../src/lib/pyerrors.ts";
import { ancestors, canonicalHost, choices, name, parseUrl, registrable, validId } from "../../src/lib/sites.ts";
import { urljoin } from "../../src/lib/urlsplit.ts";
import { kindsOut } from "../../src/workspace/out.ts";

type Fields = { [key: string]: Json };
type Outcome = { ok: true } | { ok: false; code: string; message: string } | { ok: false; raises: string };

interface Vectors {
	declaration: {
		slug: string;
		name: string;
		kinds: { id: string; label: string; actions: string[]; wildcard: boolean; hierarchical: boolean; note: string | null; listed: boolean }[];
		actions: { id: string; label: string; requires: string | null }[];
		browsable: string[];
		manage_link: [string, string] | null;
		operations: (Fields & { name: string; input_schema: Fields })[];
	};
	inputs: { [operation: string]: ({ raw: Json; ok: true; fields: Fields; query_hash: string } | { raw: Json; ok: false; message: string })[] };
	cursors: ({ cursor: string } & Outcome)[];
	hosts: { raw: string; plain: Outcome & { host?: string }; reserved: Outcome & { host?: string } }[];
	sites: {
		ids: { id: string; valid: boolean; name: string }[];
		hosts: { host: string; ancestors: string[]; choices: string[]; registrable: string | null }[];
	};
	urls: { raw: string; base: string | null; result: Outcome & { scheme?: string; host?: string; target?: string } }[];
	urljoin: { base: string; url: string; ok: boolean; joined?: string }[];
	html: { html: string; base: string; text: string; title: string | null }[];
	plain: { text: string; plain: string }[];
	decode: { body: string; content_type: string; result: Outcome & { mime?: string; form?: string; text?: string } }[];
	bodies: { encoding: string | null; chunks: string[]; result: Outcome & { length?: number; sha256?: string; head?: string } }[];
}

const VECTORS = readVectors(new URL("../fixtures/connectors/web/vectors.json", import.meta.url).pathname) as unknown as Vectors;
const CONNECTION = "0199a000-0000-7000-8000-0000000000f1";

/** What the generator's `raised` records for an error. */
function raised(error: unknown): Outcome {
	if (error instanceof OperationError) return { ok: false, code: error.code, message: error.message };
	if (error instanceof PythonError) return { ok: false, raises: error.name === "PyTypeError" ? "TypeError" : error.name };
	throw error;
}

function attempt<T extends object>(run: () => T): Outcome | ({ ok: true } & T) {
	try {
		return { ok: true, ...run() };
	} catch (error) {
		return raised(error);
	}
}

function bytes(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("the declaration", () => {
	const python = VECTORS.declaration;
	const withoutKey = webConnector({ braveKey: () => null });
	const withKey = webConnector({ braveKey: () => "k" });

	test("is Python's: kinds, actions, builtin auth, nothing browsable and no manage link", () => {
		expect([withoutKey.slug, withoutKey.name]).toEqual([python.slug, python.name]);
		expect(kindsOut(withoutKey).map(({ browsable: _, ...kind }) => kind)).toEqual(python.kinds);
		expect(withoutKey.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null }))).toEqual(python.actions);
		expect(withoutKey.auth).toEqual({ type: "builtin" });
		expect(withoutKey.browsable ?? []).toEqual(python.browsable);
		expect(withoutKey.manageLink ? withoutKey.manageLink() : null).toEqual(python.manage_link);
	});

	test("its operations are Python's, strings verbatim, search offered only with a key, and their input schemas are Pydantic's", () => {
		expect(withoutKey.operations.map((op) => op.name)).toEqual(python.operations.map((op) => op.name));
		for (const [index, op] of withoutKey.operations.entries()) {
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
				offered: offered(withoutKey, op),
				offered_with_key: offered(withKey, withKey.operations[index] as typeof op),
				input_schema: inputSchema(op),
			}).toEqual(expected);
			expect(Object.keys(inputSchema(op).properties as object)).toEqual(Object.keys(expected?.input_schema.properties as object));
		}
	});
});

describe("inputs as Python normalizes them", () => {
	for (const op of webConnector().operations) {
		const cases = VECTORS.inputs[op.name] ?? [];
		test(`${op.name}: ${cases.length} cases, with the query hash computed from them`, async () => {
			expect(cases.length).toBeGreaterThan(0);
			for (const expected of cases) {
				const validated = await validateInput(op.input as z.ZodType, expected.raw === null ? undefined : expected.raw);
				if (!expected.ok) {
					expect(validated, JSON.stringify(expected.raw)).toEqual({ ok: false, message: expected.message });
					continue;
				}
				expect(validated, JSON.stringify(expected.raw)).toEqual({ ok: true, data: expected.fields });
				if (validated.ok) expect(await queryHash(validated.data)).toBe(expected.query_hash);
			}
		});
	}

	test(`search cursors: ${VECTORS.cursors.length} as _prepare_search reads them, Unicode digits included`, async () => {
		for (const expected of VECTORS.cursors) {
			const validated = await validateInput(SEARCH.input as z.ZodType, { query: "q", cursor: expected.cursor || null });
			if (!validated.ok) throw new Error(validated.message);
			let outcome: Outcome;
			try {
				await SEARCH.prepare(binding(CONNECTION, null as never), validated.data as never);
				outcome = { ok: true };
			} catch (error) {
				outcome = raised(error);
			}
			expect(outcome, expected.cursor).toEqual((({ cursor: _, ...rest }) => rest)(expected));
		}
	});
});

describe("host names, sites and addresses as lib/sites.ts reads them", () => {
	test(`canonical_host: ${VECTORS.hosts.length} names, hostile spellings and seeded random ones, with and without reserved names`, () => {
		for (const expected of VECTORS.hosts) {
			expect(
				attempt(() => ({ host: canonicalHost(expected.raw) })),
				JSON.stringify(expected.raw),
			).toEqual(expected.plain);
			expect(
				attempt(() => ({ host: canonicalHost(expected.raw, true) })),
				JSON.stringify(expected.raw),
			).toEqual(expected.reserved);
		}
	});

	test("site ids, names, ancestors, choices and registrable domains", () => {
		for (const expected of VECTORS.sites.ids) expect({ id: expected.id, valid: validId(expected.id), name: name(expected.id) }).toEqual(expected);
		for (const expected of VECTORS.sites.hosts) {
			expect({ host: expected.host, ancestors: ancestors(expected.host), choices: choices(expected.host), registrable: registrable(expected.host) }).toEqual(expected);
		}
	});

	test(`parse_url: ${VECTORS.urls.length} addresses, alone and against a base`, () => {
		for (const expected of VECTORS.urls) {
			const result = attempt(() => {
				const url = parseUrl(expected.raw, expected.base === null ? null : parseUrl(expected.base));
				return { scheme: url.scheme, host: url.host, target: url.target };
			});
			expect(result, `${JSON.stringify(expected.raw)} against ${expected.base}`).toEqual(expected.result);
		}
	});

	test(`urljoin: ${VECTORS.urljoin.length} seeded random pairs`, () => {
		for (const expected of VECTORS.urljoin) {
			let actual: { ok: boolean; joined?: string };
			try {
				actual = { ok: true, joined: urljoin(expected.base, expected.url) };
			} catch (error) {
				if (!(error instanceof PythonError) || error.name !== "ValueError") throw error;
				actual = { ok: false };
			}
			expect({ base: expected.base, url: expected.url, ...actual }).toEqual(expected);
		}
	});
});

describe("pages as text", () => {
	test(`html_to_text: ${VECTORS.html.length} pages with base addresses, links resolved, hidden parts dropped`, () => {
		for (const expected of VECTORS.html) {
			const [text, title] = htmlToText(expected.html, expected.base);
			expect({ html: expected.html, base: expected.base, text, title }).toEqual(expected);
		}
	});

	test("plain: snippets without their markup", () => {
		for (const expected of VECTORS.plain) expect(plain(expected.text)).toBe(expected.plain);
	});

	test(`decode: ${VECTORS.decode.length} bodies and content types, charsets from the header, a <meta> or a byte order mark`, () => {
		for (const expected of VECTORS.decode) {
			const result = attempt(() => {
				const [mime, form, text] = decode(bytes(expected.body), expected.content_type);
				return { mime, form, text };
			});
			expect(result, `${expected.body} as ${expected.content_type}`).toEqual(expected.result);
		}
	});
});

describe("bodies as _body reads them", () => {
	test(`${VECTORS.bodies.length} bodies: gzip and deflate split at every byte, damaged, cut short, followed by more, and bombs`, () => {
		for (const [index, expected] of VECTORS.bodies.entries()) {
			const result = attempt(() => {
				const body = new Body(expected.encoding);
				for (const chunk of expected.chunks) body.feed(bytes(chunk));
				const out = body.bytes();
				return { length: out.length, sha256: createHash("sha256").update(out).digest("hex"), head: Buffer.from(out.subarray(0, 64)).toString("base64") };
			});
			expect(result, `case ${index}: ${expected.encoding}, ${expected.chunks.length} chunks`).toEqual(expected.result);
		}
	});
});
