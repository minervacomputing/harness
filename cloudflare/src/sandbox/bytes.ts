// Reading a process's stdout in pieces: a field up to a delimiter, an exact number of bytes, with bounds, so
// a hostile process cannot make the Sandbox buffer more than it asked for.

export class StreamEnded extends Error {}
export class TooLong extends Error {}

export class ByteReader {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly #chunks: Uint8Array[] = [];
	#size = 0;
	#ended = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.#reader = stream.getReader();
	}

	async #fill(): Promise<boolean> {
		if (this.#ended) return false;
		const { done, value } = await this.#reader.read();
		if (done) {
			this.#ended = true;
			return false;
		}
		if (value.length) {
			this.#chunks.push(value);
			this.#size += value.length;
		}
		return true;
	}

	#take(length: number): Uint8Array {
		const first = this.#chunks[0];
		if (first && first.length >= length) {
			const out = first.subarray(0, length);
			if (first.length === length) this.#chunks.shift();
			else this.#chunks[0] = first.subarray(length);
			this.#size -= length;
			return out;
		}
		const out = new Uint8Array(length);
		let at = 0;
		while (at < length) {
			const chunk = this.#chunks[0] as Uint8Array;
			const part = Math.min(chunk.length, length - at);
			out.set(chunk.subarray(0, part), at);
			at += part;
			if (part === chunk.length) this.#chunks.shift();
			else this.#chunks[0] = chunk.subarray(part);
		}
		this.#size -= length;
		return out;
	}

	#find(delimiter: number, from: number): number {
		let base = 0;
		for (const chunk of this.#chunks) {
			if (base + chunk.length > from) {
				const index = chunk.indexOf(delimiter, Math.max(0, from - base));
				if (index !== -1) return base + index;
			}
			base += chunk.length;
		}
		return -1;
	}

	/** Puts bytes back in front of what is buffered. */
	unshift(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		this.#chunks.unshift(bytes);
		this.#size += bytes.length;
	}

	/**
	 * Up to and without the next `delimiter` byte, which is consumed; at most `max` bytes before it. Null at the
	 * end of the stream with nothing buffered.
	 */
	async until(delimiter: number, max: number): Promise<Uint8Array | null> {
		let searched = 0;
		for (;;) {
			const index = this.#find(delimiter, searched);
			if (index !== -1) {
				if (index > max) throw new TooLong(`A field passed ${max} bytes.`);
				const field = this.#take(index);
				this.#take(1);
				return field;
			}
			searched = this.#size;
			if (searched > max) throw new TooLong(`A field passed ${max} bytes.`);
			if (!(await this.#fill())) {
				if (this.#size === 0) return null;
				throw new StreamEnded("The stream ended inside a field.");
			}
		}
	}

	/** Exactly `length` bytes. */
	async exactly(length: number): Promise<Uint8Array> {
		while (this.#size < length) {
			if (!(await this.#fill())) throw new StreamEnded(`The stream ended ${length - this.#size} bytes early.`);
		}
		return this.#take(length);
	}

	/** At least one byte, or null at the end: what is buffered, else the next chunk. */
	async some(): Promise<Uint8Array | null> {
		if (this.#size === 0 && !(await this.#fill())) return null;
		if (this.#size === 0) return this.some();
		return this.#take(this.#size);
	}

	/** Everything to the end, refused past `max` bytes. */
	async rest(max: number): Promise<Uint8Array> {
		do if (this.#size > max) throw new TooLong(`The output passed ${max} bytes.`);
		while (await this.#fill());
		return this.#take(this.#size);
	}

	async cancel(): Promise<void> {
		await this.#reader.cancel().catch(() => undefined);
	}
}

/** A stream's bytes up to `max`, the rest discarded but drained, so a writer never blocks on it. */
export async function drain(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
	if (!stream) return new Uint8Array(0);
	const parts: Uint8Array[] = [];
	let kept = 0;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (kept < max) {
				const part = value.subarray(0, max - kept);
				parts.push(part);
				kept += part.length;
			}
		}
	} catch {
		// A stream the container closed abruptly ends what was read.
	}
	const out = new Uint8Array(kept);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
