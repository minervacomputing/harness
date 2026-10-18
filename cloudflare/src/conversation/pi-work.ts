// What pi holds for a run, by its operation (docs/plans/chunk-19a-design.md, The data shape): the `run:<id>` submission
// the run sent to its session, and the tasks pi made for that submission. The active run's operation owns its work;
// everything else pi holds is orphaned. The settings the Conversation opens pi with are here too, since the rule rests on
// one of them: pi makes no background work.

import type { ConversationId, HarnessSettings, SubmissionId, TaskRecord } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { classifyWork, type PiWork, type SubmissionStatus } from "./gate.ts";
import type { RunRow } from "./store.ts";

/** chord's background context: never cancelled, no values. */
const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context minerva-pi-work]" });

/** Longer than a turn runs in practice: partial answers and tool output are not committed while they stream. */
const NEVER_MS = 2_000_000_000;

/**
 * pi's settings: a failed model call ends the turn (any retry delay pi might use
 * stays at or under 60 s, so a long wait is never mistaken for a restart); no background compaction; no
 * partial commits, so an interrupted answer is asked again; and no context kept in memory after a turn,
 * which would keep every object active, and billed, for 10 minutes (spike: PiHarness, fact 17).
 */
export const PI_SETTINGS: HarnessSettings = {
	retry: { enabled: false, maxAgentDelayMs: 60_000 },
	compaction: { backgroundTokens: 0 },
	progress: { partialIntervalMs: NEVER_MS, outputIntervalMs: NEVER_MS },
	stream: { maxRetryDelayMs: 60_000 },
	contextRetentionMs: 0,
};

const LIVE_TASKS = ["pending", "running", "waiting", "completing"] as const;

/** A run's operation in pi: the session it claimed, and its `run:<id>` submission once pi has it. */
export type Operation = { session: ConversationId; submission: { id: SubmissionId; status: SubmissionStatus } | null };

/**
 * Whether `task` is the operation's: in its session, not a background task, and made after its submission, whatever the
 * submission's status, so a settled run's last live task is still its own. pi's ids ascend in commit order, and a run's
 * first generation is made in the commit that places its input, so every task of the run is above its submission. Another
 * run's task is above it only if that run's work was still live when this one submitted, which Minerva never lets happen.
 */
export function belongs(op: Operation, task: Pick<TaskRecord<unknown, unknown, unknown>, "id" | "conversationId" | "background">): boolean {
	return op.submission !== null && task.conversationId === op.session && !task.background && task.id > op.submission.id;
}

/**
 * What pi holds for a run, read through the factory's storage (the gate) or after open. The run's submission decides
 * first, so pi's tasks are read only for a settled one: the newest live non-background task of each live status. When
 * its id is not above the submission's, no task of that status is the run's, so one task per status is exact.
 */
export async function piWork(storage: SqliteStorage, run: Pick<RunRow, "id" | "session">): Promise<PiWork> {
	if (run.session === null) return "not_submitted";
	const session = Number(run.session) as ConversationId;
	const submission = await storage.submissionByRequest(session, `run:${run.id}`, BG);
	let own = 0;
	if (submission?.status === "done" || submission?.status === "unanswered") {
		const op: Operation = { session, submission: { id: submission.id, status: submission.status } };
		for (const status of LIVE_TASKS) {
			const { items } = await storage.scanTasks({ conversationId: session, status, background: false, order: "descending" }, 1, undefined, BG);
			if (items.some((task) => belongs(op, task))) own += 1;
		}
	}
	return classifyWork(submission?.status, own);
}
