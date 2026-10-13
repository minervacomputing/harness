// History replay: the turns, their files and what they changed, `clip` and `recentHistory`.

import { describe, expect, test } from "vitest";
import {
	CLIPPED,
	FOLDER_INSTRUCTIONS,
	clip,
	HISTORY_BUDGET,
	historyOf,
	MESSAGE_LIMIT,
	notePaths,
	promptOf,
	recentHistory,
	sessionInstructions,
	type StoredMessage,
	withFiles,
} from "../../src/conversation/history.ts";
import type { FolderChanges } from "@minerva/contract";

const RUN = "0199a000-0000-7000-8000-000000000001";

function message(fields: Partial<StoredMessage> & Pick<StoredMessage, "role" | "content">, index = 0): StoredMessage {
	return { id: `m${String(index).padStart(4, "0")}`, attachments: [], runId: null, createdAt: 1000 + index, changes: null, ...fields };
}

function attachment(path: string) {
	return { path, size: 1, media_type: "text/plain" };
}

function changes(counts: Partial<FolderChanges["counts"]>, lists: Partial<Pick<FolderChanges, "added" | "modified" | "deleted">> = {}): FolderChanges {
	return {
		counts: { added: 0, modified: 0, deleted: 0, dirs_added: 0, dirs_deleted: 0, ...counts },
		added: lists.added ?? [],
		modified: lists.modified ?? [],
		deleted: lists.deleted ?? [],
		dirs_added: [],
		dirs_deleted: [],
	};
}

describe("file notes", () => {
	test("an attachments-only message is the note alone", () => {
		const user = message({ role: "user", content: "", attachments: [attachment("notes (2).txt"), attachment("data.csv")] });
		expect(withFiles(user)).toBe("[The user attached notes (2).txt, data.csv to this message, in your folder.]");
	});

	test("a message with text has the note after a blank line", () => {
		const user = message({ role: "user", content: "Summarize", attachments: [attachment("a.pdf")] });
		expect(withFiles(user)).toBe("Summarize\n\n[The user attached a.pdf to this message, in your folder.]");
	});

	test("an answer notes what its turn changed, by kind, with its verbs", () => {
		const answer = message({
			role: "assistant",
			content: "Done.",
			changes: changes({ added: 1, deleted: 2 }, { added: [{ path: "a.txt", size: 1 }], deleted: [{ path: "b.txt", size: 1 }, { path: "c.txt", size: 2 }] }),
		});
		expect(withFiles(answer)).toBe("Done.\n\n[In this turn, files in your folder were added a.txt; deleted b.txt, c.txt.]");
		const modified = message({ role: "assistant", content: "", changes: changes({ modified: 1 }, { modified: [{ path: "x", size: 1 }] }) });
		expect(withFiles(modified)).toBe("[In this turn, files in your folder were changed x.]");
	});

	test("an answer whose turn changed only directories, or nothing, has no note", () => {
		expect(withFiles(message({ role: "assistant", content: "Ok", changes: changes({ dirs_added: 3 }) }))).toBe("Ok");
		expect(withFiles(message({ role: "assistant", content: "Ok" }))).toBe("Ok");
		// A user message's run changes never count.
		expect(withFiles(message({ role: "user", content: "Hi", changes: changes({ added: 1 }, { added: [{ path: "a", size: 1 }] }) }))).toBe("Hi");
	});

	test("at most 20 paths are named, then how many more", () => {
		const paths = Array.from({ length: 25 }, (_, i) => `f${i}.txt`);
		expect(notePaths(paths, 25)).toBe(`${paths.slice(0, 20).join(", ")} and 5 more`);
		expect(notePaths(paths.slice(0, 20), 20)).toBe(paths.slice(0, 20).join(", "));
		// A change list holds at most 100 entries while its count is complete.
		const listed = Array.from({ length: 100 }, (_, i) => ({ path: `p${i}`, size: 1 }));
		expect(notePaths(listed, 150)).toBe(`${listed.slice(0, 20).map((item) => item.path).join(", ")} and 130 more`);
	});
});

