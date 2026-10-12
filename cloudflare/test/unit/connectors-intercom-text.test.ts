// The Intercom connector's pure parts compared with today's Python through
// test/fixtures/connectors/intercom/vectors.json (generate.py there): the HTML parser's events and the text
// agents are shown, `redact`, `written` and `check_written`, `updated_after` and its timestamp, `iso`,
// `classify`, every operation's input validation, the response models' lax ints and bools, the character
// classes the expressions are written with, and str.casefold for every code point. backend/tests/
// test_intercom.py's text case is ported here too.

import { describe, expect, test } from "vitest";
import { classify, laxBool, laxInt } from "../../src/connectors/intercom/client.ts";
import { intercom } from "../../src/connectors/intercom/connector.ts";
import { type Attribute, HTMLParser } from "../../src/connectors/intercom/html-parser.ts";
import { checkWritten, read, redact, written } from "../../src/connectors/intercom/html.ts";
import { iso } from "../../src/connectors/intercom/inboxes.ts";
import { RE_I, RE_LETTERS_EXTRA, RE_WORD } from "../../src/connectors/intercom/python.ts";
import { PYTHON_SPACE_CLASS as RE_SPACE } from "../../src/lib/text.ts";
import { casefold } from "../../src/lib/casefold.ts";
import { sinceProblem, sinceTimestamp } from "../../src/connectors/intercom/reads.ts";
import type { Operation } from "../../src/contracts/connectors.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { fromHex, fromUtf8 } from "../../src/lib/bytes.ts";
import { parseJson } from "../../src/lib/json.ts";
import folds from "../fixtures/connectors/intercom/casefold.json" with { type: "json" };
import vectors from "../fixtures/connectors/intercom/vectors.json" with { type: "json" };

const SECRET = "SECRET merger";

type Event = (string | Attribute[])[];

/** Every event the port raises, as generate.py's `Events` records Python's. */
class Events extends HTMLParser {
	readonly events: Event[] = [];

	override handleStartTag(tag: string, attrs: Attribute[]): void {
		this.events.push(["start", tag, attrs]);
	}

	override handleStartEndTag(tag: string, attrs: Attribute[]): void {
		this.events.push(["startend", tag, attrs]);
	}

	override handleEndTag(tag: string): void {
		this.events.push(["end", tag]);
	}

	override handleData(data: string): void {
		this.events.push(["data", data]);
	}

	override handleComment(data: string): void {
		this.events.push(["comment", data]);
	}

	override handleDecl(decl: string): void {
		this.events.push(["decl", decl]);
	}

	override handlePi(data: string): void {
		this.events.push(["pi", data]);
	}

	override unknownDecl(data: string): void {
		this.events.push(["unknown_decl", data]);
	}
}

function events(content: string): Event[] {
	const parser = new Events();
	parser.feed(content);
	parser.close();
	return parser.events;
}

/** The code points (outside the surrogates) a one-character expression matches, as ranges. */
function ranges(pattern: RegExp): number[][] {
	const found: number[][] = [];
	for (let point = 0; point <= 0x10ffff; point++) {
		if (point >= 0xd800 && point <= 0xdfff) continue;
		if (!pattern.test(String.fromCodePoint(point))) continue;
		const last = found[found.length - 1];
		if (last !== undefined && last[1] === point - 1) last[1] = point;
		else found.push([point, point]);
	}
	return found;
}

