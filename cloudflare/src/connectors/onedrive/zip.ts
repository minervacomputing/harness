// Reading a zip archive held in memory, as Python's zipfile reads one (backend/connectors/onedrive/office.py
// relies on it): the end of central directory record (searched for behind a comment of up to 64 KiB, and its
// Zip64 form), the central directory with each entry's name (UTF-8 when flagged, else code page 437, cut
// at a NUL, or the Unicode path extra field's), sizes and offsets (Zip64 extra fields), then an entry's local
// header (its name must be the directory's; entries may not overlap) and its data, stored or deflated,
// read in pieces with the output cut to the declared size and its CRC-32 checked at the end.
//
// DEFLATE is fflate's streaming inflate, fed a few KiB at a time, so a small entry that expands enormously
// is read only as far as its reader asks. fflate refuses some corrupt streams zlib would decode a little
// further first (and accepts a few zlib refuses, which the CRC then catches); either way the file is
// unreadable.
//
// Errors: `BadZip` for everything Python reports as BadZipFile, EOFError, ValueError (a name that is not
// valid UTF-8) or RuntimeError (patched or strongly encrypted data); `ZipVersion` for an entry that needs a
// newer zip version, which Python's ZipFile raises as a NotImplementedError while it reads the directory.

import { Inflate } from "fflate";
import { fromUtf8Strict } from "../../lib/bytes.ts";

export class BadZip extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadZipFile";
	}
}

/** NotImplementedError from reading the directory: not one of the errors office.py turns into "unreadable". */
export class ZipVersion extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotImplementedError";
	}
}

export const STORED = 0;
export const DEFLATED = 8;
const MAX_EXTRACT_VERSION = 63;
const END_SIZE = 22;
const END64_LOCATOR_SIZE = 20;
const END64_SIZE = 56;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 65535;
const UTF8_NAME = 1 << 11;
const COMPRESSED_PATCH = 1 << 5;
const STRONG_ENCRYPTION = 1 << 6;
const ENCRYPTED = 1 << 0;
/** Compressed bytes inflated at a time (Python's ZipExtFile reads at least 4 KiB). */
const INFLATE_INPUT = 4096;

const CP437_HIGH =
	"ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function cp437(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] as string);
	return out;
}

/** A name's bytes decoded as the flag says; invalid UTF-8 is a ValueError (UnicodeDecodeError) in Python. */
function decodeName(bytes: Uint8Array, flags: number): string {
	if (!(flags & UTF8_NAME)) return cp437(bytes);
	try {
		return fromUtf8Strict(bytes);
	} catch {
		throw new BadZip("A file name is not valid UTF-8.");
	}
}

