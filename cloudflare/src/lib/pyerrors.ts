// Python's built-in exceptions with Python's hierarchy, for ports whose callers catch some of them and let
// others through as the Python code does (gmail's email package, lib/urlsplit.ts). Moved
// here from connectors/gmail/email/errors.ts, which keeps the email package's own and re-exports these.

export class PythonError extends Error {
	constructor(message = "") {
		super(message);
		this.name = new.target.name;
	}
}

export class ValueError extends PythonError {}
export class OverflowError extends PythonError {}
export class UnicodeError extends ValueError {}
export class UnicodeDecodeError extends UnicodeError {}
export class UnicodeEncodeError extends UnicodeError {}
export class LookupError extends PythonError {}
export class KeyError extends LookupError {}
export class IndexError extends LookupError {}
export class PyTypeError extends PythonError {}

/** `s[i]` as Python indexes a str: by code point here only where the caller passes code points. */
export function at<T>(items: ArrayLike<T>, index: number): T {
	const i = index < 0 ? items.length + index : index;
	if (i < 0 || i >= items.length) throw new IndexError("index out of range");
	return items[i] as T;
}
