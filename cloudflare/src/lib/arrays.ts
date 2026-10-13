// Array helpers.

/**
 * `target.push(...items)` without the spread: a call spreads its arguments onto the stack, so an array of
 * more than about 100,000 items (a large provider page, a long run of text pieces) throws RangeError.
 */
export function extend<T>(target: T[], items: Iterable<T>): void {
	for (const item of items) target.push(item);
}

/** A `sort` comparator for strings: by UTF-16 code unit, as `<` compares them and `sort()` orders strings. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
