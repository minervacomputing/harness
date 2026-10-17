// What a conversation keeps, and for how long (docs/plans/chunk-15a-design.md): one Lifecycle job, `retain`, deletes what is
// due in passes of bounded steps on the object's alarm, and only while no run is active. A pass runs its steps in order
// until nothing is due or its budget is spent, then schedules itself for what is left. Each step is one transaction outside
// pi's, deletes at most RETENTION.rowsPerStep rows and records how far it got in the same transaction, so a kill rolls back
// only the step in flight and the next pass finds what is left. Its steps so far: the facts Laravel acknowledged long enough
// ago (store.ts `pruneFacts`).

import type { EpochMs } from "../shared/rpc.ts";
import type { RunStore } from "./store.ts";

/** The periods and bounds; the tests shorten them. */
export const RETENTION = {
	/** A run's own records are kept this long after it ended. */
	runMs: 30 * 24 * 60 * 60_000,
	/** A fact is kept this long after Laravel acknowledged it. */
	factsMs: 7 * 24 * 60 * 60_000,
	/** A deleted conversation is removed this long after its deletion. */
	deletedMs: 7 * 24 * 60 * 60_000,
	/** A pass that finds a run active or a start prepared comes back this much later. */
	busyMs: 60 * 60_000,
	/** An item still due after a whole pass is blocked, and looked at again this much later. */
	blockedMs: 24 * 60 * 60_000,
	/** A pass ends after this much time, between steps, and comes back at once. */
	passMs: 250,
	/** A step deletes at most this many rows. */
	rowsPerStep: 500,
};

/** The Lifecycle job of the host that runs a pass. */
export const RETAIN_JOB = "retain";

/**
 * When the next pass is due, from the due times of what is left: the earliest, where one already past is blocked (the pass
 * that just ran over it could not delete it) and counts as RETENTION.blockedMs from now. Null when nothing is left.
 */
export function nextPass(now: EpochMs, due: readonly (EpochMs | null)[]): EpochMs | null {
	let next: EpochMs | null = null;
	for (const time of due) {
		if (time === null) continue;
		const at = time > now ? time : now + RETENTION.blockedMs;
		if (next === null || at < next) next = at;
	}
	return next;
}

/** A pass that failed `failures` times in a row is tried again after 30 s, doubling to an hour. */
export function retryMs(failures: number): number {
	return Math.min(30_000 * 2 ** Math.min(failures - 1, 20), 60 * 60_000);
}

/** What a pass runs against besides the store: the object's `retain` job, its log and the test build's fault point. */
export interface RetentionHost {
	/** Makes the `retain` job due at `time`, or removes it; synchronous, so it joins the step that decides it. */
	schedule(time: EpochMs | null): void;
	log(message: string, error: unknown): void;
	/** After each committed step (detail: the step); the test build's fault point `retain:step`. */
	stepped(step: string): Promise<void>;
}

export class Retention {
	readonly #store: RunStore;
	readonly #host: RetentionHost;
	/** Passes failed in a row in this instance, for the retry's backoff. */
	#failures = 0;

	constructor(store: RunStore, host: RetentionHost) {
		this.#store = store;
		this.#host = host;
	}

	/**
	 * When retention is next due from what is held, or null when nothing is: the earliest acknowledgement not yet past its
	 * period. Read in the caller's synchronous step.
	 */
	due(): EpochMs | null {
		const oldest = this.#store.oldestAcknowledgement();
		return oldest === null ? null : oldest + RETENTION.factsMs;
	}

	/**
	 * One pass of the `retain` job. It schedules the job itself, in the step that decides what is left, so an acknowledgement
	 * that moves the job earlier after that step is never undone by the pass's outcome. Never throws: a failure is logged and
	 * the job is made due again after a backoff, which the outcome also says, should that schedule fail too.
	 */
	async pass(): Promise<{ rescheduleAt: EpochMs } | undefined> {
		try {
			const started = this.#store.now();
			for (let steps = 0; ; steps++) {
				const step = await this.#store.outside(() => this.#step(started, steps));
				if (step === null) break;
				await this.#host.stepped(step);
				// The object's clock moves only with I/O, and other events wait while this runs: a timer lets both happen.
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			this.#failures = 0;
			return undefined;
		} catch (error) {
			this.#failures++;
			const at = this.#store.now() + retryMs(this.#failures);
			this.#host.log(`retention failed (${this.#failures} in a row)`, error);
			try {
				this.#host.schedule(at);
			} catch (scheduling) {
				this.#host.log("the retain job was not scheduled", scheduling);
			}
			return { rescheduleAt: at };
		}
	}

	/**
	 * The pass's next step, run in one synchronous stretch: its name, or null once the pass is over, the job then scheduled in
	 * the same stretch. Nothing while a run is active or a start is prepared, so a turn never waits behind a prune.
	 */
	#step(started: EpochMs, steps: number): string | null {
		const now = this.#store.now();
		if (this.#store.activeRun() !== null || this.#store.preparedRuns().length > 0) {
			this.#host.schedule(now + RETENTION.busyMs);
			return null;
		}
		if (steps > 0 && now - started >= RETENTION.passMs) {
			this.#host.schedule(now);
			return null;
		}
		if (this.#store.pruneFacts(now - RETENTION.factsMs, RETENTION.rowsPerStep) > 0) return "facts";
		this.#host.schedule(nextPass(now, [this.due()]));
		return null;
	}
}
