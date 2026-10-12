// The parts of Python's email._header_value_parser (3.14) that Gmail uses: address lists (reply addresses
// are read strictly by `mime.mailboxes`, and the To, Cc and Bcc of a message Minerva builds are folded from
// their parse tree), unstructured values (Subject) and message ids (In-Reply-To, References), with the
// tokens, values, defects and the attributes the folder reads. Ported function by function; a Python
// index that could fail is `at()`, which raises IndexError as Python does, since callers catch it.
//
// Strings are JavaScript strings. Every character the grammar tests is ASCII, so indexing by UTF-16 unit
// finds the same boundaries as Python's code points; lengths that matter (folding) are counted by code
// point in fold.ts.

import { pythonLstrip, pythonRstrip, pythonSplit } from "../../../lib/text.ts";
import { decodeEncodedWord } from "./ew.ts";
import { Defect, HeaderParseError, KeyError, ValueError, at } from "./errors.ts";
import { extend } from "../../../lib/arrays.ts";

export const WSP = new Set([" ", "\t"]);
const CFWS_LEADER = new Set([" ", "\t", "("]);
export const SPECIALS = new Set([..."()<>@,:;.\\\"[]"]);
const ATOM_ENDS = new Set([...SPECIALS, ...WSP]);
export const DOT_ATOM_ENDS = new Set([...ATOM_ENDS].filter((char) => char !== "."));
const PHRASE_ENDS = new Set([...SPECIALS].filter((char) => !'."('.includes(char)));
export const NLSET = new Set(["\n", "\r"]);
export const SPECIALSNL = new Set([...SPECIALS, ...NLSET]);
const HEXDIGITS = new Set([..."0123456789abcdefABCDEF"]);

export function hasAny(text: string, set: ReadonlySet<string>): boolean {
	for (const char of text) if (set.has(char)) return true;
	return false;
}

