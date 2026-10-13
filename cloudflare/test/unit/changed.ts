// The cases of the generated vector suites where Minerva now differs from what Python did, on purpose:
// string lengths count UTF-16 units, `trim()` strips JavaScript's whitespace (U+FEFF, not U+0085), record
// keys are not stripped, and "__proto__", "constructor" and lone surrogates are refused. The suites skip
// them until the connector units replace the suites.

const PATTERNS = [/[\u{10000}-\u{10ffff}\u0085﻿]/u, /"\s+\w+\s+":/, /__proto__|"constructor"|\\ud[89a-f]/];

/** Whether a vector's input (as it is, or its JSON text) is one of those cases. */
export function changedOnPurpose(input: unknown): boolean {
	const text = typeof input === "string" ? input : JSON.stringify(input) ?? "";
	return PATTERNS.some((pattern) => pattern.test(text));
}