describe("prompt and history", () => {
	test("the prompt is this run's user message with its note, else empty", () => {
		const messages = [message({ role: "user", content: "", attachments: [attachment("a.txt")], runId: RUN })];
		expect(promptOf(messages, RUN)).toBe("[The user attached a.txt to this message, in your folder.]");
		expect(promptOf([], RUN)).toBe("");
	});

	test("the newest 20 messages but this run's own question, oldest first, failed runs' questions included", () => {
		const messages: StoredMessage[] = [];
		for (let i = 0; i < 30; i++) messages.push(message({ role: i % 3 === 2 ? "assistant" : "user", content: `m${i}` }, i));
		messages.push(message({ role: "user", content: "now", runId: RUN }, 30));
		const history = historyOf(messages, RUN);
		expect(history.map((item) => item.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 10}`));
		// Two user messages in a row: the earlier run failed or was cancelled.
		expect(history.slice(2, 4).map((item) => [item.content, item.role])).toEqual([
			["m12", "user"],
			["m13", "user"],
		]);
		// The answer of this run (after it, by time) would be replayed too, but this run's question never is.
		expect(history.some((item) => item.content === "now")).toBe(false);
	});

	test("messages are ordered by time, then id", () => {
		const a = message({ role: "user", content: "b" }, 2);
		const b = { ...message({ role: "assistant", content: "a" }, 1), createdAt: a.createdAt };
		expect(historyOf([a, b], RUN).map((item) => item.content)).toEqual(["a", "b"]);
	});
});

describe("instructions", () => {
	test("the folder's paragraph follows the run's instructions after a blank line, only with local tools", () => {
		expect(sessionInstructions("Be brief.", [])).toBe("Be brief.");
		expect(sessionInstructions("", [])).toBeNull();
		expect(sessionInstructions("Be brief.", ["read", "bash"])).toBe(`Be brief.\n\n${FOLDER_INSTRUCTIONS}`);
		expect(FOLDER_INSTRUCTIONS).toBe(
			"You have a folder at /workspace, which is kept between the turns of this conversation. The user sees its files and can download them. Commands have no network access, and nothing can be installed. A command stops after 10 minutes unless you give it a longer timeout. Processes left running in the background are stopped once no file or command tool call is running. Symbolic links are not kept.",
		);
	});
});

describe("clipping and the budget", () => {
	test("a message over 30,000 UTF-16 units keeps 30,000 and the suffix, never half a character", () => {
		expect(clip("a".repeat(MESSAGE_LIMIT))).toBe("a".repeat(MESSAGE_LIMIT));
		expect(clip("a".repeat(MESSAGE_LIMIT + 1))).toBe(`${"a".repeat(MESSAGE_LIMIT)}${CLIPPED}`);
		expect(clip("😀".repeat(MESSAGE_LIMIT / 2))).toBe("😀".repeat(MESSAGE_LIMIT / 2));
		expect(clip(`a${"😀".repeat(MESSAGE_LIMIT / 2)}`)).toBe(`a${"😀".repeat(MESSAGE_LIMIT / 2 - 1)}${CLIPPED}`);
		expect(CLIPPED).toBe("\n\n[The rest of this message was left out.]");
	});

	test("newest first within 120,000, the suffix counted, stopping at the first that does not fit", () => {
		const clipped = MESSAGE_LIMIT + CLIPPED.length;
		const history = [
			{ role: "user" as const, content: "old" },
			{ role: "assistant" as const, content: "x".repeat(40_000) },
			...Array.from({ length: 3 }, () => ({ role: "user" as const, content: "y".repeat(40_000) })),
		];
		const kept = recentHistory(history);
		// Three clipped messages fit (3 × 30,042); the fourth would pass the budget, so the walk stops there and
		// the short oldest one is not reached either.
		expect(3 * clipped).toBeLessThanOrEqual(HISTORY_BUDGET);
		expect(4 * clipped).toBeGreaterThan(HISTORY_BUDGET);
		expect(kept.map((item) => item.content)).toEqual(Array.from({ length: 3 }, () => `${"y".repeat(MESSAGE_LIMIT)}${CLIPPED}`));
	});

	test("exactly the budget fits", () => {
		const history = [
			{ role: "user" as const, content: "a".repeat(HISTORY_BUDGET - 4 * MESSAGE_LIMIT) },
			...Array.from({ length: 4 }, () => ({ role: "assistant" as const, content: "b".repeat(MESSAGE_LIMIT) })),
		];
		expect(recentHistory(history)).toHaveLength(5);
		expect(recentHistory([{ role: "user", content: "c" }, ...history])).toHaveLength(5);
	});
});
