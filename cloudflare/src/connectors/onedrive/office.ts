// Text out of Word, PowerPoint and Excel files (Office Open XML), for reading only, ported from
// backend/connectors/onedrive/office.py.
//
// These files are zip archives of XML parts (zip.ts), and only the parts that hold the text are read. Each
// part is streamed through a SAX parser (saxes, with namespaces), which keeps no tree. A document type
// declaration, and with it any entity, is refused. Decompression is metered across all the parts read, 64
// KiB at a time as today, and reading stops once the text reaches its limit. Nothing a document refers to
// is fetched or opened: links, embedded objects and external relationships are ignored. Formulas are not
// evaluated, so Excel cells give the values the file stored.
//
// The work is synchronous and bounded, and runs in the Worker that serves the call: these limits, not
// isolation, are what contain a hostile file.
//
// Where it differs from Python's expat: parts are read as UTF-8, or UTF-16 with a byte order mark (what
// Office writes); a part that declares another encoding is unreadable here, where expat would decode a
// single-byte one. saxes and expat refuse the same malformed XML in all but corner cases.

import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { OperationError } from "../../gateway/connector.ts";
import { codePointLength, sliceCodePoints } from "../../lib/text.ts";
import { DIGIT_CLASS, decimalValue, isDigitOnly } from "../../lib/digits.ts";
import { BadZip, Zip } from "./zip.ts";

export const MAX_ENTRIES = 5000;
/** Bytes decompressed across every part read, whatever the text they yield. */
export const MAX_EXPANDED = 32 * 1024 * 1024;
export const MAX_SHARED_TEXT = 4 * 1024 * 1024;
export const MAX_SHARED_STRINGS = 1_000_000;
export const MAX_SLIDES = 1000;
export const MAX_COLUMNS = 200;
export const CHUNK = 64 * 1024;
/** Python's `int()` refuses strings of more digits (sys.int_info.default_max_str_digits). */
const MAX_INT_DIGITS = 4300;
/** `\A([A-Z]{1,3})\d+\Z`, where Python's `\d` is any decimal digit (Unicode 16). */
const CELL = new RegExp(`^([A-Z]{1,3})${DIGIT_CLASS}+$`, "u");
const DECIMAL = new RegExp(`^${DIGIT_CLASS}$`, "u");
const XMLNS = "http://www.w3.org/2000/xmlns/";

export type Kind = "docx" | "pptx" | "xlsx";

export function unreadable(): OperationError {
	return new OperationError("UNSUPPORTED_FILE", "Minerva could not read this file: it is damaged, protected, or not a valid Office file.");
}

function tooLarge(): OperationError {
	return new OperationError("FILE_TOO_LARGE", "This file expands to more than Minerva reads.");
}

/** The text reached its limit; reading stops. */
class Full extends Error {}

/** A ValueError raised while a part is read: the part is unreadable. */
class Unparsable extends Error {}

class Text {
	readonly limit: number;
	readonly parts: string[] = [];
	size = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	get full(): boolean {
		return this.size >= this.limit;
	}

	get remaining(): number {
		return Math.max(this.limit - this.size, 0);
	}

	add(value: string): void {
		if (this.full) throw new Full();
		const kept = sliceCodePoints(value, 0, this.remaining);
		this.parts.push(kept);
		this.size += codePointLength(kept);
	}

	value(): string {
		return sliceCodePoints(this.parts.join(""), 0, this.limit);
	}
}

type Attrs = Map<string, string>;
type Start = (name: string, attrs: Attrs) => void;
type End = (name: string) => void;
type Chars = (data: string) => void;

/** An element or attribute name without its namespace (expat joins them with a space). */
function local(name: string): string {
	return name.slice(name.lastIndexOf(" ") + 1);
}

/**
 * The attributes as office.py sees them: `{local(k): v for k, v in attrs} | attrs`, where expat names a
 * namespaced attribute "uri local" and leaves out namespace declarations.
 */
function attrsOf(attributes: Record<string, SaxesAttributeNS>): Attrs {
	const named: [string, string][] = [];
	for (const attribute of Object.values(attributes)) {
		if (attribute.uri === XMLNS || attribute.name === "xmlns" || attribute.prefix === "xmlns") continue;
		named.push([attribute.prefix ? `${attribute.uri} ${attribute.local}` : attribute.local, attribute.value]);
	}
	const attrs: Attrs = new Map();
	for (const [key, value] of named) attrs.set(local(key), value);
	for (const [key, value] of named) attrs.set(key, value);
	return attrs;
}