export function makeQuotedPairs(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function makeParenthesisPairs(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function quoteString(value: string): string {
	return `"${makeQuotedPairs(value)}"`;
}

/** `rfc2047_matcher`: something that looks like an encoded word. */
const RFC2047 = /=\?[^?]*\?[qQbB]\?[^\n]*?\?=/;

function invalid(message: string): Defect {
	return new Defect("InvalidHeaderDefect", message);
}

function obsolete(message: string): Defect {
	return new Defect("ObsoleteHeaderDefect", message);
}

// Tokens.

export type Token = Terminal | TokenList;

export class Terminal {
	readonly terminal = true;
	tokenType: string;
	defects: Defect[] = [];
	asEwAllowed = true;
	ewCombineAllowed = true;
	syntacticBreak = true;

	/** The string the terminal is (Python's str value), which `startswith_fws` and truthiness read. */
	readonly text: string;
	readonly kind: "value" | "whitespace" | "ew-whitespace";

	constructor(text: string, tokenType: string, kind: "value" | "whitespace" | "ew-whitespace" = "value") {
		this.text = text;
		this.kind = kind;
		this.tokenType = tokenType;
	}

	str(): string {
		return this.kind === "ew-whitespace" ? "" : this.text;
	}

	get value(): string {
		if (this.kind === "whitespace") return " ";
		if (this.kind === "ew-whitespace") return "";
		return this.text;
	}

	get allDefects(): Defect[] {
		return [...this.defects];
	}

	startswithFws(): boolean {
		return this.kind !== "value" && this.text.length > 0 && WSP.has(this.text[0] as string);
	}

	get comments(): string[] {
		return [];
	}

	get length(): number {
		return this.text.length;
	}
}

export function valueTerminal(text: string, tokenType: string): Terminal {
	return new Terminal(text, tokenType, "value");
}

export function whiteSpaceTerminal(text: string, tokenType: string): Terminal {
	return new Terminal(text, tokenType, "whitespace");
}

export function ewWhiteSpaceTerminal(text: string, tokenType: string): Terminal {
	return new Terminal(text, tokenType, "ew-whitespace");
}

export const DOT = valueTerminal(".", "dot");
export const ListSeparator = valueTerminal(",", "list-separator");
ListSeparator.asEwAllowed = false;
ListSeparator.syntacticBreak = false;
const RouteComponentMarker = valueTerminal("@", "route-component-marker");

function str(token: Token): string {
	return token.str();
}

export class TokenList {
	readonly terminal = false;
	static readonly TYPE: string | null = null;
	tokenType: string | null;
	defects: Defect[] = [];
	items: Token[];

	constructor(items: Iterable<Token> = []) {
		this.items = [...items];
		this.tokenType = (this.constructor as typeof TokenList).TYPE;
	}

	get length(): number {
		return this.items.length;
	}

	at(index: number): Token {
		return at(this.items, index);
	}

	set(index: number, token: Token): void {
		const i = index < 0 ? this.items.length + index : index;
		at(this.items, i);
		this.items[i] = token;
	}

	append(token: Token): void {
		this.items.push(token);
	}

	/** `token[:0] = [leader]`. */
	prepend(token: Token): void {
		this.items.unshift(token);
	}

	str(): string {
		return this.items.map(str).join("");
	}

	get value(): string {
		return this.items
			.map((item) => item.value)
			.filter(Boolean)
			.join("");
	}

	get allDefects(): Defect[] {
		return [...this.defects, ...this.items.flatMap((item) => item.allDefects)];
	}

	startswithFws(): boolean {
		return this.at(0).startswithFws();
	}

	get asEwAllowed(): boolean {
		return this.items.every((part) => part.asEwAllowed);
	}

	get syntacticBreak(): boolean {
		return true;
	}

	get ewCombineAllowed(): boolean {
		return true;
	}

	get comments(): string[] {
		return this.items.flatMap((token) => token.comments);
	}
}

class WhiteSpaceTokenList extends TokenList {
	override get value(): string {
		return " ";
	}

	override get comments(): string[] {
		return this.items.filter((x) => x.tokenType === "comment").map((x) => (x as Comment).content);
	}
}

export class UnstructuredTokenList extends TokenList {
	static override readonly TYPE = "unstructured";
}

class Phrase extends TokenList {
	static override readonly TYPE: string = "phrase";
}

class CFWSList extends WhiteSpaceTokenList {
	static override readonly TYPE = "cfws";
}

export function cfwsList(items: Token[]): TokenList {
	return new CFWSList(items);
}

class Atom extends TokenList {
	static override readonly TYPE = "atom";
}

export class EncodedWord extends TokenList {
	static override readonly TYPE = "encoded-word";
	cte: string | null = null;
	charset: string | null = null;
	lang: string | null = null;
}

class QuotedString extends TokenList {
	static override readonly TYPE: string = "quoted-string";

	get content(): string | undefined {
		for (const x of this.items) if (x.tokenType === "bare-quoted-string") return x.value;
		return undefined;
	}

	get quotedValue(): string {
		return this.items.map((x) => (x.tokenType === "bare-quoted-string" ? str(x) : x.value)).join("");
	}
}

export class BareQuotedString extends QuotedString {
	static override readonly TYPE = "bare-quoted-string";

	override str(): string {
		return quoteString(this.items.map(str).join(""));
	}

	override get value(): string {
		return this.items.map(str).join("");
	}
}

export class Comment extends WhiteSpaceTokenList {
	static override readonly TYPE = "comment";

	override str(): string {
		return `(${this.items.map((x) => this.quote(x)).join("")})`;
	}

	quote(value: Token): string {
		if (value.tokenType === "comment") return str(value);
		return str(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
	}

	get content(): string {
		return this.items.map(str).join("");
	}

	override get comments(): string[] {
		return [this.content];
	}
}

export class AddressList extends TokenList {
	static override readonly TYPE = "address-list";

	get addresses(): Address[] {
		return this.items.filter((x) => x.tokenType === "address") as Address[];
	}

	get allMailboxes(): TokenList[] {
		return this.addresses.flatMap((x) => x.allMailboxes);
	}
}

export class Address extends TokenList {
	static override readonly TYPE = "address";

	get displayName(): string | null {
		const first = this.at(0);
		if (first.tokenType === "group") return (first as Group).displayName;
		return null;
	}

	get allMailboxes(): TokenList[] {
		const first = this.at(0);
		if (first.tokenType === "mailbox" || first.tokenType === "invalid-mailbox") return [first as TokenList];
		return (first as Group).allMailboxes;
	}
}

class MailboxList extends TokenList {
	static override readonly TYPE = "mailbox-list";

	get allMailboxes(): TokenList[] {
		return this.items.filter((x) => x.tokenType === "mailbox" || x.tokenType === "invalid-mailbox") as TokenList[];
	}
}

class GroupList extends TokenList {
	static override readonly TYPE = "group-list";

	get allMailboxes(): TokenList[] {
		if (this.length === 0 || this.at(0).tokenType !== "mailbox-list") return [];
		return (this.at(0) as MailboxList).allMailboxes;
	}
}

class Group extends TokenList {
	static override readonly TYPE = "group";

	get allMailboxes(): TokenList[] {
		if (this.at(2).tokenType !== "group-list") return [];
		return (this.at(2) as GroupList).allMailboxes;
	}

	get displayName(): string | null {
		return (this.at(0) as DisplayName).displayName;
	}
}

/** What a mailbox token answers: a Mailbox, or an InvalidMailbox whose answers are all None. */
interface MailboxLike {
	displayName: string | null;
	localPart: string | null;
	domain: string | null;
}

class NameAddr extends TokenList {
	static override readonly TYPE = "name-addr";

	get displayName(): string | null {
		if (this.length === 1) return null;
		return (this.at(0) as DisplayName).displayName;
	}

	get localPart(): string | null {
		return (this.at(-1) as AngleAddr).localPart;
	}

	get domain(): string | null {
		return (this.at(-1) as AngleAddr).domain;
	}
}

class AngleAddr extends TokenList {
	static override readonly TYPE = "angle-addr";

	get localPart(): string | null {
		for (const x of this.items) if (x.tokenType === "addr-spec") return (x as AddrSpec).localPart;
		return null;
	}

	get domain(): string | null {
		for (const x of this.items) if (x.tokenType === "addr-spec") return (x as AddrSpec).domain;
		return null;
	}
}

class ObsRoute extends TokenList {
	static override readonly TYPE = "obs-route";
}

export class Mailbox extends TokenList implements MailboxLike {
	static override readonly TYPE = "mailbox";

	get displayName(): string | null {
		const first = this.at(0);
		if (first.tokenType === "name-addr") return (first as NameAddr).displayName;
		return null;
	}

	get localPart(): string | null {
		return (this.at(0) as NameAddr | AddrSpec).localPart;
	}

	get domain(): string | null {
		return (this.at(0) as NameAddr | AddrSpec).domain;
	}
}

export class InvalidMailbox extends TokenList implements MailboxLike {
	static override readonly TYPE = "invalid-mailbox";
	readonly displayName = null;
	readonly localPart = null;
	readonly domain = null;
}

class Domain extends TokenList {
	static override readonly TYPE = "domain";

	override get asEwAllowed(): boolean {
		return false;
	}

	get domain(): string {
		return pythonSplit(super.value).join("");
	}
}

class DotAtom extends TokenList {
	static override readonly TYPE = "dot-atom";
}

class DotAtomText extends TokenList {
	static override readonly TYPE = "dot-atom-text";

	override get asEwAllowed(): boolean {
		return true;
	}
}

class NoFoldLiteral extends TokenList {
	static override readonly TYPE = "no-fold-literal";

	override get asEwAllowed(): boolean {
		return false;
	}
}

class AddrSpec extends TokenList {
	static override readonly TYPE = "addr-spec";

	override get asEwAllowed(): boolean {
		return false;
	}

	get localPart(): string {
		return (this.at(0) as LocalPart).localPart;
	}

	get domain(): string | null {
		if (this.length < 3) return null;
		return (this.at(-1) as Domain).domain;
	}

	override get value(): string {
		if (this.length < 3) return this.at(0).value;
		return pythonRstrip(this.at(0).value) + this.at(1).value + pythonLstrip(this.at(2).value);
	}
}

class ObsLocalPart extends TokenList {
	static override readonly TYPE = "obs-local-part";

	override get asEwAllowed(): boolean {
		return false;
	}
}

class DisplayName extends Phrase {
	static override readonly TYPE = "display-name";

	override get ewCombineAllowed(): boolean {
		return false;
	}

	get displayName(): string {
		const res = new TokenList(this.items);
		if (res.length === 0) return res.value;
		const first = res.at(0);
		if (first.tokenType === "cfws") res.items.shift();
		else if (!first.terminal && (first as TokenList).at(0).tokenType === "cfws") res.set(0, new TokenList((first as TokenList).items.slice(1)));
		const last = res.at(-1);
		if (last.tokenType === "cfws") res.items.pop();
		else if (!last.terminal && (last as TokenList).at(-1).tokenType === "cfws") res.set(-1, new TokenList((last as TokenList).items.slice(0, -1)));
		return res.value;
	}

	override get value(): string {
		let quote = false;
		if (this.defects.length) quote = true;
		else for (const x of this.items) if (x.tokenType === "quoted-string") quote = true;
		if (this.length !== 0 && quote) {
			let pre = "";
			let post = "";
			const first = this.at(0);
			if (first.tokenType === "cfws" || (!first.terminal && (first as TokenList).at(0).tokenType === "cfws")) pre = " ";
			const last = this.at(-1);
			if (last.tokenType === "cfws" || (!last.terminal && (last as TokenList).at(-1).tokenType === "cfws")) post = " ";
			return pre + quoteString(this.displayName) + post;
		}
		return super.value;
	}
}

class LocalPart extends TokenList {
	static override readonly TYPE = "local-part";

	override get asEwAllowed(): boolean {
		return false;
	}

	override get value(): string {
		const first = this.at(0);
		if (first.tokenType === "quoted-string") return (first as QuotedString).quotedValue;
		return first.value;
	}

	get localPart(): string {
		// Strip whitespace from front, back, and around dots.
		const res: Token[] = [DOT];
		let last: Token = DOT;
		let lastIsTl = false;
		const first = this.at(0) as TokenList;
		for (const tok of [...first.items, DOT]) {
			if (tok.tokenType === "cfws") continue;
			if (lastIsTl && tok.tokenType === "dot" && last.length > 0 && (last as TokenList).at(-1).tokenType === "cfws") {
				res[res.length - 1] = new TokenList((last as TokenList).items.slice(0, -1));
			}
			const isTl = !tok.terminal;
			if (isTl && last.tokenType === "dot" && tok.length > 0 && (tok as TokenList).at(0).tokenType === "cfws") res.push(new TokenList((tok as TokenList).items.slice(1)));
			else res.push(tok);
			last = res[res.length - 1] as Token;
			lastIsTl = isTl;
		}
		return new TokenList(res.slice(1, -1)).value;
	}
}

class DomainLiteral extends TokenList {
	static override readonly TYPE = "domain-literal";

	override get asEwAllowed(): boolean {
		return false;
	}

	get domain(): string {
		return pythonSplit(super.value).join("");
	}
}

export class HeaderLabel extends TokenList {
	static override readonly TYPE = "header-label";

	override get asEwAllowed(): boolean {
		return false;
	}
}

export class MsgID extends TokenList {
	static override readonly TYPE: string = "msg-id";

	override get asEwAllowed(): boolean {
		return false;
	}
}

class MessageIDList extends TokenList {
	static override readonly TYPE = "message-id-list";
}

class InvalidMessageID extends MsgID {
	static override readonly TYPE = "invalid-message-id";
}

export class Header extends TokenList {
	static override readonly TYPE = "header";
}

// The parser.

type Parsed<T extends Token = Token> = [T, string];

/** `_wsp_splitter(value, 1)`: [before, whitespace + after] or [value]. */
function wspSplit(value: string): [string, string] {
	const match = /[ \t]+/.exec(value);
	if (match === null) return [value, ""];
	return [value.slice(0, match.index), value.slice(match.index)];
}

function validateXtext(xtext: Terminal): void {
	const nonPrintables = xtext.text.match(/[\u0000- \u007f]/g);
	if (nonPrintables) xtext.defects.push(new Defect("NonPrintableDefect", nonPrintables.join("")));
	if (!xtext.text.isWellFormed()) xtext.defects.push(new Defect("UndecodableBytesDefect", "Non-ASCII characters found in header token"));
}

/** `_get_ptext_to_endchars`. */
function getPtextToEndchars(value: string, endchars: string): [string, string, boolean] {
	if (!value) return ["", "", false];
	const [fragment, remainder] = wspSplit(value);
	const vchars: string[] = [];
	let escape = false;
	let hadQp = false;
	let pos = 0;
	let broke = false;
	for (pos = 0; pos < fragment.length; pos++) {
		const char = fragment[pos] as string;
		if (char === "\\") {
			if (escape) {
				escape = false;
				hadQp = true;
			} else {
				escape = true;
				continue;
			}
		}
		if (escape) escape = false;
		else if (endchars.includes(char)) {
			broke = true;
			break;
		}
		vchars.push(char);
	}
	if (!broke) pos = fragment.length;
	return [vchars.join(""), fragment.slice(pos) + remainder, hadQp];
}

export function getFws(value: string): Parsed<Terminal> {
	const newvalue = pythonLstrip(value);
	return [whiteSpaceTerminal(value.slice(0, value.length - newvalue.length), "fws"), newvalue];
}

class InvalidEwError extends HeaderParseError {}

export function getEncodedWord(value: string, terminalType = "vtext"): Parsed<EncodedWord> {
	const ew = new EncodedWord();
	if (!value.startsWith("=?")) throw new HeaderParseError(`expected encoded word but found ${value}`);
	const body = value.slice(2);
	const split = body.indexOf("?=");
	let tok = split < 0 ? body : body.slice(0, split);
	let remainder = split < 0 ? [] : [body.slice(split + 2)];
	if (tok === body) throw new HeaderParseError(`expected encoded word but found ${value}`);
	const remstr = remainder.join("");
	if (remstr.length > 1 && HEXDIGITS.has(remstr[0] as string) && HEXDIGITS.has(remstr[1] as string) && tok.split("?").length - 1 < 2) {
		// The ? after the CTE was followed by an encoded word escape (=XX).
		const again = remstr.indexOf("?=");
		const rest = again < 0 ? remstr : remstr.slice(0, again);
		remainder = again < 0 ? [] : [remstr.slice(again + 2)];
		tok = `${tok}?=${rest}`;
	}
	if (pythonSplit(tok).length > 1) ew.defects.push(invalid("whitespace inside encoded word"));
	ew.cte = value;
	value = remainder.join("");
	let decoded: ReturnType<typeof decodeEncodedWord>;
	try {
		decoded = decodeEncodedWord(`=?${tok}?=`);
	} catch (error) {
		if (error instanceof ValueError || error instanceof KeyError) throw new InvalidEwError(`encoded word format invalid: '${ew.cte}'`);
		throw error;
	}
	let text = decoded.text;
	ew.charset = decoded.charset;
	ew.lang = decoded.lang;
	extend(ew.defects, decoded.defects);
	while (text) {
		if (WSP.has(text[0] as string)) {
			const [token, rest] = getFws(text);
			ew.append(token);
			text = rest;
			continue;
		}
		const [chars, rest] = wspSplit(text);
		const vtext = valueTerminal(chars, terminalType);
		validateXtext(vtext);
		ew.append(vtext);
		text = rest;
	}
	// Encoded words should be followed by a WS
	if (value && !WSP.has(value[0] as string)) ew.defects.push(invalid("missing trailing whitespace after encoded-word"));
	return [ew, value];
}

export function getUnstructured(value: string): UnstructuredTokenList {
	const unstructured = new UnstructuredTokenList();
	while (value) {
		if (WSP.has(value[0] as string)) {
			const [token, rest] = getFws(value);
			unstructured.append(token);
			value = rest;
			continue;
		}
		let validEw = true;
		if (value.startsWith("=?")) {
			let parsed: Parsed<EncodedWord> | null = null;
			try {
				parsed = getEncodedWord(value, "utext");
			} catch (error) {
				if (error instanceof InvalidEwError) validEw = false;
				else if (!(error instanceof HeaderParseError)) throw error;
			}
			if (parsed !== null) {
				const [token, rest] = parsed;
				value = rest;
				let haveWs = true;
				if (unstructured.length > 0 && unstructured.at(-1).tokenType !== "fws") {
					unstructured.defects.push(invalid("missing whitespace before encoded word"));
					haveWs = false;
				}
				if (haveWs && unstructured.length > 1 && unstructured.at(-2).tokenType === "encoded-word") {
					unstructured.set(-1, ewWhiteSpaceTerminal(str(unstructured.at(-1)), "fws"));
				}
				unstructured.append(token);
				continue;
			}
		}
		let [tok, rest] = wspSplit(value);
		// Split in the middle of an atom if there is a rfc2047 encoded word which does not have WSP on both
		// sides. The defect will be registered the next time through the loop.
		if (validEw && RFC2047.test(tok)) {
			const at = value.indexOf("=?");
			tok = value.slice(0, at);
			rest = value.slice(at);
		}
		const vtext = valueTerminal(tok, "utext");
		validateXtext(vtext);
		unstructured.append(vtext);
		value = rest;
	}
	return unstructured;
}

function getQpCtext(value: string): Parsed<Terminal> {
	const [text, rest] = getPtextToEndchars(value, "()");
	const ptext = whiteSpaceTerminal(text, "ptext");
	validateXtext(ptext);
	return [ptext, rest];
}

function getQcontent(value: string): Parsed<Terminal> {
	const [text, rest] = getPtextToEndchars(value, '"');
	const ptext = valueTerminal(text, "ptext");
	validateXtext(ptext);
	return [ptext, rest];
}

const NON_ATOM_END = /^[^()<>@,:;.\\"[\] \t]+/;

function getAtext(value: string): Parsed<Terminal> {
	const match = NON_ATOM_END.exec(value);
	if (match === null) throw new HeaderParseError(`expected atext but found '${value}'`);
	const text = match[0];
	const atext = valueTerminal(text, "atext");
	validateXtext(atext);
	return [atext, value.slice(text.length)];
}

function getBareQuotedString(value: string): Parsed<BareQuotedString> {
	if (!value || value[0] !== '"') throw new HeaderParseError(`expected '"' but found '${value}'`);
	const bare = new BareQuotedString();
	value = value.slice(1);
	if (value && value[0] === '"') return [bare, value.slice(1)];
	while (value && value[0] !== '"') {
		let token: Token;
		if (WSP.has(value[0] as string)) [token, value] = getFws(value);
		else if (value.slice(0, 2) === "=?") {
			let validEw = false;
			try {
				[token, value] = getEncodedWord(value);
				bare.defects.push(invalid("encoded word inside quoted string"));
				validEw = true;
			} catch (error) {
				if (!(error instanceof HeaderParseError)) throw error;
				[token, value] = getQcontent(value);
			}
			// Collapse the whitespace between two encoded words that occur in a bare-quoted-string.
			if (validEw && bare.length > 1 && bare.at(-1).tokenType === "fws" && bare.at(-2).tokenType === "encoded-word") {
				bare.set(-1, ewWhiteSpaceTerminal(str(bare.at(-1)), "fws"));
			}
		} else [token, value] = getQcontent(value);
		bare.append(token);
	}
	if (!value) {
		bare.defects.push(invalid("end of header inside quoted string"));
		return [bare, value];
	}
	return [bare, value.slice(1)];
}

function getComment(value: string): Parsed<Comment> {
	if (value && value[0] !== "(") throw new HeaderParseError(`expected '(' but found '${value}'`);
	const comment = new Comment();
	value = value.slice(1);
	while (value && value[0] !== ")") {
		let token: Token;
		if (WSP.has(value[0] as string)) [token, value] = getFws(value);
		else if (value[0] === "(") [token, value] = getComment(value);
		else [token, value] = getQpCtext(value);
		comment.append(token);
	}
	if (!value) {
		comment.defects.push(invalid("end of header inside comment"));
		return [comment, value];
	}
	return [comment, value.slice(1)];
}

function getCfws(value: string): Parsed<TokenList> {
	const cfws = new CFWSList();
	while (value && CFWS_LEADER.has(value[0] as string)) {
		let token: Token;
		if (WSP.has(value[0] as string)) [token, value] = getFws(value);
		else [token, value] = getComment(value);
		cfws.append(token);
	}
	return [cfws, value];
}

function getQuotedString(value: string): Parsed<QuotedString> {
	const quoted = new QuotedString();
	let token: Token;
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		quoted.append(token);
	}
	[token, value] = getBareQuotedString(value);
	quoted.append(token);
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		quoted.append(token);
	}
	return [quoted, value];
}

function getAtom(value: string): Parsed<Atom> {
	const atom = new Atom();
	let token: Token;
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		atom.append(token);
	}
	if (value && ATOM_ENDS.has(value[0] as string)) throw new HeaderParseError(`expected atom but found '${value}'`);
	if (value.startsWith("=?")) {
		try {
			[token, value] = getEncodedWord(value);
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			[token, value] = getAtext(value);
		}
	} else [token, value] = getAtext(value);
	atom.append(token);
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		atom.append(token);
	}
	return [atom, value];
}

