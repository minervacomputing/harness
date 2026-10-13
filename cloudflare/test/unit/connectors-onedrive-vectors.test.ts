// OneDrive's byte-level and string-level helpers against what today's Python computes
// (test/fixtures/connectors/onedrive/generate.py): the zip reader (CPython's zipfile) on valid, odd and damaged
// archives, the Word, PowerPoint and Excel readers on hand-written edge cases and mutations of their XML,
// download addresses, how a file is read, search cursors and tool inputs. The bombs and the entity attacks have
// their own tests in connectors-onedrive.test.ts.

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, test } from "vitest";
import { downloadAllowed, DriveItem } from "../../src/connectors/onedrive/client.ts";
import * as onedrive from "../../src/connectors/onedrive/connector.ts";
import { onedriveConnector } from "../../src/connectors/onedrive/connector.ts";
import { Archive, CHUNK, extract, type Kind } from "../../src/connectors/onedrive/office.ts";
import { BadZip } from "../../src/connectors/onedrive/zip.ts";
import { OperationError } from "../../src/gateway/connector.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { type Json } from "../../src/lib/json.ts";
import { operation, vectors } from "../fixtures/connectors/microsoft/runs.ts";
import { changedOnPurpose } from "./changed.ts";

type Recipe = { $repeat: [string, number] };

/** A long run of one character is stored as a recipe (see generate.py's `pack`). */
function unpack(value: unknown): unknown {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as { [key: string]: unknown };
		if (Object.keys(record).length === 1 && "$repeat" in record) {
			const [char, count] = (record as Recipe).$repeat;
			return char.repeat(count);
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, unpack(item)]));
	}
	return value;
}

/** An archive too large to keep in the vectors: its named parts, then `empty` empty ones (p0.xml, p1.xml, …). */
type Crowd = { $crowd: { parts: { [name: string]: string }; empty: number } };

/** The `$crowd` archive, built with the stored method: the tests that use it are about how many entries it has. */
function crowded({ parts, empty }: Crowd["$crowd"]): Uint8Array {
	const entries: [name: Buffer, data: Buffer][] = [
		...Object.entries(parts).map(([name, text]): [Buffer, Buffer] => [Buffer.from(name), Buffer.from(text)]),
		...Array.from({ length: empty }, (_, n): [Buffer, Buffer] => [Buffer.from(`p${n}.xml`), Buffer.alloc(0)]),
	];
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(0x21, 12); // 1980-01-01
		head.writeUInt32LE(crc32(data), 14);
		head.writeUInt32LE(data.length, 18);
		head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(name.length, 26);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x21, 14);
		record.writeUInt32LE(crc32(data), 16);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(data.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(offset, 42);
		local.push(head, name, data);
		central.push(record, name);
		offset += 30 + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...local, directory, end]));
}

const bytes = (data: string | Crowd): Uint8Array => (typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : crowded(data.$crowd));

const dataset = vectors("onedrive") as {
	zip: { name: string; data: string; open: string; error?: string; names?: string[]; parts?: { [name: string]: { size?: number; sha256?: string; error?: string; type?: string } } }[];
	office: { name: string; kind: Kind; limit: number; data: string | Crowd; text?: string; error?: string; message?: string; raises?: string }[];
	download_allowed: { [url: string]: { value?: boolean; raises?: string } };
	readable: { mime: string | null; name: string; value?: string; error?: string; message?: string }[];
	search_cursor: { cursor: unknown; value?: string; error?: string; raises?: string }[];
	inputs: { [tool: string]: { args: Json; data?: Json; message?: string; raises?: string }[] };
};

type Parts = { [name: string]: { size?: number; sha256?: string; error?: string } };

/** What each of the named parts reads as through the reader: its size and hash, or an error. */
async function readParts(data: Uint8Array, names: string[]): Promise<{ open: string; parts?: Parts }> {
	let archive: Archive;
	try {
		archive = await Archive.open(data);
	} catch (error) {
		if (error instanceof OperationError) return { open: error.code };
		throw error;
	}
	const parts: Parts = {};
	for (const name of names) {
		if (!archive.has(name)) {
			parts[name] = { error: "missing" };
			continue;
		}
		try {
			const digest = createHash("sha256");
			let size = 0;
			await archive.zip.read(name, CHUNK, (chunk) => {
				digest.update(chunk);
				size += chunk.length;
			});
			parts[name] = { size, sha256: digest.digest("hex") };
		} catch (error) {
			if (error instanceof BadZip) parts[name] = { error: "unreadable" };
			else throw error;
		}
	}
	return { open: "ok", parts };
}

