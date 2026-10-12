// lib/htmlparser.ts, the port of Python's HTMLParser: its events are compared with Python's for every
// document of test/fixtures/connectors/intercom/vectors.json (connectors-intercom-text.test.ts). Here, the
// time it takes on markup built to make a parser rescan its input: the expressions are Python's, which
// can backtrack, and a page is the attacker's. Each takes about 10 to 100 ms; a quadratic parser would
// take a minute.

import { describe, expect, test } from "vitest";
import { HTMLParser } from "../../src/lib/htmlparser.ts";

/** A parser that does what a reader does with every event: look at it. */
class Reading extends HTMLParser {
	seen = 0;
	override handleStartTag(tag: string): void {
		this.seen += tag.length;
	}
	override handleEndTag(tag: string): void {
		this.seen += tag.length;
	}
	override handleData(data: string): void {
		this.seen += data.length;
	}
	override handleComment(data: string): void {
		this.seen += data.length;
	}
}

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
		const started = performance.now();
		new Reading().run(document);
		expect(performance.now() - started).toBeLessThan(3000);
	});
});
