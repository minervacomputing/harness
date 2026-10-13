// The vectors generate.py wrote from today's Python (vectors.json), for the Google connectors' tests.

import type { Json } from "../../../../src/lib/json.ts";
import { readVectors } from "../read-vectors.ts";

// biome-ignore lint/suspicious/noExplicitAny: the vectors' shape is the test's to read.
export type Vectors = any;

let cached: Vectors | null = null;

export function vectors(): Vectors {
	cached ??= readVectors(new URL("./vectors.json", import.meta.url).pathname);
	return cached;
}

/** A validation vector: the input, and Python's normalized output or its message. */
export interface InputCase {
	input: { [key: string]: Json };
	ok?: { [key: string]: Json };
	error?: string;
	raises?: string;
}
