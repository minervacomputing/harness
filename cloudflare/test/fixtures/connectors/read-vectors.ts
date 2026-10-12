// Reads a connector's vectors file (vectors.json beside its generate.py). The generators write a long
// repetitive string as `{"$runs": [literal, [unit, count], ...]}` (vector_size.py `compact`) to keep the files
// small; they are expanded here, so a test sees the strings Python computed with.

import { readFileSync } from "node:fs";
import { type Json, parseJson } from "../../../src/lib/json.ts";

type Part = string | [unit: string, count: number];

/** The value with every `{"$runs": [...]}` replaced by the string it stands for. */
export function expandRuns(value: Json): Json {
	if (Array.isArray(value)) return value.map(expandRuns);
	if (typeof value !== "object" || value === null) return value;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "$runs") {
		return (value.$runs as unknown as Part[]).map((part) => (typeof part === "string" ? part : part[0].repeat(part[1]))).join("");
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandRuns(item)]));
}

/** The JSON file at the path (a file URL's pathname), read with parseJson (keys may hold escapes) and expanded. */
export function readVectors(path: string): Json {
	return expandRuns(parseJson(readFileSync(path, "utf8")) as Json);
}
