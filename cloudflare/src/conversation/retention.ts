// What a conversation keeps, and for how long: one Lifecycle job, `retain`, deletes what is
// due in passes of bounded steps on the object's alarm, and only while no run is active. A pass runs its steps in order
// until nothing is due or its budget is spent, then schedules itself for what is left. Each step is one transaction outside
// pi's, deletes at most `rowsPerStep` rows and records how far it got in the same transaction, so a kill rolls back
// only the step in flight and the next pass finds what is left. Its steps, in order: the facts Laravel acknowledged long
// enough ago (store.ts `pruneFacts`); the runs that ended long enough ago, oldest first, their own records and then their pi
// sessions (`pruneRecords`, `prunePi`); then the pi sessions no run names (`pruneOrphan`); last, a deleted conversation's
// purge, once nothing is left that it would lose (`deletion`): the index's mark, its blobs, then its storage and the object.

import type { EpochMs } from "../shared/rpc.ts";
import { PI_SCHEMA_VERSION, type PiStep } from "./pi-tables.ts";
import type { Deletion, RunStore } from "./store.ts";

/** The periods and bounds; the tests shorten them, and the test build's plan can for one conversation (ports.ts `retention`). */
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

export type RetentionPeriods = typeof RETENTION;

/** The Lifecycle job of the host that runs a pass. */
export const RETAIN_JOB = "retain";

/**
 * When the next pass is due, from the due times of what is left: the earliest, where one already past is blocked (the pass
 * that just ran over it could not delete it) and counts as `blockedMs` from now. Null when nothing is left.
 */
