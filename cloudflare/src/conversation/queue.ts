// The run's queue of connector tool calls: at most 4 calls at once, the rest waiting in order, and
// writes one at a time in the order they were asked for. Direct calls share it with scripted ones
// (`run_script`). A call keeps its slot until the executor answers, even when its caller stopped
// waiting, because a started provider request cannot be called back.

export const CALLS_AT_ONCE = 4;

/** Runs tasks one after another, in the order they were queued. */
export function serial(): <T>(task: () => Promise<T>) => Promise<T> {
	let last: Promise<unknown> = Promise.resolve();
	return (task) => {
		const next = last.then(task, task);
		last = next.catch(() => {});
		return next;
	};
}

/** Runs at most `size` tasks at once; the rest wait in the order they were queued. */
export function limiter(size: number): <T>(task: () => Promise<T>) => Promise<T> {
	let free = size;
	const waiting: (() => void)[] = [];
	return async (task) => {
		if (free > 0) free--;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else free++;
		}
	};
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export class ToolQueue {
	readonly #atOnce = limiter(CALLS_AT_ONCE);
	readonly #writes = serial();

	/** `check` runs inside the slot, just before the call is sent, and may throw to drop it. */
	send<T>(write: boolean, call: () => Promise<T>, check: () => void = () => {}): Promise<T> {
		const start = () =>
			this.#atOnce(() => {
				check();
				return call();
			});
		return write ? this.#writes(start) : start();
	}
}
