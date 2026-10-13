import { ORPCError } from '@orpc/client'

let unauthorized = () => {}

/** What the app does when an answer says its session has ended (main.tsx). */
export function onUnauthorized(handler: () => void) {
  unauthorized = handler
}

/** Tells the app its session has ended when an answer is a 401. Every answer of the contract's client comes here (lib/orpc.ts). */
export function noteAnswer(response: Response) {
  if (response.status === 401) unauthorized()
}

/** What to say when the server, or something in front of it, answered with an error and no explanation. */
function serverErrorMessage(status: number): string {
  return status >= 502 && status <= 504
    ? 'Minerva is briefly unavailable, probably restarting. Try again in a moment.'
    : 'Something went wrong on the server. Try again.'
}

/**
 * Whether a query tries again (at most twice): not after a refusal below 500, which will not change. Network failures, timeouts and 5xx
 * are tried again.
 */
export function retryQuery(count: number, error: unknown): boolean {
  if (count >= 2) return false
  return !(error instanceof ORPCError && error.status < 500)
}

/** fetch's own failure in the contract's client: the request did not reach the server, or its answer was lost. */
export class NetworkError extends Error {
  constructor(options: ErrorOptions) {
    super('The server could not be reached.', options)
  }
}

/**
 * Turns an error into one readable sentence: the contract's errors (a declared one carries the server's message; an undeclared one
 * comes from something in front of the app or from a crash, so its text is replaced by a sentence about the server), a refusal of the
 * upload (the same shape, read as JSON by its XHR), and network failures.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (error instanceof ORPCError) return error.defined ? error.message || fallback : serverErrorMessage(error.status)
  if (error instanceof TypeError) return 'The server could not be reached.'
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) return error.message
  return fallback
}
