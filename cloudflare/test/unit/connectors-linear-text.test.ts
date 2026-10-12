// backend/tests/test_linear.py's text, judge and ancestry cases, and the Linear connector's pure rules
// compared with today's Python through test/fixtures/connectors/linear/vectors.json (generate.py there):
// read text, written text and its links, team and issue names, due dates, the judge of writes, GraphQL
// errors, and every operation's input validation.

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
	Comment,
	IssueSummary,
	Label,
	MAX_TEAM_DEPTH,
	Organization,
	PageInfo,
	Person,
	Team,
	type TeamRef,
	classify,
	judge,
	laxBool,
	laxFloat,
} from "../../src/connectors/linear/client.ts";
import { linear } from "../../src/connectors/linear/connector.ts";
import { issueLinks, redact, writtenProblem } from "../../src/connectors/linear/markdown.ts";
import { pythonLoads } from "../../src/connectors/linear/pyjson.ts";
import { isoDate } from "../../src/lib/isoformat.ts";
import { strOf } from "../../src/connectors/linear/python.ts";
import { PYTHON_SPACE_CLASS as RE_SPACE, WORD_CLASS as RE_WORD, pythonSplit } from "../../src/lib/text.ts";
import { ancestry, issueName, teamName } from "../../src/connectors/linear/teams.ts";
import type { Operation } from "../../src/contracts/connectors.ts";
import { termsOf } from "../../src/gateway/connector.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { fromHex, fromUtf8 } from "../../src/lib/bytes.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";
import { sortByCodePoint } from "../../src/lib/order.ts";
import type { OAuth2 } from "../../src/workspace/credentials.ts";
import vectors from "../fixtures/connectors/linear/vectors.json" with { type: "json" };

const SECRET = "Secret ops thing";

