// The folder's tar archives (src/sandbox/tar.ts): what the writer makes reads back, and the reader refuses
// anything but a well-formed pax archive, whatever the chunks it arrives in. GNU tar's own archives are read
// in the Docker tests (test/docker/folder.test.ts).

import { describe, expect, test } from "vitest";
import { ByteReader, StreamEnded } from "../../src/sandbox/bytes.ts";
import { BLOCK, END, entryHeader, extendedRecords, FILE, padding, TarError, TarReader } from "../../src/sandbox/tar.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** The bytes as a stream of `chunk`-byte pieces. */
function chunked(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(at, at + chunk));
			at += chunk;
		},
	});
}

function file(path: string, data: string, mode = 0o644, mtime = 1_700_000_000_123): Uint8Array {
	const bytes = encoder.encode(data);
	return concat([entryHeader({ path, type: "file", size: bytes.length, mode, mtime }), bytes, padding(bytes.length)]);
}

/** Every entry of an archive with its body, as the checkpoint reads them. */
async function read(archive: Uint8Array, chunk = 4096): Promise<{ name: string; type: number; data: string }[]> {
	const input = new ByteReader(chunked(archive, chunk));
	const reader = new TarReader(input);
	const out = [];
	for (;;) {
		const entry = await reader.next();
		if (!entry) break;
		const data = await input.exactly(entry.size);
		await reader.padding(entry.size);
		out.push({ name: decoder.decode(entry.name), type: entry.type, data: decoder.decode(data) });
	}
	await reader.end();
	return out;
}

/** A ustar header block for `name`, with a correct checksum after `edit` changes it. */
function block(name: string, size: number, edit: (block: Uint8Array) => void = () => {}): Uint8Array {
	const archive = entryHeader({ path: name, type: "file", size, mode: 0o644, mtime: 0 });
	const header = archive.slice(archive.length - BLOCK);
	edit(header);
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return header;
}

describe("the writer", () => {
	test("its entries read back with their names, types and bodies, a long name and one past ustar's prefix included", async () => {
		const long = `${"x".repeat(200)}/${"é".repeat(100)}`;
		const archive = concat([
			entryHeader({ path: "empty/inner", type: "directory", size: 0, mode: 0o755, mtime: 0 }),
			file("a.txt", "alpha"),
			file(long, "long"),
			file("-x", ""),
			file("block", "b".repeat(BLOCK)),
			END,
		]);
		expect(archive.length % BLOCK).toBe(0);
		for (const chunk of [1, 7, 512, 100_000]) {
			expect(await read(archive, chunk)).toEqual([
				{ name: "empty/inner", type: 0x35, data: "" },
				{ name: "a.txt", type: FILE, data: "alpha" },
				{ name: long, type: FILE, data: "long" },
				{ name: "-x", type: FILE, data: "" },
				{ name: "block", type: FILE, data: "b".repeat(BLOCK) },
			]);
		}
	});

	test("an extended header's records count their own length, across a change in its digits", () => {
		for (let length = 1; length < 1100; length += 1) {
			const header = entryHeader({ path: "p".repeat(length), type: "file", size: 0, mode: 0o644, mtime: 1 });
			const size = Number.parseInt(decoder.decode(header.subarray(124, 135)), 8);
			expect(decoder.decode(extendedRecords(header.subarray(BLOCK, BLOCK + size)).path)).toBe("p".repeat(length));
		}
	});

	test("the mtime is exact to the millisecond in the extended header, and the mode is the entry's", () => {
		const header = entryHeader({ path: "f", type: "file", size: 3, mode: 0o755, mtime: 253_402_300_799_999 });
		expect(decoder.decode(header.subarray(BLOCK, 2 * BLOCK))).toContain(" mtime=253402300799.999\n");
		const main = header.subarray(header.length - BLOCK);
		expect(decoder.decode(main.subarray(100, 107))).toBe("0000755");
		// Past ustar's 11 octal digits, the ustar field holds 0 and the extended header the time.
		expect(decoder.decode(main.subarray(136, 147))).toBe("00000000000");
	});
});

describe("the reader refuses", () => {
	const good = file("a", "abc");
	const cases: [string, Uint8Array][] = [
		["a wrong checksum", concat([block("a", 3, (header) => (header[0] = 0x62)).map((byte, index) => (index === 148 ? 0x31 : byte)), END])],
		["a size that is not octal", concat([block("a", 0, (header) => header.set(encoder.encode("0000000008\0"), 124)), END])],
		["a size with a leading space", concat([block("a", 0, (header) => header.set(encoder.encode(" 000000000\0"), 124)), END])],
		["a header that is not ustar", concat([block("a", 0, (header) => header.set(encoder.encode("gnutar"), 257)), END])],
		["an archive that ends inside an extended header", good.subarray(0, BLOCK + 100)],
		["an archive that ends inside a header", good.subarray(0, 2 * BLOCK + 100)],
		["an archive without its end", good],
		["an archive with one end block", concat([good, new Uint8Array(BLOCK)])],
		["padding that is not zero", concat([good.map((byte, index) => (index === good.length - 1 ? 1 : byte)), END])],
		["bytes after the end", concat([good, END, encoder.encode("x")])],
		["more zeros after the end than a record", concat([good, END, new Uint8Array(21 * BLOCK)])],
		["a mebibyte of zeros after the end", concat([good, END, new Uint8Array(1024 * 1024)])],
		["an extended header before the end", concat([entryHeader({ path: "a", type: "file", size: 0, mode: 0o644, mtime: 0 }).subarray(0, 2 * BLOCK), END])],
		[
			"two extended headers before one entry",
			concat([entryHeader({ path: "a", type: "file", size: 0, mode: 0o644, mtime: 0 }).subarray(0, 2 * BLOCK), entryHeader({ path: "a", type: "file", size: 0, mode: 0o644, mtime: 0 }), END]),
		],
		["an extended header past its bound", concat([block("x", 9000, (header) => (header[156] = 0x78)), new Uint8Array(9216), block("a", 0), END])],
	];
	for (const [name, archive] of cases) {
		test(`${name}, whatever its chunks`, async () => {
			for (const chunk of [100, BLOCK, archive.length]) await expect(read(archive, chunk), String(chunk)).rejects.toThrow(TarError);
		});
	}

	test("an archive that ends inside a body, when the body is read", async () => {
		await expect(read(good.subarray(0, good.length - BLOCK + 2), 100)).rejects.toThrow(StreamEnded);
	});

	test("extended records that do not fill their header exactly, repeat a key or describe a sparse member", () => {
		const bad = ["5 a=b\n", "7 a=b\n", "06 a=b\n", "6 a=b", "7 =bcd\n", "6 a=b\n6 a=c\n", "17 path=x\n", "6 a=b\nx", "21 GNU.sparse.size=1\n", "11 size=-1\n", "12 size=0x1\n"];
		for (const records of bad) expect(() => extendedRecords(encoder.encode(records)), records).toThrow(TarError);
		expect(extendedRecords(encoder.encode("10 path=x\n9 size=7\n30 mtime=1700000000.123456789\n"))).toEqual({ path: encoder.encode("x"), size: 7 });
	});
});
