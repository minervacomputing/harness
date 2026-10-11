// The two clocks of the executor and its ledger, injected in tests. In a Worker both stand still while
// code computes and advance with I/O, which is what the write deadlines need: time spent waiting counts.

export interface Clock {
	/** Milliseconds since the epoch: stored times and run deadlines. */
	now(): number;
	/** Monotonic milliseconds: a write's deadline, fixed at dispatch so later waits eat into it. */
	monotonic(): number;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	monotonic: () => performance.now(),
};
