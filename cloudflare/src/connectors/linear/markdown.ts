// Issue and comment text as agents see it and write it (backend/connectors/linear/markdown.py).
//
// Linear writes links to its own objects as plain linear.app addresses, and those carry titles: an issue's
// address ends in its title, a project's or document's in its name. Such a link in an issue the agent may
// read can name an issue in a team it may not read. Read text therefore shortens every linear.app address
// to what identifies the object, and drops the label of a markdown link to one, which Linear fills with the
// linked object's title.
//
// Linear turns linear.app addresses in written text into mentions: mentioning a person notifies them, and
// mentioning an issue adds a note to that issue's history. Text agents write may therefore link only to
// issues, and `issueLinks` names them so the connector can check each is in the team being written to.
// Text may not show images from anywhere but Linear's own uploads, since a reader's browser would load them
// from another site, nor use HTML that loads or links anything.
//
// The expressions are Python's, with `re`'s semantics written out (python.ts): `\s` and `\w` are Unicode
// classes of their own, `\d` is any decimal digit, `.` is anything but a newline, IGNORECASE also matches
// U+0130 and U+0131 to `i`, and every expression has the `u` flag so that a class matches a code point.

import { decoded, isPlainText, PLAIN_TEXT, PYTHON_SPACE_CLASS, WORD_CLASS } from "../../lib/text.ts";
import { DIGIT_CLASS } from "../../lib/digits.ts";
import { compareCodePoints } from "../../lib/order.ts";
import { RE_I, RE_LETTERS_EXTRA } from "./python.ts";

export const MAX_ISSUE_LINKS = 10;

const S = PYTHON_SPACE_CLASS;
const LINEAR = String.raw`l${RE_I}near\.app`;
const SEGMENT = String.raw`[A-Za-z0-9_${RE_LETTERS_EXTRA}-]+`;

const ANY_LINEAR = new RegExp(LINEAR, "giu");
/** An address of an object in Linear; group 3 is the rest of its path. */
const LINEAR_URL = new RegExp(
	String.raw`(?<![${WORD_CLASS}.@-])(?:https?://)?${LINEAR}/(${SEGMENT})(?:/(${SEGMENT}))?((?:/[^${S}()<>\[\]"'\x60]*)?)`,
	"giu",
);
/** Punctuation that ends a sentence after an address rather than belonging to it. */
const TRAILING = /[.,;:!?]+$/u;
/**
 * A markdown link or image to linear.app; group 1 is the address. Labels may hold escapes and one level of
 * brackets, as Linear writes them for titles with brackets.
 */
const LABELLED_LINK = new RegExp(
	String.raw`!?\[(?:\\[^\n]|[^\]\[\\\n]|\[(?:\\[^\n]|[^\]\[\\\n])*\])*\]` +
		String.raw`\([${S}]*<?((?:https?://)?${LINEAR}/[^${S}()<>]*)>?` +
		String.raw`(?:[${S}]+(?:"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'|\((?:\\[^\n]|[^()\\\n])*\)))?[${S}]*\)`,
	"giu",
);
const OWN_ID = /-([0-9a-fA-F]{8,})$/u;
export const IDENTIFIER = new RegExp(`^[A-Za-z0-9]{1,10}-${DIGIT_CLASS}{1,9}$`, "u");

/** An issue address as agents may write it: workspace, identifier and optionally the title part. */
const ISSUE_LINK = new RegExp(
	String.raw`^https?://${LINEAR}/(${SEGMENT})/${RE_I}ssue/([A-Za-z0-9${RE_LETTERS_EXTRA}]{1,10}-${DIGIT_CLASS}{1,9})(?:/[A-Za-z0-9${RE_LETTERS_EXTRA}-]*)?$`,
	"iu",
);
/** `https?://$` searched between two positions: `$` is the window's end, or before a newline that ends it. */
const SCHEME = /https?:\/\/(?=\n?$)/iu;
/** All that any parser could take as part of an address: up to whitespace or an angle bracket. */
const RUN = new RegExp(String.raw`[^${S}<>]*`, "uy");
/** What may follow an address without being part of it: punctuation, closing brackets, emphasis, quotes. */
const AFTER = /[.,;:!?)\]*_~'"]+$/u;
const IMAGE = new RegExp(
	String.raw`!\[[^\]\n]*\]\([${S}]*<?https://uploads\.linear\.app/[^${S}()<>]+>?(?:[${S}]+"[^"\n]*")?[${S}]*\)`,
	"gu",
);
const TAG = new RegExp(String.raw`<[${S}]*/?[${S}]*([A-Za-z][${WORD_CLASS}:-]*)([^<>]*)>`, "gu");
/** `\b` before a word character is "not after one". */
const LINK_ATTRIBUTE = new RegExp(
	String.raw`(?<![${WORD_CLASS}])(?:src|url|href|data|srcset|poster|act${RE_I}on|background)[${S}]*=`,
	"iu",
);
const LOADING_TAGS: ReadonlySet<string> = new Set(["img", "image", "iframe", "embed", "object", "video", "audio", "source", "link"]);

