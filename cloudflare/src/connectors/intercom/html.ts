// Message text as agents see it and write it (backend/connectors/intercom/html.py).
//
// Intercom stores messages as HTML. Read text is the HTML turned into plain text:
// - a link to Intercom (the app, the API, its file hosts or help centers), or a relative one, which Intercom
//   shows on its own host, shows as "[Intercom link]", label included, since a label can name another
//   conversation; so does an address to Intercom in the text itself;
// - images show as "[image]"; scripts, styles and other elements that are not text are left out, with what is
//   inside them;
// - other links show as "label (address)".
// An element left out that is never closed hides the rest of the message rather than letting it through.
//
// Written text is escaped and sent as HTML paragraphs, so it is shown literally: it cannot format anything or
// mention a teammate. It may not address Intercom in any encoding.
//
// The HTML is read with a port of Python's HTMLParser (lib/htmlparser.ts), so the text is today's.

import { decoded, plainText, PYTHON_SPACE_CLASS, pythonRstrip, pythonStrip, TextError } from "../../lib/text.ts";
import { type Attribute, HTMLParser } from "../../lib/htmlparser.ts";
import { endsWithNewline, linkText, type Piece, written as writtenOut } from "../../lib/linktext.ts";
import { RE_I, RE_LETTERS_EXTRA } from "./python.ts";

// Intercom's hosts: the app and API, file hosts (intercomcdn, intercomassets, intercomusercontent,
// intercom-attachments) and help centers, in every region. Other hosts that start with "intercom" are hidden
// too. IGNORECASE as `re` reads it (python.ts).
const INTERCOM = new RegExp(`${RE_I}ntercom[a-z0-9${RE_LETTERS_EXTRA}-]*\\.[a-z${RE_LETTERS_EXTRA}]{2}|${RE_I}ntercom:`, "iu");
// Links shown with their address. Others, relative ones included (Intercom shows them on its own host), are hidden.
const SHOWN_LINK = new RegExp(`^(?:https?://|ma${RE_I}lto:|tel:)`, "iu");
const WORD = new RegExp(`[^${PYTHON_SPACE_CLASS}]+`, "gu");
const BLOCKS: ReadonlySet<string> = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "ul", "ol", "table", "li", "blockquote"]);
const DROPPED: ReadonlySet<string> = new Set(["script", "style", "head", "title", "template", "iframe", "object", "embed", "svg", "math", "noscript"]);
export const LINK = "[Intercom link]";
export const NOT_INTERCOM = "must not link to Intercom";
const PARAGRAPHS = new RegExp(`\\n[${PYTHON_SPACE_CLASS}]*\\n`, "u");

/** Whether `text` addresses Intercom in any encoding; browsers drop tabs and newlines inside addresses. */
export function toIntercom(text: string): boolean {
	return INTERCOM.test(decoded(text).replace(/[\t\n\r]/g, ""));
}

/** Plain text with every word that addresses Intercom replaced. */
export function redact(text: string): string {
	return text.replace(WORD, (word) => (toIntercom(word) ? LINK : word));
}

type Link = [href: string, label: Piece[]];

/** html.py `_Reader`. */
class Reader extends HTMLParser {
	readonly out: Piece[] = [];
	/** A link being read: its address and the text of its label. */
	readonly links: Link[] = [];
	/** The element whose content is dropped, and how deep the same element nests inside it. */
	hidden: [tag: string, depth: number] | null = null;

	#target(): Piece[] {
		const link = this.links[this.links.length - 1];
		return link === undefined ? this.out : link[1];
	}

	#emit(text: Piece): void {
		if (text.length) this.#target().push(text);
	}

	#hide(tag: string, replacement: string): void {
		this.#emit(replacement);
		this.hidden = [tag, 1];
	}

	#newline(): void {
		const target = this.#target();
		const last = target[target.length - 1];
		if (last !== undefined && !endsWithNewline(last)) target.push("\n");
	}

	override handleStartTag(tag: string, attrs: Attribute[]): void {
		if (this.hidden !== null) {
			const [name, depth] = this.hidden;
			if (tag === name) this.hidden = [name, depth + 1];
			return;
		}
		// A dict of the attributes: the last of repeated ones wins.
		const values = new Map<string, string>(attrs.map(([name, value]) => [name, value || ""]));
		if (DROPPED.has(tag)) this.#hide(tag, "");
		else if (tag === "a") {
			const href = values.get("href") || "";
			const address = decoded(href).replace(/[\u0000- ]/g, "");
			// Readers disagree on which of repeated attributes counts. An empty href is the page itself.
			const linked = values.has("href");
			if (values.size !== attrs.length || toIntercom(href) || (linked && !SHOWN_LINK.test(address))) this.#hide(tag, LINK);
			else this.links.push([href, []]);
		} else if (tag === "img") this.#emit("[image]");
		else if (tag === "br") this.#emit("\n");
		else if (tag === "li") {
			this.#newline();
			this.#emit("- ");
		} else if (BLOCKS.has(tag)) this.#newline();
	}

	override handleStartEndTag(tag: string, attrs: Attribute[]): void {
		// Browsers ignore the slash on elements that are not void, so `<script/>` stays open.
		this.handleStartTag(tag, attrs);
	}

	override handleEndTag(tag: string): void {
		if (this.hidden !== null) {
			const [name, depth] = this.hidden;
			if (tag === name) this.hidden = depth > 1 ? [name, depth - 1] : null;
			return;
		}
		const link = tag === "a" ? this.links.pop() : undefined;
		if (link !== undefined) {
			// Built from its pieces (lib/linktext.ts): joining each label anew copied nested links' text once per level.
			const [href, label] = link;
			this.#emit(linkText(label, href));
		} else if (tag === "td" || tag === "th") this.#emit("\t");
		else if (BLOCKS.has(tag)) this.#newline();
	}

	override handleData(data: string): void {
		if (this.hidden === null) this.#emit(data);
	}

	text(): string {
		// A link never closed is shown as text, without its address.
		for (let at = this.links.length - 1; at >= 0; at--) for (const text of (this.links[at] as Link)[1]) this.out.push(text);
		const lines = writtenOut(this.out).replaceAll(" ", " ").split("\n");
		const joined = lines.map(pythonRstrip).join("\n");
		return redact(pythonStrip(joined.replace(/\n{3,}/g, "\n\n")));
	}
}

/** The text an agent is shown. */
export function read(content: string | null | undefined): string {
	if (!content) return "";
	const reader = new Reader();
	reader.run(content);
	return reader.text();
}

/** Refuses text that would do more than add words to a conversation; null when it is allowed. */
export function writtenProblem(text: string): string | null {
	try {
		plainText(text);
	} catch (error) {
		if (error instanceof TextError) return error.message;
		throw error;
	}
	return toIntercom(text) ? NOT_INTERCOM : null;
}

/** html.py `check_written`: the text, or a TextError with the reason it is refused. Used as a field validator. */
export function checkWritten(text: string): string {
	const problem = writtenProblem(text);
	if (problem !== null) throw new TextError(problem);
	return text;
}

/** Python's `html.escape(text)`, quotes included. */
function escape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** The HTML that shows `text` literally: a paragraph per blank-line-separated block. */
export function written(text: string): string {
	const blocks = pythonStrip(text.replaceAll("\r\n", "\n")).split(PARAGRAPHS);
	return blocks
		.filter((block) => pythonStrip(block))
		.map((block) => `<p>${escape(block).replaceAll("\n", "<br>")}</p>`)
		.join("");
}