function getDotAtomText(value: string): Parsed<DotAtomText> {
	const dotAtomText = new DotAtomText();
	if (!value || ATOM_ENDS.has(value[0] as string)) throw new HeaderParseError(`expected atom at a start of dot-atom-text but found '${value}'`);
	while (value && !ATOM_ENDS.has(value[0] as string)) {
		let token: Token;
		[token, value] = getAtext(value);
		dotAtomText.append(token);
		if (value && value[0] === ".") {
			dotAtomText.append(DOT);
			value = value.slice(1);
		}
	}
	if (dotAtomText.at(-1) === DOT) throw new HeaderParseError(`expected atom at end of dot-atom-text but found '.${value}'`);
	return [dotAtomText, value];
}

function getDotAtom(value: string): Parsed<DotAtom> {
	const dotAtom = new DotAtom();
	let token: Token;
	if (CFWS_LEADER.has(at(value, 0))) {
		[token, value] = getCfws(value);
		dotAtom.append(token);
	}
	if (value.startsWith("=?")) {
		try {
			[token, value] = getEncodedWord(value);
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			[token, value] = getDotAtomText(value);
		}
	} else [token, value] = getDotAtomText(value);
	dotAtom.append(token);
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		dotAtom.append(token);
	}
	return [dotAtom, value];
}

