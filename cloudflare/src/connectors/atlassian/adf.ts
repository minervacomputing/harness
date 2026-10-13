// Atlassian Document Format (ADF) as agents read it and write it.
//
// Jira and Confluence store rich text as ADF, a JSON tree. Read text is that tree as plain text, without
// what could show an object the agent may not read:
// - a smart link (`inlineCard`, `blockCard`, `embedCard`) or a link to Atlassian shows as "[Atlassian
//   link]": Atlassian renders such links with the linked issue's or page's title, and fills a pasted link's
//   label with it too, so the label is left out as well. A link counts as one to Atlassian when its
//   address, in any encoding, names an Atlassian domain or one of the connection's sites, or is relative;
// - an address to Atlassian in the text itself shows the same way;
// - macros (`extension` nodes) and any node Minerva does not know show as "[unsupported content]", without
//   what they hold.
// Mentions of people keep the name ADF stores with them. Images and files show as "[attachment]". The tree
// is read to a bounded depth and size; what lies beyond is left out and marked.
//
// Written text is plain: it becomes paragraphs of text, without marks, mentions or cards, so it cannot
// notify anyone or format anything. It may not contain an address to Atlassian in any encoding, since
// Atlassian may show it as a smart link previewing something the agent may not read.
//
// A node whose `type` is a list or an object raises a TypeError, which the model sees as the generic
// failure.

import type { Json } from "../../lib/json.ts";
import { decoded, isPlainText, PLAIN_TEXT, TextError, WORDS } from "../../lib/text.ts";
import { OperationError } from "../../gateway/connector.ts";
import { IGNORECASE_I } from "./python.ts";

export const LINK = "[Atlassian link]";
export const UNSUPPORTED = "[unsupported content]";
export const MAX_DEPTH = 40;
export const MAX_NODES = 20_000;

// `re.IGNORECASE`, where "i" also matches "İ" and "ı" (python.ts).
const ATLASSIAN = new RegExp(
	String.raw`atlassian\.(?:net|com)|jira\.com|atlassian\.design|atl\.so|trello\.com|bitbucket\.org`.replaceAll("i", IGNORECASE_I),
	"iu",
);
const SCHEME = /^[a-z\u0130\u0131][a-z0-9+.\-\u0130\u0131]*:/iu;

export const ATLASSIAN_ADDRESS =
	"must not contain Atlassian addresses: Atlassian may show them as previews of issues or pages you may not read";
export const SITE_ADDRESS = "Text must not contain addresses of Atlassian sites: Atlassian may show them as previews.";

const BLOCKS: ReadonlySet<string> = new Set([
	"paragraph",
	"heading",
	"blockquote",
	"bulletList",
	"orderedList",
	"codeBlock",
	"panel",
	"table",
	"tableRow",
	"expand",
	"nestedExpand",
	"layoutSection",
	"layoutColumn",
	"taskList",
	"decisionList",
	"mediaSingle",
	"mediaGroup",
]);
const CONTAINERS: ReadonlySet<string> = new Set(["doc", "tableCell", "tableHeader", ...BLOCKS]);
const CARDS: ReadonlySet<string> = new Set(["inlineCard", "blockCard", "embedCard"]);
const MEDIA: ReadonlySet<string> = new Set(["media", "mediaInline"]);
const MARKERS: readonly string[] = ["- ", "- [x] ", "- [ ] "];

type Node = { [key: string]: Json };

