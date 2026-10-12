// String order by code point, which is Python's `sorted()`, `json.dumps(sort_keys=True)` and UTF-8 byte
// order. JavaScript's `<` and `Array.prototype.sort()` compare UTF-16 code units instead, which puts
// astral characters (emoji) before U+E000–U+FFFF. Manifests, folder listings, changes and warnings use
// this order (files spec, risk 1), and so do the keys of `visibleJson(…, { sortKeys: true })`; canonical
// JSON does not (lib/canonical.ts: RFC 8785 sorts by UTF-16 code unit). Lone surrogates count as the code
// point they encode, as in Python.

/** Negative, zero or positive as `a` sorts before, with or after `b` by code point. */
export function compareCodePoints(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let i = 0;
	while (i < length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i === length) return a.length - b.length;
	// The strings first differ at unit i. If the unit before it is a high surrogate, the code point that
	// differs may start there: a pair in one string, a lone surrogate in the other.
	if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1))) {
		const x = a.codePointAt(i - 1) as number;
		const y = b.codePointAt(i - 1) as number;
		if (x !== y) return x - y;
	}
	return (a.codePointAt(i) as number) - (b.codePointAt(i) as number);
}

/** A copy of `items` sorted by code point, of the items themselves or of `key(item)`. */
export function sortByCodePoint<T>(items: Iterable<T>, key?: (item: T) => string): T[] {
	const keyOf = key ?? ((item: T) => item as unknown as string);
	return [...items].sort((a, b) => compareCodePoints(keyOf(a), keyOf(b)));
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}
