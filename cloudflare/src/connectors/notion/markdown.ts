// Page text as agents see it and write it, ported from backend/connectors/notion/markdown.py.
//
// Notion's page markdown names other pages: child pages and databases with their titles, mentions with the
// mentioned page's title, links whose address carries the page's title, and synced blocks with content that
// lives on another page. The agent may not be allowed to read those, so their titles and synced content are
// hidden when a page is read, and Notion links are shortened to the page's id. Hiding fails closed: synced
// content is hidden up to the last closing tag, and a title tag left open hides the rest of the page.
//
// Edits are made so their outcome depends only on the text the agent was shown: an edit is widened to whole
// lines that hold nothing hidden, until it matches exactly once. Such text can only match where the agent
// could see it too, so a refused or applied edit tells nothing about what was hidden. Pages that show synced
// content from elsewhere are not edited at all.
//
// Text the agent writes may not create child pages or databases (an existing one named there might be moved
// into this page), copy synced content, mention people (which notifies them), or embed anything that Notion
// or a reader's browser would load from another site. An edit may not produce such content by joining its
// text with the page's either, nor turn text the page shows as code into markup: the edited lines must hold
// none of it afterwards, the page as a whole may gain none, and the edit may not change code fences or the
// parity of backticks.
//
// The patterns are Python's, with its `\s`, `\w`, `\b` and IGNORECASE spelled out (patterns.ts). Positions
// are UTF-16 offsets here and code points in Python; they are only used within the same text, so the
// outcome is the same.

import { OperationError } from "../../gateway/connector.ts";
import { PYTHON_SPACE_CLASS, WORD_CLASS, pythonRstrip, pythonStrip } from "../../lib/text.ts";
import {
	ALNUM_DASH_CASELESS,
	HEX_CASELESS,
	LINE_START,
	WORD_END,
	WORD_START,
	countOf,
	ignoreCase,
	rfindBefore,
} from "./patterns.ts";

/** Tags whose content is another object's title. */
export const TITLED = ["page", "database", "mention-page", "mention-database", "mention-data-source", "mention-agent"] as const;
const TITLED_OPEN = new RegExp(`<(${TITLED.map(ignoreCase).join("|")})(?=[${PYTHON_SPACE_CLASS}/>])([^<>]*)>`, "gu");
const URL_ATTRIBUTE = new RegExp(`${WORD_START}url="([^"<>]*)"`, "u");
export const SYNCED_OPEN = "<synced_block_reference";
export const SYNCED_CLOSE = "</synced_block_reference>";
export const SYNCED_HIDDEN = "(Synced content from another page. Minerva does not show it.)";
/** Anything on a line that makes an edit there depend on hidden text. */
const HIDDEN_MARK = new RegExp(`</?(?:${[...TITLED, "synced_block_reference"].map(ignoreCase).join("|")})${WORD_END}`, "gu");

/** Tags agents may not write. */
export const DENIED_TAGS: ReadonlySet<string> = new Set([
	"page",
	"database",
	"synced_block",
	"synced_block_reference",
	"mention-user",
	"mention-agent",
	"mention-data-source",
	"img",
	"image",
	"video",
	"audio",
	"file",
	"pdf",
	"embed",
	"bookmark",
	"iframe",
	"link-preview",
	"link_preview",
	"object",
	"source",
	"form",
	"meeting-notes",
	"meeting_notes",
]);
const TAG = new RegExp(`<[${PYTHON_SPACE_CLASS}]*/?[${PYTHON_SPACE_CLASS}]*([A-Za-z][${WORD_CLASS}:-]*)([^<>]*)>`, "gu");
const LINK_ATTRIBUTE = new RegExp(`${WORD_START}(?:${["src", "url", "href", "data", "srcset", "poster", "action"].map(ignoreCase).join("|")})[${PYTHON_SPACE_CLASS}]*=`, "u");
const NOTION_MENTION = new RegExp(
	`^(?:[${PYTHON_SPACE_CLASS}]+url="https://(?:www\\.)?notion\\.so/[^"${PYTHON_SPACE_CLASS}<>]*"[${PYTHON_SPACE_CLASS}]*/?[${PYTHON_SPACE_CLASS}]*` +
		`|[${PYTHON_SPACE_CLASS}]+url="https://[a-z0-9-]+\\.notion\\.site/[^"${PYTHON_SPACE_CLASS}<>]*"[${PYTHON_SPACE_CLASS}]*/?[${PYTHON_SPACE_CLASS}]*)$`,
	"u",
);
export const MENTIONS: ReadonlySet<string> = new Set(["mention-page", "mention-database"]);
export const MAX_WIDENING = 20;
/** A Notion page address; the part before the id is the page's title. */
const NOTION_URL = new RegExp(
	`${ignoreCase("https://")}(?:(?:${ignoreCase("www.")})?${ignoreCase("notion.so")}|[${ALNUM_DASH_CASELESS}]+${ignoreCase(".notion.site")})` +
		`/[^${PYTHON_SPACE_CLASS}"'<>()\\[\\]]*?([${HEX_CASELESS}]{32})(?![${HEX_CASELESS}])[^${PYTHON_SPACE_CLASS}"'<>()\\[\\]]*`,
	"gu",
);
const FENCE = new RegExp(`${LINE_START}[ \\t]*(\`{3,}|~{3,})`, "gu");