describe("against today's Python (vectors.json)", () => {
	test("HTMLParser's events for every document", () => {
		const mismatches = vectors.html.filter((vector) => JSON.stringify(events(vector.html)) !== JSON.stringify(vector.events));
		expect(mismatches.map((vector) => ({ html: vector.html, python: vector.events, port: events(vector.html) }))).toEqual([]);
		expect(vectors.html.length).toBeGreaterThan(300);
	});

	test("the text agents are shown for every document", () => {
		const mismatches = vectors.html.filter((vector) => read(vector.html) !== vector.read);
		expect(mismatches.map((vector) => ({ html: vector.html, python: vector.read, port: read(vector.html) }))).toEqual([]);
	});

	test.each(vectors.redact)("redact $text", ({ text, shown }) => {
		expect(redact(text)).toBe(shown);
	});

	test.each(vectors.written)("written $text", (vector) => {
		expect(written(vector.text)).toBe(vector.html);
	});

	test.each(vectors.checked)("check_written $text", (vector) => {
		if ("error" in vector) expect(() => checkWritten(vector.text)).toThrow(vector.error);
		else expect(checkWritten(vector.text)).toBe(vector.ok);
	});

	test("updated_after and the time it searches from", () => {
		const mismatches = vectors.since.filter((vector) => {
			const problem = sinceProblem(vector.value);
			if ("error" in vector) return problem !== vector.error;
			return problem !== null || sinceTimestamp(vector.value) !== vector.timestamp;
		});
		expect(mismatches.map((vector) => ({ ...vector, port: sinceProblem(vector.value) ?? sinceTimestamp(vector.value) }))).toEqual([]);
		expect(vectors.since.filter((vector) => "timestamp" in vector).length).toBeGreaterThan(60);
	});

	test.each(vectors.iso)("iso $timestamp", ({ timestamp, iso: shown }) => {
		expect(iso(timestamp)).toBe(shown);
	});

	test.each(vectors.classify)("classify $status $hex", (vector) => {
		// ProviderHTTP hands classify the body as text, with invalid UTF-8 replaced.
		const body = fromUtf8(fromHex(vector.hex));
		const response = new Response(body, { status: vector.status });
		if ("raises" in vector) {
			expect(() => classify("Intercom", response, body)).toThrow(TypeError);
			return;
		}
		const named = classify("Intercom", response, body);
		expect(named === null ? null : { code: named.code, message: named.message }).toEqual(vector.named);
	});

	const operations = new Map(intercom.operations.map((op): [string, Operation<never>] => [op.name, op]));
	const inputs = Object.entries(vectors.inputs).flatMap(([name, cases]) => cases.map((vector) => ({ name, ...vector })));
	test.each(inputs)("$name input $json", async (vector) => {
		const op = operations.get(vector.name) as Operation<never>;
		const result = await validateInput(op.input as never, parseJson(vector.json));
		if ("message" in vector) expect(result).toEqual({ ok: false, message: vector.message });
		else expect(result).toEqual({ ok: true, data: vector.data });
	});

	test.each(vectors.lax.int)("a response's int $value", (vector) => {
		const read = laxInt().nullable().default(null).safeParse(vector.value);
		// Beyond 2^53 the port refuses what Pydantic reads: JavaScript would round it.
		const unsafe = "ok" in vector && typeof vector.ok === "number" && !Number.isSafeInteger(vector.ok);
		if ("refused" in vector || unsafe) expect(read.success).toBe(false);
		else expect(read.data).toBe(vector.ok);
	});

	test.each(vectors.lax.bool)("a response's bool $value", (vector) => {
		const read = laxBool().default(false).safeParse(vector.value);
		if ("refused" in vector) expect(read.success).toBe(false);
		else expect(read.data).toBe(vector.ok);
	});

	test("re's \\s and \\w", () => {
		expect(ranges(new RegExp(`^[${RE_SPACE}]$`, "u"))).toEqual(vectors.classes.space);
		expect(ranges(new RegExp(`^[${RE_WORD}]$`, "u"))).toEqual(vectors.classes.word);
	});

	test("IGNORECASE letters beyond ASCII", () => {
		const nonAscii = (pattern: RegExp) => ranges(pattern).filter(([, last]) => (last as number) > 0x7f);
		const ignorecase = vectors.classes.ignorecase as { [pattern: string]: number[][] };
		expect(nonAscii(new RegExp(`^[a-z${RE_LETTERS_EXTRA}]$`, "iu"))).toEqual(ignorecase["[a-z]"]);
		expect(nonAscii(new RegExp(`^[a-z0-9${RE_LETTERS_EXTRA}-]$`, "iu"))).toEqual(ignorecase["[a-z0-9-]"]);
		expect(nonAscii(new RegExp(`^${RE_I}$`, "iu"))).toEqual(ignorecase.i);
		for (const letter of "ntercomhpsal") expect(nonAscii(new RegExp(`^${letter}$`, "iu"))).toEqual(ignorecase[letter]);
	});

	test("str.casefold of every code point", () => {
		const expected = folds as { [point: string]: string };
		const mismatches: string[] = [];
		for (let point = 0; point <= 0x10ffff; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const char = String.fromCodePoint(point);
			const want = expected[point.toString(16)];
			const folded = want === undefined ? char : String.fromCodePoint(...want.split(" ").map((part) => Number.parseInt(part, 16)));
			if (casefold(char) !== folded) mismatches.push(point.toString(16));
		}
		expect(mismatches).toEqual([]);
	});
});

