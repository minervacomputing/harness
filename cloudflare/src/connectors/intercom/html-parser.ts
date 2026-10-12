// Python's html.parser.HTMLParser (CPython 3.14.8, Lib/html/parser.py), ported line by line for the one way
// html.ts uses it: `convert_charrefs=True`, `scripting=False`, one `feed` and then `close`. Intercom's text
// is read with Python's events today, and what an agent is shown depends on their quirks (where a tag ends,
// which elements hold raw text, what a malformed tag becomes), so the port keeps them rather than a
// browser's tokenizer or htmlparser2's. test/fixtures/connectors/intercom/vectors.json holds the events
// Python raises for a corpus of hand-written and random documents; the tests compare every one.
//
// Python indexes strings by code point and JavaScript by UTF-16 unit. Every index here comes from a search
// in the same string, so the two agree, except where Python counts characters: the 34 characters the parser
// looks back for a character reference cut by the end of the input, and `feed`'s threshold.
//
// With `convert_charrefs=True`, text is searched only up to the next "<" (or, in an element whose content is
// raw text, up to its end tag), so the parser's branches for "&" are never reached and are left out.

import { NAMED } from "../../lib/html-entities.ts";
import { codePointLength, htmlUnescape, pythonStrip } from "../../lib/text.ts";

export type Attribute = [name: string, value: string | null];

