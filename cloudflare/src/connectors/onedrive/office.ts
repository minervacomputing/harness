// Text out of Word, PowerPoint and Excel files (Office Open XML), for reading only.
//
// These files are zip archives of XML parts (zip.ts), and only the parts that hold the text are read. Each
// part is streamed through a SAX parser (saxes, with namespaces), which keeps no tree. A document type
// declaration, and with it any entity, is refused. Decompression is metered across all the parts read, 64
// KiB at a time, and reading stops once the text reaches its limit. Nothing a document refers to
// is fetched or opened: links, embedded objects and external relationships are ignored. Formulas are not
// evaluated, so Excel cells give the values the file stored.
//
// The work is synchronous and bounded, and runs in the Worker that serves the call: these limits, not
// isolation, are what contain a hostile file.
//
// Parts are read as UTF-8, or UTF-16 after a byte order mark; a part that declares another encoding is
// unreadable.

import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { OperationError } from "../../gateway/connector.ts";
import { sliceText } from "../../lib/text.ts";
import { BadZip, Zip } from "./zip.ts";

export const MAX_ENTRIES = 5000;
/** Bytes decompressed across every part read, whatever the text they yield. */
export const MAX_EXPANDED = 32 * 1024 * 1024;
export const MAX_SHARED_TEXT = 4 * 1024 * 1024;
export const MAX_SHARED_STRINGS = 1_000_000;
export const MAX_SLIDES = 1000;
export const MAX_COLUMNS = 200;
export const CHUNK = 64 * 1024;
const CELL = /^([A-Z]{1,3})\d+$/u;

export type Kind = "docx" | "pptx" | "xlsx";

export function unreadable(): OperationError {
	return new OperationError("UNSUPPORTED_FILE", "Minerva could not read this file: it is damaged, protected, or not a valid Office file.");
}

function tooLarge(): OperationError {
	return new OperationError("FILE_TOO_LARGE", "This file expands to more than Minerva reads.");
}

/** The text reached its limit; reading stops. */
class Full extends Error {}

/** A part that cannot be read. */
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
		const kept = sliceText(value, 0, this.remaining);
		this.parts.push(kept);
		// A value cut short ends the text, even when the cut left a unit free rather than split a pair.
		this.size = kept.length < value.length ? this.limit : this.size + kept.length;
	}

	value(): string {
		return sliceText(this.parts.join(""), 0, this.limit);
	}
}

/** An element's attributes without a prefix, by name. */
type Attrs = Map<string, string>;
type Start = (name: string, attrs: Attrs, attributes: Record<string, SaxesAttributeNS>) => void;
type End = (name: string) => void;
type Chars = (data: string) => void;

function attrsOf(attributes: Record<string, SaxesAttributeNS>): Attrs {
	return new Map(
		Object.values(attributes)
			.filter((attribute) => !attribute.prefix)
			.map((attribute) => [attribute.local, attribute.value]),
	);
}

/** The id attribute in the relationships namespace (`r:id`), which names a relationship of the part. */
function relationshipId(attributes: Record<string, SaxesAttributeNS>): string | null {
	return Object.values(attributes).find((attribute) => attribute.local === "id" && attribute.uri.endsWith("/relationships"))?.value ?? null;
}

/** A relationship's target part, resolved against the folder of the part it belongs to. */
function resolvePart(folder: string, target: string): string {
	const parts: string[] = [];
	for (const segment of (target.startsWith("/") ? target : `${folder}/${target}`).split("/")) {
		if (segment === "..") parts.pop();
		else if (segment !== "" && segment !== ".") parts.push(segment);
	}
	return parts.join("/");
}

/** The encoding an XML declaration names, if the text starts with one. */
const DECLARED = /^<\?xml\s[^?>]*\bencoding\s*=\s*["']([^"']*)["']/;

/** Whether a declared encoding is the one the bytes are read in: by the Encoding Standard's name, or "utf-16" for either order. */
function agrees(declared: string, encoding: string): boolean {
	if (declared.trim().toLowerCase() === "utf-16") return encoding.startsWith("utf-16");
	try {
		return new TextDecoder(declared).encoding === encoding;
	} catch {
		return false;
	}
}

