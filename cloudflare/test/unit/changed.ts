// The cases of the generated vector suites where Minerva now differs from what Python did, on purpose:
// string lengths count UTF-16 units, `trim()` and `\s` are JavaScript's whitespace (U+FEFF, not U+0085 or
// U+001C to U+001F), only ASCII digits are digits, record keys are not stripped, and "__proto__",
// "constructor" and lone surrogates are refused. Messages quote names as JSON does. The suites skip those
// cases, or compare messages with `jsonQuoted`, until the connector units replace the suites.

const PATTERNS = [
	/[\u{10000}-\u{10ffff}\u0085\ufeff\u001c-\u001f]|\\u001[c-f]/u,
	/(?![0-9])\p{Nd}/u,
	/"\s+\w+\s+":/,
	/__proto__|"constructor"|\\ud[89a-f]/,
];

/** Whether a vector's input (as it is, or its JSON text) is one of those cases. */
export function changedOnPurpose(input: unknown): boolean {
	const text = typeof input === "string" ? input : JSON.stringify(input) ?? "";
	return PATTERNS.some((pattern) => pattern.test(text));
}

const ESCAPES: { readonly [char: string]: string } = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'" };

/** A message the vectors recorded with Python's quotes ('a\x00b'), with JSON's ("a\u0000b") instead. */
export function jsonQuoted(message: string): string {
	return message.replace(/'((?:[^'"\\]|\\.)*)'/g, (_, inner: string) =>
		JSON.stringify(
			inner.replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|U[0-9a-f]{8}|.)/g, (escape: string, code: string) =>
				code.length > 1 ? String.fromCodePoint(Number.parseInt(code.slice(1), 16)) : (ESCAPES[code] ?? escape),
			),
		),
	);
}

/** Whether an expected value spells Python's None, True, False, a list or a dict, where JSON's are written now. */
export function showsPythonValues(expected: unknown): boolean {
	return /\bNone\b|\bTrue\b|\bFalse\b|\['|\{'/.test(JSON.stringify(expected) ?? "");
}
