// Header folding as Python's email._header_value_parser does it (`_refold_parse_tree`, `_fold_as_ew`) under
// the SMTP policy Gmail's messages are written with: lines of at most 78 characters joined by CRLF, ASCII
// only, anything else as UTF-8 encoded words. Lengths and slices count code points, as Python's do.

import { codePointLength } from "../../../lib/text.ts";
import { encodeWord } from "./ew.ts";
import { HeaderParseError, at } from "./errors.ts";
import {
	DOT,
	Header,
	HeaderLabel,
	MsgID,
	NLSET,
	SPECIALSNL,
	type Terminal,
	type Token,
	type TokenList,
	WSP,
	cfwsList,
	getUnstructured,
	hasAny,
	makeParenthesisPairs,
	makeQuotedPairs,
	valueTerminal,
	whiteSpaceTerminal,
} from "./parser.ts";

export const MAX_LINE_LENGTH = 78;
export const LINESEP = "\r\n";

const cpLen = codePointLength;

function cpSlice(text: string, start: number, end?: number): string {
	return Array.from(text).slice(start, end).join("");
}

function lastChar(text: string): string {
	const chars = Array.from(text);
	return chars[chars.length - 1] ?? "";
}

/** `str.strip(" \t")` / `rstrip(" \t")`. */
function stripWsp(text: string): string {
	return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

function rstripWsp(text: string): string {
	return text.replace(/[ \t]+$/, "");
}

function isAscii(text: string): boolean {
	return /^[\u0000-\u007f]*$/.test(text);
}

function stealTrailingWsp(lines: string[]): string {
	let wsp = "";
	const last = lines[lines.length - 1];
	if (lines.length && last && WSP.has(lastChar(last))) {
		wsp = lastChar(last);
		lines[lines.length - 1] = cpSlice(last, 0, -1);
		// gh-142006: if the line is now empty, remove it entirely.
		if (!lines[lines.length - 1]) lines.pop();
	}
	return wsp;
}

/** `part.fold(policy=SMTP)` for a token list: MsgID is never folded, everything else is refolded. */
function foldToken(part: TokenList): string {
	if (part instanceof MsgID) return part.str() + LINESEP;
	return refoldParseTree(part);
}

function foldAsEw(toEncode: string, lines: string[], maxlen: number, lastEw: number | null, ewCombineAllowed: boolean, charset: string, lastWordIsEw: boolean): number | null {
	const last = () => lines[lines.length - 1] as string;
	const setLast = (text: string) => {
		lines[lines.length - 1] = text;
	};
	if (lastEw !== null && ewCombineAllowed) {
		toEncode = getUnstructured(cpSlice(last(), lastEw) + toEncode).str();
		setLast(cpSlice(last(), 0, lastEw));
	} else if (lastWordIsEw) {
		// Any white space between two encoded words is ignored when decoded, so it is encoded in the second.
		const lenWithoutWsp = cpLen(rstripWsp(last()));
		const leadingWhitespace = cpSlice(last(), lenWithoutWsp);
		setLast(cpSlice(last(), 0, lenWithoutWsp) + (leadingWhitespace ? " " : ""));
		toEncode = leadingWhitespace + toEncode;
	} else if (WSP.has(at(Array.from(toEncode), 0))) {
		// We're joining this to non-encoded text, so don't encode the leading blank.
		const leadingWsp = cpSlice(toEncode, 0, 1);
		toEncode = cpSlice(toEncode, 1);
		if (cpLen(last()) === maxlen) lines.push(stealTrailingWsp(lines));
		setLast(last() + leadingWsp);
	}
	let trailingWsp = "";
	if (WSP.has(at(Array.from(toEncode), -1))) {
		trailingWsp = lastChar(toEncode);
		toEncode = cpSlice(toEncode, 0, -1);
	}
	let newLastEw = lastEw === null ? cpLen(last()) : lastEw;
	const encodeAs = charset === "us-ascii" ? "utf-8" : charset;
	const chromeLen = encodeAs.length + 7;
	if (chromeLen + 1 >= maxlen) throw new HeaderParseError("max_line_length is too small to fit an encoded word");
	while (toEncode) {
		const remainingSpace = maxlen - cpLen(last());
		const textSpace = remainingSpace - chromeLen;
		if (textSpace <= 0) {
			const newline = stealTrailingWsp(lines);
			lines.push(newline || " ");
			newLastEw = cpLen(last());
			continue;
		}
		let word = cpSlice(toEncode, 0, textSpace);
		let encoded = encodeWord(word, encodeAs);
		let excess = encoded.length - remainingSpace;
		while (excess > 0) {
			word = cpSlice(word, 0, -1);
			encoded = encodeWord(word, encodeAs);
			excess = encoded.length - remainingSpace;
		}
		setLast(last() + encoded);
		toEncode = cpSlice(toEncode, cpLen(word));
		if (toEncode) {
			lines.push(" ");
			newLastEw = cpLen(last());
		}
	}
	setLast(last() + trailingWsp);
	return ewCombineAllowed ? newLastEw : null;
}

const END_EW_NOT_ALLOWED = valueTerminal("", "wrap_as_ew_blocked");

/** `_refold_parse_tree(parse_tree, policy=SMTP)`. */
export function refoldParseTree(parseTree: TokenList): string {
	const maxlen = MAX_LINE_LENGTH;
	const lines: string[] = [""];
	let lastWordIsEw = false;
	let lastEw: number | null = null;
	let lastCharset: string | null = null;
	let wrapAsEwBlocked = 0;
	let wantEncoding = false;
	let parts: Token[] = [...parseTree.items];
	const last = () => lines[lines.length - 1] as string;
	while (parts.length) {
		const part = parts.shift() as Token;
		if (part === END_EW_NOT_ALLOWED) {
			wrapAsEwBlocked -= 1;
			continue;
		}
		const tstr = part.str();
		if (!wantEncoding) {
			// Encode ptext and vtext with special characters, anything with newlines.
			if (part.tokenType === "ptext" || part.tokenType === "vtext") wantEncoding = hasAny(tstr, SPECIALSNL);
			else wantEncoding = hasAny(tstr, NLSET);
		}
		let charset: string;
		if (isAscii(tstr)) charset = "us-ascii";
		else {
			charset = part.allDefects.some((defect) => defect.kind === "UndecodableBytesDefect") ? "unknown-8bit" : "utf-8";
			wantEncoding = true;
		}
		if (wantEncoding && !wrapAsEwBlocked) {
			if (!part.asEwAllowed) {
				wantEncoding = false;
				lastEw = null;
				if (part.syntacticBreak) {
					const folded = foldToken(part as TokenList);
					const encodedPart = folded.slice(0, folded.length - LINESEP.length);
					if (!encodedPart.includes(LINESEP)) {
						// It fits on a single line
						if (cpLen(encodedPart) > maxlen - cpLen(last())) {
							// But not on this one, so start a new one.
							const newline = stealTrailingWsp(lines);
							lines.push(newline);
						}
						lines[lines.length - 1] = last() + encodedPart;
						lastWordIsEw = false;
						continue;
					}
				}
				// Either this is not a major syntactic break, or it doesn't fit on a line by itself; either way
				// fall through to unpacking the subparts and wrapping them.
			}
			if (!part.terminal) {
				// It's not a Terminal, do each piece individually.
				parts = [...part.items, ...parts];
				wantEncoding = false;
				continue;
			}
			if (part.asEwAllowed) {
				// It's a terminal, wrap it as an encoded word, possibly combining it with previous ones.
				if (lastEw !== null && charset !== lastCharset && (lastCharset === "unknown-8bit" || (lastCharset === "utf-8" && charset !== "us-ascii"))) lastEw = null;
				lastEw = foldAsEw(tstr, lines, maxlen, lastEw, part.ewCombineAllowed, charset, lastWordIsEw);
				lastWordIsEw = true;
				lastCharset = charset;
				wantEncoding = false;
				continue;
			}
			// It's a terminal which should be kept non-encoded (e.g. a ListSeparator).
			lastEw = null;
			wantEncoding = false;
		}
		if (cpLen(tstr) <= maxlen - cpLen(last())) {
			lines[lines.length - 1] = last() + tstr;
			lastWordIsEw = lastWordIsEw && !stripWsp(tstr);
			continue;
		}
		// This part is too long to fit. The RFC wants us to break at "major syntactic breaks", so unless we
		// don't consider this to be one, check if it will fit on the next line by itself.
		if (part.syntacticBreak && cpLen(tstr) + 1 <= maxlen) {
			const newline = stealTrailingWsp(lines);
			if (newline || part.startswithFws()) {
				lines.push(newline + tstr);
				lastWordIsEw = lastWordIsEw && !stripWsp(last());
				lastEw = null;
				continue;
			}
		}
		if (!part.terminal) {
			// It's not a terminal, try folding the subparts.
			let newparts: Token[] = [...part.items];
			if (part.tokenType === "bare-quoted-string") {
				// To fold a quoted string, render the quotes and use quoted pairs in the value as appropriate.
				newparts = [valueTerminal('"', "ptext"), ...newparts.map((p) => valueTerminal(makeQuotedPairs(p.str()), "ptext")), valueTerminal('"', "ptext")];
			}
			if (part.tokenType === "comment") {
				newparts = [
					valueTerminal("(", "ptext"),
					...newparts.map((p) => (p.tokenType === "ptext" ? valueTerminal(makeParenthesisPairs(p.str()), "ptext") : p)),
					valueTerminal(")", "ptext"),
				];
			}
			if (!part.asEwAllowed) {
				wrapAsEwBlocked += 1;
				newparts.push(END_EW_NOT_ALLOWED);
			}
			parts = [...newparts, ...parts];
			continue;
		}
		if (part.asEwAllowed && !wrapAsEwBlocked) {
			// It doesn't need CTE encoding, but encode it anyway so we can wrap it.
			parts.unshift(part);
			wantEncoding = true;
			continue;
		}
		// We can't figure out how to wrap it, so give up.
		const newline = stealTrailingWsp(lines);
		if (newline || part.startswithFws()) lines.push(newline + tstr);
		else {
			// We can't fold it onto the next line either...
			lines[lines.length - 1] = last() + tstr;
		}
		lastWordIsEw = lastWordIsEw && !stripWsp(tstr);
	}
	return lines.join(LINESEP) + LINESEP;
}

/** `BaseHeader.fold(policy=SMTP)`: the header's name, a colon and its folded value, ending with CRLF. */
export function foldHeader(name: string, parseTree: TokenList): string {
	const header = new Header([new HeaderLabel([valueTerminal(name, "header-name"), valueTerminal(":", "header-sep")])]);
	if (parseTree.length > 0) header.append(cfwsList([whiteSpaceTerminal(" ", "fws")]));
	header.append(parseTree);
	return refoldParseTree(header);
}

export type { Terminal };
export { DOT };