// zip.js is not CPython's zipfile, and the archives the vectors damage on purpose are read differently by
// design. Where it reads a part it must read what CPython reads; where it refuses or names the part
// differently there is nothing to compare, so such a part is skipped. That holds for the vectors whose
//   - names differ in how they are decoded or cut (a NUL, code page 437 or UTF-8 without the flag, the
//     Unicode path field) or are directories, which are not parts;
//   - sizes disagree with the data (zip.js refuses output that is not the size the entry declares), or the
//     deflate stream has trailing data or no final block (the runtime's inflater refuses it);
//   - headers disagree (local and central flags or names), entries overlap or reach past the directory, or
//     the disk number is not zero (zip.js refuses them).
// CPython's own refusals are not compared at all: the output budget bounds what is read from such an archive.
describe("the zip reader against CPython's zipfile", () => {
	test("a part read by both is the same bytes", async () => {
		expect(dataset.zip.length).toBeGreaterThan(150);
		const failures: string[] = [];
		let same = 0;
		for (const expected of dataset.zip) {
			if (expected.open !== "ok") continue;
			const actual = await readParts(bytes(expected.data), Object.keys(expected.parts ?? {}));
			for (const [name, part] of Object.entries(expected.parts ?? {})) {
				const got = actual.parts?.[name];
				if (part.error !== undefined || got?.sha256 === undefined) continue;
				if (JSON.stringify(got) === JSON.stringify(part)) same += 1;
				else failures.push(`${expected.name}: ${name}\n   python ${JSON.stringify(part)}\n   ts     ${JSON.stringify(got)}`);
			}
		}
		expect(failures).toEqual([]);
		// Most of the vectors are read, so the comparison is not empty.
		expect(same).toBeGreaterThan(100);
	});
});

const UNREADABLE = "Minerva could not read this file: it is damaged, protected, or not a valid Office file.";
const REFUSED = new Set(["word declared cp1252"]);
// Text is cut and counted in UTF-16 units, and a shared string's index is ASCII digits (anything else is an
// empty cell), where Python counted code points and read any decimal digit.
const CHANGED = /emoji|excel cell s (?:arabic indic|fullwidth|superscript|circled|mixed digit|4301 digits|unicode digits)/;

describe("the Office readers against today's Python", () => {
	test("extract: the text or the error code and message of every file", async () => {
		expect(dataset.office.length).toBeGreaterThan(350);
		const failures: string[] = [];
		for (const expected of dataset.office) {
			if (CHANGED.test(expected.name)) continue;
			let actual: { text?: string; error?: string; message?: string; threw?: string };
			try {
				actual = { text: await extract(expected.kind, bytes(expected.data), expected.limit) };
			} catch (error) {
				actual = error instanceof OperationError ? { error: error.code, message: error.message } : { threw: String(error) };
			}
			// Where Python raises (an unknown encoding in the declaration: LookupError) or reads what is refused here
			// (the single-byte codecs of Python's expat other than ISO-8859-1 and US-ASCII), the file is unreadable.
			const refused = expected.raises !== undefined || REFUSED.has(expected.name);
			const want = refused ? { error: "UNSUPPORTED_FILE", message: UNREADABLE } : expected.error ? { error: expected.error, message: expected.message } : { text: expected.text };
			if (JSON.stringify(actual) !== JSON.stringify(want)) {
				failures.push(`${expected.name} (${expected.kind}, limit ${expected.limit})\n   python ${JSON.stringify(want).slice(0, 300)}\n   ts     ${JSON.stringify(actual).slice(0, 300)}`);
			}
		}
		expect(failures).toEqual([]);
	});
});

// Hosts httpx lets through that the WHATWG parser behind fetch refuses (forbidden host code points), and Unicode or
// percent-escaped hosts, which are refused whole: downloadAllowed is stricter than Python for exactly these.
const STRICTER = new Set([
	"https://x<y.sharepoint.com/x",
	"https://x>y.sharepoint.com/x",
	"https://x[y.sharepoint.com/x",
	"https://x]y.sharepoint.com/x",
	"https://x^y.sharepoint.com/x",
	"https://x|y.sharepoint.com/x",
	"https://caf\u00e9.sharepoint.com/x",
	"https://CAF\u00c9.sharepoint.com/x",
	"https://contoso\u3002sharepoint\u3002com/x",
	"https://contoso\uff0esharepoint\uff0ecom/x",
	"https://%78.sharepoint.com/x",
	"https://contoso-\u212a.sharepoint.com/x",
]);

