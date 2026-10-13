// Message text as agents see it and write it.
//
// Slack writes links as control sequences, `<target|label>`. A link to a channel carries that channel's
// name as its label (`<#C123|secret-plans>`), and so can a link to a message in Slack. Read text therefore
// drops the label of every link to a channel or to Slack itself; the agent still sees the channel's id.
//
// Written text is sent as words only. `&`, `<` and `>` are escaped, so text cannot form a control sequence:
// no `<!channel>`, `<!here>` or `<!everyone>` that notifies a whole channel, no mention of a person or user
// group, and no link with a label that hides where it goes. Text may not link to Slack at all, in any
// encoding: Slack shows the content of a linked message, which could be in a channel the agent may not read,
// next to the post.
//
// The patterns are Python's with `re.IGNORECASE`, which for a str pattern also matches "ı" and "İ" to "i",
// "ſ" to "s" and the Kelvin sign to "k" (sre's case equivalences); the letters are spelled out as those
// classes, since JavaScript's `iu` folds "ſ" and "K" but not the two i's. Python's `$` also matches before a
// final newline. Link targets are read with the runtime's URL parser; one it cannot read counts as a link to
// Slack.

import { PLAIN_TEXT, decoded, isPlainText } from "../../lib/text.ts";

/** What Python's IGNORECASE matches for an ASCII letter of these patterns. */
const EQUIVALENT: { readonly [letter: string]: string } = { i: "iI\u0130\u0131", k: "kK\u212a", s: "sS\u017f" };

/** A word as a pattern that matches it the way Python's IGNORECASE does. */
function ignoringCase(word: string): string {
	return Array.from(word, (char) => {
		if (!/[a-z]/.test(char)) return char === "." ? "\\." : char;
		return `[${EQUIVALENT[char] ?? char + char.toUpperCase()}]`;
	}).join("");
}

const SLACK = ignoringCase("slack");
const VARIANTS = `(?:${ignoringCase("-files")}|${ignoringCase("-gov")}|${ignoringCase("-files-gov")})?`;
const COM = ignoringCase(".com");

/** A control sequence with a label; the label may hold anything but angle brackets. */
const LABELLED = /<([^<>|]*)\|([^<>]*)>/gu;
/** Slack's hosts, GovSlack's included. */
const SLACK_HOST = new RegExp(`(?:^|\\.)${SLACK}${VARIANTS}${COM}(?=\\n?$)`, "u");
/** Slack's names anywhere, and its own URI scheme (slack://channel?id=...). */
const SLACK_NAME = new RegExp(`${SLACK}${VARIANTS}${COM}|${SLACK}:/`, "u");

export const NO_SLACK_LINKS = "must not link to Slack: Slack would show the linked message, which may be in another channel";

/** `_to_slack`: whether a link target is a channel, or anything in Slack. */
export function toSlack(target: string): boolean {
	if (target.startsWith("#") || target.startsWith("@") || target.startsWith("!")) return target.startsWith("#");
	const url = URL.parse(target);
	if (url === null || url.protocol === "slack:") return true;
	return SLACK_HOST.test(url.hostname) || SLACK_NAME.test(decoded(target));
}

/** The text an agent is shown. */
export function redact(text: string): string;
export function redact(text: string | null): string | null;
export function redact(text: string | null): string | null {
	if (text === null) return null;
	return text.replace(LABELLED, (whole: string, target: string) => (toSlack(target) ? `<${target}>` : whole));
}

/** Whether written text names Slack in any encoding (the second half of `check_written`). */
export function linksToSlack(text: string): boolean {
	return SLACK_NAME.test(decoded(text));
}

/** `check_written`: refuses text that would do more than add words to a channel; null when it passes. */
export function writtenProblem(text: string): string | null {
	if (!isPlainText(text)) return PLAIN_TEXT;
	return linksToSlack(text) ? NO_SLACK_LINKS : null;
}

/** Text as Slack shows it literally. */
export function escape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
