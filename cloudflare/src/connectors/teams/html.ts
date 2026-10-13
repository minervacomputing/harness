// Message text as agents see it and write it.
//
// Teams stores channel messages as HTML. Read text is the HTML turned into plain text, without what could
// show another channel or team the agent may not read:
// - a mention of a channel or team (`<at>` whose mention names a conversation) shows as "@[channel]"; people,
//   tags and apps keep their names;
// - a link to Teams shows as "[Teams link]": its label and its address can both carry a channel's name, and
//   so does an address to Teams in the text itself;
// - a quote (any `<blockquote>`: Teams quotes replied-to messages with one) shows as "[quoted message]";
// - attachments (`<attachment>`), scripts, styles and elements whose content is raw text (textarea, xmp,
//   iframe, ...) are left out: browsers may read markup inside them that the tokenizer reads as text.
// Each of these drops everything inside the element, and an element that is never closed hides the rest of
// the message rather than letting it through, and so does one written self-closing (`<at/>`), which browsers
// read as open, and one with a misnested or unclosed element inside (lib/html.ts's `Hidden`). A mention or
// link that repeats an attribute is hidden too, since readers disagree on which value counts, and so is a
// mention whose id the list of mentions also gives to a channel. Images show as "[image]" and emoji as their
// text.
//
// Written text is escaped and sent as HTML, so it is shown literally: it cannot mention anyone (a mention
// needs an `<at>` element and a list of mentions) or format anything. It may not link to Teams, in any
// encoding: Teams can show a preview of a linked message or channel, which may be one the agent may not read.
//
// The HTML is tokenized by lib/html.ts.

import { type Attribute, Hidden, type Tokens, tokenize } from "../../lib/html.ts";
import { decoded, plainText, TextError, WORDS } from "../../lib/text.ts";
import type { Mention } from "./client.ts";
import { extend } from "../../lib/arrays.ts";
import { endsWithNewline, linkText, type Piece, written as writtenOut } from "../../lib/linktext.ts";

/**
 * An address to Teams, case-insensitive with Unicode's simple case folding (so "ſ" is an "s" and "K" a
 * "k"), and "İ" and "ı" as "i".
 */
export const TEAMS = /teams\.(?:m[iİı]crosoft\.(?:com|us)|l[iİı]ve\.com|cloud\.m[iİı]crosoft|m[iİı]crosoftonl[iİı]ne\.cn|off[iİı]ce\.com)|msteams:/iu;
const BLOCKS: ReadonlySet<string> = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "ul", "ol", "table", "li"]);
const DROPPED: ReadonlySet<string> = new Set([
	"attachment",
	"script",
	"style",
	"head",
	"title",
	"template",
	"noscript",
	"textarea",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
]);

/** Whether `text` addresses Teams in any encoding; browsers drop tabs and newlines inside addresses. */
export function toTeams(text: string): boolean {
	return TEAMS.test(decoded(text).replace(/[\t\n\r]/g, ""));
}

/** Plain text with every word that addresses Teams replaced. */
export function redact(text: string): string {
	return text.replace(WORDS, (word) => (toTeams(word) ? "[Teams link]" : word));
}

/** The `<at>` ids of mentions of people, tags and apps; any other mention, and any id also given to one, is hidden. */
function shownMentions(mentions: readonly Mention[]): Set<string> {
	const shown = new Set<string>();
	const hidden = new Set<string>();
	for (const mention of mentions) {
		if (mention.id === null) continue;
		const id = String(mention.id);
		const target = mention.mentioned;
		if (target === null || target.conversation !== null) hidden.add(id);
		else if (target.user !== null || target.application !== null || target.tag !== null) shown.add(id);
		else hidden.add(id);
	}
	return new Set([...shown].filter((id) => !hidden.has(id)));
}

class Reader implements Tokens {
	readonly shown: Set<string>;
	readonly out: Piece[] = [];
	/** A link being read: its address and the text of its label. */
	readonly links: [string, Piece[]][] = [];
	/** The element whose content is dropped. */
	hidden: Hidden | null = null;

	constructor(shown: Set<string>) {
		this.shown = shown;
	}

	#target(): Piece[] {
		return this.links.length ? (this.links[this.links.length - 1] as [string, Piece[]])[1] : this.out;
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
		if (target.length && !endsWithNewline(target[target.length - 1] as Piece)) target.push("\n");
	}

	start(tag: string, attrs: Attribute[], selfClosing: boolean): void {
		// Browsers ignore the slash on elements that are not void, so `<at/>` stays open; an emoji has no content.
		if (selfClosing && tag === "emoji" && this.hidden === null) {
			this.#emit(attrs.find(([name]) => name === "alt")?.[1] ?? "");
			return;
		}
		if (this.hidden !== null) {
			this.hidden.start(tag);
			return;
		}
		// Readers disagree on which of repeated attributes counts, so a mention or link repeating one is hidden.
		const values = new Map<string, string>(attrs);
		const repeated = values.size !== attrs.length;
		if (DROPPED.has(tag)) this.#hide(tag, "");
		else if (tag === "at") {
			const id = values.get("id");
			if (id !== undefined && this.shown.has(id) && !repeated) this.#emit("@");
			else this.#hide(tag, "@[channel]");
		} else if (tag === "a") {
			const href = values.get("href") ?? "";
			if (repeated || toTeams(href)) this.#hide(tag, "[Teams link]");
			else this.links.push([href, []]);
		} else if (tag === "blockquote") {
			this.#newline();
			this.#hide(tag, "[quoted message]\n");
		} else if (tag === "img") this.#emit("[image]");
		else if (tag === "emoji") this.#hide(tag, values.get("alt") ?? "");
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
		if (tag === "a" && this.links.length) {
			// Built from its pieces (lib/linktext.ts): joining each label anew copied nested links' text once per level.
			const [href, label] = this.links.pop() as [string, Piece[]];
			this.#emit(linkText(label, href));
		} else if (tag === "td" || tag === "th") this.#emit("\t");
		else if (BLOCKS.has(tag)) this.#newline();
	}

	text(text: string): void {
		if (this.hidden === null) this.#emit(text);
	}

	result(): string {
		// A link never closed is shown as text, without its address.
		for (const [, label] of [...this.links].reverse()) extend(this.out, label);
		const lines = writtenOut(this.out).replaceAll("\u00a0", " ").split("\n");
		const joined = lines.map((line) => line.trimEnd()).join("\n");
		return redact(joined.replace(/\n{3,}/g, "\n\n").trim());
	}
}

/** The text an agent is shown. */
export function read(content: string | null, contentType: string | null, mentions: readonly Mention[]): string {
	if (!content) return "";
	if ((contentType || "").toLowerCase() === "text") return redact(content.trim());
	const reader = new Reader(shownMentions(mentions));
	tokenize(content, reader);
	return reader.result();
}

/** Refuses text that would do more than add words to a channel. Used as a field validator. */
export function checkWritten(text: string): string {
	plainText(text);
	if (toTeams(text)) {
		throw new TextError("must not link to Teams: Teams may show the linked message or channel, which may be one you may not read");
	}
	return text;
}

/** The HTML that shows `text` literally: escaped, quotes included, with line breaks. */
export function written(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#x27;")
		.replaceAll("\r\n", "\n")
		.replaceAll("\n", "<br>");
}
