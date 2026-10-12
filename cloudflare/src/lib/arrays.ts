// Array helpers.

/**
 * `target.push(...items)` without the spread: a call spreads its arguments onto the stack, so an array of
 * more than about 100,000 items (a large provider page, a long run of text pieces) throws RangeError.
 */
export function extend<T>(target: T[], items: Iterable<T>): void {
	for (const item of items) target.push(item);
}
