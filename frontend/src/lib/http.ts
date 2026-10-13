import { ORPCError } from '@orpc/client'
import { client } from '@/api/client.gen'

let onUnauthorized = () => {}

/** Tells the app its session has ended when an answer is a 401. Every answer of both clients comes here. */
export function noteAnswer(response: Response) {
  if (response.status === 401) onUnauthorized()
}

export function installClientInterceptors(unauthorized: () => void) {
  onUnauthorized = unauthorized
  client.interceptors.response.use(response => {
    noteAnswer(response)
    return response
  })
  // A body that is not JSON comes from something in front of the app (a proxy's error page) or from a
  // crash; the client throws it as raw text, so it is replaced by a sentence.
  client.interceptors.error.use((error, response) => (typeof error === 'string' && response ? { detail: serverErrorMessage(response.status) } : error))
}

/** What to say when the server, or something in front of it, answered with an error and no explanation. */
export function serverErrorMessage(status: number): string {
  return status >= 502 && status <= 504
    ? 'Minerva is briefly unavailable, probably restarting. Try again in a moment.'
    : 'Something went wrong on the server. Try again.'
}

/**
 * Whether a query tries again (at most twice): not after an answer that will not change, which is a refusal of the contract's routes or
 * any answer of the generated client's routes. Network failures, timeouts and the contract's 5xx are tried again.
 */
export function retryQuery(count: number, error: unknown): boolean {
  if (count >= 2) return false
  if (error instanceof ORPCError) return error.status >= 500
  return !(typeof error === 'object' && error && ('detail' in error || 'code' in error))
}

/** fetch's own failure in the contract's client: the request did not reach the server, or its answer was lost. */
export class NetworkError extends Error {
  constructor(options: ErrorOptions) {
    super('The server could not be reached.', options)
  }
}

/**
 * Turns API errors into one readable sentence: the contract's errors (its declared ones carry the server's message; an undeclared one
 * comes from something in front of the app or from a crash, so its text is replaced by a sentence about the server), the generated
 * client's (`{detail}` and validation lists from the routes not in the contract yet, `{message}` from the router's own refusals), and
 * network failures.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (error instanceof ORPCError) return error.defined ? error.message || fallback : serverErrorMessage(error.status)
  if (error instanceof TypeError) return 'The server could not be reached.'
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object') {
    const { detail, message } = error as { detail?: unknown; message?: unknown }
    if (typeof message === 'string' && message) return message
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: string; loc?: unknown[] }
      const field = first.loc?.at(-1)
      return first.msg ? `${typeof field === 'string' ? `${field}: ` : ''}${first.msg}` : fallback
    }
  }
  return fallback
}