describe("download addresses", () => {
	test("downloadAllowed: HTTPS on Microsoft's file hosts, as httpx parses them", () => {
		const failures: string[] = [];
		for (const [url, expected] of Object.entries(dataset.download_allowed)) {
			const actual = downloadAllowed(url);
			// httpx's IDNA decoding raises on a malformed A-label (an unhandled error in Python): refused here.
			// Python reads some hosts that fetch's parsing refuses or changes (STRICTER); those are refused here.
			const want = expected.raises || STRICTER.has(url) ? false : expected.value;
			if (actual !== want) failures.push(`${JSON.stringify(url).slice(0, 100)}: python ${JSON.stringify(expected)}, ts ${actual}`);
		}
		expect(failures).toEqual([]);
	});
});

describe("how a file is read", () => {
	test("readable: text, an Office format, or the refusal", () => {
		const failures: string[] = [];
		for (const expected of dataset.readable) {
			const item = DriveItem({ id: "x", name: expected.name, file: expected.mime === null ? {} : { mimeType: expected.mime } });
			let actual: { value?: string; error?: string; message?: string };
			try {
				actual = { value: onedrive.readable(item) };
			} catch (error) {
				if (!(error instanceof OperationError)) throw error;
				actual = { error: error.code, message: error.message };
			}
			const { mime: _m, name: _n, ...want } = expected;
			if (JSON.stringify(actual) !== JSON.stringify(want)) failures.push(`${JSON.stringify([expected.mime, expected.name])}: python ${JSON.stringify(want)}, ts ${JSON.stringify(actual)}`);
		}
		expect(failures).toEqual([]);
	});

	test("searchCursor: the page a discovery cursor holds", () => {
		const failures: string[] = [];
		for (const expected of dataset.search_cursor) {
			const cursor = unpack(expected.cursor) as string;
			let actual: { value?: string; error?: string; raises?: string };
			try {
				actual = { value: onedrive.searchCursor(cursor) };
			} catch (error) {
				if (error instanceof OperationError) actual = { error: error.code };
				else if (error instanceof RangeError) actual = { raises: "RecursionError" };
				else throw error;
			}
			// Python's json raises RecursionError on a hundred thousand brackets; parseJson bounds the nesting and fails.
			const want = expected.raises ? { error: "INVALID_CURSOR" } : { value: expected.value, error: expected.error };
			const got = actual.raises ? { error: "INVALID_CURSOR" } : { value: actual.value, error: actual.error };
			if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${JSON.stringify(cursor).slice(0, 80)}: python ${JSON.stringify(expected)}, ts ${JSON.stringify(actual)}`);
		}
		expect(failures).toEqual([]);
	});
});

describe("tool inputs", () => {
	const names: [string, string][] = [
		["list_libraries", "list_libraries"],
		["list_folder", "list_folder"],
		["search_files", "search_files"],
		["get_file", "get_file"],
		["read_file", "read_file"],
		["create_file", "create_file"],
	];
	for (const [key, name] of names) {
		test(`inputs of ${name}: normalized arguments and Pydantic's messages`, async () => {
			const cases = dataset.inputs[key] as { args: Json; data?: Json; message?: string; raises?: string }[];
			expect(cases.length).toBeGreaterThan(1);
			const op = operation(onedriveConnector(), name);
			const failures: string[] = [];
			for (const expected of cases) {
				const args = unpack(expected.args) as Json;
				if (changedOnPurpose(args)) continue;
				const result = await validateInput(op.input as never, args);
				const actual = result.ok ? { data: result.data as Json } : { refused: true };
				const want = expected.message !== undefined ? { refused: true } : { data: unpack(expected.data) as Json };
				if (JSON.stringify(actual) !== JSON.stringify(want)) {
					failures.push(`${JSON.stringify(expected.args).slice(0, 200)}\n   python ${JSON.stringify(want).slice(0, 300)}\n   ts     ${JSON.stringify(actual).slice(0, 300)}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}
});
