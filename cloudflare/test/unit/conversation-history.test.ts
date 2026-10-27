// History replay: the turns, their files and what they changed, `clip` and `recentHistory`, and the note after a stopped turn
// or after held calls were answered.

import { describe, expect, test } from "vitest";
import {
	ANSWERED_HEAD,
	type AnsweredHold,
	CLIPPED,
	FOLDER_INSTRUCTIONS,
	clip,
	HISTORY_BUDGET,
	historyOf,
	type HoldAnswer,
	MESSAGE_LIMIT,
	notePaths,
	QUOTE_END,
	recentHistory,
	type ReceivedTurn,
	sessionInstructions,
	type StoredMessage,
	turnNote,
	withFiles,
} from "../../src/conversation/history.ts";
import type { FolderChanges } from "@minerva/contract";

const RUN = "0199a000-0000-7000-8000-000000000001";

function message(fields: Partial<StoredMessage> & Pick<StoredMessage, "role" | "content">, index = 0): StoredMessage {
	return { id: `m${String(index).padStart(4, "0")}`, attachments: [], runId: null, createdAt: 1000 + index, changes: null, ...fields };
}

function attachment(path: string) {
	return { path, size: 1, mediaType: "text/plain" };
}

function changes(counts: Partial<FolderChanges["counts"]>, lists: Partial<Pick<FolderChanges, "added" | "modified" | "deleted">> = {}): FolderChanges {
	return {
		counts: { added: 0, modified: 0, deleted: 0, dirsAdded: 0, dirsDeleted: 0, ...counts },
		added: lists.added ?? [],
		modified: lists.modified ?? [],
		deleted: lists.deleted ?? [],
		dirsAdded: [],
		dirsDeleted: [],
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
		expect(withFiles(message({ role: "assistant", content: "Ok", changes: changes({ dirsAdded: 3 }) }))).toBe("Ok");
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

describe("history", () => {
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

describe("the note after a stopped turn", () => {
	const received = (status: ReceivedTurn["status"], code: string, answered = false): ReceivedTurn => ({ status, code, answered });

	test("the end of the newest turn pi received, by how its run ended and whether pi had answered", () => {
		const cases: [ReceivedTurn, string][] = [
			[received("cancelled", "cancelled"), "[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]"],
			[received("cancelled", "emergency_stop"), "[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]"],
			[received("cancelled", "connection_removed"), "[Your previous turn was stopped before you answered it, because the user's permissions changed. Do not carry on with it unless the user asks you to.]"],
			[received("cancelled", "permissions_changed"), "[Your previous turn was stopped before you answered it, because the user's permissions changed. Do not carry on with it unless the user asks you to.]"],
			[received("timed_out", "timed_out"), "[Your previous turn ran out of time before you answered it. Do not carry on with it unless the user asks you to.]"],
			[received("failed", "compaction_failed"), "[Your previous turn failed before you answered it. Do not carry on with it unless the user asks you to.]"],
			[received("cancelled", "permissions_changed", true), "[Your previous turn was stopped after you answered it, and your answer did not reach the user.]"],
			[received("failed", "worker_failed", true), "[Your previous answer did not reach the user, who saw an error instead.]"],
			[received("timed_out", "timed_out", true), "[Your previous answer did not reach the user, who saw an error instead.]"],
		];
		for (const [turn, note] of cases) expect(turnNote(turn, [])).toBe(note);
		expect(turnNote(received("completed", "", true), [])).toBe("");
		expect(turnNote(null, [])).toBe("");
	});

	test("then each message pi never received, oldest first, closed by its end, and none whose snapshot is gone", () => {
		const note = turnNote(received("cancelled", "cancelled"), [
			{ status: "cancelled", prompt: "First." },
			{ status: "failed", prompt: null },
			{ status: "failed", prompt: "Second." },
		]);
		expect(note).toBe(
			[
				"[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]",
				"[The user sent a message that was stopped before you saw it. It said:]",
				"First.",
				QUOTE_END,
				"[The user sent a message that did not reach you, because its turn failed before it started. It said:]",
				"Second.",
				QUOTE_END,
			].join("\n\n"),
		);
		// The walk stopped at the conversation's first run, or the turn pi received completed: the quotes alone.
		expect(turnNote(null, [{ status: "timed_out", prompt: "Only." }])).toBe(`[The user sent a message that did not reach you, because its turn failed before it started. It said:]\n\nOnly.\n\n${QUOTE_END}`);
		expect(turnNote(received("completed", "", true), [{ status: "cancelled", prompt: "Only." }])).toBe(`[The user sent a message that was stopped before you saw it. It said:]\n\nOnly.\n\n${QUOTE_END}`);
	});

	test("each quote clipped to 30,000, the newest kept within 120,000", () => {
		const unseen = [
			{ status: "cancelled" as const, prompt: "old" },
			...Array.from({ length: 4 }, (_, i) => ({ status: "cancelled" as const, prompt: String(i).repeat(40_000) })),
		];
		const note = turnNote(null, unseen);
		// Three clipped quotes fit (as in recentHistory's test); the fourth would pass the budget, and the walk stops there.
		expect(note.split(QUOTE_END)).toHaveLength(4);
		for (const digit of ["1", "2", "3"]) expect(note).toContain(`${digit.repeat(MESSAGE_LIMIT)}${CLIPPED}\n\n${QUOTE_END}`);
		expect(note).not.toContain("0000");
		expect(note).not.toContain("old");
	});
});

describe("the note after held calls were answered", () => {
	const LABEL = "Gmail: Send mail";
	const answered = (...answers: HoldAnswer[]): AnsweredHold[] => answers.map((answer) => ({ label: LABEL, answer }));
	const continuation = (...answers: HoldAnswer[]) => ({ continuation: true, answered: answered(...answers) });
	const STOPPED = "[The user stopped your previous turn before you answered it. Do not carry on with it unless the user asks you to.]";
	const DECLINED = "[The user declined Gmail: Send mail. It did not run. Do not try it again unless they ask.]";
	const CLOSED = "[Gmail: Send mail, which you asked for, was not approved and did not run.]";
	const EARLIER = "[You asked to Gmail: Send mail. The user approved it, but it did not run, because an approved action before it did not succeed.]";

	test("one line per held call, by what became of it", () => {
		const cases: [HoldAnswer, string][] = [
			[{ kind: "declined" }, DECLINED],
			[{ kind: "closed" }, CLOSED],
			[{ kind: "ran", result: '{"items":[{"id":"m1"}],"count":1}' }, '[You asked to Gmail: Send mail. The user approved it, and it ran: {"items":[{"id":"m1"}],"count":1}]'],
			[{ kind: "failed", message: "The provider refused this request." }, "[You asked to Gmail: Send mail. The user approved it, but it failed: The provider refused this request.]"],
			[{ kind: "unavailable" }, "[You asked to Gmail: Send mail. The user approved it, but it is not available any more, so it did not run.]"],
			[{ kind: "changed" }, "[You asked to Gmail: Send mail. The user approved it, but it changed since they approved it, so it did not run.]"],
			[{ kind: "earlier" }, EARLIER],
			[{ kind: "stopped" }, "[You asked to Gmail: Send mail. The user approved it, but the turn was stopped before it ran.]"],
			[{ kind: "unknown" }, "[You asked to Gmail: Send mail. The user approved it, but whether it ran is unknown. Check before trying again.]"],
		];
		for (const [answer, line] of cases) expect(turnNote(null, [], continuation(answer))).toBe(line);
	});

	test("a failure says the approved calls after it did not run only when one of them did not", () => {
		const failed: HoldAnswer = { kind: "failed", message: "Refused" };
		const line = "[You asked to Gmail: Send mail. The user approved it, but it failed: Refused.";
		expect(turnNote(null, [], continuation(failed, { kind: "earlier" }))).toBe(`${line} The approved actions after it did not run.]\n\n${EARLIER}`);
		expect(turnNote(null, [], continuation(failed, { kind: "declined" }))).toBe(`${line}]\n\n${DECLINED}`);
		expect(turnNote(null, [], continuation({ kind: "declined" }, failed))).toBe(`${DECLINED}\n\n${line}]`);
	});

	test("a continuation's lines follow ANSWERED_HEAD only when the note says something before them", () => {
		expect(turnNote({ status: "cancelled", code: "cancelled", answered: false }, [], continuation({ kind: "declined" }))).toBe([STOPPED, ANSWERED_HEAD, DECLINED].join("\n\n"));
		expect(turnNote({ status: "completed", code: "", answered: true }, [], continuation({ kind: "declined" }))).toBe(DECLINED);
		expect(turnNote(null, [{ status: "cancelled", prompt: "Hi." }], continuation({ kind: "declined" }))).toBe(
			["[The user sent a message that was stopped before you saw it. It said:]", "Hi.", QUOTE_END, ANSWERED_HEAD, DECLINED].join("\n\n"),
		);
		// A plain start's closed holds need no head, and a continuation with nothing to say has no note.
		expect(turnNote({ status: "cancelled", code: "cancelled", answered: false }, [], { continuation: false, answered: answered({ kind: "closed" }) })).toBe([STOPPED, CLOSED].join("\n\n"));
		expect(turnNote({ status: "cancelled", code: "cancelled", answered: false }, [], { continuation: true, answered: [] })).toBe(STOPPED);
	});

	test("an earlier continuation pi never received is told by its lines, never its prompt; an earlier plain run by its quote, then what it closed", () => {
		const note = turnNote(null, [
			{ status: "cancelled", prompt: "Approved.", continuation: true, answered: answered({ kind: "ran", result: "{}" }, { kind: "stopped" }) },
			{ status: "failed", prompt: null, answered: [] },
			{ status: "failed", prompt: "Next.", answered: answered({ kind: "closed" }) },
		]);
		expect(note).toBe(
			[
				"[You asked to Gmail: Send mail. The user approved it, and it ran: {}]",
				"[You asked to Gmail: Send mail. The user approved it, but the turn was stopped before it ran.]",
				"[The user sent a message that did not reach you, because its turn failed before it started. It said:]",
				"Next.",
				QUOTE_END,
				CLOSED,
			].join("\n\n"),
		);
		expect(note).not.toContain("Approved.");
	});
});