function getWord(value: string): Parsed<TokenList> {
	let leader: TokenList | null = null;
	if (CFWS_LEADER.has(at(value, 0))) [leader, value] = getCfws(value);
	if (!value) throw new HeaderParseError("Expected 'atom' or 'quoted-string' but found nothing.");
	let token: TokenList;
	if (value[0] === '"') [token, value] = getQuotedString(value);
	else if (SPECIALS.has(value[0] as string)) throw new HeaderParseError(`Expected 'atom' or 'quoted-string' but found '${value}'`);
	else [token, value] = getAtom(value);
	if (leader !== null) token.prepend(leader);
	return [token, value];
}

function getPhrase(value: string): Parsed<Phrase> {
	const phrase = new Phrase();
	try {
		const [token, rest] = getWord(value);
		value = rest;
		phrase.append(token);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		phrase.defects.push(invalid("phrase does not start with word"));
	}
	while (value && !PHRASE_ENDS.has(value[0] as string)) {
		if (value[0] === ".") {
			phrase.append(DOT);
			phrase.defects.push(obsolete("period in 'phrase'"));
			value = value.slice(1);
			continue;
		}
		let token: Token;
		try {
			[token, value] = getWord(value);
			const last = phrase.length > 0 ? phrase.at(-1) : null;
			if (
				(token as TokenList).at(0).tokenType === "encoded-word" &&
				last !== null &&
				last.tokenType === "atom" &&
				last.length > 1 &&
				(last as TokenList).at(-2).tokenType === "encoded-word" &&
				(last as TokenList).at(-1).tokenType === "cfws" &&
				(last as TokenList).at(-1).comments.length === 0
			) {
				// linear ws between ews needs special handing...
				(last as TokenList).set(-1, ewWhiteSpaceTerminal(str(last), "fws"));
			}
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			if (CFWS_LEADER.has(value[0] as string)) {
				[token, value] = getCfws(value);
				phrase.defects.push(obsolete("comment found without atom"));
			} else throw error;
		}
		phrase.append(token);
	}
	return [phrase, value];
}