/** `_sanitize_filename`: the name up to its first NUL. */
function sanitized(name: string): string {
	const nul = name.indexOf("\u0000");
	return nul >= 0 ? name.slice(0, nul) : name;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** `zlib.crc32(data, value)`. */
export function crc32(data: Uint8Array, value = 0): number {
	let c = (value ^ 0xffffffff) >>> 0;
	for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Little-endian reads of what is there; Python's BytesIO reads fewer bytes at the end. */
class View {
	readonly data: Uint8Array;

	constructor(data: Uint8Array) {
		this.data = data;
	}

	slice(start: number, length: number): Uint8Array {
		if (start < 0 || start >= this.data.length || length <= 0) return new Uint8Array(0);
		return this.data.subarray(start, Math.min(this.data.length, start + length));
	}
}

function u16(bytes: Uint8Array, at: number): number {
	return (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
}

function u32(bytes: Uint8Array, at: number): number {
	return ((bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16) | ((bytes[at + 3] as number) << 24)) >>> 0;
}

/** A 64-bit field as a number; offsets beyond 2^53 are out of any archive's reach anyway. */
function u64(bytes: Uint8Array, at: number): number {
	return u32(bytes, at) + u32(bytes, at + 4) * 2 ** 32;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
	return signature.every((byte, index) => bytes[at + index] === byte);
}

const END_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const END64_LOCATOR_SIGNATURE = [0x50, 0x4b, 0x06, 0x07];
const END64_SIGNATURE = [0x50, 0x4b, 0x06, 0x06];
const CENTRAL_SIGNATURE = [0x50, 0x4b, 0x01, 0x02];
const LOCAL_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

interface EndRecord {
	size: number;
	offset: number;
	location: number;
}

/** `_EndRecData64`. */
function end64(view: View, location: number, record: EndRecord): EndRecord {
	let offset = location - END64_LOCATOR_SIZE;
	if (offset < 0) return record;
	const locator = view.slice(offset, END64_LOCATOR_SIZE);
	if (!startsWith(locator, END64_LOCATOR_SIGNATURE)) return record;
	const disk = u32(locator, 4);
	const relative = u64(locator, 8);
	const disks = u32(locator, 16);
	if (disk !== 0 || disks > 1) throw new BadZip("zipfiles that span multiple disks are not supported");
	offset -= END64_SIZE;
	if (relative > offset) throw new BadZip("Corrupt zip64 end of central directory locator");
	let extra = offset - relative;
	let data = view.slice(relative, END64_SIZE);
	if (!startsWith(data, END64_SIGNATURE) && relative !== offset) {
		extra = 0;
		data = view.slice(offset, END64_SIZE);
	}
	if (!startsWith(data, END64_SIGNATURE)) throw new BadZip("Zip64 end of central directory record not found");
	const size = u64(data, 4);
	const dirSize = u64(data, 40);
	const dirOffset = u64(data, 48);
	if (dirOffset + dirSize !== relative || size + 12 !== END64_SIZE + extra) throw new BadZip("Corrupt zip64 end of central directory record");
	return { size: dirSize, offset: dirOffset, location: offset - extra };
}

/** `_EndRecData`: the end of central directory record, or null. */
function endRecord(view: View): EndRecord | null {
	const size = view.data.length;
	if (size < END_SIZE) return null;
	const last = view.slice(size - END_SIZE, END_SIZE);
	if (startsWith(last, END_SIGNATURE) && last[END_SIZE - 2] === 0 && last[END_SIZE - 1] === 0) {
		return end64(view, size - END_SIZE, { size: u32(last, 12), offset: u32(last, 16), location: size - END_SIZE });
	}
	const commentStart = Math.max(size - MAX_COMMENT - END_SIZE, 0);
	const tail = view.data.subarray(commentStart);
	let start = -1;
	for (let at = tail.length - 4; at >= 0; at--) {
		if (startsWith(tail, END_SIGNATURE, at)) {
			start = at;
			break;
		}
	}
	if (start < 0) return null;
	const record = tail.subarray(start, start + END_SIZE);
	if (record.length !== END_SIZE) return null;
	return end64(view, commentStart + start, { size: u32(record, 12), offset: u32(record, 16), location: commentStart + start });
}

export interface ZipEntry {
	/** The name entries are looked up by: sanitized, or the Unicode path extra field's. */
	filename: string;
	/** The name as the central directory spells it, which the local header must repeat. */
	origFilename: string;
	flagBits: number;
	compressType: number;
	crc: number;
	compressSize: number;
	fileSize: number;
	headerOffset: number;
	/** Where the next entry (or the central directory) starts: an entry's data may not reach past it. */
	endOffset: number;
}

/** `ZipInfo._decodeExtra`: Zip64 sizes and offset, and the Unicode path extra field. */
function decodeExtra(entry: ZipEntry, extra: Uint8Array, nameCrc: number): void {
	let rest = extra;
	while (rest.length >= 4) {
		const type = u16(rest, 0);
		const length = u16(rest, 2);
		if (length + 4 > rest.length) throw new BadZip(`Corrupt extra field ${type.toString(16).padStart(4, "0")} (size=${length})`);
		let data = rest.subarray(4, length + 4);
		if (type === 0x0001) {
			const take = (): number => {
				if (data.length < 8) throw new BadZip("Corrupt zip64 extra field.");
				const value = u64(data, 0);
				data = data.subarray(8);
				return value;
			};
			if (entry.fileSize === 0xffffffff) entry.fileSize = take();
			if (entry.compressSize === 0xffffffff) entry.compressSize = take();
			if (entry.headerOffset === 0xffffffff) entry.headerOffset = take();
		} else if (type === 0x7075) {
			if (data.length < 5) throw new BadZip("Corrupt unicode path extra field (0x7075)");
			if (data[0] === 1 && u32(data, 1) === nameCrc) {
				let name: string;
				try {
					name = fromUtf8Strict(data.subarray(5));
				} catch {
					throw new BadZip("Corrupt unicode path extra field (0x7075): invalid utf-8 bytes");
				}
				if (name) entry.filename = sanitized(name);
			}
		}
		rest = rest.subarray(length + 4);
	}
}

/** `ZipFile._RealGetContents`: the entries of the central directory, in its order. */
export function readDirectory(data: Uint8Array): ZipEntry[] {
	const view = new View(data);
	const end = endRecord(view);
	if (end === null) throw new BadZip("File is not a zip file");
	const concat = end.location - end.size - end.offset;
	const startDir = end.offset + concat;
	if (startDir < 0) throw new BadZip("Bad offset for central directory");
	const directory = view.slice(startDir, end.size);
	const entries: ZipEntry[] = [];
	let total = 0;
	let at = 0;
	const read = (length: number): Uint8Array => {
		const part = directory.subarray(at, at + length);
		at += part.length;
		return part;
	};
	while (total < end.size) {
		const header = read(CENTRAL_SIZE);
		if (header.length !== CENTRAL_SIZE) throw new BadZip("Truncated central directory");
		if (!startsWith(header, CENTRAL_SIGNATURE)) throw new BadZip("Bad magic number for central directory");
		const nameLength = u16(header, 28);
		const extraLength = u16(header, 30);
		const commentLength = u16(header, 32);
		const nameBytes = read(nameLength);
		const flags = u16(header, 8);
		const origFilename = decodeName(nameBytes, flags);
		const extra = read(extraLength);
		read(commentLength);
		const extractVersion = header[6] as number;
		if (extractVersion > MAX_EXTRACT_VERSION) throw new ZipVersion(`zip file version ${(extractVersion / 10).toFixed(1)}`);
		const entry: ZipEntry = {
			filename: sanitized(origFilename),
			origFilename,
			flagBits: flags,
			compressType: u16(header, 10),
			crc: u32(header, 16),
			compressSize: u32(header, 20),
			fileSize: u32(header, 24),
			headerOffset: u32(header, 42),
			endOffset: 0,
		};
		decodeExtra(entry, extra, crc32(nameBytes));
		entry.headerOffset += concat;
		entries.push(entry);
		total += CENTRAL_SIZE + nameLength + extraLength + commentLength;
	}
	// Each entry ends where the next one (by offset) starts, the last one where the directory starts.
	const sorted = entries.map((entry, index) => [entry, index] as const).sort((a, b) => a[0].headerOffset - b[0].headerOffset || a[1] - b[1]);
	let endOffset = startDir;
	for (let i = sorted.length - 1; i >= 0; i--) {
		const entry = (sorted[i] as readonly [ZipEntry, number])[0];
		entry.endOffset = endOffset;
		endOffset = entry.headerOffset;
	}
	return entries;
}

/** An entry's data as `ZipFile.open(info).read(n)` gives it: `n` bytes at a time until the end. */
export class EntryReader {
	readonly #entry: ZipEntry;
	/** The entry's compressed data, as far as the archive holds it. */
	readonly #input: Uint8Array;
	#consumed = 0;
	#left: number;
	#eof = false;
	#crc = 0;
	readonly #queue: Uint8Array[] = [];
	#queued = 0;
	readonly #inflate: Inflate | null;

	constructor(entry: ZipEntry, input: Uint8Array) {
		this.#entry = entry;
		this.#input = input;
		this.#left = entry.fileSize;
		this.#inflate =
			entry.compressType === DEFLATED
				? new Inflate((chunk) => {
						if (chunk.length) {
							this.#queue.push(chunk);
							this.#queued += chunk.length;
						}
					})
				: null;
	}

	/** zlib's `eof`: the deflate stream's final block was read (fflate's state says so). */
	#streamEnded(): boolean {
		const state = (this.#inflate as unknown as { s: { f?: number; l?: unknown } }).s;
		return Boolean(state.f) && !state.l;
	}

	/** Whether more output may come: compressed data is left, and the deflate stream has not ended. */
	#more(): boolean {
		if (this.#consumed >= this.#entry.compressSize) return false;
		return this.#inflate === null || this.#consumed === 0 || !this.#streamEnded();
	}

	/**
	 * Feeds the next piece of compressed data: false when no more output can come. A piece the archive does
	 * not hold is Python's EOFError.
	 */
	#produce(): boolean {
		if (!this.#more()) return false;
		if (this.#inflate === null) {
			const piece = this.#input.subarray(this.#consumed, this.#consumed + Math.max(INFLATE_INPUT, 64 * 1024));
			if (!piece.length) throw new BadZip("EOFError");
			this.#consumed += piece.length;
			this.#queue.push(piece);
			this.#queued += piece.length;
			return true;
		}
		const piece = this.#input.subarray(this.#consumed, this.#consumed + INFLATE_INPUT);
		if (!piece.length) throw new BadZip("EOFError");
		this.#consumed += piece.length;
		try {
			this.#inflate.push(piece, false);
		} catch {
			throw new BadZip("Error -3 while decompressing data");
		}
		return true;
	}

	/** Up to `n` bytes; fewer only at the end of the entry, whose CRC-32 is then checked. */
	read(n: number): Uint8Array {
		if (this.#eof) return new Uint8Array(0);
		while (this.#queued < Math.min(n, this.#left) && this.#produce()) {}
		const take = Math.min(n, this.#left, this.#queued);
		const out = new Uint8Array(take);
		let filled = 0;
		while (filled < take) {
			const head = this.#queue[0] as Uint8Array;
			const part = head.subarray(0, take - filled);
			out.set(part, filled);
			filled += part.length;
			if (part.length === head.length) this.#queue.shift();
			else this.#queue[0] = head.subarray(part.length);
		}
		this.#queued -= take;
		this.#left -= take;
		this.#crc = crc32(out, this.#crc);
		// The end, as Python's reader finds it in the read that returns the last bytes: the declared size
		// reached, or nothing more to decompress.
		if (this.#left <= 0 || (this.#queued === 0 && !this.#more())) {
			this.#eof = true;
			if (this.#crc !== this.#entry.crc) throw new BadZip(`Bad CRC-32 for file ${this.#entry.filename}`);
		}
		return out;
	}
}

/** `ZipFile.open(info)`: the local header checked, and a reader of the entry's data. */
export function openEntry(data: Uint8Array, entry: ZipEntry): EntryReader {
	if (entry.headerOffset < 0) throw new BadZip("negative seek value");
	const view = new View(data);
	const header = view.slice(entry.headerOffset, LOCAL_SIZE);
	if (header.length !== LOCAL_SIZE) throw new BadZip("Truncated file header");
	if (!startsWith(header, LOCAL_SIGNATURE)) throw new BadZip("Bad magic number for file header");
	const nameLength = u16(header, 26);
	const extraLength = u16(header, 28);
	const nameBytes = view.slice(entry.headerOffset + LOCAL_SIZE, nameLength);
	if (entry.flagBits & COMPRESSED_PATCH) throw new BadZip("compressed patched data (flag bit 5)");
	if (entry.flagBits & STRONG_ENCRYPTION) throw new BadZip("strong encryption (flag bit 6)");
	if (decodeName(nameBytes, u16(header, 6)) !== entry.origFilename) throw new BadZip("File name in directory and header differ.");
	const start = entry.headerOffset + LOCAL_SIZE + nameLength + extraLength;
	if (start + entry.compressSize > entry.endOffset && entry.endOffset !== entry.headerOffset) throw new BadZip("Overlapped entries (possible zip bomb)");
	if (entry.flagBits & ENCRYPTED) throw new BadZip("The file is encrypted.");
	const end = start + entry.compressSize;
	const input = start < data.length ? data.subarray(start, Math.min(end, data.length)) : new Uint8Array(0);
	return new EntryReader(entry, input);
}
