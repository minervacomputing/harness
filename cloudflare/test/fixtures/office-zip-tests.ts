// The limits and checks that are ours in the Office reader's zip reader (src/connectors/office/zip.ts, over zip.js): the
// number of entries, the output budget on what is actually inflated, a zip read as an entry, damaged archives and
// the CRC-32. zip.js inflates through the runtime's DecompressionStream and checks each CRC-32 through its gzip
// form, so these run in Node (test/unit/office-zip.test.ts) and in workerd, where production runs
// (test/platform/office-zip.test.ts), with the runtime's decoding of parts. What zip.js parses is not retested
// here; connectors-onedrive.test.ts reads the Office files.

import { constants, crc32, deflateRawSync } from "node:zlib";
import { configure } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { extract, MAX_ENTRIES, MAX_EXPANDED, type Kind } from "../../src/connectors/office/office.ts";
import { BadZip, Zip } from "../../src/connectors/office/zip.ts";

const MIB = 1024 * 1024;
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

export function rels(...relationships: [id: string, type: string, target: string][]): string {
	const items = relationships.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`);
	return `<Relationships xmlns="${PACKAGE}">${items.join("")}</Relationships>`;
}

export const DOCUMENT = (text: string): string => `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

/** An Office file of each kind holding "hello", its parts stored (level 0) or deflated (9). */
export function officeFile(kind: Kind, level: 0 | 9): Uint8Array {
	const parts: { [name: string]: string } =
		kind === "docx"
			? { "_rels/.rels": rels(["rId1", "officeDocument", "word/document.xml"]), "word/document.xml": DOCUMENT("hello") }
			: kind === "pptx"
				? {
						"_rels/.rels": rels(["rId1", "officeDocument", "ppt/presentation.xml"]),
						"ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
						"ppt/_rels/presentation.xml.rels": rels(["rId2", "slide", "slides/slide1.xml"]),
						"ppt/slides/slide1.xml": `<p:sld xmlns:p="${P}" xmlns:a="${A}"><a:p><a:r><a:t>hello</a:t></a:r></a:p></p:sld>`,
					}
				: {
						"_rels/.rels": rels(["rId1", "officeDocument", "xl/workbook.xml"]),
						"xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`,
						"xl/_rels/workbook.xml.rels": rels(["rId1", "worksheet", "worksheets/sheet1.xml"]),
						"xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c><c r="B1"><v>3</v></c></row></sheetData></worksheet>`,
					};
	return zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)])), { level });
}

const TEXT: { [kind in Kind]: string } = { docx: "hello\n", pptx: "Slide 1\nhello\n", xlsx: "hello,3\n" };

function indexOf(data: Uint8Array, bytes: Uint8Array): number {
	outer: for (let at = 0; at + bytes.length <= data.length; at++) {
		for (let n = 0; n < bytes.length; n++) if (data[at + n] !== bytes[n]) continue outer;
		return at;
	}
	return -1;
}

export interface Part {
	name: string;
	/** The entry's data as stored: raw deflate when `deflated`. */
	data: Uint8Array;
	deflated: boolean;
	crc: number;
	size: number;
}

/** A zip archive of parts with the sizes and CRC given, so that an archive can claim what it holds exactly. */
export function rawZip(parts: Part[]): Uint8Array {
	const pieces: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const part of parts) {
		const name = Buffer.from(part.name);
		const method = part.deflated ? 8 : 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(part.crc, 14);
		local.writeUInt32LE(part.data.length, 18);
		local.writeUInt32LE(part.size, 22);
		local.writeUInt16LE(name.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(part.crc, 16);
		entry.writeUInt32LE(part.data.length, 20);
		entry.writeUInt32LE(part.size, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		pieces.push(local, name, Buffer.from(part.data));
		directory.push(entry, name);
		offset += 30 + name.length + part.data.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(parts.length, 8);
	end.writeUInt16LE(parts.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...pieces, central, end]));
}

export const stored = (name: string, text: string): Part => ({ name, data: strToU8(text), deflated: false, crc: crc32(text), size: strToU8(text).length });

