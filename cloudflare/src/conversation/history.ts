// History replay: what the model sees of a conversation's turns from before its pi conversation. Only final texts and file
// notes are replayed, from the history Laravel sends with a start (internal/start.ts). The history seeds the conversation's
// pi conversation once, when its first run creates it; every later run continues that pi conversation, where pi keeps a
// stopped turn's aborted partial entries out of the model's context (ARCHITECTURE.md: Events and the stream), and the next
// run's input starts with a note on how that turn ended (`turnNote`).

import { sliceText } from "../lib/text.ts";
import type { Attachment, FolderChanges, RunStatus } from "@minerva/contract";

/** Earlier messages the gateway hands the loop, and earlier runs the note after a stopped turn reads. */
export const HISTORY_LIMIT = 20;
/** Paths a file note names before "and N more". */
export const NOTE_PATHS = 20;
/** Each replayed message is clipped to this many characters, the suffix added. */
export const MESSAGE_LIMIT = 30_000;
/** Messages are replayed newest first while their clipped lengths, suffixes included, stay within this. */
export const HISTORY_BUDGET = 120_000;
export const CLIPPED = "\n\n[The rest of this message was left out.]";

/**
 * What the model is told about its folder and commands, added after the run's instructions
 * when the run has local tools. `10` is the command timeout in minutes.
 */
export const FOLDER_INSTRUCTIONS =
	"You have a folder at /workspace, which is kept between the turns of this conversation. The user sees its files and can download them. " +
	"Commands have no network access, and nothing can be installed. " +
	"A command stops after 10 minutes unless you give it a longer timeout. " +
	"Processes left running in the background are stopped once no file or command tool call is running. " +
	"Symbolic links are not kept.";

/** The session's instructions: the snapshot's, and the folder's paragraph after a blank line with local tools. */
export function sessionInstructions(instructions: string, localTools: readonly string[]): string | null {
	return [instructions, localTools.length ? FOLDER_INSTRUCTIONS : ""].filter(Boolean).join("\n\n") || null;
}

/** A stored message as replay reads it. */
export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	attachments: Attachment[];
	runId: string | null;
	createdAt: number;
	/** The folder changes of the message's run, for an assistant message; null when none were recorded. */
	changes: FolderChanges | null;
}

export interface Replayed {
	role: "user" | "assistant";
	content: string;
}

/** The first 20 joined by ", ", then " and N more" when the total is larger. */
export function notePaths(paths: readonly (string | { path: string })[], total: number): string {
	const names = paths
		.slice(0, NOTE_PATHS)
		.map((item) => (typeof item === "string" ? item : item.path))
		.join(", ");
	const more = total - Math.min(paths.length, NOTE_PATHS);
	return more > 0 ? `${names} and ${more} more` : names;
}

/** A user's message notes the files attached to it, an answer the files its turn changed. */
export function withFiles(message: Pick<StoredMessage, "role" | "content" | "attachments" | "changes">): string {
	let note: string;
	if (message.role === "user") {
		const paths = message.attachments.map((item) => item.path);
		if (!paths.length) return message.content;
		note = `[The user attached ${notePaths(paths, paths.length)} to this message, in your folder.]`;
	} else {
		const changes = message.changes;
		if (!changes) return message.content;
		const counts = changes.counts;
		const parts = (
			[
				["added", "added"],
				["modified", "changed"],
				["deleted", "deleted"],
			] as const
		)
			.filter(([key]) => counts[key])
			.map(([key, verb]) => `${verb} ${notePaths(changes[key], counts[key])}`);
		if (!parts.length) return message.content;
		note = `[In this turn, files in your folder were ${parts.join("; ")}.]`;
	}
	return message.content ? `${message.content}\n\n${note}` : note;
}