function getLocalPart(value: string): Parsed<LocalPart> {
	const localPart = new LocalPart();
	let leader: TokenList | null = null;
	if (value && CFWS_LEADER.has(value[0] as string)) [leader, value] = getCfws(value);
	if (!value) throw new HeaderParseError(`expected local-part but found '${value}'`);
	let token: TokenList;
	try {
		[token, value] = getDotAtom(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			[token, value] = getWord(value);
		} catch (inner) {
			if (!(inner instanceof HeaderParseError)) throw inner;
			if (value[0] !== "\\" && PHRASE_ENDS.has(value[0] as string)) throw inner;
			token = new TokenList();
		}
	}
	if (leader !== null) token.prepend(leader);
	localPart.append(token);
	if (value && (value[0] === "\\" || !PHRASE_ENDS.has(value[0] as string))) {
		let obs: ObsLocalPart;
		[obs, value] = getObsLocalPart(localPart.str() + value);
		if (obs.tokenType === "invalid-obs-local-part") localPart.defects.push(invalid("local-part is not dot-atom, quoted-string, or obs-local-part"));
		else localPart.defects.push(obsolete("local-part is not a dot-atom (contains CFWS)"));
		localPart.set(0, obs);
	}
	if (!/^[\u0000-\u007f]*$/.test(localPart.value)) localPart.defects.push(new Defect("NonASCIILocalPartDefect", "local-part contains non-ASCII characters)"));
	return [localPart, value];
}

function getObsLocalPart(value: string): Parsed<ObsLocalPart> {
	const obs = new ObsLocalPart();
	let lastNonWsWasDot = false;
	while (value && (value[0] === "\\" || !PHRASE_ENDS.has(value[0] as string))) {
		if (value[0] === ".") {
			if (lastNonWsWasDot) obs.defects.push(invalid("invalid repeated '.'"));
			obs.append(DOT);
			lastNonWsWasDot = true;
			value = value.slice(1);
			continue;
		}
		if (value[0] === "\\") {
			obs.append(valueTerminal(value[0], "misplaced-special"));
			value = value.slice(1);
			obs.defects.push(invalid("'\\' character outside of quoted-string/ccontent"));
			lastNonWsWasDot = false;
			continue;
		}
		if (obs.length > 0 && obs.at(-1).tokenType !== "dot") obs.defects.push(invalid("missing '.' between words"));
		let token: Token;
		try {
			[token, value] = getWord(value);
			lastNonWsWasDot = false;
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			if (!CFWS_LEADER.has(value[0] as string)) throw error;
			[token, value] = getCfws(value);
		}
		obs.append(token);
	}
	if (obs.length === 0) throw new HeaderParseError(`expected obs-local-part but found '${value}'`);
	if (obs.at(0).tokenType === "dot" || (obs.at(0).tokenType === "cfws" && obs.length > 1 && obs.at(1).tokenType === "dot")) {
		obs.defects.push(invalid("Invalid leading '.' in local part"));
	}
	if (obs.at(-1).tokenType === "dot" || (obs.at(-1).tokenType === "cfws" && obs.length > 1 && obs.at(-2).tokenType === "dot")) {
		obs.defects.push(invalid("Invalid trailing '.' in local part"));
	}
	if (obs.defects.length) obs.tokenType = "invalid-obs-local-part";
	return [obs, value];
}

