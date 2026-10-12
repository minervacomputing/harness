// Readable text from HTML, in a Markdown-like form: backend/connectors/web/markdown.py's `html_to_text`,
// for the Web connector's pages and Gmail's HTML parts (which convert with no base address, so a link is
// its href as written). Built on Python's html.parser.HTMLParser (3.14, lib/htmlparser.ts), since pages are
// hostile input. Scripts, styles, frames, forms and navigation are dropped. Links keep absolute http(s)
// targets; images keep only their alt text, so the conversation never gains a remote image that could
// carry data out when shown. Moved here from connectors/gmail/html.ts.

import { DIGIT_CLASS } from "./digits.ts";
import { type Attribute, HTMLParser } from "./htmlparser.ts";
import { PYTHON_SPACE_CLASS, codePointLength, pythonRstrip, pythonStrip } from "./text.ts";
import { urljoin, urlsplit } from "./urlsplit.ts";

const SPACES = new RegExp(`[${PYTHON_SPACE_CLASS}]+`, "g");

const SKIPPED = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"iframe",
	"object",
	"embed",
	"canvas",
	"nav",
	"footer",
	"select",
	"button",
	"textarea",
	"dialog",
	"audio",
	"video",
	"picture",
]);
const BLOCKS = new Set([
	"p",
	"div",
	"section",
	"article",
	"main",
	"header",
	"aside",
	"ul",
	"ol",
	"li",
	"table",
	"tr",
	"blockquote",
	"pre",
	"dl",
	"dt",
	"dd",
	"figure",
	"figcaption",
	"form",
	"fieldset",
	"details",
	"summary",
	"address",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"br",
]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const MAX_LINK = 500;
const MAX_DEPTH = 20;

function squash(text: string): string {
	return pythonStrip(text.replace(SPACES, " "));
}

/** `_link(base_url, href)`: an absolute http(s) address, made safe for a Markdown link, or null. */
function link(baseUrl: string, href: string | null | undefined): string | null {
	if (!href) return null;
	let absolute: string;
	try {
		absolute = urljoin(baseUrl, pythonStrip(href));
	} catch {
		// urljoin's ValueError: a malformed address.
		return null;
	}
	const parts = urlsplit(absolute);
	if (parts === null || (parts.scheme !== "http" && parts.scheme !== "https") || codePointLength(absolute) > MAX_LINK) return null;
	// Brackets and spaces would break the Markdown link.
	return absolute.replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29");
}

class Converter extends HTMLParser {
	readonly baseUrl: string;
	readonly out: string[] = [];
	private readonly skip: string[] = [];
	private readonly skipOpen = new Map<string, number>([...SKIPPED].map((tag) => [tag, 0]));
	private readonly lists: [ordered: boolean, counter: number][] = [];
	private pre = 0;
	readonly links: [start: number, href: string | null][] = [];
	readonly title: string[] = [];
	private inTitle = false;

	constructor(baseUrl: string) {
		super();
		this.baseUrl = baseUrl;
	}

	/** Ends the line, with at least `count` line breaks in a row. */
	private newline(count = 1): void {
		const tail = this.out.slice(-6).join("").replace(/ +$/, "");
		const have = pythonStrip(tail) ? tail.length - tail.replace(/\n+$/, "").length : count;
		if (have < count) this.out.push("\n".repeat(count - have));
	}

	private gap(tag: string): number {
		if (tag === "ul" || tag === "ol") return this.lists.length ? 1 : 2;
		return ["p", "table", "blockquote", "pre"].includes(tag) ? 2 : 1;
	}

	override handleStartTag(tag: string, attrs: Attribute[]): void {
		if (SKIPPED.has(tag)) {
			if (!VOID.has(tag)) {
				this.skip.push(tag);
				this.skipOpen.set(tag, (this.skipOpen.get(tag) ?? 0) + 1);
			}
			return;
		}
		if (this.skip.length) return;
		if (tag === "title") {
			this.inTitle = true;
			return;
		}
		const values = new Map<string, string | null>();
		for (const [name, value] of attrs) values.set(name, value);
		if (BLOCKS.has(tag)) this.newline(this.gap(tag));
		if (tag.length === 2 && tag[0] === "h" && "123456".includes(tag[1] as string)) {
			this.out.push(`${"#".repeat(Number(tag[1]))} `);
		} else if ((tag === "ul" || tag === "ol") && this.lists.length < MAX_DEPTH) {
			this.lists.push([tag === "ol", 0]);
		} else if (tag === "li") {
			const indent = "  ".repeat(Math.max(this.lists.length - 1, 0));
			const last = this.lists[this.lists.length - 1];
			if (last?.[0]) {
				last[1] += 1;
				this.out.push(`${indent}${last[1]}. `);
			} else this.out.push(`${indent}- `);
		} else if (tag === "pre") {
			this.pre += 1;
			this.out.push("```\n");
		} else if (tag === "code" && !this.pre) {
			this.out.push("`");
		} else if (tag === "strong" || tag === "b") {
			this.out.push("**");
		} else if (tag === "em" || tag === "i") {
			this.out.push("*");
		} else if (tag === "blockquote") {
			this.out.push("> ");
		} else if (tag === "td" || tag === "th") {
			this.out.push(" | ");
		} else if (tag === "hr") {
			this.out.push("---\n");
		} else if (tag === "img") {
			const alt = pythonStrip(values.get("alt") || "");
			if (alt) this.out.push(`[image: ${squash(alt)}]`);
		} else if (tag === "a") {
			// Links do not nest: a new one closes the open one, as browsers do.
			if (this.links.length) this.closeLink();
			this.links.push([this.out.length, link(this.baseUrl, values.get("href"))]);
		}
	}

	override handleStartEndTag(tag: string, attrs: Attribute[]): void {
		this.handleStartTag(tag, attrs);
		if (!VOID.has(tag)) this.handleEndTag(tag);
	}

	override handleEndTag(tag: string): void {
		if (this.skip.length) {
			if (this.skipOpen.get(tag)) {
				// Unbalanced markup closes everything opened after the nearest matching tag.
				for (let popped = this.skip.pop(); popped !== tag; popped = this.skip.pop()) {
					this.skipOpen.set(popped as string, (this.skipOpen.get(popped as string) ?? 0) - 1);
				}
				this.skipOpen.set(tag, (this.skipOpen.get(tag) ?? 0) - 1);
			}
			return;
		}
		if (tag === "title") {
			this.inTitle = false;
			return;
		}
		if ((tag === "ul" || tag === "ol") && this.lists.length) this.lists.pop();
		else if (tag === "pre" && this.pre) {
			this.pre -= 1;
			this.out.push("\n```");
		} else if (tag === "code" && !this.pre) this.out.push("`");
		else if (tag === "strong" || tag === "b") this.out.push("**");
		else if (tag === "em" || tag === "i") this.out.push("*");
		else if (tag === "a" && this.links.length) this.closeLink();
		if (BLOCKS.has(tag)) this.newline(this.gap(tag));
	}

	closeLink(): void {
		const [start, href] = this.links.pop() as [number, string | null];
		const text = squash(this.out.slice(start).join(""));
		this.out.splice(start);
		if (href && text && text !== href) this.out.push(`[${text}](${href})`);
		else this.out.push(text);
	}

	override handleData(data: string): void {
		if (this.inTitle) {
			this.title.push(data);
			return;
		}
		if (this.skip.length) return;
		if (this.pre) {
			this.out.push(data);
			return;
		}
		let text = data.replace(SPACES, " ");
		if (!this.out.length || (this.out[this.out.length - 1] as string).endsWith("\n")) text = text.replace(/^ +/, "");
		if (text) this.out.push(text);
	}
}

const LIST_ITEM = new RegExp(`^[${PYTHON_SPACE_CLASS}]*([-*]|${DIGIT_CLASS}+\\.) `, "u");

function tidy(text: string): string {
	const cleaned: string[] = [];
	let code = false;
	for (const raw of text.split("\n")) {
		let line = pythonRstrip(raw);
		if (line.replace(/^ +/, "").startsWith("```")) {
			code = !code;
			cleaned.push(line.replace(/^ +/, ""));
			continue;
		}
		if (code) {
			cleaned.push(line);
			continue;
		}
		const stripped = line.replace(/^ +/, "");
		// Leading spaces left over from collapsed whitespace, except list indentation.
		line = LIST_ITEM.test(line) ? line : stripped;
		if (line.startsWith("| ")) line = line.slice(2);
		cleaned.push(line);
	}
	return pythonStrip(cleaned.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** `html_to_text(html, base_url)`: (text, title). */
export function htmlToText(html: string, baseUrl = ""): [text: string, title: string | null] {
	const converter = new Converter(baseUrl);
	converter.run(html);
	// A link still open when the page ended, even inside an unclosed script.
	if (converter.links.length) converter.closeLink();
	const title = squash(converter.title.join("")) || null;
	return [tidy(converter.out.join("")), title];
}