/** An entry of `pieces` times 8 MiB of one byte, as one deflate stream of about a thousandth of that size. */
export function bomb(name: string, pieces: number, fill = 0): Part {
	const zeros = Buffer.alloc(8 * MIB, fill);
	// A sync flush ends a piece on a byte, and none is the last block, so the pieces join into one stream.
	const piece = deflateRawSync(zeros, { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
	const empty = Buffer.from([0x03, 0x00]);
	let sum = 0;
	for (let n = 0; n < pieces; n++) sum = crc32(zeros, sum);
	return { name, data: new Uint8Array(Buffer.concat([...Array.from({ length: pieces }, () => piece), empty])), deflated: true, crc: sum, size: pieces * 8 * MIB };
}

/** The code of the error a file is refused with, or null when it is read; the text is cut at `limit` characters. */
async function refusal(kind: Kind, data: Uint8Array, limit = 1000): Promise<string | null> {
	try {
		await extract(kind, data, limit);
	} catch (error) {
		return (error as { code: string }).code;
	}
	return null;
}

/** CRC-32 of the text, little-endian as the zip headers spell it. */
function crcBytes(text: string): Uint8Array {
	let crc = 0xffffffff;
	for (const byte of strToU8(text)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return new Uint8Array(new Uint32Array([~crc >>> 0]).buffer);
}

const overflow = () => new Error("budget spent");
const limits = (bytes: number, entries = 100) => ({ entries, bytes, overflow });
const nothing = () => {};

/** What the inflater produced: zip.js reads through whatever DecompressionStream it is configured with. */
let produced = 0;
const Native = DecompressionStream;

class Counting {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;

	constructor(format: ConstructorParameters<typeof DecompressionStream>[0]) {
		const inner = new Native(format);
		this.writable = inner.writable;
		this.readable = inner.readable.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					produced += chunk.length;
					controller.enqueue(chunk);
				},
			}),
		);
	}
}

type Stream = NonNullable<Parameters<typeof configure>[0]["DecompressionStream"]>;

