// The text of nested links without quadratic work, for the HTML readers that show a link as "label (address)"
// (Intercom's and Teams' html.ts): each label is joined and trimmed as its link closes and put in the
// enclosing label, which, done naively, copies the text of links nested n deep n times. Here a closed link's
// text is a `Joined` of the pieces it was made of, built in time proportional to its own pieces, and the
// whole text is written out once at the end.

/**
 * Text made of pieces, never empty, that neither starts nor ends with whitespace (as `trim()` counts it):
 * every one is a trimmed label, or a trimmed label followed by " (address)".
 */
export class Joined {
	readonly parts: readonly Piece[];
	readonly length: number;

	constructor(parts: readonly Piece[]) {
		this.parts = parts;
		this.length = parts.reduce((sum, part) => sum + part.length, 0);
	}
}

export type Piece = string | Joined;

/** The pieces' text, written out without recursion (the nesting may be as deep as the page is long). */
export function written(pieces: readonly Piece[]): string {
	const out: string[] = [];
	const stack: [readonly Piece[], number][] = [[pieces, 0]];
	while (stack.length) {
		const frame = stack[stack.length - 1] as [readonly Piece[], number];
		const [parts, at] = frame;
		if (at === parts.length) {
			stack.pop();
			continue;
		}
		frame[1] = at + 1;
		const part = parts[at] as Piece;
		if (typeof part === "string") out.push(part);
		else stack.push([part.parts, 0]);
	}
	return out.join("");
}

/**
 * The label's text, trimmed. Only strings can carry whitespace at the ends (a `Joined` has none), so the
 * strings of whitespace at either end are dropped and the ones next to them trimmed.
 */
function trimmed(label: readonly Piece[]): Piece {
	let start = 0;
	let end = label.length;
	while (start < end && typeof label[start] === "string" && !(label[start] as string).trimStart()) start++;
	while (end > start && typeof label[end - 1] === "string" && !(label[end - 1] as string).trimEnd()) end--;
	if (start === end) return "";
	const parts = label.slice(start, end);
	if (typeof parts[0] === "string") parts[0] = parts[0].trimStart();
	const last = parts.length - 1;
	if (typeof parts[last] === "string") parts[last] = parts[last].trimEnd();
	return parts.length === 1 ? (parts[0] as Piece) : new Joined(parts);
}

/** What a closed link shows: "label (address)", or the label alone when it is the address, or the address alone when there is no label. */
export function linkText(label: readonly Piece[], href: string): Piece {
	const text = trimmed(label);
	if (text.length && href && !(text.length === href.length && written([text]) === href)) return new Joined([text, " (", href, ")"]);
	return text.length ? text : href;
}

/** Whether the piece ends with a newline (a `Joined` ends with no whitespace at all). */
export function endsWithNewline(piece: Piece): boolean {
	return typeof piece === "string" && piece.endsWith("\n");
}