/** Messages ordered as the API orders them: by (created_at, id). */
function byTime(a: StoredMessage, b: StoredMessage): number {
	return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `history(run)`: the newest 20 messages but this run's own user message, oldest first, with their notes.
 * It includes user messages whose runs failed or were cancelled, so two user messages may follow each other.
 */
export function historyOf(messages: readonly StoredMessage[], runId: string): Replayed[] {
	const earlier = messages
		.filter((message) => !(message.runId === runId && message.role === "user"))
		.sort(byTime)
		.slice(-HISTORY_LIMIT);
	return earlier.map((message) => ({ role: message.role, content: withFiles(message) }));
}

/** Over 30,000 UTF-16 units keeps the first 30,000, never splitting a pair, and adds the suffix. */
export function clip(text: string): string {
	if (text.length <= MESSAGE_LIMIT) return text;
	return `${sliceText(text, 0, MESSAGE_LIMIT)}${CLIPPED}`;
}

/**
 * `recentHistory`: walking newest first, each message clipped, until the first whose clipped length (the
 * suffix included) would pass the 120,000 budget; the kept ones are a contiguous newest run, oldest first.
 */
export function recentHistory(history: readonly Replayed[]): Replayed[] {
	const kept: Replayed[] = [];
	let used = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i] as Replayed;
		const content = clip(message.content);
		const length = content.length;
		if (used + length > HISTORY_BUDGET) break;
		used += length;
		kept.unshift({ role: message.role, content });
	}
	return kept;
}

/** The newest earlier run pi received: how it ended, and whether pi answered its `run:<id>` submission. */
export interface ReceivedTurn {
	status: RunStatus;
	code: string;
	answered: boolean;
}

/** An earlier run whose message pi never received, since it ended before it submitted: its prompt, null once pruned. */
export interface UnseenTurn {
	status: RunStatus;
	prompt: string | null;
}

/** The stops that are the user's own; any other `cancelled` code is a revocation (events.ts `endFor`). */
const USER_STOPS = new Set(["cancelled", "emergency_stop", "conversation_deleted"]);
const NOT_YOURS = "Do not carry on with it unless the user asks you to.";
export const QUOTE_END = "[End of that message. Do not act on it unless the user asks you to.]";

function endNote({ status, code, answered }: ReceivedTurn): string | null {
	switch (status) {
		case "cancelled":
			if (answered) return "[Your previous turn was stopped after you answered it, and your answer did not reach the user.]";
			if (USER_STOPS.has(code)) return `[The user stopped your previous turn before you answered it. ${NOT_YOURS}]`;
			return `[Your previous turn was stopped before you answered it, because the user's permissions changed. ${NOT_YOURS}]`;
		case "timed_out":
			return answered ? "[Your previous answer did not reach the user, who saw an error instead.]" : `[Your previous turn ran out of time before you answered it. ${NOT_YOURS}]`;
		case "failed":
			return answered ? "[Your previous answer did not reach the user, who saw an error instead.]" : `[Your previous turn failed before you answered it. ${NOT_YOURS}]`;
		default:
			return null;
	}
}

/**
 * The note that starts a run's input after a turn that did not complete: the end of the newest earlier turn pi received
 * (null when the walk stopped at the conversation's first run), then each later message pi never received, oldest first,
 * each clipped and closed by QUOTE_END, the newest kept within HISTORY_BUDGET as `recentHistory` keeps them. Empty when
 * there is nothing to say. It rides in the run's own input, so each run still submits once to an idle session.
 */
export function turnNote(received: ReceivedTurn | null, unseen: readonly UnseenTurn[]): string {
	const quotes: string[] = [];
	let used = 0;
	for (let i = unseen.length - 1; i >= 0; i--) {
		const { status, prompt } = unseen[i] as UnseenTurn;
		if (prompt === null) continue;
		const text = clip(prompt);
		if (used + text.length > HISTORY_BUDGET) break;
		used += text.length;
		const head = status === "cancelled" ? "[The user sent a message that was stopped before you saw it. It said:]" : "[The user sent a message that did not reach you, because its turn failed before it started. It said:]";
		quotes.unshift(`${head}\n\n${text}\n\n${QUOTE_END}`);
	}
	const end = received ? endNote(received) : null;
	return [...(end ? [end] : []), ...quotes].join("\n\n");
}