function relationshipId(attrs: Attrs): string | null {
	for (const [key, value] of attrs) {
		if (key.includes(" ") && key.endsWith(" id") && (key.split(" ")[0] as string).endsWith("/relationships")) return value;
	}
	return null;
}

/** `posixpath.split`. */
function split(path: string): [string, string] {
	const at = path.lastIndexOf("/") + 1;
	let head = path.slice(0, at);
	const tail = path.slice(at);
	if (head && head !== "/".repeat(head.length)) head = head.replace(/\/+$/, "");
	return [head, tail];
}

/** `posixpath.join`. */
function join(first: string, ...rest: string[]): string {
	let path = first;
	for (const part of rest) {
		if (part.startsWith("/")) path = part;
		else if (!path || path.endsWith("/")) path += part;
		else path += `/${part}`;
	}
	return path;
}

/** `posixpath.normpath`. */
export function normpath(path: string): string {
	if (path === "") return ".";
	const initial = path.startsWith("/") ? (path.startsWith("//") && !path.startsWith("///") ? 2 : 1) : 0;
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== ".." || (!initial && !parts.length) || (parts.length && parts[parts.length - 1] === "..")) parts.push(part);
		else if (parts.length) parts.pop();
	}
	const joined = "/".repeat(initial) + parts.join("/");
	return joined || ".";
}