function getDtext(value: string): Parsed<Terminal> {
	const [text, rest, hadQp] = getPtextToEndchars(value, "[]");
	const ptext = valueTerminal(text, "ptext");
	if (hadQp) ptext.defects.push(obsolete("quoted printable found in domain-literal"));
	validateXtext(ptext);
	return [ptext, rest];
}

function checkForEarlyDlEnd(value: string, domainLiteral: DomainLiteral): boolean {
	if (value) return false;
	domainLiteral.defects.push(invalid("end of input inside domain-literal"));
	domainLiteral.append(valueTerminal("]", "domain-literal-end"));
	return true;
}

function getDomainLiteral(value: string): Parsed<DomainLiteral> {
	const domainLiteral = new DomainLiteral();
	let token: Token;
	if (CFWS_LEADER.has(at(value, 0))) {
		[token, value] = getCfws(value);
		domainLiteral.append(token);
	}
	if (!value) throw new HeaderParseError("expected domain-literal");
	if (value[0] !== "[") throw new HeaderParseError(`expected '[' at start of domain-literal but found '${value}'`);
	value = value.slice(1);
	domainLiteral.append(valueTerminal("[", "domain-literal-start"));
	if (checkForEarlyDlEnd(value, domainLiteral)) return [domainLiteral, value];
	if (WSP.has(value[0] as string)) {
		[token, value] = getFws(value);
		domainLiteral.append(token);
	}
	[token, value] = getDtext(value);
	domainLiteral.append(token);
	if (checkForEarlyDlEnd(value, domainLiteral)) return [domainLiteral, value];
	if (WSP.has(value[0] as string)) {
		[token, value] = getFws(value);
		domainLiteral.append(token);
	}
	if (checkForEarlyDlEnd(value, domainLiteral)) return [domainLiteral, value];
	if (value[0] !== "]") throw new HeaderParseError(`expected ']' at end of domain-literal but found '${value}'`);
	domainLiteral.append(valueTerminal("]", "domain-literal-end"));
	value = value.slice(1);
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		domainLiteral.append(token);
	}
	return [domainLiteral, value];
}

function getDomain(value: string): Parsed<Domain> {
	const domain = new Domain();
	let leader: TokenList | null = null;
	if (value && CFWS_LEADER.has(value[0] as string)) [leader, value] = getCfws(value);
	if (!value) throw new HeaderParseError(`expected domain but found '${value}'`);
	let token: TokenList;
	if (value[0] === "[") {
		[token, value] = getDomainLiteral(value);
		if (leader !== null) token.prepend(leader);
		domain.append(token);
		return [domain, value];
	}
	try {
		[token, value] = getDotAtom(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		[token, value] = getAtom(value);
	}
	if (value && value[0] === "@") throw new HeaderParseError("Invalid Domain");
	if (leader !== null) token.prepend(leader);
	domain.append(token);
	if (value && value[0] === ".") {
		domain.defects.push(obsolete("domain is not a dot-atom (contains CFWS)"));
		if (domain.at(0).tokenType === "dot-atom") domain.items = [...(domain.at(0) as TokenList).items];
		while (value && value[0] === ".") {
			domain.append(DOT);
			[token, value] = getAtom(value.slice(1));
			domain.append(token);
		}
	}
	return [domain, value];
}

function getAddrSpec(value: string): Parsed<AddrSpec> {
	const addrSpec = new AddrSpec();
	let token: Token;
	[token, value] = getLocalPart(value);
	addrSpec.append(token);
	if (!value || value[0] !== "@") {
		addrSpec.defects.push(invalid("addr-spec local part with no domain"));
		return [addrSpec, value];
	}
	addrSpec.append(valueTerminal("@", "address-at-symbol"));
	[token, value] = getDomain(value.slice(1));
	addrSpec.append(token);
	return [addrSpec, value];
}

function getObsRoute(value: string): Parsed<ObsRoute> {
	const obsRoute = new ObsRoute();
	let token: Token;
	while (value && (value[0] === "," || CFWS_LEADER.has(value[0] as string))) {
		if (CFWS_LEADER.has(value[0] as string)) {
			[token, value] = getCfws(value);
			obsRoute.append(token);
		} else if (value[0] === ",") {
			obsRoute.append(ListSeparator);
			value = value.slice(1);
		}
	}
	if (!value || value[0] !== "@") throw new HeaderParseError(`expected obs-route domain but found '${value}'`);
	obsRoute.append(RouteComponentMarker);
	[token, value] = getDomain(value.slice(1));
	obsRoute.append(token);
	while (value && value[0] === ",") {
		obsRoute.append(ListSeparator);
		value = value.slice(1);
		if (!value) break;
		if (CFWS_LEADER.has(value[0] as string)) {
			[token, value] = getCfws(value);
			obsRoute.append(token);
		}
		if (!value) break;
		if (value[0] === "@") {
			obsRoute.append(RouteComponentMarker);
			[token, value] = getDomain(value.slice(1));
			obsRoute.append(token);
		}
	}
	if (!value) throw new HeaderParseError("end of header while parsing obs-route");
	if (value[0] !== ":") throw new HeaderParseError(`expected ':' marking end of obs-route but found '${value}'`);
	obsRoute.append(valueTerminal(":", "end-of-obs-route-marker"));
	return [obsRoute, value.slice(1)];
}

function getAngleAddr(value: string): Parsed<AngleAddr> {
	const angleAddr = new AngleAddr();
	let token: Token;
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		angleAddr.append(token);
	}
	if (!value || value[0] !== "<") throw new HeaderParseError(`expected angle-addr but found '${value}'`);
	angleAddr.append(valueTerminal("<", "angle-addr-start"));
	value = value.slice(1);
	// Although it is not legal per RFC5322, SMTP uses '<>' in certain circumstances.
	if (value && value[0] === ">") {
		angleAddr.append(valueTerminal(">", "angle-addr-end"));
		angleAddr.defects.push(invalid("null addr-spec in angle-addr"));
		return [angleAddr, value.slice(1)];
	}
	try {
		[token, value] = getAddrSpec(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			[token, value] = getObsRoute(value);
			angleAddr.defects.push(obsolete("obsolete route specification in angle-addr"));
		} catch (inner) {
			if (!(inner instanceof HeaderParseError)) throw inner;
			throw new HeaderParseError(`expected addr-spec or obs-route but found '${value}'`);
		}
		angleAddr.append(token);
		[token, value] = getAddrSpec(value);
	}
	angleAddr.append(token);
	if (value && value[0] === ">") value = value.slice(1);
	else angleAddr.defects.push(invalid("missing trailing '>' on angle-addr"));
	angleAddr.append(valueTerminal(">", "angle-addr-end"));
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		angleAddr.append(token);
	}
	return [angleAddr, value];
}

