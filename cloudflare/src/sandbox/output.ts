// A command's output on its way to the caller (pi's `ShellExecOptions`): each stream decoded on its own as
// pi's StreamDecoder does, every chunk delivered in arrival order, and, with a window, output outside the
// tail the caller keeps skipped and counted, at most one delivery per `minIntervalMs` and its size at
// `bytesPerSecond` (pi's ShellOutputWindow and ShellOutputSkip). The spill thresholds are pi's: raw bytes
// and lines of both streams in arrival order, the last chunk's unterminated line counted.

import type { ShellOutputSkip, ShellOutputWindow, ShellSpillOptions } from "@earendil-works/pi-durable/env";

export type Stream = "stdout" | "stderr";
export interface Delivered {
	stream: Stream;
	text: string;
	skipped?: ShellOutputSkip;
}

const encoder = new TextEncoder();
const NEWLINE = 0x0a;

export function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

export function newlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** Decodes one stream chunk by chunk exactly like decoding all of it at once (pi's StreamDecoder). */
export class StreamText {
	readonly #decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
	#started = false;

	decode(bytes?: Uint8Array): string {
		const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
		if (this.#started || text === "") return text;
		this.#started = true;
		return text.startsWith("﻿") ? text.slice(1) : text;
	}
}

/**
 * The shortest suffix of `text` with more than `maxBytes` bytes or more than `maxLines` newlines, split at a
 * character boundary, and what precedes it (pi's tailMargin): the tail window of `text` followed by
 * anything is the window of the suffix followed by it, so the head can be skipped.
 */
export function splitTail(text: string, window: { maxBytes: number; maxLines: number }): { head: string; tail: string } {
	const bytes = encoder.encode(text);
	let byteStart = 0;
	if (bytes.length > window.maxBytes) {
		byteStart = bytes.length - window.maxBytes - 1;
		while (byteStart > 0 && ((bytes[byteStart] ?? 0) & 0xc0) === 0x80) byteStart--;
	}
	let lineStart = 0;
	let count = 0;
	for (let index = bytes.lastIndexOf(NEWLINE); index !== -1; index = index === 0 ? -1 : bytes.lastIndexOf(NEWLINE, index - 1)) {
		if (++count > window.maxLines) {
			lineStart = index;
			break;
		}
	}
	const start = Math.max(byteStart, lineStart);
	if (start === 0) return { head: "", tail: text };
	const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
	return { head: decoder.decode(bytes.subarray(0, start)), tail: decoder.decode(bytes.subarray(start)) };
}

function beyond(text: string, window: { maxBytes: number; maxLines: number }): boolean {
	return utf8Length(text) > window.maxBytes || newlines(text) > window.maxLines;
}

export interface PumpOptions {
	window?: ShellOutputWindow;
	deliver(chunk: Delivered): Promise<void>;
	now(): number;
	/** Waits `ms`; a pacing wait ends early when the pump is flushed. */
	sleep(ms: number): Promise<void>;
}

/** Without a window every byte is delivered, so a producer waits (`room`) while this much is queued. */
const QUEUED_UNITS = 2 * 1024 * 1024;

function addSkip(a: ShellOutputSkip | null, text: string): ShellOutputSkip {
	return { bytes: (a?.bytes ?? 0) + utf8Length(text), newlines: (a?.newlines ?? 0) + newlines(text), endsWithNewline: text === "" ? (a?.endsWithNewline ?? false) : text.endsWith("\n") };
}

/**
 * Output in arrival order, delivered one call at a time. With a window, what can no longer be in the tail is
 * dropped as it arrives and counted, so a fast producer behind a slow caller holds at most a few windows;
 * without one, the producer waits while the queue is full.
 */
export class OutputPump {
	readonly #options: PumpOptions;
	#queue: { stream: Stream; text: string }[] = [];
	#units = 0;
	/** Output dropped before what is queued, not yet reported. */
	#skipped: ShellOutputSkip | null = null;
	#running: Promise<void> | null = null;
	#nextAt = 0;
	#flushing = false;
	#failed = false;
	#wake: (() => void) | null = null;
	#roomWaiters: (() => void)[] = [];

	constructor(options: PumpOptions) {
		this.#options = options;
	}

	/** UTF-16 units queued and not yet delivered. */
	get queued(): number {
		return this.#units;
	}

	/** Whether a delivery failed; later output is dropped. */
	get failed(): boolean {
		return this.#failed;
	}

	push(stream: Stream, text: string): void {
		if (text === "" || this.#failed) return;
		const last = this.#queue.at(-1);
		if (last && last.stream === stream) last.text += text;
		else this.#queue.push({ stream, text });
		this.#units += text.length;
		const window = this.#options.window;
		if (window && this.#units > Math.max(4 * window.maxBytes, 4 * window.maxLines * 80, 64 * 1024)) this.#trim(window);
		this.#start();
	}

	/** Resolves once the queue has room; without a window it holds the producer back. */
	room(): Promise<void> {
		if (this.#options.window || this.#failed || this.#units < QUEUED_UNITS) return Promise.resolve();
		return new Promise((resolve) => this.#roomWaiters.push(resolve));
	}

	/** Drops the queued output that is past the window, keeping the shortest tail beyond it. */
	#trim(window: { maxBytes: number; maxLines: number }): void {
		const all = this.#queue.map((chunk) => chunk.text).join("");
		const { head, tail } = splitTail(all, window);
		if (head === "") return;
		this.#skipped = addSkip(this.#skipped, head);
		this.#queue = [{ stream: (this.#queue.at(-1) as { stream: Stream }).stream, text: tail }];
		this.#units = tail.length;
	}

	/** Delivers what is queued without waiting for the pace, then waits for every delivery. */
	async flush(): Promise<void> {
		this.#flushing = true;
		this.#wake?.();
		this.#start();
		while (this.#running) await this.#running;
	}

	#start(): void {
		this.#running ??= this.#loop().finally(() => {
			this.#running = null;
			if (this.#queue.length && !this.#failed) this.#start();
		});
	}

	#take(): Delivered[] {
		const batch = this.#queue;
		const skipped = this.#skipped;
		this.#queue = [];
		this.#units = 0;
		this.#skipped = null;
		for (const wake of this.#roomWaiters.splice(0)) wake();
		const window = this.#options.window;
		if (!window) return batch;
		const all = batch.map((chunk) => chunk.text).join("");
		const stream = (batch.at(-1) as { stream: Stream }).stream;
		const { head, tail } = beyond(all, window) ? splitTail(all, window) : { head: "", tail: all };
		if (head === "" && skipped === null) return batch;
		// The tail is past the window by a byte or a line, so nothing skipped before it can be in the kept tail.
		return [{ stream, text: tail, skipped: head === "" ? (skipped as ShellOutputSkip) : addSkip(skipped, head) }];
	}

	async #loop(): Promise<void> {
		while (this.#queue.length && !this.#failed) {
			const window = this.#options.window;
			if (window && !this.#flushing) {
				const wait = this.#nextAt - this.#options.now();
				if (wait > 0) {
					await Promise.race([this.#options.sleep(wait), new Promise<void>((resolve) => (this.#wake = resolve))]);
					this.#wake = null;
					continue;
				}
			}
			let delivered = 0;
			try {
				for (const chunk of this.#take()) {
					delivered += utf8Length(chunk.text);
					await this.#options.deliver(chunk);
				}
			} catch {
				this.#failed = true;
				this.#queue = [];
				this.#units = 0;
				for (const wake of this.#roomWaiters.splice(0)) wake();
				return;
			}
			if (window) this.#nextAt = this.#options.now() + Math.max(window.minIntervalMs, (delivered * 1000) / window.bytesPerSecond);
		}
	}
}

/** pi's spill thresholds over raw output in arrival order: whether the complete output must be kept in a file. */
export class SpillCounter {
	readonly #options: ShellSpillOptions;
	#bytes = 0;
	#newlines = 0;

	constructor(options: ShellSpillOptions) {
		this.#options = options;
	}

	/** Counts `chunk`; true once the output passed either threshold. */
	passed(chunk: Uint8Array): boolean {
		if (chunk.length === 0) return false;
		this.#bytes += chunk.length;
		for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) this.#newlines++;
		const lines = this.#newlines + (chunk[chunk.length - 1] === NEWLINE ? 0 : 1);
		return this.#bytes > this.#options.afterBytes || lines > this.#options.afterLines;
	}
}
