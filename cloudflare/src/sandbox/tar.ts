// The tar archives of the folder (POSIX pax): hydration writes one into `tar -x`, and a checkpoint reads the
// one `tar -c` writes. Each entry the writer makes has an extended header with its path and its mtime in
// milliseconds, then its ustar header. The reader takes what the container wrote as untrusted: every header's
// checksum and magic are checked, numbers are parsed strictly, an extended header is bounded and its records
// must fill it exactly, bodies must be followed by zero padding, and the archive must end with two zero
// blocks and nothing but zeros after them.

import { type ByteReader, StreamEnded, TooLong } from "./bytes.ts";
import { AGENT_GID, AGENT_UID } from "./constants.ts";

export const BLOCK = 512;
/** The end of an archive: two zero blocks. */
export const END = new Uint8Array(2 * BLOCK);
/** An extended header's records: a path of at most 1,024 bytes and a few timestamps fit well within. */
const MAX_EXTENDED = 8 * 1024;
/** `tar -c` fills its last record of 10,240 bytes with zeros after the end blocks. */
const MAX_TRAILING = 20 * BLOCK;
/** The largest number an 11-digit octal field holds. */
const MAX_OCTAL = 8 ** 11 - 1;
/** Typeflags: a regular file, a directory, an extended header. */
export const FILE = 0x30;
const DIRECTORY = 0x35;
const EXTENDED = 0x78;
const MAGIC = new TextEncoder().encode("ustar\u000000");

/** The archive is not what it should be. */
export class TarError extends Error {}

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

function octal(block: Uint8Array, offset: number, width: number, value: number): void {
	block.set(encoder.encode(value.toString(8).padStart(width - 1, "0")), offset);
}

/** A ustar header block. Names longer than its field are carried by the extended header before it. */
function ustar(name: Uint8Array, type: number, size: number, mode: number, mtimeSeconds: number): Uint8Array {
	const block = new Uint8Array(BLOCK);
	block.set(name.subarray(0, 100), 0);
	octal(block, 100, 8, mode);
	octal(block, 108, 8, AGENT_UID);
	octal(block, 116, 8, AGENT_GID);
	octal(block, 124, 12, size);
	octal(block, 136, 12, mtimeSeconds);
	block.fill(0x20, 148, 156);
	block[156] = type;
	block.set(MAGIC, 257);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
	return block;
}

/** One extended header record, `<length> <key>=<value>\n`, its length counting its own digits. */
function record(key: string, value: string): Uint8Array {
	const body = encoder.encode(` ${key}=${value}\n`);
	let length = body.length + 1;
	while (String(length).length + body.length !== length) length = String(length).length + body.length;
	const digits = encoder.encode(String(length));
	const out = new Uint8Array(length);
	out.set(digits, 0);
	out.set(body, digits.length);
	return out;
}

/** Zero bytes from the end of a body of `size` bytes to its next block. */
export function padding(size: number): Uint8Array {
	return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
}

export interface TarEntry {
	path: string;
	type: "file" | "directory";
	size: number;
	mode: number;
	/** Milliseconds since the epoch, at least 0. */
	mtime: number;
}

/** An entry's headers: an extended header with its path and mtime (and a size too large for ustar), then its ustar header. */
export function entryHeader(entry: TarEntry): Uint8Array {
	const seconds = Math.floor(entry.mtime / 1000);
	const size = entry.type === "file" ? entry.size : 0;
	const records = [record("path", entry.path), record("mtime", `${seconds}.${String(entry.mtime % 1000).padStart(3, "0")}`)];
	if (size > MAX_OCTAL) records.push(record("size", String(size)));
	const extended = new Uint8Array(records.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of records) {
		extended.set(part, at);
		at += part.length;
	}
	const head = ustar(encoder.encode("PaxHeader"), EXTENDED, extended.length, 0o644, 0);
	const main = ustar(encoder.encode(entry.path), entry.type === "file" ? FILE : DIRECTORY, size > MAX_OCTAL ? 0 : size, entry.mode, seconds > MAX_OCTAL ? 0 : seconds);
	const out = new Uint8Array(BLOCK + extended.length + padding(extended.length).length + BLOCK);
	out.set(head, 0);
	out.set(extended, BLOCK);
	out.set(main, out.length - BLOCK);
	return out;
}

/** An entry as the reader found it: its name (the extended header's path, else the ustar prefix and name), typeflag and size. */
export interface ReadEntry {
	name: Uint8Array;
	type: number;
	size: number;
}

function isZero(bytes: Uint8Array): boolean {
	for (const byte of bytes) if (byte !== 0) return false;
	return true;
}

