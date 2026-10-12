// Text in a named charset, as the Encoding Standard reads the name: the runtime's TextDecoder, which is what
// browsers and mail readers use. A body part's Content-Type charset (gmail/mime.ts), a web page's charset
// (connectors/web/fetch.ts) and an encoded word's charset (gmail/email/ew.ts) are decoded here.
//
// Two readings of the same bytes, for two jobs:
// - `decodeCharset` is for text that is shown: any label the standard has, undecodable bytes replaced by U+FFFD,
//   a byte order mark dropped. The standard maps the Latin-1 labels, and so US-ASCII's, to windows-1252, and gives
//   HZ, ISO-2022-KR and -CN, UTF-7 and UTF-32 no decoder (the constructor refuses them), so a text in one of
//   those is read as UTF-8. The label "utf-16" reads a byte order mark for the byte order, as Python's codec does
//   (the standard's is always little-endian).
// - `decodeCharsetStrictly` is for a header that decides who mail goes to (the display name in an address
//   header, gmail/mime.ts `mailboxes`). It succeeds only where every byte is decoded cleanly and has not been
//   read more kindly than Python's codec read it (the cases below), because a header with any defect is refused,
//   not guessed at. A byte order mark stays text, as it did.
//
// What it does not do: the standard's multi-byte decoders accept more pairs than Python's did (GBK's extra
// pairs under "gb2312" within EUC-CN's range, Windows-949's under "euc-kr", Big5-HKSCS's, the NEC and IBM rows of
// Shift_JIS and EUC-JP, and the pairs Python's GBK leaves unassigned, such as A1 40). Such a pair in a display
// name is no longer a defect. It cannot change who a message goes
// to: an encoded word inside an address is refused (gmail/mime.ts `mailboxes`), so a charset's text only ever
// names a person. The runtimes differ in these decoders as well (Node's ICU and workerd's): production is
// workerd, and test/fixtures/email-tests.ts runs in both.

/** Labels the Encoding Standard knows that Python's codec registry did not: a defect in an address header, as they were. */
const NOT_PYTHONS = new Set(
	[
		"unicode-1-1-utf-8 unicode11utf8 unicode20utf8 x-unicode20utf8 iso88591 iso88592 iso88593 iso88594 iso88595 csiso88596e csiso88596i",
		"iso-8859-6-e iso-8859-6-i iso88596 iso88597 sun_eu_greek csiso88598e iso88598 visual csiso88598i logical iso88599 iso885910",
		"iso885911 iso885913 iso885914 csisolatin9 iso885915 koi koi8 koi8-ru csmacintosh mac x-mac-roman dos-874 x-cp1250 x-cp1251 x-cp1252",
		"x-cp1253 x-cp1254 x-cp1255 x-cp1256 x-cp1257 x-cp1258 x-mac-cyrillic x-mac-ukrainian csgb2312 gb_2312 gb_2312-80 x-gbk cn-big5",
		"x-x-big5 cseucpkdfmtjapanese x-euc-jp x-sjis csksc56011987 iso-ir-149 ks_c_5601-1989 ksc_5601 windows-949",
		"unicodefffe csunicode iso-10646-ucs-2 ucs-2 unicode unicodefeff x-user-defined",
	]
		.join(" ")
		.split(" "),
);

/** The labels the standard maps to windows-1252 that mean 7-bit ASCII, which refuses what windows-1252 reads. */
const ASCII = new Set(["ascii", "us-ascii", "ansi_x3.4-1968"]);
/** GB 2312 as EUC-CN, which the standard reads as GBK, a superset. */
const GB2312 = new Set(["gb2312", "chinese", "csiso58gb231280", "iso-ir-58"]);
/** GBK and GB 18030, which the standard reads as one charset: Python's GBK has no four-byte sequences, and neither has a lone 0x80 (the standard's euro sign). */
const GBK = new Set(["gbk", "gb18030"]);
/** Single bytes Python's code page left undefined and the standard maps to a character that is not a C1 control (U+00A0, U+05BA). */
const UNDEFINED_BYTE = new Map([
	["tis-620", 0xa0],
	["cp1255", 0xca],
	["windows-1255", 0xca],
]);

const C1_CONTROL = /[\u0080-\u009f]/;

/** The longest label the standard has is 17 characters ("unicode-1-1-utf-8"); a longer one is not a label. */
const MAX_LABEL = 64;

