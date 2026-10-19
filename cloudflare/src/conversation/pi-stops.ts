// Stopping pi's work by its run: every live task that the acting
// run's operation does not own (pi-work.ts `belongs`) is orphaned, and a stop marks orphans one by one with `abortTask`. It
// never aborts a whole pi conversation and never withdraws a submission, so the active run's work is never touched. Marking
// and settling stay apart, as pi's calls do: `abortTask` resolves once its mark is committed and the run invocation it saw
// ended, not once the task is terminal, which only `waitForTask` shows. Starts run one at a time in its lane, each waiting
// for the orphans to end before it configures pi or submits (The start's wait). pi is passed to each call and the operation
// read through the host, so unit tests run this class on pi over node:sqlite.

import type { Harness, TaskRecord } from "@earendil-works/pi-durable";
import { belongs, type Operation } from "./pi-work.ts";

/** chord's background context: never cancelled, no values. */
const BG = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "[Context minerva-pi-stops]" });

/** How long a start waits for pi's earlier work in production, from when its section is queued, before the object resets. */
export const PI_SETTLE_MS = 30_000;

/** What a stop reads besides pi: the acting run's operation, the bound on a start's wait, and where a failure is logged. */
export interface PiStopsHost {
	/** The acting run's operation, or null when no run acts, which leaves every live task orphaned. */
	operation(): Promise<Operation | null>;
	/** How long a start's section may wait, in the lane and in its settle, in ms from when it is queued. */
	bound(): number;
	log(message: string, error: unknown): void;
}

/** What a start's section waits with. */
export interface Section {
	/**
	 * A settle until `end` or the section's deadline aborts; true when the start may go on, which neither did. Once it
	 * answers, the section no longer waits, and its deadline resets nothing.
	 */
	settle(pi: Pick<Harness, "inspect" | "abortTask" | "waitForTask">, end: AbortSignal): Promise<boolean>;
}

/** One mark: the live tasks it found orphaned, background ones included, and the end of their marks. */
export interface Marked {
	orphans: readonly TaskRecord<unknown, unknown, unknown>[];
	/** Once every mark is committed and has joined the run invocation it saw, or failed; failures are logged, so it never rejects. */
	marked: Promise<void>;
}

export class PiStops {
	readonly #host: PiStopsHost;
	/** The end of the last section queued, never rejected. */
	#lane: Promise<void> = Promise.resolve();

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

	/**
	 * A start's section: `fn` runs once every section queued before it has ended, whether it threw or not, so no start
	 * configures pi or submits while an earlier one is between its checks and its submit. Its deadline is `bound()` ms after
	 * this call, so it covers the time in the lane and the wait. If it passes while the section still waits, `expired` is
	 * called once; a section whose deadline passed in the lane never runs. Its timer is cleared once it ended.
	 */
	section(fn: (section: Section) => Promise<void>, expired: (bound: number) => Promise<void>): Promise<void> {
		const bound = this.#host.bound();
		const deadline = new AbortController();
		let waiting = true;
		const timer = setTimeout(() => {
			deadline.abort(new Error(`pi's earlier work did not end within ${bound} ms.`));
			if (waiting) expired(bound).catch((error: unknown) => this.#host.log("a start past its bound failed", error));
		}, bound);
		const section: Section = {
			settle: async (pi, end) => {
				await this.settle(pi, AbortSignal.any([end, deadline.signal]));
				// In the stretch that reads both signals: the timer either fired before it, or finds the wait over.
				waiting = false;
				return !end.aborted && !deadline.signal.aborted;
			},
		};
		const ran = this.#lane
			.then(() => (deadline.signal.aborted ? undefined : fn(section)))
			.finally(() => {
				waiting = false;
				clearTimeout(timer);
			});
		this.#lane = ran.catch(() => {});
		return ran;
	}
}