/** A numeric field: octal digits, then only NULs or spaces. */
function number(block: Uint8Array, offset: number, width: number): number {
	const match = /^([0-7]+)[\0 ]*$/.exec(latin1.decode(block.subarray(offset, offset + width)));
	if (!match) throw new TarError("A header holds a malformed number.");
	const value = Number.parseInt(match[1] as string, 8);
	if (!Number.isSafeInteger(value)) throw new TarError("A header holds a number out of range.");
	return value;
}

/** A NUL-terminated string field's bytes. */
function text(block: Uint8Array, offset: number, width: number): Uint8Array {
	const field = block.subarray(offset, offset + width);
	const end = field.indexOf(0);
	return end === -1 ? field : field.subarray(0, end);
}

function checkHeader(block: Uint8Array): void {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
	if (number(block, 148, 8) !== sum) throw new TarError("A header's checksum is wrong.");
	for (let i = 0; i < MAGIC.length; i++) if (block[257 + i] !== MAGIC[i]) throw new TarError("A header is not a ustar header.");
}

/** An extended header's records, each `<length> <key>=<value>\n` filling it exactly; only `path` and `size` are used. */
export function extendedRecords(body: Uint8Array): { path?: Uint8Array; size?: number } {
	const out: { path?: Uint8Array; size?: number } = {};
	const seen = new Set<string>();
	let at = 0;
	while (at < body.length) {
		const space = body.indexOf(0x20, at);
		const digits = space === -1 ? "" : latin1.decode(body.subarray(at, space));
		if (!/^[1-9][0-9]{0,4}$/.test(digits)) throw new TarError("An extended header record has a malformed length.");
		const end = at + Number(digits);
		if (end > body.length || body[end - 1] !== 0x0a) throw new TarError("An extended header record does not end where its length says.");
		const content = body.subarray(space + 1, end - 1);
		const equals = content.indexOf(0x3d);
		if (equals < 1) throw new TarError("An extended header record has no key.");
		const key = latin1.decode(content.subarray(0, equals));
		const value = content.subarray(equals + 1);
		if (seen.has(key)) throw new TarError("An extended header repeats a key.");
		seen.add(key);
		if (key === "path") out.path = value;
		else if (key === "size") {
			const size = latin1.decode(value);
			if (!/^(0|[1-9][0-9]{0,15})$/.test(size) || !Number.isSafeInteger(Number(size))) throw new TarError("An extended header holds a malformed size.");
			out.size = Number(size);
		} else if (key.startsWith("GNU.sparse")) throw new TarError("A sparse archive member is not read.");
		at = end;
	}
	return out;
}

/** Reads an archive's entries from a process's output, strictly and in bounded pieces. */
export class TarReader {
	readonly #input: ByteReader;

	constructor(input: ByteReader) {
		this.#input = input;
	}

	async #exactly(length: number): Promise<Uint8Array> {
		try {
			return await this.#input.exactly(length);
		} catch (error) {
			if (error instanceof StreamEnded) throw new TarError("The archive ended early.");
			throw error;
		}
	}

	/** The next entry's header, its extended header applied; null at the end of the archive. */
	async next(): Promise<ReadEntry | null> {
		let extended: { path?: Uint8Array; size?: number } | null = null;
		for (;;) {
			const block = await this.#exactly(BLOCK);
			if (isZero(block)) {
				if (extended) throw new TarError("An extended header precedes the end of the archive.");
				if (!isZero(await this.#exactly(BLOCK))) throw new TarError("The archive's end has one zero block.");
				return null;
			}
			checkHeader(block);
			const type = block[156] as number;
			const size = number(block, 124, 12);
			if (type === EXTENDED) {
				if (extended) throw new TarError("Two extended headers precede one entry.");
				if (size > MAX_EXTENDED) throw new TarError("An extended header is too long.");
				extended = extendedRecords(await this.#exactly(size));
				await this.padding(size);
				continue;
			}
			const prefix = text(block, 345, 155);
			const name = text(block, 0, 100);
			const joined = prefix.length === 0 ? name : new Uint8Array([...prefix, 0x2f, ...name]);
			return { name: extended?.path ?? joined, type, size: extended?.size ?? size };
		}
	}

	/** Reads the zero padding after a body of `size` bytes. */
	async padding(size: number): Promise<void> {
		const length = padding(size).length;
		if (length > 0 && !isZero(await this.#exactly(length))) throw new TarError("A body's padding is not zero.");
	}

	/** After the end blocks: nothing but zeros, at most a record's worth, then the end of the output. */
	async end(): Promise<void> {
		let rest: Uint8Array;
		try {
			rest = await this.#input.rest(MAX_TRAILING);
		} catch (error) {
			if (error instanceof TooLong) throw new TarError("Bytes follow the end of the archive.");
			throw error;
		}
		if (!isZero(rest)) throw new TarError("Bytes follow the end of the archive.");
	}
}
