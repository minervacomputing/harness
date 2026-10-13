// History replay: what the model sees of a conversation's earlier turns. Only final
// texts and file notes are replayed, from our own messages table, never pi's transcript, so pi's aborted
// partial entries never reach the next turn (plan: Events and the stream). Each run is a fresh pi session
// seeded with this history when it is created; a resumed attempt keeps what its session holds.

import { sliceText } from "../lib/text.ts";
import type { AttachmentOut, FolderChangesOut } from "../shared/api.ts";

/** Earlier messages the gateway hands the loop. */
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
	attachments: AttachmentOut[];
	runId: string | null;
	createdAt: number;
	/** The folder changes of the message's run, for an assistant message; null when none were recorded. */
	changes: FolderChangesOut | null;
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
			.map(([key, verb]) => `${verb} ${notePaths(changes[key], counts[key] ?? 0)}`);
		if (!parts.length) return message.content;
		note = `[In this turn, files in your folder were ${parts.join("; ")}.]`;
	}
	return message.content ? `${message.content}\n\n${note}` : note;
}

/** The run's prompt: its user message with its note, or "" when there is none. */
export function promptOf(messages: readonly StoredMessage[], runId: string): string {
	const own = messages.find((message) => message.runId === runId && message.role === "user");
	return own ? withFiles(own) : "";
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