/** An XML declaration's version, up to its closing quote. */
const VERSION = /^<\?xml([ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*)(["'])[A-Za-z0-9._-]*\2/;

/** The encoding an XML declaration names, if the text starts with one. */
const DECLARED = /^<\?xml\s[^?>]*\bencoding\s*=\s*["']([^"']*)["']/;

/**
 * The part's bytes as text, decoded as they stream, as expat reads them: UTF-16 after its byte order mark or
 * when the first two bytes are a zero and a character, else UTF-8 (a byte order mark skipped), or ISO-8859-1 or
 * US-ASCII when the declaration says so; invalid sequences refused. A declaration that contradicts the bytes
 * is refused (expat's "encoding specified in XML declaration is incorrect"), and so is one that names any
 * other encoding (Python's expat also reads other single-byte codecs).
 */
class Decoder {
	#utf8: TextDecoder | null = null;
	#single: "latin1" | "ascii" | null = null;
	/** Little or big endian UTF-16, decoded here (the runtime's TextDecoder may know only UTF-8). */
	#utf16: { little: boolean; pending: number[]; high: number | null; head: string | null } | null = null;

	write(bytes: Uint8Array, final: boolean): string {
		if (this.#utf8 === null && this.#single === null && this.#utf16 === null) {
			if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
				this.#utf16 = { little: bytes[0] === 0xff, pending: [], high: null, head: "" };
				bytes = bytes.subarray(2);
			} else if (bytes.length > 1 && (bytes[0] === 0) !== (bytes[1] === 0)) {
				// No byte order mark: a zero byte beside a character's other byte, as expat tells UTF-16 apart.
				this.#utf16 = { little: bytes[1] === 0, pending: [], high: null, head: "" };
			} else {
				if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
				const declared = DECLARED.exec(String.fromCharCode(...bytes.subarray(0, 256)));
				const name = declared === null ? "utf-8" : (declared[1] as string).toLowerCase();
				if (name === "utf-8") this.#utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
				else if (name === "iso-8859-1") this.#single = "latin1";
				else if (name === "us-ascii") this.#single = "ascii";
				else throw new Unparsable("encoding");
			}
		}
		if (this.#utf8 !== null) return this.#utf8.decode(bytes, { stream: !final });
		if (this.#single !== null) {
			let out = "";
			for (let at = 0; at < bytes.length; at += 8192) {
				const piece = bytes.subarray(at, at + 8192);
				if (this.#single === "ascii" && piece.some((byte) => byte > 0x7f)) throw new Unparsable("us-ascii");
				out += String.fromCharCode(...piece);
			}
			return out;
		}
		const state = this.#utf16 as { little: boolean; pending: number[]; high: number | null; head: string | null };
		const units = [...state.pending, ...bytes];
		let out = "";
		let at = 0;
		for (; at + 1 < units.length; at += 2) {
			const unit = state.little ? (units[at] as number) | ((units[at + 1] as number) << 8) : ((units[at] as number) << 8) | (units[at + 1] as number);
			if (state.high !== null) {
				if (unit < 0xdc00 || unit > 0xdfff) throw new Unparsable("utf-16");
				out += String.fromCharCode(state.high, unit);
				state.high = null;
			} else if (unit >= 0xd800 && unit <= 0xdbff) state.high = unit;
			else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Unparsable("utf-16");
			else out += String.fromCharCode(unit);
		}
		state.pending = units.slice(at);
		if (final && (state.pending.length || state.high !== null)) throw new Unparsable("utf-16");
		if (state.head !== null) {
			// The declaration is read once 256 characters are in: UTF-16 or the variant of this byte order only.
			state.head += out;
			if (state.head.length >= 256 || final) {
				const declared = DECLARED.exec(state.head.slice(0, 256));
				state.head = null;
				const name = declared === null ? "utf-16" : (declared[1] as string).toLowerCase();
				if (name !== "utf-16" && name !== (state.little ? "utf-16le" : "utf-16be")) throw new Unparsable("encoding");
			}
		}
		return out;
	}
}

/** saxes's own state: text it holds back until the next markup, and where it is. */
interface Pending {
	text: string;
	state: number;
	entityReturnState: number;
	tags: unknown[];
}
const S_TEXT = 13;
const S_ENTITY = 14;

/**
 * Hands the text saxes holds at the end of a chunk to `chars` now, as expat hands over the text of each chunk
 * it parsed, so a long run of text stops being read once the text is full, as it does today.
 */
function flushText(parser: SaxesParser<{ xmlns: true }>, chars: Chars): void {
	const pending = parser as unknown as Pending;
	if (!pending.text || !pending.tags.length) return;
	if (pending.state === S_TEXT || (pending.state === S_ENTITY && pending.entityReturnState === S_TEXT)) {
		const text = pending.text;
		pending.text = "";
		chars(text);
	}
}

/** The prefixes bound before any element (saxes' root namespaces). */
const ROOT_NAMESPACES: Readonly<Record<string, string>> = { xml: "http://www.w3.org/XML/1998/namespace", xmlns: "http://www.w3.org/2000/xmlns/" };

/**
 * saxes resolves a prefix by walking every open element, so nesting costs the square of its depth (20,000
 * nested elements took over a second, expat a few milliseconds). Here the bindings in scope are kept per
 * prefix as elements open and close (`Archive.parse` keeps them), so a lookup is one step and finds what
 * saxes would: the element's own declarations, then the nearest open element's, then xml and xmlns. An
 * override on the class, not the instance: a property added to a parser slows every access saxes makes.
 */
class ScopedParser extends SaxesParser<{ xmlns: true; position: false }> {
	readonly scopes = new Map<string, string[]>();
	opening: SaxesTagNS | null = null;

	override resolve(prefix: string): string | undefined {
		return this.opening?.ns[prefix] ?? this.scopes.get(prefix)?.at(-1) ?? (Object.hasOwn(ROOT_NAMESPACES, prefix) ? ROOT_NAMESPACES[prefix] : undefined);
	}
}

export class Archive {
	readonly zip: Zip;

	constructor(zip: Zip) {
		this.zip = zip;
	}

	/** The archive's directory; the limits on its entries and on what is inflated are zip.ts's. */
	static async open(data: Uint8Array): Promise<Archive> {
		try {
			return new Archive(await Zip.open(data, { entries: MAX_ENTRIES, bytes: MAX_EXPANDED, overflow: tooLarge }));
		} catch (error) {
			if (error instanceof BadZip) throw unreadable();
			throw error;
		}
	}

	has(name: string): boolean {
		return this.zip.has(name);
	}

	async parse(name: string, start: Start, end: End | null = null, chars: Chars | null = null): Promise<void> {
		const parser = new ScopedParser({ xmlns: true, position: false });
		parser.on("doctype", () => {
			throw unreadable();
		});
		parser.on("opentagstart", (tag) => {
			parser.opening = tag as SaxesTagNS;
		});
		parser.on("closetag", (tag) => {
			for (const prefix of Object.keys((tag as SaxesTagNS).ns)) parser.scopes.get(prefix)?.pop();
			if (end !== null) end(local((tag as SaxesTagNS).local));
		});
		parser.on("opentag", (tag) => {
			for (const [prefix, uri] of Object.entries((tag as SaxesTagNS).ns)) {
				const scope = parser.scopes.get(prefix);
				if (scope === undefined) parser.scopes.set(prefix, [uri]);
				else scope.push(uri);
			}
			parser.opening = null;
			const attributes = (tag as SaxesTagNS).attributes;
			// expat joins a namespace and a name with a space, so it refuses a namespace that holds one.
			for (const attribute of Object.values(attributes)) {
				if ((attribute.name === "xmlns" || attribute.prefix === "xmlns") && attribute.value.includes(" ")) throw unreadable();
			}
			start(local((tag as SaxesTagNS).local), attrsOf(attributes));
		});
		if (chars !== null) {
			parser.on("text", chars);
			parser.on("cdata", chars);
		}
		const decoder = new Decoder();
		try {
			let first = true;
			await this.zip.read(name, CHUNK, (chunk) => {
				let text = decoder.write(chunk, false);
				if (first) {
					// A second byte order mark is text before the root; saxes would skip it.
					if (text.startsWith("\ufeff")) throw new Unparsable("bom");
					// expat takes any version of letters, digits, "." "_" and "-" and reads it as XML 1.0.
					text = text.replace(VERSION, (_match, before: string, quote: string) => `<?xml${before}${quote}1.0${quote}`);
					first = false;
				}
				parser.write(text);
				if (chars !== null) flushText(parser, chars);
			});
			parser.write(decoder.write(new Uint8Array(0), true));
			parser.close();
		} catch (error) {
			if (error instanceof Full) return;
			if (error instanceof OperationError) throw error;
			// expat's errors, a bad zip, zlib's errors, EOFError, ValueError and RuntimeError.
			throw unreadable();
		}
	}

	/** The part's internal relationships: id -> [type, the target part's name]. */
	async relationships(part: string): Promise<Map<string, [string, string]>> {
		const [folder, base] = split(part);
		const rels = join(folder, "_rels", `${base}.rels`);
		const found = new Map<string, [string, string]>();
		if (!this.has(rels)) return found;
		await this.parse(rels, (name, attrs) => {
			if (name !== "Relationship" || attrs.get("TargetMode") === "External") return;
			const rid = attrs.get("Id");
			const kind = attrs.get("Type");
			const target = attrs.get("Target");
			if (rid && kind && target && found.size < MAX_ENTRIES) {
				const path = target.startsWith("/") ? target.slice(1) : join(folder, target);
				found.set(rid, [kind, normpath(path)]);
			}
		});
		return found;
	}

	/** The package's main part (the document, presentation or workbook). */
	async main(): Promise<string> {
		for (const [kind, target] of (await this.relationships("")).values()) {
			if (kind.endsWith("/officeDocument")) return target;
		}
		throw unreadable();
	}
}

/** The text of `t` elements, a newline after each paragraph, and `marks` for the elements they name. */
async function paragraphs(archive: Archive, part: string, text: Text, marks: Map<string, string>): Promise<void> {
	let inside = false;
	await archive.parse(
		part,
		(name) => {
			if (name === "t") inside = true;
			else if (marks.has(name)) text.add(marks.get(name) as string);
		},
		(name) => {
			if (name === "t") inside = false;
			else if (name === "p") text.add("\n");
		},
		(data) => {
			if (inside) text.add(data);
		},
	);
}

async function word(archive: Archive, text: Text): Promise<void> {
	await paragraphs(
		archive,
		await archive.main(),
		text,
		new Map([
			["tab", "\t"],
			["br", "\n"],
			["cr", "\n"],
		]),
	);
}

async function slides(archive: Archive): Promise<string[]> {
	const main = await archive.main();
	const relationships = await archive.relationships(main);
	const order: string[] = [];
	await archive.parse(main, (name, attrs) => {
		if (name !== "sldId" || order.length >= MAX_SLIDES) return;
		const rid = relationshipId(attrs);
		if (rid) order.push(rid);
	});
	return order.filter((rid) => relationships.has(rid)).map((rid) => (relationships.get(rid) as [string, string])[1]);
}

async function powerpoint(archive: Archive, text: Text): Promise<void> {
	let number = 0;
	for (const slide of await slides(archive)) {
		number += 1;
		if (text.full) return;
		text.add(`${number > 1 ? "\n" : ""}Slide ${number}\n`);
		await paragraphs(archive, slide, text, new Map([["br", "\n"]]));
	}
}

async function sharedStrings(archive: Archive, part: string): Promise<string[]> {
	const strings: string[] = [];
	let current: string[] = [];
	let total = 0;
	const depth = { t: 0, rPh: 0 };
	await archive.parse(
		part,
		(name) => {
			if (name === "si") current = [];
			else if (name === "t" || name === "rPh") depth[name] += 1;
		},
		(name) => {
			if (name === "si") {
				if (strings.length >= MAX_SHARED_STRINGS) throw tooLarge();
				strings.push(current.join(""));
			} else if (name === "t" || name === "rPh") depth[name] -= 1;
		},
		(data) => {
			// Phonetic guides (rPh) repeat a reading of the text, not the text.
			if (depth.t && !depth.rPh) {
				total += codePointLength(data);
				if (total > MAX_SHARED_TEXT) throw tooLarge();
				current.push(data);
			}
		},
	);
	return strings;
}

function column(reference: string | undefined, fallback: number): number {
	const match = reference ? CELL.exec(reference) : null;
	if (match === null) return fallback;
	let index = 0;
	for (const letter of match[1] as string) index = index * 26 + letter.charCodeAt(0) - 64;
	return index - 1;
}

/** `int(raw) if raw.isdigit() else -1`, where `int()` raises a ValueError for a digit that is not decimal. */
function sharedIndex(raw: string): number {
	const chars = Array.from(raw);
	if (!chars.length || !chars.every((char) => DECIMAL.test(char) || isDigitOnly(char))) return -1;
	if (chars.some((char) => !DECIMAL.test(char)) || chars.length > MAX_INT_DIGITS) throw new Unparsable("int");
	let index = 0;
	for (const char of chars) {
		index = index * 10 + decimalValue(char);
		// Any index past the strings' count is out of range alike.
		if (index > MAX_SHARED_STRINGS) return MAX_SHARED_STRINGS + 1;
	}
	return index;
}

function cellText(kind: string | undefined, raw: string, strings: readonly string[]): string {
	if (kind === "s") {
		const index = sharedIndex(raw);
		return index >= 0 && index < strings.length ? (strings[index] as string) : "";
	}
	if (kind === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
	return raw;
}

/** A row as Python's `csv.writer(lineterminator="\n")` writes it. */
export function csvRow(cells: readonly string[]): string {
	const fields = cells.map((cell) => (/[,"\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell));
	const line = fields.join(",");
	// A record of one empty field is written quoted, so it is not an empty line.
	return `${line === "" && cells.length ? '""' : line}\n`;
}

/** The first worksheet, in workbook order, as CSV. */
async function excel(archive: Archive, text: Text): Promise<void> {
	const main = await archive.main();
	const relationships = await archive.relationships(main);
	const first: string[] = [];
	await archive.parse(main, (name, attrs) => {
		if (name !== "sheet" || first.length) return;
		const rid = relationshipId(attrs);
		if (rid) first.push(rid);
	});
	if (!first.length || !relationships.has(first[0] as string)) throw unreadable();
	let shared: string | null = null;
	for (const [kind, target] of relationships.values()) {
		if (kind.endsWith("/sharedStrings")) {
			shared = target;
			break;
		}
	}
	const strings = shared && archive.has(shared) ? await sharedStrings(archive, shared) : [];

	const row = new Map<number, string>();
	// The cell being read; it stays set after the cell ends, as office.py's dict does.
	const cell: { type?: string | undefined; column?: number } = {};
	let value: string[] = [];
	const state = { v: false, is: false, t: false };
	const isState = (name: string): name is keyof typeof state => name === "v" || name === "is" || name === "t";
	await archive.parse(
		(relationships.get(first[0] as string) as [string, string])[1],
		(name, attrs) => {
			if (name === "row") row.clear();
			else if (name === "c") {
				cell.type = attrs.get("t");
				cell.column = column(attrs.get("r"), Math.max(-1, ...row.keys()) + 1);
				value = [];
			} else if (isState(name)) state[name] = true;
		},
		(name) => {
			if (isState(name)) state[name] = false;
			else if (name === "c") {
				const at = cell.column;
				if (at !== undefined && at >= 0 && at < MAX_COLUMNS) row.set(at, cellText(cell.type, value.join(""), strings));
			} else if (name === "row" && row.size) {
				// Cells are cut to what the text can still take before the row is built: one long shared string
				// may fill many cells.
				let budget = text.remaining;
				if (!budget) throw new Full();
				const cells: string[] = [];
				const last = Math.max(...row.keys());
				for (let i = 0; i <= last; i++) {
					const kept = sliceCodePoints(row.get(i) ?? "", 0, budget);
					cells.push(kept);
					budget -= codePointLength(kept) + 1;
					if (budget <= 0) break;
				}
				text.add(csvRow(cells));
			}
		},
		(data) => {
			if (state.v || (state.is && state.t)) value.push(data);
		},
	);
}

const READERS: { [kind in Kind]: (archive: Archive, text: Text) => Promise<void> } = { docx: word, pptx: powerpoint, xlsx: excel };

export function isKind(value: string): value is Kind {
	return value === "docx" || value === "pptx" || value === "xlsx";
}

/** The text of a .docx, .pptx or .xlsx file, at most `limit` characters. */
export async function extract(kind: Kind, data: Uint8Array, limit: number): Promise<string> {
	const text = new Text(limit);
	await READERS[kind](await Archive.open(data), text);
	return text.value();
}