/** `str(UUID(int=n))`. */
function uuid(n: number): string {
	const hex = n.toString(16).padStart(32, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function response(status: number, body: unknown): [Response, string] {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return [new Response(text, { status }), text];
}

function judged(status: number, body: unknown): string | null {
	const [res, text] = response(status, body);
	return judge(res, text);
}

describe("text (test_linear.py)", () => {
	test("read text hides titles of linked objects", () => {
		const shown = redact(
			`[${SECRET}](https://linear.app/acme/issue/OPS-1/secret-ops-thing) and ` +
				"https://linear.app/Acme/issue/ops-2/other-title, " +
				"https://linear.app/acme/project/secret-roadmap-0a1b2c3d4e5f/overview, " +
				"linear.app/acme/view/hush-hush, https://linear.app/acme, " +
				"![shot](https://uploads.linear.app/a/b.png), " +
				`[\\[SEC\\] ${SECRET} \\[x\\]](https://linear.app/acme/issue/OPS-1/x), ` +
				`[[${SECRET}]](https://linear.app/acme/issue/OPS-1 'tip'), ` +
				`![${SECRET}](https://linear.app/acme/issue/OPS-1 (${SECRET})), ` +
				`[${SECRET}](https://linear.app/acme/issue/OPS-1 "a \\"quote\\"")`,
		);
		for (const hidden of ["ecret", "other-title", "roadmap", "hush"]) expect(shown).not.toContain(hidden);
		expect(shown).toContain("https://linear.app/acme/issue/OPS-1 and");
		expect(shown).toContain("https://linear.app/Acme/issue/OPS-2,");
		expect(shown).toContain("https://linear.app/acme/project/0a1b2c3d4e5f,");
		expect(shown).toContain("https://linear.app/acme/view,");
		expect(shown).toContain("![shot](https://uploads.linear.app/a/b.png)");
		expect(shown).not.toContain("SEC");
		expect(redact(null)).toBeNull();
	});

	test.each([
		"![x](https://evil.example/p.png)",
		"<img src=https://evil.example/p.png>",
		'<a href="https://evil.example">x</a>',
		"<iframe>",
		"https://linear.app/acme/project/roadmap-0a1b2c3d4e5f",
		"linear.app/acme/issue/ENG-1",
		"https://linear.app/acme/issue/ENG-1.evil",
		"[x](https://linear.app/acme/issue/ENG-1/../../issue/OPS-1)",
		"[x](https://linear.app/acme/issue/ENG-1/x_/../../OPS-1)",
		"[x](https://linear.app/acme/issue/ENG-1'/../OPS-1)",
		"https://linear.app/acme/issue/ENG-1)/../OPS-1",
		"https://linear.app/acme/issue/ENG-1\\)/../OPS-1",
		"https://linear.app/acme/issue/ENG-1/%2e%2e",
		"https://linear.app/acme/issue/ENG-1?x=1",
		"https://linear.app/acme/issue/ENG-1#top",
		"[x](https://linear%2eapp/acme/issue/OPS-1)",
		"[x](https://linear&#46;app/acme/issue/OPS-1)",
		"[x](https://linear\\.app/acme/issue/OPS-1)",
		"[x](https://linear。app/acme/issue/OPS-1)",
		"[x](https://ｌｉｎｅａｒ.app/acme/issue/OPS-1)",
		"[x](https://linear​.app/acme/issue/OPS-1)",
		"https://linear.app/acme/settings/api",
		"[ENG-1](https://linear.app/acme/team/ENG)",
		"nul\x00",
		Array.from({ length: 11 }, (_, n) => `https://linear.app/acme/issue/ENG-${n + 1}`).join(" "),
	])("written text may only add words: %j", (written) => {
		expect(writtenProblem(written)).not.toBeNull();
	});

	test("written text allows markdown, uploads and issue links", () => {
		const written =
			"Plain **markdown** with [a link](https://example.com), <br>, " +
			"![shot](https://uploads.linear.app/a/b.png), [docs](https://linear.app/Acme/issue/eng-2/write-docs) " +
			"and https://linear.app/acme/issue/ENG-2. (https://linear.app/acme/issue/ENG-2), 100% sure, " +
			"**https://linear.app/acme/issue/ENG-2**, <https://linear.app/acme/issue/ENG-2/>";
		expect(writtenProblem(written)).toBeNull();
		expect(issueLinks(written)).toEqual([["acme", "ENG-2"]]);
	});

	test("judge claims only what Linear confirms", () => {
		const error = { message: "x", extensions: { type: "internal error" } };
		expect(judged(200, { data: { issueCreate: { success: true } } })).toBe("applied");
		// Errors raised before anything ran.
		const malformed = { message: "x", extensions: { type: "graphql error", code: "GRAPHQL_VALIDATION_FAILED" } };
		expect(judged(400, { errors: [malformed] })).toBe("not_applied");
		const limited = { message: "x", extensions: { type: "Ratelimited", code: "RATELIMITED" } };
		expect(judged(400, { data: null, errors: [limited] })).toBe("not_applied");
		// Anything else may have been applied.
		expect(judged(400, { errors: [error] })).toBe("unknown");
		expect(judged(200, { data: null, errors: [malformed] })).toBe("unknown");
		expect(judged(200, { data: null, errors: [error] })).toBe("unknown");
		expect(judged(200, { data: { issueCreate: { success: false } } })).toBe("unknown");
		expect(judged(200, "<html>")).toBe("unknown");
		expect(judged(502, "<html>")).toBeNull();
	});

	test("team chains beyond the limit are partial", () => {
		const chain = (levels: number): TeamRef => {
			let team: TeamRef = { id: uuid(1000), parent: null };
			for (let n = 0; n < levels; n++) team = { id: uuid(n + 1), parent: team };
			return team;
		};
		let [within, partial] = ancestry(chain(MAX_TEAM_DEPTH));
		expect([within.length, partial]).toEqual([MAX_TEAM_DEPTH, false]);
		[within, partial] = ancestry(chain(MAX_TEAM_DEPTH + 1));
		expect([within.length, partial]).toEqual([MAX_TEAM_DEPTH, true]);
		// A cycle, or a parent that is not a team id, ends the chain as partial.
		const loop: TeamRef = { id: uuid(1), parent: { id: uuid(2), parent: { id: uuid(1).toUpperCase(), parent: null } } };
		expect(ancestry(loop)).toEqual([[uuid(2)], true]);
		expect(ancestry({ id: uuid(1), parent: { id: "not-a-team", parent: null } })).toEqual([[], true]);
	});
});

/** generate.py `described`: each field's description and default, and the required fields. */
function described(schema: JsonObject): JsonObject {
	const fields: JsonObject = {};
	for (const [name, prop] of Object.entries(schema.properties as { [name: string]: JsonObject })) {
		const anyOf = (prop.anyOf ?? []) as JsonObject[];
		const options = [prop, ...anyOf, ...anyOf.map((item) => (item.items ?? {}) as JsonObject)];
		const description = options.find((option) => Object.hasOwn(option, "description"))?.description ?? null;
		fields[name] = { description, ...(Object.hasOwn(prop, "default") ? { default: prop.default as Json } : {}) };
	}
	return { fields, required: (schema.required ?? []) as Json };
}

describe("against today's Python (vectors.json)", () => {
	test("the declaration: kinds, actions, auth, operations and every string the model or a user reads", () => {
		const auth = linear.auth as OAuth2;
		const ours = {
			slug: linear.slug,
			name: linear.name,
			kinds: linear.kinds.map((kind) => ({
				id: kind.id,
				label: kind.label,
				actions: kind.actions,
				wildcard: kind.wildcard ?? false,
				hierarchical: kind.hierarchical ?? false,
				note: kind.note ?? null,
				listed: kind.listed ?? true,
			})),
			actions: linear.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null })),
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
			browsable: linear.browsable ?? [],
			operations: linear.operations.map((op) => {
				const terms = termsOf(op);
				return {
					name: op.name,
					title: op.title,
					description: op.description,
					needs: op.needs,
					output_action: terms.outputAction,
					consent: terms.consent === null ? null : terms.consent.map((option) => sortByCodePoint(option)),
					revision: terms.revision,
					mutates: terms.mutates,
					paginated: terms.paginated,
					schema: described(inputSchema(op)),
				};
			}),
		};
		expect(ours).toEqual(vectors.declaration);
		expect([linear.offered, linear.manageLink, linear.children]).toEqual([undefined, undefined, undefined]);
	});

	test.each(vectors.redact)("redact $text", ({ text, shown }) => {
		expect(redact(text)).toBe(shown);
	});

	test.each(vectors.written)("check_written $text", (vector) => {
		const problem = writtenProblem(vector.text);
		if ("error" in vector) expect(problem).toBe(vector.error);
		else {
			expect(problem).toBeNull();
			expect(issueLinks(vector.text)).toEqual(vector.links);
		}
	});

	test.each(vectors.teams)("team name $name", (vector) => {
		expect(teamName(vector.name)).toBe("ok" in vector ? vector.ok : null);
	});

	test.each(vectors.issues)("issue name $name", (vector) => {
		expect(issueName(vector.name)).toBe("ok" in vector ? vector.ok : null);
	});

	test.each(vectors.dates)("due date $value", (vector) => {
		expect(isoDate(vector.value)).toBe("ok" in vector ? vector.ok : null);
	});

	test.each(vectors.judge)("judge $status $body", ({ status, body, effect }) => {
		const [res] = response(status, body);
		expect(judge(res, body)).toBe(effect);
	});

	test.each(vectors.raw)("judge and classify $status $hex", ({ status, hex, effect, code }) => {
		const bytes = fromHex(hex);
		const body = new Response(bytes, { status });
		const text = fromUtf8(bytes);
		expect(judge(body, text, bytes)).toBe(effect);
		expect(classify("Linear", body, text, bytes)?.code ?? null).toBe(code);
	});

	test.each(vectors.loads)("json.loads $hex", (vector) => {
		// A number too large for a double, 1e400, is a float `inf` in Python and Infinity here; generate.py
		// writes Python's non-finite floats as None.
		const finite = (value: Json | undefined): Json | undefined => {
			if (typeof value === "number") return Number.isFinite(value) ? value : null;
			if (Array.isArray(value)) return value.map((item) => finite(item) as Json);
			if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finite(item) as Json]));
			return value;
		};
		const loaded = pythonLoads(fromHex(vector.hex));
		if ("error" in vector) expect(loaded).toBeUndefined();
		else expect(finite(loaded)).toEqual(parseJson(vector.json as string));
	});

	test.each(vectors.errors)("classify $errors", ({ errors, code }) => {
		const [res, text] = response(400, { errors });
		expect(classify("Linear", res, text)?.code ?? null).toBe(code);
	});

	const operations = new Map(linear.operations.map((op): [string, Operation<never>] => [op.name, op]));
	const inputs = Object.entries(vectors.inputs).flatMap(([name, cases]) => cases.map((vector) => ({ name, ...vector })));
	test.each(inputs)("$name input $json", async (vector) => {
		const op = operations.get(vector.name) as Operation<never>;
		const result = await validateInput(op.input as never, parseJson(vector.json));
		if ("message" in vector) expect(result).toEqual({ ok: false, message: vector.message });
		else expect(result).toEqual({ ok: true, data: vector.data });
	});

	const models: { [name: string]: z.ZodType<unknown, unknown> } = { PageInfo, Comment, Label, Person, Organization, IssueSummary, Team };
	test.each(vectors.models)("the response model $model reads $value", (vector) => {
		const read = (models[vector.model] as z.ZodType<unknown, unknown>).safeParse(vector.value);
		if ("refused" in vector) expect(read.success).toBe(false);
		else expect(read.data).toEqual(vector.read);
	});

	test.each(vectors.lax.bool)("a response's bool $value", (vector) => {
		const read = laxBool().safeParse(vector.value);
		if ("refused" in vector) expect(read.success).toBe(false);
		else expect(read.data).toBe(vector.ok);
	});

	test.each(vectors.lax.float)("a response's float $value", (vector) => {
		const read = laxFloat().nullable().default(null).safeParse(vector.value);
		// Python's "inf" and "nan" are refused: no JSON can carry them on to the model.
		if ("refused" in vector || typeof vector.ok === "string") expect(read.success).toBe(false);
		else expect(read.data).toBe(vector.ok);
	});

	test("re's \\w, \\d and \\s as the sanitizer writes them, for every code point", () => {
		const { unicode, word, digit, space, unassigned } = vectors.classes;
		const inRanges = (text: string): ((point: number) => boolean) => {
			const bounds = text.split(",").map((range) => range.split("-").map((part) => Number.parseInt(part, 16)) as [number, number]);
			return (point) => bounds.some(([first, last]) => point >= first && point <= last);
		};
		const newer = inRanges(unassigned);
		const ours: [string, RegExp, (point: number) => boolean][] = [
			["word", new RegExp(`^[${RE_WORD}]$`, "u"), inRanges(word)],
			["digit", /^\p{Nd}$/u, inRanges(digit)],
			["space", new RegExp(`^[${RE_SPACE}]$`, "u"), inRanges(space)],
		];
		const mismatches: string[] = [];
		for (let point = 0; point <= 0x10ffff; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const char = String.fromCodePoint(point);
			for (const [name, pattern, python] of ours) if (pattern.test(char) !== python(point)) mismatches.push(`${name} ${point.toString(16)}`);
		}
		// Only where the runtime's Unicode (17 in Node 24) assigned what Python's (16) does not: about 4,700
		// code points, most of them CJK ideographs of Unicode 17's extension J.
		expect(unicode).toBe("16.0.0");
		expect(mismatches.filter((mismatch) => !newer(Number.parseInt(mismatch.split(" ")[1] as string, 16)))).toEqual([]);
		expect(mismatches.length).toBeLessThan(10_000);
	});
});

describe("Python's semantics the rules use", () => {
	test("str.split", () => {
		expect(pythonSplit("  a\u0085b c d﻿e  ")).toEqual(["a", "b", "c", "d﻿e"]);
		expect(pythonSplit("")).toEqual([]);
	});

	test("str() of JSON values", () => {
		expect(strOf(null)).toBe("None");
		expect(strOf(["not found", 1, true, { a: null }])).toBe("['not found', 1, True, {'a': None}]");
		expect(strOf(["it's"])).toBe('["it\'s"]');
	});
});
