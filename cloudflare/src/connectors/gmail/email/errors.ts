// The Python exceptions the email package's port raises, with Python's hierarchy, since the code that calls
// it catches some and lets others through exactly as gmail/mime.py does: `except LookupError, UnicodeError`
// in `_decode`, `suppress(ValueError, LookupError, UnicodeError)` in `header_text`, `except ValueError,
// IndexError, TypeError` in `mailboxes`. An exception Python would not catch there (a HeaderParseError from
// decode_header, a CharsetError) escapes the connector as it does today, and the call fails with the
// executor's generic error.

export { IndexError, KeyError, LookupError, PyTypeError, PythonError, UnicodeDecodeError, UnicodeEncodeError, UnicodeError, ValueError, at } from "../../../lib/pyerrors.ts";
import { PythonError, ValueError } from "../../../lib/pyerrors.ts";

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