export function zipTests(): void {
	beforeAll(() => configure({ DecompressionStream: Counting as unknown as Stream }));
	afterAll(() => configure({ DecompressionStream: Native as unknown as Stream }));

	describe("Office files in zip archives", () => {
		for (const level of [0, 9] as const) {
			for (const kind of ["docx", "pptx", "xlsx"] as const) {
				test(`a ${kind} file with its parts ${level === 0 ? "stored" : "deflated"} is read`, async () => {
					expect(await extract(kind, officeFile(kind, level), 1000)).toBe(TEXT[kind]);
				});
			}
		}

		test("a part in UTF-16 after a byte order mark is read; one declaring an encoding other than its own is refused", async () => {
			const utf16 = (text: string, bigEndian: boolean) => {
				const units = `\ufeff${text}`;
				const bytes = new Uint8Array(2 * units.length);
				const view = new DataView(bytes.buffer);
				for (let at = 0; at < units.length; at++) view.setUint16(2 * at, units.charCodeAt(at), !bigEndian);
				return bytes;
			};
			const word = (document: Uint8Array) => zipSync({ "_rels/.rels": strToU8(rels(["rId1", "officeDocument", "word/document.xml"])), "word/document.xml": document });
			for (const bigEndian of [false, true]) expect(await extract("docx", word(utf16(DOCUMENT("zażółć \u{1f600}"), bigEndian)), 1000)).toBe("zażółć \u{1f600}\n");
			expect(await extract("docx", word(strToU8(`<?xml version="1.0" encoding="utf8"?>${DOCUMENT("hello")}`)), 1000)).toBe("hello\n");
			for (const declared of ["ISO-8859-1", "UTF-16"]) {
				expect(await refusal("docx", word(strToU8(`<?xml version="1.0" encoding="${declared}"?>${DOCUMENT("hello")}`)))).toBe("UNSUPPORTED_FILE");
			}
		});

		test("a truncated archive is refused, wherever it is cut", async () => {
			for (const level of [0, 9] as const) {
				const whole = officeFile("docx", level);
				for (const length of [0, 21, 30, Math.floor(whole.length / 2), whole.length - 30, whole.length - 22, whole.length - 1]) {
					expect(await refusal("docx", whole.slice(0, length)), `level ${level}, cut at ${length}`).toBe("UNSUPPORTED_FILE");
				}
			}
		});

		test("a stored part whose bytes changed fails its CRC-32", async () => {
			const data = officeFile("docx", 0);
			// Still well-formed XML, so only the checksum can tell.
			const at = indexOf(data, strToU8("hello"));
			expect(at).toBeGreaterThan(0);
			data[at] = 0x6a;
			expect(indexOf(data, strToU8("jello"))).toBe(at);
			expect(await refusal("docx", data)).toBe("UNSUPPORTED_FILE");
		});

		test("a deflated part whose CRC-32 is wrong in its header and in the directory is refused", async () => {
			const data = officeFile("docx", 9);
			const sum = crcBytes(DOCUMENT("hello"));
			// The local header and the directory spell the same value, so the archive is consistent but for the data.
			const first = indexOf(data, sum);
			const second = first + 4 + indexOf(data.subarray(first + 4), sum);
			expect(first).toBeGreaterThan(0);
			expect(second).toBeGreaterThan(first + 4);
			for (const at of [first, second]) data[at] = (data[at] as number) ^ 0x01;
			expect(await refusal("docx", data)).toBe("UNSUPPORTED_FILE");
		});

		for (const level of [0, 9] as const) {
			test(`a damaged part is refused even when the text is cut short before the end of it, ${level === 0 ? "stored" : "deflated"}`, async () => {
				// A part of some tens of kilobytes, the first character of whose text is all that is wanted: the check must not be skipped.
				const body = DOCUMENT("hello").replace("</w:body>", `</w:body>${" ".repeat(40_000)}`);
				const make = () => zipSync({ "_rels/.rels": strToU8(rels(["rId1", "officeDocument", "word/document.xml"])), "word/document.xml": strToU8(body) }, { level });
				expect(await refusal("docx", make(), 1)).toBeNull();
				// The CRC-32 is wrong in the header and in the directory alike.
				const data = make();
				const sum = crcBytes(body);
				const first = indexOf(data, sum);
				const second = first + 4 + indexOf(data.subarray(first + 4), sum);
				expect(first).toBeGreaterThan(0);
				expect(second).toBeGreaterThan(first + 4);
				for (const at of [first, second]) data[at] = (data[at] as number) ^ 0x01;
				expect(await refusal("docx", data, 1)).toBe("UNSUPPORTED_FILE");
				expect(await refusal("docx", data)).toBe("UNSUPPORTED_FILE");
			});
		}

		test("a local header that names another file than the directory does is refused", async () => {
			const data = officeFile("docx", 0);
			expect(await refusal("docx", data)).toBeNull();
			// The name in the second entry's local header, which is the document: the first spelling is in the relationships.
			const at = 1 + indexOf(data.subarray(1), strToU8("PK\x03\x04")) + 30;
			expect(String.fromCharCode(...data.subarray(at, at + 17))).toBe("word/document.xml");
			data[at] = 0x78;
			expect(await refusal("docx", data)).toBe("UNSUPPORTED_FILE");
		});

		test("a part that expands past the budget is refused as too large", async () => {
			// Spaces keep the XML well-formed, so nothing but the budget stops the read; they deflate to under a megabyte.
			const padding = " ".repeat(MAX_EXPANDED + 1);
			const data = zipSync({ "_rels/.rels": strToU8(rels(["rId1", "officeDocument", "word/document.xml"])), "word/document.xml": strToU8(`<w:document xmlns:w="${W}">${padding}</w:document>`) }, { level: 9 });
			expect(data.length).toBeLessThan(MIB);
			expect(await refusal("docx", data)).toBe("FILE_TOO_LARGE");
		});

		test("a gigabyte of spaces, a megabyte as deflated with its true size and CRC-32 declared, is refused as too large", async () => {
			// Only the budget stops it: the entry's header is true, and nothing else is wrong with the archive.
			const archive = rawZip([stored("_rels/.rels", rels(["rId1", "officeDocument", "word/document.xml"])), bomb("word/document.xml", 128, 0x20)]);
			expect(archive.length).toBeLessThan(2 * MIB);
			expect(await refusal("docx", archive)).toBe("FILE_TOO_LARGE");
		});

		test("an archive with more entries than the limit is refused", async () => {
			const parts: { [name: string]: Uint8Array } = {};
			for (let n = 0; n <= MAX_ENTRIES; n++) parts[`part${n}.xml`] = new Uint8Array(0);
			expect(await refusal("docx", zipSync(parts, { level: 0 }))).toBe("UNSUPPORTED_FILE");
		});
	});

	describe("the output budget", () => {
		test("a high-ratio bomb is stopped by the budget, without inflating it all", async () => {
			// A gigabyte of zeros, about a megabyte as deflated, whose header declares the true size and CRC-32: only the budget stops it.
			const archive = rawZip([bomb("bomb.xml", 128)]);
			expect(archive.length).toBeLessThan(2 * MIB);
			const zip = await Zip.open(archive, limits(4 * MIB));
			produced = 0;
			let seen = 0;
			await expect(zip.read("bomb.xml", 64 * 1024, (bytes) => (seen += bytes.length))).rejects.toThrow("budget spent");
			expect(seen).toBeLessThanOrEqual(4 * MIB);
			// The inflater made the budget's worth, which shows that it is counted, and stopped a step or two past it, nowhere near the 1 GiB.
			expect(produced).toBeGreaterThanOrEqual(4 * MIB);
			expect(produced).toBeLessThan(16 * MIB);
		});

		test("the budget is the bytes inflated by all the reads of one archive", async () => {
			const zip = await Zip.open(rawZip([stored("a.xml", "x".repeat(600)), stored("b.xml", "y".repeat(600))]), limits(1000));
			await zip.read("a.xml", 64 * 1024, nothing);
			await expect(zip.read("b.xml", 64 * 1024, nothing)).rejects.toThrow("budget spent");
		});

		test("a zip read as an entry is its bytes, bounded, and is never opened", async () => {
			const inner = rawZip([bomb("bomb.xml", 128)]);
			const outer = rawZip([{ name: "inner.zip", data: inner, deflated: false, crc: crc32(inner), size: inner.length }]);
			const zip = await Zip.open(outer, limits(4 * MIB));
			produced = 0;
			const read: Uint8Array[] = [];
			await zip.read("inner.zip", 64 * 1024, (bytes) => read.push(bytes.slice()));
			expect(Buffer.concat(read).equals(Buffer.from(inner))).toBe(true);
			expect(produced).toBe(0);
			// Nothing inside it is an entry of the outer archive.
			expect(zip.has("bomb.xml")).toBe(false);
		});

		test("pieces are the size asked for, and the last waits for the CRC-32", async () => {
			const text = "0123456789".repeat(25);
			const zip = await Zip.open(rawZip([stored("a.xml", text)]), limits(MIB));
			const sizes: number[] = [];
			await zip.read("a.xml", 100, (bytes) => sizes.push(bytes.length));
			expect(sizes).toEqual([100, 100, 50]);
			const damaged = rawZip([{ ...stored("a.xml", text), crc: 1 }]);
			let delivered = 0;
			await expect((await Zip.open(damaged, limits(MIB))).read("a.xml", 1000, (bytes) => (delivered += bytes.length))).rejects.toBeInstanceOf(BadZip);
			// The entry is shorter than a piece, so none of it was delivered before the checksum failed.
			expect(delivered).toBe(0);
		});
	});

	describe("the directory", () => {
		const many = (count: number) => rawZip(Array.from({ length: count }, (_, n) => stored(`p${n}.xml`, "<a/>")));

		test("more entries than the limit are refused, and as many are not", async () => {
			await expect(Zip.open(many(4), limits(MIB, 3))).rejects.toBeInstanceOf(BadZip);
			expect(await Zip.open(many(3), limits(MIB, 3))).toBeInstanceOf(Zip);
		});

		test("they are refused before any entry is inflated", async () => {
			const deflated = (n: number): Part => ({ name: `p${n}.xml`, data: new Uint8Array(deflateRawSync("<a/>")), deflated: true, crc: crc32("<a/>"), size: 4 });
			produced = 0;
			await expect(Zip.open(rawZip(Array.from({ length: 6 }, (_, n) => deflated(n))), limits(MIB, 5))).rejects.toBeInstanceOf(BadZip);
			expect(produced).toBe(0);
		});

		test("two entries with one name are refused", async () => {
			await expect(Zip.open(rawZip([stored("a.xml", "<a/>"), stored("a.xml", "<b/>")]), limits(MIB))).rejects.toBeInstanceOf(BadZip);
		});

		test("an entry whose deflate stream is cut short, inside a complete directory, is refused", async () => {
			const text = "<w:t>".repeat(200);
			const full = new Uint8Array(deflateRawSync(text));
			const part = (data: Uint8Array): Part => ({ name: "word/document.xml", data, deflated: true, crc: crc32(text), size: text.length });
			await (await Zip.open(rawZip([part(full)]), limits(MIB))).read("word/document.xml", 64 * 1024, nothing);
			const cut = await Zip.open(rawZip([part(full.subarray(0, full.length - 3))]), limits(MIB));
			await expect(cut.read("word/document.xml", 64 * 1024, nothing)).rejects.toBeInstanceOf(BadZip);
		});
	});
}