/**
 * Hides everything from the first synced reference to the last closing tag: synced content may itself
 * contain the closing tag as text, so no earlier one can be trusted to end it.
 */
function redactSynced(markdown: string): string {
	const start = markdown.indexOf(SYNCED_OPEN);
	if (start === -1) return markdown;
	const end = markdown.lastIndexOf(SYNCED_CLOSE);
	const hidden = `${SYNCED_OPEN}>${SYNCED_HIDDEN}${SYNCED_CLOSE}`;
	if (end < start) return markdown.slice(0, start) + hidden;
	return markdown.slice(0, start) + hidden + markdown.slice(end + SYNCED_CLOSE.length);
}

/** The first match of a global pattern at or after `from`. */
function search(pattern: RegExp, text: string, from: number): RegExpExecArray | null {
	pattern.lastIndex = from;
	return pattern.exec(text);
}

/**
 * Empties tags that hold another object's title, keeping only their address. A tag left open hides the
 * rest of the page.
 */
function redactTitled(markdown: string): string {
	const parts: string[] = [];
	let position = 0;
	for (let match = search(TITLED_OPEN, markdown, position); match !== null; match = search(TITLED_OPEN, markdown, position)) {
		const name = (match[1] as string).toLowerCase();
		const attributes = match[2] as string;
		const url = URL_ATTRIBUTE.exec(attributes);
		const tag = url ? `<${name} url="${url[1]}"` : `<${name}`;
		const end = match.index + match[0].length;
		parts.push(markdown.slice(position, match.index));
		if (pythonRstrip(attributes).endsWith("/")) {
			parts.push(`${tag}/>`);
			position = end;
			continue;
		}
		parts.push(`${tag}></${name}>`);
		const close = search(new RegExp(`</${ignoreCase(name)}[${PYTHON_SPACE_CLASS}]*>`, "gu"), markdown, end);
		if (close === null) return parts.join("");
		position = close.index + close[0].length;
	}
	parts.push(markdown.slice(position));
	return parts.join("");
}

/** The page text an agent is shown. */
export function redact(markdown: string): string {
	const text = redactTitled(redactSynced(markdown));
	return text.replace(NOTION_URL, (_, id: string) => `https://www.notion.so/${id.toLowerCase()}`);
}

export function showsSyncedContent(markdown: string): boolean {
	return markdown.includes(SYNCED_OPEN);
}

/** What in the text would do more than add words to a page: (the text itself, why it is refused). */
function refusals(text: string): [text: string, reason: string][] {
	const found: [string, string][] = Array.from({ length: countOf(text, "![") }, (): [string, string] => ["![", "must not contain images"]);
	for (const match of text.matchAll(TAG)) {
		const name = (match[1] as string).toLowerCase();
		const attributes = match[2] as string;
		if (DENIED_TAGS.has(name)) found.push([match[0], `must not contain <${name}> tags`]);
		else if (MENTIONS.has(name)) {
			if (pythonStrip(attributes) && !NOTION_MENTION.test(attributes)) found.push([match[0], `<${name}> must link to a notion.so page`]);
		} else if (LINK_ATTRIBUTE.test(attributes)) found.push([match[0], "must not contain tags that link to other sites; use [text](url) links"]);
	}
	return found;
}