/** `str.strip("/")`. */
function stripSlashes(text: string): string {
	return text.replace(/^\/+|\/+$/gu, "");
}

function short(_match: string, workspace: string, kind: string | undefined, path: string | undefined): string {
	let rest = path ?? "";
	const end = TRAILING.exec(rest);
	const trailing = end ? end[0] : "";
	rest = rest.slice(0, rest.length - trailing.length);
	if (kind === undefined) return `https://linear.app/${workspace}${trailing}`;
	const segment = stripSlashes(rest).split("/", 1)[0] ?? "";
	if (kind.toLowerCase() === "issue" && IDENTIFIER.test(segment)) return `https://linear.app/${workspace}/issue/${segment.toUpperCase()}${trailing}`;
	const own = OWN_ID.exec(segment);
	if (own) return `https://linear.app/${workspace}/${kind}/${(own[1] as string).toLowerCase()}${trailing}`;
	return `https://linear.app/${workspace}/${kind}${trailing}`;
}

/** The text an agent is shown. */
export function redact(text: string): string;
export function redact(text: string | null): string | null;
export function redact(text: string | null): string | null {
	if (text === null) return null;
	const unlabelled = text.replace(LABELLED_LINK, (_match, address: string) => address.replace(LINEAR_URL, short));
	return unlabelled.replace(LINEAR_URL, short);
}

function count(pattern: RegExp, text: string): number {
	return text.match(pattern)?.length ?? 0;
}

export const ENCODED = "must not write Linear addresses in an encoded form";
export const IMAGES = "may show only images uploaded to Linear (https://uploads.linear.app/...)";
export const HTML = "must not contain HTML that loads or links anything; use [text](url) links";
export const TOO_MANY_LINKS = `may link to at most ${MAX_ISSUE_LINKS} Linear issues`;
export const NOT_AN_ISSUE_LINK =
	"may link to Linear only with issue addresses (https://linear.app/<workspace>/issue/<ID>), each followed by a space or the end of the link; Linear turns other Linear links into mentions";

/** What text an agent writes may not do, or null: `check_written`'s ValueError. A field validator. */
export function writtenProblem(text: string): string | null {
	if (!isPlainText(text)) return PLAIN_TEXT;
	const rest = text.replace(IMAGE, "");
	if (count(ANY_LINEAR, decoded(rest)) > count(ANY_LINEAR, rest)) return ENCODED;
	if (rest.includes("![")) return IMAGES;
	for (const tag of rest.matchAll(TAG)) {
		if (LOADING_TAGS.has((tag[1] as string).toLowerCase()) || LINK_ATTRIBUTE.test(tag[2] as string)) return HTML;
	}
	const links = linksOf(rest);
	if (typeof links === "string") return links;
	if (links.length > MAX_ISSUE_LINKS) return TOO_MANY_LINKS;
	return null;
}

/**
 * The (workspace, identifier) of each Linear address in the text, or the refusal if any is not exactly an
 * issue address. The whole run an address could extend over must be one, so that no path, query or
 * fragment after it (`/../OPS-1`) can lead a browser or Linear elsewhere.
 */
function linksOf(text: string): [string, string][] | string {
	const links: [string, string][] = [];
	for (const found of text.matchAll(ANY_LINEAR)) {
		const start = found.index;
		const window = text.slice(Math.max(0, start - 8), start);
		const scheme = SCHEME.exec(window);
		RUN.lastIndex = start;
		const run = RUN.exec(text);
		const from = scheme ? Math.max(0, start - 8) + scheme.index : start;
		const to = run ? run.index + run[0].length : start + found[0].length;
		const address = text.slice(from, to).replace(AFTER, "");
		const link = scheme ? ISSUE_LINK.exec(address.replace(/\/+$/u, "")) : null;
		if (link === null) return NOT_AN_ISSUE_LINK;
		links.push([(link[1] as string).toLowerCase(), (link[2] as string).toUpperCase()]);
	}
	return links;
}

/** The (workspace, identifier) of every Linear issue the text links to, once each, sorted. */
export function issueLinks(text: string): [string, string][] {
	const links = linksOf(text.replace(IMAGE, ""));
	if (typeof links === "string") throw new TypeError(links);
	const unique = new Map(links.map((link) => [JSON.stringify(link), link]));
	return [...unique.values()].sort((a, b) => compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]));
}
