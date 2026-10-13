// Text in a named charset, as the Encoding Standard reads the name: the runtime's TextDecoder, which is what
// browsers and mail readers use. A body part's Content-Type charset (gmail/mime.ts) and a web page's charset
// (connectors/web/fetch.ts) are decoded here.
//
// Undecodable bytes are replaced by U+FFFD and a byte order mark is dropped. The standard maps the Latin-1
// labels, and so US-ASCII's, to windows-1252, and gives HZ, ISO-2022-KR and -CN, UTF-7 and UTF-32 no decoder
// (the constructor refuses them), so a text in one of those is read as UTF-8 by the callers. The label "utf-16"
// reads a byte order mark for the byte order (the standard's is always little-endian). Spellings the standard
// lacks but senders use, with "_" or "-" where it has the other or neither ("latin-1", "utf_8", "euc_jp"), are
// read as the standard's label.

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
const DECODERS = new Map<string, TextDecoder | null>();
const REMEMBERED = 64;

function construct(label: string): TextDecoder | null {
	try {
		return new TextDecoder(label);
	} catch {
		// A label the standard does not have, or one this runtime was built without.
		return null;
	}
}

/** The decoder for a label as the standard spells it, or with "_" for "-" or without either ("latin-1", "euc_jp"). */
function decoder(name: string): TextDecoder | null {
	const found = DECODERS.get(name);
	if (found !== undefined) return found;
	const made = construct(name) ?? construct(name.replaceAll("_", "-")) ?? construct(name.replace(/[-_.\s]/g, ""));
	if (DECODERS.size >= REMEMBERED) DECODERS.clear();
	DECODERS.set(name, made);
	return made;
}

/** Whether the runtime has a decoder for the label. */
export function charsetKnown(label: string): boolean {
	return decoder(normalized(label)) !== null;
}

/** "utf-16": a byte order mark chooses the order, little-endian without one. The decoder drops the mark. */
function utf16(bytes: Uint8Array): string {
	return bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-16le";
}

/** The bytes as text in the charset, undecodable sequences as U+FFFD, a byte order mark dropped; null for a label the standard lacks. */
export function decodeCharset(bytes: Uint8Array, label: string): string | null {
	let name = normalized(label);
	if (name === "utf-16" || name === "utf_16") name = utf16(bytes);
	return decoder(name)?.decode(bytes) ?? null;
}
