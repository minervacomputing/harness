// Reading the zip archives of Office files (office.ts) with zip.js, which parses the format: the end record
// and its Zip64 form, the central directory, the entries' local headers, and the stored and deflated data
// (the runtime's DecompressionStream inflates it). What is ours is the limits that contain a hostile archive:
//
// - at most `entries` entries, counted while the central directory is read, before any entry is;
// - only the entries asked for are read, one at a time;
// - an output budget shared by every read of one archive. The inflated bytes pass through a writer that
//   counts them and fails the read once the budget is spent, so an entry that expands enormously is
//   inflated only as far as the budget allows. zip.js is given 4 KiB of compressed data at a time (deflate's
//   best ratio is 1032:1) and waits for the writer between steps, so the inflater runs a few MiB ahead of
//   the budget at most;
// - each entry's CRC-32 is checked, and the last piece of an entry is handed over only once it has been, so
//   an entry of one piece is never parsed damaged. A reader that stops early (office.ts, once the text it
//   wants is complete) leaves the rest of a longer entry unchecked.
//
// zip.js also refuses output that is not the size an entry declares, a local header whose flags, method,
// CRC-32, sizes or file name differ from the directory's, and data that reaches past the directory. Not
// refused, as the budget bounds what they could cost: overlapping entries, an entry flagged as patched
// (bit 5) or strongly encrypted (bit 6) but not encrypted, and odd file names (zip.js reads UTF-8 without
// the flag, and does not cut at a NUL). Names are never used as paths.
//
// Every zip.js failure (a truncated or corrupt archive, an encrypted or unsupported entry) is a `BadZip`.

import { Uint8ArrayReader, ZipReader, configure, type Entry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { concatAll } from "../../lib/bytes.ts";

// Workers have no web workers, and zip.js is given no worker script.
configure({ useWebWorkers: false, chunkSize: 4096 });

export class BadZip extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BadZip";
	}
}

export interface ZipLimits {
	/** The most entries an archive may hold. */
	entries: number;
	/** The most bytes all the reads of one archive may inflate. */
	bytes: number;
	/** The error that fails the read which spends the budget. */
	overflow: () => Error;
}

export class Zip {
	readonly #entries: ReadonlyMap<string, Entry>;
	readonly #overflow: () => Error;
	#left: number;

	constructor(entries: ReadonlyMap<string, Entry>, limits: ZipLimits) {
		this.#entries = entries;
		this.#overflow = limits.overflow;
		this.#left = limits.bytes;
	}

	/** The archive's directory: a `BadZip` for a damaged archive, more entries than allowed or two with one name. */
	static async open(data: Uint8Array, limits: ZipLimits): Promise<Zip> {
		const entries = new Map<string, Entry>();
		try {
			const reader = new ZipReader(new Uint8ArrayReader(data), { useWebWorkers: false, checkCrc32: true, checkLocalFilename: true, filenameValidation: "tolerant" });
			for await (const entry of reader.getEntriesGenerator()) {
				if (entries.size >= limits.entries) throw new BadZip("Too many entries.");
				// Which of two entries with one name is read would be ambiguous.
				if (entries.has(entry.filename)) throw new BadZip("Two entries have one name.");
				entries.set(entry.filename, entry);
			}
		} catch (error) {
			throw error instanceof BadZip ? error : new BadZip(error instanceof Error ? error.message : "Not a zip archive.");
		}
		return new Zip(entries, limits);
	}

	has(name: string): boolean {
		return this.#entries.has(name);
	}

	/**
	 * Inflates an entry, handing `sink` its bytes in pieces of `piece` (the last is shorter). The read stops with
	 * the sink's error, or the budget's, as soon as one is thrown.
	 */
	async read(name: string, piece: number, sink: (bytes: Uint8Array) => void): Promise<void> {
		const entry = this.#entries.get(name);
		if (entry === undefined || entry.directory) throw new BadZip("No such file.");
		// zip.js may wrap what the writer throws, so the sink's own error is kept and thrown as it was.
		let failure: unknown;
		// What is not yet a whole piece, and at least the last of them: it waits for the CRC-32.
		let held: Uint8Array[] = [];
		let heldLength = 0;
		const writer = new WritableStream<Uint8Array>({
			write: (bytes) => {
				try {
					this.#left -= bytes.length;
					if (this.#left < 0) throw this.#overflow();
					held.push(bytes);
					heldLength += bytes.length;
					if (heldLength <= piece) return;
					const data = concatAll(held);
					let at = 0;
					for (; data.length - at > piece; at += piece) sink(data.subarray(at, at + piece));
					const rest = data.slice(at);
					held = [rest];
					heldLength = rest.length;
				} catch (error) {
					failure = error;
					throw error;
				}
			},
		});
		try {
			await entry.getData(writer);
		} catch (error) {
			if (failure !== undefined) throw failure;
			throw new BadZip(error instanceof Error ? error.message : "Unreadable entry.");
		}
		if (heldLength) sink(concatAll(held));
	}
}
