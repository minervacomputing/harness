// Stopping pi's work by its run (docs/plans/chunk-19a-design.md, Stopping and settling): every live task that the acting
// run's operation does not own (pi-work.ts `belongs`) is orphaned, and a stop marks orphans one by one with `abortTask`. It
// never aborts a whole pi conversation and never withdraws a submission, so the active run's work is never touched. Marking
// and settling stay apart, as pi's calls do: `abortTask` resolves once its mark is committed and the run invocation it saw
// ended, not once the task is terminal, which only `waitForTask` shows. pi is passed to each call and the operation read
// through the host, so unit tests run this class on pi over node:sqlite.

import type { Harness, TaskRecord } from "@earendil-works/pi-durable";
import { belongs, type Operation } from "./pi-work.ts";

/** chord's background context: never cancelled, no values. */
const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context minerva-pi-stops]" });

/** What a stop reads besides pi: the acting run's operation, and where a failed mark is logged. */
export interface PiStopsHost {
	/** The acting run's operation, or null when no run acts, which leaves every live task orphaned. */
	operation(): Promise<Operation | null>;
	log(message: string, error: unknown): void;
}

/** One mark: the live tasks it found orphaned, background ones included, and the end of their marks. */
export interface Marked {
	orphans: readonly TaskRecord<unknown, unknown, unknown>[];
	/** Once every mark is committed and has joined the run invocation it saw, or failed; failures are logged, so it never rejects. */
	marked: Promise<void>;
}

export class PiStops {
	readonly #host: PiStopsHost;

	constructor(host: PiStopsHost) {
		this.#host = host;
	}

	/**
	 * One pass. pi's live tasks are read first, then the acting run's operation, so a submission committed between the two
	 * reads has no task in the inspection that could be taken for an orphan. Then, in one synchronous stretch, `abortTask`
	 * starts for every orphan, marked or not, since pi commits no second mark for a task marked by request and replaces a
	 * `restart` mark; with `session`, only for that session's. Resolves once the marks are started: one can wait on a run
	 * invocation that ignores its signal.
	 */
	async mark(pi: Pick<Harness, "inspect" | "abortTask">, session?: number): Promise<Marked> {
		const { tasks } = await pi.inspect(BG);
		const op = await this.#host.operation();
		const orphans = tasks.map((task) => task.record).filter((task) => (session === undefined || task.conversationId === session) && (op === null || !belongs(op, task)));
		const marked = Promise.allSettled(orphans.map((task) => pi.abortTask(task.id, BG))).then((results) => {
			for (const [i, result] of results.entries()) if (result.status === "rejected") this.#host.log(`pi's task ${orphans[i]?.id} could not be marked`, result.reason);
		});
		return { orphans, marked };
	}

	/**
	 * Marks, then waits for one live non-background orphan to end, whoever marked it, until a mark finds none. pi settles an
	 * orphaned submission in the commit that ends the generation holding its run, which is such a task, so no submission needs
	 * a wait of its own. Once `signal` aborts, it returns, and pi cancels only the wait. `waitForTask` resumes pi's scheduler, so
	 * this must never run before PiHarness resumes pi; `harness.pi()` returns only after it.
	 */
	async settle(pi: Pick<Harness, "inspect" | "abortTask" | "waitForTask">, signal?: AbortSignal): Promise<void> {
		const context = { ...BG, abortSignal: signal };
		for (;;) {
			const { orphans } = await this.mark(pi);
			const first = orphans.find((task) => !task.background);
			if (first === undefined) return;
			try {
				await pi.waitForTask(first.id, context);
			} catch (error) {
				if (!signal?.aborted) throw error;
				return;
			}
		}
	}
}
