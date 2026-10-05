export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

export class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const type = (err as { type?: string }).type;
  return type === "StripeConnectionError" || type === "StripeAPIError";
}

/** Run `fn` until it succeeds, retrying network errors and timeouts with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await withTimeout(fn(), opts.timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === opts.attempts) break;
      await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
