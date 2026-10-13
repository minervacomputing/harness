// Message text as agents see it and write it.
//
// Intercom stores messages as HTML. Read text is the HTML turned into plain text:
// - a link to Intercom (the app, the API, its file hosts or help centers), or a relative one, which Intercom
//   shows on its own host, shows as "[Intercom link]", label included, since a label can name another
//   conversation; so does an address to Intercom in the text itself;
// - images show as "[image]"; scripts, styles, elements whose content is raw text (textarea, xmp, ...) and
//   other elements that are not text are left out, with what is inside them;
// - other links show as "label (address)".
// An element left out that is never closed, or has a misnested or unclosed element inside (lib/html.ts's
// `Hidden`), hides the rest of the message rather than letting it through.
//
// Written text is escaped and sent as HTML paragraphs, so it is shown literally: it cannot format anything or
// mention a teammate. It may not address Intercom in any encoding.
//
// The HTML is tokenized by lib/html.ts.

import { browserAddress, decoded, plainText, TextError, WORDS } from "../../lib/text.ts";
import { type Attribute, Hidden, type Tokens, tokenize } from "../../lib/html.ts";
import { endsWithNewline, linkText, type Piece, written as writtenOut } from "../../lib/linktext.ts";

/** "i" and the lookalikes that case folding does not match to it, the dotted capital I and the dotless i. */
const I = "[i\u0130\u0131]";
const LOOKALIKES = "\u0130\u0131";
// Intercom's hosts: the app and API, file hosts (intercomcdn, intercomassets, intercomusercontent,
// intercom-attachments) and help centers, in every region. Other hosts that start with "intercom" are hidden
// too, in any case and with the lookalikes of "i" ("ſ" and the Kelvin sign fold under the `iu` flags).
const INTERCOM = new RegExp(`${I}ntercom[a-z0-9${LOOKALIKES}-]*\\.[a-z${LOOKALIKES}]{2}|${I}ntercom:`, "iu");
// Links shown with their address, by their scheme as a browser reads it (lib/text.ts `browserAddress`): a
// lookalike letter makes a link relative. Others, relative ones included (Intercom shows them on its own
// host), are hidden.
const SHOWN_LINK = /^(?:https?:\/\/|mailto:|tel:)/i;
const BLOCKS: ReadonlySet<string> = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "ul", "ol", "table", "li", "blockquote"]);
const DROPPED: ReadonlySet<string> = new Set([
	"script",
	"style",
	"head",
	"title",
	"template",
	"iframe",
	"object",
	"embed",
	"svg",
	"math",
	"noscript",
	"textarea",
	"xmp",
	"noembed",
	"noframes",
	"plaintext",
]);
export const LINK = "[Intercom link]";
export const NOT_INTERCOM = "must not link to Intercom";
const PARAGRAPHS = /\n\s*\n/u;

/** Whether `text` addresses Intercom in any encoding; browsers drop tabs and newlines inside addresses. */
export function toIntercom(text: string): boolean {
	return INTERCOM.test(decoded(text).replace(/[\t\n\r]/g, ""));
}

/** Plain text with every word that addresses Intercom replaced. */
export function redact(text: string): string {
	return text.replace(WORDS, (word) => (toIntercom(word) ? LINK : word));
}

type Link = [href: string, label: Piece[]];

/** Reads a body's HTML into text and links, leaving out hidden elements. */
class Reader implements Tokens {
	readonly out: Piece[] = [];
	/** A link being read: its address and the text of its label. */
	readonly links: Link[] = [];
	/** The element whose content is dropped. */
	hidden: Hidden | null = null;

	#target(): Piece[] {
		const link = this.links[this.links.length - 1];
		return link === undefined ? this.out : link[1];
	}

	#emit(text: Piece): void {
		if (text.length) this.#target().push(text);
	}

	#hide(tag: string, replacement: string): void {
		this.#emit(replacement);
		this.hidden = new Hidden(tag);
	}

	#newline(): void {
		const target = this.#target();
		const last = target[target.length - 1];
		if (last !== undefined && !endsWithNewline(last)) target.push("\n");
	}

	/** Browsers ignore the slash on elements that are not void, so `<script/>` stays open. */
	start(tag: string, attrs: Attribute[]): void {
		if (this.hidden !== null) {
			this.hidden.start(tag);
			return;
		}
		const values = new Map<string, string>(attrs);
		if (DROPPED.has(tag)) this.#hide(tag, "");
		else if (tag === "a") {
			const href = values.get("href") || "";
			const address = browserAddress(href);
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

	end(tag: string): void {
		if (this.hidden !== null) {
			if (this.hidden.end(tag)) this.hidden = null;
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

	text(data: string): void {
		if (this.hidden === null) this.#emit(data);
	}

	result(): string {
		// A link never closed is shown as text, without its address.
		for (let at = this.links.length - 1; at >= 0; at--) for (const text of (this.links[at] as Link)[1]) this.out.push(text);
		const lines = writtenOut(this.out).replaceAll(" ", " ").split("\n");
		const joined = lines.map((line) => line.trimEnd()).join("\n");
		return redact(joined.replace(/\n{3,}/g, "\n\n").trim());
	}
}

/** The text an agent is shown. */
export function read(content: string | null | undefined): string {
	if (!content) return "";
	const reader = new Reader();
	tokenize(content, reader);
	return reader.result();
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

/** The text, or a TextError with the reason it is refused. Used as a field validator. */
export function checkWritten(text: string): string {
	const problem = writtenProblem(text);
	if (problem !== null) throw new TextError(problem);
	return text;
}

/** HTML-escaped text, quotes included. */
function escape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** The HTML that shows `text` literally: a paragraph per blank-line-separated block. */
export function written(text: string): string {
	const blocks = text.replaceAll("\r\n", "\n").trim().split(PARAGRAPHS);
	return blocks
		.filter((block) => block.trim())
		.map((block) => `<p>${escape(block).replaceAll("\n", "<br>")}</p>`)
		.join("");
}