function getDisplayName(value: string): Parsed<DisplayName> {
	const displayName = new DisplayName();
	const [token, rest] = getPhrase(value);
	extend(displayName.items, token.items);
	displayName.defects = [...token.defects];
	return [displayName, rest];
}

function getNameAddr(value: string): Parsed<NameAddr> {
	const nameAddr = new NameAddr();
	let leader: TokenList | null = null;
	if (!value) throw new HeaderParseError(`expected name-addr but found '${value}'`);
	if (CFWS_LEADER.has(value[0] as string)) {
		[leader, value] = getCfws(value);
		if (!value) throw new HeaderParseError(`expected name-addr but found '${leader.str()}'`);
	}
	if (value[0] !== "<") {
		if (PHRASE_ENDS.has(value[0] as string)) throw new HeaderParseError(`expected name-addr but found '${value}'`);
		let token: DisplayName;
		[token, value] = getDisplayName(value);
		if (!value) throw new HeaderParseError(`expected name-addr but found '${token.str()}'`);
		if (leader !== null) {
			const first = token.at(0);
			if (!first.terminal) (first as TokenList).prepend(leader);
			else token.prepend(leader);
			leader = null;
		}
		nameAddr.append(token);
	}
	const [token, rest] = getAngleAddr(value);
	if (leader !== null) token.prepend(leader);
	nameAddr.append(token);
	return [nameAddr, rest];
}

function getMailbox(value: string): Parsed<Mailbox> {
	// The only way to figure out if we are dealing with a name-addr or an addr-spec is to try parsing each one.
	const mailbox = new Mailbox();
	let token: TokenList;
	try {
		[token, value] = getNameAddr(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			[token, value] = getAddrSpec(value);
		} catch (inner) {
			if (!(inner instanceof HeaderParseError)) throw inner;
			throw new HeaderParseError(`expected mailbox but found '${value}'`);
		}
	}
	if (token.allDefects.some((defect) => defect.kind === "InvalidHeaderDefect")) mailbox.tokenType = "invalid-mailbox";
	mailbox.append(token);
	return [mailbox, value];
}

function getInvalidMailbox(value: string, endchars: string): Parsed<InvalidMailbox> {
	const invalidMailbox = new InvalidMailbox();
	while (value && !endchars.includes(value[0] as string)) {
		if (PHRASE_ENDS.has(value[0] as string)) {
			invalidMailbox.append(valueTerminal(value[0] as string, "misplaced-special"));
			value = value.slice(1);
		} else {
			let token: Token;
			[token, value] = getPhrase(value);
			invalidMailbox.append(token);
		}
	}
	return [invalidMailbox, value];
}

function getMailboxList(value: string): Parsed<MailboxList> {
	const mailboxList = new MailboxList();
	while (value && value[0] !== ";") {
		try {
			let token: Token;
			[token, value] = getMailbox(value);
			mailboxList.append(token);
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			let leader: TokenList | null = null;
			if (CFWS_LEADER.has(value[0] as string)) {
				[leader, value] = getCfws(value);
				if (!value || ",;".includes(value[0] as string)) {
					mailboxList.append(leader);
					mailboxList.defects.push(obsolete("empty element in mailbox-list"));
				} else {
					let token: InvalidMailbox;
					[token, value] = getInvalidMailbox(value, ",;");
					if (leader !== null) token.prepend(leader);
					mailboxList.append(token);
					mailboxList.defects.push(invalid("invalid mailbox in mailbox-list"));
				}
			} else if (value[0] === ",") {
				mailboxList.defects.push(obsolete("empty element in mailbox-list"));
			} else {
				let token: InvalidMailbox;
				[token, value] = getInvalidMailbox(value, ",;");
				if (leader !== null) token.prepend(leader);
				mailboxList.append(token);
				mailboxList.defects.push(invalid("invalid mailbox in mailbox-list"));
			}
		}
		if (value && !",;".includes(value[0] as string)) {
			// Crap after mailbox; treat it as an invalid mailbox. The mailbox info will still be available.
			const mailbox = mailboxList.at(-1) as TokenList;
			mailbox.tokenType = "invalid-mailbox";
			let token: InvalidMailbox;
			[token, value] = getInvalidMailbox(value, ",;");
			extend(mailbox.items, token.items);
			mailboxList.defects.push(invalid("invalid mailbox in mailbox-list"));
		}
		if (value && value[0] === ",") {
			mailboxList.append(ListSeparator);
			value = value.slice(1);
		}
	}
	return [mailboxList, value];
}

function getGroupList(value: string): Parsed<GroupList> {
	const groupList = new GroupList();
	if (!value) {
		groupList.defects.push(invalid("end of header before group-list"));
		return [groupList, value];
	}
	let leader: TokenList | null = null;
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[leader, value] = getCfws(value);
		if (!value) {
			// This should never happen in email parsing, since CFWS-only is a legal alternative to group-list.
			groupList.defects.push(invalid("end of header in group-list"));
			groupList.append(leader);
			return [groupList, value];
		}
		if (value[0] === ";") {
			groupList.append(leader);
			return [groupList, value];
		}
	}
	let token: MailboxList;
	[token, value] = getMailboxList(value);
	if (token.allMailboxes.length === 0) {
		if (leader !== null) groupList.append(leader);
		extend(groupList.items, token.items);
		groupList.defects.push(obsolete("group-list with empty entries"));
		return [groupList, value];
	}
	if (leader !== null) token.prepend(leader);
	groupList.append(token);
	return [groupList, value];
}

