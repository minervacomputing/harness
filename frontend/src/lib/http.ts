import { client } from '@/api/client.gen'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

/** Sets the CSRF cookie once per page load; Django requires it for every unsafe request. */
let csrfReady: Promise<void> | null = null
export function ensureCsrf(): Promise<void> {
  csrfReady ??= fetch('/api/csrf', { credentials: 'same-origin' }).then(() => undefined)
  return csrfReady
}

export function installClientInterceptors(onUnauthorized: () => void) {
  client.interceptors.request.use(async request => {
    if (UNSAFE.has(request.method)) {
      await ensureCsrf()
      request.headers.set('X-CSRFToken', csrfToken())
    }
    return request
  })
  client.interceptors.response.use(response => {
    if (response.status === 401) onUnauthorized()
    return response
  })
  // A body that is not JSON comes from something in front of the app (a proxy's error page) or from
  // Django's bare 500 page; the client throws it as raw text, so it is replaced by a sentence.
  client.interceptors.error.use((error, response) => {
    if (typeof error !== 'string' || !response) return error
    return { detail: response.status >= 502 && response.status <= 504
      ? 'Minerva is briefly unavailable, probably restarting. Try again in a moment.'
      : 'Something went wrong on the server. Try again.' }
  })
}

/** Turns API errors (Ninja `{detail}`, validation lists, network failures) into one readable sentence. */
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