/**
 * A part's bytes as text, decoded as they stream: UTF-16 after its byte order mark, else UTF-8 (a byte order
 * mark dropped), invalid sequences refused. A declaration that names another encoding is refused.
 */
class Decoder {
	#decoder: TextDecoder | null = null;

	write(bytes: Uint8Array, final: boolean): string {
		const first = this.#decoder === null;
		const label = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
		this.#decoder ??= new TextDecoder(label, { fatal: true, ignoreBOM: false });
		const text = this.#decoder.decode(bytes, { stream: !final });
		if (first) {
			// The first piece is the whole part or 64 KiB of it: a declaration it does not hold whole is refused.
			if (text.startsWith("<?xml") && !text.includes("?>")) throw new Unparsable("encoding");
			const declared = DECLARED.exec(text)?.[1];
			if (declared !== undefined && !agrees(declared, this.#decoder.encoding)) throw new Unparsable("encoding");
		}
		return text;
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
 * Hands the text saxes holds back at the end of a chunk to `chars` now, rather than at the next markup, so a
 * long run of text stops being read as soon as the text is full.
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
 * nested elements took over a second). Here the bindings in scope are kept per
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
			if (end !== null) end((tag as SaxesTagNS).local);
		});
		parser.on("opentag", (tag) => {
			for (const [prefix, uri] of Object.entries((tag as SaxesTagNS).ns)) {
				const scope = parser.scopes.get(prefix);
				if (scope === undefined) parser.scopes.set(prefix, [uri]);
				else scope.push(uri);
			}
			parser.opening = null;
			const attributes = (tag as SaxesTagNS).attributes;
			start((tag as SaxesTagNS).local, attrsOf(attributes), attributes);
		});
		if (chars !== null) {
			parser.on("text", chars);
			parser.on("cdata", chars);
		}
		const decoder = new Decoder();
		try {
			await this.zip.read(name, CHUNK, (chunk) => {
				parser.write(decoder.write(chunk, false));
				if (chars !== null) flushText(parser, chars);
			});
			parser.write(decoder.write(new Uint8Array(0), true));
			parser.close();
		} catch (error) {
			if (error instanceof Full) return;
			if (error instanceof OperationError) throw error;
			// The XML parser's errors, a bad zip, a bad stream, or a part cut short.
			throw unreadable();
		}
	}

	/** The part's internal relationships: id -> [type, the target part's name]. */
	async relationships(part: string): Promise<Map<string, [string, string]>> {
		const at = part.lastIndexOf("/");
		const folder = at < 0 ? "" : part.slice(0, at);
		const rels = `${folder ? `${folder}/` : ""}_rels/${part.slice(at + 1)}.rels`;
		const found = new Map<string, [string, string]>();
		if (!this.has(rels)) return found;
		await this.parse(rels, (name, attrs) => {
			if (name !== "Relationship" || attrs.get("TargetMode") === "External") return;
			const rid = attrs.get("Id");
			const kind = attrs.get("Type");
			const target = attrs.get("Target");
			if (rid && kind && target && found.size < MAX_ENTRIES) {
				found.set(rid, [kind, resolvePart(folder, target)]);
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
	await archive.parse(main, (name, _attrs, attributes) => {
		if (name !== "sldId" || order.length >= MAX_SLIDES) return;
		const rid = relationshipId(attributes);
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
				total += data.length;
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

/** A shared string's index written as ASCII digits, or -1 for anything else. Any index past the strings' count is out of range alike. */
function sharedIndex(raw: string): number {
	if (!/^\d+$/.test(raw)) return -1;
	return Math.min(Number(raw), MAX_SHARED_STRINGS + 1);
}

function cellText(kind: string | undefined, raw: string, strings: readonly string[]): string {
	if (kind === "s") {
		const index = sharedIndex(raw);
		return index >= 0 && index < strings.length ? (strings[index] as string) : "";
	}
	if (kind === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
	return raw;
}

/** A CSV row: fields with a comma, quote or line break quoted, quotes doubled, ending with "\n". */
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
	await archive.parse(main, (name, _attrs, attributes) => {
		if (name !== "sheet" || first.length) return;
		const rid = relationshipId(attributes);
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
	// The cell being read.
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
					const kept = sliceText(row.get(i) ?? "", 0, budget);
					cells.push(kept);
					budget -= kept.length + 1;
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