function isDict(value: unknown): value is Node {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(node: Node, key: string): Json | undefined {
	return Object.hasOwn(node, key) ? node[key] : undefined;
}

/** The text with what a browser drops or decodes in an address removed (browsers drop tabs and newlines). */
function flattened(text: string): string {
	return decoded(text).replace(/[\t\n\r]/g, "");
}

function namesHost(flat: string, hosts: readonly string[]): boolean {
	const lower = flat.toLowerCase();
	return hosts.some((host) => host !== "" && lower.includes(host));
}

/**
 * Whether an address leads to Atlassian: an Atlassian domain or one of `hosts`, in any encoding, or a
 * relative address, which resolves on the site showing it.
 */
export function internal(address: string, hosts: readonly string[] = []): boolean {
	const flat = flattened(address).trim();
	if (ATLASSIAN.test(flat) || namesHost(flat, hosts)) return true;
	return !SCHEME.test(flat) || flat.startsWith("//");
}

/** Plain text with every word that addresses Atlassian replaced. */
export function redact(text: string, hosts: readonly string[] = []): string {
	return text.replace(WORDS, (word) => {
		const flat = flattened(word);
		return ATLASSIAN.test(flat) || namesHost(flat, hosts) ? LINK : word;
	});
}

/** The earliest and latest instants shown, in milliseconds: years 1 to 9999. */
const MIN_MS = -62_135_596_800_000;
const MAX_MS = 253_402_300_799_999;

/** A date node's day from its timestamp in milliseconds (an integer, or one written as digits), or "[date]". */
export function date(timestamp: Json | undefined): string {
	const text = typeof timestamp === "string" ? timestamp.trim() : null;
	const ms = typeof timestamp === "number" ? Math.trunc(timestamp) : text !== null && /^[+-]?\d{1,16}$/.test(text) ? Number(text) : null;
	if (ms === null || !(ms >= MIN_MS && ms <= MAX_MS)) return "[date]";
	return new Date(ms).toISOString().slice(0, 10);
}

class Reader {
	readonly hosts: readonly string[];
	readonly out: string[] = [];
	nodes = 0;
	cut = false;

	constructor(hosts: readonly string[]) {
		this.hosts = hosts;
	}

	newline(): void {
		// A list item's first paragraph stays on the line of its marker.
		const last = this.out[this.out.length - 1];
		if (last !== undefined && !last.endsWith("\n") && !MARKERS.includes(last)) this.out.push("\n");
	}

	attrs(node: Node): Node {
		const attrs = get(node, "attrs");
		return isDict(attrs) ? attrs : {};
	}

	text(value: Json | undefined): string {
		return typeof value === "string" ? value : "";
	}

	/** The address of a text node's link mark; "" for a link without a usable address. */
	link(node: Node): string | null {
		const marks = get(node, "marks");
		if (!Array.isArray(marks)) return null;
		const hrefs = marks.filter((mark) => isDict(mark) && get(mark, "type") === "link") as Node[];
		if (hrefs.length === 0) return null;
		if (hrefs.length > 1) return "";
		return this.text(get(this.attrs(hrefs[0] as Node), "href"));
	}

	children(node: Node, depth: number): void {
		const content = get(node, "content");
		if (!Array.isArray(content)) return;
		// Consecutive text with the same link is one link.
		let label: string[] = [];
		let href: string | null = null;
		for (const child of content) {
			if (this.cut) break;
			const current = isDict(child) && get(child, "type") === "text" ? this.link(child) : null;
			if (href !== null && current !== href) {
				this.flush(href, label);
				label = [];
				href = null;
			}
			if (current !== null) {
				// Within the same limits as any other node.
				this.nodes += 1;
				if (this.nodes > MAX_NODES || depth + 1 > MAX_DEPTH) {
					this.cut = true;
					break;
				}
				href = current;
				label.push(this.text(get(child as Node, "text")));
				continue;
			}
			this.node(child, depth + 1);
		}
		if (href !== null) this.flush(href, label);
	}

	flush(href: string, label: string[]): void {
		const text = label.join("").trim();
		if (!href || internal(href, this.hosts)) this.out.push(LINK);
		else if (text && text !== href) this.out.push(`${text} (${href})`);
		else this.out.push(href);
	}

	node(node: Json, depth: number): void {
		if (this.cut) return;
		this.nodes += 1;
		if (this.nodes > MAX_NODES || depth > MAX_DEPTH) {
			this.cut = true;
			return;
		}
		if (!isDict(node)) return;
		const kind = get(node, "type");
		const attrs = this.attrs(node);
		if (kind === "text") this.out.push(this.text(get(node, "text")));
		else if (kind === "hardBreak") this.out.push("\n");
		else if (kind === "rule") {
			this.newline();
			this.out.push("---\n");
		} else if (kind === "mention") {
			const name = this.text(get(attrs, "text")).replace(/^@+/, "");
			this.out.push(name ? `@${name}` : "@[someone]");
		} else if (kind === "emoji") this.out.push(this.text(get(attrs, "text")) || this.text(get(attrs, "shortName")));
		else if (kind === "date") this.out.push(date(get(attrs, "timestamp")));
		else if (kind === "status") this.out.push(`[${this.text(get(attrs, "text"))}]`);
		else if (typeof kind === "object" && kind !== null) {
			// `kind in _CARDS` hashes it.
			throw new TypeError("unhashable type");
		} else if (typeof kind === "string" && CARDS.has(kind)) {
			const url = this.text(get(attrs, "url"));
			this.out.push(!url || internal(url, this.hosts) ? LINK : url);
		} else if (typeof kind === "string" && MEDIA.has(kind)) this.out.push("[attachment]");
		else if (kind === "placeholder") {
			// Nothing to show.
		} else if (kind === "listItem") {
			this.newline();
			this.out.push("- ");
			this.children(node, depth);
			this.newline();
		} else if (kind === "taskItem" || kind === "decisionItem") {
			this.newline();
			this.out.push(get(attrs, "state") === "DONE" && kind === "taskItem" ? "- [x] " : "- [ ] ");
			this.children(node, depth);
			this.newline();
		} else if (kind === "tableCell" || kind === "tableHeader") {
			this.children(node, depth);
			this.out.push("\t");
		} else if (kind === "expand" || kind === "nestedExpand") {
			this.newline();
			const title = this.text(get(attrs, "title"));
			if (title) this.out.push(`${title}\n`);
			this.children(node, depth);
			this.newline();
		} else if (typeof kind === "string" && CONTAINERS.has(kind)) {
			const block = BLOCKS.has(kind);
			if (block) this.newline();
			this.children(node, depth);
			if (block) this.newline();
		} else {
			// Macros and nodes Minerva does not know.
			this.out.push(UNSUPPORTED);
		}
	}

	result(): string {
		const lines = this.out.join("").replaceAll("\u00a0", " ").split("\n");
		let joined = lines.map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
		if (this.cut) joined = joined ? `${joined}\n[more content not shown]` : "[more content not shown]";
		return redact(joined, this.hosts);
	}
}

/** The text an agent is shown. `hosts` are the connection's sites, whose addresses count as Atlassian's. */
export function read(document: Json | undefined, hosts: readonly string[] = []): string {
	if (!isDict(document)) return "";
	const reader = new Reader(hosts.map((host) => host.toLowerCase()));
	reader.node(document, 0);
	return reader.result();
}

/**
 * Refuses written text naming one of the connection's sites, in any encoding (sites on their own domains
 * are not covered by `checkWritten`).
 */
export function checkHosts(text: string, hosts: readonly string[]): void {
	const flat = flattened(text).toLowerCase();
	if (hosts.some((host) => host !== "" && flat.includes(host.toLowerCase()))) throw new OperationError("INVALID_ARGUMENTS", SITE_ADDRESS);
}

/** Whether written text names no Atlassian address (`check_written` after `plain_text`). */
export function namesNoAtlassian(text: string): boolean {
	return !ATLASSIAN.test(flattened(text));
}

/**
 * `check_written`: refuses text that would do more than add words, with the field validator's message
 * (TextError). Inputs declare it as two refinements, `isPlainText` then `namesNoAtlassian`.
 */
export function checkWritten(text: string): string {
	if (!isPlainText(text)) throw new TextError(PLAIN_TEXT);
	if (!namesNoAtlassian(text)) throw new TextError(ATLASSIAN_ADDRESS);
	return text;
}

/** An ADF document showing `text` literally: paragraphs at blank lines, line breaks within them. */
export function written(text: string): { [key: string]: Json } {
	const paragraphs: Json[] = [];
	for (const block of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split(/\n[ \t]*\n/)) {
		const content: Json[] = [];
		for (const line of block.split("\n")) {
			if (content.length) content.push({ type: "hardBreak" });
			if (line) content.push({ type: "text", text: line });
		}
		if (content.length) paragraphs.push({ type: "paragraph", content });
	}
	return { type: "doc", version: 1, content: paragraphs };
}
