import { client } from '@/api/client.gen'

export function installClientInterceptors(onUnauthorized: () => void) {
  client.interceptors.response.use(response => {
    if (response.status === 401) onUnauthorized()
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

/** Turns API errors (`{detail}`, validation lists, network failures) into one readable sentence. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (error instanceof TypeError) return 'The server could not be reached.'
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: string; loc?: unknown[] }
      const field = first.loc?.at(-1)
      return first.msg ? `${typeof field === 'string' ? `${field}: ` : ''}${first.msg}` : fallback
    }
  }
  return fallback
}
