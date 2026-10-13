// The Python exceptions the email package's port raises, with Python's hierarchy, since the code that calls
// it catches some and lets others through exactly as gmail/mime.py does: `except LookupError, UnicodeError`
// in `_decode`, `suppress(ValueError, LookupError, UnicodeError)` in `header_text`, `except ValueError,
// IndexError, TypeError` in `mailboxes`. An exception Python would not catch there (a HeaderParseError from
// decode_header, a CharsetError) escapes the connector as it does today, and the call fails with the
// executor's generic error.

export class PythonError extends Error {
	constructor(message = "") {
		super(message);
		this.name = new.target.name;
	}
}

export class ValueError extends PythonError {}
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

/** email.errors.MessageError and its subclasses: none of the above, so callers above never catch them. */
export class MessageError extends PythonError {}
export class HeaderParseError extends MessageError {}
export class CharsetError extends MessageError {}
/** binascii.Error, a ValueError. */
export class BinasciiError extends ValueError {}

/** A defect the header parser records (email.errors' MessageDefect classes, by name). */
export type DefectKind =
	| "InvalidHeaderDefect"
	| "ObsoleteHeaderDefect"
	| "NonPrintableDefect"
	| "UndecodableBytesDefect"
	| "NonASCIILocalPartDefect"
	| "InvalidBase64PaddingDefect"
	| "InvalidBase64CharactersDefect"
	| "InvalidBase64LengthDefect"
	| "CharsetError";

export class Defect {
	readonly kind: DefectKind;
	readonly message: string;

	constructor(kind: DefectKind, message = "") {
		this.kind = kind;
		this.message = message;
	}
}