// The expressions, as Python compiles them; `match` is sticky (`y`) and `search` global (`g`). Python's
// classes here are ASCII, and its negated classes match any character, so UTF-16 units match alike.
const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const PICLOSE = />/g;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const TAGFIND_TOLERANT = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND_TOLERANT =
	/((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATETAGEND =
	/[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const ATTR_CHARREF = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g;
const CHARREF_END = /[\t\n\r\f ;]/g;

/** Elements whose content is raw text (RAWTEXT), and those whose content only has character references (RCDATA). */
const CDATA_CONTENT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_CONTENT_ELEMENTS: ReadonlySet<string> = new Set(["textarea", "title"]);

/** `pattern.match(text, at)`. */
function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
	pattern.lastIndex = at;
	return pattern.exec(text);
}

/** `pattern.search(text, at)`. */
function searchFrom(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
	pattern.lastIndex = at;
	return pattern.exec(text);
}

function end(match: RegExpExecArray): number {
	return match.index + match[0].length;
}

/** `text.rfind(sub, start)`: the last `sub` that starts at or after `start`. */
function rfind(text: string, sub: string, start: number): number {
	const at = text.lastIndexOf(sub);
	return at >= start ? at : -1;
}

/** The index (in units) of the character `count` characters (code points) before the end, or 0. */
function charactersBeforeEnd(text: string, count: number): number {
	let at = text.length;
	for (let seen = 0; seen < count && at > 0; seen++) {
		const low = text.charCodeAt(at - 1);
		const high = text.charCodeAt(at - 2);
		at -= low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
	}
	return at;
}

/** `_unescape_attrvalue`: references in an attribute's value, as the standard's attribute value states read them. */
function unescapeAttributeValue(value: string): string {
	return value.replace(ATTR_CHARREF, (ref) => {
		// Numeric references are always read.
		if (ref.startsWith("&#")) return htmlUnescape(ref);
		// A named one only if it is a whole name and not followed by "=".
		if (!ref.endsWith("=") && Object.hasOwn(NAMED, ref.slice(1))) return htmlUnescape(ref);
		return ref;
	});
}

/** Finds tags and other markup and calls a handler for each, as Python's HTMLParser does. */
export class HTMLParser {
	#rawdata = "";
	/** The element whose content is raw text, or null. */
	#cdataElem: string | null = null;
	/** The end tag that ends it (null for plaintext, which never ends). */
	#interesting: RegExp | null = null;
	#escapable = true;
	readonly #supportCdata = true;
	#pending: string[] = [];
	#pendingLength = 0;
	#parseThreshold = 1;

	/** Feeds text to the parser; what cannot be parsed yet is kept for the next call. */
	feed(data: string): void {
		// Python counts characters.
		this.#pendingLength += codePointLength(data);
		if (this.#pendingLength < this.#parseThreshold) {
			this.#pending.push(data);
			return;
		}
		if (this.#pending.length === 0) this.#rawdata += data;
		else {
			this.#pending.push(data);
			this.#rawdata += this.#pending.join("");
			this.#pending = [];
		}
		this.#pendingLength = 0;
		const n = codePointLength(this.#rawdata);
		this.#goahead(false);
		const left = codePointLength(this.#rawdata);
		this.#parseThreshold = left < n ? 1 : left;
	}

	/** Handles any buffered data as if the input ended. */
	close(): void {
		if (this.#pending.length > 0) {
			this.#rawdata += this.#pending.join("");
			this.#pending = [];
			this.#pendingLength = 0;
		}
		this.#goahead(true);
	}

	// Overridable.

	handleStartTag(_tag: string, _attrs: Attribute[]): void {}

	/** `<tag .../>`. */
	handleStartEndTag(tag: string, attrs: Attribute[]): void {
		this.handleStartTag(tag, attrs);
		this.handleEndTag(tag);
	}

	handleEndTag(_tag: string): void {}

	handleData(_data: string): void {}

	handleComment(_data: string): void {}

	handleDecl(_decl: string): void {}

	handlePi(_data: string): void {}

	unknownDecl(_data: string): void {}

	#setCdataMode(elem: string, escapable: boolean): void {
		this.#cdataElem = elem.toLowerCase();
		this.#escapable = escapable;
		// re.IGNORECASE | re.ASCII; the element names are ASCII.
		this.#interesting = this.#cdataElem === "plaintext" ? null : new RegExp(`</${this.#cdataElem}(?=[\\t\\n\\r\\f />])`, "gi");
	}

	#clearCdataMode(): void {
		this.#interesting = null;
		this.#cdataElem = null;
		this.#escapable = true;
	}

	#text(text: string): void {
		this.handleData(this.#escapable ? htmlUnescape(text) : text);
	}

	/** Handles data as far as reasonable; with `end`, as if the input ended there. */
	#goahead(end: boolean): void {
		const rawdata = this.#rawdata;
		let i = 0;
		const n = rawdata.length;
		while (i < n) {
			let j: number;
			if (this.#cdataElem === null) {
				j = rawdata.indexOf("<", i);
				if (j < 0) {
					// A character reference may be cut by the end of what was fed: wait for more when an "&" near
					// the end is not followed by a space or ";".
					const amppos = rfind(rawdata, "&", Math.max(i, charactersBeforeEnd(rawdata, 34)));
					if (amppos >= 0 && searchFrom(CHARREF_END, rawdata, amppos) === null) break;
					j = n;
				}
			} else if (this.#interesting === null) {
				// plaintext: `\z`.
				j = n;
			} else {
				const found = searchFrom(this.#interesting, rawdata, i);
				if (found === null) break;
				j = found.index;
			}
			if (i < j) this.#text(rawdata.slice(i, j));
			i = j;
			if (i === n) break;
			if (!rawdata.startsWith("<", i)) throw new Error("interesting.search() lied");
			let k: number;
			if (matchAt(STARTTAGOPEN, rawdata, i)) k = this.#parseStarttag(i);
			else if (rawdata.startsWith("</", i)) k = this.#parseEndtag(i);
			else if (rawdata.startsWith("<!--", i)) k = this.#parseComment(i);
			else if (rawdata.startsWith("<?", i)) k = this.#parsePi(i);
			else if (rawdata.startsWith("<!", i)) k = this.#parseHtmlDeclaration(i);
			else if (i + 1 < n || end) {
				this.handleData("<");
				k = i + 1;
			} else break;
			if (k < 0) {
				if (!end) break;
				if (matchAt(STARTTAGOPEN, rawdata, i)) {
					// An unfinished start tag is dropped.
				} else if (rawdata.startsWith("</", i)) {
					if (i + 2 === n) this.handleData("</");
					else if (matchAt(ENDTAGOPEN, rawdata, i)) {
						// An unfinished end tag is dropped.
					} else this.handleComment(rawdata.slice(i + 2));
				} else if (rawdata.startsWith("<!--", i)) {
					let stop = n;
					const rest = rawdata.slice(i + 4);
					for (const suffix of ["--!", "--", "-"]) {
						if (rest.endsWith(suffix)) {
							stop -= suffix.length;
							break;
						}
					}
					this.handleComment(rawdata.slice(i + 4, stop));
				} else if (rawdata.startsWith("<![CDATA[", i) && this.#supportCdata) {
					this.unknownDecl(rawdata.slice(i + 3));
				} else if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
					this.handleDecl(rawdata.slice(i + 2));
				} else if (rawdata.startsWith("<!", i)) {
					this.handleComment(rawdata.slice(i + 2));
				} else if (rawdata.startsWith("<?", i)) {
					this.handlePi(rawdata.slice(i + 2));
				} else {
					throw new Error("we should not get here!");
				}
				k = n;
			}
			i = k;
		}
		if (end && i < n) {
			this.#text(rawdata.slice(i, n));
			i = n;
		}
		this.#rawdata = rawdata.slice(i);
	}

	/** `<!...>`: a comment, CDATA, a doctype or a bogus comment; -1 if not terminated. */
	#parseHtmlDeclaration(i: number): number {
		const rawdata = this.#rawdata;
		if (rawdata.slice(i, i + 4) === "<!--") return this.#parseComment(i);
		if (rawdata.slice(i, i + 9) === "<![CDATA[" && this.#supportCdata) {
			const j = rawdata.indexOf("]]>", i + 9);
			if (j < 0) return -1;
			this.unknownDecl(rawdata.slice(i + 3, j));
			return j + 3;
		}
		if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
			const gtpos = rawdata.indexOf(">", i + 9);
			if (gtpos === -1) return -1;
			this.handleDecl(rawdata.slice(i + 2, gtpos));
			return gtpos + 1;
		}
		return this.#parseBogusComment(i);
	}

	/** `<!--...-->`; -1 if not terminated. An empty comment is closed by the first ">" or "->". */
	#parseComment(i: number): number {
		const rawdata = this.#rawdata;
		const found = matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4) ?? searchFrom(COMMENTCLOSE, rawdata, i + 4);
		if (found === null) return -1;
		this.handleComment(rawdata.slice(i + 4, found.index));
		return end(found);
	}

	/** `<!...>` or `</...>` that is not a tag; -1 if not terminated. */
	#parseBogusComment(i: number): number {
		const rawdata = this.#rawdata;
		const pos = rawdata.indexOf(">", i + 2);
		if (pos === -1) return -1;
		this.handleComment(rawdata.slice(i + 2, pos));
		return pos + 1;
	}

	/** `<?...>`; -1 if not terminated. */
	#parsePi(i: number): number {
		const rawdata = this.#rawdata;
		const found = searchFrom(PICLOSE, rawdata, i + 2);
		if (found === null) return -1;
		this.handlePi(rawdata.slice(i + 2, found.index));
		return end(found);
	}

	/** A start tag; its end, or -1 if not terminated. */
	#parseStarttag(i: number): number {
		const endpos = this.#checkForWholeStartTag(i);
		if (endpos < 0) return endpos;
		const rawdata = this.#rawdata;
		const attrs: Attribute[] = [];
		const found = matchAt(TAGFIND_TOLERANT, rawdata, i + 1);
		if (found === null) throw new Error("unexpected call to parse_starttag()");
		let k = end(found);
		const tag = (found[1] as string).toLowerCase();
		while (k < endpos) {
			const m = matchAt(ATTRFIND_TOLERANT, rawdata, k);
			if (m === null) break;
			const name = m[1] as string;
			let value: string | null = m[3] ?? null;
			if (!m[2]) value = null;
			else if (value !== null && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
				value = value.slice(1, -1);
			}
			if (value) value = unescapeAttributeValue(value);
			attrs.push([name.toLowerCase(), value]);
			k = end(m);
		}
		const rest = pythonStrip(rawdata.slice(k, endpos));
		if (rest !== ">" && rest !== "/>") {
			this.handleData(rawdata.slice(i, endpos));
			return endpos;
		}
		if (rest.endsWith("/>")) {
			// XHTML-style empty tag: <span attr="value" />
			this.handleStartEndTag(tag, attrs);
		} else {
			this.handleStartTag(tag, attrs);
			if (CDATA_CONTENT_ELEMENTS.has(tag) || tag === "plaintext") this.#setCdataMode(tag, false);
			else if (RCDATA_CONTENT_ELEMENTS.has(tag)) this.#setCdataMode(tag, true);
		}
		return endpos;
	}

	/** Where a complete start tag ends, or -1. */
	#checkForWholeStartTag(i: number): number {
		const rawdata = this.#rawdata;
		const found = matchAt(LOCATETAGEND, rawdata, i + 1);
		if (found === null) throw new Error("unexpected call to check_for_whole_start_tag()");
		const j = end(found);
		if (rawdata[j - 1] !== ">") return -1;
		return j;
	}

	/** An end tag; its end, or -1 if not terminated. */
	#parseEndtag(i: number): number {
		const rawdata = this.#rawdata;
		if (rawdata.indexOf(">", i + 2) < 0) return -1;
		if (!matchAt(ENDTAGOPEN, rawdata, i)) {
			// "</>" is ignored.
			if (rawdata.slice(i + 2, i + 3) === ">") return i + 3;
			return this.#parseBogusComment(i);
		}
		const located = matchAt(LOCATETAGEND, rawdata, i + 2);
		if (located === null) throw new Error("unexpected call to parse_endtag");
		const j = end(located);
		if (rawdata[j - 1] !== ">") return -1;
		const found = matchAt(TAGFIND_TOLERANT, rawdata, i + 2);
		if (found === null) throw new Error("unexpected call to parse_endtag");
		this.handleEndTag((found[1] as string).toLowerCase());
		this.#clearCdataMode();
		return j;
	}
}
