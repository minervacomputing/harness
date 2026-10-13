// The tokens of an HTML document, read with htmlparser2's tokenizer (the HTML standard's tokenization states),
// without building a tree. Callers get start tags with their attributes, end tags and text; comments, CDATA,
// doctypes and processing instructions are dropped with what is inside them. Character references are decoded
// as the standard decodes them in text and in attribute values. The content of script, style, title,
// textarea, xmp, iframe, noembed, noframes and plaintext is text up to its own end tag. Tag and attribute
// names are lowercased in ASCII only, as browsers do, so an end tag that spells its "k" with the Kelvin sign
// does not end a blockquote.
//
// Nothing is inferred: no end tag is implied, no element is void and a "/" before ">" is only reported. The
// callers' policies decide what an element that is never closed, or written self-closing, hides (`Hidden`).
// A tag the document ends inside is dropped, end tags included.
//
// Where browsers read the markup differently from the tokenizer, the document ends there, so that nothing
// they read as part of an element a caller hides can come out as text:
// - an end tag holding a quote: browsers read attributes in end tags, so a quoted ">" does not end one, while
//   the tokenizer ends it at the first ">";
// - CDATA holding a ">": outside SVG and MathML, browsers read "<![CDATA[" as a comment that ends there;
// - a script whose text leaves browsers in its double-escaped state ("<!--", then "<script"), where
//   "</script>" does not end it.
//
// The tokenizer is a single pass over the text, so hostile markup takes linear time.

import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";

/** An attribute's name and value; an attribute written without a value has "". */
export type Attribute = [name: string, value: string];

export interface Tokens {
	/** A start tag; `selfClosing` when it ends in "/>". */
	start(tag: string, attributes: Attribute[], selfClosing: boolean): void;
	end(tag: string): void;
	/** Text, decoded; adjacent text arrives in one call. */
	text(data: string): void;
}

const lower = (name: string): string => name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/** Whether browsers are still inside a script whose text, up to a "</script>", is `text`. */
function doubleEscaped(text: string): boolean {
	let state: "data" | "escaped" | "double" = "data";
	for (const [found] of text.matchAll(/<!--(?:-*>)?|-->|<script[\t\n\f\r />]/gi)) {
		if (found.startsWith("<!--")) {
			if (found.endsWith(">")) state = "data";
			else if (state === "data") state = "escaped";
		} else if (found === "-->") state = "data";
		else if (state === "escaped") state = "double";
	}
	return state === "double";
}

/** Calls `tokens` for each tag and run of text of `html`, in order. */
export function tokenize(html: string, tokens: Tokens): void {
	let text: string[] = [];
	let tag = "";
	let attributes: Attribute[] = [];
	let name = "";
	let value = "";
	/** Where the text of an open script starts, or -1. */
	let script = -1;
	let stopped = false;
	const flush = (): void => {
		if (text.length === 0) return;
		const data = text.join("");
		text = [];
		if (data) tokens.text(data);
	};
	const stop = (): void => {
		stopped = true;
		tokenizer.pause();
	};
	const startTag = (end: number, selfClosing: boolean): void => {
		flush();
		const [opened, attrs] = [tag, attributes];
		attributes = [];
		if (opened === "script") script = end + 1;
		tokens.start(opened, attrs, selfClosing);
	};
	const callbacks: TokenizerCallbacks = {
		ontext: (start, end) => {
			// At the end of the input the tokenizer reports what is left of a tag it was inside (a start tag's
			// name, or -1 for the rest of a tag) as text; that tag is dropped instead.
			if (start < 0 || (html[start - 1] === "<" && /[A-Za-z]/.test(html[start] ?? ""))) return;
			text.push(html.slice(start, end));
		},
		ontextentity: (point) => void text.push(String.fromCodePoint(point)),
		onopentagname: (start, end) => {
			tag = lower(html.slice(start, end));
			attributes = [];
		},
		onattribname: (start, end) => {
			name = lower(html.slice(start, end));
			value = "";
		},
		onattribdata: (start, end) => {
			value += html.slice(start, end);
		},
		onattribentity: (point) => {
			value += String.fromCodePoint(point);
		},
		onattribend: () => void attributes.push([name, value]),
		onopentagend: (end) => startTag(end, false),
		onselfclosingtag: (end) => startTag(end, true),
		onclosetag: (start, end) => {
			flush();
			const close = html.indexOf(">", end);
			const closed = lower(html.slice(start, end));
			if (close < 0 || /["']/.test(html.slice(end, close))) return stop();
			if (closed === "script" && script >= 0 && doubleEscaped(html.slice(script, start - 2))) return stop();
			script = -1;
			tokens.end(closed);
		},
		oncomment: () => {},
		oncdata: (start, end, offset) => {
			if (html.slice(start, end - offset).includes(">")) stop();
		},
		ondeclaration: () => {},
		onprocessinginstruction: () => {},
		onend: flush,
	};
	const tokenizer = new Tokenizer({ decodeEntities: true }, callbacks);
	tokenizer.write(html);
	if (!stopped) tokenizer.end();
	flush();
}

const VOID: ReadonlySet<string> = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * An element a reader hides, with what is open inside it. Only its own end tag ends it, and only once every
 * element opened inside has been closed in order; an end tag that does not close the innermost one is ignored.
 * Browsers ignore some end tags (a blockquote's inside a table, a mention's inside a div), so a misnested or
 * unclosed element inside hides the rest of the document rather than ending the hidden element early.
 */
export class Hidden {
	readonly tag: string;
	readonly #inside: string[] = [];

	constructor(tag: string) {
		this.tag = tag;
	}

	start(tag: string): void {
		if (!VOID.has(tag)) this.#inside.push(tag);
	}

	/** Whether the end tag ends the hidden element. */
	end(tag: string): boolean {
		if (this.#inside.length === 0) return tag === this.tag;
		if (this.#inside[this.#inside.length - 1] === tag) this.#inside.pop();
		return false;
	}
}
