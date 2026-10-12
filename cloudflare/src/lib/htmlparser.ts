// Python's html.parser.HTMLParser (3.14) with convert_charrefs=True, fed one text and closed, ported with
// its tokenizer's regular expressions: the events it hands to a subclass, and when. Gmail's HTML to text
// (lib/markdown.ts, web/markdown.py's `html_to_text`) and Teams' message reader
// (connectors/teams/html.ts) are subclasses; their tests compare with today's Python.

import { NAMED } from "./html-entities.ts";
import { htmlUnescape, pythonStrip } from "./text.ts";

const INTERESTING_NORMAL = /[&<]/g;
const ENTITYREF = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y;
const CHARREF = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y;
const INCOMPLETE = /&[a-zA-Z#]/y;
const INCOMPLETE_CHARREF = /&#(?:[0-9]|[xX][0-9a-fA-F])/y;
const ATTR_CHARREF = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g;
const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const PICLOSE = />/g;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const TAGFIND_TOLERANT = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND_TOLERANT = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATETAGEND =
	/[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;

const CDATA_CONTENT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_CONTENT_ELEMENTS = new Set(["textarea", "title"]);

function matchAt(regex: RegExp, text: string, at: number): RegExpExecArray | null {
	regex.lastIndex = at;
	return regex.exec(text);
}

function searchFrom(regex: RegExp, text: string, at: number): RegExpExecArray | null {
	regex.lastIndex = at;
	return regex.exec(text);
}

/** `_unescape_attrvalue`: numeric references always, named ones only when exact and not followed by "=". */
function unescapeAttrValue(value: string): string {
	return value.replace(ATTR_CHARREF, (ref: string) => {
		if (ref.startsWith("&#")) return htmlUnescape(ref);
		if (!ref.endsWith("=") && Object.hasOwn(NAMED, ref.slice(1))) return htmlUnescape(ref);
		return ref;
	});
}

export type Attrs = [name: string, value: string | null][];

/** html.parser.HTMLParser with convert_charrefs=True, fed one text and closed. */
export abstract class HTMLParser {
	private rawdata = "";
	private interesting: RegExp | "plaintext" = INTERESTING_NORMAL;
	private cdataElem: string | null = null;
	private escapable = true;
	private readonly supportCdata = true;

	abstract handleStarttag(tag: string, attrs: Attrs): void;
	abstract handleEndtag(tag: string): void;
	abstract handleData(data: string): void;

	handleStartendtag(tag: string, attrs: Attrs): void {
		this.handleStarttag(tag, attrs);
		this.handleEndtag(tag);
	}

	/** One `feed(text)` then `close()`. */
	run(text: string): void {
		if (text.length > 0) {
			this.rawdata += text;
			this.goahead(false);
		}
		this.goahead(true);
	}

	private setCdataMode(elem: string): void {
		this.cdataElem = elem.toLowerCase();
		if (this.cdataElem === "plaintext") this.interesting = "plaintext";
		else this.interesting = new RegExp(`</${this.cdataElem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\t\\n\\r\\f />])`, "gi");
	}

	private clearCdataMode(): void {
		this.interesting = INTERESTING_NORMAL;
		this.cdataElem = null;
		this.escapable = true;
	}

	private goahead(end: boolean): void {
		const rawdata = this.rawdata;
		let i = 0;
		const n = rawdata.length;
		while (i < n) {
			let j: number;
			if (!this.cdataElem) {
				j = rawdata.indexOf("<", i);
				if (j < 0) {
					// If more text may follow, a character reference could be cut in half at the end: wait for
					// the rest, unless the last "&" is followed by a space or ";".
					const from = Math.max(i, n - 34);
					const amppos = rawdata.lastIndexOf("&");
					if (amppos >= from && !/[\t\n\r\f ;]/.test(rawdata.slice(amppos))) break;
					j = n;
				}
			} else {
				let found: number;
				if (this.interesting === "plaintext") found = n;
				else {
					const match = searchFrom(this.interesting as RegExp, rawdata, i);
					found = match === null ? -1 : match.index;
				}
				if (found >= 0) j = found;
				else break;
			}
			if (i < j) {
				if (this.escapable) this.handleData(htmlUnescape(rawdata.slice(i, j)));
				else this.handleData(rawdata.slice(i, j));
			}
			i = j;
			if (i === n) break;
			if (rawdata.startsWith("<", i)) {
				let k: number;
				if (matchAt(STARTTAGOPEN, rawdata, i)) k = this.parseStarttag(i);
				else if (rawdata.startsWith("</", i)) k = this.parseEndtag(i);
				else if (rawdata.startsWith("<!--", i)) k = this.parseComment(i);
				else if (rawdata.startsWith("<?", i)) k = this.parsePi(i);
				else if (rawdata.startsWith("<!", i)) k = this.parseHtmlDeclaration(i);
				else if (i + 1 < n || end) {
					this.handleData("<");
					k = i + 1;
				} else break;
				if (k < 0) {
					if (!end) break;
					// At the end, an unterminated construct is a comment (dropped), except "</" alone, which is text.
					if (!matchAt(STARTTAGOPEN, rawdata, i) && rawdata.startsWith("</", i) && i + 2 === n) this.handleData("</");
					k = n;
				}
				i = k;
			} else if (rawdata.startsWith("&#", i)) {
				// Not reached with convert_charrefs: the text before "<" is unescaped as a whole.
				const match = matchAt(CHARREF, rawdata, i);
				if (match) {
					let k = i + match[0].length;
					if (!rawdata.startsWith(";", k - 1)) k -= 1;
					i = k;
					continue;
				}
				if (matchAt(INCOMPLETE_CHARREF, rawdata, i)) {
					if (end) i = n;
					break;
				}
				if (i + 3 < n) {
					this.handleData("&#");
					i += 2;
				} else break;
			} else if (rawdata.startsWith("&", i)) {
				const match = matchAt(ENTITYREF, rawdata, i);
				if (match) {
					let k = i + match[0].length;
					if (!rawdata.startsWith(";", k - 1)) k -= 1;
					i = k;
					continue;
				}
				if (matchAt(INCOMPLETE, rawdata, i)) {
					if (end) i = n;
					break;
				}
				if (i + 1 < n) {
					this.handleData("&");
					i += 1;
				} else break;
			} else throw new Error("interesting.search() lied");
		}
		if (end && i < n) {
			if (this.escapable) this.handleData(htmlUnescape(rawdata.slice(i, n)));
			else this.handleData(rawdata.slice(i, n));
			i = n;
		}
		this.rawdata = rawdata.slice(i);
	}

	private parseHtmlDeclaration(i: number): number {
		const rawdata = this.rawdata;
		if (rawdata.slice(i, i + 4) === "<!--") return this.parseComment(i);
		if (rawdata.slice(i, i + 9) === "<![CDATA[" && this.supportCdata) {
			const j = rawdata.indexOf("]]>", i + 9);
			if (j < 0) return -1;
			return j + 3;
		}
		if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
			const gtpos = rawdata.indexOf(">", i + 9);
			if (gtpos === -1) return -1;
			return gtpos + 1;
		}
		return this.parseBogusComment(i);
	}

	private parseComment(i: number): number {
		const rawdata = this.rawdata;
		// An empty comment is abruptly closed by the first ">" or "->".
		let match = matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4);
		if (!match) {
			match = searchFrom(COMMENTCLOSE, rawdata, i + 4);
			if (!match) return -1;
		}
		return match.index + match[0].length;
	}

	private parseBogusComment(i: number): number {
		const pos = this.rawdata.indexOf(">", i + 2);
		if (pos === -1) return -1;
		return pos + 1;
	}

	private parsePi(i: number): number {
		const match = searchFrom(PICLOSE, this.rawdata, i + 2);
		if (!match) return -1;
		return match.index + match[0].length;
	}

	private checkForWholeStartTag(i: number): number {
		const rawdata = this.rawdata;
		const match = matchAt(LOCATETAGEND, rawdata, i + 1) as RegExpExecArray;
		const j = i + 1 + match[0].length;
		if (rawdata[j - 1] !== ">") return -1;
		return j;
	}

	private parseStarttag(i: number): number {
		const endpos = this.checkForWholeStartTag(i);
		if (endpos < 0) return endpos;
		const rawdata = this.rawdata;
		const attrs: Attrs = [];
		const match = matchAt(TAGFIND_TOLERANT, rawdata, i + 1) as RegExpExecArray;
		let k = i + 1 + match[0].length;
		const tag = (match[1] as string).toLowerCase();
		while (k < endpos) {
			const m = matchAt(ATTRFIND_TOLERANT, rawdata, k);
			if (!m) break;
			const attrname = m[1] as string;
			const rest = m[2];
			let attrvalue: string | null = m[3] ?? null;
			if (!rest) attrvalue = null;
			else if (attrvalue !== null && ((attrvalue.slice(0, 1) === "'" && attrvalue.slice(-1) === "'") || (attrvalue.slice(0, 1) === '"' && attrvalue.slice(-1) === '"'))) {
				attrvalue = attrvalue.slice(1, -1);
			}
			if (attrvalue) attrvalue = unescapeAttrValue(attrvalue);
			attrs.push([attrname.toLowerCase(), attrvalue]);
			k += m[0].length;
		}
		const end = pythonStrip(rawdata.slice(k, endpos));
		if (end !== ">" && end !== "/>") {
			this.handleData(rawdata.slice(i, endpos));
			return endpos;
		}
		if (end.endsWith("/>")) this.handleStartendtag(tag, attrs);
		else {
			this.handleStarttag(tag, attrs);
			if (CDATA_CONTENT_ELEMENTS.has(tag) || tag === "plaintext") {
				this.setCdataMode(tag);
				this.escapable = false;
			} else if (RCDATA_CONTENT_ELEMENTS.has(tag)) {
				this.setCdataMode(tag);
				this.escapable = true;
			}
		}
		return endpos;
	}

	private parseEndtag(i: number): number {
		const rawdata = this.rawdata;
		if (rawdata.indexOf(">", i + 2) < 0) return -1;
		if (!matchAt(ENDTAGOPEN, rawdata, i)) {
			// "</>" is ignored; anything else is a bogus comment.
			if (rawdata.slice(i + 2, i + 3) === ">") return i + 3;
			return this.parseBogusComment(i);
		}
		const located = matchAt(LOCATETAGEND, rawdata, i + 2) as RegExpExecArray;
		const j = i + 2 + located[0].length;
		if (rawdata[j - 1] !== ">") return -1;
		const match = matchAt(TAGFIND_TOLERANT, rawdata, i + 2) as RegExpExecArray;
		const tag = (match[1] as string).toLowerCase();
		this.handleEndtag(tag);
		this.clearCdataMode();
		return j;
	}
}
