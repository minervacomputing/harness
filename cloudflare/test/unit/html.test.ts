// lib/html.ts: the tokens readers build on, and the time hostile markup takes.

import { describe, expect, test } from "vitest";
import { type Attribute, tokenize } from "../../src/lib/html.ts";

/** The tokens of `html`, written out: <tag a="v"/>, </tag> and "text". */
function tokens(html: string): string[] {
	const seen: string[] = [];
	tokenize(html, {
		start: (tag: string, attributes: Attribute[], selfClosing: boolean) =>
			void seen.push(`<${tag}${attributes.map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join("")}${selfClosing ? "/" : ""}>`),
		end: (tag: string) => void seen.push(`</${tag}>`),
		text: (data: string) => void seen.push(JSON.stringify(data)),
	});
	return seen;
}

describe("tokens", () => {
	test("tags, attributes and text, with names lowercased in ASCII only", () => {
		expect(tokens('<A HREF="x" Title=y checked>one &amp; two</A>')).toEqual(['<a href="x" title="y" checked="">', '"one & two"', "</a>"]);
		expect(tokens("<a\nhref='x'\n>y</a\n>")).toEqual(['<a href="x">', '"y"', "</a>"]);
		expect(tokens("<blockquote>x</blocKquote>")).toEqual(["<blockquote>", '"x"', "</blocKquote>"]);
		expect(tokens('<a href="1" href="2"/>')).toEqual(['<a href="1" href="2"/>']);
	});

	test("nothing is inferred: no implied or void end tags", () => {
		expect(tokens("<a>1<a>2<p>3<br>")).toEqual(["<a>", '"1"', "<a>", '"2"', "<p>", '"3"', "<br>"]);
	});

	test("comments, CDATA, doctypes and processing instructions are dropped with their content", () => {
		expect(tokens("a<!-- <at id=1>x</at> -->b<![CDATA[x]]>c<!doctype html>d<?php e ?>f<!x>g")).toEqual(['"abcdfg"']);
		expect(tokens("a<!-- <at>x --!>b<!-->c")).toEqual(['"abc"']);
	});

	test("where browsers read the markup differently, the document ends", () => {
		// Browsers end "<![CDATA[" at the first ">" outside SVG and MathML.
		expect(tokens("a<![CDATA[><blockquote>]]>b")).toEqual(['"a"']);
		// They read a quoted ">" in an end tag as part of it.
		expect(tokens('a</p x="><b>">b')).toEqual(['"a"']);
		// "</script>" does not end a script in its double-escaped state.
		expect(tokens("<script><!--<script></script>x</script>b")).toEqual(["<script>", '"<!--<script>"']);
		expect(tokens("<script><!-- <script> --></script>b")).toEqual(["<script>", '"<!-- <script> -->"', "</script>", '"b"']);
		expect(tokens("<script><!--><script></script>b")).toEqual(["<script>", '"<!--><script>"', "</script>", '"b"']);
	});

	test("raw text runs to its own end tag, in any case, and to the end of the document if that is missing", () => {
		expect(tokens("<SCRIPT><at>x</at></script >y")).toEqual(["<script>", '"<at>x</at>"', "</script>", '"y"']);
		expect(tokens("<script/><b>x</b></script>y")).toEqual(["<script/>", '"<b>x</b>"', "</script>", '"y"']);
		expect(tokens("<style>a</style")).toEqual(["<style>", '"a</style"']);
		expect(tokens("<title>&lt;b&gt;</title>")).toEqual(["<title>", '"<b>"', "</title>"]);
	});

	test("a tag the document ends inside is dropped", () => {
		for (const cut of ['<a href="y', "<at id=1", "<a/", "<a /", "<scr", "<script", "</at", "</at ", "</at/", "</at x"]) {
			expect(tokens(`x${cut}`), cut).toEqual(['"x"']);
		}
		expect(tokens("x<")).toEqual(['"x<"']);
		expect(tokens("x</")).toEqual(['"x</"']);
	});

	test("references in attribute values are decoded as the standard decodes them there", () => {
		const href = (value: string): string => {
			let found = "";
			tokenize(`<a href="${value}">`, { start: (_, attributes) => void (found = attributes[0]?.[1] ?? ""), end() {}, text() {} });
			return found;
		};
		expect(href("&#x6a;avascript:x")).toBe("javascript:x");
		expect(href("?a=1&amp;b=2&copy=3&notin;")).toBe("?a=1&b=2&copy=3∉");
		expect(href("&amp")).toBe("&");
		expect(href("&ampx")).toBe("&ampx");
		expect(href("&#0;&#xd800;&#128;")).toBe("��€");
	});
});

const N = 200_000;
const SHAPES: [name: string, document: string][] = [
	["a closed tag with many attributes", `<a ${"x= ".repeat(N)}>`],
	["a tag with a quote that never closes", `<a x="${"a ".repeat(N)}`],
	["a tag that never closes", `<a ${"x=".repeat(N)}`],
	["an end tag with many attributes", `</a ${"x= ".repeat(N)}>`],
	["an end tag that never closes", `</a ${"x= ".repeat(N)}`],
	["a title with near end tags", `<title>${"x</titleX".repeat(N)}</title>`],
	["a script with partial end tags", `<script>${"</scr".repeat(N)}`],
	["a script with longer end tag names", `<script>${"</scripts ".repeat(N)}</script>`],
	["a textarea that never closes", `<textarea>${"&amp;<".repeat(N)}`],
	["plaintext", `<plaintext>${"<a>&amp;".repeat(N)}`],
	["a comment that never closes", `<!--${"-- ".repeat(N)}`],
	["a comment of dashes and bangs", `<!--${"--!".repeat(N)}`],
	["CDATA that never closes", `<![CDATA[${"]]".repeat(N)}`],
	["a processing instruction", `<?${"x".repeat(N)}`],
	["a declaration", `<!doctype ${"x".repeat(N)}`],
	["a character reference cut by the end", `&${"a".repeat(N)}`],
	["many character references cut by the end", "&amp".repeat(N)],
	["text with ampersands", `${"a & b ".repeat(N)}&`],
	["angle brackets", "<".repeat(N)],
	["end tag openers", "</".repeat(N)],
	["declaration openers", "<!".repeat(N)],
	["many unclosed quotes", "<a b='".repeat(N)],
	["many tags", "<a b=c>".repeat(N)],
	["many end tags", "</a>".repeat(N)],
];

describe("hostile markup is tokenized in about linear time", () => {
	test.each(SHAPES)("%s", (_, document) => {
		let seen = 0;
		const started = performance.now();
		tokenize(document, {
			start: (tag) => void (seen += tag.length),
			end: (tag) => void (seen += tag.length),
			text: (data) => void (seen += data.length),
		});
		expect(performance.now() - started).toBeLessThan(3000);
	});
});
