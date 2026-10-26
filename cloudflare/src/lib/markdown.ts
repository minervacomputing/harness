// Readable text from HTML, in a Markdown-like form, for Gmail's HTML parts and Google Calendar's descriptions.
// Both are hostile input. Scripts, styles, frames, forms and navigation are dropped with what is inside them.
// Links keep absolute http(s) targets; images keep only their alt text, so the conversation never gains a
// remote image that could carry data out when shown.

import { type Attribute, type Tokens, tokenize } from "./html.ts";

const SPACES = /\s+/g;

const SKIPPED = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"iframe",
	"noembed",
	"noframes",
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
	"title",
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
	return text.replace(SPACES, " ").trim();
}

/** `href`, if it is an absolute http(s) address, made safe for a Markdown link; else null. */
function link(href: string | undefined): string | null {
	if (!href) return null;
	const url = URL.parse(href.trim());
	if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.href.length > MAX_LINK) return null;
	// Parentheses would end the Markdown link; the parser has encoded spaces already.
	return url.href.replaceAll("(", "%28").replaceAll(")", "%29");
}

/** Elements whose "/>" browsers honour (foreign content); on others the slash is ignored. */
const SELF_CLOSING = new Set(["svg", "math"]);

class Converter implements Tokens {
	readonly out: string[] = [];
	private readonly skip: string[] = [];
	private readonly skipOpen = new Map<string, number>([...SKIPPED].map((tag) => [tag, 0]));
	private readonly lists: [ordered: boolean, counter: number][] = [];
	private pre = 0;
	readonly links: [start: number, href: string | null][] = [];

	/** Ends the line, with at least `count` line breaks in a row. */
	private newline(count = 1): void {
		const tail = this.out.slice(-6).join("").replace(/ +$/, "");
		const have = tail.trim() ? tail.length - tail.replace(/\n+$/, "").length : count;
		if (have < count) this.out.push("\n".repeat(count - have));
	}

	private gap(tag: string): number {
		if (tag === "ul" || tag === "ol") return this.lists.length ? 1 : 2;
		return ["p", "table", "blockquote", "pre"].includes(tag) ? 2 : 1;
	}

	start(tag: string, attrs: Attribute[], selfClosing: boolean): void {
		this.open(tag, attrs);
		if (selfClosing && SELF_CLOSING.has(tag)) this.end(tag);
	}

	private open(tag: string, attrs: Attribute[]): void {
		if (SKIPPED.has(tag)) {
			if (!VOID.has(tag)) {
				this.skip.push(tag);
				this.skipOpen.set(tag, (this.skipOpen.get(tag) ?? 0) + 1);
			}
			return;
		}
		if (this.skip.length) return;
		// The first of repeated attributes counts, as in browsers.
		const values = new Map<string, string>();
		for (const [name, value] of attrs) if (!values.has(name)) values.set(name, value);
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
			const alt = (values.get("alt") || "").trim();
			if (alt) this.out.push(`[image: ${squash(alt)}]`);
		} else if (tag === "a") {
			// Links do not nest: a new one closes the open one, as browsers do.
			if (this.links.length) this.closeLink();
			this.links.push([this.out.length, link(values.get("href"))]);
		}
	}

	end(tag: string): void {
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
		// A link whose text is its own address is shown once.
		if (href && text && link(text) !== href) this.out.push(`[${text}](${href})`);
		else this.out.push(text);
	}

	text(data: string): void {
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

const LIST_ITEM = /^\s*([-*]|\d+\.) /u;

function tidy(text: string): string {
	const cleaned: string[] = [];
	let code = false;
	for (const raw of text.split("\n")) {
		let line = raw.trimEnd();
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
	return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string): string {
	const converter = new Converter();
	tokenize(html, converter);
	// A link still open when the page ended, even inside an unclosed script.
	if (converter.links.length) converter.closeLink();
	return tidy(converter.out.join(""));
}