function white(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/** The standard's way of matching a label: ASCII whitespace trimmed, ASCII letters lowercased. One that is too long is no label (""). */
function normalized(label: string): string {
	let start = 0;
	let end = label.length;
	while (start < end && white(label.charCodeAt(start))) start++;
	while (end > start && white(label.charCodeAt(end - 1))) end--;
	if (end - start > MAX_LABEL) return "";
	return label.slice(start, end).replace(/[A-Z]/g, (char) => char.toLowerCase());
}

// A message chooses its labels, and a constructor that throws costs several times a decode, so each answer is
// remembered, up to a bound.
const LENIENT = new Map<string, TextDecoder | null>();
const FATAL = new Map<string, TextDecoder | null>();
const REMEMBERED = 64;

// The shown text drops a byte order mark, as readers do. A strict decoder keeps it as text (U+FEFF), as Python's
// codecs did: one at the start of an address would otherwise vanish and leave a valid address.
function construct(label: string, fatal: boolean): TextDecoder | null {
	try {
		return new TextDecoder(label, { fatal, ignoreBOM: fatal });
	} catch {
		// A label the standard does not have, or one this runtime was built without.
		return null;
	}
}

/** The decoder for a label as the standard spells it; for the shown text, also as Python spelled it ("latin-1", "iso_8859_1", "euc_jp"). */
function decoder(name: string, fatal: boolean, pythonSpelling: boolean): TextDecoder | null {
	const cache = fatal ? FATAL : LENIENT;
	const key = pythonSpelling ? `~${name}` : name;
	const found = cache.get(key);
	if (found !== undefined) return found;
	let made = construct(name, fatal);
	if (made === null && pythonSpelling) made = construct(name.replaceAll("_", "-"), fatal) ?? construct(name.replace(/[-_.\s]/g, ""), fatal);
	if (cache.size >= REMEMBERED) cache.clear();
	cache.set(key, made);
	return made;
}

/** Whether the runtime has a decoder for the label. */
export function charsetKnown(label: string): boolean {
	return decoder(normalized(label), false, true) !== null;
}

/**
 * Python's "utf-16": a byte order mark chooses the order, little-endian without one (the standard's label is
 * little-endian always). The mark itself is dropped by the shown text's decoder, so `strip` is for the strict one.
 */
function utf16(bytes: Uint8Array, strip: boolean): { name: string; bytes: Uint8Array } {
	const first = bytes[0];
	const second = bytes[1];
	if (first === 0xfe && second === 0xff) return { name: "utf-16be", bytes: strip ? bytes.subarray(2) : bytes };
	if (first === 0xff && second === 0xfe) return { name: "utf-16le", bytes: strip ? bytes.subarray(2) : bytes };
	return { name: "utf-16le", bytes };
}

/** The bytes as text in the charset, undecodable sequences as U+FFFD, a byte order mark dropped; null for a label the standard lacks. */
export function decodeCharset(bytes: Uint8Array, label: string): string | null {
	let name = normalized(label);
	if (name === "utf-16" || name === "utf_16") ({ name, bytes } = utf16(bytes, false));
	const lenient = decoder(name, false, true);
	return lenient === null ? null : lenient.decode(bytes);
}

/** EUC-CN's byte pairs: a lead byte of A1 to F7 and a trail byte of A1 to FE, beside ASCII. GBK, which decodes them, has more. */
function euccn(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length; i++) {
		const lead = bytes[i] as number;
		if (lead < 0x80) continue;
		const trail = bytes[++i];
		if (lead < 0xa1 || lead > 0xf7 || trail === undefined || trail < 0xa1 || trail > 0xfe) return false;
	}
	return true;
}

/** GBK as Python has it: no lone 0x80 or 0xFF, and four-byte sequences (a trail byte of 0x30 to 0x39) only for GB 18030. */
function gbk(bytes: Uint8Array, fourBytes: boolean): boolean {
	for (let i = 0; i < bytes.length; i++) {
		const lead = bytes[i] as number;
		if (lead < 0x80) continue;
		const trail = bytes[++i];
		if (lead === 0x80 || lead === 0xff || trail === undefined) return false;
		if (trail >= 0x30 && trail <= 0x39) {
			if (!fourBytes) return false;
			i += 2;
		}
	}
	return true;
}

/**
 * The bytes as text, or null when they are not cleanly the charset's: a label that Python's codec registry did
 * not have, a label the standard lacks, a byte sequence the decoder refuses, a byte beyond 7 bits under an ASCII
 * label, a byte pair beyond GB 2312 under its labels, a sequence beyond Python's GBK, a byte Python's code page
 * left undefined, or a C1 control character (U+0080 to U+009F), which is what the standard reads the bytes
 * other code pages leave undefined as. Empty bytes are text whatever the label.
 */
export function decodeCharsetStrictly(bytes: Uint8Array, label: string): string | null {
	if (bytes.length === 0) return "";
	let name = normalized(label);
	if (NOT_PYTHONS.has(name)) return null;
	if (name === "utf-16") ({ name, bytes } = utf16(bytes, true));
	if (ASCII.has(name) && bytes.some((byte) => byte >= 0x80)) return null;
	if (GB2312.has(name) && !euccn(bytes)) return null;
	if (GBK.has(name) && !gbk(bytes, name === "gb18030")) return null;
	const undefinedByte = UNDEFINED_BYTE.get(name);
	if (undefinedByte !== undefined && bytes.includes(undefinedByte)) return null;
	const strict = decoder(name, true, false);
	if (strict === null) return null;
	let text: string;
	try {
		text = strict.decode(bytes);
	} catch {
		return null;
	}
	return C1_CONTROL.test(text) ? null : text;
}