function getGroup(value: string): Parsed<Group> {
	const group = new Group();
	let token: Token;
	[token, value] = getDisplayName(value);
	if (!value || value[0] !== ":") throw new HeaderParseError(`expected ':' at end of group display name but found '${value}'`);
	group.append(token);
	group.append(valueTerminal(":", "group-display-name-terminator"));
	value = value.slice(1);
	if (value && value[0] === ";") {
		group.append(valueTerminal(";", "group-terminator"));
		return [group, value.slice(1)];
	}
	[token, value] = getGroupList(value);
	group.append(token);
	if (!value) group.defects.push(invalid("end of header in group"));
	else if (value[0] !== ";") throw new HeaderParseError(`expected ';' at end of group but found ${value}`);
	group.append(valueTerminal(";", "group-terminator"));
	value = value.slice(1);
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		group.append(token);
	}
	return [group, value];
}

function getAddress(value: string): Parsed<Address> {
	const address = new Address();
	let token: Token;
	try {
		[token, value] = getGroup(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			[token, value] = getMailbox(value);
		} catch (inner) {
			if (!(inner instanceof HeaderParseError)) throw inner;
			throw new HeaderParseError(`expected address but found '${value}'`);
		}
	}
	address.append(token);
	return [address, value];
}

/** `get_address_list`: the whole value, invalid addresses kept as invalid mailboxes with defects. */
export function getAddressList(value: string): AddressList {
	const addressList = new AddressList();
	while (value) {
		try {
			let token: Token;
			[token, value] = getAddress(value);
			addressList.append(token);
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			let leader: TokenList | null = null;
			if (CFWS_LEADER.has(value[0] as string)) {
				[leader, value] = getCfws(value);
				if (!value || value[0] === ",") {
					addressList.append(leader);
					addressList.defects.push(obsolete("address-list entry with no content"));
				} else {
					let token: InvalidMailbox;
					[token, value] = getInvalidMailbox(value, ",");
					if (leader !== null) token.prepend(leader);
					addressList.append(new Address([token]));
					addressList.defects.push(invalid("invalid address in address-list"));
				}
			} else if (value[0] === ",") {
				addressList.defects.push(obsolete("empty element in address-list"));
			} else {
				let token: InvalidMailbox;
				[token, value] = getInvalidMailbox(value, ",");
				if (leader !== null) token.prepend(leader);
				addressList.append(new Address([token]));
				addressList.defects.push(invalid("invalid address in address-list"));
			}
		}
		if (value && value[0] !== ",") {
			// Crap after address: add it to the address list as an invalid mailbox
			let token: InvalidMailbox;
			[token, value] = getInvalidMailbox(value, ",");
			addressList.append(new Address([token]));
			addressList.defects.push(invalid("invalid address in address-list"));
		}
		if (value) {
			// Must be a , at this point.
			addressList.append(ListSeparator);
			value = value.slice(1);
		}
	}
	return addressList;
}

function getNoFoldLiteral(value: string): Parsed<NoFoldLiteral> {
	const literal = new NoFoldLiteral();
	if (!value) throw new HeaderParseError(`expected no-fold-literal but found '${value}'`);
	if (value[0] !== "[") throw new HeaderParseError(`expected '[' at the start of no-fold-literal but found '${value}'`);
	literal.append(valueTerminal("[", "no-fold-literal-start"));
	value = value.slice(1);
	let token: Token;
	[token, value] = getDtext(value);
	literal.append(token);
	if (!value || value[0] !== "]") throw new HeaderParseError(`expected ']' at the end of no-fold-literal but found '${value}'`);
	literal.append(valueTerminal("]", "no-fold-literal-end"));
	return [literal, value.slice(1)];
}

function getMsgId(value: string): Parsed<MsgID> {
	const msgId = new MsgID();
	let token: Token;
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		msgId.append(token);
	}
	if (!value || value[0] !== "<") throw new HeaderParseError(`expected msg-id but found '${value}'`);
	msgId.append(valueTerminal("<", "msg-id-start"));
	value = value.slice(1);
	// Parse id-left.
	try {
		[token, value] = getDotAtomText(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			// obs-id-left is same as local-part of add-spec.
			[token, value] = getObsLocalPart(value);
			msgId.defects.push(obsolete("obsolete id-left in msg-id"));
		} catch (inner) {
			if (!(inner instanceof HeaderParseError)) throw inner;
			throw new HeaderParseError(`expected dot-atom-text or obs-id-left but found '${value}'`);
		}
	}
	msgId.append(token);
	if (!value || value[0] !== "@") {
		msgId.defects.push(invalid("msg-id with no id-right"));
		// Even though there is no id-right, if the local part ends with `>` let's just parse it too.
		if (value && value[0] === ">") {
			msgId.append(valueTerminal(">", "msg-id-end"));
			value = value.slice(1);
		}
		return [msgId, value];
	}
	msgId.append(valueTerminal("@", "address-at-symbol"));
	value = value.slice(1);
	// Parse id-right.
	try {
		[token, value] = getDotAtomText(value);
	} catch (error) {
		if (!(error instanceof HeaderParseError)) throw error;
		try {
			[token, value] = getNoFoldLiteral(value);
		} catch (second) {
			if (!(second instanceof HeaderParseError)) throw second;
			try {
				[token, value] = getDomain(value);
				msgId.defects.push(obsolete("obsolete id-right in msg-id"));
			} catch (third) {
				if (!(third instanceof HeaderParseError)) throw third;
				throw new HeaderParseError(`expected dot-atom-text, no-fold-literal or obs-id-right but found '${value}'`);
			}
		}
	}
	msgId.append(token);
	if (value && value[0] === ">") value = value.slice(1);
	else msgId.defects.push(invalid("missing trailing '>' on msg-id"));
	msgId.append(valueTerminal(">", "msg-id-end"));
	if (value && CFWS_LEADER.has(value[0] as string)) {
		[token, value] = getCfws(value);
		msgId.append(token);
	}
	return [msgId, value];
}

/** `parse_message_ids`: In-Reply-To and References. */
export function parseMessageIds(value: string): TokenList {
	const list = new MessageIDList();
	while (value) {
		if (value[0] === ",") {
			// message id list separated with commas - this is invalid, but happens rather frequently in the wild
			list.defects.push(invalid("comma in msg-id list"));
			list.append(whiteSpaceTerminal(" ", "invalid-comma-replacement"));
			value = value.slice(1);
			continue;
		}
		try {
			let token: Token;
			[token, value] = getMsgId(value);
			list.append(token);
		} catch (error) {
			if (!(error instanceof HeaderParseError)) throw error;
			const token = getUnstructured(value);
			list.append(new InvalidMessageID(token.items));
			list.defects.push(invalid(`Invalid msg-id: ${error.message}`));
			break;
		}
	}
	return list;
}