export function nextPass(now: EpochMs, due: readonly (EpochMs | null)[], blockedMs: number): EpochMs | null {
	let next: EpochMs | null = null;
	for (const time of due) {
		if (time === null) continue;
		const at = time > now ? time : now + blockedMs;
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
	/** The periods and bounds, read at each step. */
	periods(): RetentionPeriods;
	/** Makes the `retain` job due at `time`, or removes it; synchronous, so it joins the step that decides it. */
	schedule(time: EpochMs | null): void;
	log(message: string, error: unknown): void;
	/**
	 * Starts marking every live task of the session for abort, background ones included, without waiting for them: the pass
	 * goes on within its budget, so a slow abort never keeps it from the runs behind the session.
	 */
	abort(session: number): void;
	/** After each committed step (detail: the step); the test build's fault point `retain:step`. */
	stepped(step: StepName): Promise<void>;
	/**
	 * Waits until what the step wrote is durable. It is the I/O that moves the object's clock to the time the steps took, which
	 * the pass's budget reads: on the platform the clock stands still through SQL, and a timer moves it only by its own delay.
	 */
	sync(): Promise<void>;
	/** At a pass's start and at its end, unless it destroyed the object; the test build's fault point `retain:pass`. */
	edge(at: "start" | "end"): Promise<void>;
	purge: Purge;
}

/**
 * A deleted conversation's purge, in this order. Each step is idempotent,
 * so a pass after a failure or a kill runs them again from the first.
 */
export interface Purge {
	/** `deleteInternal`'s clean-up again: the conversation's scripts and its sandbox destroyed. */
	clean(): Promise<void>;
	/** The recovery index's mark: from here a command that reads the index no longer reaches the object. */
	mark(): Promise<void>;
	/** A page of the conversation's objects in R2 deleted; how many, 0 once none is left. */
	blobs(): Promise<number>;
	/**
	 * Every table deleted while the alarm still stands, then the object destroyed (the SDK's `destroy()`, which deletes the
	 * alarm before the storage): a reset between the two leaves nothing behind. The fault point `retain:step` (`storage`)
	 * comes between them.
	 */
	storage(): Promise<void>;
}

/**
 * A step of a pass: what it deleted from (a run's own records, a run's pi session, a session no run names), or the purge's
 * step it finished: `clean`, `mark`, `blobs` after each page that deleted objects, and `storage` before the object's end.
 */
export type StepName = "facts" | "runs" | "pi" | "orphan" | "clean" | "mark" | "blobs" | "storage";

/**
 * What a pass's step answers: a step taken, with a session to abort after it; the purge, which ends the pass; or the pass over
 * with the job's next time.
 */
type Step = { name: StepName; abort?: number } | { purge: true } | { next: EpochMs | null };

/**
 * What one pass keeps in memory: the pi sessions with live work, aborted once and skipped for the rest of the pass, so they
 * never hide the runs behind them; and whether pi's schema is one these statements do not know, which stops the pi stage.
 */
interface PassState {
	skipped: Set<number>;
	piPaused: boolean;
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
	 * When retention is next due from what is held, or null when nothing is: the earliest of the oldest acknowledgement's, the
	 * oldest run not yet pruned's and the deletion's period. Read in the caller's synchronous step.
	 */
	due(): EpochMs | null {
		let earliest: EpochMs | null = null;
		for (const time of this.#dues()) if (time !== null && (earliest === null || time < earliest)) earliest = time;
		return earliest;
	}

	#dues(): (EpochMs | null)[] {
		const periods = this.#host.periods();
		const acknowledged = this.#store.oldestAcknowledgement();
		const ended = this.#store.oldestUnpruned();
		const deleted = this.#store.deletion()?.deletedAt ?? null;
		return [
			acknowledged === null ? null : acknowledged + periods.factsMs,
			ended === null ? null : ended + periods.runMs,
			deleted === null ? null : deleted + periods.deletedMs,
		];
	}

	/**
	 * One pass of the `retain` job. It schedules the job itself, in the step that decides what is left, so an acknowledgement
	 * that moves the job earlier after that step is never undone by the pass's outcome; the outcome says the same time, which
	 * Lifecycle applies only if no schedule reached the job since, as when that schedule failed. Never throws: a failure is
	 * logged and the job is made due again after a backoff.
	 */
	async pass(): Promise<{ rescheduleAt: EpochMs } | undefined> {
		try {
			await this.#host.edge("start");
			const started = this.#store.now();
			const state: PassState = { skipped: new Set(), piPaused: false };
			for (let steps = 0; ; steps++) {
				const step = await this.#store.outside(() => this.#step(started, steps, state));
				if ("next" in step || "purge" in step) {
					const next = "next" in step ? step.next : await this.#purge(started);
					this.#failures = 0;
					// A purge that answers no next time destroyed the object: nothing is left to mark the end in.
					if ("next" in step || next !== null) await this.#host.edge("end");
					return next === null ? undefined : { rescheduleAt: next };
				}
				if (step.abort !== undefined) this.#host.abort(step.abort);
				await this.#host.stepped(step.name);
				await this.#host.sync();
				// Other events wait while this runs: a timer lets them in.
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
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
	 * The pass's next step, run in one synchronous stretch: its name, or once the pass is over the job's next time, scheduled in
	 * the same stretch. Nothing while a run is active or a start is prepared, so a turn never waits behind a prune.
	 */
	#step(started: EpochMs, steps: number, state: PassState): Step {
		const now = this.#store.now();
		const periods = this.#host.periods();
		const over = (next: EpochMs | null) => {
			this.#host.schedule(next);
			return { next };
		};
		// What the orphans' step relies on too: no loop can be creating or claiming a session.
		if (this.#store.activeRun() !== null || this.#store.preparedRuns().length > 0) return over(now + periods.busyMs);
		if (steps > 0 && now - started >= periods.passMs) return over(now);
		const limit = periods.rowsPerStep;
		if (this.#store.pruneFacts(now - periods.factsMs, limit) > 0) return { name: "facts" };
		const run = this.#store.prunableRun(now - periods.runMs, [...state.skipped], !state.piPaused);
		if (run !== null && run.prune !== "pi") {
			this.#store.pruneRecords(run.id, limit);
			return { name: "runs" };
		}
		if (run !== null) {
			const session = Number(run.session);
			return this.#piStep(this.#store.prunePi(run.id, session, limit), session, "pi", state);
		}
		const orphan = state.piPaused ? null : this.#store.pruneOrphan([...state.skipped], limit);
		if (orphan !== null) return this.#piStep(orphan.step, orphan.session, "orphan", state);
		const deletion = this.#dueDeletion(now);
		if (deletion?.purgeable) return { purge: true };
		// Never destroyed while it holds a fact Laravel lacks, which may be money (owner question 1); a pass blocked here comes
		// back a day later.
		if (deletion && deletion.unacknowledged > 0) this.#host.log(`a deleted conversation is kept: ${deletion.unacknowledged} facts are not acknowledged`, undefined);
		return over(nextPass(now, this.#dues(), periods.blockedMs));
	}

	/** The conversation's deletion, once its period is over. */
	#dueDeletion(now: EpochMs): Deletion | null {
		const deletion = this.#store.deletion();
		return deletion !== null && deletion.deletedAt + this.#host.periods().deletedMs <= now ? deletion : null;
	}

	/**
	 * The purge, its steps in order: the R2 prefix a page at a time, at least one a pass and then within its budget, after
	 * which the job is due now; then the storage. The job's next time, or null once the object is gone.
	 */
	async #purge(started: EpochMs): Promise<EpochMs | null> {
		const purge = this.#host.purge;
		await purge.clean();
		await this.#host.stepped("clean");
		await purge.mark();
		await this.#host.stepped("mark");
		for (let pages = 0; ; pages++) {
			const now = this.#store.now();
			if (pages > 0 && now - started >= this.#host.periods().passMs) {
				this.#host.schedule(now);
				return now;
			}
			if ((await purge.blobs()) === 0) break;
			await this.#host.stepped("blobs");
		}
		// The awaits above let commands in: what cannot be undone waits until the condition holds again.
		const ready = await this.#store.outside(
			() => this.#store.activeRun() === null && this.#store.preparedRuns().length === 0 && this.#dueDeletion(this.#store.now())?.purgeable === true,
		);
		if (!ready) {
			const now = this.#store.now();
			this.#host.schedule(now);
			return now;
		}
		await purge.storage();
		return null;
	}

	#piStep(step: PiStep, session: number, name: StepName, state: PassState): Step {
		if (step.kind === "live") {
			state.skipped.add(session);
			return { name, abort: session };
		}
		if (step.kind === "schema") {
			state.piPaused = true;
			this.#host.log(`pi's schema is version ${step.version}, not ${PI_SCHEMA_VERSION}: pi sessions are not deleted`, undefined);
		}
		return { name };
	}
}
