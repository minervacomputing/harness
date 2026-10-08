/** Small helpers for running tasks together. */

/** Runs tasks one after another, in the order they were queued. */
export function serial(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return task => {
    const next = last.then(task, task)
    last = next.catch(() => {})
    return next
  }
}

/** Runs at most `size` tasks at once; the rest wait in the order they were queued. */
export function limiter(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let free = size
  const waiting: Array<() => void> = []
  return async task => {
    if (free > 0) free--
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export type Deferred<T> = { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void }

/** A promise with its resolve and reject. A rejection nobody waits for is not reported as unhandled. */
export function deferred<T = void>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Settles every task, then rethrows the most important failure: the first that `rank` puts lowest, else the first.
 * Unlike `Promise.all`, nothing is still running when it rejects.
 */
export async function settleAll<T>(tasks: Promise<T>[], rank: (error: unknown) => number = () => 0): Promise<T[]> {
  const settled = await Promise.allSettled(tasks)
  let failure: { error: unknown, rank: number } | undefined
  for (const result of settled) {
    if (result.status === 'fulfilled') continue
    const order = rank(result.reason)
    if (!failure || order < failure.rank) failure = { error: result.reason, rank: order }
  }
  if (failure) throw failure.error
  return settled.map(result => (result as PromiseFulfilledResult<T>).value)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
