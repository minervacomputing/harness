// What pi holds for a run, by its operation (docs/plans/chunk-19a-design.md, The data shape): the `run:<id>` submission
// the run sent to its session, and the tasks pi made for that submission. The active run's operation owns its work;
// everything else pi holds is orphaned. The gate reads it here, and tool and model calls are admitted by it (Admission).
// The settings the Conversation opens pi with are here too, since the rule rests on one of them: pi makes no background
// work.

import type { ConversationId, HarnessSettings, SubmissionId, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AttemptFence, EpochMs } from "../shared/rpc.ts";
import { classifyWork, type PiWork, type SubmissionStatus } from "./gate.ts";
import type { RunRow, RunStore } from "./store.ts";

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

/** The run's operation, read through the factory's storage; null for a run that has claimed no session. */
export async function operationOf(storage: Pick<SqliteStorage, "submissionByRequest">, run: Pick<RunRow, "id" | "session">): Promise<Operation | null> {
	if (run.session === null) return null;
	const session = Number(run.session) as ConversationId;
	const submission = await storage.submissionByRequest(session, `run:${run.id}`, BG);
	return { session, submission: submission === undefined ? null : { id: submission.id, status: submission.status } };
}

/**
 * What pi holds for a run, read through the factory's storage (the gate) or after open. The run's submission decides
 * first, so pi's tasks are read only for a settled one: the newest live non-background task of each live status. When
 * its id is not above the submission's, no task of that status is the run's, so one task per status is exact.
 */
export async function piWork(storage: SqliteStorage, run: Pick<RunRow, "id" | "session">): Promise<PiWork> {
	const op = await operationOf(storage, run);
	const submitted = op?.submission?.status;
	let own = 0;
	if (op !== null && (submitted === "done" || submitted === "unanswered")) {
		for (const status of LIVE_TASKS) {
			const { items } = await storage.scanTasks({ conversationId: op.session, status, background: false, order: "descending" }, 1, undefined, BG);
			if (items.some((task) => belongs(op, task))) own += 1;
		}
	}
	return classifyWork(submitted, own);
}

/** A tool execution as pi names it: the session it runs in and its task (`api.conversationId`, `api.taskId`). */
export type PiCall = { session: ConversationId; task: TaskId };

/** What admission reads: the store's active run and fence check, and pi's submissions once the factory opened pi. */
export interface Admission {
	store: Pick<RunStore, "activeRun" | "isCurrent">;
	pi(): Pick<SqliteStorage, "submissionByRequest"> | null;
}

/** A tool's admission also counts the execution for the test build, by the session it names, before any check. */
export interface ToolAdmission extends Admission {
	entered(session: string): void;
}

/**
 * The active run's current attempt, when the call is that run's: from its session, while its submission is placed, and
 * from a task made after the submission, so work another run left in the session never acts under this run's grants. The
 * fence is checked after pi's read, so a run that ended meanwhile is refused.
 */
export async function admitTool(deps: ToolAdmission, call: PiCall): Promise<{ fence: AttemptFence; deadline: EpochMs | null } | null> {
	deps.entered(String(call.session));
	const run = deps.store.activeRun();
	if (run === null || run.session !== String(call.session)) return null;
	const submission = await deps.pi()?.submissionByRequest(Number(run.session) as ConversationId, `run:${run.id}`, BG);
	if (submission?.status !== "placed" || call.task <= submission.id) return null;
	const fence = { runId: run.id, attempt: run.attempt };
	return deps.store.isCurrent(fence) ? { fence, deadline: run.deadline } : null;
}

/**
 * Whether a model call the wrapper began for `fence` may be recorded and sent: the fence's run is the active one and its
 * submission is placed. pi gives a model call no task, so the operation's state is the rule. It is enough because a
 * session's model calls come only from the generation holding its live run and the compactions that generation owns,
 * and no generation but the placed operation's is left live in its session (docs/plans/chunk-19a-design.md, Admission).
 */
export async function admitModel(deps: Admission, fence: AttemptFence): Promise<boolean> {
	const run = deps.store.activeRun();
	if (run === null || run.id !== fence.runId || run.session === null) return false;
	const submission = await deps.pi()?.submissionByRequest(Number(run.session) as ConversationId, `run:${run.id}`, BG);
	return submission?.status === "placed" && deps.store.isCurrent(fence);
}