describe("text (test_intercom.py)", () => {
	test("HTML is read as text without links to Intercom", () => {
		expect(read('<a href="https://www.intercom.com/x">a <b>label</b></a> after')).toBe("[Intercom link] after");
		expect(read('<a href="https://example.com" href="https://app.intercom.com">x</a>')).toBe("[Intercom link]");
		expect(read('<a href="https://intercom-attachments-1.com/f">f</a>')).toBe("[Intercom link]");
		expect(read("<p>one</p><ul><li>two</li><li>three</li></ul>")).toBe("one\n- two\n- three");
		expect(read("<p>see app.intercom.com/a/x</p>")).toBe("see [Intercom link]");
		expect(read(`<p>open</p><script>${SECRET}`)).toBe("open");
		expect(read(`<svg><svg></svg>${SECRET}</svg>shown`)).toBe("shown");
		expect(read('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
		for (const host of ["intercomassets.com", "static.intercomassets.eu", "x.intercomcdn.eu", "intercomusercontent.com", "intercom-attachments.eu"]) {
			expect(read(`<a href="https://${host}/f">${SECRET}</a>`)).toBe("[Intercom link]");
		}
		// Relative links resolve against Intercom's own pages.
		for (const href of ["/a/inbox/abc123/conversation/101", "conversation/101", "//app.intercom.com/x", "java\tscript:x"]) {
			expect(read(`<a href="${href}">${SECRET}</a>`)).toBe("[Intercom link]");
		}
		expect(read(`<a href="mailto:a@example.com">${SECRET}</a>`)).not.toBe("[Intercom link]");
		expect(read(`<a href="">${SECRET}</a>`)).toBe("[Intercom link]");
		expect(read(`<a href>${SECRET}</a>`)).toBe("[Intercom link]");
		expect(read("<a>plain</a>")).toBe("plain");
		expect(read(null)).toBe("");
		expect(written("a & b\r\n\r\n\r\nc")).toBe("<p>a &amp; b</p><p>c</p>");
	});

	test("a large document is read in time", () => {
		// The expressions are Python's; a 4 MB body of unclosed attributes must not backtrack for long.
		const started = performance.now();
		read(`<p ${"a=b ".repeat(200_000)}`);
		read(`<a href="https://example.com">${"x<b>y</b>".repeat(100_000)}`);
		read("<".repeat(500_000));
		expect(performance.now() - started).toBeLessThan(10_000);
	});
});

describe("nested links", () => {
	// Python's answers (intercom/html.py `read`, which teams/html.py shares for these).
	const H = "https://example.com/";
	const cases: [string, string][] = [
		[`<a href="${H}"><a href="${H}"><a href="${H}"> x </a></a></a>`, `x (${H}) (${H}) (${H})`],
		[`<a href="${H}"><a href="${H}"><a href="${H}">${H}</a></a></a>`, H],
		[`<a href="${H}"><a href="${H}"><a href="${H}"> </a> \n </a></a>`, H],
		[`<a href=" ${H} ">a<a href="${H}b">  b <b>c</b>  </a>  </a>tail`, `ab c (${H}b) ( ${H} )tail`],
		[`<a href="${H}"><a href="${H}">x</a> y <a href="${H}">z</a></a><p>after`, `x (${H}) y z (${H}) (${H})\nafter`],
		[`<a href="${H}"><a href="${H}">x</a>`, `x (${H})`],
		[`<a href="">  </a>q<a href="${H}"> </a>`, `[Intercom link]q${H}`],
	];
	test("read as Python reads them", () => {
		for (const [html, text] of cases) expect(read(html), html).toBe(text);
	});

	test("links nested a hundred thousand deep are read in about linear time", () => {
		// Before: each closing link joined its whole label again, so the text was copied once per level
		// (60,000 levels, about 2 MB, took seconds).
		const depth = 100_000;
		const started = performance.now();
		const text = read(`${`<a href="${H}">`.repeat(depth)}x${"</a>".repeat(depth)}`);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(text === `x${` (${H})`.repeat(depth)}`).toBe(true);
		expect(read(`${`<a href="${H}">`.repeat(depth)}${H}${"</a>".repeat(depth)}`)).toBe(H);
	});
});