/** Why the text would do more than add words to a page, or null. A field check (`check_written`). */
export function writtenRefusal(text: string): string | null {
	const refused = refusals(text);
	return refused.length ? (refused[0] as [string, string])[1] : null;
}

function notApplied(message: string): OperationError {
	return new OperationError("EDIT_NOT_APPLIED", message);
}

function once(text: string, part: string): boolean {
	const first = text.indexOf(part);
	return first !== -1 && text.indexOf(part, first + 1) === -1;
}

function hiddenWithin(visible: string, start: number, end: number): boolean {
	// Python's `search(text, pos, endpos)`: nothing after `endpos` is seen.
	return search(HIDDEN_MARK, visible.slice(0, end), start) !== null;
}

export interface ContentUpdate {
	old_str: string;
	new_str: string;
}

function update(markdown: string, old: string, replacement: string): ContentUpdate {
	const visible = redact(markdown);
	if (!once(visible, old)) throw notApplied("The text to replace must appear exactly once in the page, as read_page shows it.");
	const start = visible.indexOf(old);
	const end = start + old.length;
	let lineStart = rfindBefore(visible, "\n", start) + 1;
	const after = visible.indexOf("\n", end);
	let lineEnd = after === -1 ? visible.length : after;
	for (let round = 0; round < MAX_WIDENING; round++) {
		if (hiddenWithin(visible, lineStart, lineEnd)) {
			throw notApplied(
				"Minerva does not edit lines that link to child pages, databases or mentioned pages, or next to synced content. Choose text on other lines.",
			);
		}
		const lead = lineStart > 0 ? 1 : 0;
		const trail = lineEnd < visible.length ? 1 : 0;
		const anchored = visible.slice(lineStart - lead, lineEnd + trail);
		if (once(visible, anchored)) {
			const replaced = visible.slice(lineStart - lead, start) + replacement + visible.slice(end, lineEnd + trail);
			// Whole lines without hidden text read the same in the page itself, unless they hold Notion links,
			// which are shown shortened.
			if (!once(markdown, anchored)) {
				throw notApplied("Minerva cannot edit these lines: they link to Notion pages, or the page changed. Read the page again, or choose text on other lines.");
			}
			checkEdit(anchored, replaced);
			return { old_str: anchored, new_str: replaced };
		}
		if (lineStart === 0 && lineEnd === visible.length) break;
		if (lineStart > 0) lineStart = rfindBefore(visible, "\n", lineStart - 1) + 1;
		if (lineEnd < visible.length) {
			const following = visible.indexOf("\n", lineEnd + 1);
			lineEnd = following === -1 ? visible.length : following;
		}
	}
	throw notApplied("The lines around this text repeat in the page. Include more of the text to replace.");
}

function fences(text: string): string[] {
	return Array.from(text.matchAll(FENCE), (match) => match[1] as string);
}

function checkEdit(old: string, replacement: string): void {
	if (refusals(replacement).length) {
		throw notApplied(
			"Minerva does not edit lines that hold images, embeds or other content it does not write, nor make such content from the page's text. Choose text on other lines.",
		);
	}
	const [before, after] = [fences(old), fences(replacement)];
	if (before.length !== after.length || before.some((fence, index) => fence !== after[index]) || countOf(old, "`") % 2 !== countOf(replacement, "`") % 2) {
		throw notApplied(
			"Minerva does not add or remove code fences or single backticks in an edit, since that changes how the rest of the page reads. Keep backticks paired.",
		);
	}
}

function counted(markdown: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const [text] of refusals(markdown)) counts.set(text, (counts.get(text) ?? 0) + 1);
	return counts;
}

/** Notion content updates for the agent's edits, applied in order. */
export function planEdits(markdown: string, edits: readonly (readonly [old: string, replacement: string])[]): ContentUpdate[] {
	const before = counted(markdown);
	const updates: ContentUpdate[] = [];
	let text = markdown;
	for (const [old, replacement] of edits) {
		const planned = update(text, old, replacement);
		// `str.replace(old, new, 1)`, without JavaScript's `$` patterns in the replacement.
		const at = text.indexOf(planned.old_str);
		text = text.slice(0, at) + planned.new_str + text.slice(at + planned.old_str.length);
		updates.push(planned);
	}
	for (const [refused, count] of counted(text)) {
		if (count > (before.get(refused) ?? 0)) throw notApplied("These edits would join text into an image, embed or other content Minerva does not write.");
	}
	return updates;
}
